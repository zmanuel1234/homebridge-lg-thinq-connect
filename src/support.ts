// How sure we are about each LG appliance type, in three levels:
//  - tested: confirmed on a real appliance by someone using this plugin;
//  - checked: matches Home Assistant's LG integration on captured data from a real appliance
//    (test/ha-parity.test.ts compares, value by value, what each shows);
//  - experimental: built from LG's documentation and its own toolkits, not yet confirmed.
// A type moves up when a user's report (or a new Home Assistant sample) confirms it.

export type SupportLevel = 'tested' | 'checked' | 'experimental';

export const SUPPORT: Record<string, { level: SupportLevel; evidence: string }> = {
  DEVICE_WASHER: { level: 'tested', evidence: 'the author\'s LG washer (and Home Assistant\'s washer sample)' },
  DEVICE_DRYER: { level: 'tested', evidence: 'the author\'s LG dryer' },
  DEVICE_AIR_CONDITIONER: { level: 'checked', evidence: 'Home Assistant\'s three air conditioner samples' },
  DEVICE_DEHUMIDIFIER: { level: 'checked', evidence: 'Home Assistant\'s dehumidifier sample' },
  DEVICE_HOOD: { level: 'checked', evidence: 'Home Assistant\'s range hood sample' },
  DEVICE_AIR_PURIFIER: { level: 'checked', evidence: 'Home Assistant\'s air purifier sample' },
};

/** The support level of an LG appliance type (anything not listed is experimental). */
export function supportLevel(deviceType: string): SupportLevel {
  return SUPPORT[deviceType]?.level ?? 'experimental';
}
