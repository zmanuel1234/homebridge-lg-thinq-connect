// LG's official ThinQ Connect API: the requests this plugin makes, typed.
//
// Requests and headers follow LG's documentation and its Node toolkit (thinqconnect, Apache-2.0):
// https://thinq.developer.lge.com/en/cloud/docs/thinq-connect/ . The plugin talks to the API
// directly instead of using that toolkit, which needs a native AWS library that is slow or
// impossible to install on some Raspberry Pi setups.

import { createHash, randomBytes } from 'node:crypto';

/** LG's API key for personal-access-token clients: a public value, the same in LG's own toolkit. */
export const API_KEY = 'ZkVkqP9jq44HuWkbNX9EKzZmmn7ToPY3A4vQ4tY8';

export type Region = 'aic' | 'eic' | 'kic';

// Which LG server holds accounts from each country (LG's toolkit, CountryPreset).
const REGIONS: Record<Region, string> = {
  kic: 'AU BD CN HK ID IN JP KH KR LA LK MM MY NP NZ PH SG TH TW VN',
  aic: 'AG AR AW BB BO BR BS BZ CA CL CO CR CU DM DO EC GD GT GY HN HT JM KN LC MX NI PA PE PR PY SR SV TT US UY VC VE',
  eic: 'AE AF AL AM AO AT AZ BA BE BF BG BH BJ BY CD CF CG CH CI CM CV CY CZ DE DJ DK DZ EE EG ES ET FI FR GA GB GE GH GM GN GQ GR '
    + 'HR HU IE IL IQ IR IS IT JO KE KG KW KZ LB LR LT LU LV LY MA MD ME MK ML MR MT MU MW NE NG NL NO OM PK PL PS PT QA RO RS RU '
    + 'RW SA SD SE SI SK SL SN SO ST SY TD TG TN TR TZ UA UG UZ XK YE ZA ZM',
};

/** The LG server region for a two-letter country code, or undefined if LG doesn't serve it. */
export function regionFor(country: string): Region | undefined {
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) { return undefined; }
  return (Object.keys(REGIONS) as Region[]).find((r) => REGIONS[r].split(' ').includes(code));
}

/** A client ID that stays the same for the same token, without storing anything. */
export function clientIdFor(token: string): string {
  return `homebridge-lg-thinq-connect-${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

export interface DeviceInfo {
  deviceType: string;
  modelName: string;
  alias: string;
  reportable?: boolean;
}

export interface Device {
  deviceId: string;
  deviceInfo: DeviceInfo;
}

/** An answer from LG that isn't a success: HTTP status, LG's error code and message. */
export class ThinQError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly lgMessage: string,
  ) {
    super(ThinQError.describe(status, code, lgMessage));
    this.name = 'ThinQError';
  }

  /** True when the token is missing, wrong, expired or lacks a permission. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  static describe(status: number, code: string, message: string): string {
    const lg = [code && `LG error ${code}`, message].filter(Boolean).join(': ');
    const base = status ? `HTTP ${status}${lg ? ` (${lg})` : ''}` : lg || 'no answer';
    if (status === 401 || status === 403) {
      return `${base}. Check the personal access token: it must be copied whole, not deleted at connect-pat.lgthinq.com, `
        + 'and created with every device permission. The account must also be in the selected country.';
    }
    if (status === 429) {
      return `${base}. LG is limiting how often this account can ask; the plugin will retry more slowly.`;
    }
    return base;
  }
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ClientOptions {
  token: string;
  country: string;
  /** Defaults to clientIdFor(token). */
  clientId?: string;
  /** For tests: the server to talk to instead of LG's. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchFn;
}

export class ThinQClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly country: string;
  private readonly clientId: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(options: ClientOptions) {
    const region = regionFor(options.country);
    if (!region) {
      throw new Error(`LG's ThinQ Connect API doesn't serve the country "${options.country}". Use a two-letter code such as US or GB.`);
    }
    if (!options.token.trim()) {
      throw new Error('No personal access token set.');
    }
    this.token = options.token.trim();
    this.country = options.country.trim().toUpperCase();
    this.clientId = options.clientId || clientIdFor(this.token);
    this.baseUrl = (options.baseUrl || `https://api-${region}.lgthinq.com/`).replace(/\/?$/, '/');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetch || (fetch as unknown as FetchFn);
  }

  /** The appliances on the account. */
  async devices(): Promise<Device[]> {
    const answer = await this.request('GET', 'devices');
    if (!Array.isArray(answer)) { return []; }
    return answer.filter(isDevice).map((d) => ({
      deviceId: d.deviceId,
      deviceInfo: { ...d.deviceInfo, modelName: typeof d.deviceInfo.modelName === 'string' ? d.deviceInfo.modelName : '' },
    }));
  }

  /** What an appliance reports and accepts. */
  profile(deviceId: string): Promise<unknown> {
    return this.request('GET', `devices/${encodeURIComponent(deviceId)}/profile`);
  }

  /** An appliance's current state. */
  state(deviceId: string): Promise<unknown> {
    return this.request('GET', `devices/${encodeURIComponent(deviceId)}/state`);
  }

  /** Send a command. LG refuses it unless the appliance can take it right now (conditional control). */
  control(deviceId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `devices/${encodeURIComponent(deviceId)}/control`, payload, { 'x-conditional-control': 'true' });
  }

  private async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'x-country': this.country,
      'x-message-id': randomBytes(16).toString('base64url'),
      'x-client-id': this.clientId,
      'x-api-key': API_KEY,
      'x-service-phase': 'OP',
      'Accept': 'application/json',
      ...extra,
    };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; }

    let status: number;
    let text: string;
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
      const why = e?.name === 'TimeoutError' ? `no answer within ${this.timeoutMs / 1000} s`
        : e?.cause?.code || e?.cause?.message || e?.message || String(err);
      throw new ThinQError(0, '', `Couldn't reach LG (${why})`);
    }

    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ThinQError(status, '', `LG answered with something that isn't JSON: ${text.slice(0, 120)}`);
    }
    const error = field(json, 'error');
    if (status < 200 || status >= 300 || error !== undefined) {
      throw new ThinQError(status, String(field(error, 'code') ?? ''), String(field(error, 'message') ?? ''));
    }
    return field(json, 'response');
  }
}

/** A property of an object, or undefined when it isn't an object. */
export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function isDevice(value: unknown): value is Device {
  const info = field(value, 'deviceInfo');
  return typeof field(value, 'deviceId') === 'string'
    && typeof field(info, 'deviceType') === 'string'
    && typeof field(info, 'alias') === 'string';
}
