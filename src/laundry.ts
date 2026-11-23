// Washers and dryers: reading LG's profile (what a machine reports and accepts) and its state.
//
// LG describes laundry machines in three shapes:
//  - a dryer: one set of properties, `{ runState, timer, ... }`;
//  - a washer (and wash combo, WashTower washer): a list of sets, one per drum, each with
//    `location.locationName` (MAIN, MINI); the state is a list in the same shape;
//  - a WashTower as one device: `{ washer: ..., dryer: ... }`, and commands wrapped the same way.
// Each drum or machine becomes one "unit" here, and one accessory in the Home app.
//
// Other appliances that run cycles the same way (dishwashers, Stylers, ovens: runState, timer,
// an operation with START and STOP) use the same code, as experimental types.

import { field } from './api';

export type LaundryKind = 'washer' | 'dryer' | 'dishwasher' | 'styler' | 'oven';

/** LG device types handled as laundry, and what each one is. 'tower' = WashTower as one device. */
const TYPES: Record<string, LaundryKind | 'tower'> = {
  DEVICE_WASHER: 'washer',
  DEVICE_WASHTOWER_WASHER: 'washer',
  DEVICE_WASHCOMBO_MAIN: 'washer',
  DEVICE_WASHCOMBO_MINI: 'washer',
  DEVICE_DRYER: 'dryer',
  DEVICE_WASHTOWER_DRYER: 'dryer',
  DEVICE_WASHTOWER: 'tower',
};

/** Other appliances that run cycles like laundry machines (experimental). */
const CYCLE_TYPES: Record<string, LaundryKind> = {
  DEVICE_DISH_WASHER: 'dishwasher',
  DEVICE_STYLER: 'styler',
  DEVICE_OVEN: 'oven',
};

/** The operation field each kind uses, when the profile doesn't show one with START. */
const OP_KEYS: Record<LaundryKind, string> = {
  washer: 'washerOperationMode',
  dryer: 'dryerOperationMode',
  dishwasher: 'dishWasherOperationMode',
  styler: 'stylerOperationMode',
  oven: 'ovenOperationMode',
};

/** Device types tested on real machines; the rest are marked experimental in the log. */
export const TESTED_TYPES = new Set(['DEVICE_WASHER', 'DEVICE_DRYER']);

export function isLaundry(deviceType: string): boolean {
  return deviceType in TYPES;
}

/** A dishwasher, Styler or oven: run like laundry, experimental. */
export function isCycleAppliance(deviceType: string): boolean {
  return deviceType in CYCLE_TYPES;
}

export interface LaundryUnit {
  kind: LaundryKind;
  /** '' for a machine with one drum; otherwise MAIN, MINI, WASHER or DRYER. */
  location: string;
  /** The states this machine can report, from its profile. */
  states: string[];
  /** The operation commands it accepts (START, STOP, POWER_OFF), and the field they go in. */
  operations: string[];
  opKey: string;
  /** It reports its door (doorStatus.doorState: dishwashers). */
  hasDoor: boolean;
  /** It reports when rinse aid needs refilling (dishWashingStatus.rinseRefill). */
  hasRinseAid: boolean;
  /** The machine reports a cycle count (cycle.cycleCount), used for the tub-clean reminder. */
  countsCycles: boolean;
  /** Where this unit's properties sit in a WashTower's state and commands. */
  towerKey?: 'washer' | 'dryer';
  /** Whether the state and commands carry location.locationName. */
  usesLocation: boolean;
}

type Props = Record<string, unknown>;

const asObject = (v: unknown): Props | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Props : undefined;

/** The property sets of a profile or state: a list (one per drum) or a single set. */
function propertySets(value: unknown): Props[] {
  if (Array.isArray(value)) { return value.map(asObject).filter((p): p is Props => !!p); }
  const one = asObject(value);
  return one ? [one] : [];
}

const locationOf = (props: Props): string => {
  const name = field(field(props, 'location'), 'locationName');
  return typeof name === 'string' ? name : '';
};

/** Values an enum property lists for reading ('r') or writing ('w'). */
function enumValues(prop: unknown, mode: 'r' | 'w'): string[] {
  const list = field(field(prop, 'value'), mode);
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
}

function unitFrom(kind: LaundryKind, props: Props, location: string, usesLocation: boolean, towerKey?: 'washer' | 'dryer'): LaundryUnit {
  // The field with START among its commands; the kind's usual one if none shows it
  const ops = asObject(props.operation) || {};
  const withStart = Object.keys(ops).find((k) => enumValues(ops[k], 'w').includes('START'));
  const opKey = withStart || OP_KEYS[kind];
  return {
    kind,
    location,
    states: enumValues(field(field(props, 'runState'), 'currentState'), 'r'),
    operations: enumValues(field(field(props, 'operation'), opKey), 'w'),
    opKey,
    hasDoor: field(field(props, 'doorStatus'), 'doorState') !== undefined,
    hasRinseAid: field(field(props, 'dishWashingStatus'), 'rinseRefill') !== undefined,
    countsCycles: field(field(props, 'cycle'), 'cycleCount') !== undefined,
    towerKey,
    usesLocation,
  };
}

/** The units (drums or machines) a laundry device's profile describes. */
export function laundryUnits(deviceType: string, profile: unknown): LaundryUnit[] {
  const type = TYPES[deviceType] || CYCLE_TYPES[deviceType];
  if (!type) { return []; }
  if (type === 'tower') {
    return (['washer', 'dryer'] as const).flatMap((key) => {
      const child = field(profile, key);
      const sets = propertySets(field(child, 'property') ?? child);
      return sets.slice(0, 1).map((p) => unitFrom(key, p, key.toUpperCase(), false, key));
    });
  }
  const sets = propertySets(field(profile, 'property'));
  if (sets.length <= 1) {
    const props = sets[0] || {};
    const loc = locationOf(props);
    return [unitFrom(type, props, sets.length && loc ? loc : '', !!loc)];
  }
  return sets.map((p) => unitFrom(type, p, locationOf(p), true));
}

export interface LaundryStatus {
  /** LG's state word, e.g. RUNNING, SPINNING, END, POWER_OFF; 'UNKNOWN' if missing. */
  state: string;
  /** A cycle is under way and moving. */
  running: boolean;
  /** A cycle is under way but paused or holding. */
  paused: boolean;
  /** The cycle has finished (END, or a dryer in wrinkle care). */
  done: boolean;
  /** The machine reports an error. */
  error: boolean;
  /** LG's error name when it gives one (e.g. DOOR_OPEN_ERROR). */
  errorName: string;
  /** Seconds left and in total for the cycle under way; 0 when there is none. */
  remaining: number;
  total: number;
  /** Remote Start is enabled on the machine, so it accepts commands. */
  remoteControl: boolean;
  /** Times the washer has run, when it reports it. */
  cycleCount?: number;
  /** The door is open (dishwashers), when reported. */
  doorOpen?: boolean;
  /** Rinse aid needs refilling (dishwashers), when reported. */
  rinseAidLow?: boolean;
  /** The course or program, when reported (dishwashers: dishWashingCourse). */
  course?: string;
  /** Seconds until a delayed start, while waiting for one (RESERVED). */
  startsIn?: number;
}

// States that are not a cycle under way. Anything not listed here or in PAUSED counts as running,
// so a state LG adds later (a new phase) shows as running rather than idle.
const IDLE = new Set(['POWER_OFF', 'INITIAL', 'FROZEN_PREVENT_INITIAL', 'END', 'WRINKLE_CARE', 'ERROR', 'RESERVED', 'SLEEP', 'UNKNOWN']);
const PAUSED = new Set(['PAUSE', 'FROZEN_PREVENT_PAUSE', 'RINSE_HOLD']);
const DONE = new Set(['END', 'WRINKLE_CARE']);

/** Running, paused or finished, from LG's state word: for any appliance that runs cycles. */
export function cyclePhase(state: string): { running: boolean; paused: boolean; done: boolean; error: boolean } {
  const paused = PAUSED.has(state);
  return { running: !paused && !IDLE.has(state), paused, done: DONE.has(state), error: state === 'ERROR' };
}

/** The state set for one unit, from a device's full state. */
export function unitState(unit: LaundryUnit, state: unknown): Props | undefined {
  const scoped = unit.towerKey ? field(state, unit.towerKey) : state;
  const sets = propertySets(scoped);
  if (!unit.usesLocation) { return sets[0]; }
  return sets.find((s) => locationOf(s) === unit.location) || (sets.length === 1 ? sets[0] : undefined);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A unit's status from a device's full state. */
export function laundryStatus(unit: LaundryUnit, state: unknown): LaundryStatus {
  const s = unitState(unit, state);
  const word = field(field(s, 'runState'), 'currentState');
  const current = typeof word === 'string' && word ? word : 'UNKNOWN';
  const paused = PAUSED.has(current);
  const running = !paused && !IDLE.has(current);
  const timer = field(s, 'timer');
  const inCycle = running || paused;
  const errorWord = field(field(s, 'error'), 'errorCode') ?? field(s, 'errorCode');
  const count = field(field(s, 'cycle'), 'cycleCount');
  const door = field(field(s, 'doorStatus'), 'doorState');
  const rinse = field(field(s, 'dishWashingStatus'), 'rinseRefill');
  const course = field(field(s, 'dishWashingCourse'), 'currentDishWashingCourse');
  return {
    state: current,
    running,
    paused,
    done: DONE.has(current),
    error: current === 'ERROR',
    errorName: current === 'ERROR' && typeof errorWord === 'string' ? errorWord : '',
    remaining: inCycle ? num(field(timer, 'remainHour')) * 3600 + num(field(timer, 'remainMinute')) * 60 + num(field(timer, 'remainSecond')) : 0,
    total: inCycle ? num(field(timer, 'totalHour')) * 3600 + num(field(timer, 'totalMinute')) * 60 : 0,
    remoteControl: field(field(s, 'remoteControlEnable'), 'remoteControlEnabled') === true,
    cycleCount: typeof count === 'number' ? count : undefined,
    doorOpen: door === undefined ? undefined : door === 'OPEN',
    rinseAidLow: typeof rinse === 'boolean' ? rinse : undefined,
    course: typeof course === 'string' && course ? course : undefined,
    startsIn: current === 'RESERVED'
      ? num(field(timer, 'relativeHourToStart')) * 3600 + num(field(timer, 'relativeMinuteToStart')) * 60 || undefined
      : undefined,
  };
}

/**
 * A live update applied to the last known state. LG sends only what changed, in the same shape
 * as the full state: objects are merged key by key, and a washer's list of drums is matched by
 * location (a drum not in the update keeps its last state).
 */
export function mergeState(base: unknown, patch: unknown): unknown {
  if (patch === undefined) { return base; }
  if (Array.isArray(patch)) {
    if (!Array.isArray(base)) { return patch; }
    const merged: unknown[] = (base as unknown[]).slice();
    for (const item of patch as unknown[]) {
      const loc = locationOf(asObject(item) || {});
      const i = loc ? merged.findIndex((b) => locationOf(asObject(b) || {}) === loc) : (merged.length === 1 ? 0 : -1);
      if (i >= 0) { merged[i] = mergeState(merged[i], item); } else { merged.push(item); }
    }
    return merged;
  }
  const p = asObject(patch);
  const b = asObject(base);
  if (!p) { return patch; }
  if (!b) {
    // A list-shaped state (washer) patched with one drum's object
    if (Array.isArray(base)) { return mergeState(base, [patch]); }
    return patch;
  }
  const out: Props = { ...b };
  for (const [k, v] of Object.entries(p)) { out[k] = mergeState(b[k], v); }
  return out;
}

/** What an LG alert means: a finished cycle, a problem, or neither (just logged). */
export function alertKind(pushCode: string): 'finished' | 'problem' | 'other' {
  if (/ERROR|FAIL|FULL|EMPTY|PROBLEM/.test(pushCode)) { return 'problem'; }
  if (/COMPLETE|FINISH|DONE/.test(pushCode)) { return 'finished'; }
  return 'other';
}

/** Which machine an alert is about, for a WashTower that has both (WASHING_… or DRYING_…). */
export function alertFor(pushCode: string): LaundryKind | undefined {
  if (pushCode.startsWith('WASHING') || pushCode.includes('WASH')) { return 'washer'; }
  if (pushCode.startsWith('DRYING') || pushCode.includes('DRY')) { return 'dryer'; }
  return undefined;
}

/** The command body for an operation (START, STOP, POWER_OFF) on a unit. */
export function operationPayload(unit: LaundryUnit, operation: string): Record<string, unknown> {
  const body: Record<string, unknown> = { operation: { [unit.opKey]: operation } };
  if (unit.usesLocation && unit.location) { body.location = { locationName: unit.location }; }
  return unit.towerKey ? { [unit.towerKey]: body } : body;
}

// Words for LG's states, where its own name reads oddly. RUNNING is the main phase: washing or drying.
const LABELS: Record<string, string> = {
  POWER_OFF: 'Off',
  INITIAL: 'Ready',
  PAUSE: 'Paused',
  DETECTING: 'Detecting load',
  END: 'Finished',
  RESERVED: 'Delayed start waiting',
  FROZEN_PREVENT_INITIAL: 'Freeze protection',
  FROZEN_PREVENT_RUNNING: 'Freeze protection running',
  FROZEN_PREVENT_PAUSE: 'Freeze protection paused',
  ADD_DRAIN: 'Draining',
  DETERGENT_AMOUNT: 'Measuring detergent',
};

/** "Spinning" from SPINNING, "Paused" from PAUSE, "Washing" or "Drying" from RUNNING: for the log and sensor names. */
export function stateLabel(state: string, kind: LaundryKind = 'washer'): string {
  if (state === 'RUNNING') {
    return ({ washer: 'Washing', dryer: 'Drying', dishwasher: 'Washing', styler: 'Refreshing', oven: 'Cooking' } as const)[kind];
  }
  if (LABELS[state]) { return LABELS[state]; }
  const text = state.toLowerCase().split('_').filter(Boolean).join(' ');
  return text ? text[0].toUpperCase() + text.slice(1) : state;
}
