// The platform against the fake LG server: finding appliances, registering and reusing
// accessories, removing old ones only after a successful listing, failures, and commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { LGThinQPlatform, readSettings } from '../src/platform';
import { ThinQClient } from '../src/api';
import { FakeLG } from './fake-lg';

type Hap = typeof HapNodejs;
let hap: Hap | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

test('settings: defaults, limits and clean-up', () => {
  const s = readSettings({ platform: 'LGThinQConnect' } as PlatformConfig);
  assert.deepEqual(s, { token: '', country: 'US', pollInterval: 60, runningPollInterval: 30, allowControl: false, phaseSensors: [], ignore: [] });
  const t = readSettings({
    platform: 'LGThinQConnect', token: ' abc ', country: 'gb', pollInterval: 5, runningPollInterval: '9999',
    allowControl: 'yes', phaseSensors: ['SPINNING', '', 3], ignore: [' Dryer '],
  } as unknown as PlatformConfig);
  assert.deepEqual(t, { token: 'abc', country: 'GB', pollInterval: 30, runningPollInterval: 600, allowControl: false, phaseSensors: ['SPINNING'], ignore: ['dryer'] });
});

if (!hap) {
  test('platform tests', { skip: `HAP library doesn't load on Node ${process.version}: ${loadError}` }, () => {});
} else {
  defineTests(hap);
}

function defineTests(hap: Hap): void {
  const { Service: S, Characteristic: C } = hap;

  async function homebridge(t: { after(fn: () => unknown): void }, config: Record<string, unknown> = {}) {
    const lg = await new FakeLG().start();
    const api = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const calls = { registered: [] as PlatformAccessory[], updated: [] as PlatformAccessory[], unregistered: [] as PlatformAccessory[] };
    api.hap = hap;
    api.platformAccessory = function (name: string, uuid: string): PlatformAccessory {
      return Object.assign(new hap!.Accessory(name, uuid), { context: {} }) as unknown as PlatformAccessory;
    };
    api.registerPlatformAccessories = (_p: string, _n: string, list: PlatformAccessory[]) => calls.registered.push(...list);
    api.updatePlatformAccessories = (list: PlatformAccessory[]) => calls.updated.push(...list);
    api.unregisterPlatformAccessories = (_p: string, _n: string, list: PlatformAccessory[]) => calls.unregistered.push(...list);
    const lines: string[] = [];
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const platforms: LGThinQPlatform[] = [];
    t.after(async () => { platforms.forEach((p) => p.stop()); await lg.stop(); });

    /** Start a platform with these cached accessories; resolves once its first discovery is done. */
    const start = async (cached: PlatformAccessory[] = [], over: Record<string, unknown> = {}) => {
      const cfg = { platform: 'LGThinQConnect', token: lg.token, ...config, ...over } as PlatformConfig;
      const client = new ThinQClient({ token: String(cfg.token || 'x'), country: 'US', baseUrl: lg.url });
      const platform = new LGThinQPlatform(log, cfg, api as unknown as API, client);
      platforms.push(platform);
      cached.forEach((a) => platform.configureAccessory(a));
      await platform.start();
      return platform;
    };
    return { lg, api, calls, lines, start };
  }

  test('no token: a warning with where to get one, nothing added', async (t) => {
    const hb = await homebridge(t);
    await hb.start([], { token: '' });
    assert.equal(hb.calls.registered.length, 0);
    assert.ok(hb.lines.some((l) => l.startsWith('warn: No LG personal access token set') && l.includes('connect-pat.lgthinq.com')));
  });

  test('our washer and dryer are added, named as in the ThinQ app, and checked right away', async (t) => {
    const hb = await homebridge(t);
    const platform = await hb.start();
    assert.deepEqual(hb.calls.registered.map((a) => a.displayName), ['Front Load Washer', 'Dryer']);
    assert.ok(hb.lines.includes('info: Added "Front Load Washer" (F3P2CYVAT__).'));
    assert.deepEqual(platform.machines.map((m) => m.units[0].status?.state), ['POWER_OFF', 'POWER_OFF']);
    assert.ok(hb.lg.requests.some((r) => r.path === 'devices/device-1/state'));
    assert.ok(!hb.lines.some((l) => l.includes('experimental')), 'washer and dryer are tested types');
    // The serial shown in the Home app is not LG's device ID
    const serial = hb.calls.registered[0].getService(S.AccessoryInformation)!.getCharacteristic(C.SerialNumber).value;
    assert.match(String(serial), /^[0-9A-F]{12}$/);
  });

  test('restarting reuses the cached accessories instead of adding new ones', async (t) => {
    const hb = await homebridge(t);
    await hb.start();
    const cached = hb.calls.registered.splice(0);
    await hb.start(cached);
    assert.equal(hb.calls.registered.length, 0);
    assert.equal(hb.calls.updated.length, 2);
    assert.equal(hb.calls.unregistered.length, 0);
  });

  test('an appliance removed from the account, or ignored, is removed from the Home app', async (t) => {
    const hb = await homebridge(t);
    await hb.start();
    const cached = hb.calls.registered.splice(0);
    await hb.start(cached, { ignore: ['dryer'] });
    assert.deepEqual(hb.calls.unregistered.map((a) => a.displayName), ['Dryer']);
    assert.ok(hb.lines.includes('info: Leaving out "Dryer" (in the ignore list).'));
  });

  test('LG unreachable at startup: cached accessories stay, and it tries again later', async (t) => {
    const hb = await homebridge(t);
    await hb.start();
    const cached = hb.calls.registered.splice(0);
    hb.lg.failWith = [503, '', 'Service unavailable'];
    await hb.start(cached);
    assert.equal(hb.calls.unregistered.length, 0);
    assert.ok(hb.lines.some((l) => l.startsWith('error: Couldn\'t list your LG appliances: HTTP 503') && l.includes('Trying again in 1 min')));
  });

  test('an unsupported appliance is named in the log, with how to help add it', async (t) => {
    const hb = await homebridge(t);
    hb.lg.devices.push({ deviceId: 'fridge', deviceInfo: { deviceType: 'DEVICE_REFRIGERATOR', alias: 'Fridge', modelName: 'X' }, profile: {}, state: {} });
    await hb.start();
    assert.equal(hb.calls.registered.length, 2);
    assert.ok(hb.lines.some((l) => l.startsWith('info: "Fridge" (DEVICE_REFRIGERATOR) isn\'t supported yet') && l.includes('lg-thinq-diagnostics')));
  });

  test('an untested laundry type is added and marked experimental; a two-drum one gets one accessory per drum', async (t) => {
    const hb = await homebridge(t);
    const washer = hb.lg.devices[0];
    const drum = (loc: string) => ({ ...(washer.profile as { property: Record<string, unknown>[] }).property[0], location: { locationName: loc } });
    hb.lg.devices = [{ deviceId: 'combo', deviceInfo: { deviceType: 'DEVICE_WASHCOMBO_MAIN', alias: 'Combo', modelName: 'WC' },
      profile: { property: [drum('MAIN'), drum('MINI')] }, state: [] }];
    await hb.start();
    assert.deepEqual(hb.calls.registered.map((a) => a.displayName), ['Combo Main', 'Combo Mini']);
    assert.ok(hb.lines.some((l) => l.startsWith('warn: [Combo] DEVICE_WASHCOMBO_MAIN support is experimental')));
  });

  test('a rejected token: a warning with advice, and a fault after repeated failures', async (t) => {
    const hb = await homebridge(t);
    const platform = await hb.start();
    hb.lg.failWith = [401, '1218', 'Invalid token'];
    const machine = platform.machines[0];
    for (let i = 0; i < 3; i++) { await platform.poll(machine); }
    assert.ok(hb.lines.some((l) => l.startsWith('warn: [Front Load Washer] Couldn\'t get its state from LG: HTTP 401') && l.includes('Check the personal access token')));
    assert.ok(hb.lines.some((l) => l.includes('Unreachable for 3 checks in a row')));
    const valve = machine.units[0].valve;
    assert.equal(valve.getCharacteristic(C.StatusFault).value, C.StatusFault.GENERAL_FAULT);
    hb.lg.failWith = null;
    await platform.poll(machine);
    assert.ok(hb.lines.includes('info: [Front Load Washer] Reachable again.'));
    assert.equal(valve.getCharacteristic(C.StatusFault).value, C.StatusFault.NO_FAULT);
  });

  test('a cycle seen through the API: time left on the tile; the end triggers done', async (t) => {
    const hb = await homebridge(t);
    const platform = await hb.start();
    const machine = platform.machines[0];
    const set = (state: string, remain: number) => {
      hb.lg.devices[0].state = [{ runState: { currentState: state }, timer: { remainHour: 0, remainMinute: remain, totalHour: 1, totalMinute: 0 },
        remoteControlEnable: { remoteControlEnabled: false }, location: { locationName: 'MAIN' } }];
    };
    set('SPINNING', 7);
    await platform.poll(machine);
    const acc = machine.units[0];
    assert.equal(acc.valve.getCharacteristic(C.RemainingDuration).value, 420);
    assert.equal(acc.valve.getCharacteristic(C.InUse).value, C.InUse.IN_USE);
    set('END', 0);
    await platform.poll(machine);
    assert.equal(acc.doneSensor.getCharacteristic(C.OccupancyDetected).value, C.OccupancyDetected.OCCUPANCY_DETECTED);
  });

  test('control on: a tap in the Home app reaches LG as a command for the right drum', async (t) => {
    const hb = await homebridge(t, { allowControl: true });
    hb.lg.devices[0].state = [{ runState: { currentState: 'RUNNING' }, timer: { remainHour: 0, remainMinute: 30 },
      remoteControlEnable: { remoteControlEnabled: true }, location: { locationName: 'MAIN' } }];
    const platform = await hb.start();
    const valve = platform.machines[0].units[0].valve;
    await valve.getCharacteristic(C.Active).handleSetRequest(0);
    const sent = hb.lg.requests.find((r) => r.method === 'POST');
    assert.equal(sent?.path, 'devices/device-1/control');
    assert.deepEqual(sent?.body, { operation: { washerOperationMode: 'STOP' }, location: { locationName: 'MAIN' } });
  });
}
