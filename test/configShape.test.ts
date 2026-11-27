import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformConfig } from 'homebridge';
import { isOldShape, kindOf, migrateConfig } from '../src/configShape';
import { readSettings } from '../src/platform';

// The user's 2.x config, as the settings screen saved it (token shortened)
const flat = {
  name: 'LG ThinQ', country: 'US', allowControl: true, pollInterval: 60, runningPollInterval: 30, token: 'thinqpat_x',
  _bridge: { username: '0E:51:B8:16:66:E0', port: 58228, name: 'LG ThinQ Connect', debugModeEnabled: true },
  experimental: false, extraControls: true, liveUpdates: true, energy: true, tubCleanAfter: 30, doneHoldMinutes: 120,
  problemSensor: 'contact', lintFilterAfter: 1, ventCheckPercent: 30, lintFilterAutoClear: true,
  appliances: [{ extraControls: false, temperatureSensor: false, hideRemoteStart: false }],
  notificationSensors: 'contact', platform: 'LGThinQConnect',
};

test('3.0 shape: a 2.x config is converted into groups, keeping the child bridge and the lists', () => {
  assert.equal(isOldShape(flat), true);
  const c = migrateConfig(flat);
  assert.deepEqual(c, {
    name: 'LG ThinQ', country: 'US', token: 'thinqpat_x', platform: 'LGThinQConnect',
    _bridge: flat._bridge,
    general: { allowControl: true, liveUpdates: true, energy: true, experimental: false, extraControls: true },
    laundry: { doneHoldMinutes: 120 },
    washer: { tubCleanAfter: 30 },
    dryer: { lintFilterAfter: 1, lintFilterAutoClear: true, ventCheckPercent: 30 },
    polling: { idle: 60, running: 30 },
  });
  assert.equal(isOldShape(c), false);
  assert.ok(!('appliances' in c), 'the blank row the 2.x settings screen saved is dropped');
  assert.equal(flat.tubCleanAfter, 30, 'the config given is left as it was');
  // And reading either shape gives the same settings
  assert.deepEqual(readSettings(c as unknown as PlatformConfig), readSettings(flat as unknown as PlatformConfig));
});

test('3.0 shape: "Problem sensors show as: occupancy" from before 2.0 carries over; a group already set wins', () => {
  assert.deepEqual(migrateConfig({ problemSensor: 'occupancy' }), { general: { sensorType: 'occupancy' } });
  assert.deepEqual(migrateConfig({ problemSensor: 'occupancy', sensorType: 'contact' }), { general: { sensorType: 'contact' } });
  assert.deepEqual(migrateConfig({ tubCleanAfter: 5, washer: { tubCleanAfter: 30 } }), { washer: { tubCleanAfter: 30 } });
  assert.deepEqual(migrateConfig({ general: { energy: false } }), { general: { energy: false } }, 'already 3.0: unchanged');
});

test('3.0 shape: each LG device type has a kind for its options', () => {
  assert.equal(kindOf('DEVICE_WASHER'), 'washer');
  assert.equal(kindOf('DEVICE_WASHCOMBO_MAIN'), 'washer');
  assert.equal(kindOf('DEVICE_DRYER'), 'dryer');
  assert.equal(kindOf('DEVICE_WASHTOWER'), 'washtower');
  assert.equal(kindOf('DEVICE_AIR_CONDITIONER'), 'air_conditioner');
  assert.equal(kindOf('DEVICE_REFRIGERATOR'), 'other');
});

test('settings: per-appliance options read in the 3.0 shape, "None" (unset) leaving the general value', () => {
  const s = readSettings({
    platform: 'LGThinQConnect', general: { sensorType: 'contact' }, dryer: { ventCheckPercent: 30 },
    appliances: [
      { name: ' Dryer ', type: 'dryer', ventCheckPercent: 25, lintFilterAfter: '3', phaseSensors: ['COOLING', ''], sensorType: 'occupancy', lintFilterAutoClear: true },
      { name: 'Washer', type: 'washer', tubCleanAfter: 999, doneHoldMinutes: '', hideRemoteStart: true },
      { name: 'Living Room AC', type: 'air_conditioner', acModes: 'cool', sensorType: 'sideways' },
    ],
  } as unknown as PlatformConfig);
  assert.equal(s.ventCheckPercent, 30);
  assert.deepEqual(s.appliances.get('dryer'), {
    type: 'dryer', ventCheckPercent: 25, lintFilterAfter: 3, phaseSensors: ['COOLING'], sensorType: 'occupancy', lintFilterAutoClear: true,
  });
  assert.deepEqual(s.appliances.get('washer'), { type: 'washer', tubCleanAfter: 200, hideRemoteStart: true }, 'limits, and an empty number is unset');
  assert.deepEqual(s.appliances.get('living room ac'), { type: 'air_conditioner', acModes: 'cool' }, 'an unknown value is left out');
});

test('3.0 shape: named rows under appliances are kept as they are, blank ones dropped', () => {
  const rows = [{ name: 'Dryer', lintFilterAfter: 5 }, { hideRemoteStart: false }, { name: '  ' }];
  const c = migrateConfig({ platform: 'LGThinQConnect', appliances: rows });
  assert.deepEqual(c.appliances, [{ name: 'Dryer', lintFilterAfter: 5 }]);
  assert.equal(isOldShape({ appliances: [{ name: 'Dryer' }] }), false);
  assert.equal(isOldShape({ appliances: [{ name: 'Dryer' }, {}] }), true);
});
