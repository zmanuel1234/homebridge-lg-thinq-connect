// Appliances that move or treat air: air purifiers, dehumidifiers, humidifiers, fans (ceiling
// fans, ventilators, air purifier fans) and range hoods. Property names follow LG's toolkit and
// Home Assistant's integration; dehumidifier, air purifier and hood sample data is Home Assistant's.

import type { CharacteristicValue, Service } from 'homebridge';
import { field } from '../api';
import { alertKind } from '../laundry';
import { alertCodes } from './air-conditioner';
import { Appliance, type ApplianceContext, set } from './base';
import {
  type Obj, type Range, fieldOf, levelFor, levelPercent, num, powerField, rangeOf, resources, speedLevels,
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

// ---- Air quality and filters (air purifiers, some air conditioners and humidifiers) ----

const AIR_QUALITY: Record<string, number> = { GOOD: 2, NORMAL: 3, BAD: 4, VERY_BAD: 5 };

/** Filter life left in percent: filterRemainPercent, or from used and lifetime hours. */
export function filterPercent(state: unknown): number | undefined {
  const info = field(state, 'filterInfo');
  const remain = num(field(info, 'filterRemainPercent')) ?? num(field(info, 'topFilterRemainPercent'));
  if (remain !== undefined) { return Math.max(0, Math.min(100, remain)); }
  const life = num(field(info, 'filterLifetime'));
  const used = num(field(info, 'usedTime'));
  return life && used !== undefined ? Math.max(0, Math.min(100, Math.round(100 * (1 - used / life)))) : undefined;
}

export class AirPurifier extends Powered {
  readonly tile: Service;
  private readonly quality?: Service;
  private readonly filter?: Service;
  private state: unknown = undefined;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx, profile);
    const { Service: S, Characteristic: C } = this.hap;
    this.tile = this.service(S.AirPurifier, ctx.name, 'purifier');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    this.tile.getCharacteristic(C.TargetAirPurifierState).setProps({ validValues: [C.TargetAirPurifierState.MANUAL] });
    this.speedCharacteristic(this.tile);
    const keep = new Set(['purifier']);
    if (this.res.airQualitySensor) {
      this.quality = this.service(S.AirQualitySensor, `${ctx.name} air quality`, 'air-quality');
      keep.add('air-quality');
    }
    if (this.res.filterInfo) {
      this.filter = this.service(S.FilterMaintenance, `${ctx.name} filter`, 'filter');
      keep.add('filter');
    }
    this.problemFromProfile(profile, keep);
    this.prune(keep);
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    this.readPower(state);
    if (state !== null && state !== undefined) { this.state = state; }
    set(this.tile.getCharacteristic(C.Active), this.on ? 1 : 0);
    set(this.tile.getCharacteristic(C.CurrentAirPurifierState),
      this.on ? C.CurrentAirPurifierState.PURIFYING_AIR : C.CurrentAirPurifierState.INACTIVE);
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    if (this.quality) {
      const aq = field(this.state, 'airQualitySensor');
      const level = field(aq, 'totalPollutionLevel');
      set(this.quality.getCharacteristic(C.AirQuality), typeof level === 'string' ? AIR_QUALITY[level] ?? 0 : 0);
      const pm25 = num(field(aq, 'PM2'));
      const pm10 = num(field(aq, 'PM10'));
      if (pm25 !== undefined) { set(this.quality.getCharacteristic(C.PM2_5Density), Math.min(pm25, 1000)); }
      if (pm10 !== undefined) { set(this.quality.getCharacteristic(C.PM10Density), Math.min(pm10, 1000)); }
    }
    if (this.filter) {
      const pct = filterPercent(this.state);
      if (pct !== undefined) {
        set(this.filter.getCharacteristic(C.FilterLifeLevel), pct);
        set(this.filter.getCharacteristic(C.FilterChangeIndication),
          pct <= 10 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK);
      }
    }
    this.renderProblem();
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

