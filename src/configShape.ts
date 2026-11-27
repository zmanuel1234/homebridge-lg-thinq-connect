// The shape of the plugin's settings in config.json since 3.0, grouped by what they're for, and
// the conversion from the flat settings of 2.x and earlier. The plugin reads every config through
// migrateConfig, so a 2.x config keeps working unchanged; the settings screen saves the new shape.
//
//   {
//     "platform": "LGThinQConnect", "name": "LG ThinQ", "token": "…", "country": "US",
//     "general":  { allowControl, liveUpdates, energy, sensorType, experimental, extraControls },
//     "laundry":  { phaseSensors, doneHoldMinutes },          washers, dryers and other cycle appliances
//     "washer":   { tubCleanAfter },
//     "dryer":    { lintFilterAfter, lintFilterAutoClear, ventCheckPercent },
//     "polling":  { idle, running },                          seconds between checks
//     "ignore":   ["Appliance name", …],
//     "appliances": [ { name, type, …any of the options above that apply to that type } ]
//   }

/** What an appliance is, for the options that apply to it (from LG's device type). */
export type ApplianceKind =
  | 'washer' | 'dryer' | 'washtower' | 'dishwasher' | 'styler' | 'oven' | 'air_conditioner' | 'other';

const KINDS: Record<string, ApplianceKind> = {
  DEVICE_WASHER: 'washer',
  DEVICE_WASHTOWER_WASHER: 'washer',
  DEVICE_WASHCOMBO_MAIN: 'washer',
  DEVICE_WASHCOMBO_MINI: 'washer',
  DEVICE_DRYER: 'dryer',
  DEVICE_WASHTOWER_DRYER: 'dryer',
  DEVICE_WASHTOWER: 'washtower',
  DEVICE_DISH_WASHER: 'dishwasher',
  DEVICE_STYLER: 'styler',
  DEVICE_OVEN: 'oven',
  DEVICE_AIR_CONDITIONER: 'air_conditioner',
};

/** The kind of appliance an LG device type is ("other" for any type without options of its own). */
export function kindOf(deviceType: string): ApplianceKind {
  return KINDS[deviceType] || 'other';
}

/** Settings moved into a group in 3.0: the 2.x key, and where it lives now. */
const MOVED: [old: string, group: string, key: string][] = [
  ['allowControl', 'general', 'allowControl'],
  ['liveUpdates', 'general', 'liveUpdates'],
  ['energy', 'general', 'energy'],
  ['sensorType', 'general', 'sensorType'],
  ['experimental', 'general', 'experimental'],
  ['extraControls', 'general', 'extraControls'],
  ['phaseSensors', 'laundry', 'phaseSensors'],
  ['doneHoldMinutes', 'laundry', 'doneHoldMinutes'],
  ['tubCleanAfter', 'washer', 'tubCleanAfter'],
  ['lintFilterAfter', 'dryer', 'lintFilterAfter'],
  ['lintFilterAutoClear', 'dryer', 'lintFilterAutoClear'],
  ['ventCheckPercent', 'dryer', 'ventCheckPercent'],
  ['pollInterval', 'polling', 'idle'],
  ['runningPollInterval', 'polling', 'running'],
];

/** 2.x settings that 3.0 no longer has: folded into others (see migrateConfig). */
const RETIRED = ['problemSensor', 'notificationSensors'];

type Config = Record<string, unknown>;
const isObject = (v: unknown): v is Config => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The config in the 3.0 shape. A 2.x (flat) config is converted: each setting moves into its group
 * unless the group already has it, and the retired ones are folded in ("Problem sensors show as:
 * occupancy", before 2.0's single setting, becomes general.sensorType). Anything else, such as the
 * child bridge's `_bridge`, is kept as it is; rows under appliances without a name are dropped. Returns a new object; the one given isn't changed.
 */
export function migrateConfig(config: Config): Config {
  const out: Config = {};
  for (const [k, v] of Object.entries(config)) {
    if (MOVED.some(([old]) => old === k) || RETIRED.includes(k)) { continue; }
    out[k] = isObject(v) ? { ...v } : v;
  }
  for (const [old, group, key] of MOVED) {
    if (!(old in config)) { continue; }
    const g = isObject(out[group]) ? out[group] as Config : (out[group] = {});
    if (!(key in g)) { g[key] = config[old]; }
  }
  if (config.problemSensor === 'occupancy') {
    const g = isObject(out.general) ? out.general as Config : (out.general = {});
    if (!('sensorType' in g)) { g.sensorType = 'occupancy'; }
  }
  // Rows without a name apply to nothing (2.x's settings screen saved a blank one)
  if (Array.isArray(config.appliances)) {
    const named = config.appliances.filter(named_);
    if (named.length) { out.appliances = named.map((r) => ({ ...r })); } else { delete out.appliances; }
  }
  return out;
}

/** The config is in the 2.x (flat) shape: it has a setting that 3.0 keeps in a group, or a retired one. */
export function isOldShape(config: Config): boolean {
  return Object.keys(config).some((k) => MOVED.some(([old]) => old === k) || RETIRED.includes(k))
    || (Array.isArray(config.appliances) && !config.appliances.every(named_));
}

function named_(row: unknown): row is Config {
  return isObject(row) && typeof row.name === 'string' && row.name.trim() !== '';
}
