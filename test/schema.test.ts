import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.schema.json';
import { readSettings } from '../src/platform';
import { PLATFORM_NAME } from '../src/settings';
import type { PlatformConfig } from 'homebridge';

interface SchemaNode {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  required?: boolean | string[];
  items?: SchemaNode & { oneOf?: { enum: string[] }[] };
}
type LayoutItem = string | { key?: string; type?: string; items?: LayoutItem[] };

const props = config.schema.properties as unknown as Record<string, SchemaNode>;
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
  assert.equal(s.pollInterval, props.pollInterval.default);
  assert.equal(s.runningPollInterval, props.runningPollInterval.default);
  assert.equal(s.country, props.country.default);
  assert.equal(s.allowControl, props.allowControl.default);
  assert.equal(s.tubCleanAfter, props.tubCleanAfter.default);
  assert.equal(s.lintFilterAfter, props.lintFilterAfter.default);
  assert.equal(s.lintFilterAutoClear, props.lintFilterAutoClear.default);
  assert.equal(s.notifyAsContact, props.notificationSensors.default === 'contact');
  assert.equal(s.ventCheckPercent, props.ventCheckPercent.default);
  // The code's limits match the screen's
  assert.equal(readSettings({ platform: PLATFORM_NAME, pollInterval: 1 } as PlatformConfig).pollInterval, props.pollInterval.minimum);
  assert.equal(readSettings({ platform: PLATFORM_NAME, runningPollInterval: 1e6 } as PlatformConfig).runningPollInterval, props.runningPollInterval.maximum);
});

test('settings screen: nothing required (the UI would refuse to save a blank form)', () => {
  for (const [k, v] of Object.entries(props)) { assert.ok(!v.required, k); }
  assert.ok(!('required' in config.schema));
});

test('settings screen: every setting is in the layout, and intervals are number boxes', () => {
  const flat = flatten(layout);
  const keys = flat.map((i) => (typeof i === 'string' ? i : i.key)).filter(Boolean);
  for (const k of Object.keys(props)) { assert.ok(keys.includes(k), `${k} missing from the layout`); }
  // Options inside lists (such as Options per appliance) too: one left out works in config.json
  // but can't be set on the settings screen
  for (const [k, p] of Object.entries(props)) {
    const itemProps = (p as { items?: { properties?: Record<string, unknown> } }).items?.properties;
    for (const sub of Object.keys(itemProps || {})) {
      assert.ok(keys.includes(`${k}[].${sub}`), `${k}[].${sub} missing from the layout`);
    }
  }
  for (const k of ['pollInterval', 'runningPollInterval', 'tubCleanAfter', 'lintFilterAfter', 'ventCheckPercent']) {
    const item = flat.find((i) => typeof i === 'object' && i.key === k);
    assert.ok(typeof item === 'object' && item.type === 'number', `${k} should be a number box`);
  }
});

test('settings screen: phase choices are states LG reports for washers or dryers', async () => {
  const { realDevices } = await import('./fake-lg');
  const { laundryUnits } = await import('../src/laundry');
  const [w, d] = realDevices();
  const known = new Set([...laundryUnits('DEVICE_WASHER', w.profile)[0].states, ...laundryUnits('DEVICE_DRYER', d.profile)[0].states]);
  for (const choice of props.phaseSensors.items!.oneOf!) {
    assert.ok(known.has(choice.enum[0]), `${choice.enum[0]} isn't a state our machines report`);
  }
});
