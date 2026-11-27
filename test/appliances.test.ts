// The experimental appliance types on Homebridge's HAP library: what each shows in the Home app,
// and the commands each sends. Air conditioners, the air purifier, dehumidifier and range hood use
// Home Assistant's sample data (test/fixtures/ha); the rest are built from LG's documented
// property names.
import { ThinQError } from '../src/api';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { API, Characteristic, Logging, PlatformAccessory } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { type ApplianceContext, categoryOf, mappingFor } from '../src/appliances';
import type { LaundryContext } from '../src/accessory';
import { filterPercent } from '../src/appliances/sensors';
import { levelFor, levelPercent, speedLevels, temperatureC } from '../src/appliances/profile';

type Hap = typeof HapNodejs;
let hap: Hap | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

const fixture = (name: string, file: 'profile' | 'status' | 'device'): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ha', name, `${file}.json`), 'utf8')) as unknown;

/** An enum field description as LG writes one. */
const en = (values: string[], mode: string[] = ['r', 'w']) => ({ type: 'enum', mode, value: Object.fromEntries(mode.map((m) => [m, values])) });
const range = (min: number, max: number, step = 1, mode: string[] = ['r', 'w']) =>
  ({ type: 'range', mode, value: Object.fromEntries(mode.map((m) => [m, { min, max, step }])) });

test('fan speeds: AUTO at the top of the slider, as the AC plugin does; other modes left out', () => {
  const desc = (w: string[]) => ({ type: 'enum', mode: ['r', 'w'], value: { r: w, w } });
  const levels = speedLevels(desc(['LOW', 'MID', 'HIGH', 'AUTO']));
  assert.deepEqual(levels, ['LOW', 'MID', 'HIGH', 'AUTO']);
  assert.deepEqual(levels.map((l) => levelPercent(levels, l)), [25, 50, 75, 100]);
  assert.equal(levelFor(levels, 100), 'AUTO');
  assert.equal(levelFor(levels, 75), 'HIGH');
  assert.deepEqual(speedLevels(desc(['SLOW', 'LOW', 'MID', 'HIGH', 'NATURE', 'POWER', 'AUTO'])), ['SLOW', 'LOW', 'MID', 'HIGH', 'AUTO']);
  assert.deepEqual(speedLevels(desc(['LOW', 'HIGH'])), ['LOW', 'HIGH'], 'no AUTO offered: none added');
});

test('helpers: levels, temperatures in either unit, filter life', () => {
  assert.equal(levelPercent(['LOW', 'MID', 'HIGH'], 'MID'), 67);
  assert.equal(levelPercent(['LOW', 'MID', 'HIGH'], 'AUTO'), 0);
  assert.equal(levelFor(['LOW', 'MID', 'HIGH'], 34), 'MID');
  assert.equal(levelFor(['LOW', 'MID', 'HIGH'], 1), 'LOW');
  assert.equal(levelFor(['LOW', 'MID', 'HIGH'], 100), 'HIGH');
  assert.equal(temperatureC({ currentTemperature: 77, unit: 'F' }, 'currentTemperature'), 25);
  assert.equal(temperatureC([{ currentTemperature: 77, unit: 'F' }, { currentTemperature: 25, unit: 'C' }], 'currentTemperature'), 25);
  assert.equal(temperatureC([{ currentTemperature: 68, unit: 'F' }], 'currentTemperature'), 20);
  assert.equal(filterPercent({ filterInfo: { filterLifetime: 540, usedTime: 180 } }), 67);
  assert.equal(filterPercent({ filterInfo: { filterRemainPercent: 8 } }), 8);
  assert.equal(filterPercent({}), undefined);
});

test('mappings: each type gets its own; microwaves with a fan get the hood; nothing to show is undefined', () => {
  assert.equal(mappingFor('DEVICE_AIR_CONDITIONER', {})?.label, 'air conditioner');
  assert.equal(mappingFor('DEVICE_SYSTEM_BOILER', {})?.label, 'heat pump');
  assert.equal(mappingFor('DEVICE_MICROWAVE_OVEN', { property: { lamp: { lampBrightness: range(0, 2) } } })?.label, 'microwave');
  assert.equal(mappingFor('DEVICE_MICROWAVE_OVEN', {}), undefined);
  assert.equal(mappingFor('DEVICE_PLANT_CULTIVATOR', { property: { operation: { operationMode: en(['POWER_ON', 'POWER_OFF']) } } })?.label, 'appliance (basic)');
  assert.equal(mappingFor('DEVICE_KIMCHI_REFRIGERATOR', fixture('kimchi_refrigerator', 'profile')), undefined);
  assert.equal(categoryOf(mappingFor('DEVICE_AIR_CONDITIONER', {})!), 21);
});

if (!hap) {
  test('appliance tests', { skip: `HAP library doesn't load on Node ${process.version}: ${loadError}` }, () => {});
} else {
  defineTests(hap);
}

function defineTests(hap: Hap): void {
  const { Service: S, Characteristic: C } = hap;

  function make(deviceType: string, profile: unknown, alias = 'Thing', extraControls = true, options?: ApplianceContext['options'], problemAsOccupancy = false) {
    const lines: string[] = [];
    const sent: Record<string, unknown>[] = [];
    let refreshes = 0;
    let fail: Error | undefined;
    const accessory = Object.assign(new hap.Accessory(alias, hap.uuid.generate(String(Math.random()))), { context: {} }) as unknown as PlatformAccessory<LaundryContext>;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const ctx: ApplianceContext = {
      log, api: { hap } as unknown as API, accessory, name: alias, serial: 'S1',
      device: { deviceId: 'd1', deviceInfo: { deviceType, alias, modelName: 'M1' } },
      send: (p) => { sent.push(p); return fail ? Promise.reject(fail) : Promise.resolve({}); },
      refreshSoon: () => { refreshes++; },
      extraControls,
      options,
      sensorsAsOccupancy: problemAsOccupancy,
    };
    const part = mappingFor(deviceType, profile)!.create(ctx, profile);
    return { part, accessory, lines, sent, refreshes: () => refreshes, failNext: (e: Error) => { fail = e; } };
  }
  const val = (ch: Characteristic) => ch.value;
  async function write(ch: Characteristic, v: unknown): Promise<unknown> {
    try { await ch.handleSetRequest(v as number); return undefined; } catch (status) { return status; }
  }

  // ---- Air conditioners (Home Assistant's three sample units) ----

  test('air conditioner: heater/cooler tile from real data, cool only, fan speeds and swing', () => {
    const { part, accessory } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'Bedroom AC');
    part.update(fixture('air_conditioner', 'status'));
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(val(tile.getCharacteristic(C.Active)), C.Active.ACTIVE);
    assert.equal(val(tile.getCharacteristic(C.CurrentHeaterCoolerState)), C.CurrentHeaterCoolerState.COOLING);
    assert.equal(val(tile.getCharacteristic(C.CurrentTemperature)), 25);
    assert.equal(val(tile.getCharacteristic(C.CoolingThresholdTemperature)), 19);
    assert.deepEqual(tile.getCharacteristic(C.TargetHeaterCoolerState).props.validValues, [C.TargetHeaterCoolerState.COOL]);
    assert.equal(tile.getCharacteristic(C.CoolingThresholdTemperature).props.minValue, 18);
    assert.equal(tile.getCharacteristic(C.CoolingThresholdTemperature).props.maxValue, 30);
    assert.equal(val(tile.getCharacteristic(C.RotationSpeed)), 50, 'MID of LOW/MID/HIGH/AUTO');
    assert.ok(tile.testCharacteristic(C.SwingMode));
    assert.ok(part.busy);
    assert.ok(accessory.getServiceById(S.ContactSensor, 'problem'), 'this model alerts WATER_IS_FULL');
  });

  test('air conditioner: commands for power, temperature, fan, swing; a refused mode', async () => {
    const { part, accessory, sent, lines } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'AC');
    part.update(fixture('air_conditioner', 'status'));
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(await write(tile.getCharacteristic(C.CoolingThresholdTemperature), 22), undefined);
    assert.equal(await write(tile.getCharacteristic(C.RotationSpeed), 100), undefined);
    assert.equal(await write(tile.getCharacteristic(C.SwingMode), C.SwingMode.SWING_ENABLED), undefined);
    assert.equal(await write(tile.getCharacteristic(C.Active), C.Active.INACTIVE), undefined);
    assert.deepEqual(sent, [
      { temperature: { targetTemperature: 22 } },
      { airFlow: { windStrength: 'AUTO' } },
      { windDirection: { rotateUpDown: true } },
      { operation: { airConOperationMode: 'POWER_OFF' } },
    ]);
    assert.ok(lines.includes('info: [AC] Switched off.'));
    // HEAT isn't one of this unit's modes: the tile only offers COOL, and a stray request is refused
    assert.equal(await write(tile.getCharacteristic(C.TargetHeaterCoolerState), C.TargetHeaterCoolerState.HEAT), hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.ok(lines.includes('info: [AC] This air conditioner has no heat mode.'));
  });

  test('air conditioner: a °F unit gets whole °F; fan-only mode shows idle; no swing when the unit has none', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner1', 'profile'), 'AC');
    const status = fixture('air_conditioner1', 'status') as Record<string, unknown>;
    part.update({ ...status, temperature: { currentTemperature: 77, targetTemperature: 66, unit: 'F' }, temperatureInUnits: undefined });
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(val(tile.getCharacteristic(C.CurrentTemperature)), 25);
    assert.equal(tile.testCharacteristic(C.SwingMode), false);
    await write(tile.getCharacteristic(C.CoolingThresholdTemperature), 21);
    assert.deepEqual(sent.at(-1), { temperature: { targetTemperature: 70, unit: 'F' } });
    part.update({ ...status, airConJobMode: { currentJobMode: 'FAN' } });
    assert.equal(val(tile.getCharacteristic(C.CurrentHeaterCoolerState)), C.CurrentHeaterCoolerState.IDLE);
    assert.equal(val(tile.getCharacteristic(C.TargetHeaterCoolerState)), C.TargetHeaterCoolerState.COOL, 'keeps the last heat/cool mode');
  });

  test('air conditioner: LG refusing a command shows an error and logs why; commands go one at a time', async () => {
    const { part, accessory, lines, failNext, sent } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner2', 'profile'), 'AC');
    part.update(fixture('air_conditioner2', 'status'));
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    // A scene sets several at once: all sent, in order
    await Promise.all([write(tile.getCharacteristic(C.CoolingThresholdTemperature), 24), write(tile.getCharacteristic(C.RotationSpeed), 20)]);
    assert.deepEqual(sent, [{ temperature: { targetTemperature: 24 } }, { airFlow: { windStrength: 'SLOW' } }]);
    failNext(new Error('HTTP 400 (LG error 2301: Fail device control)'));
    assert.equal(await write(tile.getCharacteristic(C.CoolingThresholdTemperature), 20), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    assert.ok(lines.some((l) => l.startsWith('warn: [AC] LG refused "Set to 20 °C": HTTP 400')));
    // The next check from LG (asked for right away) makes the tile readable again, even when
    // nothing changed: LG still says what the tile already shows
    const target = tile.getCharacteristic(C.CoolingThresholdTemperature);
    part.update(fixture('air_conditioner2', 'status'));
    const shown = target.value;
    failNext(new Error('HTTP 400 (LG error 2301: Fail device control)'));
    await write(target, 22);
    assert.notEqual(target.statusCode, 0, 'HAP-NodeJS keeps the error');
    part.update(fixture('air_conditioner2', 'status'));
    assert.equal(target.value, shown, 'the same value as before');
    assert.equal(target.statusCode, 0, 'cleared, even though the value didn\'t change');
    await target.handleGetRequest();
    // LG's "device timeout" (2211) isn't a refusal: it may well have been done
    failNext(new ThinQError(400, '2211', 'Device Timeout'));
    assert.equal(await write(target, 21), undefined);
    assert.ok(lines.some((l) => l.startsWith('info: [AC] Sent "Set to 21 °C", but LG didn\'t confirm it')), lines.join('\n'));
  });

  test('problem sensor as an occupancy sensor (setting): an LG problem alert shows as detected', () => {
    const { part, accessory } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'AC', true, undefined, true);
    part.update(fixture('air_conditioner', 'status'));
    assert.equal(accessory.getServiceById(S.ContactSensor, 'problem'), undefined);
    const sensor = accessory.getServiceById(S.OccupancySensor, 'problem')!;
    assert.equal(val(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    part.alert('problem', 'WATER_IS_FULL');
    assert.equal(val(sensor.getCharacteristic(C.OccupancyDetected)), C.OccupancyDetected.OCCUPANCY_DETECTED);
  });

  test('air conditioner: LG\'s "water is full" alert opens the problem sensor until it\'s switched off and on', () => {
    const { part, accessory, lines } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'AC');
    part.update(fixture('air_conditioner', 'status'));
    part.alert('problem', 'WATER_IS_FULL');
    const problem = accessory.getServiceById(S.ContactSensor, 'problem')!;
    assert.equal(val(problem.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    assert.ok(lines.includes('warn: [AC] LG alert: Water is full.'));
    part.update({ operation: { airConOperationMode: 'POWER_OFF' } });
    assert.equal(val(problem.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED);
  });

  test('air conditioner extras from real data: air purify, energy saving, left-right swing, dry mode; air quality, humidity, filter', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'AC');
    part.update(fixture('air_conditioner', 'status'));
    const sw = (sub: string) => accessory.getServiceById(S.Switch, sub);
    assert.deepEqual(accessory.services.filter((x) => x.UUID === S.Switch.UUID).map((x) => x.subtype).sort(),
      ['air-purify', 'energy-saving', 'mode-AIR_DRY', 'swing-left-right']);
    assert.equal(val(sw('energy-saving')!.getCharacteristic(C.ConfiguredName)), 'AC Energy Saving');
    assert.equal(val(sw('energy-saving')!.getCharacteristic(C.On)), false);
    const aq = accessory.getServiceById(S.AirQualitySensor, 'air-quality')!;
    assert.equal(val(aq.getCharacteristic(C.AirQuality)), C.AirQuality.EXCELLENT + 1, 'GOOD');
    assert.equal(val(aq.getCharacteristic(C.PM2_5Density)), 24);
    assert.equal(val(accessory.getServiceById(S.HumiditySensor, 'humidity')!.getCharacteristic(C.CurrentRelativeHumidity)), 40);
    assert.equal(val(accessory.getServiceById(S.FilterMaintenance, 'filter')!.getCharacteristic(C.FilterLifeLevel)), 67, '180 of 540 hours used');
    await write(sw('air-purify')!.getCharacteristic(C.On), true);
    await write(sw('energy-saving')!.getCharacteristic(C.On), true);
    await write(sw('swing-left-right')!.getCharacteristic(C.On), true);
    await write(sw('mode-AIR_DRY')!.getCharacteristic(C.On), true);
    await write(sw('mode-AIR_DRY')!.getCharacteristic(C.On), false);
    assert.deepEqual(sent, [
      { operation: { airCleanOperationMode: 'START' } },
      { powerSave: { powerSaveEnabled: true } },
      { windDirection: { rotateLeftRight: true } },
      { airConJobMode: { currentJobMode: 'AIR_DRY' } },
      { airConJobMode: { currentJobMode: 'COOL' } },
    ]);
    // The unit doesn't report air purify back: the switch keeps the last command
    part.update(fixture('air_conditioner', 'status'));
    assert.equal(val(sw('air-purify')!.getCharacteristic(C.On)), true);
    assert.equal(val(sw('energy-saving')!.getCharacteristic(C.On)), false, 'reported back: follows the unit');
  });

  test('air conditioner extras: display light, jet mode, fan mode; none with the setting off', async () => {
    const profile = { property: {
      operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airConJobMode: { currentJobMode: en(['COOL', 'FAN']) },
      airFlow: { windStrength: en(['LOW', 'HIGH', 'POWER', 'AUTO']) },
      display: { light: en(['ON', 'OFF']) },
      temperature: { targetTemperature: range(18, 30), currentTemperature: { type: 'number', mode: ['r'] } },
    } };
    const { part, accessory, sent } = make('DEVICE_AIR_CONDITIONER', profile, 'AC');
    part.update({ operation: { airConOperationMode: 'POWER_ON' }, airConJobMode: { currentJobMode: 'FAN' },
      airFlow: { windStrength: 'POWER' }, display: { light: 'ON' }, temperature: { currentTemperature: 24, targetTemperature: 22, unit: 'C' } });
    const sw = (sub: string) => accessory.getServiceById(S.Switch, sub)!;
    assert.equal(val(sw('jet').getCharacteristic(C.On)), true);
    assert.equal(val(sw('display-light').getCharacteristic(C.On)), true);
    assert.equal(val(sw('mode-FAN').getCharacteristic(C.On)), true);
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(val(tile.getCharacteristic(C.RotationSpeed)), 100, 'jet is not a slider speed');
    await write(sw('jet').getCharacteristic(C.On), false);
    await write(sw('display-light').getCharacteristic(C.On), false);
    assert.deepEqual(sent, [{ airFlow: { windStrength: 'AUTO' } }, { display: { light: 'OFF' } }]);
    const off = make('DEVICE_AIR_CONDITIONER', profile, 'AC', false);
    assert.equal(off.accessory.services.filter((x) => x.UUID === S.Switch.UUID).length, 0);
  });

  test('air conditioner two-set: in auto with two set points on, heating and cooling are separate', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_CONDITIONER', { property: {
      operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airConJobMode: { currentJobMode: en(['COOL', 'HEAT', 'AUTO']) },
      temperature: { targetTemperature: range(16, 30), currentTemperature: { type: 'number', mode: ['r'] } },
      twoSetTemperature: { twoSetEnabled: { type: 'boolean', mode: ['r', 'w'] } },
      twoSetTemperatureInUnits: [{ unit: 'C', heatTargetTemperature: range(16, 26), coolTargetTemperature: range(20, 30) }],
    } }, 'AC');
    part.update({ operation: { airConOperationMode: 'POWER_ON' }, airConJobMode: { currentJobMode: 'AUTO' },
      temperature: { currentTemperature: 22, targetTemperature: 22, unit: 'C' },
      twoSetTemperature: { twoSetEnabled: true }, twoSetTemperatureInUnits: [{ unit: 'C', heatTargetTemperature: 19, coolTargetTemperature: 25 }] });
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(val(tile.getCharacteristic(C.HeatingThresholdTemperature)), 19);
    assert.equal(val(tile.getCharacteristic(C.CoolingThresholdTemperature)), 25);
    assert.equal(tile.getCharacteristic(C.CoolingThresholdTemperature).props.minValue, 20);
    await write(tile.getCharacteristic(C.CoolingThresholdTemperature), 26);
    assert.deepEqual(sent, [{ twoSetTemperatureInUnits: { coolTargetTemperature: 26, unit: 'C' } }]);
    // Cool mode: back to the one set temperature
    part.update({ airConJobMode: { currentJobMode: 'COOL' }, operation: { airConOperationMode: 'POWER_ON' } });
    assert.equal(val(tile.getCharacteristic(C.CoolingThresholdTemperature)), 22);
    await write(tile.getCharacteristic(C.CoolingThresholdTemperature), 23);
    assert.deepEqual(sent.at(-1), { temperature: { targetTemperature: 23 } });
  });

  // ---- Air purifier, dehumidifier, hood (Home Assistant's sample units) ----

  test('air purifier: on/off from real data; air quality and filter when the profile has them', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_PURIFIER', fixture('air_purifier', 'profile'), 'Purifier');
    part.update(fixture('air_purifier', 'status'));
    const tile = accessory.getServiceById(S.AirPurifier, 'purifier')!;
    assert.equal(val(tile.getCharacteristic(C.Active)), 1);
    assert.equal(val(tile.getCharacteristic(C.CurrentAirPurifierState)), C.CurrentAirPurifierState.PURIFYING_AIR);
    assert.equal(accessory.getServiceById(S.AirQualitySensor, 'air-quality'), undefined, 'this model has no sensor');
    await write(tile.getCharacteristic(C.Active), 0);
    assert.deepEqual(sent, [{ operation: { airPurifierOperationMode: 'POWER_OFF' } }]);

    const full = make('DEVICE_AIR_PURIFIER', { property: {
      operation: { airPurifierOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airFlow: { windStrength: en(['LOW', 'MID', 'HIGH', 'AUTO']) },
      airQualitySensor: { PM2: { type: 'number', mode: ['r'] }, totalPollutionLevel: en(['GOOD', 'NORMAL', 'BAD', 'VERY_BAD'], ['r']) },
      filterInfo: { filterRemainPercent: { type: 'number', mode: ['r'] } },
    } }, 'Purifier');
    full.part.update({ operation: { airPurifierOperationMode: 'POWER_ON' }, airFlow: { windStrength: 'LOW' },
      airQualitySensor: { PM2: 14, totalPollutionLevel: 'BAD' }, filterInfo: { filterRemainPercent: 6 } });
    const aq = full.accessory.getServiceById(S.AirQualitySensor, 'air-quality')!;
    assert.equal(val(aq.getCharacteristic(C.AirQuality)), C.AirQuality.INFERIOR);
    assert.equal(val(aq.getCharacteristic(C.PM2_5Density)), 14);
    const filter = full.accessory.getServiceById(S.FilterMaintenance, 'filter')!;
    assert.equal(val(filter.getCharacteristic(C.FilterChangeIndication)), C.FilterChangeIndication.CHANGE_FILTER);
    assert.equal(val(full.accessory.getServiceById(S.AirPurifier, 'purifier')!.getCharacteristic(C.RotationSpeed)), 25);
  });

  test('air purifier: auto or manual from its modes, and a sleep mode switch', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_PURIFIER', { property: {
      operation: { airPurifierOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airPurifierJobMode: { currentJobMode: en(['CLEAN', 'AUTO', 'SLEEP']) },
    } }, 'Purifier');
    part.update({ operation: { airPurifierOperationMode: 'POWER_ON' }, airPurifierJobMode: { currentJobMode: 'AUTO' } });
    const tile = accessory.getServiceById(S.AirPurifier, 'purifier')!;
    const T = C.TargetAirPurifierState;
    assert.equal(val(tile.getCharacteristic(T)), T.AUTO);
    await write(tile.getCharacteristic(T), T.MANUAL);
    const sleep = accessory.getServiceById(S.Switch, 'sleep')!;
    await write(sleep.getCharacteristic(C.On), true);
    await write(sleep.getCharacteristic(C.On), false);
    assert.deepEqual(sent.map((p) => (p.airPurifierJobMode as Record<string, string>).currentJobMode), ['CLEAN', 'SLEEP', 'CLEAN']);
  });

  test('dehumidifier: humidity now and target from real data, its two fan speeds, the full-tank alert', async () => {
    const { part, accessory, sent } = make('DEVICE_DEHUMIDIFIER', fixture('dehumidifier', 'profile'), 'Basement');
    part.update(fixture('dehumidifier', 'status'));
    const tile = accessory.getServiceById(S.HumidifierDehumidifier, 'humidity')!;
    assert.equal(val(tile.getCharacteristic(C.CurrentRelativeHumidity)), 80);
    assert.equal(val(tile.getCharacteristic(C.RelativeHumidityDehumidifierThreshold)), 55);
    assert.equal(tile.getCharacteristic(C.RelativeHumidityDehumidifierThreshold).props.minStep, 5);
    assert.equal(val(tile.getCharacteristic(C.CurrentHumidifierDehumidifierState)), C.CurrentHumidifierDehumidifierState.DEHUMIDIFYING);
    assert.equal(val(tile.getCharacteristic(C.RotationSpeed)), 100, 'HIGH of LOW/HIGH');
    await write(tile.getCharacteristic(C.RelativeHumidityDehumidifierThreshold), 45);
    await write(tile.getCharacteristic(C.RotationSpeed), 40);
    assert.deepEqual(sent, [{ humidity: { targetHumidity: 45 } }, { airFlow: { windStrengthLevel: 'LOW' } }]);
    assert.ok(accessory.getServiceById(S.ContactSensor, 'problem'), 'WATER_IS_FULL in its alerts');
  });

  test('humidifier: the humidifier mode of the same tile', () => {
    const { part, accessory } = make('DEVICE_HUMIDIFIER', { property: {
      operation: { humidifierOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      humidity: { targetHumidity: range(30, 70, 5) },
      airQualitySensor: { humidity: { type: 'number', mode: ['r'] } },
    } }, 'Nursery');
    part.update({ operation: { humidifierOperationMode: 'POWER_ON' }, humidity: { targetHumidity: 50 }, airQualitySensor: { humidity: 38 } });
    const tile = accessory.getServiceById(S.HumidifierDehumidifier, 'humidity')!;
    assert.equal(val(tile.getCharacteristic(C.CurrentRelativeHumidity)), 38);
    assert.equal(val(tile.getCharacteristic(C.RelativeHumidityHumidifierThreshold)), 50);
    assert.equal(val(tile.getCharacteristic(C.CurrentHumidifierDehumidifierState)), C.CurrentHumidifierDehumidifierState.HUMIDIFYING);
  });

  test('range hood: fan speed in steps and the light, from real data', async () => {
    const { part, accessory, sent } = make('DEVICE_HOOD', fixture('hood', 'profile'), 'Hood');
    part.update(fixture('hood', 'status'));
    const fan = accessory.getServiceById(S.Fanv2, 'fan')!;
    const lamp = accessory.getServiceById(S.Lightbulb, 'lamp')!;
    assert.equal(val(fan.getCharacteristic(C.Active)), 1);
    assert.equal(val(fan.getCharacteristic(C.RotationSpeed)), 20, 'speed 1 of 5');
    assert.equal(val(lamp.getCharacteristic(C.On)), true);
    assert.equal(val(lamp.getCharacteristic(C.Brightness)), 100, 'brightness 2 of 2');
    await write(fan.getCharacteristic(C.RotationSpeed), 60);
    await write(lamp.getCharacteristic(C.On), false);
    assert.deepEqual(sent, [{ ventilation: { fanSpeed: 3 } }, { lamp: { lampBrightness: 0 } }]);
  });

  test('microwave: running and time left to the second, done, and the vent fan and light', async () => {
    const { part, accessory, sent, lines } = make('DEVICE_MICROWAVE_OVEN', { property: {
      runState: { currentState: en(['INITIAL', 'RUNNING', 'PAUSE', 'END'], ['r']) },
      timer: { remainMinute: { type: 'number', mode: ['r'] }, remainSecond: { type: 'number', mode: ['r'] } },
      ventilation: { fanSpeed: range(0, 3) },
      lamp: { lampBrightness: range(0, 2) },
    } }, 'Microwave');
    part.update({ runState: { currentState: 'RUNNING' }, timer: { remainMinute: 2, remainSecond: 30 }, ventilation: { fanSpeed: 0 }, lamp: { lampBrightness: 1 } });
    const cycle = accessory.getServiceById(S.Valve, 'cycle')!;
    const done = accessory.getServiceById(S.OccupancySensor, 'done')!;
    assert.ok(cycle.isPrimaryService);
    assert.equal(val(cycle.getCharacteristic(C.InUse)), 1);
    assert.equal(val(cycle.getCharacteristic(C.RemainingDuration)), 150);
    assert.equal(val(accessory.getServiceById(S.Fanv2, 'fan')!.getCharacteristic(C.ConfiguredName)), 'Microwave Fan');
    assert.equal(val(accessory.getServiceById(S.Lightbulb, 'lamp')!.getCharacteristic(C.Brightness)), 50);
    assert.ok(part.busy);
    part.update({ runState: { currentState: 'END' }, timer: { remainMinute: 0, remainSecond: 0 }, ventilation: { fanSpeed: 0 }, lamp: { lampBrightness: 0 } });
    assert.equal(val(done.getCharacteristic(C.OccupancyDetected)), 1);
    assert.equal(val(cycle.getCharacteristic(C.Active)), 0);
    // LG's "done" alert after it already went back to idle, until the next start
    part.update({ runState: { currentState: 'INITIAL' } });
    part.alert('finished', 'COOKING_IS_COMPLETE');
    assert.equal(val(done.getCharacteristic(C.OccupancyDetected)), 1);
    assert.ok(lines.includes("info: [Microwave] LG says it's done."));
    part.update({ runState: { currentState: 'RUNNING' }, timer: { remainMinute: 1, remainSecond: 0 } });
    assert.equal(val(done.getCharacteristic(C.OccupancyDetected)), 0);
    // It can't be started from the Home app; the fan still works
    assert.equal(await write(cycle.getCharacteristic(C.Active), 0), hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    await write(accessory.getServiceById(S.Fanv2, 'fan')!.getCharacteristic(C.Active), 1);
    assert.deepEqual(sent, [{ ventilation: { fanSpeed: 1 } }]);
  });

  test('microwave from a cached accessory: its services are kept, not re-added', () => {
    const profile = { property: { runState: { currentState: en(['RUNNING', 'END'], ['r']) }, lamp: { lampBrightness: range(0, 2) } } };
    const first = make('DEVICE_MICROWAVE_OVEN', profile, 'Microwave');
    const cycleId = first.accessory.getServiceById(S.Valve, 'cycle')!.iid;
    const ctxAgain = mappingFor('DEVICE_MICROWAVE_OVEN', profile)!;
    // Same accessory again, as after a restart
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logging;
    ctxAgain.create({ log, api: { hap } as unknown as API, accessory: first.accessory, name: 'Microwave', serial: 'S1',
      device: { deviceId: 'd1', deviceInfo: { deviceType: 'DEVICE_MICROWAVE_OVEN', alias: 'Microwave', modelName: 'M1' } },
      send: () => Promise.resolve({}), refreshSoon: () => {} }, profile);
    assert.equal(first.accessory.getServiceById(S.Valve, 'cycle')!.iid, cycleId);
    assert.equal(first.accessory.services.filter((x) => x.UUID === S.Valve.UUID).length, 1);
  });

  test('ceiling fan and ventilator: a fan tile with on/off and speed (any operation field with POWER_ON)', async () => {
    const { part, accessory, sent } = make('DEVICE_VENTILATOR', { property: {
      operation: { ventOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airFlow: { windStrength: en(['LOW', 'MID', 'HIGH', 'AUTO']) },
    } }, 'Vent');
    part.update({ operation: { ventOperationMode: 'POWER_OFF' }, airFlow: { windStrength: 'HIGH' } });
    const fan = accessory.getServiceById(S.Fanv2, 'fan')!;
    assert.equal(val(fan.getCharacteristic(C.Active)), 0);
    await write(fan.getCharacteristic(C.Active), 1);
    assert.deepEqual(sent, [{ operation: { ventOperationMode: 'POWER_ON' } }]);
  });

  // ---- Heating, fridge, vacuum (from LG's documented property names) ----

  test('water heater: a thermostat with the tank temperature and its set point', async () => {
    const { part, accessory, sent } = make('DEVICE_WATER_HEATER', { property: {
      operation: { waterHeaterOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      temperatureInUnits: [{ unit: 'C', targetTemperature: range(35, 65), currentTemperature: { type: 'number', mode: ['r'] } },
        { unit: 'F', targetTemperature: range(95, 149) }],
    } }, 'Water heater');
    part.update({ operation: { waterHeaterOperationMode: 'POWER_ON' },
      temperatureInUnits: [{ unit: 'C', currentTemperature: 48, targetTemperature: 55 }, { unit: 'F', currentTemperature: 118, targetTemperature: 131 }] });
    const t = accessory.getServiceById(S.Thermostat, 'water')!;
    assert.equal(val(t.getCharacteristic(C.CurrentTemperature)), 48);
    assert.equal(val(t.getCharacteristic(C.TargetTemperature)), 55);
    assert.equal(val(t.getCharacteristic(C.TargetHeatingCoolingState)), C.TargetHeatingCoolingState.HEAT);
    assert.equal(t.getCharacteristic(C.TargetTemperature).props.maxValue, 65);
    await write(t.getCharacteristic(C.TargetTemperature), 60);
    await write(t.getCharacteristic(C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.OFF);
    assert.deepEqual(sent, [{ temperatureInUnits: { targetTemperature: 60, unit: 'C' } }, { operation: { waterHeaterOperationMode: 'POWER_OFF' } }]);
  });

  test('heat pump: room heating (air set point) and hot water, as the boiler plugin maps them', async () => {
    const { part, accessory, sent } = make('DEVICE_SYSTEM_BOILER', { property: {
      boilerJobMode: { currentJobMode: en(['HEAT', 'COOL', 'AUTO']) },
      operation: { boilerOperationMode: en(['POWER_ON', 'POWER_OFF']), hotWaterMode: en(['ON', 'OFF']), roomTempMode: en(['AIR', 'WATER'], ['r']) },
      roomTemperatureInUnits: [{ unit: 'C', airHeatTargetTemperature: range(16, 30), outWaterCurrentTemperature: { type: 'number', mode: ['r'] } }],
      hotWaterTemperatureInUnits: [{ unit: 'C', targetTemperature: range(30, 60) }],
    } }, 'Heat pump');
    part.update({
      boilerJobMode: { currentJobMode: 'HEAT' },
      operation: { boilerOperationMode: 'POWER_ON', hotWaterMode: 'OFF', roomTempMode: 'AIR' },
      roomTemperatureInUnits: [{ unit: 'C', airCurrentTemperature: 20.5, airHeatTargetTemperature: 21, outWaterCurrentTemperature: 38 }],
      hotWaterTemperatureInUnits: [{ unit: 'C', currentTemperature: 42, targetTemperature: 50, minTemperature: 30, maxTemperature: 55 }],
    });
    const room = accessory.getServiceById(S.Thermostat, 'room')!;
    const water = accessory.getServiceById(S.Thermostat, 'hot-water')!;
    assert.equal(val(room.getCharacteristic(C.CurrentTemperature)), 20.5);
    assert.equal(val(room.getCharacteristic(C.TargetTemperature)), 21);
    assert.equal(val(room.getCharacteristic(C.TargetHeatingCoolingState)), C.TargetHeatingCoolingState.HEAT);
    assert.equal(val(water.getCharacteristic(C.TargetHeatingCoolingState)), C.TargetHeatingCoolingState.OFF);
    assert.equal(water.getCharacteristic(C.TargetTemperature).props.maxValue, 55, 'limits from the state');
    // The water leaving the heat pump, as Home Assistant shows it; no return sensor when it isn't reported
    const flow = accessory.getServiceById(S.TemperatureSensor, 'flow-temperature')!;
    assert.equal(val(flow.getCharacteristic(C.ConfiguredName)), 'Heat pump Flow Temperature');
    assert.equal(val(flow.getCharacteristic(C.CurrentTemperature)), 38);
    assert.equal(accessory.getServiceById(S.TemperatureSensor, 'return-temperature'), undefined);
    await write(room.getCharacteristic(C.TargetTemperature), 22);
    await write(room.getCharacteristic(C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.COOL);
    await write(water.getCharacteristic(C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.HEAT);
    assert.deepEqual(sent, [
      { roomTemperatureInUnits: { airHeatTargetTemperature: 22, unit: 'C' } },
      { boilerJobMode: { currentJobMode: 'COOL' } },
      { operation: { hotWaterMode: 'ON' } },
    ]);
  });

  test('refrigerator: a door sensor, fridge and freezer set points, an express switch, the water filter', async () => {
    const { part, accessory, sent } = make('DEVICE_REFRIGERATOR', { property: {
      doorStatus: [{ locationName: 'MAIN', doorState: en(['OPEN', 'CLOSE'], ['r']) }],
      temperatureInUnits: [
        { locationName: 'FRIDGE', targetTemperatureC: range(1, 7), targetTemperatureF: range(33, 43), unit: 'C' },
        { locationName: 'FREEZER', targetTemperatureC: range(-23, -15), targetTemperatureF: range(-8, 5), unit: 'C' },
      ],
      refrigeration: { expressMode: { type: 'boolean', mode: ['r', 'w'] }, rapidFreeze: en(['ON', 'OFF']) },
      waterFilterInfo: { waterFilter1RemainPercent: { type: 'number', mode: ['r'] } },
    } }, 'Fridge');
    part.update({
      doorStatus: [{ locationName: 'MAIN', doorState: 'OPEN' }],
      temperatureInUnits: [{ locationName: 'FRIDGE', targetTemperatureC: 3, unit: 'C' }, { locationName: 'FREEZER', targetTemperatureC: -18, unit: 'C' }],
      refrigeration: { expressMode: false },
      waterFilterInfo: { waterFilter1RemainPercent: 40 },
    });
    const door = accessory.getServiceById(S.ContactSensor, 'door-MAIN')!;
    assert.equal(val(door.getCharacteristic(C.ConfiguredName)), 'Fridge Door');
    assert.equal(val(door.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    const freezer = accessory.getServiceById(S.Thermostat, 'temp-FREEZER')!;
    assert.equal(val(freezer.getCharacteristic(C.TargetTemperature)), -18);
    assert.equal(freezer.getCharacteristic(C.TargetTemperature).props.minValue, -23);
    // An ON/OFF setting is a switch too, sending LG's own words
    await write(accessory.getServiceById(S.Switch, 'switch-rapidFreeze')!.getCharacteristic(C.On), true);
    assert.deepEqual(sent.splice(0), [{ refrigeration: { rapidFreeze: 'ON' } }]);
    assert.equal(val(accessory.getServiceById(S.FilterMaintenance, 'filter')!.getCharacteristic(C.FilterLifeLevel)), 40);
    await write(freezer.getCharacteristic(C.TargetTemperature), -20);
    await write(accessory.getServiceById(S.Switch, 'switch-expressMode')!.getCharacteristic(C.On), true);
    assert.deepEqual(sent, [
      { temperatureInUnits: { locationName: 'FREEZER', unit: 'C', targetTemperatureC: -20 } },
      { refrigeration: { expressMode: true } },
    ]);
    part.update({ doorStatus: [{ locationName: 'MAIN', doorState: 'CLOSE' }] });
    assert.equal(val(door.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED);
  });

  test('robot vacuum: a switch that is on while cleaning, battery, start / resume / home', async () => {
    const { part, accessory, sent } = make('DEVICE_ROBOT_CLEANER', { property: {
      runState: { currentState: en(['WORKING', 'CHARGING', 'PAUSE', 'HOMING', 'SLEEP'], ['r']) },
      operation: { cleanOperationMode: en(['START', 'PAUSE', 'HOMING', 'RESUME', 'WAKE_UP'], ['w']) },
      battery: { percent: { type: 'number', mode: ['r'] } },
    } }, 'Robot');
    part.update({ runState: { currentState: 'CHARGING' }, battery: { percent: 15 } });
    const sw = accessory.getServiceById(S.Switch, 'clean')!;
    const battery = accessory.getServiceById(S.Battery, 'battery')!;
    assert.equal(val(sw.getCharacteristic(C.On)), false);
    assert.equal(val(battery.getCharacteristic(C.BatteryLevel)), 15);
    assert.equal(val(battery.getCharacteristic(C.ChargingState)), 1);
    assert.equal(val(battery.getCharacteristic(C.StatusLowBattery)), 1);
    await write(sw.getCharacteristic(C.On), true);
    part.update({ runState: { currentState: 'PAUSE' } });
    await write(sw.getCharacteristic(C.On), true);
    part.update({ runState: { currentState: 'WORKING' } });
    assert.ok(part.busy);
    await write(sw.getCharacteristic(C.On), false);
    assert.deepEqual(sent.map((p) => (p.operation as Record<string, string>).cleanOperationMode), ['START', 'RESUME', 'HOMING']);
  });

  test('basic fallback: power switch, temperatures and humidity from any profile', async () => {
    const { part, accessory, sent } = make('DEVICE_PLANT_CULTIVATOR', { property: {
      operation: { operationMode: en(['POWER_ON', 'POWER_OFF']) },
      temperature: { currentTemperature: { type: 'number', mode: ['r'] }, unit: en(['C', 'F'], ['r']) },
      humidity: { currentHumidity: { type: 'number', mode: ['r'] } },
    } }, 'Thing');
    part.update({ operation: { operationMode: 'POWER_ON' }, temperature: { currentTemperature: 86, unit: 'F' }, humidity: { currentHumidity: 45 } });
    assert.equal(val(accessory.getServiceById(S.Switch, 'power')!.getCharacteristic(C.On)), true);
    assert.equal(val(accessory.getServiceById(S.TemperatureSensor, 'temp-temperature')!.getCharacteristic(C.CurrentTemperature)), 30);
    assert.equal(val(accessory.getServiceById(S.HumiditySensor, 'humidity')!.getCharacteristic(C.CurrentRelativeHumidity)), 45);
    await write(accessory.getServiceById(S.Switch, 'power')!.getCharacteristic(C.On), false);
    assert.deepEqual(sent, [{ operation: { operationMode: 'POWER_OFF' } }]);
  });
  // ---- Closing the gap with the other LG plugins ----

  const acThreeModes = () => ({ property: {
    operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) },
    airConJobMode: { currentJobMode: en(['COOL', 'HEAT', 'AUTO', 'FAN']) },
    temperature: { targetTemperature: range(16, 30), currentTemperature: { type: 'number', mode: ['r'] } },
    windDirection: { rotateUpDown: { type: 'boolean', mode: ['r', 'w'] }, rotateLeftRight: { type: 'boolean', mode: ['r', 'w'] } },
  } });
  const acOn = { operation: { airConOperationMode: 'POWER_ON' }, airConJobMode: { currentJobMode: 'COOL' },
    temperature: { currentTemperature: 23.5, targetTemperature: 22, unit: 'C' }, windDirection: { rotateUpDown: false, rotateLeftRight: true } };

  test('air conditioner options: cooling or heating only, which way the swing moves, a room temperature sensor', async () => {
    const T = C.TargetHeaterCoolerState;
    const all = make('DEVICE_AIR_CONDITIONER', acThreeModes(), 'AC');
    assert.deepEqual(all.accessory.getServiceById(S.HeaterCooler, 'climate')!.getCharacteristic(T).props.validValues, [T.AUTO, T.HEAT, T.COOL]);
    assert.ok(all.accessory.getServiceById(S.Switch, 'swing-left-right'), 'by default the tile swings up-down; left-right is a switch');

    const cool = make('DEVICE_AIR_CONDITIONER', acThreeModes(), 'AC', true, { acModes: 'cool', acSwing: 'both', temperatureSensor: true });
    cool.part.update({ ...acOn, airConJobMode: { currentJobMode: 'HEAT' } });
    const tile = cool.accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.deepEqual(tile.getCharacteristic(T).props.validValues, [T.COOL]);
    assert.equal(val(tile.getCharacteristic(T)), T.COOL, 'a mode set on the remote shows as the one the tile has');
    assert.equal(cool.accessory.getServiceById(S.Switch, 'swing-left-right'), undefined);
    assert.equal(cool.accessory.getServiceById(S.Switch, 'swing-up-down'), undefined);
    assert.equal(val(tile.getCharacteristic(C.SwingMode)), C.SwingMode.SWING_ENABLED, 'swinging either way shows as swing');
    await write(tile.getCharacteristic(C.SwingMode), C.SwingMode.SWING_DISABLED);
    assert.deepEqual(cool.sent, [{ windDirection: { rotateUpDown: false, rotateLeftRight: false } }]);
    const room = cool.accessory.getServiceById(S.TemperatureSensor, 'room-temperature')!;
    assert.equal(val(room.getCharacteristic(C.CurrentTemperature)), 23.5);

    const lr = make('DEVICE_AIR_CONDITIONER', acThreeModes(), 'AC', true, { acModes: 'heat', acSwing: 'left-right' });
    lr.part.update(acOn);
    assert.deepEqual(lr.accessory.getServiceById(S.HeaterCooler, 'climate')!.getCharacteristic(T).props.validValues, [T.HEAT]);
    assert.ok(lr.accessory.getServiceById(S.Switch, 'swing-up-down'), 'the other direction gets the switch');
    assert.equal(val(lr.accessory.getServiceById(S.HeaterCooler, 'climate')!.getCharacteristic(C.SwingMode)), C.SwingMode.SWING_ENABLED);

    // Heating only on a unit that can't heat: all its modes stay
    const coolOnly = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'AC', true, { acModes: 'heat' });
    assert.deepEqual(coolOnly.accessory.getServiceById(S.HeaterCooler, 'climate')!.getCharacteristic(T).props.validValues, [T.COOL]);
    // Extra switches off for this one only
    const plain = make('DEVICE_AIR_CONDITIONER', acThreeModes(), 'AC', true, { extraControls: false });
    assert.equal(plain.accessory.services.filter((x) => x.UUID === S.Switch.UUID).length, 0);
  });

  test('air purifier: turbo kept off the slider; AeroTower warm mode, UV nano and temperature', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_PURIFIER_FAN', { property: {
      operation: { airFanOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airFanJobMode: { currentJobMode: en(['SPACE_CLEAN', 'DIRECT_CLEAN', 'SLEEP']) },
      airFlow: { windStrength: en(['LOW', 'MID', 'HIGH', 'POWER']), warmMode: en(['WARM_ON', 'WARM_OFF']) },
      misc: { uvNano: en(['ON', 'OFF']) },
      airQualitySensor: { temperature: { type: 'number', mode: ['r'] }, humidity: { type: 'number', mode: ['r'] } },
    } }, 'AeroTower');
    part.update({ operation: { airFanOperationMode: 'POWER_ON' }, airFanJobMode: { currentJobMode: 'SPACE_CLEAN' },
      airFlow: { windStrength: 'POWER', warmMode: 'WARM_OFF' }, misc: { uvNano: 'ON' }, airQualitySensor: { temperature: 21, humidity: 40 } });
    const turbo = accessory.getServiceById(S.Switch, 'turbo')!;
    const warm = accessory.getServiceById(S.Switch, 'warm')!;
    const uv = accessory.getServiceById(S.Switch, 'uv-nano')!;
    assert.equal(val(turbo.getCharacteristic(C.On)), true);
    assert.equal(val(warm.getCharacteristic(C.On)), false);
    assert.equal(val(uv.getCharacteristic(C.On)), true);
    assert.equal(val(accessory.getServiceById(S.TemperatureSensor, 'temperature')!.getCharacteristic(C.CurrentTemperature)), 21);
    assert.equal(val(accessory.getServiceById(S.HumiditySensor, 'humidity')!.getCharacteristic(C.CurrentRelativeHumidity)), 40);
    await write(turbo.getCharacteristic(C.On), false);
    await write(warm.getCharacteristic(C.On), true);
    await write(uv.getCharacteristic(C.On), false);
    await write(accessory.getServiceById(S.Switch, 'sleep')!.getCharacteristic(C.On), true);
    assert.deepEqual(sent, [{ airFlow: { windStrength: 'HIGH' } }, { airFlow: { warmMode: 'WARM_ON' } }, { misc: { uvNano: 'OFF' } },
      { airFanJobMode: { currentJobMode: 'SLEEP' } }]);
    const none = make('DEVICE_AIR_PURIFIER_FAN', { property: { airFlow: { windStrength: en(['LOW', 'POWER']), warmMode: en(['WARM_ON', 'WARM_OFF']) } } }, 'A', false);
    assert.equal(none.accessory.services.filter((x) => x.UUID === S.Switch.UUID).length, 0);
  });

  /** A cooktop profile as LG documents it: one entry per cooking zone. */
  const cooktopProfile = (powerOff = true) => ({
    property: ['LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR'].map((z) => ({
      cookingZone: { currentState: en(['INITIAL', 'COOK', 'PAUSE', 'LOCK'], ['r']) },
      location: { locationName: z },
      power: { powerLevel: range(0, 9, 1, ['r']) },
      timer: { remainHour: range(0, 11, 1, ['r']), remainMinute: range(0, 59, 1, ['r']) },
    })),
    // Where LG's toolkits read the "all off" command from
    ...(powerOff ? { extensionProperty: { operation: { operationMode: en(['POWER_OFF'], ['w']) } } } : {}),
  });
  const zone = (z: string, st: string) => ({ cookingZone: { currentState: st }, location: { locationName: z }, timer: { remainHour: 0, remainMinute: 0 } });

  test('cooktop: which burners are on, any burner on, and a button that switches them all off', async () => {
    assert.equal(mappingFor('DEVICE_COOKTOP', cooktopProfile())?.label, 'cooktop');
    const { part, accessory, sent, lines } = make('DEVICE_COOKTOP', cooktopProfile(), 'Cooktop');
    const any = accessory.getServiceById(S.OccupancySensor, 'in-use')!;
    const lf = accessory.getServiceById(S.OccupancySensor, 'zone-LEFT_FRONT')!;
    const rf = accessory.getServiceById(S.OccupancySensor, 'zone-RIGHT_FRONT')!;
    assert.equal(any.isPrimaryService, true);
    assert.equal(lf.getCharacteristic(C.Name).value, 'Cooktop Left Front');
    part.update([zone('LEFT_FRONT', 'COOK'), zone('RIGHT_FRONT', 'INITIAL'), zone('LEFT_REAR', 'LOCK')]);
    assert.equal(val(any.getCharacteristic(C.OccupancyDetected)), 1);
    assert.equal(val(lf.getCharacteristic(C.OccupancyDetected)), 1);
    assert.equal(val(rf.getCharacteristic(C.OccupancyDetected)), 0);
    assert.equal(part.busy, true);
    assert.ok(lines.includes('info: [Cooktop] On: left front.'));
    // A live update for one zone only
    part.update([zone('LEFT_FRONT', 'INITIAL')]);
    assert.equal(val(any.getCharacteristic(C.OccupancyDetected)), 0);
    assert.ok(lines.includes('info: [Cooktop] All burners off.'));
    const off = accessory.getServiceById(S.Switch, 'power-off')!;
    await write(off.getCharacteristic(C.On), true);
    assert.deepEqual(sent, [{ operation: { operationMode: 'POWER_OFF' } }]);
    await write(off.getCharacteristic(C.On), false);
    assert.equal(sent.length, 1, 'switching the button off sends nothing');
    // Models that can't be switched off remotely, or extra controls off: no button
    assert.equal(make('DEVICE_COOKTOP', cooktopProfile(false), 'C').accessory.getServiceById(S.Switch, 'power-off'), undefined);
    assert.equal(make('DEVICE_COOKTOP', cooktopProfile(), 'C', false).accessory.getServiceById(S.Switch, 'power-off'), undefined);
    assert.equal(make('DEVICE_COOKTOP', cooktopProfile(), 'C', true, { extraControls: false }).accessory.getServiceById(S.Switch, 'power-off'), undefined);
  });

  test('cooktop: "all burners off" refused by LG goes back off and stays readable', async () => {
    const { part, accessory, failNext } = make('DEVICE_COOKTOP', cooktopProfile(), 'C');
    part.update(undefined);
    const on = accessory.getServiceById(S.Switch, 'power-off')!.getCharacteristic(C.On);
    failNext(new Error('HTTP 400 (LG error 2301: Fail device control)'));
    assert.equal(await write(on, 1), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(on.value, false);
    assert.equal(on.statusCode, 0, 'readable again');
  });

  test('cooktop: a burner LG stops listing counts as off (the stove-on sensor can\'t stick)', () => {
    const { part, accessory } = make('DEVICE_COOKTOP', cooktopProfile(), 'Cooktop');
    part.update([zone('LEFT_FRONT', 'COOK'), zone('RIGHT_FRONT', 'INITIAL')]);
    assert.equal(part.busy, true);
    part.update([zone('RIGHT_FRONT', 'INITIAL')]);
    assert.equal(part.busy, false);
    assert.equal(val(accessory.getServiceById(S.OccupancySensor, 'in-use')!.getCharacteristic(C.OccupancyDetected)), 0);
  });

  test('air purifier: TURBO is a switch, not a speed, and switching it off never sends it', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_PURIFIER', { property: {
      operation: { airPurifierOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airFlow: { windStrength: en(['LOW', 'MID', 'HIGH', 'TURBO']) },
    } }, 'Purifier');
    part.update({ operation: { airPurifierOperationMode: 'POWER_ON' }, airFlow: { windStrength: 'TURBO' } });
    await write(accessory.getServiceById(S.Switch, 'turbo')!.getCharacteristic(C.On), false);
    await write(accessory.getServiceById(S.AirPurifier, 'purifier')!.getCharacteristic(C.RotationSpeed), 100);
    assert.deepEqual(sent[0], { airFlow: { windStrength: 'HIGH' } });
    assert.ok(!sent.some((p) => JSON.stringify(p).includes('TURBO')), 'the slider at full speed is HIGH, not turbo');
    assert.deepEqual(speedLevels(en(['LOW', 'MID', 'HIGH', 'TURBO'])), ['LOW', 'MID', 'HIGH']);
  });

  test('air conditioner cooling only: switching on a unit left in heat on its remote also sets cool', async () => {
    const { part, accessory, sent } = make('DEVICE_AIR_CONDITIONER', acThreeModes(), 'AC', true, { acModes: 'cool' });
    part.update({ ...acOn, operation: { airConOperationMode: 'POWER_OFF' }, airConJobMode: { currentJobMode: 'HEAT' } });
    await write(accessory.getServiceById(S.HeaterCooler, 'climate')!.getCharacteristic(C.Active), 1);
    assert.deepEqual(sent, [{ operation: { airConOperationMode: 'POWER_ON' } }, { airConJobMode: { currentJobMode: 'COOL' } }]);
    // Already cooling: just on
    const b = make('DEVICE_AIR_CONDITIONER', acThreeModes(), 'AC', true, { acModes: 'cool' });
    b.part.update({ ...acOn, operation: { airConOperationMode: 'POWER_OFF' } });
    await write(b.accessory.getServiceById(S.HeaterCooler, 'climate')!.getCharacteristic(C.Active), 1);
    assert.deepEqual(b.sent, [{ operation: { airConOperationMode: 'POWER_ON' } }]);
    // A choice the unit can't do is logged
    const c = make('DEVICE_AIR_CONDITIONER', fixture('air_conditioner', 'profile'), 'AC', true, { acModes: 'heat' });
    assert.ok(c.lines.some((l) => l.startsWith('warn: [AC] Set to heating only, but this unit has no heat mode')));
  });

  // ---- From Home Assistant's and LG's issue reports ----

  test('air conditioner fan speed: windStrength when the unit has it (it has Auto), windStrengthDetail only otherwise', async () => {
    const base = (airFlow: Record<string, unknown>) => ({ property: {
      operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airConJobMode: { currentJobMode: en(['COOL']) },
      temperature: { targetTemperature: range(16, 30) }, airFlow } });
    const both = make('DEVICE_AIR_CONDITIONER', base({ windStrength: en(['LOW', 'MID', 'HIGH', 'AUTO']), windStrengthDetail: en(['NATURE', 'LOW', 'LOW_MID', 'MID', 'HIGH', 'POWER']) }), 'AC');
    both.part.update({ operation: { airConOperationMode: 'POWER_ON' }, airFlow: { windStrength: 'AUTO', windStrengthDetail: 'LOW' } });
    const tile = both.accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(val(tile.getCharacteristic(C.RotationSpeed)), 100, 'Auto, from windStrength');
    await write(tile.getCharacteristic(C.RotationSpeed), 25);
    assert.deepEqual(both.sent, [{ airFlow: { windStrength: 'LOW' } }]);
    const detail = make('DEVICE_AIR_CONDITIONER', base({ windStrengthDetail: en(['LOW', 'MID', 'HIGH', 'POWER']) }), 'AC');
    detail.part.update({ operation: { airConOperationMode: 'POWER_ON' }, airFlow: { windStrengthDetail: 'MID' } });
    const t2 = detail.accessory.getServiceById(S.HeaterCooler, 'climate')!;
    assert.equal(val(t2.getCharacteristic(C.RotationSpeed)), 67);
    await write(detail.accessory.getServiceById(S.Switch, 'jet')!.getCharacteristic(C.On), true);
    assert.deepEqual(detail.sent, [{ airFlow: { windStrengthDetail: 'POWER' } }]);
  });

  test('air conditioner: airflow styles as switches, errors on the problem sensor, a mode picked while off switches it on', async () => {
    const { part, accessory, sent, lines } = make('DEVICE_AIR_CONDITIONER', { property: {
      operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airConJobMode: { currentJobMode: en(['COOL', 'HEAT']) },
      runState: { currentState: en(['NORMAL', 'ERROR'], ['r']) },
      temperature: { targetTemperature: range(16, 30) },
      windDirection: { forestWind: { type: 'boolean', mode: ['r', 'w'] }, mannerWind: { type: 'boolean', mode: ['r'] } },
    } }, 'AC');
    part.update({ operation: { airConOperationMode: 'POWER_OFF' }, airConJobMode: { currentJobMode: 'COOL' }, runState: { currentState: 'NORMAL' },
      windDirection: { forestWind: true } });
    const forest = accessory.getServiceById(S.Switch, 'wind-forestWind')!;
    assert.equal(forest.getCharacteristic(C.Name).value, 'AC Forest Wind');
    assert.equal(val(forest.getCharacteristic(C.On)), true);
    assert.equal(accessory.getServiceById(S.Switch, 'wind-mannerWind'), undefined, 'read-only: no switch');
    await write(forest.getCharacteristic(C.On), false);
    assert.deepEqual(sent.splice(0), [{ windDirection: { forestWind: false } }]);
    // A mode chosen on the tile while it's off: on, then the mode (and turning it on in the same action sends nothing more)
    const tile = accessory.getServiceById(S.HeaterCooler, 'climate')!;
    await Promise.all([write(tile.getCharacteristic(C.TargetHeaterCoolerState), C.TargetHeaterCoolerState.HEAT), write(tile.getCharacteristic(C.Active), 1)]);
    assert.deepEqual(sent.splice(0), [{ operation: { airConOperationMode: 'POWER_ON' } }, { airConJobMode: { currentJobMode: 'HEAT' } }]);
    // An error reported by the unit
    part.update({ runState: { currentState: 'ERROR' } });
    const problem = accessory.getServiceById(S.ContactSensor, 'problem')!;
    assert.equal(val(problem.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    assert.ok(lines.includes('warn: [AC] The air conditioner reports an error.'));
    part.update({ runState: { currentState: 'NORMAL' } });
    assert.equal(val(problem.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_DETECTED);
  });

  test('humidifier: auto, sleep, hygiene dry, warm mist, mood lamp and display light switches; temperature and air quality', async () => {
    const { part, accessory, sent } = make('DEVICE_HUMIDIFIER', { property: {
      operation: { humidifierOperationMode: en(['POWER_ON', 'POWER_OFF']), autoMode: en(['AUTO_ON', 'AUTO_OFF']), sleepMode: en(['SLEEP_ON', 'SLEEP_OFF']),
        hygieneDryMode: en(['ON', 'OFF']) },
      humidity: { targetHumidity: range(30, 70, 5), warmMode: en(['WARM_ON', 'WARM_OFF']) },
      moodLamp: { moodLampState: en(['MOODLAMP_ON', 'MOODLAMP_OFF']) },
      display: { light: en(['ON', 'OFF']) },
      airQualitySensor: { PM2: { type: 'number', mode: ['r'] }, temperature: { type: 'number', mode: ['r'] }, humidity: { type: 'number', mode: ['r'] } },
    } }, 'Humidifier');
    part.update({ operation: { humidifierOperationMode: 'POWER_ON', autoMode: 'AUTO_ON', sleepMode: 'SLEEP_OFF' },
      humidity: { warmMode: 'WARM_ON' }, moodLamp: { moodLampState: 'MOODLAMP_OFF' },
      airQualitySensor: { PM2: 9, temperature: 20.5, humidity: 41 } });
    const sw = (sub: string) => accessory.getServiceById(S.Switch, sub)!;
    assert.deepEqual(['auto-mode', 'sleep-mode', 'hygiene-dry', 'warm', 'mood-lamp', 'display-light'].map((x) => !!accessory.getServiceById(S.Switch, x)), [true, true, true, true, true, true]);
    assert.equal(val(sw('auto-mode').getCharacteristic(C.On)), true);
    assert.equal(val(sw('warm').getCharacteristic(C.On)), true);
    await write(sw('mood-lamp').getCharacteristic(C.On), true);
    await write(sw('sleep-mode').getCharacteristic(C.On), true);
    assert.deepEqual(sent, [{ moodLamp: { moodLampState: 'MOODLAMP_ON' } }, { operation: { sleepMode: 'SLEEP_ON' } }]);
    assert.equal(val(accessory.getServiceById(S.TemperatureSensor, 'temperature')!.getCharacteristic(C.CurrentTemperature)), 20.5);
    assert.equal(val(accessory.getServiceById(S.AirQualitySensor, 'air-quality')!.getCharacteristic(C.PM2_5Density)), 9);
    assert.equal(val(accessory.getServiceById(S.HumidifierDehumidifier, 'humidity')!.getCharacteristic(C.CurrentRelativeHumidity)), 41);
    assert.equal(accessory.getServiceById(S.HumiditySensor, 'humidity'), undefined, 'humidity is on the tile');
  });

  test('ventilator: CO2 (with HomeKit\'s alarm above 1,000 ppm), air quality and temperature', () => {
    const { part, accessory } = make('DEVICE_VENTILATOR', { property: {
      operation: { ventOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      airFlow: { windStrength: en(['LOW', 'MID', 'HIGH']) },
      temperature: { currentTemperature: { type: 'number', mode: ['r'] }, unit: en(['C'], ['r']) },
      airQualitySensor: { CO2: { type: 'number', mode: ['r'] }, PM2: { type: 'number', mode: ['r'] }, PM10: { type: 'number', mode: ['r'] } },
    } }, 'Vent');
    part.update({ operation: { ventOperationMode: 'POWER_ON' }, temperature: { currentTemperature: 21, unit: 'C' }, airQualitySensor: { CO2: 1250, PM2: 12, PM10: 20 } });
    const co2 = accessory.getServiceById(S.CarbonDioxideSensor, 'co2')!;
    assert.equal(val(co2.getCharacteristic(C.CarbonDioxideLevel)), 1250);
    assert.equal(val(co2.getCharacteristic(C.CarbonDioxideDetected)), 1);
    part.update({ airQualitySensor: { CO2: 600 } });
    assert.equal(val(co2.getCharacteristic(C.CarbonDioxideDetected)), 0);
    assert.equal(val(accessory.getServiceById(S.TemperatureSensor, 'temperature')!.getCharacteristic(C.CurrentTemperature)), 21);
    assert.equal(val(accessory.getServiceById(S.AirQualitySensor, 'air-quality')!.getCharacteristic(C.PM10Density)), 20);
  });

  test('fridge: power saving and sabbath mode as status when LG doesn\'t let them be changed; three water filters and the air filter', async () => {
    const { part, accessory, sent } = make('DEVICE_REFRIGERATOR', { property: {
      powerSave: { powerSaveEnabled: { type: 'boolean', mode: ['r', 'w'] } },
      sabbath: { sabbathMode: { type: 'boolean', mode: ['r'], value: { r: [false, true] } } },
      waterFilterInfo: { waterFilter1RemainPercent: { type: 'number', mode: ['r'] }, waterFilter2RemainPercent: { type: 'number', mode: ['r'] },
        waterFilter3RemainPercent: { type: 'number', mode: ['r'] } },
      refrigeration: { freshAirFilterRemainPercent: { type: 'number', mode: ['r'] } },
    } }, 'Fridge');
    part.update({ powerSave: { powerSaveEnabled: false }, sabbath: { sabbathMode: true },
      waterFilterInfo: { waterFilter1RemainPercent: 80, waterFilter2RemainPercent: 8, waterFilter3RemainPercent: 50 }, refrigeration: { freshAirFilterRemainPercent: 30 } });
    assert.equal(val(accessory.getServiceById(S.OccupancySensor, 'status-sabbathMode')!.getCharacteristic(C.OccupancyDetected)), 1);
    assert.equal(accessory.getServiceById(S.Switch, 'switch-sabbathMode'), undefined);
    await write(accessory.getServiceById(S.Switch, 'switch-powerSaveEnabled')!.getCharacteristic(C.On), true);
    assert.deepEqual(sent, [{ powerSave: { powerSaveEnabled: true } }]);
    const filters = accessory.services.filter((x) => x.UUID === S.FilterMaintenance.UUID);
    assert.deepEqual(filters.map((f) => [f.getCharacteristic(C.Name).value, f.getCharacteristic(C.FilterLifeLevel).value]),
      [['Fridge Water Filter', 80], ['Fridge Water Filter 2', 8], ['Fridge Water Filter 3', 50], ['Fridge Air Filter', 30]]);
    assert.equal(val(filters[1].getCharacteristic(C.FilterChangeIndication)), C.FilterChangeIndication.CHANGE_FILTER);
    assert.equal(filters[0].subtype, 'filter', 'the first keeps the subtype it had');
  });

  test('wine cellar: optimal humidity switch, sabbath status, and the light (refused while LG blocks light control)', async () => {
    const { part, accessory, sent, lines } = make('DEVICE_WINE_CELLAR', { property: {
      operation: { lightStatus: range(0, 100, 1), optimalHumidity: en(['ON', 'OFF']), sabbathMode: en(['ON', 'OFF'], ['r']) },
    } }, 'Wine');
    part.update({ operation: { lightStatus: 50, lightStatusControlEnabled: true, optimalHumidity: 'OFF', sabbathMode: 'ON' } });
    const light = accessory.getServiceById(S.Lightbulb, 'light')!;
    assert.equal(val(light.getCharacteristic(C.Brightness)), 50);
    await write(light.getCharacteristic(C.Brightness), 80);
    await write(accessory.getServiceById(S.Switch, 'switch-optimalHumidity')!.getCharacteristic(C.On), true);
    assert.deepEqual(sent.splice(0), [{ operation: { lightStatus: 80 } }, { operation: { optimalHumidity: 'ON' } }]);
    assert.equal(val(accessory.getServiceById(S.OccupancySensor, 'status-sabbathMode')!.getCharacteristic(C.OccupancyDetected)), 1);
    part.update({ operation: { lightStatusControlEnabled: false } });
    assert.ok(await write(light.getCharacteristic(C.On), false));
    assert.equal(sent.length, 0);
    assert.ok(lines.some((l) => l.includes('light control is off on the wine cellar')));
  });

  test('water heater: its modes as switches (off goes back to auto)', async () => {
    const { part, accessory, sent } = make('DEVICE_WATER_HEATER', { property: {
      operation: { waterHeaterOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      waterHeaterJobMode: { currentJobMode: en(['AUTO', 'HEAT_PUMP', 'TURBO', 'VACATION']) },
      temperatureInUnits: [{ unit: 'C', targetTemperature: range(30, 60) }],
    } }, 'Water');
    part.update({ operation: { waterHeaterOperationMode: 'POWER_ON' }, waterHeaterJobMode: { currentJobMode: 'TURBO' } });
    const turbo = accessory.getServiceById(S.Switch, 'mode-TURBO')!;
    assert.equal(val(turbo.getCharacteristic(C.On)), true);
    assert.equal(accessory.getServiceById(S.Switch, 'mode-AUTO'), undefined);
    assert.equal(accessory.getServiceById(S.Switch, 'mode-HEAT_PUMP')!.getCharacteristic(C.Name).value, 'Water Heat Pump');
    await write(turbo.getCharacteristic(C.On), false);
    await write(accessory.getServiceById(S.Switch, 'mode-VACATION')!.getCharacteristic(C.On), true);
    assert.deepEqual(sent, [{ waterHeaterJobMode: { currentJobMode: 'AUTO' } }, { waterHeaterJobMode: { currentJobMode: 'VACATION' } }]);
  });

  test('cooktop: burner levels and time left in the log; stick vacuum: battery and charging; kimchi fridge words aren\'t temperatures', () => {
    const cook = make('DEVICE_COOKTOP', cooktopProfile(), 'Cooktop');
    cook.part.update([{ ...zone('LEFT_FRONT', 'COOK'), power: { powerLevel: 7 }, timer: { remainHour: 0, remainMinute: 12 } }]);
    assert.ok(cook.lines.includes('info: [Cooktop] On: left front (level 7, 12 min left).'));
    const stick = make('DEVICE_STICK_CLEANER', { property: { runState: { currentState: en(['CHARGING', 'STANDBY'], ['r']) },
      battery: { level: en(['LOW', 'MID', 'HIGH'], ['r']), percent: { type: 'number', mode: ['r'] } } } }, 'Stick');
    stick.part.update({ runState: { currentState: 'CHARGING' }, battery: { percent: 64 } });
    const battery = stick.accessory.getServiceById(S.Battery, 'battery')!;
    assert.deepEqual([val(battery.getCharacteristic(C.BatteryLevel)), val(battery.getCharacteristic(C.ChargingState))], [64, 1]);
    stick.part.update({ runState: { currentState: 'STANDBY' }, battery: { level: 'LOW' } });
    assert.deepEqual([val(battery.getCharacteristic(C.BatteryLevel)), val(battery.getCharacteristic(C.StatusLowBattery))], [20, 1]);
    // Kimchi fridges report compartment modes where a temperature might be: the basic tile ignores them
    const kimchi = make('DEVICE_KIMCHI_REFRIGERATOR', { property: { temperature: [{ locationName: 'TOP', targetTemperature: en(['KIMCHI', 'FREEZER'], ['r']) }],
      operation: { kimchiOperationMode: en(['POWER_ON', 'POWER_OFF']) } } }, 'Kimchi');
    assert.doesNotThrow(() => kimchi.part.update({ temperature: [{ locationName: 'TOP', targetTemperature: 'KIMCHI' }], operation: { kimchiOperationMode: 'POWER_ON' } }));
  });

  test('air conditioner: a scene switching it off while setting a mode leaves it off; one write\'s failure is shared', async () => {
    const profile = { property: {
      operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airConJobMode: { currentJobMode: en(['COOL', 'HEAT']) },
      temperature: { targetTemperature: range(16, 30) } } };
    const T = C.TargetHeaterCoolerState;
    const tileOf = (a: PlatformAccessory) => a.getServiceById(S.HeaterCooler, 'climate')!;
    // Unit on; "off, heating" in one action, in either order: only POWER_OFF
    for (const order of ['active-first', 'mode-first']) {
      const a = make('DEVICE_AIR_CONDITIONER', profile, 'AC');
      a.part.update({ operation: { airConOperationMode: 'POWER_ON' }, airConJobMode: { currentJobMode: 'COOL' } });
      const writes = [() => write(tileOf(a.accessory).getCharacteristic(C.Active), 0), () => write(tileOf(a.accessory).getCharacteristic(T), T.HEAT)];
      if (order === 'mode-first') { writes.reverse(); }
      await Promise.all(writes.map((w) => w()));
      await new Promise((r) => setTimeout(r, 250));
      assert.ok(!a.sent.some((p) => JSON.stringify(p).includes('POWER_ON')), order);
      assert.ok(a.sent.some((p) => JSON.stringify(p).includes('POWER_OFF')), order);
    }
    // Unit off; "off, heating": nothing at all
    const b = make('DEVICE_AIR_CONDITIONER', profile, 'AC');
    b.part.update({ operation: { airConOperationMode: 'POWER_OFF' }, airConJobMode: { currentJobMode: 'COOL' } });
    await Promise.all([write(tileOf(b.accessory).getCharacteristic(C.Active), 0), write(tileOf(b.accessory).getCharacteristic(T), T.HEAT)]);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(b.sent, []);
    // Unit off; only a mode picked: on, then the mode, once
    const c = make('DEVICE_AIR_CONDITIONER', profile, 'AC');
    c.part.update({ operation: { airConOperationMode: 'POWER_OFF' }, airConJobMode: { currentJobMode: 'COOL' } });
    await write(tileOf(c.accessory).getCharacteristic(T), T.HEAT);
    assert.deepEqual(c.sent, [{ operation: { airConOperationMode: 'POWER_ON' } }, { airConJobMode: { currentJobMode: 'HEAT' } }]);
    // Unit off; on first, then the mode: on, mode once
    const d = make('DEVICE_AIR_CONDITIONER', profile, 'AC');
    d.part.update({ operation: { airConOperationMode: 'POWER_OFF' }, airConJobMode: { currentJobMode: 'COOL' } });
    await Promise.all([write(tileOf(d.accessory).getCharacteristic(C.Active), 1), write(tileOf(d.accessory).getCharacteristic(T), T.HEAT)]);
    assert.deepEqual(d.sent, [{ operation: { airConOperationMode: 'POWER_ON' } }, { airConJobMode: { currentJobMode: 'HEAT' } }]);
    // LG refusing the power-on: both writes of the action report it, and the tile shows off again
    const e = make('DEVICE_AIR_CONDITIONER', profile, 'AC');
    e.part.update({ operation: { airConOperationMode: 'POWER_OFF' }, airConJobMode: { currentJobMode: 'COOL' } });
    e.failNext(new Error('LG says no'));
    const results = await Promise.all([write(tileOf(e.accessory).getCharacteristic(T), T.HEAT), write(tileOf(e.accessory).getCharacteristic(C.Active), 1)]);
    assert.ok(results[1] !== undefined, 'the on write reports the failure');
    e.part.update(undefined);
    assert.equal(val(tileOf(e.accessory).getCharacteristic(C.Active)), C.Active.INACTIVE);
  });

  test('water heater: switching off a mode that isn\'t on changes nothing; wine light kept within LG\'s range', async () => {
    const { part, accessory, sent } = make('DEVICE_WATER_HEATER', { property: {
      operation: { waterHeaterOperationMode: en(['POWER_ON', 'POWER_OFF']) },
      waterHeaterJobMode: { currentJobMode: en(['AUTO', 'HEAT_PUMP', 'TURBO']) },
      temperatureInUnits: [{ unit: 'C', targetTemperature: range(30, 60) }] } }, 'Water');
    part.update({ operation: { waterHeaterOperationMode: 'POWER_ON' }, waterHeaterJobMode: { currentJobMode: 'HEAT_PUMP' } });
    await write(accessory.getServiceById(S.Switch, 'mode-TURBO')!.getCharacteristic(C.On), false);
    assert.deepEqual(sent, []);
    const wine = make('DEVICE_WINE_CELLAR', { property: { operation: { lightStatus: range(1, 10, 1) } } }, 'Wine');
    wine.part.update({ operation: { lightStatus: 5 } });
    await write(wine.accessory.getServiceById(S.Lightbulb, 'light')!.getCharacteristic(C.On), false);
    await write(wine.accessory.getServiceById(S.Lightbulb, 'light')!.getCharacteristic(C.Brightness), 100);
    assert.deepEqual(wine.sent, [{ operation: { lightStatus: 1 } }, { operation: { lightStatus: 10 } }], 'off means the lowest level LG allows');
  });

  test('basic fallback: an LG alert opens the problem sensor, and it closes again on its own', () => {
    const { part, accessory } = make('DEVICE_PLANT_CULTIVATOR', { property: { operation: { operationMode: en(['POWER_ON', 'POWER_OFF']) } } });
    const problem = () => accessory.getServiceById(S.ContactSensor, 'problem')!.getCharacteristic(C.ContactSensorState).value;
    const on = { operation: { operationMode: 'POWER_ON' } };
    part.update(on);
    part.alert('problem', 'SOMETHING_ERROR');
    assert.equal(problem(), C.ContactSensorState.CONTACT_NOT_DETECTED);
    part.update(on);
    part.update(on);
    assert.equal(problem(), C.ContactSensorState.CONTACT_NOT_DETECTED);
    part.update(on);
    assert.equal(problem(), C.ContactSensorState.CONTACT_DETECTED, 'closed after three normal checks');
    part.alert('problem', 'SOMETHING_ERROR');
    part.update({ operation: { operationMode: 'POWER_OFF' } });
    assert.equal(problem(), C.ContactSensorState.CONTACT_DETECTED, 'closed when switched off');
  });

  /* eslint-disable no-console -- HAP prints value warnings to the console */
  test('every Home Assistant sample appliance is set up without HAP warnings about its values', () => {
    const warnings: string[] = [];
    const orig = { warn: console.warn, log: console.log };
    const catchWarning = (...a: unknown[]) => { const m = a.map(String).join(' '); if (/illegal value|not contained|exceeded/.test(m)) { warnings.push(m); } };
    console.warn = catchWarning;
    console.log = catchWarning;
    try {
      for (const name of readdirSync(join(__dirname, 'fixtures', 'ha')).filter((n) => existsSync(join(__dirname, 'fixtures', 'ha', n, 'device.json')))) {
        const info = fixture(name, 'device') as { deviceInfo?: { deviceType: string }; deviceType?: string };
        const type = info.deviceInfo?.deviceType || info.deviceType || '';
        const profile = fixture(name, 'profile');
        if (!mappingFor(type, profile)) { continue; }
        const { part, accessory } = make(type, profile);
        accessory.on('characteristic-warning' as never, ((w: { message: string }) => warnings.push(`${name}: ${w.message}`)) as never);
        part.update(fixture(name, 'status'));
      }
    } finally {
      Object.assign(console, orig);
    }
    assert.deepEqual(warnings, []);
  });
  /* eslint-enable no-console */
}
