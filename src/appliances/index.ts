// Which mapping each LG appliance type gets (beyond laundry and other cycle appliances).
// All of these are experimental: they appear only with the "Experimental appliances" setting on,
// until someone with the appliance confirms them.

import { AirConditioner } from './air-conditioner';
import { AirPurifier, Fan, Hood, HumidityAppliance, Microwave } from './air';
import { Fridge } from './fridge';
import { HeatPump, WaterHeater } from './heating';
import { Basic, RobotVacuum, basicHasSomething } from './other';
import type { ApplianceContext, Part } from './base';
import { resources } from './profile';

export type { ApplianceContext, Part } from './base';

// HomeKit accessory categories (Homebridge's Categories is a const enum, so the numbers are used)
const CATEGORY = { OTHER: 1, FAN: 3, THERMOSTAT: 9, AIR_PURIFIER: 19, AIR_CONDITIONER: 21, AIR_HUMIDIFIER: 22, AIR_DEHUMIDIFIER: 23 } as const;
type CategoryName = keyof typeof CATEGORY;

/** The HomeKit category number for a mapping. */
export function categoryOf(mapping: { category: CategoryName }): number {
  return CATEGORY[mapping.category];
}

interface Mapping {
  /** What it's called in the log. */
  label: string;
  category: CategoryName;
  create(ctx: ApplianceContext, profile: unknown): Part;
}

const MAPPINGS: Record<string, Mapping> = {
  DEVICE_AIR_CONDITIONER: { label: 'air conditioner', category: 'AIR_CONDITIONER', create: (c, p) => new AirConditioner(c, p) },
  DEVICE_AIR_PURIFIER: { label: 'air purifier', category: 'AIR_PURIFIER', create: (c, p) => new AirPurifier(c, p) },
  DEVICE_AIR_PURIFIER_FAN: { label: 'air purifier fan', category: 'AIR_PURIFIER', create: (c, p) => new AirPurifier(c, p) },
  DEVICE_DEHUMIDIFIER: { label: 'dehumidifier', category: 'AIR_DEHUMIDIFIER', create: (c, p) => new HumidityAppliance(c, p, 'dehumidifier') },
  DEVICE_HUMIDIFIER: { label: 'humidifier', category: 'AIR_HUMIDIFIER', create: (c, p) => new HumidityAppliance(c, p, 'humidifier') },
  DEVICE_CEILING_FAN: { label: 'ceiling fan', category: 'FAN', create: (c, p) => new Fan(c, p) },
  DEVICE_VENTILATOR: { label: 'ventilator', category: 'FAN', create: (c, p) => new Fan(c, p) },
  DEVICE_HOOD: { label: 'range hood', category: 'FAN', create: (c, p) => new Hood(c, p) },
  DEVICE_WATER_HEATER: { label: 'water heater', category: 'THERMOSTAT', create: (c, p) => new WaterHeater(c, p) },
  DEVICE_SYSTEM_BOILER: { label: 'heat pump', category: 'THERMOSTAT', create: (c, p) => new HeatPump(c, p) },
  DEVICE_REFRIGERATOR: { label: 'refrigerator', category: 'OTHER', create: (c, p) => new Fridge(c, p) },
  DEVICE_WINE_CELLAR: { label: 'wine cellar', category: 'OTHER', create: (c, p) => new Fridge(c, p) },
  DEVICE_ROBOT_CLEANER: { label: 'robot vacuum', category: 'OTHER', create: (c, p) => new RobotVacuum(c, p) },
};

const BASIC: Mapping = { label: 'appliance (basic)', category: 'OTHER', create: (c, p) => new Basic(c, p) };

/**
 * The mapping for an appliance, or undefined when there is nothing to show yet. Over-the-range
 * microwaves with a fan or light get the range hood mapping (as in Home Assistant).
 */
export function mappingFor(deviceType: string, profile: unknown): Mapping | undefined {
  if (MAPPINGS[deviceType]) { return MAPPINGS[deviceType]; }
  if (deviceType === 'DEVICE_MICROWAVE_OVEN') {
    const res = resources(profile);
    if (res.runState || res.ventilation || res.lamp) {
      return { label: 'microwave', category: 'OTHER', create: (c, p) => new Microwave(c, p) };
    }
  }
  return basicHasSomething(profile) ? BASIC : undefined;
}

/** Appliance types with a mapping of their own (for the README and the log). */
export const MAPPED_TYPES = Object.keys(MAPPINGS);
