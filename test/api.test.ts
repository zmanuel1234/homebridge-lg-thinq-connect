import test from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY, ThinQClient, ThinQError, clientIdFor, regionFor } from '../src/api';
import { FakeLG } from './fake-lg';

test('regions: each country goes to its LG server', () => {
  assert.equal(regionFor('US'), 'aic');
  assert.equal(regionFor('ca'), 'aic');
  assert.equal(regionFor(' GB '), 'eic');
  assert.equal(regionFor('DE'), 'eic');
  assert.equal(regionFor('KR'), 'kic');
  assert.equal(regionFor('AU'), 'kic');
  assert.equal(regionFor('XX'), undefined);
  assert.equal(regionFor('USA'), undefined);
});

test('client: LG\'s address for the region, and refusals for a bad country or no token', () => {
  assert.equal(new ThinQClient({ token: 't', country: 'US' }).baseUrl, 'https://api-aic.lgthinq.com/');
  assert.equal(new ThinQClient({ token: 't', country: 'FR' }).baseUrl, 'https://api-eic.lgthinq.com/');
  assert.throws(() => new ThinQClient({ token: 't', country: 'ZZ' }), /doesn't serve the country "ZZ"/);
  assert.throws(() => new ThinQClient({ token: '  ', country: 'US' }), /No personal access token/);
});

test('client ID: the same for the same token, different for another, no token in it', () => {
  assert.equal(clientIdFor('abc'), clientIdFor('abc'));
  assert.notEqual(clientIdFor('abc'), clientIdFor('abd'));
  assert.match(clientIdFor('abc'), /^homebridge-lg-thinq-connect-[0-9a-f]{16}$/);
});

test('requests carry the headers LG requires', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  const client = new ThinQClient({ token: lg.token, country: 'us', baseUrl: lg.url });
  await client.devices();
  await client.devices();
  const [a, b] = lg.requests;
  assert.equal(a.headers.authorization, `Bearer ${lg.token}`);
  assert.equal(a.headers['x-country'], 'US');
  assert.equal(a.headers['x-api-key'], API_KEY);
  assert.equal(a.headers['x-service-phase'], 'OP');
  assert.equal(a.headers['x-client-id'], clientIdFor(lg.token));
  assert.match(String(a.headers['x-message-id']), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a.headers['x-message-id'], b.headers['x-message-id'], 'a new message ID per request');
});

test('devices, profile and state come back unwrapped', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  const client = new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url });
  const devices = await client.devices();
  assert.deepEqual(devices.map((d) => [d.deviceInfo.alias, d.deviceInfo.deviceType, d.deviceInfo.modelName]), [
    ['Front Load Washer', 'DEVICE_WASHER', 'F3P2CYVAT__'],
    ['Dryer', 'DEVICE_DRYER', 'RV13D4AMH_D_US'],
  ]);
  assert.ok(Array.isArray(await client.state('device-1')));
  assert.ok(await client.profile('device-2'));
});

test('devices: an unreadable list fails (never an empty account); a missing name or model is filled in', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  const client = new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url });
  lg.devices = [{ deviceId: 'a', deviceInfo: { deviceType: 'DEVICE_WASHER' }, profile: {}, state: {} }] as never;
  assert.deepEqual(await client.devices(), [{ deviceId: 'a', deviceInfo: { deviceType: 'DEVICE_WASHER', alias: 'DEVICE_WASHER', modelName: '' } }]);
  lg.devices = [
    { deviceId: 'a', deviceInfo: { deviceType: 'DEVICE_WASHER', alias: 'W' }, profile: {}, state: {} },
    { deviceId: 'b', deviceInfo: { alias: 'no type' }, profile: {}, state: {} },
  ] as never;
  await assert.rejects(client.devices(), /appliance list this plugin can't read/);
  lg.listingOverride = {};
  await assert.rejects(client.devices(), (err: ThinQError) => err.message === 'LG sent an appliance list this plugin can\'t read');
});

test('control: posts the body with LG\'s conditional-control header', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  const client = new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url });
  await client.control('device-1', { operation: { washerOperationMode: 'START' } });
  const req = lg.requests.at(-1)!;
  assert.equal(req.method, 'POST');
  assert.equal(req.path, 'devices/device-1/control');
  assert.equal(req.headers['x-conditional-control'], 'true');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(req.body, { operation: { washerOperationMode: 'START' } });
});

test('errors: LG\'s code and message, with advice for a bad token', async (t) => {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  const bad = new ThinQClient({ token: 'wrong', country: 'US', baseUrl: lg.url });
  await assert.rejects(bad.devices(), (err: unknown) => {
    assert.ok(err instanceof ThinQError);
    assert.equal(err.status, 401);
    assert.equal(err.code, '1218');
    assert.ok(err.isAuth);
    assert.match(err.message, /HTTP 401 \(LG error 1218: Invalid token\)\. Check the personal access token/);
    return true;
  });
  lg.failWith = [429, '1314', 'Exceeded request limit'];
  const client = new ThinQClient({ token: lg.token, country: 'US', baseUrl: lg.url });
  await assert.rejects(client.devices(), /HTTP 429 \(LG error 1314: Exceeded request limit\)\. LG is limiting/);
});

test('errors: no answer, a timeout and a non-JSON answer', async () => {
  const unreachable = new ThinQClient({ token: 't', country: 'US', fetch: () => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) });
  await assert.rejects(unreachable.devices(), /Couldn't reach LG \(ECONNREFUSED\)/);

  const slow = new ThinQClient({
    token: 't', country: 'US', timeoutMs: 20,
    // AbortSignal.timeout doesn't keep Node running on its own; a pending request does
    fetch: (_url, init) => new Promise((_ok, fail) => {
      const pending = setTimeout(() => {}, 5000);
      init.signal.addEventListener('abort', () => { clearTimeout(pending); fail(init.signal.reason); });
    }),
  });
  await assert.rejects(slow.devices(), /no answer within 0.02 s/);

  const html = new ThinQClient({ token: 't', country: 'US', fetch: () => Promise.resolve({ status: 502, text: () => Promise.resolve('<html>') }) });
  await assert.rejects(html.devices(), /HTTP 502 .*isn't JSON: <html>/);
});
