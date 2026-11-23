// "Checked" against Home Assistant: Home Assistant's LG integration ships captured answers from
// real LG appliances (test/fixtures/ha) and snapshots of exactly what it shows for each one
// (test/fixtures/ha/snapshots, its *.ambr files, copied unchanged). This test feeds the same answers
// to this plugin and compares what the Home app gets with what Home Assistant shows, value by value.
// The expectations are read from Home Assistant's snapshot files, so updating them from Home
// Assistant updates this test. Intentional differences are listed (DIFFERENCES) with the reason.
//
// An appliance type is "checked" (src/support.ts) only if it has comparisons here that pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { API, Characteristic, Logging, PlatformAccessory } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { type ApplianceContext, mappingFor } from '../src/appliances';
import { LaundryAccessory, type LaundryContext } from '../src/accessory';
import { laundryStatus, laundryUnits } from '../src/laundry';
import { SUPPORT } from '../src/support';
import { levelFor, speedLevels } from '../src/appliances/profile';

type Hap = typeof HapNodejs;
let hap: Hap | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch { /* reported by the other HAP tests */ }

const DIR = join(__dirname, 'fixtures', 'ha');
const json = (name: string, file: string): unknown => JSON.parse(readFileSync(join(DIR, name, `${file}.json`), 'utf8'));

interface Shown { state: string; attrs: Record<string, string> }

/** Home Assistant's snapshots: fixture → entity → state and attributes (as written in the .ambr files). */
export function readSnapshots(): Map<string, Map<string, Shown>> {
  const out = new Map<string, Map<string, Shown>>();
  for (const file of readdirSync(join(DIR, 'snapshots')).filter((f) => f.endsWith('.ambr'))) {
    for (const block of readFileSync(join(DIR, 'snapshots', file), 'utf8').split('# ---')) {
      const m = /# name: \w+\[(\w+)\]\[([\w.]+)-state\]/.exec(block);
      if (!m) { continue; }
      const state = /'state': '([^']*)'/.exec(block)?.[1] ?? '';
      const attrs: Record<string, string> = {};
      for (const [, k, v] of block.matchAll(/<[^>]*: '(\w+)'>: ([^,\n]+),/g)) { attrs[k] = v.replace(/^'(.*)'$/, '$1'); }
      if (!out.has(m[1])) { out.set(m[1], new Map()); }
      out.get(m[1])!.set(m[2], { state, attrs });
    }
  }
  return out;
}

/** Where this plugin deliberately shows something else, and why. */
export const DIFFERENCES: Record<string, string> = {
  'air_conditioner2 climate fan_mode':
    'Home Assistant reads windStrengthDetail when a unit has both fields; that loses Auto (LG pythinqconnect #43), so this plugin reads windStrength.',
};

const fToC = (f: number) => (f - 32) * 5 / 9;
/** A temperature Home Assistant shows, in °C (its tests run in °F). */
const tempC = (s: Shown, attr: string): number => {
  const v = Number(s.attrs[attr]);
  return /FAHRENHEIT/.test(s.attrs.temperature_unit || '') ? fToC(v) : v;
};
/** Home Assistant's fan mode names for LG's fan speeds. */
const HA_FAN: Record<string, string> = { LOW: 'low', MID: 'medium', HIGH: 'high', AUTO: 'auto', MID_HIGH: 'mid_high', LOW_MID: 'low_mid', NATURE: 'nature', POWER: 'power' };

function defineTests(hap: Hap): void {
  const { Service: S, Characteristic: C } = hap;
  const snaps = readSnapshots();
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, () => {}])) as unknown as Logging;
  const api = { hap } as unknown as API;
  const accessoryFor = (name: string) => Object.assign(new hap.Accessory(name, hap.uuid.generate(name)), { context: {} }) as unknown as PlatformAccessory<LaundryContext>;
  const appliance = (fixture: string) => {
    const device = json(fixture, 'device') as { deviceInfo: { deviceType: string } };
    const profile = json(fixture, 'profile');
    const accessory = accessoryFor(fixture);
    const ctx: ApplianceContext = { log, api, accessory, name: fixture, serial: 'S',
      device: { deviceId: fixture, deviceInfo: { deviceType: device.deviceInfo.deviceType, alias: fixture, modelName: '' } },
      send: () => Promise.resolve({}), refreshSoon: () => {}, extraControls: true };
    const part = mappingFor(device.deviceInfo.deviceType, profile)!.create(ctx, profile);
    part.update(json(fixture, 'status'));
    return accessory;
  };
  // The appliance types actually compared with something Home Assistant shows, as the tests run
  const compared = new Set<string>();
  const shown = (fixture: string, entity: string): Shown => {
    const s = snaps.get(fixture)?.get(entity);
    assert.ok(s, `Home Assistant's snapshot has ${entity} for ${fixture}`);
    compared.add((json(fixture, 'device') as { deviceInfo: { deviceType: string } }).deviceInfo.deviceType);
    return s;
  };
  const val = (ch: Characteristic) => ch.value as number;
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 0.6, `${what}: this plugin ${a}, Home Assistant ${b}`);

  for (const fixture of ['air_conditioner', 'air_conditioner1', 'air_conditioner2']) {
    test(`checked against Home Assistant: ${fixture} (real sample)`, () => {
      const acc = appliance(fixture);
      const ha = shown(fixture, `climate.test_${fixture}`);
      const tile = acc.getServiceById(S.HeaterCooler, 'climate')!;
      assert.equal(val(tile.getCharacteristic(C.Active)) === 1, ha.state !== 'off', 'on/off');
      const modes: Record<string, number> = { cool: C.TargetHeaterCoolerState.COOL, heat: C.TargetHeaterCoolerState.HEAT, heat_cool: C.TargetHeaterCoolerState.AUTO };
      if (modes[ha.state] !== undefined) { assert.equal(val(tile.getCharacteristic(C.TargetHeaterCoolerState)), modes[ha.state], 'mode'); }
      near(val(tile.getCharacteristic(C.CurrentTemperature)), tempC(ha, 'current_temperature'), 'room temperature');
      near(val(tile.getCharacteristic(C.CoolingThresholdTemperature)), tempC(ha, 'temperature'), 'set temperature');
      near(tile.getCharacteristic(C.CoolingThresholdTemperature).props.minValue!, tempC(ha, 'min_temp'), 'lowest set temperature');
      near(tile.getCharacteristic(C.CoolingThresholdTemperature).props.maxValue!, tempC(ha, 'max_temp'), 'highest set temperature');
      if (ha.attrs.fan_mode && !DIFFERENCES[`${fixture} climate fan_mode`]) {
        // The speed the Home app shows, turned back into LG's level, is the one Home Assistant shows
        const profile = json(fixture, 'profile') as { property: { airFlow?: Record<string, never> } };
        const levels = speedLevels(profile.property.airFlow?.windStrength);
        const level = levelFor(levels, val(tile.getCharacteristic(C.RotationSpeed)));
        assert.equal(HA_FAN[level], ha.attrs.fan_mode, `fan speed: this plugin ${level}, Home Assistant ${ha.attrs.fan_mode}`);
      }
      if (ha.attrs.swing_mode) {
        assert.equal(val(tile.getCharacteristic(C.SwingMode)) === 1, ha.attrs.swing_mode === 'on', 'swing');
      }
      if (ha.attrs.swing_horizontal_mode) {
        const lr = acc.getServiceById(S.Switch, 'swing-left-right');
        assert.ok(lr, 'left-right swing has a switch');
        assert.equal(lr.getCharacteristic(C.On).value, ha.attrs.swing_horizontal_mode === 'on', 'left-right swing');
      }
      if (ha.attrs.current_humidity) {
        assert.equal(val(acc.getServiceById(S.HumiditySensor, 'humidity')!.getCharacteristic(C.CurrentRelativeHumidity)), Number(ha.attrs.current_humidity), 'humidity');
      }
      // Its switches and sensors
      const sw = (entity: string, sub: string) => {
        const s = snaps.get(fixture)?.get(entity);
        if (!s) { return; }
        assert.equal(acc.getServiceById(S.Switch, sub)?.getCharacteristic(C.On).value, s.state === 'on', entity);
      };
      sw(`switch.test_${fixture}_air_purify`, 'air-purify');
      sw(`switch.test_${fixture}_energy_saving`, 'energy-saving');
      const sensor = (entity: string, read: () => number | undefined) => {
        const s = snaps.get(fixture)?.get(entity);
        if (!s || !/^-?\d/.test(s.state)) { return; }
        assert.equal(read(), Number(s.state), entity);
      };
      const aq = acc.getServiceById(S.AirQualitySensor, 'air-quality');
      sensor(`sensor.test_${fixture}_pm2_5`, () => aq?.getCharacteristic(C.PM2_5Density).value as number);
      sensor(`sensor.test_${fixture}_pm10`, () => aq?.getCharacteristic(C.PM10Density).value as number);
    });
  }

  test('checked against Home Assistant: dehumidifier (real sample)', () => {
    const acc = appliance('dehumidifier');
    const ha = shown('dehumidifier', 'humidifier.test_dehumidifier');
    const tile = acc.getServiceById(S.HumidifierDehumidifier, 'humidity')!;
    assert.equal(val(tile.getCharacteristic(C.Active)) === 1, ha.state === 'on', 'on/off');
    assert.equal(val(tile.getCharacteristic(C.CurrentRelativeHumidity)), Number(ha.attrs.current_humidity), 'humidity now');
    assert.equal(val(tile.getCharacteristic(C.RelativeHumidityDehumidifierThreshold)), Number(ha.attrs.humidity), 'target humidity');
    assert.equal(tile.getCharacteristic(C.RelativeHumidityDehumidifierThreshold).props.minValue, Number(ha.attrs.min_humidity), 'lowest target');
    assert.equal(tile.getCharacteristic(C.RelativeHumidityDehumidifierThreshold).props.maxValue, Number(ha.attrs.max_humidity), 'highest target');
    assert.equal(val(tile.getCharacteristic(C.CurrentHumidifierDehumidifierState)) === C.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
      /DRYING/.test(ha.attrs.action), 'drying');
  });

  test('checked against Home Assistant: range hood (real sample)', () => {
    const acc = appliance('hood');
    const ha = shown('hood', 'fan.test_hood_hood');
    const fan = acc.getServiceById(S.Fanv2, 'fan')!;
    assert.equal(val(fan.getCharacteristic(C.Active)) === 1, ha.state === 'on', 'fan on');
    assert.equal(val(fan.getCharacteristic(C.RotationSpeed)), Number(ha.attrs.percentage), 'fan speed (%)');
  });

  test('air purifier sample (Home Assistant shows no purifier entities, so not "checked"): on/off from its status', () => {
    const acc = appliance('air_purifier');
    const tile = acc.getServiceById(S.AirPurifier, 'purifier')!;
    const status = json('air_purifier', 'status') as { operation?: { airPurifierOperationMode?: string } };
    assert.equal(val(tile.getCharacteristic(C.Active)) === 1, status.operation?.airPurifierOperationMode === 'POWER_ON', 'on/off');
  });

  test('checked against Home Assistant: washer (real sample)', () => {
    const device = json('washer', 'device') as { deviceInfo: { deviceType: string } };
    const profile = json('washer', 'profile');
    const ha = shown('washer', 'switch.test_washer_power');
    for (const unit of laundryUnits(device.deviceInfo.deviceType, profile)) {
      const acc = accessoryFor(`washer ${unit.location}`);
      const laundry = new LaundryAccessory({ log, api }, acc, unit,
        { name: 'Washer', model: '', serial: 'S', allowControl: false, phaseSensors: [], tubCleanAfter: 0 }, () => Promise.resolve({}));
      const status = laundryStatus(unit, json('washer', 'status'));
      laundry.update(status);
      // Home Assistant's power switch, and the Home app's tile: off and not running, no fault
      assert.equal(status.state !== 'POWER_OFF', ha.state === 'on', 'switched on');
      assert.equal(val(laundry.valve.getCharacteristic(C.Active)), 0, 'not running');
      assert.equal(val(laundry.valve.getCharacteristic(C.StatusFault)), 0, 'no fault');
      laundry.stop();
    }
  });

  test('every "checked" appliance type has passing comparisons with Home Assistant here', () => {
    const checked = Object.entries(SUPPORT).filter(([, s]) => s.level === 'checked').map(([t]) => t);
    assert.deepEqual(checked.filter((t) => !compared.has(t)), []);
  });
}

if (hap) { defineTests(hap); } else { test('checked against Home Assistant', { skip: 'HAP library not loadable' }, () => {}); }
