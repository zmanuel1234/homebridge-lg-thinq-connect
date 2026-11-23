// Appliances that move or treat air: air purifiers, dehumidifiers, humidifiers, fans (ceiling
// fans, ventilators, air purifier fans) and range hoods. Property names follow LG's toolkit and
// Home Assistant's integration; dehumidifier, air purifier and hood sample data is Home Assistant's.

import type { CharacteristicValue, Service } from 'homebridge';
import { alertKind } from '../laundry';
import { AirSensors, alertCodes } from './sensors';
import { Appliance, type ApplianceContext, set } from './base';
import {
  type Obj, type Range, enumValues, fieldOf, levelFor, levelPercent, num, powerField, rangeOf, resources, speedLevels,
  stateValue, writable,
} from './profile';

/** On/off and a fan speed from named levels (LOW, MID, HIGH), shared by the fan-like appliances. */
abstract class Powered extends Appliance {
  protected readonly res: Obj;
  protected readonly power?: { name: string; canWrite: boolean };
  protected readonly windResource: string;
  protected readonly windField?: string;
  protected readonly speeds: string[];
  on = false;
  protected speed = 0;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    this.res = resources(profile);
    this.power = powerField(this.res);
    this.windResource = 'airFlow';
    this.windField = ['windStrength', 'windStrengthLevel'].find((f) => writable(fieldOf(this.res, 'airFlow', f)));
    this.speeds = this.windField ? speedLevels(fieldOf(this.res, 'airFlow', this.windField)) : [];
  }

  override get busy(): boolean { return this.on; }

  protected readPower(state: unknown): void {
    if (state === null || state === undefined) { return; }
    if (this.power) {
      const wasOn = this.on;
      this.on = stateValue(state, 'operation', this.power.name) === 'POWER_ON';
      if (wasOn !== this.on) { this.problemAlert = ''; }
    }
    if (this.windField) { this.speed = levelPercent(this.speeds, stateValue(state, 'airFlow', this.windField)); }
  }

  protected setPower(v: CharacteristicValue): Promise<void> {
    const on = v === 1 || v === true;
    if (on === this.on) { return Promise.resolve(); }
    if (!this.power?.canWrite) { return this.refuse('It can\'t be switched on or off through LG\'s API.'); }
    return this.command(on ? 'Switched on' : 'Switched off', { operation: { [this.power.name]: on ? 'POWER_ON' : 'POWER_OFF' } })
      .then(() => { this.on = on; });
  }

  protected setSpeed(percent: number): Promise<void> {
    if (percent === 0 || !this.windField) { return Promise.resolve(); }
    const level = levelFor(this.speeds, percent);
    return this.command(`Speed ${level.toLowerCase()}`, { airFlow: { [this.windField]: level } });
  }

  protected speedCharacteristic(svc: Service): void {
    const { Characteristic: C } = this.hap;
    if (this.speeds.length) {
      svc.getCharacteristic(C.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((v) => this.setSpeed(Number(v)));
    } else if (svc.testCharacteristic(C.RotationSpeed)) {
      svc.removeCharacteristic(svc.getCharacteristic(C.RotationSpeed));
    }
  }

  protected problemFromProfile(profile: unknown, keep: Set<string>): void {
    if (alertCodes(profile).some((c) => alertKind(c) === 'problem')) {
      this.addProblemSensor();
      keep.add('problem');
    }
  }

  protected refuse(why: string): Promise<void> {
    this.ctx.log.info(`[${this.ctx.name}] ${why}`);
    setTimeout(() => this.update(undefined), 50).unref?.();
    return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
  }
}

/**
 * Air purifiers: on/off, fan speed, auto or manual mode (when the purifier has an AUTO mode), a
 * sleep mode switch, and air quality, humidity and filter sensors when reported.
 */
export class AirPurifier extends Powered {
  readonly tile: Service;
  readonly sleep?: Service;
  private readonly sensors: AirSensors;
  private readonly jobModes: string[];
  private jobMode = '';

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx, profile);
    const { Service: S, Characteristic: C } = this.hap;
    this.jobModes = enumValues(fieldOf(this.res, 'airPurifierJobMode', 'currentJobMode'), 'w');
    this.tile = this.service(S.AirPurifier, ctx.name, 'purifier');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    const T = C.TargetAirPurifierState;
    const target = this.tile.getCharacteristic(T);
    if (this.jobModes.includes('AUTO') && this.manualMode) {
      target.setProps({ validValues: [T.MANUAL, T.AUTO] }).onSet((v) => this.setJobMode(v === T.AUTO ? 'AUTO' : this.manualMode!));
    } else {
      target.setProps({ validValues: [T.MANUAL] });
    }
    this.speedCharacteristic(this.tile);
    const keep = new Set(['purifier']);
    if (ctx.extraControls !== false && this.jobModes.includes('SLEEP')) {
      this.sleep = this.service(S.Switch, `${ctx.name} sleep mode`, 'sleep');
      this.sleep.getCharacteristic(C.On).onSet((v) => this.setJobMode(v === true || v === 1 ? 'SLEEP' : (this.manualMode || 'AUTO')));
      keep.add('sleep');
    }
    this.sensors = new AirSensors(this, this.res, ctx.name, (t, n, s) => this.service(t, n, s), keep, true);
    this.problemFromProfile(profile, keep);
    this.prune(keep);
    this.update(undefined);
  }

  /** The mode "manual" means: CLEAN if offered, otherwise the first that isn't AUTO or SLEEP. */
  private get manualMode(): string | undefined {
    return this.jobModes.includes('CLEAN') ? 'CLEAN' : this.jobModes.find((m) => m !== 'AUTO' && m !== 'SLEEP');
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    this.readPower(state);
    if (state) {
      const m = stateValue(state, 'airPurifierJobMode', 'currentJobMode');
      if (typeof m === 'string') { this.jobMode = m; }
      this.sensors.update(state);
    }
    set(this.tile.getCharacteristic(C.Active), this.on ? 1 : 0);
    set(this.tile.getCharacteristic(C.CurrentAirPurifierState),
      this.on ? C.CurrentAirPurifierState.PURIFYING_AIR : C.CurrentAirPurifierState.INACTIVE);
    set(this.tile.getCharacteristic(C.TargetAirPurifierState),
      this.jobMode === 'AUTO' ? C.TargetAirPurifierState.AUTO : C.TargetAirPurifierState.MANUAL);
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    if (this.sleep) { set(this.sleep.getCharacteristic(C.On), this.jobMode === 'SLEEP'); }
    this.renderProblem();
  }

  private setJobMode(mode: string): Promise<void> {
    if (mode === this.jobMode) { return Promise.resolve(); }
    return this.command(`Mode ${mode.toLowerCase().split('_').join(' ')}`, { airPurifierJobMode: { currentJobMode: mode } })
      .then(() => { this.jobMode = mode; });
  }
}

/** Dehumidifiers and humidifiers: the Home app's humidifier-dehumidifier tile. */
export class HumidityAppliance extends Powered {
  readonly tile: Service;
  private readonly kind: 'dehumidifier' | 'humidifier';
  private readonly range?: Range;
  private current = 0;
  private target = 50;

  constructor(ctx: ApplianceContext, profile: unknown, kind: 'dehumidifier' | 'humidifier') {
    super(ctx, profile);
    this.kind = kind;
    const { Service: S, Characteristic: C } = this.hap;
    this.tile = this.service(S.HumidifierDehumidifier, ctx.name, 'humidity');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    const T = C.TargetHumidifierDehumidifierState;
    this.tile.getCharacteristic(T).setProps({ validValues: [kind === 'dehumidifier' ? T.DEHUMIDIFIER : T.HUMIDIFIER] });
    const desc = fieldOf(this.res, 'humidity', 'targetHumidity');
    this.range = writable(desc) ? rangeOf(desc, 'w') : undefined;
    const threshold = kind === 'dehumidifier' ? C.RelativeHumidityDehumidifierThreshold : C.RelativeHumidityHumidifierThreshold;
    if (this.range) {
      this.tile.getCharacteristic(threshold)
        .setProps({ minValue: this.range.min, maxValue: this.range.max, minStep: this.range.step })
        .onSet((v) => this.setTarget(Number(v)));
    }
    this.speedCharacteristic(this.tile);
    const keep = new Set(['humidity']);
    this.problemFromProfile(profile, keep);
    this.prune(keep);
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    this.readPower(state);
    if (state !== null && state !== undefined) {
      this.current = num(stateValue(state, 'humidity', 'currentHumidity')) ?? num(stateValue(state, 'airQualitySensor', 'humidity')) ?? this.current;
      this.target = num(stateValue(state, 'humidity', 'targetHumidity')) ?? this.target;
    }
    const T = C.TargetHumidifierDehumidifierState;
    const K = C.CurrentHumidifierDehumidifierState;
    set(this.tile.getCharacteristic(C.Active), this.on ? 1 : 0);
    set(this.tile.getCharacteristic(T), this.kind === 'dehumidifier' ? T.DEHUMIDIFIER : T.HUMIDIFIER);
    set(this.tile.getCharacteristic(K), !this.on ? K.INACTIVE : this.kind === 'dehumidifier' ? K.DEHUMIDIFYING : K.HUMIDIFYING);
    set(this.tile.getCharacteristic(C.CurrentRelativeHumidity), Math.max(0, Math.min(100, this.current)));
    if (this.range) {
      const threshold = this.kind === 'dehumidifier' ? C.RelativeHumidityDehumidifierThreshold : C.RelativeHumidityHumidifierThreshold;
      set(this.tile.getCharacteristic(threshold), Math.min(Math.max(this.target, this.range.min), this.range.max));
    }
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    this.renderProblem();
  }

  private setTarget(value: number): Promise<void> {
    if (value === this.target) { return Promise.resolve(); }
    return this.command(`Humidity target ${value}%`, { humidity: { targetHumidity: value } }).then(() => { this.target = value; });
  }
}

/** Ceiling fans, ventilators and air purifier fans: a fan tile with on/off and speed. */
export class Fan extends Powered {
  readonly tile: Service;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx, profile);
    const { Service: S, Characteristic: C } = this.hap;
    this.tile = this.service(S.Fanv2, ctx.name, 'fan');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    this.speedCharacteristic(this.tile);
    const keep = new Set(['fan']);
    this.problemFromProfile(profile, keep);
    this.prune(keep);
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    this.readPower(state);
    set(this.tile.getCharacteristic(C.Active), this.on ? 1 : 0);
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    this.renderProblem();
  }
}

/** Range hoods (and over-the-range microwaves): the fan as a number of speeds, and the light. */
export class Hood extends Appliance {
  readonly fan?: Service;
  readonly lamp?: Service;
  private readonly fanRange?: Range;
  private readonly lampRange?: Range;
  private fanSpeed = 0;
  private brightness = 0;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    const res = resources(profile);
    const fanDesc = fieldOf(res, 'ventilation', 'fanSpeed');
    const lampDesc = fieldOf(res, 'lamp', 'lampBrightness');
    this.fanRange = rangeOf(fanDesc, 'w') || rangeOf(fanDesc, 'r');
    this.lampRange = rangeOf(lampDesc, 'w') || rangeOf(lampDesc, 'r');
    const keep = new Set<string>();
    if (this.fanRange) {
      this.fan = this.service(S.Fanv2, ctx.name, 'fan');
      this.fan.setPrimaryService(true);
      const steps = this.fanRange.max;
      this.fan.getCharacteristic(C.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: 1 });
      if (writable(fanDesc)) {
        this.fan.getCharacteristic(C.Active).onSet((v) => this.setFan(v === 1 || v === true ? Math.max(1, this.fanSpeed || 1) : 0));
        this.fan.getCharacteristic(C.RotationSpeed).onSet((v) => this.setFan(Math.round((Number(v) / 100) * steps)));
      }
      keep.add('fan');
    }
    if (this.lampRange) {
      this.lamp = this.service(S.Lightbulb, `${ctx.name} light`, 'lamp');
      if (writable(lampDesc)) {
        const top = this.lampRange.max;
        this.lamp.getCharacteristic(C.On).onSet((v) => this.setLamp(v === true || v === 1 ? Math.max(1, this.brightness || top) : 0));
        this.lamp.getCharacteristic(C.Brightness).onSet((v) => this.setLamp(Math.round((Number(v) / 100) * top)));
      }
      keep.add('lamp');
    }
    this.prune(keep);
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    if (state !== null && state !== undefined) {
      this.fanSpeed = num(stateValue(state, 'ventilation', 'fanSpeed')) ?? this.fanSpeed;
      this.brightness = num(stateValue(state, 'lamp', 'lampBrightness')) ?? this.brightness;
    }
    if (this.fan && this.fanRange) {
      set(this.fan.getCharacteristic(C.Active), this.fanSpeed > 0 ? 1 : 0);
      set(this.fan.getCharacteristic(C.RotationSpeed), Math.round((this.fanSpeed / this.fanRange.max) * 100));
    }
    if (this.lamp && this.lampRange) {
      set(this.lamp.getCharacteristic(C.On), this.brightness > 0);
      set(this.lamp.getCharacteristic(C.Brightness), Math.round((this.brightness / this.lampRange.max) * 100));
    }
  }

  override get busy(): boolean { return this.fanSpeed > 0 || this.brightness > 0; }

  private setFan(speed: number): Promise<void> {
    const s = Math.max(0, Math.min(this.fanRange!.max, speed));
    if (s === this.fanSpeed) { return Promise.resolve(); }
    return this.command(s ? `Fan speed ${s}` : 'Fan off', { ventilation: { fanSpeed: s } }).then(() => { this.fanSpeed = s; });
  }

  private setLamp(level: number): Promise<void> {
    const l = Math.max(0, Math.min(this.lampRange!.max, level));
    if (l === this.brightness) { return Promise.resolve(); }
    return this.command(l ? `Light ${l}` : 'Light off', { lamp: { lampBrightness: l } }).then(() => { this.brightness = l; });
  }
}

