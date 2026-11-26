// The HomeKit surface: every tile and sensor each appliance gets, with its identifier (subtype) and
// characteristics, plus the setting names. People build automations and scenes on these, so 1.x
// never renames or removes one by accident: any change fails this test until it's approved by
// regenerating the snapshot (UPDATE_SURFACE=1 npm test) and noting it in the CHANGELOG. Additions
// are fine in 1.x; renames and removals wait for 2.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { type ApplianceContext, MAPPED_TYPES, mappingFor } from '../src/appliances';
import { LaundryAccessory, type LaundryContext } from '../src/accessory';
import { LAUNDRY_TYPES, laundryUnits } from '../src/laundry';
import { PLUGIN_NAME } from '../src/settings';
import { readSettings } from '../src/platform';
import { realDevices } from './fake-lg';
import schema from '../config.schema.json';

type Hap = typeof HapNodejs;
let hap: Hap | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch { /* the HAP tests elsewhere report why */ }

const SNAPSHOT = join(__dirname, 'surface.snapshot.json');
const en = (values: string[], mode: string[] = ['r', 'w']) => ({ type: 'enum', mode, value: Object.fromEntries(mode.map((m) => [m, values])) });
const range = (min: number, max: number, step = 1, mode: string[] = ['r', 'w']) =>
  ({ type: 'range', mode, value: Object.fromEntries(mode.map((m) => [m, { min, max, step }])) });
const bool = (mode: string[] = ['r', 'w']) => ({ type: 'boolean', mode, value: Object.fromEntries(mode.map((m) => [m, [true, false]])) });
const number = { type: 'number', mode: ['r'] };
const ha = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ha', name, 'profile.json'), 'utf8'));

/** Profiles with every feature each mapping can show (from LG's docs and toolkits, and Home Assistant's samples). */
const APPLIANCES: { name: string; type: string; profile: unknown; options?: ApplianceContext['options']; extraControls?: boolean }[] = [
  { name: 'ha air_conditioner', type: 'DEVICE_AIR_CONDITIONER', profile: ha('air_conditioner') },
  { name: 'ha air_conditioner1', type: 'DEVICE_AIR_CONDITIONER', profile: ha('air_conditioner1') },
  { name: 'ha air_conditioner2', type: 'DEVICE_AIR_CONDITIONER', profile: ha('air_conditioner2') },
  { name: 'ha air_purifier', type: 'DEVICE_AIR_PURIFIER', profile: ha('air_purifier') },
  { name: 'ha dehumidifier', type: 'DEVICE_DEHUMIDIFIER', profile: ha('dehumidifier') },
  { name: 'ha hood', type: 'DEVICE_HOOD', profile: ha('hood') },
  { name: 'air conditioner, everything', type: 'DEVICE_AIR_CONDITIONER', profile: { property: {
    operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']), airCleanOperationMode: en(['START', 'STOP']) },
    airConJobMode: { currentJobMode: en(['COOL', 'HEAT', 'AUTO', 'AIR_DRY', 'FAN']) },
    runState: { currentState: en(['NORMAL', 'ERROR'], ['r']) },
    temperatureInUnits: [{ unit: 'C', targetTemperature: range(16, 30), currentTemperature: number }],
    airFlow: { windStrength: en(['LOW', 'MID', 'HIGH', 'AUTO', 'POWER']) },
    windDirection: { rotateUpDown: bool(), rotateLeftRight: bool(), forestWind: bool(), airGuideWind: bool() },
    powerSave: { powerSaveEnabled: bool() }, display: { light: en(['ON', 'OFF']) },
    airQualitySensor: { PM2: number, PM10: number, totalPollutionLevel: en(['GOOD', 'BAD'], ['r']), humidity: number },
    filterInfo: { filterRemainPercent: number },
  } } },
  { name: 'air conditioner, options', type: 'DEVICE_AIR_CONDITIONER', options: { acModes: 'cool', acSwing: 'both', temperatureSensor: true },
    profile: { property: {
      operation: { airConOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airConJobMode: { currentJobMode: en(['COOL', 'HEAT']) },
      temperature: { targetTemperature: range(16, 30) }, windDirection: { rotateUpDown: bool(), rotateLeftRight: bool() },
    } } },
  { name: 'AeroTower', type: 'DEVICE_AIR_PURIFIER_FAN', profile: { property: {
    operation: { airFanOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airFanJobMode: { currentJobMode: en(['SPACE_CLEAN', 'SLEEP']) },
    airFlow: { windStrength: en(['LOW', 'HIGH', 'POWER']), warmMode: en(['WARM_ON', 'WARM_OFF']) },
    misc: { uvNano: en(['ON', 'OFF']) }, display: { light: en(['ON', 'OFF']) },
    airQualitySensor: { temperature: number, humidity: number, PM2: number },
  } } },
  { name: 'humidifier', type: 'DEVICE_HUMIDIFIER', profile: { property: {
    operation: { humidifierOperationMode: en(['POWER_ON', 'POWER_OFF']), autoMode: en(['AUTO_ON', 'AUTO_OFF']), sleepMode: en(['SLEEP_ON', 'SLEEP_OFF']),
      hygieneDryMode: en(['ON', 'OFF']) },
    humidity: { targetHumidity: range(30, 70, 5), warmMode: en(['WARM_ON', 'WARM_OFF']) },
    moodLamp: { moodLampState: en(['MOODLAMP_ON', 'MOODLAMP_OFF']) }, display: { light: en(['ON', 'OFF']) },
    airFlow: { windStrength: en(['LOW', 'HIGH']) }, airQualitySensor: { PM2: number, temperature: number, humidity: number },
  } } },
  { name: 'ventilator', type: 'DEVICE_VENTILATOR', profile: { property: {
    operation: { ventOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airFlow: { windStrength: en(['LOW', 'MID', 'HIGH']) },
    temperature: { currentTemperature: number }, airQualitySensor: { CO2: number, PM2: number, PM10: number },
  } } },
  { name: 'ceiling fan', type: 'DEVICE_CEILING_FAN', profile: { property: {
    operation: { ceilingfanOperationMode: en(['POWER_ON', 'POWER_OFF']) }, airFlow: { windStrength: en(['LOW', 'MID', 'HIGH']) },
  } } },
  { name: 'microwave', type: 'DEVICE_MICROWAVE_OVEN', profile: { property: {
    runState: { currentState: en(['INITIAL', 'COOKING', 'DONE'], ['r']) }, timer: { remainMinute: number, remainSecond: number },
    ventilation: { fanSpeed: range(0, 4) }, lamp: { lampBrightness: range(0, 2) },
  } } },
  { name: 'cooktop', type: 'DEVICE_COOKTOP', profile: {
    property: ['LEFT_FRONT', 'RIGHT_FRONT'].map((z) => ({ cookingZone: { currentState: en(['INITIAL', 'COOK'], ['r']) },
      location: { locationName: z }, power: { powerLevel: range(0, 9, 1, ['r']) } })),
    extensionProperty: { operation: { operationMode: en(['POWER_OFF'], ['w']) } },
  } },
  { name: 'refrigerator', type: 'DEVICE_REFRIGERATOR', profile: { property: {
    doorStatus: [{ locationName: 'MAIN', doorState: en(['OPEN', 'CLOSE'], ['r']) }],
    temperatureInUnits: [{ locationName: 'FRIDGE', targetTemperatureC: range(1, 7), unit: 'C' }, { locationName: 'FREEZER', targetTemperatureC: range(-23, -15), unit: 'C' }],
    refrigeration: { expressMode: bool(), rapidFreeze: en(['ON', 'OFF']), expressFridge: bool(), freshAirFilterRemainPercent: number },
    ecoFriendly: { ecoFriendlyMode: bool() }, powerSave: { powerSaveEnabled: bool() }, sabbath: { sabbathMode: bool(['r']) },
    waterFilterInfo: { waterFilter1RemainPercent: number, waterFilter2RemainPercent: number, waterFilter3RemainPercent: number },
  } } },
  { name: 'wine cellar', type: 'DEVICE_WINE_CELLAR', profile: { property: {
    temperatureInUnits: [{ locationName: 'WINE_UPPER', targetTemperatureC: range(5, 18), unit: 'C' }],
    operation: { lightStatus: range(0, 100), optimalHumidity: en(['ON', 'OFF']), sabbathMode: en(['ON', 'OFF'], ['r']) },
  } } },
  { name: 'water heater', type: 'DEVICE_WATER_HEATER', profile: { property: {
    operation: { waterHeaterOperationMode: en(['POWER_ON', 'POWER_OFF']) },
    waterHeaterJobMode: { currentJobMode: en(['AUTO', 'HEAT_PUMP', 'TURBO', 'VACATION']) },
    temperatureInUnits: [{ unit: 'C', targetTemperature: range(30, 60), currentTemperature: number }],
  } } },
  { name: 'heat pump', type: 'DEVICE_SYSTEM_BOILER', profile: { property: {
    operation: { boilerOperationMode: en(['POWER_ON', 'POWER_OFF']), hotWaterMode: en(['ON', 'OFF']) },
    boilerJobMode: { currentJobMode: en(['HEAT', 'COOL', 'AUTO']) },
    roomTemperatureInUnits: [{ unit: 'C', airHeatTargetTemperature: range(15, 30), airCurrentTemperature: number }],
    hotWaterTemperatureInUnits: [{ unit: 'C', targetTemperature: range(30, 55), currentTemperature: number }],
  } } },
  { name: 'robot vacuum', type: 'DEVICE_ROBOT_CLEANER', profile: { property: {
    runState: { currentState: en(['CLEANING', 'CHARGING', 'SLEEP'], ['r']) }, operation: { cleanOperationMode: en(['START', 'HOMING'], ['w']) },
    battery: { percent: number },
  } } },
  { name: 'stick vacuum', type: 'DEVICE_STICK_CLEANER', profile: { property: {
    runState: { currentState: en(['CHARGING', 'STANDBY'], ['r']) }, battery: { percent: number },
  } } },
  { name: 'basic (unknown type)', type: 'DEVICE_PLANT_CULTIVATOR', profile: { property: {
    operation: { plantOperationMode: en(['POWER_ON', 'POWER_OFF']) }, temperature: { currentTemperature: number },
  } } },
];

/** Washers, dryers and other cycle appliances, per unit: our own washer and dryer, and LG-documented shapes. */
const LAUNDRY: { name: string; type: string; profile: unknown; tubClean?: number }[] = [
  ...realDevices().map((d) => ({ name: `ours ${String(d.deviceInfo.deviceType)}`, type: String(d.deviceInfo.deviceType), profile: d.profile, tubClean: 30 })),
  { name: 'ha washtower_dryer', type: 'DEVICE_WASHTOWER_DRYER', profile: ha('washtower_dryer') },
  // Other laundry types, built from our washer's and dryer's profiles (same LG fields)
  ...(() => {
    const [washer, dryer] = realDevices();
    return [
      { name: 'washtower (one device)', type: 'DEVICE_WASHTOWER', profile: { washer: washer.profile, dryer: dryer.profile } },
      { name: 'washtower washer', type: 'DEVICE_WASHTOWER_WASHER', profile: washer.profile },
      { name: 'washcombo main', type: 'DEVICE_WASHCOMBO_MAIN', profile: washer.profile },
      { name: 'washcombo mini', type: 'DEVICE_WASHCOMBO_MINI', profile: washer.profile },
      { name: 'styler', type: 'DEVICE_STYLER', profile: dryer.profile },
    ];
  })(),
  { name: 'dishwasher', type: 'DEVICE_DISH_WASHER', profile: { property: {
    runState: { currentState: en(['POWER_OFF', 'RUNNING', 'END'], ['r']) }, operation: { dishWasherOperationMode: en(['START', 'STOP'], ['w']) },
    doorStatus: { doorState: en(['OPEN', 'CLOSE'], ['r']) }, dishWashingStatus: { rinseRefill: bool(['r']) },
  } } },
  { name: 'oven (two cavities)', type: 'DEVICE_OVEN', profile: { property: ['UPPER', 'LOWER'].map((loc) => ({
    location: { locationName: loc }, runState: { currentState: en(['INITIAL', 'COOKING_IN_PROGRESS'], ['r']) },
    operation: { ovenOperationMode: en(['START', 'STOP'], ['w']) }, cook: { cookMode: en(['BAKE'], ['w']) },
    temperature: [{ unit: 'F', targetTemperature: range(170, 550) }, { unit: 'C', targetTemperature: range(80, 285) }],
  })) } },
];

function defineTests(hap: Hap): void {
  const { Service: S } = hap;
  const serviceNames = new Map<string, string>(Object.entries(S).filter(([, v]) => typeof v === 'function' && (v as { UUID?: string }).UUID)
    .map(([k, v]) => [(v as { UUID: string }).UUID, k]));
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, () => {}])) as unknown as Logging;
  const api = { hap } as unknown as API;
  const newAccessory = (name: string) =>
    Object.assign(new hap.Accessory(name, hap.uuid.generate(name)), { context: {} }) as unknown as PlatformAccessory<LaundryContext>;
  const describe = (acc: PlatformAccessory) => acc.services
    .filter((s) => s.UUID !== S.AccessoryInformation.UUID)
    .map((s) => `${serviceNames.get(s.UUID) || s.UUID}/${s.subtype || ''}: ${s.characteristics.map((c) => c.displayName).sort().join(', ')}`)
    .sort();
  // Every tile's name: the appliance's name, then what the tile is in title case
  const lowerCaseNames: string[] = [];
  const checkNames = (acc: PlatformAccessory, base: string) => {
    for (const s of acc.services.filter((x) => x.UUID !== S.AccessoryInformation.UUID)) {
      const shown = String(s.getCharacteristic(hap.Characteristic.ConfiguredName).value || s.getCharacteristic(hap.Characteristic.Name).value || '');
      const rest = shown === base ? '' : shown.startsWith(`${base} `) ? shown.slice(base.length + 1) : `(not after "${base}") ${shown}`;
      if (rest.split(' ').some((w) => /^[a-z]/.test(w)) || rest.startsWith('(')) { lowerCaseNames.push(`${acc.displayName}: ${shown}`); }
    }
  };

  test('HomeKit surface: no tile, sensor, identifier or characteristic changes by accident (see the comment at the top)', () => {
    const surface: Record<string, string[]> = {};
    for (const a of APPLIANCES) {
      const accessory = newAccessory(a.name);
      const ctx: ApplianceContext = {
        log, api, accessory, name: 'Appliance', serial: 'S', device: { deviceId: 'd', deviceInfo: { deviceType: a.type, alias: 'Appliance', modelName: 'M' } },
        send: () => Promise.resolve({}), refreshSoon: () => {}, extraControls: a.extraControls ?? true, options: a.options,
      };
      const mapping = mappingFor(a.type, a.profile);
      assert.ok(mapping, `${a.name}: mapped`);
      mapping.create(ctx, a.profile).stop();
      surface[a.name] = describe(accessory);
      checkNames(accessory, 'Appliance');
    }
    for (const l of LAUNDRY) {
      for (const unit of laundryUnits(l.type, l.profile)) {
        const accessory = newAccessory(`${l.name} ${unit.location}`);
        const laundry = new LaundryAccessory({ log, api }, accessory, unit,
          { name: 'Machine', model: 'M', serial: 'S', allowControl: true, phaseSensors: ['SPINNING'], tubCleanAfter: l.tubClean ?? 0, lintFilterAfter: 5, ventCheckPercent: 30 },
          () => Promise.resolve({}));
        laundry.stop();
        checkNames(accessory, 'Machine');
        surface[`${l.name}${unit.location ? ` ${unit.location}` : ''}`] = describe(accessory);
      }
    }
    assert.deepEqual(lowerCaseNames, [], 'every tile name in title case after the appliance\'s name');
    surface.settings = settingKeys();
    if (process.env.UPDATE_SURFACE === '1') {
      writeFileSync(SNAPSHOT, `${JSON.stringify(surface, null, 2)}\n`);
    }
    assert.ok(existsSync(SNAPSHOT), `${SNAPSHOT} is missing: restore it from git (or record it with UPDATE_SURFACE=1 npm test)`);
    const saved = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string[]>;
    // Removed or changed entries fail; new appliances or entries only fail until the snapshot is updated
    for (const [name, entries] of Object.entries(saved)) {
      assert.ok(surface[name], `"${name}" disappeared from the HomeKit surface`);
      const missing = entries.filter((e) => !surface[name].includes(e));
      assert.deepEqual(missing, [], `"${name}": changed or removed (renames and removals wait for 2.0; additions: UPDATE_SURFACE=1 npm test)`);
    }
    assert.deepEqual(Object.keys(surface).filter((k) => !saved[k]), [], 'new entries: record them with UPDATE_SURFACE=1 npm test');
    for (const name of Object.keys(saved)) {
      assert.deepEqual(surface[name].filter((e) => !saved[name].includes(e)), [], `"${name}": additions not recorded yet (UPDATE_SURFACE=1 npm test)`);
    }
  });
}

/** Every setting name: the settings screen's and what the plugin reads. */
function settingKeys(): string[] {
  const keys = new Set<string>();
  const walk = (props: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(props)) {
      keys.add(`${prefix}${k}`);
      const items = (v as { items?: { properties?: Record<string, unknown> } }).items;
      if (items?.properties) { walk(items.properties, `${prefix}${k}[].`); }
    }
  };
  walk((schema as { schema: { properties: Record<string, unknown> } }).schema.properties, '');
  for (const k of Object.keys(readSettings({ platform: 'LGThinQConnect' }))) { keys.add(`(read) ${k}`); }
  return [...keys].sort();
}

if (hap) { defineTests(hap); } else { test('HomeKit surface', { skip: 'HAP library not loadable' }, () => {}); }

// The accessory IDs: the Home app keys scenes and automations to these, so they never change in 1.x
test('HomeKit surface: accessory IDs are made the same way', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'platform.ts'), 'utf8');
  assert.ok(src.includes('uuid.generate(`${PLUGIN_NAME}:${device.deviceId}:${unit.location}`)'), 'laundry accessory IDs');
  assert.ok(src.includes('uuid.generate(`${PLUGIN_NAME}:${device.deviceId}:`)'), 'other appliances\' accessory IDs');
  assert.equal(PLUGIN_NAME, 'homebridge-lg-thinq-connect');
});

// Every type the plugin maps appears above
test('HomeKit surface covers every mapped appliance type', () => {
  const covered = new Set([...APPLIANCES.map((a) => a.type), ...LAUNDRY.map((l) => l.type)]);
  assert.deepEqual(MAPPED_TYPES.filter((t) => !covered.has(t)), []);
  assert.deepEqual(LAUNDRY_TYPES.filter((t) => !covered.has(t)), [], 'every laundry and cycle type');
});
