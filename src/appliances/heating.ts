// Water heaters and heat pumps ("system boilers") as thermostats. The heat pump follows
// homebridge-lg-thinq-system-boiler (MIT): one thermostat for room heating or cooling, one for hot
// water. Property names are LG's toolkit's; temperatures come per unit (…InUnits, °C preferred).

import type { Service } from 'homebridge';
import { field } from '../api';
import { Appliance, type ApplianceContext, set, limit } from './base';
import { type Obj, type Range, asObj, enumValues, fieldOf, num, powerField, resources, stateValue, temperatureC, temperatureRangeC } from './profile';

/** A °C range from an …InUnits resource's min/max values in the state (hot water), if given. */
function rangeFromState(state: unknown, resource: string): Range | undefined {
  const r = field(state, resource);
  const c = Array.isArray(r) ? r.map(asObj).find((e) => e?.unit === 'C') : asObj(r);
  const min = num(c?.minTemperature);
  const max = num(c?.maxTemperature);
  return min !== undefined && max !== undefined && max > min ? { min, max, step: 1 } : undefined;
}

/** A thermostat tile: current and target temperature, heat (or cool/auto) and off. */
abstract class Thermostats extends Appliance {
  protected thermostat(name: string, subtype: string, range: Range, modes: number[],
    onMode: (v: number) => Promise<void>, onTarget: (c: number) => Promise<void>): Service {
    const { Service: S, Characteristic: C } = this.hap;
    const svc = this.service(S.Thermostat, name, subtype);
    limit(svc.getCharacteristic(C.TargetHeatingCoolingState), { validValues: modes }).onSet((v) => onMode(Number(v)));
    limit(svc.getCharacteristic(C.TargetTemperature), { minValue: range.min, maxValue: range.max, minStep: range.step })
      .onSet((v) => onTarget(Number(v)));
    limit(svc.getCharacteristic(C.CurrentTemperature), { minValue: -40, maxValue: 100 });
    return svc;
  }

  protected show(svc: Service, on: boolean, mode: number, current: number | undefined, target: number | undefined, range: Range): void {
    const { Characteristic: C } = this.hap;
    const T = C.TargetHeatingCoolingState;
    set(svc.getCharacteristic(T), on ? mode : T.OFF);
    set(svc.getCharacteristic(C.CurrentHeatingCoolingState), !on ? 0 : mode === T.COOL ? 2 : 1);
    if (current !== undefined) { set(svc.getCharacteristic(C.CurrentTemperature), current); }
    if (target !== undefined) { set(svc.getCharacteristic(C.TargetTemperature), Math.min(Math.max(target, range.min), range.max)); }
  }

  protected refuse(why: string): Promise<void> {
    this.ctx.log.info(`[${this.ctx.name}] ${why}`);
    return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
  }
}

export class WaterHeater extends Thermostats {
  readonly tile: Service;
  private readonly power?: { name: string; canWrite: boolean };
  private readonly range: Range;
  on = false;
  private current?: number;
  private target?: number;
  /** Modes beyond the default one (heat pump, turbo, vacation…) as switches; off returns to the default. */
  readonly modeSwitches = new Map<string, Service>();
  private readonly defaultMode?: string;
  private mode = '';

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const res = resources(profile);
    const { Service: S, Characteristic: C } = this.hap;
    this.power = powerField(res);
    this.range = temperatureRangeC(res, 'temperatureInUnits', 'targetTemperature') || { min: 30, max: 70, step: 1 };
    const T = C.TargetHeatingCoolingState;
    this.tile = this.thermostat(ctx.name, 'water', this.range, [T.OFF, T.HEAT], (v) => this.setPower(v !== T.OFF), (c) => this.setTarget(c));
    this.tile.setPrimaryService(true);
    const keep = new Set(['water']);
    const modes = enumValues(fieldOf(res, 'waterHeaterJobMode', 'currentJobMode'), 'w');
    this.defaultMode = modes.includes('AUTO') ? 'AUTO' : modes[0];
    if ((ctx.options?.extraControls ?? ctx.extraControls) !== false && modes.length > 1) {
      for (const mode of modes.filter((m) => m !== this.defaultMode)) {
        const sub = `mode-${mode}`;
        const svc = this.service(S.Switch, `${ctx.name} ${mode.toLowerCase().split('_').join(' ')}`, sub);
        svc.getCharacteristic(C.On).onSet((v) => this.setMode(v === true || v === 1 ? mode : this.defaultMode!));
        this.modeSwitches.set(mode, svc);
        keep.add(sub);
      }
    }
    this.prune(keep);
    this.update(undefined);
  }

  private setMode(mode: string): Promise<void> {
    if (mode === this.mode) { return Promise.resolve(); }
    return this.command(`Mode ${mode.toLowerCase().split('_').join(' ')}`, { waterHeaterJobMode: { currentJobMode: mode } })
      .then(() => { this.mode = mode; this.update(undefined); });
  }

  update(state: unknown): void {
    if (state) {
      if (this.power) { this.on = stateValue(state, 'operation', this.power.name) === 'POWER_ON'; }
      const t = field(state, 'temperatureInUnits') ?? field(state, 'temperature');
      this.current = temperatureC(t, 'currentTemperature') ?? this.current;
      this.target = temperatureC(t, 'targetTemperature') ?? this.target;
      const mode = stateValue(state, 'waterHeaterJobMode', 'currentJobMode');
      if (typeof mode === 'string') { this.mode = mode; }
    }
    this.show(this.tile, this.on, this.hap.Characteristic.TargetHeatingCoolingState.HEAT, this.current, this.target, this.range);
    for (const [mode, svc] of this.modeSwitches) { set(svc.getCharacteristic(this.hap.Characteristic.On), this.mode === mode); }
  }

  override get busy(): boolean { return this.on; }

  private setPower(on: boolean): Promise<void> {
    if (on === this.on) { return Promise.resolve(); }
    if (!this.power?.canWrite) { return this.refuse('It can\'t be switched on or off through LG\'s API.'); }
    return this.command(on ? 'Switched on' : 'Switched off', { operation: { [this.power.name]: on ? 'POWER_ON' : 'POWER_OFF' } })
      .then(() => { this.on = on; });
  }

  private setTarget(c: number): Promise<void> {
    if (c === this.target) { return Promise.resolve(); }
    return this.command(`Set to ${c} °C`, { temperatureInUnits: { targetTemperature: c, unit: 'C' } }).then(() => { this.target = c; });
  }
}

/** Heat pumps: room heating / cooling, and hot water. */
export class HeatPump extends Thermostats {
  readonly room: Service;
  readonly water?: Service;
  private readonly res: Obj;
  private readonly roomRange: Range;
  private waterRange: Range;
  private readonly jobModes: string[];
  powered = false;
  private jobMode = 'HEAT';
  private roomSource = 'AIR';
  private roomCurrent?: number;
  private roomTarget?: number;
  waterOn = false;
  private waterCurrent?: number;
  private waterTarget?: number;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Characteristic: C } = this.hap;
    const T = C.TargetHeatingCoolingState;
    this.res = resources(profile);
    this.jobModes = enumValues(fieldOf(this.res, 'boilerJobMode', 'currentJobMode'), 'w');
    this.roomRange = ['airHeatTargetTemperature', 'waterHeatTargetTemperature', 'targetTemperature']
      .map((n) => temperatureRangeC(this.res, 'roomTemperatureInUnits', n)).find(Boolean) || { min: 5, max: 57, step: 1 };
    const modes = [T.OFF, ...(['HEAT', 'COOL', 'AUTO'] as const).filter((m) => this.jobModes.includes(m))
      .map((m) => (m === 'HEAT' ? T.HEAT : m === 'COOL' ? T.COOL : T.AUTO))];
    this.room = this.thermostat(ctx.name, 'room', this.roomRange, modes.length > 1 ? modes : [T.OFF, T.HEAT],
      (v) => this.setRoomMode(v), (c) => this.setRoomTarget(c));
    this.room.setPrimaryService(true);
    const keep = new Set(['room']);
    this.waterRange = temperatureRangeC(this.res, 'hotWaterTemperatureInUnits', 'targetTemperature') || { min: 30, max: 80, step: 1 };
    if (this.res.hotWaterTemperatureInUnits) {
      this.water = this.thermostat(`${ctx.name} hot water`, 'hot-water', this.waterRange, [T.OFF, T.HEAT],
        (v) => this.setWater(v !== T.OFF), (c) => this.setWaterTarget(c));
      keep.add('hot-water');
    }
    this.prune(keep);
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    const T = C.TargetHeatingCoolingState;
    if (state) {
      this.powered = stateValue(state, 'operation', 'boilerOperationMode') === 'POWER_ON';
      const job = stateValue(state, 'boilerJobMode', 'currentJobMode');
      if (typeof job === 'string') { this.jobMode = job; }
      const source = stateValue(state, 'operation', 'roomTempMode');
      if (typeof source === 'string') { this.roomSource = source; }
      const room = field(state, 'roomTemperatureInUnits');
      const water = this.roomSource === 'WATER';
      this.roomCurrent = temperatureC(room, water ? 'outWaterCurrentTemperature' : 'airCurrentTemperature')
        ?? temperatureC(room, 'currentTemperature') ?? this.roomCurrent;
      this.roomTarget = temperatureC(room, this.targetField()) ?? temperatureC(room, 'targetTemperature') ?? this.roomTarget;
      this.waterOn = stateValue(state, 'operation', 'hotWaterMode') === 'ON';
      const hw = field(state, 'hotWaterTemperatureInUnits');
      this.waterCurrent = temperatureC(hw, 'currentTemperature') ?? this.waterCurrent;
      this.waterTarget = temperatureC(hw, 'targetTemperature') ?? this.waterTarget;
      const r = rangeFromState(state, 'hotWaterTemperatureInUnits');
      if (r && this.water && (r.min !== this.waterRange.min || r.max !== this.waterRange.max)) {
        this.waterRange = r;
        limit(this.water.getCharacteristic(C.TargetTemperature), { minValue: r.min, maxValue: r.max, minStep: 1 });
      }
    }
    const mode = this.jobMode === 'COOL' ? T.COOL : this.jobMode === 'AUTO' ? T.AUTO : T.HEAT;
    this.show(this.room, this.powered, mode, this.roomCurrent, this.roomTarget, this.roomRange);
    if (this.water) { this.show(this.water, this.waterOn, T.HEAT, this.waterCurrent, this.waterTarget, this.waterRange); }
  }

  override get busy(): boolean { return this.powered || this.waterOn; }

  /** Which room set point applies: by heating or cooling, by air or water (as the boiler plugin does). */
  private targetField(): string {
    const cool = this.jobMode === 'COOL';
    return this.roomSource === 'WATER'
      ? (cool ? 'waterCoolTargetTemperature' : 'waterHeatTargetTemperature')
      : (cool ? 'airCoolTargetTemperature' : 'airHeatTargetTemperature');
  }

  private async setRoomMode(v: number): Promise<void> {
    const T = this.hap.Characteristic.TargetHeatingCoolingState;
    if (v === T.OFF) {
      if (!this.powered) { return; }
      await this.command('Heating and cooling off', { operation: { boilerOperationMode: 'POWER_OFF' } });
      this.powered = false;
      return;
    }
    const mode = v === T.COOL ? 'COOL' : v === T.AUTO ? 'AUTO' : 'HEAT';
    if (mode !== this.jobMode) {
      await this.command(`Mode ${mode.toLowerCase()}`, { boilerJobMode: { currentJobMode: mode } });
      this.jobMode = mode;
    }
    if (!this.powered) {
      await this.command('Heating and cooling on', { operation: { boilerOperationMode: 'POWER_ON' } });
      this.powered = true;
    }
  }

  private setRoomTarget(c: number): Promise<void> {
    if (c === this.roomTarget) { return Promise.resolve(); }
    return this.command(`Room set to ${c} °C`, { roomTemperatureInUnits: { [this.targetField()]: c, unit: 'C' } })
      .then(() => { this.roomTarget = c; });
  }

  private setWater(on: boolean): Promise<void> {
    if (on === this.waterOn) { return Promise.resolve(); }
    return this.command(on ? 'Hot water on' : 'Hot water off', { operation: { hotWaterMode: on ? 'ON' : 'OFF' } })
      .then(() => { this.waterOn = on; });
  }

  private setWaterTarget(c: number): Promise<void> {
    if (c === this.waterTarget) { return Promise.resolve(); }
    return this.command(`Hot water set to ${c} °C`, { hotWaterTemperatureInUnits: { targetTemperature: c, unit: 'C' } })
      .then(() => { this.waterTarget = c; });
  }
}

