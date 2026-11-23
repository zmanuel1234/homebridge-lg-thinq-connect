// Air conditioners as a heater/cooler tile: on/off, cool / heat / auto, the room temperature, the
// set temperature, fan speed (Auto at the top of the slider) and swing. The approach follows homebridge-lg-thinqconnect-ac (MIT),
// which runs this on the same LG API; the sample data is Home Assistant's (see test fixtures).
//
// LG modes without a heater/cooler equivalent (fan only, dry, air clean) show as on and idle.

import type { CharacteristicValue, Service } from 'homebridge';
import { field } from '../api';
import { alertKind } from '../laundry';
import { Appliance, type ApplianceContext, set } from './base';
import {
  type Obj, type Range, cToF, enumValues, fieldOf, levelFor, levelPercent, powerField, resources, speedLevels,
  stateValue, temperatureC, temperatureRangeC, unitOf, writable,
} from './profile';

const MODES = ['COOL', 'HEAT', 'AUTO'] as const;
type Mode = typeof MODES[number];

/** The appliance's alert codes (profile.notification.push). */
export function alertCodes(profile: unknown): string[] {
  const n = field(field(profile, 'notification'), 'push');
  return Array.isArray(n) ? n.filter((c): c is string => typeof c === 'string') : [];
}

export class AirConditioner extends Appliance {
  readonly tile: Service;
  private readonly res: Obj;
  private readonly power?: { name: string; canWrite: boolean };
  private readonly modes: Mode[];
  private readonly speeds: string[];
  private readonly swingField?: string;
  private readonly ranges: Partial<Record<Mode, Range>>;
  on = false;
  private mode = 'COOL';
  private lastMode: Mode = 'COOL';
  private current = 22;
  target = 22;
  private unit: 'C' | 'F' = 'C';
  private speed = 0;
  private swing = false;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    this.res = resources(profile);
    this.power = powerField(this.res);
    this.modes = MODES.filter((m) => enumValues(fieldOf(this.res, 'airConJobMode', 'currentJobMode'), 'w').includes(m));
    const wind = fieldOf(this.res, 'airFlow', 'windStrength');
    this.speeds = writable(wind) ? speedLevels(wind) : [];
    this.swingField = ['rotateUpDown', 'rotateLeftRight'].find((f) => writable(fieldOf(this.res, 'windDirection', f)));
    const any = this.tempRange('targetTemperature');
    this.ranges = {
      COOL: this.tempRange('coolTargetTemperature') || any,
      HEAT: this.tempRange('heatTargetTemperature') || any,
      AUTO: this.tempRange('autoTargetTemperature') || any,
    };

    this.tile = this.service(S.HeaterCooler, ctx.name, 'climate');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    const target = this.tile.getCharacteristic(C.TargetHeaterCoolerState);
    const valid = this.modes.map((m) => this.hkMode(m)).sort((a, b) => a - b);
    if (valid.length) { target.setProps({ validValues: valid }); }
    target.onSet((v) => this.setMode(v));
    for (const ch of [C.CoolingThresholdTemperature, C.HeatingThresholdTemperature]) {
      this.tile.getCharacteristic(ch).onSet((v) => this.setTarget(Number(v)));
    }
    this.applyRange();
    if (this.speeds.length) {
      this.tile.getCharacteristic(C.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((v) => this.setSpeed(Number(v)));
    } else if (this.tile.testCharacteristic(C.RotationSpeed)) {
      this.tile.removeCharacteristic(this.tile.getCharacteristic(C.RotationSpeed));
    }
    if (this.swingField) {
      this.tile.getCharacteristic(C.SwingMode).onSet((v) => this.setSwing(v));
    } else if (this.tile.testCharacteristic(C.SwingMode)) {
      this.tile.removeCharacteristic(this.tile.getCharacteristic(C.SwingMode));
    }
    const keep = new Set(['climate']);
    // Portable units alert when their water tank is full: a problem sensor for that
    if (alertCodes(profile).some((c) => alertKind(c) === 'problem')) {
      this.addProblemSensor();
      keep.add('problem');
    }
    this.prune(keep);
    this.render();
  }

  private tempRange(name: string): Range | undefined {
    return temperatureRangeC(this.res, 'temperatureInUnits', name) || temperatureRangeC(this.res, 'temperature', name);
  }

  private hkMode(m: Mode): number {
    const T = this.hap.Characteristic.TargetHeaterCoolerState;
    return m === 'HEAT' ? T.HEAT : m === 'AUTO' ? T.AUTO : T.COOL;
  }

  /** The set temperature limits for the current mode (they differ by mode on some units). */
  private applyRange(): void {
    const { Characteristic: C } = this.hap;
    const r = this.ranges[this.lastMode] || { min: 16, max: 30, step: 1 };
    for (const ch of [C.CoolingThresholdTemperature, C.HeatingThresholdTemperature]) {
      const c = this.tile.getCharacteristic(ch);
      c.setProps({ minValue: r.min, maxValue: r.max, minStep: r.step });
      set(c, Math.min(Math.max(this.target, r.min), r.max));
    }
  }

  update(state: unknown): void {
    this.unreachable = state === null;
    if (state !== null) {
      const wasOn = this.on;
      if (this.power) { this.on = stateValue(state, 'operation', this.power.name) === 'POWER_ON'; }
      if (this.on !== wasOn) { this.problemAlert = ''; } // switched off and on: an emptied tank
      const mode = stateValue(state, 'airConJobMode', 'currentJobMode');
      if (typeof mode === 'string') {
        this.mode = mode;
        if ((MODES as readonly string[]).includes(mode) && mode !== this.lastMode) {
          this.lastMode = mode as Mode;
          this.applyRange();
        }
      }
      this.unit = unitOf(state, 'temperature');
      // temperature (in the unit the AC shows) first: live updates change it; temperatureInUnits as backup
      const read = (name: string) => temperatureC(field(state, 'temperature'), name) ?? temperatureC(field(state, 'temperatureInUnits'), name);
      this.current = read('currentTemperature') ?? this.current;
      this.target = read('targetTemperature') ?? this.target;
      if (this.speeds.length) { this.speed = levelPercent(this.speeds, stateValue(state, 'airFlow', 'windStrength')) || 100; }
      if (this.swingField) { this.swing = stateValue(state, 'windDirection', this.swingField) === true; }
    }
    this.render();
  }

  private render(): void {
    const { Characteristic: C } = this.hap;
    set(this.tile.getCharacteristic(C.Active), this.on ? C.Active.ACTIVE : C.Active.INACTIVE);
    set(this.tile.getCharacteristic(C.TargetHeaterCoolerState), this.hkMode(this.lastMode));
    const H = C.CurrentHeaterCoolerState;
    set(this.tile.getCharacteristic(H), !this.on ? H.INACTIVE : this.mode === 'HEAT' ? H.HEATING : this.mode === 'COOL' ? H.COOLING : H.IDLE);
    set(this.tile.getCharacteristic(C.CurrentTemperature), this.current);
    const r = this.ranges[this.lastMode];
    const t = r ? Math.min(Math.max(this.target, r.min), r.max) : this.target;
    set(this.tile.getCharacteristic(C.CoolingThresholdTemperature), t);
    set(this.tile.getCharacteristic(C.HeatingThresholdTemperature), t);
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    if (this.swingField) {
      set(this.tile.getCharacteristic(C.SwingMode), this.swing ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED);
    }
    this.renderProblem();
  }

  override get busy(): boolean { return this.on; }

  private setPower(v: CharacteristicValue): Promise<void> {
    if (!this.power?.canWrite) { return this.refuse('This air conditioner can\'t be switched on or off through LG\'s API.'); }
    const on = v === 1 || v === true;
    if (on === this.on) { return Promise.resolve(); }
    return this.command(on ? 'Switched on' : 'Switched off', { operation: { [this.power.name]: on ? 'POWER_ON' : 'POWER_OFF' } })
      .then(() => { this.on = on; });
  }

  private setMode(v: CharacteristicValue): Promise<void> {
    const T = this.hap.Characteristic.TargetHeaterCoolerState;
    const mode: Mode = v === T.HEAT ? 'HEAT' : v === T.AUTO ? 'AUTO' : 'COOL';
    if (!this.modes.includes(mode)) { return this.refuse(`This air conditioner has no ${mode.toLowerCase()} mode.`); }
    if (mode === this.mode) { return Promise.resolve(); }
    return this.command(`Mode ${mode.toLowerCase()}`, { airConJobMode: { currentJobMode: mode } })
      .then(() => { this.lastMode = mode; this.mode = mode; this.applyRange(); });
  }

  private setTarget(celsius: number): Promise<void> {
    if (Math.abs(celsius - this.target) < 0.01) { return Promise.resolve(); }
    if (this.unit === 'F') {
      // The unit shows °F: send whole °F, as its own controls do
      const f = Math.round(cToF(celsius));
      return this.command(`Set to ${f} °F`, { temperature: { targetTemperature: f, unit: 'F' } }).then(() => { this.target = celsius; });
    }
    return this.command(`Set to ${celsius} °C`, { temperature: { targetTemperature: celsius } }).then(() => { this.target = celsius; });
  }

  private setSpeed(percent: number): Promise<void> {
    if (percent === 0) { return Promise.resolve(); } // the Home app sends 0 before switching off
    const level = levelFor(this.speeds, percent);
    return this.command(`Fan ${level.toLowerCase()}`, { airFlow: { windStrength: level } });
  }

  private setSwing(v: CharacteristicValue): Promise<void> {
    const on = v === this.hap.Characteristic.SwingMode.SWING_ENABLED;
    return this.command(on ? 'Swing on' : 'Swing off', { windDirection: { [this.swingField!]: on } });
  }

  private refuse(why: string): Promise<void> {
    this.ctx.log.info(`[${this.ctx.name}] ${why}`);
    setTimeout(() => this.render(), 50).unref?.();
    return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
  }
}
