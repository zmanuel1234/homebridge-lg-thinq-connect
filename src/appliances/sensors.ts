// Sensors several appliance types share: air quality (PM2.5, PM10, overall level), humidity from
// an air quality sensor, and filter life. Used by air purifiers and air conditioners.

import type { Service } from 'homebridge';
import { field } from '../api.js';
import { type Appliance, set } from './base.js';
import { type Obj, num } from './profile.js';

/** The appliance's alert codes (profile.notification.push). */
export function alertCodes(profile: unknown): string[] {
  const n = field(field(profile, 'notification'), 'push');
  return Array.isArray(n) ? n.filter((c): c is string => typeof c === 'string') : [];
}

/** Filter life left in percent: filterRemainPercent, or from used and lifetime hours. */
export function filterPercent(state: unknown): number | undefined {
  const info = field(state, 'filterInfo');
  const remain = num(field(info, 'filterRemainPercent')) ?? num(field(info, 'topFilterRemainPercent'));
  if (remain !== undefined) { return Math.max(0, Math.min(100, remain)); }
  const life = num(field(info, 'filterLifetime'));
  const used = num(field(info, 'usedTime'));
  return life && used !== undefined ? Math.max(0, Math.min(100, Math.round(100 * (1 - used / life)))) : undefined;
}

// LG's overall air quality levels, as the Home app's (1 excellent … 5 poor)
const AIR_QUALITY: Record<string, number> = { GOOD: 2, NORMAL: 3, BAD: 4, VERY_BAD: 5 };

type ServiceFn = (type: typeof Service.AirQualitySensor, name: string, subtype: string) => Service;

/** Air quality, humidity and filter services for whatever of these a profile has. */
export class AirSensors {
  readonly quality?: Service;
  readonly humidity?: Service;
  readonly filter?: Service;
  private state: unknown;

  constructor(private readonly owner: Appliance, res: Obj, name: string, service: ServiceFn, keep: Set<string>, withHumidity: boolean) {
    const { Service: S } = owner.hap;
    const aq = res.airQualitySensor && typeof res.airQualitySensor === 'object' ? res.airQualitySensor as Obj : undefined;
    if (aq && (aq.PM2 || aq.PM10 || aq.totalPollutionLevel || aq.totalPollution)) {
      this.quality = service(S.AirQualitySensor, `${name} air quality`, 'air-quality');
      keep.add('air-quality');
    }
    if (withHumidity && aq?.humidity) {
      this.humidity = service(S.HumiditySensor, `${name} humidity`, 'humidity');
      keep.add('humidity');
    }
    if (res.filterInfo) {
      this.filter = service(S.FilterMaintenance, `${name} filter`, 'filter');
      keep.add('filter');
    }
  }

  update(state: unknown): void {
    const { Characteristic: C } = this.owner.hap;
    if (state) { this.state = state; }
    const aq = field(this.state, 'airQualitySensor');
    if (this.quality) {
      const level = field(aq, 'totalPollutionLevel');
      set(this.quality.getCharacteristic(C.AirQuality), typeof level === 'string' ? AIR_QUALITY[level] ?? 0 : 0);
      const pm25 = num(field(aq, 'PM2'));
      const pm10 = num(field(aq, 'PM10'));
      if (pm25 !== undefined) { set(this.quality.getCharacteristic(C.PM2_5Density), Math.min(pm25, 1000)); }
      if (pm10 !== undefined) { set(this.quality.getCharacteristic(C.PM10Density), Math.min(pm10, 1000)); }
    }
    const h = num(field(aq, 'humidity'));
    if (this.humidity && h !== undefined) { set(this.humidity.getCharacteristic(C.CurrentRelativeHumidity), Math.max(0, Math.min(100, h))); }
    const pct = filterPercent(this.state);
    if (this.filter && pct !== undefined) {
      set(this.filter.getCharacteristic(C.FilterLifeLevel), pct);
      set(this.filter.getCharacteristic(C.FilterChangeIndication),
        pct <= 10 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK);
    }
  }
}
