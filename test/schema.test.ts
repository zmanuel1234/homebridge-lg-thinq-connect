import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.schema.json';
import { readSettings } from '../src/platform';
import { PLATFORM_NAME } from '../src/settings';
import type { PlatformConfig } from 'homebridge';

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  required?: boolean | string[];
  items?: SchemaNode & { oneOf?: { enum: string[] }[] };
}
type LayoutItem = string | { key?: string; type?: string; items?: LayoutItem[] };

const top = config.schema.properties as unknown as Record<string, SchemaNode>;
/** Every setting by its key on the settings screen: groups' settings as group.key (general.energy). */
const props: Record<string, SchemaNode> = {};
for (const [k, v] of Object.entries(top)) {
  if (v.type === 'object' && v.properties) {
    for (const [sub, n] of Object.entries(v.properties)) { props[`${k}.${sub}`] = n; }
  } else {
    props[k] = v;
  }
}
const layout = config.layout as unknown as LayoutItem[];

const flatten = (items: LayoutItem[], out: LayoutItem[] = []): LayoutItem[] => {
  for (const i of items) {
    out.push(i);
    if (typeof i === 'object' && i.items) { flatten(i.items, out); }
  }
  return out;
};

test('settings screen: the alias the platform registers', () => {
  assert.equal(config.pluginAlias, PLATFORM_NAME);
  assert.equal(config.pluginType, 'platform');
  assert.equal(config.singular, true);
});

test('settings screen: every default matches its type and limits, and the code uses the same', () => {
  for (const [k, v] of Object.entries(props)) {
    if (!('default' in v)) { continue; }
    const ok = (v.type === 'integer' && Number.isInteger(v.default)) || v.type === typeof v.default;
    assert.ok(ok, `${k}: default ${JSON.stringify(v.default)} is not ${v.type}`);
    if (typeof v.default === 'number') {
      if (v.minimum !== undefined) { assert.ok(v.default >= v.minimum, `${k} below minimum`); }
      if (v.maximum !== undefined) { assert.ok(v.default <= v.maximum, `${k} above maximum`); }
    }
  }
  const s = readSettings({ platform: PLATFORM_NAME } as PlatformConfig);
  assert.equal(s.pollInterval, props['polling.idle'].default);
  assert.equal(s.runningPollInterval, props['polling.running'].default);
  assert.equal(s.country, props.country.default);
  assert.equal(s.allowControl, props['general.allowControl'].default);
  assert.equal(s.liveUpdates, props['general.liveUpdates'].default);
  assert.equal(s.energy, props['general.energy'].default);
  assert.equal(s.sensorsAsOccupancy, props['general.sensorType'].default === 'occupancy');
  assert.equal(s.extraControls, props['general.extraControls'].default);
  assert.equal(s.doneHoldMinutes, props['laundry.doneHoldMinutes'].default);
  assert.equal(s.tubCleanAfter, props['washer.tubCleanAfter'].default);
  assert.equal(s.lintFilterAfter, props['dryer.lintFilterAfter'].default);
  assert.equal(s.lintFilterAutoClear, props['dryer.lintFilterAutoClear'].default);
  assert.equal(s.ventCheckPercent, props['dryer.ventCheckPercent'].default);
  // The code's limits match the screen's
  assert.equal(readSettings({ platform: PLATFORM_NAME, polling: { idle: 1 } } as PlatformConfig).pollInterval, props['polling.idle'].minimum);
  assert.equal(readSettings({ platform: PLATFORM_NAME, polling: { running: 1e6 } } as PlatformConfig).runningPollInterval, props['polling.running'].maximum);
});

test('settings screen: nothing required (the UI would refuse to save a blank form)', () => {
  for (const [k, v] of Object.entries(props)) { assert.ok(!v.required, k); }
  assert.ok(!('required' in config.schema));
});

test('settings screen: every setting is in the layout, and intervals are number boxes', () => {
  const flat = flatten(layout);
  const keys = flat.map((i) => (typeof i === 'string' ? i : i.key)).filter(Boolean);
  for (const k of Object.keys(props)) { assert.ok(keys.includes(k), `${k} missing from the layout`); }
  // Options inside lists (such as Options per appliance) too: a list laid out by its key alone
  // shows all of them; one that names its fields must name each, or the one left out works in
  // config.json but can't be set on the settings screen
  for (const [k, p] of Object.entries(props)) {
    const itemProps = (p as { items?: { properties?: Record<string, unknown> } }).items?.properties;
    const entry = flat.find((i) => typeof i === 'object' && i.key === k);
    if (!itemProps || (typeof entry === 'object' && !entry.items)) { continue; }
    for (const sub of Object.keys(itemProps)) {
      assert.ok(keys.includes(`${k}[].${sub}`), `${k}[].${sub} missing from the layout`);
    }
  }
  // A pick-any list of fixed choices (phase sensors) as checkboxes: laid out by its key alone it
  // gets no "Add" button on the settings screen, so nothing could be chosen
  for (const k of ['laundry.phaseSensors', 'appliances[].phaseSensors']) {
    const phases = flat.find((i) => typeof i === 'object' && i.key === k);
    assert.equal(typeof phases === 'object' && phases.type, 'checkboxes', k);
  }
  // The settings screen always shows one row in a list that names its fields (it needs that for
  // its "Add" button), and saves it: so nothing in a row may have a value until it's chosen. The
  // on/off options are drop-downs with a blank default rather than checkboxes (saved as false)
  const items = (props.appliances as { items: { properties: Record<string, { type?: string; default?: unknown; oneOf?: unknown[] }> } }).items.properties;
  for (const [k, p] of Object.entries(items)) {
    assert.equal(p.default, undefined, `appliances[].${k}: no default`);
    if (p.type === 'boolean') {
      assert.equal(p.oneOf?.length, 2, `appliances[].${k}: a choice of true or false`);
      const entry = flat.find((i) => typeof i === 'object' && i.key === `appliances[].${k}`);
      assert.equal(typeof entry === 'object' && entry.type, 'select', `appliances[].${k}: a drop-down, not a checkbox`);
    }
  }
  for (const k of ['polling.idle', 'polling.running', 'laundry.doneHoldMinutes', 'washer.tubCleanAfter', 'dryer.lintFilterAfter',
    'dryer.ventCheckPercent', 'appliances[].doneHoldMinutes', 'appliances[].tubCleanAfter', 'appliances[].lintFilterAfter',
    'appliances[].ventCheckPercent']) {
    const item = flat.find((i) => typeof i === 'object' && i.key === k);
    assert.ok(typeof item === 'object' && item.type === 'number', `${k} should be a number box`);
  }
});

test('settings screen: phase choices are states LG reports for washers or dryers', async () => {
  const { realDevices } = await import('./fake-lg');
  const { laundryUnits } = await import('../src/laundry');
  const [w, d] = realDevices();
  const known = new Set([...laundryUnits('DEVICE_WASHER', w.profile)[0].states, ...laundryUnits('DEVICE_DRYER', d.profile)[0].states]);
  for (const choice of props['laundry.phaseSensors'].items!.oneOf!) {
    assert.ok(known.has(choice.enum[0]), `${choice.enum[0]} isn't a state our machines report`);
  }
  // An appliance's own choice offers the same states
  const own = (props.appliances.items as { properties: Record<string, SchemaNode> }).properties.phaseSensors;
  assert.deepEqual(own.items, props['laundry.phaseSensors'].items);
});

test('settings screen: every option per appliance is read by the plugin, and its limits match the general one', () => {
  const items = (props.appliances.items as { properties: Record<string, SchemaNode & { enum?: unknown[]; oneOf?: { enum: unknown[] }[] }> }).properties;
  // A value for each option (the first choice, or the largest number allowed)
  const row: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(items)) {
    if (k === 'name') { row[k] = 'Dryer'; continue; }
    if (p.type === 'array') { row[k] = [p.items!.oneOf![0].enum[0]]; continue; }
    if (p.oneOf) { row[k] = p.oneOf[p.oneOf.length - 1].enum[0]; continue; }
    if (p.enum) { row[k] = p.enum[0]; continue; }
    if (p.type === 'integer' || p.type === 'number') { row[k] = p.maximum ?? 5; continue; }
    if (p.type === 'string') { row[k] = 'x'; continue; }
  }
  const got = readSettings({ platform: PLATFORM_NAME, appliances: [row] } as unknown as PlatformConfig).appliances.get('dryer')!;
  for (const k of Object.keys(items)) {
    if (k === 'name') { continue; }
    assert.ok(k in got, `appliances[].${k} is on the settings screen, but the plugin ignores it`);
  }
  // The same option in a group: the same limits
  for (const [k, p] of Object.entries(items)) {
    const general = Object.entries(props).find(([key]) => key.endsWith(`.${k}`))?.[1];
    if (!general || (p.type !== 'integer' && p.type !== 'number')) { continue; }
    assert.equal(p.minimum, general.minimum, `appliances[].${k} minimum`);
    assert.equal(p.maximum, general.maximum, `appliances[].${k} maximum`);
  }
});
