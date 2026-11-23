// The experimental appliance types on Homebridge's HAP library: what each shows in the Home app,
// and the commands each sends. Air conditioners, the air purifier, dehumidifier and range hood use
// Home Assistant's sample data (test/fixtures/ha); the rest are built from LG's documented
// property names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { API, Characteristic, Logging, PlatformAccessory } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { type ApplianceContext, categoryOf, mappingFor } from '../src/appliances';
import type { LaundryContext } from '../src/accessory';
import { filterPercent } from '../src/appliances/air';
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
  assert.equal(mappingFor('DEVICE_MICROWAVE_OVEN', { property: { lamp: { lampBrightness: range(0, 2) } } })?.label, 'microwave (hood fan and light)');
  assert.equal(mappingFor('DEVICE_MICROWAVE_OVEN', {}), undefined);
  assert.equal(mappingFor('DEVICE_COOKTOP', { property: { operation: { operationMode: en(['POWER_ON', 'POWER_OFF']) } } })?.label, 'appliance (basic)');
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

  function make(deviceType: string, profile: unknown, alias = 'Thing') {
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
      roomTemperatureInUnits: [{ unit: 'C', airHeatTargetTemperature: range(16, 30) }],
      hotWaterTemperatureInUnits: [{ unit: 'C', targetTemperature: range(30, 60) }],
    } }, 'Heat pump');
    part.update({
      boilerJobMode: { currentJobMode: 'HEAT' },
      operation: { boilerOperationMode: 'POWER_ON', hotWaterMode: 'OFF', roomTempMode: 'AIR' },
      roomTemperatureInUnits: [{ unit: 'C', airCurrentTemperature: 20.5, airHeatTargetTemperature: 21 }],
      hotWaterTemperatureInUnits: [{ unit: 'C', currentTemperature: 42, targetTemperature: 50, minTemperature: 30, maxTemperature: 55 }],
    });
    const room = accessory.getServiceById(S.Thermostat, 'room')!;
    const water = accessory.getServiceById(S.Thermostat, 'hot-water')!;
    assert.equal(val(room.getCharacteristic(C.CurrentTemperature)), 20.5);
    assert.equal(val(room.getCharacteristic(C.TargetTemperature)), 21);
    assert.equal(val(room.getCharacteristic(C.TargetHeatingCoolingState)), C.TargetHeatingCoolingState.HEAT);
    assert.equal(val(water.getCharacteristic(C.TargetHeatingCoolingState)), C.TargetHeatingCoolingState.OFF);
    assert.equal(water.getCharacteristic(C.TargetTemperature).props.maxValue, 55, 'limits from the state');
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
    assert.equal(val(door.getCharacteristic(C.ConfiguredName)), 'Fridge door');
    assert.equal(val(door.getCharacteristic(C.ContactSensorState)), C.ContactSensorState.CONTACT_NOT_DETECTED);
    const freezer = accessory.getServiceById(S.Thermostat, 'temp-FREEZER')!;
    assert.equal(val(freezer.getCharacteristic(C.TargetTemperature)), -18);
    assert.equal(freezer.getCharacteristic(C.TargetTemperature).props.minValue, -23);
    assert.equal(accessory.getServiceById(S.Switch, 'switch-rapidFreeze'), undefined, 'only true/false switches');
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
    const { part, accessory, sent } = make('DEVICE_COOKTOP', { property: {
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
}
