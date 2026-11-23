// Reading LG profiles and states for any appliance type.
//
// A profile lists resources (operation, temperature, airFlow…), each with fields that say their
// type (enum, range, number, boolean) and mode ('r' read, 'w' write), and the values allowed for
// each mode. A state has the same resources with current values. Some resources are lists, one
// entry per location (a fridge's FRIDGE and FREEZER) or per unit (temperatureInUnits: C and F).

import { field } from '../api';

export type Obj = Record<string, unknown>;

export const asObj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined;

/** A profile's resources as one object (a list of property sets is merged, first wins). */
export function resources(profile: unknown): Obj {
  const p = field(profile, 'property');
  if (Array.isArray(p)) {
    const out: Obj = {};
    for (const set of p) {
      for (const [k, v] of Object.entries(asObj(set) || {})) { if (!(k in out)) { out[k] = v; } }
    }
    return out;
  }
  return asObj(p) || {};
}

/** A field's description in a resource: { type, mode, value }. */
export function fieldOf(res: Obj, resource: string, name: string): Obj | undefined {
  return asObj(field(res[resource], name));
}

export const readable = (desc: Obj | undefined): boolean => !!desc && (!Array.isArray(desc.mode) || (desc.mode as unknown[]).includes('r'));
export const writable = (desc: Obj | undefined): boolean => !!desc && Array.isArray(desc.mode) && (desc.mode as unknown[]).includes('w');

/** An enum field's values for reading or writing (strings only). */
export function enumValues(desc: Obj | undefined, mode: 'r' | 'w'): string[] {
  const list = field(field(desc, 'value'), mode);
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
}

export interface Range { min: number; max: number; step: number }

/** A range field's limits for reading or writing. */
export function rangeOf(desc: Obj | undefined, mode: 'r' | 'w'): Range | undefined {
  const r = field(field(desc, 'value'), mode);
  const min = field(r, 'min');
  const max = field(r, 'max');
  const step = field(r, 'step');
  if (typeof min !== 'number' || typeof max !== 'number' || max < min) { return undefined; }
  return { min, max, step: typeof step === 'number' && step > 0 ? step : 1 };
}

/**
 * The field in a resource that turns the appliance on and off: an enum whose values include
 * POWER_ON and POWER_OFF (airConOperationMode, dehumidifierOperationMode, …).
 */
export function powerField(res: Obj, resource = 'operation'): { name: string; canWrite: boolean } | undefined {
  for (const [name, d] of Object.entries(asObj(res[resource]) || {})) {
    const desc = asObj(d);
    const values = [...enumValues(desc, 'r'), ...enumValues(desc, 'w')];
    if (values.includes('POWER_ON') && values.includes('POWER_OFF')) {
      return { name, canWrite: writable(desc) && enumValues(desc, 'w').includes('POWER_ON') };
    }
  }
  return undefined;
}

/** The field in a resource that starts and stops a cycle: an enum with START among its write values. */
export function startField(res: Obj, resource = 'operation'): { name: string; values: string[] } | undefined {
  for (const [name, d] of Object.entries(asObj(res[resource]) || {})) {
    const values = enumValues(asObj(d), 'w');
    if (values.includes('START')) { return { name, values }; }
  }
  return undefined;
}

/** A value from a state: state[resource][name]. */
export function stateValue(state: unknown, resource: string, name: string): unknown {
  return field(field(state, resource), name);
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const fToC = (f: number): number => Math.round(((f - 32) * 5 / 9) * 10) / 10;
export const cToF = (c: number): number => c * 9 / 5 + 32;

/**
 * A temperature in °C from a resource that is either { <name>, unit } or a list of such
 * entries, one per unit (temperatureInUnits). Prefers the °C entry; converts °F.
 */
export function temperatureC(resource: unknown, name: string): number | undefined {
  if (Array.isArray(resource)) {
    const entries = resource.map(asObj).filter((e): e is Obj => !!e);
    const c = entries.find((e) => e.unit === 'C');
    if (c && num(c[name]) !== undefined) { return num(c[name]); }
    const f = entries.find((e) => e.unit === 'F');
    const fv = f ? num(f[name]) : undefined;
    return fv === undefined ? undefined : fToC(fv);
  }
  const value = num(field(resource, name));
  if (value === undefined) { return undefined; }
  return field(resource, 'unit') === 'F' ? fToC(value) : value;
}

/** The writable °C range of a temperature field, from a resource or its °C entry. */
export function temperatureRangeC(res: Obj, resource: string, name: string): Range | undefined {
  const r = res[resource];
  if (Array.isArray(r)) {
    const c = r.map(asObj).find((e) => e?.unit === 'C');
    return c ? rangeOf(asObj(c[name]), 'w') : undefined;
  }
  return rangeOf(fieldOf(res, resource, name), 'w');
}

/** The unit an appliance currently reports temperatures in ('C' unless it says 'F'). */
export function unitOf(state: unknown, resource: string): 'C' | 'F' {
  const r = field(state, resource);
  const u = Array.isArray(r) ? undefined : field(r, 'unit');
  return u === 'F' ? 'F' : 'C';
}

/** Entries of a per-location resource ([{ locationName, … }]) in a profile or state. */
export function locations(resource: unknown): { location: string; entry: Obj }[] {
  const list = Array.isArray(resource) ? resource : (asObj(resource) ? [resource] : []);
  return list.map(asObj).filter((e): e is Obj => !!e)
    .map((entry) => ({ location: typeof entry.locationName === 'string' ? entry.locationName : '', entry }));
}

/** Percent of a list of named levels (LOW, MID, HIGH): 1 of 3 is 33, 3 of 3 is 100; AUTO and unknown 0. */
export function levelPercent(levels: string[], value: unknown): number {
  const i = typeof value === 'string' ? levels.indexOf(value) : -1;
  return i < 0 ? 0 : Math.round(((i + 1) / levels.length) * 100);
}

/** The named level nearest a percent (at least the lowest). */
export function levelFor(levels: string[], percent: number): string {
  const i = Math.max(0, Math.min(levels.length - 1, Math.ceil((percent / 100) * levels.length) - 1));
  return levels[i];
}

/**
 * Speed levels from an enum field's write values: the named speeds in LG's order, then AUTO at the
 * top of the slider when the appliance offers it, as homebridge-lg-thinqconnect-ac does
 * (LOW/MID/HIGH/AUTO is 25/50/75/100 %). Other modes (NATURE, POWER) aren't speeds and are left out.
 */
export function speedLevels(desc: Obj | undefined): string[] {
  const values = enumValues(desc, 'w');
  const speeds = values.filter((v) => !/AUTO|NATURE|POWER/.test(v));
  return values.includes('AUTO') ? [...speeds, 'AUTO'] : speeds;
}
