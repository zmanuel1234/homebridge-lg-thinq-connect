// Live updates against the stand-in LG server and message server: certificate, subscriptions,
// messages, the saved certificate, and reconnecting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logging } from 'homebridge';
import { ThinQClient, clientIdFor } from '../src/api.js';
import { LiveUpdates, type LiveMessage, type LiveOptions } from '../src/live.js';
import { FakeLG } from './fake-lg.js';
import { FakeBroker } from './fake-broker.js';

const fastIdentity = () => ({ privateKeyPem: 'KEY', csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----\n' });
const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) { throw new Error('timed out waiting'); }
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup(t: { after(fn: () => unknown): void }, over: Partial<LiveOptions> = {}) {
  const lg = await new FakeLG().start();
  const broker = await new FakeBroker().start();
  const dir = mkdtempSync(join(tmpdir(), 'lg-live-'));
  const lines: string[] = [];
  const messages: LiveMessage[] = [];
  const connectedChanges: boolean[] = [];
  const servers: { host: string; port: number }[] = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
  const client = new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url });
  const storageFile = join(dir, 'lg-thinq-connect', 'live.json');
  const live = new LiveUpdates({
    client, clientId: clientIdFor(lg.token), log, storageFile,
    onMessage: (m) => messages.push(m),
    onConnected: (c) => connectedChanges.push(c),
    connect: (server) => { servers.push(server); return connect(broker.port, '127.0.0.1'); },
    newIdentity: fastIdentity,
    ...over,
  });
  t.after(async () => { live.stop(); await broker.stop(); await lg.stop(); });
  return { lg, broker, live, lines, messages, connectedChanges, servers, storageFile };
}

test('connecting: certificate from LG, appliances subscribed, LG\'s topic subscribed with our client ID', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1', 'device-2']);
  assert.ok(s.live.connected);
  assert.deepEqual(s.connectedChanges, [true]);
  assert.deepEqual(s.servers, [{ host: 'example-ats.iot.us-west-2.amazonaws.com', port: 8883 }]);
  assert.equal(s.lg.certificates.length, 1);
  assert.deepEqual(s.lg.subscribed, { event: ['device-1', 'device-2'], push: ['device-1', 'device-2'] });
  const id = clientIdFor(s.lg.token);
  assert.deepEqual(s.broker.clients.map((c) => [c.clientId, c.cleanSession, c.topics]), [[id, false, [`app/clients/${id}/push`]]]);
  assert.ok(s.lines.includes('info: Live updates from LG connected: changes show in the Home app within seconds.'));
  const body = s.lg.requests.find((r) => r.path === 'event/device-1/subscribe')?.body;
  assert.deepEqual(body, { expire: { unit: 'HOUR', timer: 4464 } });
});

test('messages: state updates and alerts reach the platform; junk is ignored', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1']);
  const topic = s.broker.clients[0].topics[0];
  s.broker.publish(topic, { deviceId: 'device-1', deviceType: 'DEVICE_WASHER', pushType: 'DEVICE_STATUS', report: { runState: { currentState: 'SPINNING' } } });
  s.broker.publish(topic, { deviceId: 'device-2', deviceType: 'DEVICE_DRYER', pushType: 'DEVICE_PUSH', pushCode: 'DRYING_IS_COMPLETE' });
  s.broker.publish(topic, 'not json');
  s.broker.publish(topic, { hello: 'world' });
  await until(() => s.messages.length >= 2 && s.lines.filter((l) => l.startsWith('debug: Live update')).length >= 2);
  assert.deepEqual(s.messages, [
    { deviceId: 'device-1', pushType: 'DEVICE_STATUS', report: { runState: { currentState: 'SPINNING' } }, pushCode: undefined },
    { deviceId: 'device-2', pushType: 'DEVICE_PUSH', report: undefined, pushCode: 'DRYING_IS_COMPLETE' },
  ]);
});

test('the certificate is saved privately and reused after a restart; subscriptions that exist are fine', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1']);
  const saved = JSON.parse(readFileSync(s.storageFile, 'utf8')) as Record<string, string>;
  assert.equal(saved.certificatePem, 'CERT-1');
  assert.equal(saved.privateKeyPem, 'KEY');
  // Windows has no Unix file permissions: it reports every file as 0o666, so only check elsewhere.
  if (process.platform !== 'win32') {
    assert.equal(statSync(s.storageFile).mode & 0o777, 0o600);
  }
  s.live.stop();
  await s.live.start(['device-1']);
  assert.ok(s.live.connected);
  assert.equal(s.lg.certificates.length, 1, 'no new certificate');
  assert.ok(!s.lines.some((l) => l.startsWith('warn:')), 'already-subscribed (1207) is not a failure');
});

test('a dropped connection: back to scheduled checks, then reconnects', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1']);
  s.broker.dropAll();
  await until(() => !s.live.connected);
  assert.deepEqual(s.connectedChanges, [true, false]);
  assert.ok(s.lines.some((l) => l.startsWith('warn: Live updates from LG disconnected') && l.includes('trying again in 10 s')));
});

test('LG refusing the connection: retried later; after three failures a new certificate is fetched', async (t) => {
  const s = await setup(t);
  s.broker.connackCode = 5;
  await s.live.start(['device-1']);
  assert.ok(!s.live.connected);
  assert.ok(s.lines.some((l) => l.startsWith('warn: Live updates from LG failed while connecting to example-ats') && l.includes('not authorized')));
  assert.ok(existsSync(s.storageFile));
  // Two more failed attempts, run by hand instead of waiting for the retry timer
  const attempt = (s.live as unknown as { attempt(): Promise<void> }).attempt.bind(s.live);
  await attempt();
  await attempt();
  assert.ok(!existsSync(s.storageFile), 'the certificate is dropped after three failures');
  s.broker.connackCode = 0;
  await attempt();
  assert.ok(s.live.connected);
  assert.equal(s.lg.certificates.length, 2);
});

test('an unreadable saved certificate is replaced', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1']);
  s.live.stop();
  writeFileSync(s.storageFile, '{not json');
  await s.live.start(['device-1']);
  assert.ok(s.live.connected);
  assert.equal(s.lg.certificates.length, 2);
});

test('LG not answering the route: a warning, nothing thrown', async (t) => {
  const s = await setup(t);
  s.lg.failWith = [503, '', 'Service unavailable'];
  await s.live.start(['device-1']);
  assert.ok(!s.live.connected);
  assert.ok(s.lines.some((l) => l.startsWith('warn: Live updates from LG failed while asking LG for its message server: HTTP 503')));
});

test('a real key and certificate request is accepted by the stand-in LG', async (t) => {
  const s = await setup(t, { newIdentity: undefined });
  await s.live.start(['device-1']);
  assert.ok(s.live.connected);
  assert.match(s.lg.certificates[0], /^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE REQUEST-----\n$/);
  const saved = JSON.parse(readFileSync(s.storageFile, 'utf8')) as { privateKeyPem: string };
  assert.match(saved.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
});

test('an internet outage (LG\'s route failing) keeps a good certificate', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1']);
  s.live.stop();
  s.lg.failPath = /^route$/;
  const attempt = (s.live as unknown as { attempt(): Promise<void>; stopped: boolean });
  attempt.stopped = false;
  for (let i = 0; i < 4; i++) { await attempt.attempt(); }
  assert.ok(existsSync(s.storageFile), 'the certificate is kept');
  s.live.stop();
});

test('a platform error while applying a live update is logged, not thrown into the connection', async (t) => {
  const s = await setup(t, { onMessage: () => { throw new Error('boom'); } });
  await s.live.start(['device-1']);
  s.broker.publish(s.broker.clients[0].topics[0], { deviceId: 'device-1', pushType: 'DEVICE_STATUS', report: {} });
  await until(() => s.lines.some((l) => l.startsWith('error: Couldn\'t apply a live update: Error: boom')));
  assert.ok(s.live.connected);
});

test('an appliance added later is subscribed right away', async (t) => {
  const s = await setup(t);
  await s.live.start(['device-1']);
  await s.live.addDevice('device-2');
  await s.live.addDevice('device-2');
  assert.deepEqual(s.lg.subscribed, { event: ['device-1', 'device-2'], push: ['device-1', 'device-2'] });
});
