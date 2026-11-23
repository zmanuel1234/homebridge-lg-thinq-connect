// Robot vacuums, and a basic fallback for appliance types without a mapping of their own.

import type { Service } from 'homebridge';
import { field } from '../api';
import { stateLabel } from '../laundry';
import { Appliance, type ApplianceContext, set } from './base';
import { type Obj, asObj, enumValues, fieldOf, locations, num, powerField, resources, stateValue, temperatureC } from './profile';

// Robot vacuum states, as Home Assistant groups them (its vacuum.py), in LG's upper case.
const CLEANING = new Set(['WORKING', 'STATION', 'STATION_DRY', 'CLEAN_LEARNING', 'DETECTING', 'CLEANING']);
const CHARGING = new Set(['CHARGING']);
const HOMING = new Set(['HOMING']);

/**
 * Robot vacuums: the Home app has no vacuum tile, so a switch that is on while cleaning (off sends
 * it home, on starts or resumes it), and a battery.
 */
export class RobotVacuum extends Appliance {
  readonly tile: Service;
  readonly battery: Service;
  private readonly canClean: boolean;
  private state = 'UNKNOWN';
  private percent?: number;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    const res = resources(profile);
    this.canClean = enumValues(fieldOf(res, 'operation', 'cleanOperationMode'), 'w').length > 0;
    this.tile = this.service(S.Switch, ctx.name, 'clean');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.On).onSet((v) => this.setCleaning(v === true || v === 1));
    this.battery = this.service(S.Battery, `${ctx.name} battery`, 'battery');
    this.addProblemSensor();
    this.prune(new Set(['clean', 'battery', 'problem']));
    this.update(undefined);
  }

  get cleaning(): boolean { return CLEANING.has(this.state); }
  override get busy(): boolean { return this.cleaning || HOMING.has(this.state); }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    if (state) {
      const s = stateValue(state, 'runState', 'currentState');
      if (typeof s === 'string') {
        const next = s.toUpperCase();
        if (next !== this.state && this.state !== 'UNKNOWN') { this.ctx.log.info(`[${this.ctx.name}] ${stateLabel(next)}.`); }
        if (CLEANING.has(next)) { this.problemAlert = ''; }
        this.state = next;
      }
      const battery = field(state, 'battery');
      this.percent = batteryPercent(battery) ?? this.percent;
    }
    set(this.tile.getCharacteristic(C.On), this.cleaning);
    if (this.percent !== undefined) {
      set(this.battery.getCharacteristic(C.BatteryLevel), Math.max(0, Math.min(100, this.percent)));
      set(this.battery.getCharacteristic(C.StatusLowBattery), this.percent <= 20 ? 1 : 0);
    }
    set(this.battery.getCharacteristic(C.ChargingState), CHARGING.has(this.state) ? 1 : 0);
    this.renderProblem();
  }

  private setCleaning(on: boolean): Promise<void> {
    if (on === this.cleaning) { return Promise.resolve(); }
    if (!this.canClean) {
      this.ctx.log.info(`[${this.ctx.name}] It can't be started or sent home through LG's API.`);
      return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
    }
    // As Home Assistant does: wake a sleeping one, resume a paused one, otherwise start; off goes home
    const mode = !on ? 'HOMING' : this.state === 'SLEEP' ? 'WAKE_UP' : this.state === 'PAUSE' ? 'RESUME' : 'START';
    return this.command(on ? 'Cleaning' : 'Sent home', { operation: { cleanOperationMode: mode } });
  }
}

/** Battery percent from LG's battery object: a percent, or a level word. */
function batteryPercent(battery: unknown): number | undefined {
  return num(field(battery, 'percent'))
    ?? ({ FULL: 100, OVER_CHARGE: 100, HIGH: 100, MID: 60, MIDDLE: 60, LOW: 20, DOCK_LEVEL: 10, WARNING: 10, MOVELESS: 5 } as Record<string, number>)[String(field(battery, 'level'))];
}

/**
 * Cordless stick vacuums: LG's API only reports them (no control): the battery, whether it's
 * charging, and its state changes in the log.
 */
export class StickVacuum extends Appliance {
  readonly battery: Service;
  private state = 'UNKNOWN';
  private percent?: number;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    void profile;
    const { Service: S } = this.hap;
    this.battery = this.service(S.Battery, `${ctx.name} battery`, 'battery');
    this.battery.setPrimaryService(true);
    this.addProblemSensor();
    this.prune(new Set(['battery', 'problem']));
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    if (state) {
      const s = stateValue(state, 'runState', 'currentState');
      if (typeof s === 'string') {
        const next = s.toUpperCase();
        if (next !== this.state && this.state !== 'UNKNOWN') { this.ctx.log.info(`[${this.ctx.name}] ${stateLabel(next)}.`); }
        this.state = next;
      }
      this.percent = batteryPercent(field(state, 'battery')) ?? this.percent;
    }
    if (this.percent !== undefined) {
      set(this.battery.getCharacteristic(C.BatteryLevel), Math.max(0, Math.min(100, this.percent)));
      set(this.battery.getCharacteristic(C.StatusLowBattery), this.percent <= 20 ? 1 : 0);
    }
    set(this.battery.getCharacteristic(C.ChargingState), /CHARG/.test(this.state) && !/COMPLETE|FULL/.test(this.state) ? 1 : 0);
    this.renderProblem();
  }
}

/**
 * Any other appliance type: what its profile shows that the Home app can display. On/off as a
 * switch (when LG lets it be switched), temperatures as temperature sensors, humidity as a humidity
 * sensor, and LG's problem alerts on a problem sensor. Volunteers' reports turn these into proper
 * mappings.
 */
/** Full state checks after an alert before a basic appliance's problem sensor closes again. */
const CLEAR_ALERT_AFTER = 3;

export class Basic extends Appliance {
  readonly power?: Service;
  readonly temperatures = new Map<string, Service>();
  readonly humidity?: Service;
  private readonly powerInfo?: { name: string; canWrite: boolean };
  private on = false;
  private readonly values = new Map<string, number>();

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    const res = resources(profile);
    const keep = new Set<string>();
    this.powerInfo = powerField(res);
    if (this.powerInfo) {
      this.power = this.service(S.Switch, ctx.name, 'power');
      this.power.setPrimaryService(true);
      this.power.getCharacteristic(C.On).onSet((v) => this.setPower(v === true || v === 1));
      keep.add('power');
    }
    for (const key of Basic.temperatureKeys(res)) {
      const sub = `temp-${key}`;
      const label = key === 'temperature' ? 'temperature' : `${stateLabel(key).toLowerCase()} temperature`;
      this.temperatures.set(key, this.service(S.TemperatureSensor, `${ctx.name} ${label}`, sub));
      this.temperatures.get(key)!.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 300 });
      keep.add(sub);
    }
    if (fieldOf(res, 'humidity', 'currentHumidity') || fieldOf(res, 'airQualitySensor', 'humidity')) {
      this.humidity = this.service(S.HumiditySensor, `${ctx.name} humidity`, 'humidity');
      keep.add('humidity');
    }
    this.addProblemSensor();
    keep.add('problem');
    this.prune(keep);
    this.update(undefined);
  }

  /** Resources holding a current temperature: temperature, temperatureInUnits, or per location. */
  static temperatureKeys(res: Obj): string[] {
    const keys: string[] = [];
    for (const name of ['temperature', 'temperatureInUnits']) {
      const r = res[name];
      if (Array.isArray(r)) {
        const located = locations(r).filter((l) => l.location && asObj(l.entry.currentTemperature));
        if (located.length) { keys.push(...located.map((l) => `${name}:${l.location}`)); continue; }
        if (r.some((e) => asObj(asObj(e)?.currentTemperature))) { keys.push(name); }
      } else if (asObj(field(r, 'currentTemperature'))) {
        keys.push(name);
      }
    }
    // temperature and temperatureInUnits describe the same thing: keep one
    return keys.includes('temperatureInUnits') ? keys.filter((k) => k !== 'temperature') : keys;
  }

  override get busy(): boolean { return this.on; }
  private cleanChecks = 0;

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    if (state) {
      const wasOn = this.on;
      if (this.powerInfo) { this.on = stateValue(state, 'operation', this.powerInfo.name) === 'POWER_ON'; }
      // An alert ends when the appliance is switched on or off, or after a few normal checks
      if (this.problemAlert && (wasOn !== this.on || ++this.cleanChecks >= CLEAR_ALERT_AFTER)) {
        this.problemAlert = '';
      }
      if (!this.problemAlert) { this.cleanChecks = 0; }
      for (const key of this.temperatures.keys()) {
        const [resource, location] = key.split(':');
        const r = field(state, resource);
        const entry = location ? locations(r).find((l) => l.location === location)?.entry : r;
        const t = temperatureC(entry, 'currentTemperature');
        if (t !== undefined) { this.values.set(key, t); }
      }
      const h = num(stateValue(state, 'humidity', 'currentHumidity')) ?? num(stateValue(state, 'airQualitySensor', 'humidity'));
      if (h !== undefined) { this.values.set('humidity', h); }
    }
    if (this.power) { set(this.power.getCharacteristic(C.On), this.on); }
    for (const [key, svc] of this.temperatures) {
      const t = this.values.get(key);
      if (t !== undefined) { set(svc.getCharacteristic(C.CurrentTemperature), t); }
    }
    const h = this.values.get('humidity');
    if (this.humidity && h !== undefined) { set(this.humidity.getCharacteristic(C.CurrentRelativeHumidity), Math.max(0, Math.min(100, h))); }
    this.renderProblem();
  }

  private setPower(on: boolean): Promise<void> {
    if (on === this.on) { return Promise.resolve(); }
    if (!this.powerInfo?.canWrite) {
      this.ctx.log.info(`[${this.ctx.name}] It can't be switched on or off through LG's API.`);
      return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
    }
    return this.command(on ? 'Switched on' : 'Switched off', { operation: { [this.powerInfo.name]: on ? 'POWER_ON' : 'POWER_OFF' } })
      .then(() => { this.on = on; });
  }
}

/** True when the fallback has anything to show for a profile. */
export function basicHasSomething(profile: unknown): boolean {
  const res = resources(profile);
  return !!powerField(res) || Basic.temperatureKeys(res).length > 0
    || !!fieldOf(res, 'humidity', 'currentHumidity') || !!fieldOf(res, 'airQualitySensor', 'humidity');
}
