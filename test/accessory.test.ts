import test from 'node:test';
import assert from 'node:assert/strict';
import type { API, Characteristic, Logging, PlatformAccessory } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { LaundryAccessory, type LaundryContext, type LaundryOptions } from '../src/accessory';
import { type LaundryStatus, laundryUnits } from '../src/laundry';
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
    remaining: 0, total: 0, remoteControl: false, ...over,
  });
  const running = (over: Partial<LaundryStatus> = {}) => status({ state: 'RUNNING', running: true, remaining: 1800, total: 3600, ...over });

  function setup(options: Partial<LaundryOptions> = {}, accessory?: Acc) {
    const lines: string[] = [];
    const sent: Record<string, unknown>[] = [];
    let refreshes = 0;
    let sendResult: () => Promise<unknown> = () => Promise.resolve({});
    const acc = accessory || Object.assign(new hap.Accessory('Washer', hap.uuid.generate(String(Math.random()))), { context: {} }) as unknown as Acc;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const api = { hap } as unknown as API;
    const laundry = new LaundryAccessory({ log, api }, acc, unit,
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
    assert.equal(value(laundry.doneSensor.getCharacteristic(C.ConfiguredName)), 'Washer done');
    assert.equal(value(laundry.problemSensor.getCharacteristic(C.ConfiguredName)), 'Washer problem');
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
    assert.equal(value(spin.getCharacteristic(C.ConfiguredName)), 'Washer spinning');
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
    assert.equal(value(sensor.getCharacteristic(C.ConfiguredName)), 'Washer tub clean');
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
