import test from 'node:test';
import assert from 'node:assert/strict';
import { isLaundry, laundryStatus, laundryUnits, operationPayload, stateLabel } from '../src/laundry';
import { realDevices } from './fake-lg';

const [washer, dryer] = realDevices();

/** A washer state in LG's list shape, with the given run state and time. */
const washerState = (state: string, remain = [0, 0], total = [0, 0], extra: Record<string, unknown> = {}) => [{
  runState: { currentState: state },
  remoteControlEnable: { remoteControlEnabled: false },
  timer: { remainHour: remain[0], remainMinute: remain[1], totalHour: total[0], totalMinute: total[1] },
  location: { locationName: 'MAIN' },
  ...extra,
}];

test('laundry types', () => {
  for (const t of ['DEVICE_WASHER', 'DEVICE_DRYER', 'DEVICE_WASHTOWER', 'DEVICE_WASHTOWER_WASHER', 'DEVICE_WASHCOMBO_MINI']) {
    assert.ok(isLaundry(t), t);
  }
  assert.ok(!isLaundry('DEVICE_REFRIGERATOR'));
});

test('our washer: one unit at MAIN, with its states and commands', () => {
  const [unit, ...more] = laundryUnits('DEVICE_WASHER', washer.profile);
  assert.equal(more.length, 0);
  assert.equal(unit.kind, 'washer');
  assert.equal(unit.location, 'MAIN');
  assert.ok(unit.usesLocation);
  assert.deepEqual(unit.operations, ['START', 'STOP', 'POWER_OFF']);
  for (const s of ['SPINNING', 'RINSING', 'DETECTING', 'END', 'POWER_OFF', 'RINSE_HOLD']) { assert.ok(unit.states.includes(s), s); }
});

test('our dryer: one unit, no location', () => {
  const [unit, ...more] = laundryUnits('DEVICE_DRYER', dryer.profile);
  assert.equal(more.length, 0);
  assert.equal(unit.kind, 'dryer');
  assert.equal(unit.location, '');
  assert.ok(!unit.usesLocation);
  assert.deepEqual(unit.operations, ['START', 'STOP', 'POWER_OFF']);
  assert.ok(unit.states.includes('WRINKLE_CARE'));
});

test('our machines as captured (both off): idle, no time left, even though the dryer says 1 min', () => {
  const w = laundryStatus(laundryUnits('DEVICE_WASHER', washer.profile)[0], washer.state);
  assert.deepEqual(w, {
    state: 'POWER_OFF', running: false, paused: false, done: false, error: false, errorName: '',
    remaining: 0, total: 0, remoteControl: false, cycleCount: 15,
  });
  const d = laundryStatus(laundryUnits('DEVICE_DRYER', dryer.profile)[0], dryer.state);
  assert.equal(d.state, 'POWER_OFF');
  assert.equal(d.remaining, 0);
  assert.equal(d.cycleCount, undefined);
});

test('a running cycle: time left and total in seconds', () => {
  const unit = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const s = laundryStatus(unit, washerState('SPINNING', [0, 12], [1, 5], { remoteControlEnable: { remoteControlEnabled: true } }));
  assert.equal(s.running, true);
  assert.equal(s.paused, false);
  assert.equal(s.remaining, 12 * 60);
  assert.equal(s.total, 65 * 60);
  assert.equal(s.remoteControl, true);
});

test('which states count as running, paused, done and error', () => {
  const unit = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const is = (state: string) => {
    const s = laundryStatus(unit, washerState(state, [0, 30], [1, 0]));
    return [s.running, s.paused, s.done, s.error];
  };
  for (const st of ['RUNNING', 'RINSING', 'SPINNING', 'DETECTING', 'PREWASH', 'DRYING', 'REFRESHING', 'ADD_DRAIN', 'FROZEN_PREVENT_RUNNING', 'COOLING', 'SOME_NEW_PHASE']) {
    assert.deepEqual(is(st), [true, false, false, false], st);
  }
  for (const st of ['PAUSE', 'RINSE_HOLD', 'FROZEN_PREVENT_PAUSE']) { assert.deepEqual(is(st), [false, true, false, false], st); }
  for (const st of ['END', 'WRINKLE_CARE']) { assert.deepEqual(is(st), [false, false, true, false], st); }
  assert.deepEqual(is('ERROR'), [false, false, false, true]);
  for (const st of ['POWER_OFF', 'INITIAL', 'RESERVED', 'FROZEN_PREVENT_INITIAL']) { assert.deepEqual(is(st), [false, false, false, false], st); }
  // A paused cycle keeps its time; a finished one has none
  assert.equal(laundryStatus(unit, washerState('PAUSE', [0, 20], [1, 0])).remaining, 1200);
  assert.equal(laundryStatus(unit, washerState('END', [0, 1], [1, 0])).remaining, 0);
});

test('an error with a name, a missing or odd state', () => {
  const unit = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const s = laundryStatus(unit, washerState('ERROR', [0, 0], [0, 0], { error: { errorCode: 'DOOR_OPEN_ERROR' } }));
  assert.equal(s.error, true);
  assert.equal(s.errorName, 'DOOR_OPEN_ERROR');
  assert.equal(laundryStatus(unit, undefined).state, 'UNKNOWN');
  assert.equal(laundryStatus(unit, [{ runState: {} }]).running, false);
  assert.equal(laundryStatus(unit, 'nonsense').state, 'UNKNOWN');
  assert.equal(laundryStatus(unit, washerState('RUNNING', [-1, Number.NaN], [0, 0])).remaining, 0);
});

test('commands: the washer\'s include its location, the dryer\'s don\'t', () => {
  const w = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const d = laundryUnits('DEVICE_DRYER', dryer.profile)[0];
  assert.deepEqual(operationPayload(w, 'START'), { operation: { washerOperationMode: 'START' }, location: { locationName: 'MAIN' } });
  assert.deepEqual(operationPayload(d, 'STOP'), { operation: { dryerOperationMode: 'STOP' } });
});

test('a two-drum wash combo: one unit per drum, each with its own state', () => {
  const drum = (loc: string) => ({ ...(washer.profile as { property: Record<string, unknown>[] }).property[0], location: { locationName: loc } });
  const profile = { property: [drum('MAIN'), drum('MINI')] };
  const units = laundryUnits('DEVICE_WASHCOMBO_MAIN', profile);
  assert.deepEqual(units.map((u) => u.location), ['MAIN', 'MINI']);
  const state = [
    { runState: { currentState: 'RUNNING' }, timer: { remainHour: 0, remainMinute: 40 }, location: { locationName: 'MAIN' } },
    { runState: { currentState: 'END' }, location: { locationName: 'MINI' } },
  ];
  assert.equal(laundryStatus(units[0], state).remaining, 2400);
  assert.equal(laundryStatus(units[1], state).done, true);
  assert.deepEqual(operationPayload(units[1], 'START'), { operation: { washerOperationMode: 'START' }, location: { locationName: 'MINI' } });
});

test('a WashTower as one device: a washer and a dryer, commands wrapped', () => {
  const profile = { washer: washer.profile, dryer: dryer.profile };
  const units = laundryUnits('DEVICE_WASHTOWER', profile);
  assert.deepEqual(units.map((u) => [u.kind, u.location, u.towerKey]), [['washer', 'WASHER', 'washer'], ['dryer', 'DRYER', 'dryer']]);
  const state = { washer: washerState('RINSING', [0, 25], [1, 0]), dryer: { runState: { currentState: 'COOLING' } } };
  assert.equal(laundryStatus(units[0], state).state, 'RINSING');
  assert.equal(laundryStatus(units[0], state).remaining, 1500);
  assert.equal(laundryStatus(units[1], state).state, 'COOLING');
  assert.deepEqual(operationPayload(units[1], 'START'), { dryer: { operation: { dryerOperationMode: 'START' } } });
});

test('nothing understandable: no units', () => {
  assert.deepEqual(laundryUnits('DEVICE_REFRIGERATOR', washer.profile), []);
  assert.equal(laundryUnits('DEVICE_DRYER', undefined).length, 1, 'still one unit; its states are unknown');
  assert.deepEqual(laundryUnits('DEVICE_WASHTOWER', {}), []);
});

test('state labels', () => {
  assert.equal(stateLabel('SPINNING'), 'Spinning');
  assert.equal(stateLabel('WRINKLE_CARE'), 'Wrinkle care');
  assert.equal(stateLabel('MAIN'), 'Main');
  assert.equal(stateLabel(''), '');
});
