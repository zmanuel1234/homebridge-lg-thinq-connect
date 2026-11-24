import test from 'node:test';
import { ThinQError } from '../src/api';
import assert from 'node:assert/strict';
import type { API, Characteristic, Logging, PlatformAccessory } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { LaundryAccessory, type LaundryContext, type LaundryOptions } from '../src/accessory';
import { type LaundryStatus, laundryStatus, laundryUnits } from '../src/laundry';
import { realDevices } from './fake-lg';

type Hap = typeof HapNodejs;

// These tests use Homebridge's HAP library, an ES module whose current release targets newer
// Node versions. If it can't be loaded, only these tests are skipped (with the reason).
let hap: Hap | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.ConfiguredName)), 'Washer Done');
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ConfiguredName)), 'Washer Problem');
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
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
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
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(value(laundry.valve.getCharacteristic(C.Active)), C.Active.INACTIVE);
    assert.ok(lines.includes('info: [Washer] Finished.'));
    // Powering off or starting again clears it
    laundry.update(status());
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('a finish missed between two checks (straight to off near the end) still triggers done, briefly', () => {
    const { laundry } = setup();
    laundry.update(running({ remaining: 60 }));
    laundry.update(status());
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(running());
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
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
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(running({ state: 'RUNNING', remaining: 0, total: 0 }));
    laundry.update(status());
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('a cycle cancelled with plenty of time left is not a finish', () => {
    const { laundry } = setup();
    laundry.update(running({ remaining: 40 * 60 }));
    laundry.update(status());
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
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
    assert.equal(value(spin.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(running({ state: 'RINSING' }));
    assert.equal(value(spin.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
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
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.ok(lines.includes('info: [Washer] LG says the cycle is finished.'));
    laundry.update(status({ state: 'END', done: true }));
    laundry.update(status());
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('LG\'s "finished" alert while weighing the load is ignored; with lots of time shown, the next state decides', () => {
    const { laundry, lines } = setup();
    const done = () => value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected));
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
    assert.equal(value(dryer.laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.ok(dryer.lines.includes('info: [Washer] LG says the cycle is finished.'));
    // …or straight to off
    const off = setup();
    off.laundry.update(running({ remaining: 20 * 60 }));
    off.laundry.alert('finished', 'DRYING_IS_COMPLETE');
    off.laundry.update(status());
    assert.equal(value(off.laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    off.laundry.stop();
  });

  test('LG\'s "finished" alert when the machine is already off: a brief done', () => {
    const { laundry } = setup();
    laundry.update(status());
    laundry.alert('finished', 'DRYING_IS_COMPLETE');
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
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
    const sensor = acc.getServiceById(S.OccupancySensor, 'tub-clean')!;
    assert.equal(value(sensor.getCharacteristic(C.ConfiguredName)), 'Washer Tub Clean');
    laundry.update(status({ cycleCount: 29 }));
    assert.equal(value(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    laundry.update(status({ cycleCount: 30 }));
    laundry.update(status({ cycleCount: 31 }));
    assert.equal(value(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(lines.filter((l) => l.includes('Time for a Tub Clean')).length, 1);
    assert.ok(lines.includes('info: [Washer] Time for a Tub Clean: LG counts 30 cycles (reminder set at 30).'));
    // After a Tub Clean, LG's count starts again
    laundry.update(status({ cycleCount: 0 }));
    assert.equal(value(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  test('tub-clean reminder: none when off, for a dryer, or for a washer that doesn\'t count; removed when turned off', () => {
    assert.equal(setup().acc.getServiceById(S.OccupancySensor, 'tub-clean'), undefined, 'off by default');
    const [, dryerDevice] = realDevices();
    const dryerUnit = laundryUnits('DEVICE_DRYER', dryerDevice.profile)[0];
    assert.equal(dryerUnit.countsCycles, false);
    assert.equal(unit.countsCycles, true, 'our washer counts its cycles');
    const on = setup({ tubCleanAfter: 30 });
    const off = setup({ tubCleanAfter: 0 }, on.acc);
    assert.equal(off.acc.getServiceById(S.OccupancySensor, 'tub-clean'), undefined);
  });

  test('names: 1.0.x lower-case defaults are brought up to date; names changed in the Home app are kept', () => {
    const first = setup();
    first.laundry.doneSensor.getCharacteristic(C.ConfiguredName).updateValue('Washer done');
    first.laundry.problemSensor.getCharacteristic(C.ConfiguredName).updateValue('Laundry trouble');
    const again = setup({}, first.acc);
    assert.equal(value(again.laundry.doneSensor.getCharacteristic(C.ConfiguredName)), 'Washer Done');
    assert.equal(value(again.laundry.problemSensor.getCharacteristic(C.ConfiguredName)), 'Laundry trouble');
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
    // An outright refusal still is one
    failSends(new ThinQError(400, '2302', 'Not possible'));
    await assert.rejects(laundry.valve.getCharacteristic(C.Active).handleSetRequest(1));
    assert.ok(lines.some((l) => l.startsWith('warn: [Washer] LG refused START')));
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
    const kept = setup({ allowControl: true });
    kept.laundry.update(status({ state: 'INITIAL', remoteControl: true, programTime: 3900 }));
    await kept.laundry.valve.getCharacteristic(C.Active).handleSetRequest(1);
    kept.laundry.update(running({ state: 'RUNNING', remaining: 3840, total: 3840, programTime: 3840 }));
    assert.ok(!kept.lines.some((l) => l.includes('cycle time changed')));
  });

  test('remote start sensor: on while Remote Start is on, only when control is allowed', () => {
    assert.equal(unit.reportsRemoteStart, true, 'our washer reports Remote Start');
    assert.equal(setup().acc.getServiceById(S.OccupancySensor, 'remote-start'), undefined, 'no sensor without control');
    const { acc, laundry } = setup({ allowControl: true });
    const sensor = acc.getServiceById(S.OccupancySensor, 'remote-start')!;
    assert.equal(value(sensor.getCharacteristic(C.ConfiguredName)), 'Washer Remote Start');
    laundry.update(status({ remoteControl: true }));
    assert.equal(value(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    laundry.update(running({ remoteControl: false }));
    assert.equal(value(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    const off = setup({ allowControl: false }, acc);
    assert.equal(off.acc.getServiceById(S.OccupancySensor, 'remote-start'), undefined, 'removed when control is turned off');
  });

  test('cycle count: logged when a cycle finishes, for machines that count', () => {
    const { laundry, lines } = setup();
    laundry.update(running({ cycleCount: 41 }));
    laundry.update(status({ state: 'END', done: true, cycleCount: 42 }));
    assert.ok(lines.some((l) => l.startsWith('info: [Washer]') && l.includes('(LG counts 42 cycles)')), lines.join('\n'));
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
    assert.equal(value(acc.getServiceById(S.OccupancySensor, 'rinse-aid')!.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
    assert.equal(acc.getServiceById(S.OccupancySensor, 'tub-clean'), undefined, 'the tub-clean reminder is for washers');
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
