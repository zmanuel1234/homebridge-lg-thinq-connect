import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ThinQClient, ThinQError } from '../src/api';
import { checkToken, supportOf, typeName } from '../src/homebridge-ui/check';
import { FakeLG } from './fake-lg';
import schema from '../config.schema.json';

async function fakeLG(t: { after: (fn: () => Promise<void>) => void }): Promise<FakeLG> {
  const lg = await new FakeLG().start();
  t.after(() => lg.stop());
  return lg;
}

test('check token: lists the appliances and how well each is supported', async (t) => {
  const lg = await fakeLG(t);
  const r = await checkToken(` ${lg.token} `, 'us', (o) => new ThinQClient({ ...o, baseUrl: lg.url }));
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Signed in to LG (US): found Front Load Washer, Dryer.');
  assert.deepEqual(r.appliances.map((a) => a.support), ['supported', 'supported']);
  assert.ok(!JSON.stringify(r).includes(lg.token), 'the token is never sent back');
});

test('check token: a refused token says what to do, and nothing is thrown', async (t) => {
  const lg = await fakeLG(t);
  lg.failWith = [401, '1103', 'Invalid token'];
  const r = await checkToken('wrong', 'US', (o) => new ThinQClient({ ...o, baseUrl: lg.url }));
  assert.equal(r.ok, false);
  assert.match(r.message, /^LG refused: .*LG error 1103.*every permission ticked.*Signing in/);
  assert.deepEqual(await checkToken('', 'US'), { ok: false, message: 'Paste your personal access token in the Token box first.', appliances: [] });
  const zz = (await checkToken('t', 'ZZ')).message;
  assert.match(zz, /doesn't serve the country "ZZ"/);
  assert.doesNotMatch(zz, /LG refused/, 'a local check is not LG refusing');
});

test('check token: an account with no appliances points at the other account', async (t) => {
  const lg = await fakeLG(t);
  lg.devices = [];
  const r = await checkToken(lg.token, undefined, (o) => new ThinQClient({ ...o, baseUrl: lg.url }));
  assert.equal(r.ok, true);
  assert.match(r.message, /^Signed in to LG \(US\), but this account has no appliances/);
});

test('support levels and names for LG types', () => {
  assert.equal(supportOf('DEVICE_DRYER'), 'supported');
  assert.equal(supportOf('DEVICE_WASHTOWER_DRYER'), 'laundry');
  assert.equal(supportOf('DEVICE_DISH_WASHER'), 'experimental');
  assert.equal(supportOf('DEVICE_AIR_CONDITIONER'), 'experimental');
  assert.equal(supportOf('DEVICE_MICROWAVE_OVEN'), 'experimental');
  assert.equal(supportOf('DEVICE_SOMETHING_NEW'), 'basic');
  assert.equal(typeName('DEVICE_WASHTOWER_DRYER'), 'washtower dryer');
});

test('LG error codes come with what to do', () => {
  assert.match(new ThinQError(400, '1304', 'Not acceptable terms').message, /accept them/);
  assert.match(new ThinQError(400, '1307', 'Not supported country').message, /country your LG account was created in/);
  assert.match(new ThinQError(400, '2301', 'Remote off').message, /Remote Start/);
  assert.match(new ThinQError(400, '1222', 'Not connected').message, /on Wi-Fi/);
  assert.equal(new ThinQError(400, '1302', 'Not found token').isAuth, true);
  assert.equal(new ThinQError(400, '1222', 'Not connected').isAuth, false);
  assert.equal(new ThinQError(500, '9999', 'Odd').message, 'HTTP 500 (LG error 9999: Odd)');
});

test('settings page: Homebridge loads it from the build', () => {
  assert.equal((schema as { customUi?: boolean }).customUi, true);
  assert.equal((schema as { customUiPath?: string }).customUiPath, './dist/homebridge-ui');
  const page = readFileSync('src/homebridge-ui/public/index.html', 'utf8');
  assert.match(page, /connect-pat\.lgthinq\.com/);
  assert.match(page, /request\('\/check'/);
  assert.ok(!/innerHTML/.test(page), 'LG names are shown as text, never as HTML');
  if (existsSync('dist')) {
    assert.ok(existsSync('dist/homebridge-ui/server.js'));
    assert.ok(existsSync('dist/homebridge-ui/public/index.html'));
  }
});

test('settings page: the server\'s helper library loads from the plugin\'s CommonJS build', () => {
  const out = spawnSync(process.execPath, ['-e', "process.stdout.write(typeof require('@homebridge/plugin-ui-utils').HomebridgePluginUiServer)"], { encoding: 'utf8' });
  assert.equal(out.stdout, 'function', out.stderr);
});
