// Refrigerators (and wine cellars): door-open sensors, a set temperature per compartment, the
// express modes as switches, and filters. LG reports each compartment's set temperature, not the
// measured one, so the compartments show the set temperature as their temperature.
//
// Property names and shapes are LG's toolkit's: doorStatus and temperatureInUnits are lists with
// one entry per door (MAIN) or compartment (FRIDGE, FREEZER, CONVERTIBLE).

import type { Service } from 'homebridge';
import { field } from '../api.js';
import { Appliance, type ApplianceContext, set, limit } from './base.js';
import { type Range, asObj, fToC, locations, num, rangeOf, resources, writable } from './profile.js';
import { stateLabel } from '../laundry.js';
import { onOffValues } from './air.js';

/** On/off settings: a switch when LG lets them be changed, else a status sensor (on while set). */
const SWITCHES: { resource: string; name: string; label: string }[] = [
  { resource: 'refrigeration', name: 'expressMode', label: 'express freeze' },
  { resource: 'refrigeration', name: 'rapidFreeze', label: 'rapid freeze' },
  { resource: 'refrigeration', name: 'expressFridge', label: 'express cool' },
  { resource: 'ecoFriendly', name: 'ecoFriendlyMode', label: 'eco mode' },
  { resource: 'powerSave', name: 'powerSaveEnabled', label: 'power saving' },
  // Read-only through LG's API on the fridges reported so far (control returns 2201)
  { resource: 'sabbath', name: 'sabbathMode', label: 'sabbath mode' },
  // Wine cellars
  { resource: 'operation', name: 'sabbathMode', label: 'sabbath mode' },
  { resource: 'operation', name: 'optimalHumidity', label: 'optimal humidity' },
];

/** Filters: [resource, property, subtype, label]. The first found keeps the subtype "filter". */
const FILTERS: [string, string, string][] = [
  ['waterFilterInfo', 'waterFilter1RemainPercent', 'water filter'],
  ['waterFilterInfo', 'waterFilter2RemainPercent', 'water filter 2'],
  ['waterFilterInfo', 'waterFilter3RemainPercent', 'water filter 3'],
  ['refrigeration', 'freshAirFilterRemainPercent', 'air filter'],
];

interface Flag { resource: string; name: string; label: string; on: unknown; off: unknown; service: Service; writable: boolean }

interface Compartment { location: string; service: Service; range: Range; unitF: boolean; target?: number }

export class Fridge extends Appliance {
  readonly doors = new Map<string, Service>();
  readonly compartments: Compartment[] = [];
  readonly flags: Flag[] = [];
  readonly filters: { resource: string; name: string; service: Service }[] = [];
  readonly light?: Service;
  private readonly lightRange?: Range;
  private readonly values = new Map<string, unknown>();

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    const res = resources(profile);
    const keep = new Set<string>();

    for (const { location } of locations(res.doorStatus)) {
      const sub = `door-${location || 'MAIN'}`;
      const label = !location || location === 'MAIN' ? 'door' : `${stateLabel(location).toLowerCase()} door`;
      this.doors.set(location, this.service(S.ContactSensor, `${ctx.name} ${label}`, sub));
      keep.add(sub);
    }

    for (const { location, entry } of locations(res.temperatureInUnits)) {
      const c = asObj(entry.targetTemperatureC);
      const f = asObj(entry.targetTemperatureF);
      const rc = rangeOf(c, 'w') || rangeOf(c, 'r');
      const rf = rangeOf(f, 'w') || rangeOf(f, 'r');
      const range = rc || (rf ? { min: fToC(rf.min), max: fToC(rf.max), step: 0.5 } : undefined);
      if (!range) { continue; }
      const sub = `temp-${location}`;
      const svc = this.service(S.Thermostat, `${ctx.name} ${stateLabel(location || 'fridge').toLowerCase()}`, sub);
      const T = C.TargetHeatingCoolingState;
      limit(svc.getCharacteristic(T), { validValues: [T.COOL] });
      limit(svc.getCharacteristic(C.TargetTemperature), { minValue: range.min, maxValue: range.max, minStep: range.step });
      limit(svc.getCharacteristic(C.CurrentTemperature), { minValue: -40, maxValue: 100 });
      const comp: Compartment = { location, service: svc, range, unitF: !rc };
      if (writable(rc ? c : f)) {
        svc.getCharacteristic(C.TargetTemperature).onSet((v) => this.setTarget(comp, Number(v)));
      }
      this.compartments.push(comp);
      keep.add(sub);
    }
    for (const sw of SWITCHES) {
      const desc = asObj(field(res[sw.resource], sw.name));
      if (!desc || this.flags.some((f) => f.name === sw.name)) { continue; }
      const canWrite = onOffValues(desc);
      const readValues = desc.type === 'boolean' ? { on: true, off: false } : onOffValues({ ...desc, mode: ['w'], value: { w: field(desc.value, 'r') } });
      const values = canWrite || readValues;
      if (!values) { continue; }
      const sub = `${canWrite ? 'switch' : 'status'}-${sw.name}`;
      const service = canWrite
        ? this.service(S.Switch, `${ctx.name} ${sw.label}`, sub)
        : this.service(S.OccupancySensor, `${ctx.name} ${sw.label}`, sub);
      const flag: Flag = { ...sw, ...values, service, writable: !!canWrite };
      if (canWrite) {
        service.getCharacteristic(C.On).onSet((v) => {
          const on = v === true || v === 1;
          return this.command(`${sw.label[0].toUpperCase()}${sw.label.slice(1)} ${on ? 'on' : 'off'}`, { [sw.resource]: { [sw.name]: on ? flag.on : flag.off } })
            .then(() => { this.values.set(sw.name, on); });
        });
      }
      this.flags.push(flag);
      keep.add(sub);
    }

    for (const [resource, name, label] of FILTERS) {
      if (!field(res[resource], name)) { continue; }
      const sub = this.filters.length ? `filter-${name}` : 'filter';
      this.filters.push({ resource, name, service: this.service(S.FilterMaintenance, `${ctx.name} ${label}`, sub) });
      keep.add(sub);
    }

    // Wine cellars: the light's brightness, when LG lets it be changed
    const light = asObj(field(res.operation, 'lightStatus'));
    this.lightRange = writable(light) ? rangeOf(light, 'w') : undefined;
    if (this.lightRange) {
      this.light = this.service(S.Lightbulb, `${ctx.name} light`, 'light');
      this.light.getCharacteristic(C.On).onSet((v) => this.setLight(v === true || v === 1 ? this.lightRange!.max : 0));
      limit(this.light.getCharacteristic(C.Brightness), { minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((v) => this.setLight(Math.round((Number(v) / 100) * this.lightRange!.max)));
      keep.add('light');
    }
    // LG's fridge alerts (a door left open, filter due) are logged; the door sensors cover the doors
    this.prune(keep);
    this.update(undefined);
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    if (state) {
      for (const { location, entry } of locations(field(state, 'doorStatus'))) {
        this.values.set(`door-${location}`, entry.doorState);
      }
      for (const { location, entry } of locations(field(state, 'temperatureInUnits'))) {
        const comp = this.compartments.find((c) => c.location === location);
        if (!comp) { continue; }
        const unit = entry.unit === 'F' ? 'F' : 'C';
        const v = num(entry[`targetTemperature${unit}`]) ?? num(entry.targetTemperature);
        if (v !== undefined) { comp.target = unit === 'F' ? fToC(v) : v; }
      }
      for (const f of this.flags) {
        const v = field(field(state, f.resource), f.name);
        if (v === f.on || v === f.off) { this.values.set(f.name, v === f.on); }
      }
      for (const f of this.filters) {
        const v = num(field(field(state, f.resource), f.name));
        if (v !== undefined) { this.values.set(`filter-${f.name}`, v); }
      }
      const op = field(state, 'operation');
      const light = num(field(op, 'lightStatus'));
      if (light !== undefined) { this.values.set('light', light); }
      const lightControl = field(op, 'lightStatusControlEnabled');
      if (typeof lightControl === 'boolean') { this.values.set('lightControl', lightControl); }
    }
    for (const [location, svc] of this.doors) {
      const open = this.values.get(`door-${location}`) === 'OPEN';
      set(svc.getCharacteristic(C.ContactSensorState), open ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
    }
    for (const comp of this.compartments) {
      if (comp.target === undefined) { continue; }
      const t = Math.min(Math.max(comp.target, comp.range.min), comp.range.max);
      set(comp.service.getCharacteristic(C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.COOL);
      set(comp.service.getCharacteristic(C.CurrentHeatingCoolingState), C.CurrentHeatingCoolingState.COOL);
      set(comp.service.getCharacteristic(C.TargetTemperature), t);
      set(comp.service.getCharacteristic(C.CurrentTemperature), comp.target);
    }
    for (const f of this.flags) {
      const on = this.values.get(f.name) === true;
      if (f.writable) { set(f.service.getCharacteristic(C.On), on); } else { set(f.service.getCharacteristic(C.OccupancyDetected), on ? 1 : 0); }
    }
    for (const f of this.filters) {
      const pct = this.values.get(`filter-${f.name}`);
      if (typeof pct !== 'number') { continue; }
      set(f.service.getCharacteristic(C.FilterLifeLevel), Math.max(0, Math.min(100, pct)));
      set(f.service.getCharacteristic(C.FilterChangeIndication),
        pct <= 10 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK);
    }
    const level = this.values.get('light');
    if (this.light && this.lightRange && typeof level === 'number') {
      set(this.light.getCharacteristic(C.On), level > 0);
      const brightness = this.light.getCharacteristic(C.Brightness);
      // Off keeps the last brightness (pushed again, so a refused change can't leave an error behind)
      set(brightness, level > 0 ? Math.round((level / this.lightRange.max) * 100) : Number(brightness.value) || 0);
    }
  }

  /** Wine cellar light: LG lists it as changeable but refuses while lightStatusControlEnabled is false. */
  private setLight(wanted: number): Promise<void> {
    // Within LG's range and steps (a light whose range starts above 0 can only be dimmed, not switched off)
    const r = this.lightRange!;
    const level = Math.min(r.max, Math.max(r.min, Math.round(wanted / r.step) * r.step));
    if (level === this.values.get('light')) { setTimeout(() => this.update(undefined), 50).unref?.(); return Promise.resolve(); }
    if (this.values.get('lightControl') === false) {
      this.ctx.log.info(`[${this.ctx.name}] LG doesn't allow changing the light right now (light control is off on the wine cellar).`);
      setTimeout(() => this.update(undefined), 50).unref?.();
      return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
    }
    return this.command(level ? `Light ${level}` : 'Light off', { operation: { lightStatus: level } })
      .then(() => { this.values.set('light', level); });
  }

  private setTarget(comp: Compartment, celsius: number): Promise<void> {
    if (comp.unitF) {
      const f = Math.round(celsius * 9 / 5 + 32);
      return this.command(`${stateLabel(comp.location)} set to ${f} °F`,
        { temperatureInUnits: { locationName: comp.location, unit: 'F', targetTemperatureF: f } })
        .then(() => { comp.target = celsius; });
    }
    return this.command(`${stateLabel(comp.location)} set to ${celsius} °C`,
      { temperatureInUnits: { locationName: comp.location, unit: 'C', targetTemperatureC: celsius } })
      .then(() => { comp.target = celsius; });
  }
}

