// Energy use for the Eve app. The Home app doesn't show energy; Eve (and some other HomeKit apps)
// read Eve's "Total Consumption" characteristic, in kWh. LG reports energy with a delay (often a
// day), so this is this month's use as LG last counted it, checked every hour.

import type { API, Characteristic, Service, WithUUID } from 'homebridge';

export type EveCharacteristic = WithUUID<new () => Characteristic>;

const TOTAL_CONSUMPTION_UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

let cached: EveCharacteristic | undefined;

/** Eve's Total Consumption characteristic (kWh), made once per Homebridge. */
export function totalConsumption(api: API): EveCharacteristic {
  if (cached) { return cached; }
  const { Characteristic: C, Formats, Perms } = api.hap;
  class TotalConsumption extends C {
    static readonly UUID = TOTAL_CONSUMPTION_UUID;
    constructor() {
      super('Total Consumption', TOTAL_CONSUMPTION_UUID, {
        format: Formats.FLOAT, unit: 'kWh', minValue: 0, maxValue: 1_000_000, minStep: 0.001,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = 0;
    }
  }
  cached = TotalConsumption as unknown as EveCharacteristic;
  return cached;
}

/** The service energy goes on: the accessory's main one. */
export function mainService(services: Service[], infoUuid: string): Service | undefined {
  return services.find((s) => s.isPrimaryService) || services.find((s) => s.UUID !== infoUuid);
}

/** YYYYMM for this month, local time. */
export function thisMonth(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}
