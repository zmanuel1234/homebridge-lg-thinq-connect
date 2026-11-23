import { ThinQClient, ThinQError, type ClientOptions } from '../api';
import { isCycleAppliance, isLaundry } from '../laundry';
import { MAPPED_TYPES } from '../appliances';
import { supportLevel } from '../support';
import { collect } from '../bin/lg-thinq-diagnostics';

/**
 * tested: confirmed on real appliances. checked: matches Home Assistant on real sample data
 * (needs "Experimental appliances"). laundry: other laundry, added without that setting.
 * experimental: needs "Experimental appliances". basic: experimental, and added only if LG
 * reports something useful.
 */
export type Support = 'tested' | 'checked' | 'laundry' | 'experimental' | 'basic';

export interface CheckResult {
  ok: boolean;
  /** One line for the person: what was found, or what went wrong and what to do. */
  message: string;
  appliances: { name: string; type: string; support: Support }[];
}

/** How well this plugin supports an LG appliance type. */
export function supportOf(deviceType: string): Support {
  const level = supportLevel(deviceType);
  if (level === 'tested') { return 'tested'; }
  if (level === 'checked') { return 'checked'; }
  if (isLaundry(deviceType)) { return 'laundry'; }
  if (isCycleAppliance(deviceType) || MAPPED_TYPES.includes(deviceType)
    || deviceType === 'DEVICE_MICROWAVE_OVEN') { return 'experimental'; }
  return 'basic';
}

/** A friendly name for an LG type: DEVICE_WASHTOWER_DRYER → washtower dryer. */
export function typeName(deviceType: string): string {
  return deviceType.replace(/^DEVICE_/, '').replace(/_/g, ' ').toLowerCase();
}

/**
 * Tries a token the way the plugin will use it: lists the appliances on its LG account. Never
 * throws; never returns the token.
 */
export async function checkToken(
  token: unknown, country: unknown,
  makeClient: (o: ClientOptions) => ThinQClient = (o) => new ThinQClient(o),
): Promise<CheckResult> {
  const t = typeof token === 'string' ? token.trim() : '';
  const c = typeof country === 'string' && country.trim() ? country.trim().toUpperCase() : 'US';
  if (!t) {
    return { ok: false, message: 'Paste your personal access token in the Token box first.', appliances: [] };
  }
  let client: ThinQClient;
  try {
    client = makeClient({ token: t, country: c });
  } catch (err) {
    return { ok: false, message: (err as Error).message, appliances: [] };
  }
  let devices;
  try {
    devices = await client.devices();
  } catch (err) {
    const why = (err as Error).message;
    return { ok: false, message: err instanceof ThinQError && err.status ? `LG refused: ${why}` : `Couldn't reach LG: ${why}`, appliances: [] };
  }
  const appliances = devices.map((d) => ({
    name: d.deviceInfo.alias || typeName(d.deviceInfo.deviceType),
    type: d.deviceInfo.deviceType,
    support: supportOf(d.deviceInfo.deviceType),
  }));
  const message = appliances.length
    ? `Signed in to LG (${c}): found ${appliances.map((a) => a.name).join(', ')}.`
    : `Signed in to LG (${c}), but this account has no appliances. Create the token on the LG account `
      + 'the ThinQ app shows your appliances on.';
  return { ok: true, message, appliances };
}

/**
 * The same report as lg-thinq-diagnostics, for the settings page's "Copy diagnostics": what LG
 * says about each appliance, with device IDs, serials and network names removed. Never throws;
 * never includes the token.
 */
export async function diagnostics(
  token: unknown, country: unknown,
  makeClient: (o: ClientOptions) => ThinQClient = (o) => new ThinQClient(o),
): Promise<{ ok: boolean; message: string; report?: string }> {
  const t = typeof token === 'string' ? token.trim() : '';
  const c = typeof country === 'string' && country.trim() ? country.trim().toUpperCase() : 'US';
  if (!t) { return { ok: false, message: 'Paste your personal access token in the Token box first.' }; }
  try {
    const report = await collect(makeClient({ token: t, country: c }), c, 'settings page');
    const text = JSON.stringify(report, null, 2);
    return { ok: true, message: `Diagnostics for ${report.appliances.length} appliance(s), with IDs and serial numbers removed.`, report: text.split(t).join('TOKEN-REMOVED') };
  } catch (err) {
    return { ok: false, message: `Couldn't get diagnostics: ${(err as Error).message}` };
  }
}
