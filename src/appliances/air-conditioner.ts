// Air conditioners as a heater/cooler tile: on/off, cool / heat / auto, the room temperature, the
// set temperature, fan speed (Auto at the top of the slider) and swing. The approach follows
// homebridge-lg-thinqconnect-ac (MIT), which runs this on the same LG API; the sample data is Home
// Assistant's (see test fixtures).
//
// Extras, for what a unit's profile offers (and the "extra controls" setting allows): switches for
// air purify, energy saving, the display light, left-right swing (the tile swings up-down), jet
// mode, and dry and fan-only modes; air quality, humidity and filter sensors; and in auto mode,
// separate heating and cooling set points when the unit uses two of them ("two-set").
//
// LG modes without a heater/cooler equivalent (fan only, dry, air clean) show as on and idle.

import type { CharacteristicValue, Service } from 'homebridge';
import { field } from '../api';
import { alertKind } from '../laundry';
import { Appliance, type ApplianceContext, set, limit } from './base';
import { AirSensors, alertCodes } from './sensors';
import {
  type Obj, type Range, cToF, enumValues, fToC, fieldOf, levelFor, levelPercent, powerField, resources, speedLevels,
  stateValue, temperatureC, temperatureRangeC, unitOf, writable,
} from './profile';

export { alertCodes } from './sensors';

const MODES = ['COOL', 'HEAT', 'AUTO'] as const;
type Mode = typeof MODES[number];

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** An extra on/off control: how to read it from the state, and the command for on or off. */
interface Extra {
  subtype: string;
  label: string;
  read(state: unknown): boolean | undefined;
  payload(on: boolean): Record<string, unknown>;
  service?: Service;
  value: boolean;
}

export class AirConditioner extends Appliance {
  readonly tile: Service;
  readonly extras: Extra[] = [];
  private readonly sensors: AirSensors;
  private readonly res: Obj;
  private readonly power?: { name: string; canWrite: boolean };
  private readonly modes: Mode[];
  private readonly speeds: string[];
  private readonly swingField?: string;
  private readonly ranges: Partial<Record<Mode, Range>>;
  private readonly twoSetRanges?: { heat?: Range; cool?: Range };
  on = false;
  private mode = 'COOL';
  private lastMode: Mode = 'COOL';
  private current = 22;
  target = 22;
  private twoSet = false;
  private heatTarget?: number;
  private coolTarget?: number;
  private unit: 'C' | 'F' = 'C';
  private speed = 0;
  private wind = '';
  private swing = false;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    this.res = resources(profile);
    this.power = powerField(this.res);
    const jobModes = enumValues(fieldOf(this.res, 'airConJobMode', 'currentJobMode'), 'w');
    this.modes = MODES.filter((m) => jobModes.includes(m));
    const wind = fieldOf(this.res, 'airFlow', 'windStrength');
    this.speeds = writable(wind) ? speedLevels(wind) : [];
    this.swingField = ['rotateUpDown', 'rotateLeftRight'].find((f) => writable(fieldOf(this.res, 'windDirection', f)));
    const any = this.tempRange('targetTemperature');
    this.ranges = {
      COOL: this.tempRange('coolTargetTemperature') || any,
      HEAT: this.tempRange('heatTargetTemperature') || any,
      AUTO: this.tempRange('autoTargetTemperature') || any,
    };
    if (this.res.twoSetTemperatureInUnits) {
      this.twoSetRanges = {
        heat: temperatureRangeC(this.res, 'twoSetTemperatureInUnits', 'heatTargetTemperature'),
        cool: temperatureRangeC(this.res, 'twoSetTemperatureInUnits', 'coolTargetTemperature'),
      };
    }

    this.tile = this.service(S.HeaterCooler, ctx.name, 'climate');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    const target = this.tile.getCharacteristic(C.TargetHeaterCoolerState);
    const valid = this.modes.map((m) => this.hkMode(m)).sort((a, b) => a - b);
    if (valid.length) { limit(target, { validValues: valid }); }
    target.onSet((v) => this.setMode(v));
    this.tile.getCharacteristic(C.CoolingThresholdTemperature).onSet((v) => this.setThreshold('cool', Number(v)));
    this.tile.getCharacteristic(C.HeatingThresholdTemperature).onSet((v) => this.setThreshold('heat', Number(v)));
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
    this.sensors = new AirSensors(this, this.res, ctx.name, (t, n, s) => this.service(t, n, s), keep, true);
    if (ctx.extraControls !== false) {
      for (const extra of this.findExtras(jobModes)) {
        extra.service = this.service(S.Switch, `${ctx.name} ${extra.label}`, extra.subtype);
        extra.service.getCharacteristic(C.On).onSet((v) => this.setExtra(extra, v === true || v === 1));
        this.extras.push(extra);
        keep.add(extra.subtype);
      }
    }
    this.prune(keep);
    this.render();
  }

  /** The extra controls this unit's profile offers. */
  private findExtras(jobModes: string[]): Extra[] {
    const out: Extra[] = [];
    const add = (e: Omit<Extra, 'value'>) => { out.push({ ...e, value: false }); };
    const airClean = enumValues(fieldOf(this.res, 'operation', 'airCleanOperationMode'), 'w');
    if (airClean.includes('START')) {
      // Some units don't report it back: the switch then shows the last command
      add({ subtype: 'air-purify', label: 'air purify',
        read: (s) => { const v = stateValue(s, 'operation', 'airCleanOperationMode'); return v === undefined ? undefined : v === 'START'; },
        payload: (on) => ({ operation: { airCleanOperationMode: on ? 'START' : 'STOP' } }) });
    }
    if (writable(fieldOf(this.res, 'powerSave', 'powerSaveEnabled'))) {
      add({ subtype: 'energy-saving', label: 'energy saving',
        read: (s) => bool(stateValue(s, 'powerSave', 'powerSaveEnabled')),
        payload: (on) => ({ powerSave: { powerSaveEnabled: on } }) });
    }
    const light = fieldOf(this.res, 'display', 'light');
    if (writable(light)) {
      const onOff = enumValues(light, 'w').includes('ON');
      add({ subtype: 'display-light', label: 'display light',
        read: (s) => { const v = stateValue(s, 'display', 'light'); return onOff ? (v === undefined ? undefined : v === 'ON') : bool(v); },
        payload: (on) => ({ display: { light: onOff ? (on ? 'ON' : 'OFF') : on } }) });
    }
    if (this.swingField === 'rotateUpDown' && writable(fieldOf(this.res, 'windDirection', 'rotateLeftRight'))) {
      add({ subtype: 'swing-left-right', label: 'swing left-right',
        read: (s) => bool(stateValue(s, 'windDirection', 'rotateLeftRight')),
        payload: (on) => ({ windDirection: { rotateLeftRight: on } }) });
    }
    if (enumValues(fieldOf(this.res, 'airFlow', 'windStrength'), 'w').includes('POWER')) {
      add({ subtype: 'jet', label: 'jet mode',
        read: (s) => { const v = stateValue(s, 'airFlow', 'windStrength'); return v === undefined ? undefined : v === 'POWER'; },
        payload: (on) => ({ airFlow: { windStrength: on ? 'POWER' : (this.speeds.includes('AUTO') ? 'AUTO' : this.speeds.at(-1) || 'HIGH') } }) });
    }
    for (const [mode, label] of [['AIR_DRY', 'dry mode'], ['FAN', 'fan mode']] as const) {
      if (!jobModes.includes(mode)) { continue; }
      add({ subtype: `mode-${mode}`, label,
        read: (s) => { const v = stateValue(s, 'airConJobMode', 'currentJobMode'); return v === undefined ? undefined : v === mode; },
        payload: (on) => ({ airConJobMode: { currentJobMode: on ? mode : (this.modes.includes(this.lastMode) ? this.lastMode : this.modes[0] || 'COOL') } }) });
    }
    return out;
  }

  private tempRange(name: string): Range | undefined {
    const c = temperatureRangeC(this.res, 'temperatureInUnits', name);
    if (c) { return c; }
    // The plain resource is in the unit the AC displays: an air conditioner set point above 40 is °F
    const r = temperatureRangeC(this.res, 'temperature', name);
    if (!r || r.max <= 40) { return r; }
    return { min: Math.round(fToC(r.min) * 2) / 2, max: Math.round(fToC(r.max) * 2) / 2, step: 0.5 };
  }

  private hkMode(m: Mode): number {
    const T = this.hap.Characteristic.TargetHeaterCoolerState;
    return m === 'HEAT' ? T.HEAT : m === 'AUTO' ? T.AUTO : T.COOL;
  }

  /** Two set points in auto mode: when the unit offers them and has them turned on. */
  private get usesTwoSet(): boolean {
    return !!this.twoSetRanges && this.twoSet && this.lastMode === 'AUTO';
  }

  /** The set temperature limits for the current mode (they differ by mode on some units). */
  private applyRange(): void {
    const { Characteristic: C } = this.hap;
    const r = this.ranges[this.lastMode] || { min: 16, max: 30, step: 1 };
    const two = this.usesTwoSet;
    const pairs = [
      [C.CoolingThresholdTemperature, two ? this.twoSetRanges?.cool || r : r, two ? this.coolTarget ?? this.target : this.target],
      [C.HeatingThresholdTemperature, two ? this.twoSetRanges?.heat || r : r, two ? this.heatTarget ?? this.target : this.target],
    ] as const;
    for (const [ch, range, value] of pairs) {
      const c = this.tile.getCharacteristic(ch);
      limit(c, { minValue: range.min, maxValue: range.max, minStep: range.step });
      set(c, Math.min(Math.max(value, range.min), range.max));
    }
  }

  update(state: unknown): void {
    this.unreachable = state === null;
    if (state !== null && state !== undefined) {
      const wasOn = this.on;
      if (this.power) { this.on = stateValue(state, 'operation', this.power.name) === 'POWER_ON'; }
      if (this.on !== wasOn) { this.problemAlert = ''; } // switched off and on: an emptied tank
      const mode = stateValue(state, 'airConJobMode', 'currentJobMode');
      if (typeof mode === 'string') {
        this.mode = mode;
        if ((MODES as readonly string[]).includes(mode)) { this.lastMode = mode as Mode; }
      }
      this.unit = unitOf(state, 'temperature');
      // temperature (in the unit the AC shows) first: live updates change it; temperatureInUnits as backup
      const read = (name: string) => temperatureC(field(state, 'temperature'), name) ?? temperatureC(field(state, 'temperatureInUnits'), name);
      this.current = read('currentTemperature') ?? this.current;
      this.target = read('targetTemperature') ?? this.target;
      if (this.twoSetRanges) {
        const enabled = stateValue(state, 'twoSetTemperature', 'twoSetEnabled');
        if (typeof enabled === 'boolean') { this.twoSet = enabled; }
        const two = field(state, 'twoSetTemperatureInUnits');
        this.heatTarget = temperatureC(two, 'heatTargetTemperature') ?? this.heatTarget;
        this.coolTarget = temperatureC(two, 'coolTargetTemperature') ?? this.coolTarget;
      }
      if (this.speeds.length) {
        const w = stateValue(state, 'airFlow', 'windStrength');
        if (typeof w === 'string') { this.wind = w; }
        this.speed = levelPercent(this.speeds, this.wind) || 100;
      }
      if (this.swingField) { this.swing = stateValue(state, 'windDirection', this.swingField) === true; }
      for (const e of this.extras) {
        const v = e.read(state);
        if (v !== undefined) { e.value = v; }
      }
      this.sensors.update(state);
    }
    this.applyRange();
    this.render();
  }

  private render(): void {
    const { Characteristic: C } = this.hap;
    set(this.tile.getCharacteristic(C.Active), this.on ? C.Active.ACTIVE : C.Active.INACTIVE);
    set(this.tile.getCharacteristic(C.TargetHeaterCoolerState), this.hkMode(this.lastMode));
    const H = C.CurrentHeaterCoolerState;
    set(this.tile.getCharacteristic(H), !this.on ? H.INACTIVE : this.mode === 'HEAT' ? H.HEATING : this.mode === 'COOL' ? H.COOLING : H.IDLE);
    set(this.tile.getCharacteristic(C.CurrentTemperature), this.current);
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    if (this.swingField) {
      set(this.tile.getCharacteristic(C.SwingMode), this.swing ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED);
    }
    for (const e of this.extras) { set(e.service!.getCharacteristic(C.On), e.value); }
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

  /** A set point from the tile: one set temperature, or in two-set auto mode, heating or cooling. */
  private setThreshold(which: 'cool' | 'heat', celsius: number): Promise<void> {
    if (this.usesTwoSet) {
      const current = which === 'cool' ? this.coolTarget : this.heatTarget;
      if (current !== undefined && Math.abs(celsius - current) < 0.01) { return Promise.resolve(); }
      const [value, unit] = this.unit === 'F' ? [Math.round(cToF(celsius)), 'F'] : [celsius, 'C'];
      return this.command(`${which === 'cool' ? 'Cooling' : 'Heating'} set to ${value} °${unit}`,
        { twoSetTemperatureInUnits: { [`${which}TargetTemperature`]: value, unit } })
        .then(() => { if (which === 'cool') { this.coolTarget = celsius; } else { this.heatTarget = celsius; } });
    }
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
    if (level === this.wind) { return Promise.resolve(); }
    return this.command(`Fan ${level.toLowerCase()}`, { airFlow: { windStrength: level } }).then(() => { this.wind = level; });
  }

  private setSwing(v: CharacteristicValue): Promise<void> {
    const on = v === this.hap.Characteristic.SwingMode.SWING_ENABLED;
    return this.command(on ? 'Swing on' : 'Swing off', { windDirection: { [this.swingField!]: on } });
  }

  private setExtra(extra: Extra, on: boolean): Promise<void> {
    if (on === extra.value) { return Promise.resolve(); }
    return this.command(`${extra.label[0].toUpperCase()}${extra.label.slice(1)} ${on ? 'on' : 'off'}`, extra.payload(on))
      .then(() => { extra.value = on; });
  }

  private refuse(why: string): Promise<void> {
    this.ctx.log.info(`[${this.ctx.name}] ${why}`);
    setTimeout(() => this.render(), 50).unref?.();
    return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
  }
}
