import test from 'node:test';
import assert from 'node:assert/strict';
import { alertFor, alertKind, isLaundry, laundryStatus, laundryUnits, mergeState, operationPayload, stateLabel } from '../src/laundry.js';
import { realDevices } from './fake-lg.js';

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

test('error name: as LG sent it on a real washer (a plain "error" next to runState), and the other shapes', () => {
  const u = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const at = (extra: Record<string, unknown>) => laundryStatus(u, [{ runState: { currentState: 'ERROR' }, location: { locationName: 'MAIN' }, ...extra }]);
  assert.equal(at({ error: 'DOOR_OPEN_ERROR' }).errorName, 'DOOR_OPEN_ERROR');
  assert.equal(at({ error: { errorCode: 'OUT_OF_BALANCE_ERROR' } }).errorName, 'OUT_OF_BALANCE_ERROR');
  assert.equal(at({ errorCode: 'WATER_DRAIN_ERROR' }).errorName, 'WATER_DRAIN_ERROR');
  assert.equal(at({}).errorName, '');
});

test('our machines as captured (both off): idle, no time left, even though the dryer says 1 min', () => {
  const w = laundryStatus(laundryUnits('DEVICE_WASHER', washer.profile)[0], washer.state);
  assert.deepEqual(w, {
    state: 'POWER_OFF', running: false, paused: false, done: false, error: false, errorName: '',
    remaining: 0, total: 0, programTime: 0, remoteControl: false, cycleCount: 15, doorOpen: undefined, rinseAidLow: undefined,
    course: undefined, startsIn: undefined, endsIn: undefined,
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
  for (const st of ['RUNNING', 'RINSING', 'SPINNING', 'DETECTING', 'PREWASH', 'DRYING', 'REFRESHING', 'ADD_DRAIN', 'COOLING', 'SOME_NEW_PHASE']) {
    assert.deepEqual(is(st), [true, false, false, false], st);
  }
  for (const st of ['PAUSE', 'RINSE_HOLD']) { assert.deepEqual(is(st), [false, true, false, false], st); }
  for (const st of ['END', 'WRINKLE_CARE']) { assert.deepEqual(is(st), [false, false, true, false], st); }
  assert.deepEqual(is('ERROR'), [false, false, false, true]);
  // Freeze protection runs on its own: not a cycle
  for (const st of ['POWER_OFF', 'INITIAL', 'RESERVED', 'FROZEN_PREVENT_INITIAL', 'FROZEN_PREVENT_RUNNING', 'FROZEN_PREVENT_PAUSE']) { assert.deepEqual(is(st), [false, false, false, false], st); }
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
  assert.equal(stateLabel('PAUSE'), 'Paused');
  assert.equal(stateLabel('INITIAL'), 'Ready');
  assert.equal(stateLabel('DETECTING'), 'Detecting load');
  assert.equal(stateLabel('END'), 'Finished');
  assert.equal(stateLabel('RUNNING'), 'Washing');
  assert.equal(stateLabel('RUNNING', 'dryer'), 'Drying');
});

test('merging live updates: only what changed, washer drums matched by location', () => {
  const unit = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const base = washerState('RINSING', [0, 30], [1, 0], { remoteControlEnable: { remoteControlEnabled: true } });
  const merged = mergeState(base, [{ runState: { currentState: 'SPINNING' }, timer: { remainMinute: 12 }, location: { locationName: 'MAIN' } }]);
  const s = laundryStatus(unit, merged);
  assert.equal(s.state, 'SPINNING');
  assert.equal(s.remaining, 12 * 60);
  assert.equal(s.total, 3600, 'total kept from before');
  assert.equal(s.remoteControl, true, 'untouched fields kept');
  assert.equal((base[0].runState as { currentState: string }).currentState, 'RINSING', 'the old state is not changed in place');
  // An update as a single object, without a list
  assert.equal(laundryStatus(unit, mergeState(base, { runState: { currentState: 'END' } })).state, 'END');
  // A dryer (one object) and a first update with no earlier state
  const dryerUnit = laundryUnits('DEVICE_DRYER', dryer.profile)[0];
  assert.equal(laundryStatus(dryerUnit, mergeState(dryer.state, { runState: { currentState: 'COOLING' } })).state, 'COOLING');
  assert.equal(laundryStatus(dryerUnit, mergeState(undefined, { runState: { currentState: 'RUNNING' } })).state, 'RUNNING');
  assert.equal(mergeState(base, undefined), base);
});

test('merging live updates: two drums, only one changes', () => {
  const state = [
    { runState: { currentState: 'RUNNING' }, location: { locationName: 'MAIN' } },
    { runState: { currentState: 'END' }, location: { locationName: 'MINI' } },
  ];
  const merged = mergeState(state, [{ runState: { currentState: 'PAUSE' }, location: { locationName: 'MINI' } }]) as typeof state;
  assert.deepEqual(merged.map((d) => d.runState.currentState), ['RUNNING', 'PAUSE']);
});

test('LG alerts: finished or problem, and which machine', () => {
  assert.equal(alertKind('WASHING_IS_COMPLETE'), 'finished');
  assert.equal(alertKind('DRYING_IS_COMPLETE'), 'finished');
  assert.equal(alertKind('DRYING_FAILED'), 'problem');
  assert.equal(alertKind('ERROR_DURING_WASHING'), 'problem');
  assert.equal(alertKind('SOMETHING_NEW'), 'other');
  // Codes Home Assistant lists for other appliances: a leak, a humidifier out of water
  assert.equal(alertKind('WATER_LEAK_HAS_OCCURRED'), 'problem');
  assert.equal(alertKind('LACK_OF_WATER'), 'problem');
  assert.equal(alertKind('WATER_IS_FULL'), 'problem');
  assert.equal(alertKind('TIME_TO_CHANGE_FILTER'), 'other');
  assert.equal(alertKind('PREHEATING_IS_COMPLETE'), 'other');
  assert.equal(alertFor('WASHING_IS_COMPLETE'), 'washer');
  assert.equal(alertFor('ERROR_DURING_WASHING'), 'washer');
  assert.equal(alertFor('DRYING_FAILED'), 'dryer');
  assert.equal(alertFor('SOMETHING_NEW'), undefined);
});

test('dishwasher: a cycle appliance with its own command field, door and rinse aid', () => {
  const profile = { property: {
    runState: { currentState: { type: 'enum', mode: ['r'], value: { r: ['POWER_OFF', 'RUNNING', 'RINSING', 'DRYING', 'END', 'PAUSE'] } } },
    operation: { dishWasherOperationMode: { type: 'enum', mode: ['w'], value: { w: ['START', 'STOP', 'POWER_OFF'] } } },
    doorStatus: { doorState: { type: 'enum', mode: ['r'], value: { r: ['OPEN', 'CLOSE'] } } },
    dishWashingStatus: { rinseRefill: { type: 'boolean', mode: ['r'] } },
    timer: { remainHour: { type: 'number', mode: ['r'] }, remainMinute: { type: 'number', mode: ['r'] } },
  } };
  const [unit] = laundryUnits('DEVICE_DISH_WASHER', profile);
  assert.equal(unit.kind, 'dishwasher');
  assert.equal(unit.opKey, 'dishWasherOperationMode');
  assert.ok(unit.hasDoor && unit.hasRinseAid);
  const s = laundryStatus(unit, { runState: { currentState: 'DRYING' }, doorStatus: { doorState: 'CLOSE' },
    dishWashingStatus: { rinseRefill: true }, timer: { remainHour: 0, remainMinute: 20 } });
  assert.equal(s.running, true);
  assert.equal(s.remaining, 1200);
  assert.equal(s.doorOpen, false);
  assert.equal(s.rinseAidLow, true);
  assert.deepEqual(operationPayload(unit, 'START'), { operation: { dishWasherOperationMode: 'START' } });
  assert.equal(stateLabel('RUNNING', 'dishwasher'), 'Washing');
  assert.equal(stateLabel('RUNNING', 'styler'), 'Refreshing');
  assert.equal(stateLabel('RUNNING', 'oven'), 'Cooking');
  // A Styler whose profile names its command field differently still finds the one with START
  const [styler] = laundryUnits('DEVICE_STYLER', { property: { operation: { anyName: { type: 'enum', mode: ['w'], value: { w: ['START', 'STOP'] } } } } });
  assert.equal(styler.opKey, 'anyName');
});

test('dishwasher: the course while running, and how long until a delayed start', () => {
  const [unit] = laundryUnits('DEVICE_DISH_WASHER', { property: { runState: { currentState: { type: 'enum', mode: ['r'], value: { r: ['RUNNING', 'RESERVED'] } } } } });
  const running = laundryStatus(unit, { runState: { currentState: 'RUNNING' }, dishWashingCourse: { currentDishWashingCourse: 'ECO' },
    timer: { remainHour: 1, remainMinute: 10, remainSecond: 30 } });
  assert.equal(running.course, 'ECO');
  assert.equal(running.remaining, 4230, 'seconds count too');
  const waiting = laundryStatus(unit, { runState: { currentState: 'RESERVED' }, timer: { relativeHourToStart: 3, relativeMinuteToStart: 15 } });
  assert.equal(waiting.startsIn, 3 * 3600 + 15 * 60);
  assert.equal(laundryStatus(unit, { runState: { currentState: 'RESERVED' } }).startsIn, undefined);
  // Delay set by when it should finish (Home Assistant's "delayed end")
  const byEnd = laundryStatus(unit, { runState: { currentState: 'RESERVED' }, timer: { relativeHourToStop: 6, relativeMinuteToStop: 0 } });
  assert.equal(byEnd.endsIn, 6 * 3600);
  assert.equal(byEnd.startsIn, undefined);
});

test('an oven reaching its temperature is not a finish', () => {
  assert.equal(alertKind('PREHEATING_IS_COMPLETE'), 'other');
  assert.equal(alertKind('COOKING_IS_COMPLETE'), 'finished');
});

test('below an hour, LG leaves remainHour out of live updates: minutes alone mean less than an hour', () => {
  const unit = laundryUnits('DEVICE_WASHER', washer.profile)[0];
  const base = washerState('RINSING', [1, 2], [1, 30]);
  // 1:02 left, then an update with only the minutes (59): 0:59, not 1:59
  const merged = mergeState(base, [{ timer: { remainMinute: 59 }, location: { locationName: 'MAIN' } }]);
  assert.equal(laundryStatus(unit, merged).remaining, 59 * 60);
  // Minutes alone that didn't wrap round: the hour hasn't changed (1:30 → 1:29, not 0:29)
  const long = washerState('RINSING', [1, 30], [2, 0]);
  assert.equal(laundryStatus(unit, mergeState(long, [{ timer: { remainMinute: 29 }, location: { locationName: 'MAIN' } }])).remaining, 89 * 60);
  // 2:01 → 1:58 wraps round: one hour less
  assert.equal(laundryStatus(unit, mergeState(washerState('RINSING', [2, 1], [3, 0]), [{ timer: { remainMinute: 58 }, location: { locationName: 'MAIN' } }])).remaining, 118 * 60);
  // An update with both is taken as is; one without a timer leaves it alone
  assert.equal(laundryStatus(unit, mergeState(base, [{ timer: { remainHour: 1, remainMinute: 1 }, location: { locationName: 'MAIN' } }])).remaining, 3660);
  assert.equal(laundryStatus(unit, mergeState(base, [{ runState: { currentState: 'SPINNING' }, location: { locationName: 'MAIN' } }])).remaining, 3720);
  // A WashTower part, and an object-shaped state
  assert.deepEqual(mergeState({ dryer: { timer: { remainHour: 1, remainMinute: 5 } } }, { dryer: { timer: { remainMinute: 58 } } }),
    { dryer: { timer: { remainHour: 0, remainMinute: 58 } } });
});
