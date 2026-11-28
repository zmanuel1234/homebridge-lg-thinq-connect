import test, { mock } from 'node:test';
import { ThinQError } from '../src/api.js';
import assert from 'node:assert/strict';
import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { LaundryAccessory, type LaundryContext, type LaundryOptions } from '../src/accessory.js';
import { type LaundryStatus, laundryStatus, laundryUnits } from '../src/laundry.js';
import { realDevices } from './fake-lg.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type Hap = typeof HapNodejs;

// These tests use Homebridge's HAP library, an ES module whose current release targets newer
// Node versions. If it can't be loaded, only these tests are skipped (with the reason).
let hap: Hap | null = null;
let loadError = '';
try {
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

if (!hap) {
  test('accessory tests', { skip: `HAP library doesn't load on Node ${process.version}: ${loadError}` }, () => {});
} else {
  defineTests(hap);
}

function defineTests(hap: Hap): void {
  const { Service: S, Characteristic: C } = hap;
  const [washer] = realDevices();
  const unit = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  type Acc = PlatformAccessory<LaundryContext>;

  const status = (over: Partial<LaundryStatus> = {}): LaundryStatus => ({
    state: 'POWER_OFF', running: false, paused: false, done: false, error: false, errorName: '',
    remaining: 0, total: 0, programTime: 0, remoteControl: false, ...over,
  });
  const running = (over: Partial<LaundryStatus> = {}) => status({ state: 'RUNNING', running: true, remaining: 1800, total: 3600, ...over });

  function setup(options: Partial<LaundryOptions> = {}, accessory?: Acc, forUnit = unit) {
    const lines: string[] = [];
    const sent: Record<string, unknown>[] = [];
    let refreshes = 0;
    let sendResult: () => Promise<unknown> = () => Promise.resolve({});
    const acc = accessory || Object.assign(new hap.Accessory('Washer', hap.uuid.generate(String(Math.random()))), { context: {} }) as unknown as Acc;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const api = { hap } as unknown as API;
    const laundry = new LaundryAccessory({ log, api }, acc, forUnit,
      { name: 'Washer', model: 'F3P2CYVAT__', serial: 'ABC123', allowControl: false, phaseSensors: [], tubCleanAfter: 0, ...options },
      (payload) => { sent.push(payload); return sendResult(); },
      () => { refreshes++; });
    return {
      acc, laundry, lines, sent,
      refreshes: () => refreshes,
      failSends: (err: Error) => { sendResult = () => Promise.reject(err); },
    };
  }

  const value = (ch: Characteristic) => ch.value;
  /** An on/off sensor of either kind (contact: open = on), as OccupancyDetected values. */
  function on(svc: Service): CharacteristicValue | null {
    if (svc.UUID === S.ContactSensor.UUID) {
      return svc.getCharacteristic(C.ContactSensorState).value === C.ContactSensorState.CONTACT_NOT_DETECTED ? 1 : 0;
    }
    return svc.getCharacteristic(C.OccupancyDetected).value;
  }
  /** What Home gets when it writes a characteristic: undefined, or the HAP error status. */
  async function write(ch: Characteristic, v: number): Promise<unknown> {
    try {
      await ch.handleSetRequest(v);
      return undefined;
    } catch (status) {
      return status;
    }
  }

  test('services: a valve as the main tile, a done sensor and a problem sensor, named after the machine', () => {
    const { acc, laundry } = setup();
    assert.ok(laundry.valve.isPrimaryService);
    assert.equal(acc.getServiceById(S.Valve, 'cycle'), laundry.valve);
    assert.equal(value(laundry.valve.getCharacteristic(C.ValveType)), C.ValveType.GENERIC_VALVE);
    assert.equal(value(laundry.valve.getCharacteristic(C.ConfiguredName)), 'Washer');
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.ConfiguredName)), 'Washer Finished');
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ConfiguredName)), 'Washer Error');
    const info = acc.getService(S.AccessoryInformation)!;
    assert.equal(value(info.getCharacteristic(C.Manufacturer)), 'LG');
    assert.equal(value(info.getCharacteristic(C.Model)), 'F3P2CYVAT__');
    assert.equal(value(info.getCharacteristic(C.SerialNumber)), 'ABC123');
  });

  test('a running cycle: active, in use, time left on the tile, beyond HomeKit\'s default one hour', () => {
    const { laundry } = setup();
    laundry.update(running({ remaining: 95 * 60, total: 120 * 60 }));
    assert.equal(value(laundry.valve.getCharacteristic(C.Active)), C.Active.ACTIVE);
    assert.equal(value(laundry.valve.getCharacteristic(C.InUse)), C.InUse.IN_USE);
    assert.equal(value(laundry.valve.getCharacteristic(C.RemainingDuration)), 95 * 60);
    assert.equal(value(laundry.valve.getCharacteristic(C.SetDuration)), 120 * 60);
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('paused: off, so a tap resumes it; the time left is kept', () => {
    const { laundry } = setup();
    laundry.update(status({ state: 'PAUSE', paused: true, remaining: 600, total: 3600 }));
    assert.equal(value(laundry.valve.getCharacteristic(C.Active)), C.Active.INACTIVE);
    assert.equal(value(laundry.valve.getCharacteristic(C.InUse)), C.InUse.NOT_IN_USE);
    assert.equal(value(laundry.valve.getCharacteristic(C.RemainingDuration)), 600);
  });

  test('finished: the done sensor detects, the tile goes off, and the log says so', () => {
    const { laundry, lines } = setup();
    laundry.update(running());
    laundry.update(status({ state: 'END', done: true }));
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(value(laundry.valve.getCharacteristic(C.Active)), C.Active.INACTIVE);
    assert.ok(lines.includes('info: [Washer] Finished.'));
    // The washer switches itself off 30 s later (seen): the laundry is still waiting, so done stays on
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    // Switched on for the next load: done ends
    laundry.update(status({ state: 'INITIAL' }));
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.stop();
  });

  test('done after the machine switches itself off: ends when it\'s started again, or after the set time; 0 = with the machine', () => {
    const done = (l: LaundryAccessory) => on(l.doneSensor);
    const started = setup();
    started.laundry.update(running());
    started.laundry.update(status({ state: 'END', done: true }));
    started.laundry.update(status());
    started.laundry.update(running());
    assert.equal(done(started.laundry), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED, 'a new cycle ends it');
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    try {
      const timed = setup({ doneHoldMinutes: 120 });
      timed.laundry.update(running());
      timed.laundry.update(status({ state: 'END', done: true }));
      timed.laundry.update(status());
      mock.timers.tick(119 * 60_000);
      assert.equal(done(timed.laundry), C.OccupancyDetected.OCCUPANCY_DETECTED);
      mock.timers.tick(2 * 60_000);
      assert.equal(done(timed.laundry), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED, 'ends after 2 hours');
    } finally {
      mock.timers.reset();
    }
    const now = setup({ doneHoldMinutes: 0 });
    now.laundry.update(running());
    now.laundry.update(status({ state: 'END', done: true }));
    now.laundry.update(status());
    assert.equal(done(now.laundry), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED, '0: off together with the machine');
  });

  test('done held across a Homebridge restart, and its time limit with it', () => {
    const first = setup();
    first.laundry.update(running());
    first.laundry.update(status({ state: 'END', done: true }));
    first.laundry.update(status());
    first.laundry.stop();
    assert.ok((first.acc.context as LaundryContext).doneUntil! > Date.now(), 'kept with the accessory');
    // Homebridge restarts: same accessory, no state from LG yet, then LG says off
    const again = setup({}, first.acc);
    assert.equal(on(again.laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    again.laundry.update(status());
    assert.equal(on(again.laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    again.laundry.update(status({ state: 'INITIAL' }));
    assert.equal(on(again.laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    assert.equal((again.acc.context as LaundryContext).doneUntil, undefined, 'forgotten once used');
    // A hold that ran out while Homebridge was down isn't brought back
    (again.acc.context as LaundryContext).doneUntil = Date.now() - 1000;
    const late = setup({}, again.acc);
    assert.equal(on(late.laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    late.laundry.stop();
  });

  test('a finish only inferred while the machine is still on shows for a minute, not the 2-hour hold', () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    try {
      const { laundry } = setup();
      laundry.update(running({ remaining: 60 }));
      // Stopped in its last minute, the machine still on: done briefly, as before
      laundry.update(status({ state: 'INITIAL' }));
      assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
      mock.timers.tick(61_000);
      assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    } finally {
      mock.timers.reset();
    }
  });

  test('ovens: done ends with them (cooking finished, not a load waiting)', () => {
    const oven = laundryUnits('DEVICE_OVEN', ovenProfile())[1];
    const { laundry } = setup({ name: 'Oven' }, undefined, oven);
    laundry.update(running({ state: 'COOKING_IN_PROGRESS' }));
    laundry.update(status({ state: 'DONE', done: true }));
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('done after a dryer\'s wrinkle care: switched off there, it ends at once (someone is at the machine)', () => {
    const { laundry } = setup();
    laundry.update(running());
    laundry.update(status({ state: 'END', done: true }));
    laundry.update(status({ state: 'WRINKLE_CARE', done: true, remoteControl: true }));
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('a finish missed between two checks (straight to off near the end) still triggers done, briefly', () => {
    const { laundry } = setup();
    laundry.update(running({ remaining: 60 }));
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(running());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.stop();
  });

  /** An oven as LG documents one: two cavities; the upper bakes only. */
  const ovenProfile = (units: ('C' | 'F')[] = ['F', 'C']) => ({ property: ['UPPER', 'LOWER'].map((loc) => ({
    location: { locationName: loc },
    runState: { currentState: { type: 'enum', mode: ['r'], value: { r: ['INITIAL', 'PREHEATING', 'COOKING_IN_PROGRESS', 'COOLING', 'DONE'] } } },
    operation: { ovenOperationMode: { type: 'enum', mode: ['w'], value: { w: ['PREHEATING', 'START', 'STOP'] } } },
    cook: { cookMode: { type: 'enum', mode: ['w'], value: { w: loc === 'UPPER' ? ['BAKE'] : ['BAKE', 'CONVECTION_BAKE', 'CONVECTION_ROAST'] } } },
    remoteControlEnable: { remoteControlEnabled: { type: 'boolean', mode: ['r'], value: { r: [false, true] } } },
    temperature: units.map((u) => ({ unit: u, targetTemperature: { type: 'range', mode: ['r', 'w'],
      value: u === 'F' ? { r: { min: 170, max: 550, step: 1 }, w: { min: 170, max: 550, step: 1 } } : { r: { min: 80, max: 285, step: 1 }, w: { min: 80, max: 285, step: 1 } } } })),
  })) });

  const ovenState = (state: string, over: Record<string, unknown> = {}) => [{ location: { locationName: 'LOWER' }, runState: { currentState: state },
    remoteControlEnable: { remoteControlEnabled: true }, ...over }];
  const F = (v: number) => ({ temperature: { targetTemperature: v, unit: 'F' } });
  const heatOn = (l: LaundryAccessory) => l.ovenThermostat!.getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.HEAT);
  const setTemp = (l: LaundryAccessory, c: number) => l.ovenThermostat!.getCharacteristic(C.TargetTemperature).handleSetRequest(c);

  test('oven: a thermostat per cavity that starts it at a temperature and stops it', async () => {
    const units = laundryUnits('DEVICE_OVEN', ovenProfile());
    assert.deepEqual(units.map((u) => [u.location, u.oven?.cookModes]), [['UPPER', ['BAKE']], ['LOWER', ['BAKE', 'CONVECTION_BAKE', 'CONVECTION_ROAST']]]);
    const lower = units[1];
    const { laundry, sent, lines } = setup({ name: 'Lower oven', allowControl: true }, undefined, lower);
    const t = laundry.ovenThermostat!;
    assert.equal(t.getCharacteristic(C.TargetTemperature).props.maxValue, 285);
    assert.equal(t.getCharacteristic(C.TargetTemperature).props.minStep, 0.5, 'half degrees, so every whole °F can be chosen');
    // A US oven, idle, showing °F
    laundry.update(laundryStatus(lower, ovenState('INITIAL', F(0))));
    assert.equal(value(t.getCharacteristic(C.TemperatureDisplayUnits)), C.TemperatureDisplayUnits.FAHRENHEIT);
    await heatOn(laundry);
    assert.deepEqual(sent, [{ operation: { ovenOperationMode: 'START' }, location: { locationName: 'LOWER' },
      temperature: { targetTemperature: 350, unit: 'F' }, cook: { cookMode: 'BAKE' } }], 'starts at 350 °F, in bake');
    assert.ok(lines.includes('info: [Lower oven] Sent start: bake, 350 °F.'));
    // Cooking at 375 °F in convection: shown, and a new temperature is sent at once, keeping the mode
    const cooking = laundryStatus(lower, ovenState('COOKING_IN_PROGRESS', { ...F(375), cook: { cookMode: 'CONVECTION_BAKE' } }));
    assert.deepEqual([cooking.running, cooking.setTemperature, cooking.cookMode], [true, { value: 375, unit: 'F' }, 'CONVECTION_BAKE']);
    laundry.update(cooking);
    assert.equal(value(t.getCharacteristic(C.CurrentHeatingCoolingState)), C.CurrentHeatingCoolingState.HEAT);
    assert.equal(value(t.getCharacteristic(C.TargetTemperature)), 190.5);
    assert.equal(Math.round(Number(value(t.getCharacteristic(C.CurrentTemperature))) * 10) / 10, 190.6, 'LG gives no actual temperature: the set one shows');
    await setTemp(laundry, 204.5);
    assert.deepEqual(sent.at(-1), { operation: { ovenOperationMode: 'START' }, location: { locationName: 'LOWER' },
      temperature: { targetTemperature: 400, unit: 'F' }, cook: { cookMode: 'CONVECTION_BAKE' } });
    // The chosen temperature holds while the oven still reports the old one
    laundry.update(cooking);
    assert.equal(value(t.getCharacteristic(C.TargetTemperature)), 204.5);
    await t.getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.OFF);
    assert.deepEqual(sent.at(-1), { operation: { ovenOperationMode: 'STOP' }, location: { locationName: 'LOWER' } });
    // Cooling down afterwards isn't cooking; DONE is a finish
    const cool = laundryStatus(lower, ovenState('COOLING'));
    assert.deepEqual([cool.running, cool.done], [false, false]);
    assert.equal(laundryStatus(lower, ovenState('DONE')).done, true);
  });

  test('oven: nothing restarts it by surprise (paused, self-cleaning, the main tile, a stale temperature)', async () => {
    const lower = laundryUnits('DEVICE_OVEN', ovenProfile())[1];
    const { laundry, sent, lines, acc } = setup({ name: 'Oven', allowControl: true }, undefined, lower);
    // Paused: a new temperature is kept for later, not sent (START would resume it)
    laundry.update(laundryStatus(lower, ovenState('PAUSED', F(350))));
    await setTemp(laundry, 200);
    assert.equal(sent.length, 0);
    // Self-cleaning: no start and no temperature; stop still works
    laundry.update(laundryStatus(lower, ovenState('CLEANING')));
    await setTemp(laundry, 210);
    assert.equal(sent.length, 0);
    await heatOn(laundry); // shown as heating already: nothing to do
    assert.equal(sent.length, 0);
    assert.equal(value(laundry.ovenThermostat!.getCharacteristic(C.CurrentHeatingCoolingState)), C.CurrentHeatingCoolingState.HEAT);
    // The main tile on an oven starts through the thermostat, with temperature and mode
    laundry.update(laundryStatus(lower, ovenState('INITIAL', F(0))));
    await acc.getService(S.Valve)!.getCharacteristic(C.Active).handleSetRequest(1);
    assert.deepEqual(sent.at(-1), { operation: { ovenOperationMode: 'START' }, location: { locationName: 'LOWER' },
      temperature: { targetTemperature: 410, unit: 'F' }, cook: { cookMode: 'BAKE' } }, 'the last temperature chosen in the Home app (210 °C)');
    // A temperature set right after the start (same scene) is sent again, though the oven doesn't report cooking yet
    await setTemp(laundry, 180);
    assert.equal((sent.at(-1)!.temperature as { targetTemperature: number }).targetTemperature, 356);
    // While idle, an old temperature reported by the oven doesn't replace the one chosen
    const fresh = setup({ name: 'Oven', allowControl: true }, undefined, lower);
    await setTemp(fresh.laundry, 150);
    fresh.laundry.update(laundryStatus(lower, ovenState('INITIAL', F(400))));
    await heatOn(fresh.laundry);
    assert.equal((fresh.sent[0].temperature as { targetTemperature: number }).targetTemperature, 302);
    // A paused oven isn't resumed from the main tile
    fresh.laundry.update(laundryStatus(lower, ovenState('PAUSED', F(302))));
    await assert.rejects(fresh.acc.getService(S.Valve)!.getCharacteristic(C.Active).handleSetRequest(1));
    assert.ok(fresh.lines.includes('info: [Oven] The oven is paused: resume it at the oven.'));
    assert.equal(fresh.sent.length, 1);
    assert.ok(!lines.some((l) => l.includes('Sent temperature') && l.includes('210')));
  });

  test('oven: refused without control allowed or remote control on; a °F-only oven; no temperature, no thermostat', async () => {
    const [upper] = laundryUnits('DEVICE_OVEN', ovenProfile(['F']));
    const a = setup({ name: 'Oven' }, undefined, upper);
    await assert.rejects(heatOn(a.laundry));
    assert.ok(a.lines.some((l) => l.includes('control is off in the plugin settings')));
    const b = setup({ name: 'Oven', allowControl: true }, undefined, upper);
    b.laundry.update(status({ state: 'INITIAL' }));
    await assert.rejects(heatOn(b.laundry));
    assert.ok(b.lines.includes('info: [Oven] Can\'t start the oven: turn on remote control on the oven first (LG only accepts commands then).'));
    assert.equal(b.sent.length, 0);
    // °F only: limits converted for the Home app, and commands in °F
    assert.equal(b.laundry.ovenThermostat!.getCharacteristic(C.TargetTemperature).props.minValue, 76);
    b.laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    await heatOn(b.laundry);
    assert.deepEqual(b.sent[0].temperature, { targetTemperature: 350, unit: 'F' });
    // A washer has no oven thermostat
    assert.equal(setup().laundry.ovenThermostat, undefined);
  });

  test('stopped early, before LG knew the time (0 left while detecting the load), is not a finish', () => {
    const { laundry } = setup();
    laundry.update(running({ state: 'DETECTING', remaining: 0, total: 0 }));
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(running({ state: 'RUNNING', remaining: 0, total: 0 }));
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('a cycle cancelled with plenty of time left is not a finish', () => {
    const { laundry } = setup();
    laundry.update(running({ remaining: 40 * 60 }));
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('an error: the problem sensor opens, the tile shows a fault, the log names it', () => {
    const { laundry, lines } = setup();
    laundry.update(running());
    laundry.update(status({ state: 'ERROR', error: true, errorName: 'WATER_SUPPLY_ERROR' }));
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    assert.equal(value(laundry.valve.getCharacteristic(C.StatusFault)), C.StatusFault.GENERAL_FAULT);
    assert.ok(lines.includes('warn: [Washer] The machine reports an error: WATER_SUPPLY_ERROR.'));
    laundry.update(status());
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED);
    assert.equal(value(laundry.valve.getCharacteristic(C.StatusFault)), C.StatusFault.NO_FAULT);
  });

  test('unreachable: a fault on the tile, the last known state kept', () => {
    const { laundry } = setup();
    laundry.update(running());
    laundry.update(null);
    assert.equal(value(laundry.valve.getCharacteristic(C.StatusFault)), C.StatusFault.GENERAL_FAULT);
    assert.equal(value(laundry.valve.getCharacteristic(C.InUse)), C.InUse.IN_USE);
    laundry.update(running());
    assert.equal(value(laundry.valve.getCharacteristic(C.StatusFault)), C.StatusFault.NO_FAULT);
  });

  test('phase sensors: only phases the machine reports; on during that phase', () => {
    const { acc, laundry } = setup({ phaseSensors: ['SPINNING', 'COOLING'] });
    assert.deepEqual([...laundry.phaseSensors.keys()], ['SPINNING'], 'a washer never reports COOLING');
    const spin = acc.getServiceById(S.OccupancySensor, 'phase-SPINNING')!;
    assert.equal(value(spin.getCharacteristic(C.ConfiguredName)), 'Washer Spinning');
    laundry.update(running({ state: 'SPINNING' }));
    assert.equal(on(spin), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(running({ state: 'RINSING' }));
    assert.equal(on(spin), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('phase sensors taken out of the settings are removed from a cached accessory', () => {
    const first = setup({ phaseSensors: ['SPINNING', 'RINSING'] });
    const again = setup({ phaseSensors: ['RINSING'] }, first.acc);
    assert.equal(again.acc.getServiceById(S.OccupancySensor, 'phase-SPINNING'), undefined);
    assert.ok(again.acc.getServiceById(S.OccupancySensor, 'phase-RINSING'));
    assert.equal(again.acc.services.filter((s) => s.UUID === S.Valve.UUID).length, 1, 'no duplicate services');
  });

  test('a name changed in the Home app is kept', () => {
    const first = setup();
    first.laundry.valve.getCharacteristic(C.ConfiguredName).updateValue('Laundry room washer');
    const again = setup({}, first.acc);
    assert.equal(value(again.laundry.valve.getCharacteristic(C.ConfiguredName)), 'Laundry room washer');
  });

  test('LG\'s "finished" alert: done right away, until the machine is switched off or starts again', () => {
    const { laundry, lines } = setup();
    laundry.update(running({ remaining: 60 }));
    laundry.alert('finished', 'WASHING_IS_COMPLETE');
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.ok(lines.includes('info: [Washer] LG says the cycle is finished.'));
    laundry.update(status({ state: 'END', done: true }));
    laundry.update(status());
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED, 'still waiting');
    laundry.update(status({ state: 'INITIAL' }));
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.stop();
  });

  test('LG\'s "finished" alert while weighing the load is ignored; with lots of time shown, the next state decides', () => {
    const { laundry, lines } = setup();
    const done = () => on(laundry.doneSensor);
    laundry.update(running({ state: 'DETECTING', remaining: 0, total: 0 }));
    laundry.alert('finished', 'WASHING_IS_COMPLETE');
    assert.equal(done(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    assert.ok(lines.some((l) => l.startsWith('debug: [Washer] Ignored LG\'s "WASHING_IS_COMPLETE" alert')));
    // Premature: the next state is still mid-cycle
    laundry.update(running({ remaining: 45 * 60 }));
    laundry.alert('finished', 'WASHING_IS_COMPLETE');
    assert.equal(done(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(running({ remaining: 44 * 60 }));
    assert.equal(done(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    // Real: a sensor dry that ends early (the alert comes first, then the end)
    const dryer = setup();
    dryer.laundry.update(running({ remaining: 20 * 60 }));
    dryer.laundry.alert('finished', 'DRYING_IS_COMPLETE');
    dryer.laundry.update(status({ state: 'END', done: false }));
    assert.equal(on(dryer.laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.ok(dryer.lines.includes('info: [Washer] LG says the cycle is finished.'));
    // …or straight to off
    const off = setup();
    off.laundry.update(running({ remaining: 20 * 60 }));
    off.laundry.alert('finished', 'DRYING_IS_COMPLETE');
    off.laundry.update(status());
    assert.equal(on(off.laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    off.laundry.stop();
  });

  test('LG\'s "finished" alert when the machine is already off: a brief done', () => {
    const { laundry } = setup();
    laundry.update(status());
    laundry.alert('finished', 'DRYING_IS_COMPLETE');
    assert.equal(on(laundry.doneSensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.stop();
  });

  test('LG\'s problem alert (drying failed): the problem sensor opens until the next cycle', () => {
    const { laundry, lines } = setup();
    laundry.update(status({ state: 'END', done: true }));
    laundry.alert('problem', 'DRYING_FAILED');
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    assert.equal(value(laundry.valve.getCharacteristic(C.StatusFault)), C.StatusFault.GENERAL_FAULT);
    assert.ok(lines.includes('warn: [Washer] LG alert: Drying failed.'));
    laundry.update(status({ state: 'END', done: true }));
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED, 'still open');
    laundry.update(running());
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED);
  });

  test('other LG alerts are only logged', () => {
    const { laundry, lines } = setup();
    laundry.alert('other', 'TUB_CLEAN_RECOMMENDED');
    assert.ok(lines.includes('info: [Washer] LG alert: Tub clean recommended.'));
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED);
  });

  test('tub-clean reminder: on once LG\'s cycle count reaches the setting, logged once', () => {
    const { acc, laundry, lines } = setup({ tubCleanAfter: 30 });
    const sensor = acc.getServiceById(S.ContactSensor, 'tub-clean')!;
    assert.equal(value(sensor.getCharacteristic(C.ConfiguredName)), 'Washer Tub Clean Due');
    laundry.update(status({ cycleCount: 29 }));
    assert.equal(on(sensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(status({ cycleCount: 30 }));
    laundry.update(status({ cycleCount: 31 }));
    assert.equal(on(sensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(lines.filter((l) => l.includes('Time for a Tub Clean')).length, 1);
    assert.ok(lines.includes('info: [Washer] Time for a Tub Clean: LG counts 30 cycles (reminder set at 30).'));
    // Switched on: LG briefly says 0, then the real count again (seen: 16 → 0 → 16): no flicker
    laundry.update(status({ state: 'INITIAL', cycleCount: 0 }));
    assert.equal(on(sensor), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(status({ state: 'INITIAL', cycleCount: 31 }));
    assert.equal(lines.filter((l) => l.includes('Time for a Tub Clean')).length, 1, 'not logged again');
    assert.equal(lines.filter((l) => l.includes('LG now counts 31')).length, 1, 'the blip isn\'t a new count');
    // After a Tub Clean, LG's count starts again: a 0 that lasts is believed
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      laundry.update(status({ cycleCount: 0 }));
      mock.timers.tick(31_000);
      laundry.update(status({ cycleCount: 0 }));
    } finally {
      mock.timers.reset();
    }
    assert.equal(on(sensor), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    assert.deepEqual(lines.filter((l) => l.includes('restarted')),
      ['info: [Washer] LG\'s count restarted at 0 (was 31): Tub Clean done, the reminder is off.'], 'logged once');
    // The next wash counts from 1 again, logged like any other
    laundry.update(status({ cycleCount: 1 }));
    assert.ok(lines.includes('info: [Washer] LG now counts 1 cycle.'));
  });

  test('a Tub Clean restarting LG\'s count is logged without the reminder too; a brief 0 isn\'t', () => {
    const { laundry, lines } = setup();
    laundry.update(status({ cycleCount: 23 }));
    laundry.update(status({ state: 'INITIAL', cycleCount: 0 }));
    laundry.update(status({ state: 'INITIAL', cycleCount: 23 }));
    assert.equal(lines.filter((l) => l.includes('restarted')).length, 0, 'the power-on blip');
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      laundry.update(status({ state: 'END', cycleCount: 0 }));
      mock.timers.tick(31_000);
      laundry.update(status({ state: 'POWER_OFF', cycleCount: 0 }));
      laundry.update(status({ state: 'POWER_OFF', cycleCount: 0 }));
    } finally {
      mock.timers.reset();
    }
    assert.deepEqual(lines.filter((l) => l.includes('restarted')),
      ['info: [Washer] LG\'s count restarted at 0 (was 23): Tub Clean done.']);
  });

  test('tub-clean reminder: none when off, for a dryer, or for a washer that doesn\'t count; removed when turned off', () => {
    assert.equal(setup().acc.getServiceById(S.ContactSensor, 'tub-clean'), undefined, 'off by default');
    const [, dryerDevice] = realDevices();
    const dryerUnit = laundryUnits('DEVICE_DRYER', dryerDevice.profile)[0];
    assert.equal(dryerUnit.countsCycles, false);
    assert.equal(unit.countsCycles, true, 'our washer counts its cycles');
    const on = setup({ tubCleanAfter: 30 });
    const off = setup({ tubCleanAfter: 0 }, on.acc);
    assert.equal(off.acc.getServiceById(S.ContactSensor, 'tub-clean'), undefined);
  });

  // Dryer care: the lint filter reminder and the vent check
  const [, dryerDevice] = realDevices();
  const dryerUnit = laundryUnits('DEVICE_DRYER', dryerDevice.profile)[0];
  const dryerSetup = (options: Partial<LaundryOptions> = {}, accessory?: Acc) => setup({ name: 'Dryer', ...options }, accessory, dryerUnit);
  const detected = (svc: Service | undefined) => on(svc!) === C.OccupancyDetected.OCCUPANCY_DETECTED;
  /** One dry: idle → running for `minutes` (with a pause that doesn't count) → END → off. */
  function dry(laundry: LaundryAccessory, minutes: number): void {
    laundry.update(status({ state: 'INITIAL' }));
    laundry.update(running());
    mock.timers.tick((minutes - 5) * 60_000);
    laundry.update(status({ state: 'PAUSE', paused: true, remaining: 300, total: 3600 }));
    mock.timers.tick(20 * 60_000);
    laundry.update(running({ state: 'COOLING', remaining: 300 }));
    mock.timers.tick(5 * 60_000);
    laundry.update(status({ state: 'END', done: true }));
    laundry.update(status({ state: 'POWER_OFF' }));
  }
  async function withClock(fn: () => void | Promise<void>): Promise<void> {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    try { await fn(); } finally { mock.timers.reset(); }
  }

  test('dryer care: off by default; only for dryers; sensors and button named after the dryer', () => {
    const plain = dryerSetup();
    assert.equal(plain.laundry.lintSensor, undefined);
    assert.equal(plain.laundry.ventSensor, undefined);
    assert.equal(setup({ lintFilterAfter: 5, ventCheckPercent: 30 }).laundry.lintSensor, undefined, 'not for a washer');
    const { acc, laundry } = dryerSetup({ lintFilterAfter: 5, ventCheckPercent: 30 });
    assert.equal(value(laundry.lintSensor!.getCharacteristic(C.ConfiguredName)), 'Dryer Clean Lint Filter');
    assert.equal(value(laundry.lintButton!.getCharacteristic(C.ConfiguredName)), 'Dryer Lint Filter Cleaned');
    assert.equal(value(laundry.ventSensor!.getCharacteristic(C.ConfiguredName)), 'Dryer Check Vent');
    assert.equal(acc.getServiceById(S.Switch, 'lint-filter-cleaned'), laundry.lintButton);
    // Turned off again: removed
    const off = dryerSetup({}, acc);
    assert.equal(acc.getServiceById(S.ContactSensor, 'lint-filter'), undefined);
    assert.equal(acc.getServiceById(S.Switch, 'lint-filter-cleaned'), undefined);
    assert.equal(acc.getServiceById(S.ContactSensor, 'vent-check'), undefined);
    assert.equal(off.laundry.lintSensor, undefined);
  });

  test('lint filter: on after the set number of dries (kept across restarts); the button starts again and turns itself off', async () => {
    const { acc, laundry } = dryerSetup({ lintFilterAfter: 2 });
    await withClock(async () => {
      dry(laundry, 50);
      assert.equal(acc.context.lintDries, 1);
      assert.equal(detected(laundry.lintSensor), false);
      // A Homebridge restart between dries: the count is kept with the accessory
      const again = dryerSetup({ lintFilterAfter: 2 }, acc);
      dry(again.laundry, 50);
      assert.equal(detected(again.laundry.lintSensor), true);
      assert.ok(again.lines.includes('info: [Dryer] Time to clean the lint filter: 2 dries since it was last cleaned.'));
      // A dry stopped half way isn't counted
      again.laundry.update(running());
      mock.timers.tick(10 * 60_000);
      again.laundry.update(status({ state: 'INITIAL' }));
      assert.equal(acc.context.lintDries, 2);
      assert.equal(await write(again.laundry.lintButton!.getCharacteristic(C.On), 1), undefined);
      assert.equal(acc.context.lintDries, 0);
      assert.equal(detected(again.laundry.lintSensor), false);
      assert.ok(again.lines.includes('info: [Dryer] Lint filter marked cleaned (after 2 dries).'));
      mock.timers.tick(1000);
      assert.equal(value(again.laundry.lintButton!.getCharacteristic(C.On)), false, 'the button turns itself off');
    });
  });

  test('estimate check (log only): how far a dry ran past its first estimate; the Check Vent sensor is left alone', async () => {
    const { acc, laundry, lines } = dryerSetup({ ventCheckPercent: 30 });
    await withClock(() => {
      laundry.update(status({ state: 'INITIAL' }));
      laundry.update(running({ remaining: 45 * 60 }));
      mock.timers.tick(6 * 60_000);
      laundry.update(running({ remaining: 34 * 60 }));
      mock.timers.tick(20 * 60_000);
      laundry.update(running({ remaining: 25 * 60 }));
      mock.timers.tick(21 * 60_000);
      laundry.update(running({ state: 'COOLING', remaining: 5 * 60 }));
      mock.timers.tick(5 * 60_000);
      laundry.update(status({ state: 'END', done: true }));
      assert.ok(lines.includes('info: [Dryer] Estimate check (log only): dried 52 min, first estimate 40 min, largest 51 min: +30%. '
        + 'Last 1: +30% (would leave off Check Vent at 30%).'), lines.join('\n'));
      assert.deepEqual(acc.context.overruns, [30]);
      assert.equal(acc.context.dryEstimate, undefined);
      assert.equal(on(laundry.ventSensor!), C.ContactSensorState.CONTACT_DETECTED, 'log only: the sensor stays off');
      // A dry already under way when Homebridge started has no estimate: nothing logged
      const again = dryerSetup({ ventCheckPercent: 30 }, acc);
      again.laundry.update(running({ remaining: 30 * 60 }));
      mock.timers.tick(40 * 60_000);
      again.laundry.update(running({ remaining: 10 * 60 }));
      again.laundry.update(status({ state: 'END', done: true }));
      assert.equal(again.lines.filter((l) => l.includes('Estimate check')).length, 0);
    });
  });

  test('vent check: times each dry without its pauses; on when dries get 30 % longer, off when back to usual', async () => {
    const { acc, laundry, lines } = dryerSetup({ ventCheckPercent: 30 });
    await withClock(() => {
      for (let i = 0; i < 8; i++) { dry(laundry, 50); }
      assert.deepEqual(acc.context.dryMinutes, [50, 50, 50, 50, 50, 50, 50, 50], 'the 20-minute pauses don\'t count');
      assert.equal(laundry.usualDryMinutes, 50);
      dry(laundry, 70);
      assert.equal(detected(laundry.ventSensor), false);
      dry(laundry, 72);
      assert.equal(detected(laundry.ventSensor), true);
      assert.ok(lines.some((l) => l.startsWith('warn: [Dryer] Drying takes longer than usual (recent dries about 70 min, usually 50 min)')));
      dry(laundry, 50);
      dry(laundry, 49);
      assert.equal(detected(laundry.ventSensor), false);
      assert.ok(lines.includes('info: [Dryer] Drying times are back to usual (about 50 min): vent check off.'));
    });
  });

  test('lint filter clearing itself: no button; on after the dries set, off when the next dry starts', async () => {
    const { acc, laundry, lines } = dryerSetup({ lintFilterAfter: 1, lintFilterAutoClear: true });
    assert.equal(laundry.lintButton, undefined);
    assert.equal(acc.getServiceById(S.Switch, 'lint-filter-cleaned'), undefined);
    await withClock(() => {
      dry(laundry, 50);
      assert.equal(detected(laundry.lintSensor), true, 'after every dry');
      assert.ok(lines.includes('info: [Dryer] Time to clean the lint filter: 1 dry since it was last cleaned.'));
      // Opening the door, pressing buttons: not a new dry yet
      laundry.update(status({ state: 'INITIAL' }));
      assert.equal(detected(laundry.lintSensor), true);
      laundry.update(running());
      assert.equal(detected(laundry.lintSensor), false, 'the next dry started');
      assert.ok(lines.includes('info: [Dryer] Lint filter reminder off: the dryer started again.'));
      mock.timers.tick(50 * 60_000);
      laundry.update(status({ state: 'END', done: true }));
      assert.equal(detected(laundry.lintSensor), true, 'and on again after it');
    });
    // With more dries set, starting the dryer before the reminder doesn't reset the count
    const three = dryerSetup({ lintFilterAfter: 3, lintFilterAutoClear: true });
    await withClock(() => {
      dry(three.laundry, 50);
      dry(three.laundry, 50);
      assert.equal(three.acc.context.lintDries, 2);
      dry(three.laundry, 50);
      assert.equal(detected(three.laundry.lintSensor), true);
      three.laundry.update(running());
      assert.equal(three.acc.context.lintDries, 0);
    });
    // Turning it off brings the button back
    const back = dryerSetup({ lintFilterAfter: 1 }, acc);
    assert.ok(back.laundry.lintButton);
  });

  test('lint filter: LG\'s "drying complete" during cool-down and then END count as one dry, also across a restart', async () => {
    const { acc, laundry } = dryerSetup({ lintFilterAfter: 5, ventCheckPercent: 30 });
    await withClock(() => {
      laundry.update(status({ state: 'INITIAL' }));
      laundry.update(running());
      mock.timers.tick(45 * 60_000);
      laundry.update(running({ state: 'COOLING', remaining: 5 * 60 }));
      laundry.alert('finished', 'DRYING_IS_COMPLETE');
      mock.timers.tick(5 * 60_000);
      laundry.update(running({ state: 'COOLING', remaining: 60 }));
      // Homebridge restarts before the end
      const again = dryerSetup({ lintFilterAfter: 5, ventCheckPercent: 30 }, acc);
      again.laundry.update(running({ state: 'COOLING', remaining: 60 }));
      mock.timers.tick(60_000);
      again.laundry.update(status({ state: 'END', done: true }));
      again.laundry.update(status({ state: 'POWER_OFF' }));
      assert.equal(acc.context.lintDries, 1, 'one dry');
      assert.deepEqual(acc.context.dryMinutes, [51], 'timed once, to the real end (cool-down included)');
      // The next dry counts again
      dry(again.laundry, 50);
      assert.equal(acc.context.lintDries, 2);
      // A restart between dries, and the next dry already running when the plugin starts: it's a
      // new dry (counted, not timed), not the rest of the one counted earlier
      mock.timers.tick(3 * 3600_000);
      const later = dryerSetup({ lintFilterAfter: 5, ventCheckPercent: 30 }, acc);
      later.laundry.update(running());
      mock.timers.tick(40 * 60_000);
      later.laundry.update(status({ state: 'END', done: true }));
      assert.equal(acc.context.lintDries, 3);
      assert.deepEqual(acc.context.dryMinutes, [51, 50], 'its start is unknown, so it isn\'t timed');
    });
  });

  test('vent check: a dry already under way when the plugin started isn\'t timed (its start is unknown)', async () => {
    const { acc, laundry } = dryerSetup({ ventCheckPercent: 30, lintFilterAfter: 3 });
    await withClock(() => {
      laundry.update(running());
      mock.timers.tick(10 * 60_000);
      laundry.update(status({ state: 'END', done: true }));
    });
    assert.equal(acc.context.dryMinutes, undefined);
    assert.equal(acc.context.lintDries, 1, 'but it still counts for the lint filter');
  });

  test('names: 1.0.x lower-case defaults are brought up to date; names changed in the Home app are kept', () => {
    const first = setup();
    first.laundry.doneSensor.getCharacteristic(C.ConfiguredName).updateValue('Washer done');
    first.laundry.problemSensor.getCharacteristic(C.ConfiguredName).updateValue('Laundry trouble');
    const again = setup({}, first.acc);
    assert.equal(value(again.laundry.doneSensor.getCharacteristic(C.ConfiguredName)), 'Washer Finished');
    assert.equal(value(again.laundry.problemSensor.getCharacteristic(C.ConfiguredName)), 'Laundry trouble');
  });

  test('names: the 1.0.19 defaults (Done, Problem, Tub Clean, Remote Start, Lint Filter, Vent Check) become the new ones; chosen names stay', () => {
    const old = setup({ tubCleanAfter: 30, allowControl: true });
    const name = (svc: { getCharacteristic: (c: typeof C.ConfiguredName) => Characteristic }) => svc.getCharacteristic(C.ConfiguredName);
    name(old.laundry.doneSensor).updateValue('Washer Done');
    name(old.laundry.problemSensor).updateValue('Washer Problem');
    name(old.laundry.tubCleanSensor!).updateValue('Washer tub clean');
    name(old.laundry.remoteStartSensor!).updateValue('Washer Remote Start');
    const again = setup({ tubCleanAfter: 30, allowControl: true }, old.acc);
    assert.equal(value(name(again.laundry.doneSensor)), 'Washer Finished');
    assert.equal(value(name(again.laundry.problemSensor)), 'Washer Error');
    assert.equal(value(name(again.laundry.tubCleanSensor!)), 'Washer Tub Clean Due');
    assert.equal(value(name(again.laundry.remoteStartSensor!)), 'Washer Ready To Start');
    const dryer = dryerSetup({ lintFilterAfter: 1, ventCheckPercent: 30 });
    name(dryer.laundry.lintSensor!).updateValue('Dryer Lint Filter');
    name(dryer.laundry.ventSensor!).updateValue('Clean the vent!');
    const dryerAgain = dryerSetup({ lintFilterAfter: 1, ventCheckPercent: 30 }, dryer.acc);
    assert.equal(value(name(dryerAgain.laundry.lintSensor!)), 'Dryer Clean Lint Filter');
    assert.equal(value(name(dryerAgain.laundry.ventSensor!)), 'Clean the vent!', 'a name chosen in the Home app stays');
  });

  test('a refused tap leaves the tile readable (HAP-NodeJS kept the error and the Home app showed No Response)', async () => {
    const { laundry } = setup({ allowControl: true });
    laundry.update(status({ state: 'INITIAL' }));
    const active = laundry.valve.getCharacteristic(C.Active);
    // No Remote Start: refused, as on the real washer at 10:30
    await assert.rejects(active.handleSetRequest(1));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(active.statusCode, 0, 'the error is cleared');
    assert.equal(await active.handleGetRequest(), 0, 'reads work again: off');
    // And a later update with nothing changed keeps it that way
    laundry.update(status({ state: 'INITIAL' }));
    assert.equal(await active.handleGetRequest(), 0);
  });

  test('LG error 2211 (device timeout) on START isn\'t a refusal: the washer had started; the plugin checks', async () => {
    const { laundry, lines, failSends, refreshes } = setup({ allowControl: true });
    laundry.update(status({ state: 'INITIAL', remoteControl: true, programTime: 3900 }));
    failSends(new ThinQError(400, '2211', 'Device Timeout'));
    await laundry.valve.getCharacteristic(C.Active).handleSetRequest(1);
    assert.ok(lines.some((l) => l.startsWith('info: [Washer] Sent start, but LG didn\'t confirm it') && l.includes('2211')), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('LG refused')));
    assert.ok(refreshes() > 0, 'asks LG for the state');
    // Meanwhile the tile shows it started, and another tap doesn't send it again
    assert.equal(value(laundry.valve.getCharacteristic(C.Active)), C.Active.ACTIVE);
    // An outright refusal still is one
    const other = setup({ allowControl: true });
    other.laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    other.failSends(new ThinQError(400, '2302', 'Not possible'));
    await assert.rejects(other.laundry.valve.getCharacteristic(C.Active).handleSetRequest(1));
    assert.ok(other.lines.some((l) => l.startsWith('warn: [Washer] LG refused START')));
    assert.equal(value(other.laundry.valve.getCharacteristic(C.Active)), C.Active.INACTIVE, 'refused: not shown as started');
  });

  test('a start sent from the Home app shows at once and isn\'t sent again while LG catches up (dryer: 7 s, four extra starts)', async () => {
    const { laundry, sent } = setup({ allowControl: true });
    const active = laundry.valve.getCharacteristic(C.Active);
    laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    await active.handleSetRequest(1);
    assert.equal(sent.length, 1);
    // LG hasn't reported it yet: still shown as started, and more taps send nothing
    laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    assert.equal(value(active), C.Active.ACTIVE);
    await active.handleSetRequest(1);
    await active.handleSetRequest(1);
    assert.equal(sent.length, 1, 'one start only');
    // LG reports it running: normal again; a pause is sent
    laundry.update(running({ remoteControl: true }));
    assert.equal(value(active), C.Active.ACTIVE);
    await active.handleSetRequest(0);
    assert.equal(sent.length, 2);
    assert.equal(value(active), C.Active.INACTIVE, 'shown paused at once');
    laundry.update(running({ remoteControl: true }));
    assert.equal(value(active), C.Active.INACTIVE, 'still shown paused until LG reports it');
    laundry.update(status({ state: 'PAUSE', paused: true, remoteControl: true, remaining: 1800, total: 3600 }));
    assert.equal(value(active), C.Active.INACTIVE);
  });

  test('a start LG never reports goes back to off after 30 s', async () => {
    const { laundry } = setup({ allowControl: true });
    const active = laundry.valve.getCharacteristic(C.Active);
    laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    await active.handleSetRequest(1);
    (laundry as unknown as { pending: { until: number } }).pending.until = Date.now() - 1;
    laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    assert.equal(value(active), C.Active.INACTIVE);
  });

  test('start from the Home app: a program time that jumps right after is logged (Speed Wash 15 min became Normal 65)', async () => {
    const { laundry, lines } = setup({ allowControl: true });
    laundry.update(status({ state: 'INITIAL', remoteControl: true, programTime: 15 * 60 }));
    await laundry.valve.getCharacteristic(C.Active).handleSetRequest(1);
    // As LG reported it: detecting with the dial's 15 min, then washing with Normal's 65
    laundry.update(running({ state: 'DETECTING', remaining: 900, total: 900, programTime: 900, remoteControl: true }));
    assert.ok(!lines.some((l) => l.includes('cycle time changed')));
    laundry.update(running({ state: 'RUNNING', remaining: 3900, total: 3900, programTime: 3900 }));
    assert.ok(lines.some((l) => l.startsWith('warn: [Washer] The cycle time changed from 15 min to 1 h 5 min right after the start')),
      lines.join('\n'));
    // Once only, and not for a program that kept its time
    laundry.update(running({ state: 'RUNNING', remaining: 3800, total: 3900, programTime: 3900 }));
    assert.equal(lines.filter((l) => l.includes('cycle time changed')).length, 1);
    // A start LG refuses (door open) leaves nothing behind: a hand start then isn't flagged
    const refused = setup({ allowControl: true });
    refused.laundry.update(status({ state: 'INITIAL', remoteControl: true, programTime: 900 }));
    refused.failSends(new ThinQError(400, '2302', 'Not possible'));
    await assert.rejects(refused.laundry.valve.getCharacteristic(C.Active).handleSetRequest(1));
    refused.laundry.update(running({ state: 'RUNNING', remaining: 3900, total: 3900, programTime: 3900 }));
    assert.ok(!refused.lines.some((l) => l.includes('cycle time changed')));
    // The washer's own adjustment for the load, later than the window: not a program switch
    // (seen: Normal, 65 min, became 53 min 43 s after the start)
    const adjusted = setup({ allowControl: true });
    adjusted.laundry.update(status({ state: 'INITIAL', remoteControl: true, programTime: 3900 }));
    await adjusted.laundry.valve.getCharacteristic(C.Active).handleSetRequest(1);
    adjusted.laundry.update(running({ state: 'DETECTING', remaining: 0, total: 3900, programTime: 3900, remoteControl: true }));
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      mock.timers.tick(43_000);
      adjusted.laundry.update(running({ state: 'RUNNING', remaining: 3180, total: 3180, programTime: 3180, remoteControl: true }));
    } finally {
      mock.timers.reset();
    }
    assert.ok(!adjusted.lines.some((l) => l.includes('cycle time changed')), adjusted.lines.join('\n'));
    const kept = setup({ allowControl: true });
    kept.laundry.update(status({ state: 'INITIAL', remoteControl: true, programTime: 3900 }));
    await kept.laundry.valve.getCharacteristic(C.Active).handleSetRequest(1);
    kept.laundry.update(running({ state: 'RUNNING', remaining: 3840, total: 3840, programTime: 3840 }));
    assert.ok(!kept.lines.some((l) => l.includes('cycle time changed')));
  });

  test('problem alert: cleared once the error is over (door closed, back to ready), not only by the next cycle', () => {
    const { laundry } = setup();
    const open = () => laundry.problem;
    laundry.update(status({ state: 'DETECTING', running: true }));
    laundry.update(status({ state: 'ERROR', error: true, errorName: 'DOOR_OPEN_ERROR' }));
    laundry.alert('problem', 'ERROR_DURING_WASHING');
    assert.equal(open(), true);
    // Door closed, the cycle cancelled: the washer is ready again
    laundry.update(status({ state: 'INITIAL' }));
    assert.equal(open(), false);
    // An alert that comes in while already back to ready is cleared at the next update
    laundry.alert('problem', 'ERROR_DURING_WASHING');
    laundry.update(status({ state: 'INITIAL' }));
    assert.equal(open(), false);
    // A problem alert without an error state (a dry that failed) stays until the next cycle or off
    laundry.update(status({ state: 'END', done: true }));
    laundry.alert('problem', 'DRYING_FAILED');
    laundry.update(status({ state: 'END', done: true }));
    assert.equal(open(), true);
    laundry.update(status({ state: 'POWER_OFF' }));
    assert.equal(open(), false);
  });

  test('"Sensors show as": contact sensors by default (open = on, named in notifications); occupancy by setting, replacing them (logged)', () => {
    const first = setup({ tubCleanAfter: 30 });
    for (const sub of ['done', 'problem', 'tub-clean']) {
      assert.ok(first.acc.getServiceById(S.ContactSensor, sub), `${sub}: a contact sensor by default`);
      assert.equal(first.acc.getServiceById(S.OccupancySensor, sub), undefined);
    }
    const done = first.acc.getServiceById(S.ContactSensor, 'done')!;
    first.laundry.update(status({ state: 'END', done: true, cycleCount: 31 }));
    assert.equal(value(done.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED, 'open: finished');
    assert.equal(value(first.acc.getServiceById(S.ContactSensor, 'tub-clean')!.getCharacteristic(C.ContactSensorState)),
      C.ContactSensorState.CONTACT_NOT_DETECTED, 'open: tub clean due');
    first.laundry.update(running({ cycleCount: 31 }));
    assert.equal(value(done.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED, 'closed');
    // Occupancy: each replaced, with the same name, and a note in the log
    const { acc, laundry, lines } = setup({ tubCleanAfter: 30, sensorsAsOccupancy: true }, first.acc);
    for (const sub of ['done', 'problem', 'tub-clean']) {
      assert.ok(acc.getServiceById(S.OccupancySensor, sub), `${sub}: occupancy`);
      assert.equal(acc.getServiceById(S.ContactSensor, sub), undefined, `${sub}: the contact sensor is gone`);
    }
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.ConfiguredName)), 'Washer Finished', 'same name');
    assert.ok(lines.includes('info: [Washer] "Washer Finished" is now an occupancy sensor (the setting "Sensors show as"): '
      + 'turn its notifications on again in the Home app, and check automations that used it.'));
    laundry.update(status({ state: 'ERROR', error: true, errorName: 'DOOR_OPEN_ERROR' }));
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    // A reminder turned off goes, whichever kind it was; and back to contact
    const off = setup({ sensorsAsOccupancy: true }, acc);
    assert.equal(off.acc.getServiceById(S.OccupancySensor, 'tub-clean'), undefined);
    const back = setup({}, acc);
    assert.equal(back.acc.getServiceById(S.OccupancySensor, 'done'), undefined);
    assert.ok(back.acc.getServiceById(S.ContactSensor, 'done'));
    assert.equal(back.lines.filter((l) => l.includes('is now a contact sensor')).length, 2, 'finished and error');
    // Dryer reminders too
    const dryer = dryerSetup({ lintFilterAfter: 1, ventCheckPercent: 30 });
    assert.ok(dryer.acc.getServiceById(S.ContactSensor, 'lint-filter'));
    assert.ok(dryer.acc.getServiceById(S.ContactSensor, 'vent-check'));
    const occ = dryerSetup({ lintFilterAfter: 1, ventCheckPercent: 30, sensorsAsOccupancy: true });
    assert.ok(occ.acc.getServiceById(S.OccupancySensor, 'lint-filter'));
  });

  test('remote start sensor: on while Remote Start is on, only when control is allowed', () => {
    assert.equal(unit.reportsRemoteStart, true, 'our washer reports Remote Start');
    assert.equal(setup().acc.getServiceById(S.OccupancySensor, 'remote-start'), undefined, 'no sensor without control');
    const { acc, laundry } = setup({ allowControl: true });
    const sensor = acc.getServiceById(S.OccupancySensor, 'remote-start')!;
    assert.equal(value(sensor.getCharacteristic(C.ConfiguredName)), 'Washer Ready To Start');
    const shown = () => on(sensor);
    laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    assert.equal(shown(), C.OccupancyDetected.OCCUPANCY_DETECTED, 'waiting to be started');
    // LG keeps Remote Start on during the cycle (seen): not waiting any more
    laundry.update(running({ remoteControl: true }));
    assert.equal(shown(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(status({ state: 'PAUSE', paused: true, remoteControl: true, remaining: 1800, total: 3600 }));
    assert.equal(shown(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED, 'paused: resume, not a new start');
    // A dryer turns it on by itself in wrinkle care (seen): a start would begin a new cycle
    laundry.update(status({ state: 'WRINKLE_CARE', done: true, remoteControl: true }));
    assert.equal(shown(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(status({ state: 'INITIAL', remoteControl: false }));
    assert.equal(shown(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    // A delayed start is already set to run: not waiting for one
    laundry.update(status({ state: 'RESERVED', remoteControl: true, startsIn: 3600 }));
    assert.equal(shown(), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    const off = setup({ allowControl: false }, acc);
    assert.equal(off.acc.getServiceById(S.OccupancySensor, 'remote-start'), undefined, 'removed when control is turned off');
  });

  test('cycle count: logged when LG\'s count goes up (it arrives in an update of its own, right after the end)', () => {
    const { laundry, lines } = setup();
    laundry.update(running({ cycleCount: 16 }));
    laundry.update(status({ state: 'END', done: true, cycleCount: 16 }));
    laundry.update(status({ state: 'END', done: true, cycleCount: 17 }));
    assert.ok(lines.includes('info: [Washer] LG now counts 17 cycles.'), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('LG counts 16')));
    // The power-on blip as LG sent it (17 → 0 → 17): no new count logged
    laundry.update(status({ state: 'INITIAL', cycleCount: 0 }));
    laundry.update(status({ state: 'INITIAL', cycleCount: 17 }));
    assert.equal(lines.filter((l) => l.includes('LG now counts')).length, 1);
    laundry.stop();
  });

  test('dishwasher: door and rinse-aid sensors when the machine reports them', () => {
    const dish = laundryUnits('DEVICE_DISH_WASHER', { property: {
      runState: { currentState: { type: 'enum', mode: ['r'], value: { r: ['RUNNING', 'END'] } } },
      doorStatus: { doorState: { type: 'enum', mode: ['r'], value: { r: ['OPEN', 'CLOSE'] } } },
      dishWashingStatus: { rinseRefill: { type: 'boolean', mode: ['r'] } },
    } })[0];
    const acc = Object.assign(new hap.Accessory('Dishwasher', hap.uuid.generate(String(Math.random()))), { context: {} }) as unknown as Acc;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logging;
    const laundry = new LaundryAccessory({ log, api: { hap } as unknown as API }, acc, dish,
      { name: 'Dishwasher', model: '', serial: 'S', allowControl: false, phaseSensors: [], tubCleanAfter: 30 }, () => Promise.resolve());
    laundry.update(status({ state: 'END', done: true, doorOpen: true, rinseAidLow: true }));
    assert.equal(value(acc.getServiceById(S.ContactSensor, 'door')!.getCharacteristic(C.ConfiguredName)), 'Dishwasher Door');
    assert.equal(value(acc.getServiceById(S.ContactSensor, 'door')!.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    assert.equal(on(acc.getServiceById(S.ContactSensor, 'rinse-aid')!), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(acc.getServiceById(S.ContactSensor, 'tub-clean'), undefined, 'the tub-clean reminder is for washers');
    assert.equal(value(acc.getService(S.AccessoryInformation)!.getCharacteristic(C.Model)), 'Dishwasher');
    // Our washer reports neither: no such sensors
    assert.equal(setup().acc.getServiceById(S.ContactSensor, 'door'), undefined);
  });

  test('log lines: the course while running, and a delayed start', () => {
    const { laundry, lines } = setup();
    laundry.update(status());
    laundry.update(status({ state: 'RESERVED', startsIn: 2 * 3600 + 30 * 60 }));
    laundry.update(running({ state: 'RUNNING', course: 'HEAVY_DUTY', remaining: 85 * 60 }));
    assert.ok(lines.includes('info: [Washer] Delayed start waiting, starts in 2 h 30 min.'));
    assert.ok(lines.includes('info: [Washer] Washing (heavy duty), 85 min left.'));
  });

  test('tapping the tile with control off: refused, the tile snaps back, the log says why', async () => {
    const { laundry, lines, sent } = setup();
    laundry.update(running({ remoteControl: true }));
    const result = await write(laundry.valve.getCharacteristic(C.Active), 0);
    assert.equal(result, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.deepEqual(sent, []);
    assert.ok(lines.some((l) => l.includes('control is off in the plugin settings')));
  });

  test('control on, but Remote Start not pressed: refused with a hint', async () => {
    const { laundry, lines, sent } = setup({ allowControl: true });
    laundry.update(status({ state: 'PAUSE', paused: true, remaining: 600 }));
    const result = await write(laundry.valve.getCharacteristic(C.Active), 1);
    assert.equal(result, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.deepEqual(sent, []);
    assert.ok(lines.some((l) => l.includes('press Remote Start on the machine first')));
  });

  test('control on and Remote Start pressed: off pauses (STOP), on resumes (START), then a quick re-check', async () => {
    const { laundry, sent, refreshes, lines } = setup({ allowControl: true });
    laundry.update(running({ remoteControl: true }));
    assert.equal(await write(laundry.valve.getCharacteristic(C.Active), 0), undefined);
    laundry.update(status({ state: 'PAUSE', paused: true, remaining: 600, remoteControl: true }));
    assert.equal(await write(laundry.valve.getCharacteristic(C.Active), 1), undefined);
    assert.deepEqual(sent, [
      { operation: { washerOperationMode: 'STOP' }, location: { locationName: 'MAIN' } },
      { operation: { washerOperationMode: 'START' }, location: { locationName: 'MAIN' } },
    ]);
    assert.equal(refreshes(), 2);
    assert.ok(lines.includes('info: [Washer] Sent pause.'));
    assert.ok(lines.includes('info: [Washer] Sent resume.'));
  });

  test('power switch: only when set and control is allowed; on while the machine is on', () => {
    assert.equal(setup({ allowControl: true }).laundry.powerSwitch, undefined, 'off by default');
    assert.equal(setup({ powerSwitch: true }).laundry.powerSwitch, undefined, 'not without control');
    const { laundry, acc } = setup({ allowControl: true, powerSwitch: true });
    assert.equal(acc.getServiceById(S.Switch, 'power'), laundry.powerSwitch);
    assert.equal(value(laundry.powerSwitch!.getCharacteristic(C.ConfiguredName)), 'Washer Power');
    laundry.update(status());
    assert.equal(value(laundry.powerSwitch!.getCharacteristic(C.On)), false);
    laundry.update(status({ state: 'INITIAL' }));
    assert.equal(value(laundry.powerSwitch!.getCharacteristic(C.On)), true);
    // Turned off in the settings: removed
    setup({ allowControl: true, powerSwitch: false }, acc);
    assert.equal(acc.getServiceById(S.Switch, 'power'), undefined);
  });

  test('power switch: off sends POWER_OFF when idle, finished or paused; refused during a running cycle, and for on', async () => {
    const { laundry, sent, lines } = setup({ allowControl: true, powerSwitch: true });
    const power = laundry.powerSwitch!.getCharacteristic(C.On);
    laundry.update(running());
    assert.equal(await write(power, 0), hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.ok(lines.some((l) => l.includes('Not switched off during a cycle: pause it first.')));
    assert.deepEqual(sent, []);
    laundry.update(status({ state: 'END', done: true }));
    assert.equal(await write(power, 0), undefined);
    assert.deepEqual(sent, [{ operation: { washerOperationMode: 'POWER_OFF' }, location: { locationName: 'MAIN' } }]);
    assert.ok(lines.includes('info: [Washer] Sent power off.'));
    laundry.update(status());
    assert.equal(await write(power, 1), hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.ok(lines.some((l) => l.includes("can't switch a machine on: press its power button")));
    assert.equal(sent.length, 1);
  });

  test('remote start: a tap on an idle machine with Remote Start pressed sends START', async () => {
    const { laundry, sent, lines } = setup({ allowControl: true });
    laundry.update(status({ state: 'INITIAL', remoteControl: true }));
    assert.equal(await write(laundry.valve.getCharacteristic(C.Active), 1), undefined);
    assert.deepEqual(sent, [{ operation: { washerOperationMode: 'START' }, location: { locationName: 'MAIN' } }]);
    assert.ok(lines.includes('info: [Washer] Sent start.'));
  });

  test('a tap that matches the current state sends nothing', async () => {
    const { laundry, sent } = setup({ allowControl: true });
    laundry.update(running({ remoteControl: true }));
    assert.equal(await write(laundry.valve.getCharacteristic(C.Active), 1), undefined);
    assert.deepEqual(sent, []);
  });

  test('LG refusing the command: an error in the Home app and a warning in the log', async () => {
    const { laundry, lines, failSends } = setup({ allowControl: true });
    laundry.update(running({ remoteControl: true }));
    failSends(new Error('HTTP 400 (LG error 2301: Command not supported in current state)'));
    const result = await write(laundry.valve.getCharacteristic(C.Active), 0);
    assert.equal(result, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.ok(lines.some((l) => l.startsWith('warn: [Washer] LG refused STOP: HTTP 400')));
  });
}
