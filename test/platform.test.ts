// The platform against the fake LG server: finding appliances, registering and reusing
// accessories, removing old ones only after a successful listing, failures, and commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { LGThinQPlatform, readSettings, untilNextEnergyCheck } from '../src/platform';
import { ThinQClient } from '../src/api';
import { FakeLG } from './fake-lg';
import { FakeBroker } from './fake-broker';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

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
  assert.deepEqual(s, { token: '', country: 'US', pollInterval: 60, runningPollInterval: 30, allowControl: false, liveUpdates: true, phaseSensors: [], tubCleanAfter: 0, experimental: false, extraControls: true, ignore: [], appliances: new Map(), energy: true });
  const t = readSettings({
    platform: 'LGThinQConnect', token: ' abc ', country: 'gb', pollInterval: 5, runningPollInterval: '9999',
    allowControl: 'yes', liveUpdates: false, phaseSensors: ['SPINNING', '', 3], tubCleanAfter: 500, experimental: 'yes', extraControls: false, ignore: [' Dryer '], energy: false,
    appliances: [{ name: ' Living Room AC ', acModes: 'cool', acSwing: 'both', temperatureSensor: true, extraControls: false, odd: 1 },
      { name: '', acModes: 'cool' }, { name: 'Purifier', acModes: 'sideways', acSwing: 7 }, 'junk'],
  } as unknown as PlatformConfig);
  assert.deepEqual(t, { token: 'abc', country: 'GB', pollInterval: 30, runningPollInterval: 600, allowControl: false, liveUpdates: false, phaseSensors: ['SPINNING'], tubCleanAfter: 200, experimental: false, extraControls: false, ignore: ['dryer'], energy: false,
    appliances: new Map([['living room ac', { acModes: 'cool', acSwing: 'both', temperatureSensor: true, extraControls: false }], ['purifier', {}]]) });
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
    const start = async (cached: PlatformAccessory[] = [], over: Record<string, unknown> = {}, broker?: FakeBroker) => {
      const cfg = { platform: 'LGThinQConnect', token: lg.token, liveUpdates: !!broker, ...config, ...over } as PlatformConfig;
      const client = new ThinQClient({ token: String(cfg.token || 'x'), country: 'US', baseUrl: lg.url });
      const platform = new LGThinQPlatform(log, cfg, api as unknown as API, client);
      if (broker) {
        platform.liveOverrides = {
          connect: () => connect(broker.port, '127.0.0.1'),
          newIdentity: () => ({ privateKeyPem: 'KEY', csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----\n' }),
          storageFile: join(mkdtempSync(join(tmpdir(), 'lg-platform-')), 'live.json'),
        };
      }
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
    assert.ok(hb.lines.includes('warn: No LG personal access token set. Create one at https://connect-pat.lgthinq.com '
      + 'and paste it in this plugin\'s settings.'));
  });

  test('our washer and dryer are added, named as in the ThinQ app, and checked right away', async (t) => {
    const hb = await homebridge(t);
    const platform = await hb.start();
    assert.deepEqual(hb.calls.registered.map((a) => a.displayName), ['Front Load Washer', 'Dryer']);
    assert.ok(hb.lines.includes('info: Added "Front Load Washer" (F3P2CYVAT__).'));
    assert.equal(hb.lines.filter((l) => l === 'info: Signed in to LG (US): found Front Load Washer, Dryer.').length, 1);
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

  const until = async (check: () => boolean): Promise<void> => {
    const end = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > end) { throw new Error('timed out waiting'); }
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  test('energy: this month\'s use on the main tile for Eve, for appliances LG keeps it for', async (t) => {
    const hb = await homebridge(t);
    hb.lg.energy['device-1'] = { properties: ['energyUsage'], wh: 12345 };
    const platform = await hb.start();
    await until(() => hb.lg.energyQueries.length > 0);
    const month = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    assert.deepEqual(hb.lg.energyQueries, [`property=energyUsage&period=MONTHLY&startDate=${month}&endDate=${month}`]);
    const washer = hb.calls.registered.find((a) => a.displayName === 'Front Load Washer')!;
    const valve = washer.getService(S.Valve)!;
    await until(() => valve.characteristics.some((c) => c.UUID === 'E863F10C-079E-48FF-8F27-9C2605A29F52' && c.value === 12.345));
    assert.ok(hb.lines.includes('info: [Front Load Washer] Energy use this month is shown in the Eve app (LG updates it daily).'));
    // The dryer: LG keeps no figures for it, so nothing is added and nothing is logged above debug
    const dryer = hb.calls.registered.find((a) => a.displayName === 'Dryer')!;
    assert.ok(!dryer.getService(S.Valve)!.characteristics.some((c) => c.UUID === 'E863F10C-079E-48FF-8F27-9C2605A29F52'));
    assert.ok(!hb.lines.some((l) => l.includes('[Dryer] Energy') && !l.startsWith('debug')));
    platform.stop();
  });

  test('energy: turned off in the settings, LG isn\'t asked and an earlier figure is taken off the tile', async (t) => {
    const hb = await homebridge(t);
    hb.lg.energy['device-1'] = { properties: ['energyUsage'], wh: 1000 };
    const first = await hb.start();
    const isEnergy = (c: { UUID: string }) => c.UUID === 'E863F10C-079E-48FF-8F27-9C2605A29F52';
    const washer = hb.calls.registered.find((a) => a.displayName === 'Front Load Washer')!;
    await until(() => washer.getService(S.Valve)!.characteristics.some(isEnergy));
    first.stop();
    const cached = hb.calls.registered.splice(0);
    const queries = hb.lg.energyQueries.length;
    await hb.start(cached, { energy: false });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hb.lg.energyQueries.length, queries);
    assert.ok(!washer.getService(S.Valve)!.characteristics.some(isEnergy));
  });

  test('energy: LG not answering is tried again later; a model without figures isn\'t', async (t) => {
    const hb = await homebridge(t);
    hb.lg.energy['device-1'] = { properties: ['energyUsage'], wh: 1000 };
    hb.lg.failPath = /^devices\/energy\/device-1\/profile/;
    const platform = await hb.start();
    await new Promise((r) => setTimeout(r, 50));
    const washer = platform.machines.find((m) => m.device.deviceId === 'device-1')!;
    const dryer = platform.machines.find((m) => m.device.deviceId !== 'device-1')!;
    assert.ok(washer.energyTimer, 'a retry is scheduled');
    assert.equal(dryer.energyTimer, undefined, 'LG says the dryer has none: no retry');
    hb.lg.failPath = null;
    await platform.setupEnergy(washer);
    assert.equal(hb.lg.energyQueries.length, 1);
    platform.stop();
  });

  test('LG answering an empty list: nothing removed until it says so three times in a row', async (t) => {
    const hb = await homebridge(t);
    await hb.start();
    const cached = hb.calls.registered.splice(0);
    hb.lg.devices = [];
    const platform = await hb.start(cached);
    assert.equal(hb.calls.unregistered.length, 0);
    assert.ok(hb.lines.some((l) => l.startsWith('error: LG listed no appliances on this account. Trying again in 1 min')));
    await platform.discover();
    assert.equal(hb.calls.unregistered.length, 0);
    await platform.discover();
    assert.deepEqual(hb.calls.unregistered.map((a) => a.displayName), ['Front Load Washer', 'Dryer']);
  });

  test('LG not answering for an appliance\'s details: its accessory shows a fault, and setup is tried again', async (t) => {
    const hb = await homebridge(t);
    await hb.start();
    const cached = hb.calls.registered.splice(0);
    hb.lg.failPath = /device-1\/profile$/;
    const platform = await hb.start(cached);
    assert.deepEqual(platform.machines.map((m) => m.device.deviceInfo.alias), ['Dryer']);
    assert.equal(hb.calls.unregistered.length, 0);
    const washer = cached.find((a) => a.displayName === 'Front Load Washer')!;
    assert.equal(washer.getService(S.Valve)!.getCharacteristic(C.StatusFault).value, C.StatusFault.GENERAL_FAULT);
    assert.ok(hb.lines.some((l) => l.startsWith('error: [Front Load Washer] Couldn\'t set up') && l.includes('Trying again shortly')));
    hb.lg.failPath = null;
    await platform.retrySetups();
    assert.deepEqual(platform.machines.map((m) => m.device.deviceInfo.alias), ['Dryer', 'Front Load Washer']);
    assert.equal(hb.calls.registered.length, 0, 'the cached accessory is reused, not added twice');
    assert.equal(washer.getService(S.Valve)!.getCharacteristic(C.StatusFault).value, C.StatusFault.NO_FAULT);
    assert.ok(hb.lines.includes('info: [Front Load Washer] Set up now.'));
  });

  test('every appliance failing to set up: no "nothing supported" warning', async (t) => {
    const hb = await homebridge(t);
    hb.lg.failPath = /profile$/;
    await hb.start();
    assert.ok(!hb.lines.some((l) => l.includes('No supported LG appliances')));
  });

  test('other appliance types: left out unless "Experimental appliances" is on, with how to try them', async (t) => {
    const hb = await homebridge(t);
    hb.lg.devices.push({ deviceId: 'fridge', deviceInfo: { deviceType: 'DEVICE_REFRIGERATOR', alias: 'Fridge', modelName: 'X' }, profile: {}, state: {} });
    await hb.start();
    assert.equal(hb.calls.registered.length, 2);
    assert.ok(hb.lines.some((l) => l.startsWith('info: "Fridge" (DEVICE_REFRIGERATOR) isn\'t confirmed on a real appliance yet')
      && l.includes('"Experimental appliances"')));
  });

  test('experimental on: a type with nothing to show is named in the log, with how to help add it', async (t) => {
    const hb = await homebridge(t);
    hb.lg.devices.push({ deviceId: 'brew', deviceInfo: { deviceType: 'DEVICE_HOME_BREW', alias: 'Brewer', modelName: 'X' }, profile: {}, state: {} });
    await hb.start([], { experimental: true });
    assert.equal(hb.calls.registered.length, 2);
    assert.ok(hb.lines.some((l) => l.startsWith('info: "Brewer" (DEVICE_HOME_BREW) isn\'t supported yet') && l.includes('lg-thinq-diagnostics')));
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

  test('live updates: connected after finding the appliances; a state update moves the tile right away', async (t) => {
    const hb = await homebridge(t);
    const broker = await new FakeBroker().start();
    t.after(() => broker.stop());
    const platform = await hb.start([], {}, broker);
    await until(() => !!platform.live?.connected);
    assert.deepEqual(hb.lg.subscribed.event, ['device-1', 'device-2']);
    const topic = broker.clients[0].topics[0];
    broker.publish(topic, { deviceId: 'device-1', deviceType: 'DEVICE_WASHER', pushType: 'DEVICE_STATUS',
      report: [{ runState: { currentState: 'RINSING' }, timer: { remainHour: 0, remainMinute: 25, totalHour: 1, totalMinute: 0 }, location: { locationName: 'MAIN' } }] });
    const washer = platform.machines[0].units[0];
    await until(() => washer.status?.state === 'RINSING');
    assert.equal(washer.valve.getCharacteristic(C.RemainingDuration).value, 25 * 60);
    assert.ok(hb.lines.includes('info: [Front Load Washer] Rinsing, 25 min left.'));
    // Scheduled checks become a backup while live updates work
    const interval = (platform as unknown as { interval(m: unknown): number }).interval.bind(platform);
    assert.equal(interval(platform.machines[0]), 120);
    assert.equal(interval(platform.machines[1]), 600);
    broker.dropAll();
    await until(() => !platform.live?.connected);
    assert.equal(interval(platform.machines[1]), 60, 'back to normal checks');
  });

  test('live alerts: the dryer\'s "drying failed" opens its problem sensor; "complete" triggers done', async (t) => {
    const hb = await homebridge(t);
    const broker = await new FakeBroker().start();
    t.after(() => broker.stop());
    const platform = await hb.start([], {}, broker);
    await until(() => !!platform.live?.connected);
    const topic = broker.clients[0].topics[0];
    const dryer = platform.machines[1].units[0];
    // The dryer finishing: drying, then LG's alerts
    platform.onLive({ deviceId: 'device-2', pushType: 'DEVICE_STATUS', report: { runState: { currentState: 'COOLING' } } });
    broker.publish(topic, { deviceId: 'device-2', pushType: 'DEVICE_PUSH', pushCode: 'DRYING_FAILED' });
    await until(() => !!dryer.problemAlert);
    assert.equal(dryer.problemSensor.getCharacteristic(C.ContactSensorState).value, C.ContactSensorState.CONTACT_NOT_DETECTED);
    broker.publish(topic, { deviceId: 'device-2', pushType: 'DEVICE_PUSH', pushCode: 'DRYING_IS_COMPLETE' });
    await until(() => dryer.done);
    assert.equal(dryer.doneSensor.getCharacteristic(C.OccupancyDetected).value, C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.ok(hb.lines.includes('warn: [Dryer] LG alert: Drying failed.'));
    // Unknown appliances and types are ignored quietly
    // An alert for one of two drums of the same kind goes to the one in use
    const [a, b] = [{ busy: false, wasBusy: true, alertKey: 'washer', alerts: [] as string[] }, { busy: false, wasBusy: false, alertKey: 'washer', alerts: [] as string[] }]
      .map((p) => Object.assign(p, { accessory: null, update() {}, stop() {}, alert(_k: string, c: string) { p.alerts.push(c); } }));
    platform.machines.push({ device: { deviceId: 'twin', deviceInfo: { alias: 'Twin', deviceType: 'DEVICE_WASHER', modelName: '' } }, units: [], parts: [a, b] as never, failures: 0 });
    platform.onLive({ deviceId: 'twin', pushType: 'DEVICE_PUSH', pushCode: 'WASHING_IS_COMPLETE' });
    assert.deepEqual([a.alerts, b.alerts], [['WASHING_IS_COMPLETE'], []]);
    platform.machines.pop();
    platform.onLive({ deviceId: 'nope', pushType: 'DEVICE_STATUS', report: {} });
    platform.onLive({ deviceId: 'device-2', pushType: 'DEVICE_REGISTERED' });
    assert.ok(hb.lines.some((l) => l.startsWith('debug: Live update for an appliance not in the Home app')));
  });

  test('live updates off in the settings: no connection attempted', async (t) => {
    const hb = await homebridge(t);
    const platform = await hb.start();
    assert.equal(platform.live, undefined);
    assert.ok(!hb.lg.requests.some((r) => r.path === 'route'));
  });

  test('experimental on: a real air conditioner\'s data through LG, controlled from the Home app', async (t) => {
    const hb = await homebridge(t);
    const dir = join(__dirname, 'fixtures', 'ha', 'air_conditioner');
    const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
    const info = (read('device.json') as { deviceInfo: Record<string, unknown> }).deviceInfo;
    hb.lg.devices.push({ deviceId: 'ac-1', deviceInfo: info, profile: read('profile.json'), state: read('status.json') });
    const platform = await hb.start([], { experimental: true });
    assert.deepEqual(hb.calls.registered.map((a) => a.displayName), ['Front Load Washer', 'Dryer', 'Test air conditioner']);
    assert.ok(hb.lines.some((l) => l.startsWith('warn: [Test air conditioner] Added as an experimental air conditioner')));
    const ac = hb.calls.registered[2];
    const tile = ac.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(tile.getCharacteristic(C.CurrentTemperature).value, 25);
    await tile.getCharacteristic(C.Active).handleSetRequest(0);
    const sent = hb.lg.requests.find((r) => r.method === 'POST' && r.path === 'devices/ac-1/control');
    assert.deepEqual(sent?.body, { operation: { airConOperationMode: 'POWER_OFF' } });
    // Live updates reach it too
    platform.onLive({ deviceId: 'ac-1', pushType: 'DEVICE_STATUS', report: { temperature: { currentTemperature: 23, unit: 'C' } } });
    assert.equal(tile.getCharacteristic(C.CurrentTemperature).value, 23);
  });

  test('experimental on: a dishwasher is added as a cycle appliance', async (t) => {
    const hb = await homebridge(t);
    hb.lg.devices.push({ deviceId: 'dw', deviceInfo: { deviceType: 'DEVICE_DISH_WASHER', alias: 'Dishwasher', modelName: 'DW' },
      profile: { property: { runState: { currentState: { type: 'enum', mode: ['r'], value: { r: ['RUNNING', 'END'] } } } } },
      state: { runState: { currentState: 'RUNNING' }, timer: { remainHour: 1, remainMinute: 5 } } });
    const off = await hb.start();
    assert.equal(off.machines.length, 2, 'not without the setting');
    const on = await hb.start([], { experimental: true });
    const dish = on.machines[2].units[0];
    assert.equal(dish.unit.kind, 'dishwasher');
    assert.equal(dish.valve.getCharacteristic(C.RemainingDuration).value, 65 * 60);
    assert.ok(hb.lines.some((l) => l.includes('DEVICE_DISH_WASHER support is experimental')));
  });
}

test('energy is checked once a day, at a random time between 01:00 and 06:00', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m);
  const hours = (ms: number) => ms / 3600_000;
  assert.equal(hours(untilNextEnergyCheck(at(0), 0)), 1, 'just after midnight: 01:00 today');
  assert.equal(hours(untilNextEnergyCheck(at(0), 0.999999)), 6 - 0.000005, 'up to 06:00');
  assert.equal(hours(untilNextEnergyCheck(at(12), 0)), 13, 'in the afternoon: 01:00 tomorrow');
  assert.equal(hours(untilNextEnergyCheck(at(3), 0.2)), 23, 'already past today\'s 02:00: tomorrow\'s');
});
