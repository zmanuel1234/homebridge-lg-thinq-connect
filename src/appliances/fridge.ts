// Refrigerators (and wine cellars): door-open sensors, a set temperature per compartment, the
// express modes as switches, and filters. LG reports each compartment's set temperature, not the
// measured one, so the compartments show the set temperature as their temperature.
//
// Property names and shapes are LG's toolkit's: doorStatus and temperatureInUnits are lists with
// one entry per door (MAIN) or compartment (FRIDGE, FREEZER, CONVERTIBLE).

import type { Service } from 'homebridge';
import { field } from '../api';
import { Appliance, type ApplianceContext, set } from './base';
import { type Range, asObj, fToC, locations, num, rangeOf, resources, writable } from './profile';
import { stateLabel } from '../laundry';

const SWITCHES: { resource: string; name: string; label: string }[] = [
  { resource: 'refrigeration', name: 'expressMode', label: 'express freeze' },
  { resource: 'refrigeration', name: 'rapidFreeze', label: 'rapid freeze' },
  { resource: 'refrigeration', name: 'expressFridge', label: 'express cool' },
  { resource: 'ecoFriendly', name: 'ecoFriendlyMode', label: 'eco mode' },
];

interface Compartment { location: string; service: Service; range: Range; unitF: boolean; target?: number }

export class Fridge extends Appliance {
  readonly doors = new Map<string, Service>();
  readonly compartments: Compartment[] = [];
  readonly switches = new Map<string, Service>();
  private readonly filter?: Service;
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
      svc.getCharacteristic(T).setProps({ validValues: [T.COOL] });
      svc.getCharacteristic(C.TargetTemperature).setProps({ minValue: range.min, maxValue: range.max, minStep: range.step });
      svc.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 100 });
      const comp: Compartment = { location, service: svc, range, unitF: !rc };
      if (writable(rc ? c : f)) {
        svc.getCharacteristic(C.TargetTemperature).onSet((v) => this.setTarget(comp, Number(v)));
      }
      this.compartments.push(comp);
      keep.add(sub);
    }
    for (const s of SWITCHES) {
      const desc = asObj(field(res[s.resource], s.name));
      if (!writable(desc) || desc?.type !== 'boolean') { continue; }
      const sub = `switch-${s.name}`;
      const svc = this.service(S.Switch, `${ctx.name} ${s.label}`, sub);
      svc.getCharacteristic(C.On).onSet((v) => this.command(`${s.label} ${v ? 'on' : 'off'}`, { [s.resource]: { [s.name]: v === true || v === 1 } })
        .then(() => { this.values.set(s.name, v === true || v === 1); }));
      this.switches.set(s.name, svc);
      keep.add(sub);
    }

    if (field(res.waterFilterInfo, 'waterFilter1RemainPercent') || field(res.refrigeration, 'freshAirFilterRemainPercent')) {
      this.filter = this.service(S.FilterMaintenance, `${ctx.name} filter`, 'filter');
      keep.add('filter');
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
      for (const s of SWITCHES) {
        const v = field(field(state, s.resource), s.name);
        if (typeof v === 'boolean') { this.values.set(s.name, v); }
      }
      const filter = num(field(field(state, 'waterFilterInfo'), 'waterFilter1RemainPercent'))
        ?? num(field(field(state, 'refrigeration'), 'freshAirFilterRemainPercent'));
      if (filter !== undefined) { this.values.set('filter', filter); }
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
    for (const [name, svc] of this.switches) {
      set(svc.getCharacteristic(C.On), this.values.get(name) === true);
    }
    const filter = this.values.get('filter');
    if (this.filter && typeof filter === 'number') {
      set(this.filter.getCharacteristic(C.FilterLifeLevel), Math.max(0, Math.min(100, filter)));
      set(this.filter.getCharacteristic(C.FilterChangeIndication),
        filter <= 10 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK);
    }
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

