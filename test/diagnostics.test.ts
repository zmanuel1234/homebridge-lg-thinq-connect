import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, redact } from '../src/bin/lg-thinq-diagnostics';
import { ThinQClient } from '../src/api';
import { FakeLG } from './fake-lg';

test('redact: device IDs anywhere, and serial, MAC and network fields', () => {
  const out = redact({
    a: 'abc-123', nested: { id: 'xx abc-123 yy', serialNumber: 'S1', macAddress: '00:11', ssid: 'Home', keep: 'MAIN' },
  }, ['abc-123']);
  assert.deepEqual(out, {
    a: 'DEVICE-ID-REMOVED',
    nested: { id: 'xx DEVICE-ID-REMOVED yy', serialNumber: 'REMOVED', macAddress: 'REMOVED', ssid: 'REMOVED', keep: 'MAIN' },
  });
});

test('collect: every appliance\'s info, profile and state, with no device ID left', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  lg.devices[1].state = { echo: 'device-2' };
  const report = await collect(new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url }), 'US', 'tool 1.0');
  assert.equal(report.tool, 'tool 1.0');
  assert.equal(report.country, 'US');
  assert.equal(report.appliances.length, 2);
  const text = JSON.stringify(report);
  assert.ok(!text.includes('device-1') && !text.includes('device-2'));
  assert.ok(text.includes('DEVICE-ID-REMOVED'));
  assert.ok(text.includes('WASHING_IS_COMPLETE'), 'the profile is included');
});

test('collect: one appliance failing doesn\'t stop the rest', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  const client = new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url });
  const flaky = {
    devices: () => client.devices(),
    profile: (id: string) => (id === 'device-1' ? Promise.reject(new Error('boom')) : client.profile(id)),
    state: (id: string) => client.state(id),
  };
  const report = await collect(flaky, 'US', 'tool');
  const first = report.appliances[0] as { profile: unknown; state: unknown };
  assert.deepEqual(first.profile, { error: 'boom' });
  assert.ok(Array.isArray(first.state));
});
