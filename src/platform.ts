import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { type Device, ThinQClient, ThinQError, clientIdFor } from './api';
import { alertFor, alertKind, isCycleAppliance, isLaundry, laundryStatus, laundryUnits, mergeState, stateLabel } from './laundry';
import { consumptionService, ENERGY_SUBTYPE, mainService, thisMonth, totalConsumption } from './energy';
import { supportLevel } from './support';
import { type ApplianceContext, type ApplianceOptions, type Part, categoryOf, mappingFor } from './appliances';
import { type LaundryContext, LaundryAccessory } from './accessory';
import { type LiveClient, type LiveMessage, type LiveOptions, LiveUpdates } from './live';

/** What the platform needs from LG; ThinQClient in Homebridge, a stand-in in tests. */
export interface Client {
  devices(): Promise<Device[]>;
  profile(deviceId: string): Promise<unknown>;
  state(deviceId: string): Promise<unknown>;
  control(deviceId: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Energy figures (optional: a client without them shows no energy). */
  energyProperties?(deviceId: string): Promise<string[]>;
  energyUsage?(deviceId: string, property: string, period: 'DAILY' | 'MONTHLY', start: string, end: string): Promise<number>;
}

const isLiveClient = (c: Client): c is Client & LiveClient =>
  ['messageServer', 'registerClient', 'issueCertificate', 'subscribeEvents', 'subscribePush']
    .every((m) => typeof (c as unknown as Record<string, unknown>)[m] === 'function');

export interface Settings {
  token: string;
  country: string;
  /** Seconds between checks while a machine is idle, and while a cycle runs. */
  pollInterval: number;
  runningPollInterval: number;
  allowControl: boolean;
  /** Changes pushed by LG the moment they happen, with scheduled checks as a backup. */
  liveUpdates: boolean;
  phaseSensors: string[];
  /** Cycles counted by LG at which the tub-clean reminder turns on; 0 = off. */
  tubCleanAfter: number;
  /** Add appliance types not yet confirmed on real hardware (everything but washers and dryers). */
  experimental: boolean;
  /** Extra switches for experimental appliances (air conditioner modes, purifier sleep mode…). */
  extraControls: boolean;
  /** Appliance names (as in the ThinQ app) to leave out of the Home app. */
  ignore: string[];
  /** Options for single appliances, by name as in the ThinQ app (lower case). */
  appliances: Map<string, ApplianceOptions>;
  /** Energy use (this month) for Eve, for appliances LG reports it for. */
  energy: boolean;
}

/** The "Options per appliance" list: by ThinQ name, only the options this plugin knows. */
function applianceOptions(v: unknown): Map<string, ApplianceOptions> {
  const out = new Map<string, ApplianceOptions>();
  if (!Array.isArray(v)) { return out; }
  for (const e of v) {
    if (!e || typeof e !== 'object') { continue; }
    const o = e as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().toLowerCase() : '';
    if (!name) { continue; }
    const opts: ApplianceOptions = {};
    if (typeof o.extraControls === 'boolean') { opts.extraControls = o.extraControls; }
    if (o.acModes === 'all' || o.acModes === 'cool' || o.acModes === 'heat') { opts.acModes = o.acModes; }
    if (o.acSwing === 'up-down' || o.acSwing === 'left-right' || o.acSwing === 'both') { opts.acSwing = o.acSwing; }
    if (typeof o.temperatureSensor === 'boolean') { opts.temperatureSensor = o.temperatureSensor; }
    out.set(name, opts);
  }
  return out;
}

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) : [];

export function readSettings(config: PlatformConfig): Settings {
  return {
    token: typeof config.token === 'string' ? config.token.trim() : '',
    country: typeof config.country === 'string' && config.country.trim() ? config.country.trim().toUpperCase() : 'US',
    pollInterval: clamp(config.pollInterval, 30, 3600, 60),
    runningPollInterval: clamp(config.runningPollInterval, 15, 600, 30),
    allowControl: config.allowControl === true,
    liveUpdates: config.liveUpdates !== false,
    phaseSensors: strings(config.phaseSensors),
    tubCleanAfter: clamp(config.tubCleanAfter, 0, 200, 0),
    experimental: config.experimental === true,
    extraControls: config.extraControls !== false,
    ignore: strings(config.ignore).map((s) => s.toLowerCase()),
    appliances: applianceOptions(config.appliances),
    energy: config.energy !== false,
  };
}

/** A washer, dryer or other cycle appliance (one drum) as a Part. */
class LaundryPart implements Part {
  constructor(readonly laundry: LaundryAccessory) {}
  get accessory() { return this.laundry.accessory; }
  get alertKey(): string { return this.laundry.unit.kind; }
  wasBusy = false;
  get busy(): boolean { return !!(this.laundry.status?.running || this.laundry.status?.paused); }
  update(state: unknown): void {
    this.wasBusy = this.busy;
    this.laundry.update(state === null ? null : laundryStatus(this.laundry.unit, state));
  }
  alert(kind: 'finished' | 'problem' | 'other', code: string): void { this.laundry.alert(kind, code); }
  stop(): void { this.laundry.stop(); }
}

/** One LG appliance: its accessories and its polling. */
interface Machine {
  device: Device;
  /** Washers, dryers and other cycle appliances: one per drum. */
  units: LaundryAccessory[];
  /** Everything that follows this appliance's state (laundry units included). */
  parts: Part[];
  /** The last full state from LG, which live updates are merged into. */
  state?: unknown;
  timer?: NodeJS.Timeout;
  failures: number;
  energyTimer?: NodeJS.Timeout;
}

/** After a failure, energy setup is tried again after this long (seconds). */
const ENERGY_RETRY = 3600;

/**
 * Milliseconds until the next daily energy check: a random time between 01:00 and 06:00 local,
 * as Home Assistant does, so many installs don't all ask LG at once (LG updates the figures daily).
 */
export function untilNextEnergyCheck(now = new Date(), random = Math.random()): number {
  const next = new Date(now);
  next.setHours(1, 0, 0, 0);
  next.setTime(next.getTime() + Math.floor(random * 5 * 3600 * 1000));
  if (next.getTime() <= now.getTime()) { next.setDate(next.getDate() + 1); }
  return next.getTime() - now.getTime();
}

/** Waits between tries to list the appliances after a failure, in seconds. */
const DISCOVERY_RETRY = [60, 120, 300, 900];
/** Empty listings in a row before accessories are removed (LG may answer empty during an outage). */
const EMPTY_LISTINGS_TO_REMOVE = 3;
/** Seconds to wait after LG asks to slow down. */
const RATE_LIMIT_RETRY = 600;
/** Seconds between checks while LG rejects the token. */
const AUTH_RETRY = 900;
/** Failed checks in a row before the Home app shows the machine with a fault. */
const FAULT_AFTER = 3;
/** With live updates connected, scheduled checks are only a backup: at least this far apart (s). */
const LIVE_IDLE = 600;
const LIVE_RUNNING = 120;

export class LGThinQPlatform implements DynamicPlatformPlugin {
  readonly log: Logging;
  readonly config: PlatformConfig;
  readonly api: API;
  readonly cached = new Map<string, PlatformAccessory<LaundryContext>>();
  readonly machines: Machine[] = [];
  settings: Settings;
  client: Client | undefined;
  live: LiveUpdates | undefined;
  /** For tests: replaces parts of the live-update setup (connection, key, storage). */
  liveOverrides: Partial<LiveOptions> = {};
  private discoveryTimer: NodeJS.Timeout | undefined;
  private discoveryTries = 0;
  /** Appliances whose setup failed (LG didn't answer for its profile): tried again with a backoff. */
  private failedSetups: Device[] = [];
  private setupTries = 0;
  private setupTimer: NodeJS.Timeout | undefined;
  /** Successful listings in a row that came back empty while the Home app has accessories. */
  private emptyListings = 0;
  stopped = false;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API, client?: Client) {
    this.log = log;
    this.config = config || ({} as PlatformConfig);
    this.api = api;
    this.settings = readSettings(this.config);
    this.client = client;

    this.api.on('didFinishLaunching', () => {
      this.start().catch((err: unknown) => {
        this.log.error(`Setup failed: ${(err as Error | null)?.stack || String(err)}`);
      });
    });
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<LaundryContext>);
  }

  async start(): Promise<void> {
    if (!this.settings.token) {
      this.log.warn('No LG personal access token set. Create one at https://connect-pat.lgthinq.com and paste it in this plugin\'s settings.');
      return;
    }
    if (!this.client) {
      try {
        this.client = new ThinQClient({ token: this.settings.token, country: this.settings.country });
      } catch (err) {
        this.log.error((err as Error).message);
        return;
      }
    }
    await this.discover();
  }

  /** List the account's appliances and set up the supported ones. */
  private signedIn = false;

  async discover(): Promise<void> {
    if (this.stopped || !this.client) { return; }
    let devices: Device[];
    try {
      devices = await this.client.devices();
    } catch (err) {
      this.retryDiscovery(`Couldn't list your LG appliances: ${(err as Error).message}`);
      return;
    }
    // An empty answer while the Home app has accessories may be a passing LG problem: confirm first
    if (!devices.length && this.cached.size && ++this.emptyListings < EMPTY_LISTINGS_TO_REMOVE) {
      this.retryDiscovery('LG listed no appliances on this account.');
      return;
    }
    this.emptyListings = 0;
    this.discoveryTries = 0;
    if (!this.signedIn) {
      this.signedIn = true;
      const names = devices.map((d) => d.deviceInfo.alias).filter(Boolean);
      this.log.info(`Signed in to LG (${this.settings.country}): found ${names.length ? names.join(', ') : 'no appliances'}.`);
    }

    const active = new Set<string>();
    for (const device of devices) {
      const { alias, deviceType, modelName } = device.deviceInfo;
      if (this.settings.ignore.includes(alias.toLowerCase())) {
        this.log.info(`Leaving out "${alias}" (in the ignore list).`);
        continue;
      }
      const laundry = isLaundry(deviceType);
      // Laundry and the types checked against Home Assistant are added; the rest need the setting
      if (!laundry && supportLevel(deviceType) === 'experimental' && !this.settings.experimental) {
        this.log.info(`"${alias}" (${deviceType}) isn't confirmed on a real appliance yet. To try it, turn on `
          + '"Experimental appliances" in this plugin\'s settings, and please report how it works.');
        continue;
      }
      try {
        if (laundry || isCycleAppliance(deviceType)) {
          await this.setupLaundry(device, active);
        } else {
          await this.setupOther(device, active);
        }
      } catch (err) {
        this.log.error(`[${alias}] Couldn't set up this ${modelName || deviceType}: ${(err as Error).message} `
          + 'Trying again shortly; meanwhile it shows with a fault in the Home app.');
        // Keep its cached accessories: this may be a passing failure
        for (const [uuid, acc] of this.cached) {
          if (acc.context.deviceId === device.deviceId) { active.add(uuid); }
        }
        this.markFault(device.deviceId);
        this.failedSetups.push(device);
      }
    }

    // Only after a successful listing: a failed one must never empty the Home app
    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => { this.cached.delete(a.UUID); this.log.info(`Removed "${a.displayName}": it's no longer on the LG account or is ignored.`); });
    }
    if (this.failedSetups.length) { this.scheduleSetupRetry(); }
    if (this.machines.length) {
      this.startLive();
    } else if (!this.failedSetups.length) {
      this.log.warn('No supported LG appliances found on this account. Washers, dryers, air conditioners, '
        + 'dehumidifiers and range hoods are supported; turn on "Experimental appliances" for other types.');
    }
  }

  private retryDiscovery(why: string): void {
    const wait = DISCOVERY_RETRY[Math.min(this.discoveryTries, DISCOVERY_RETRY.length - 1)];
    this.discoveryTries++;
    this.log.error(`${why} Trying again in ${wait / 60} min. Appliances already in the Home app stay there meanwhile.`);
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => { void this.discover(); }, wait * 1000);
    this.discoveryTimer.unref?.();
  }

  /** Shows an appliance's cached accessories with a fault while it can't be set up. */
  private markFault(deviceId: string): void {
    const { Characteristic: C } = this.api.hap;
    for (const acc of this.cached.values()) {
      if (acc.context.deviceId !== deviceId) { continue; }
      for (const service of acc.services) {
        if (service.testCharacteristic(C.StatusFault)) { service.updateCharacteristic(C.StatusFault, C.StatusFault.GENERAL_FAULT); }
      }
    }
  }

  private scheduleSetupRetry(): void {
    if (this.stopped) { return; }
    const wait = DISCOVERY_RETRY[Math.min(this.setupTries, DISCOVERY_RETRY.length - 1)];
    this.setupTries++;
    clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(() => { void this.retrySetups(); }, wait * 1000);
    this.setupTimer.unref?.();
  }

  /** Tries again to set up the appliances that failed; their accessories are reused, never doubled. */
  async retrySetups(): Promise<void> {
    if (this.stopped) { return; }
    const devices = this.failedSetups;
    this.failedSetups = [];
    for (const device of devices) {
      if (this.machines.some((m) => m.device.deviceId === device.deviceId)) { continue; }
      try {
        if (isLaundry(device.deviceInfo.deviceType) || isCycleAppliance(device.deviceInfo.deviceType)) {
          await this.setupLaundry(device, new Set());
        } else {
          await this.setupOther(device, new Set());
        }
        this.log.info(`[${device.deviceInfo.alias}] Set up now.`);
        if (this.live) { await this.live.addDevice(device.deviceId); } else { this.startLive(); }
      } catch (err) {
        this.log.debug(`[${device.deviceInfo.alias}] Still couldn't set it up: ${(err as Error).message}`);
        this.failedSetups.push(device);
      }
    }
    if (this.failedSetups.length) { this.scheduleSetupRetry(); } else { this.setupTries = 0; }
  }

  private startLive(): void {
    if (!this.settings.liveUpdates || this.live || !this.client || !isLiveClient(this.client)) { return; }
    const clientId = clientIdFor(this.settings.token);
    const storageDir = (this.api.user as { storagePath?: () => string } | undefined)?.storagePath?.();
    if (!storageDir && !this.liveOverrides.storageFile) {
      this.log.warn('Live updates are off: Homebridge didn\'t give a storage folder for their certificate. Checking on a schedule instead.');
      return;
    }
    this.live = new LiveUpdates({
      client: this.client,
      clientId,
      log: this.log,
      storageFile: join(storageDir || '', 'lg-thinq-connect', `live-${clientId.slice(-16)}.json`),
      onMessage: (m) => this.onLive(m),
      onConnected: (connected) => {
        // Back to normal checks soon after losing live updates
        if (!connected) { this.machines.forEach((m) => this.schedule(m, 5)); }
      },
      ...this.liveOverrides,
    });
    void this.live.start(this.machines.map((m) => m.device.deviceId));
  }

  /** A live update from LG: a partial state, or an alert. */
  onLive(message: LiveMessage): void {
    const machine = this.machines.find((m) => m.device.deviceId === message.deviceId);
    if (!machine) {
      this.log.debug(`Live update for an appliance not in the Home app (${message.pushType}), ignored.`);
      return;
    }
    const name = machine.device.deviceInfo.alias;
    if (message.pushType === 'DEVICE_STATUS' && message.report !== undefined) {
      this.log.debug(`[${name}] Live update: ${JSON.stringify(message.report)}`);
      machine.state = mergeState(machine.state, message.report);
      for (const part of machine.parts) { part.update(machine.state); }
      this.schedule(machine, this.interval(machine));
    } else if (message.pushType === 'DEVICE_PUSH' && message.pushCode) {
      const kind = alertKind(message.pushCode);
      const target = alertFor(message.pushCode);
      let parts = machine.parts.length > 1 && target ? machine.parts.filter((p) => p.alertKey === target) : machine.parts;
      if (!parts.length) { parts = machine.parts; }
      // Two drums of one kind (a twin washer): the alert is for the one that was in use
      if (parts.length > 1) {
        const inUse = parts.filter((p) => p.busy || p.wasBusy);
        if (inUse.length) { parts = inUse; }
      }
      parts.forEach((p) => p.alert(kind, message.pushCode!));
      this.schedule(machine, 2); // confirm with LG's full state
    } else {
      this.log.debug(`[${name}] Live update of type ${message.pushType}, ignored.`);
    }
  }

  /** Seconds until the next scheduled check for a machine. */
  private interval(machine: Machine): number {
    const running = machine.parts.some((p) => p.busy);
    const live = !!this.live?.connected;
    if (running) { return live ? Math.max(this.settings.runningPollInterval, LIVE_RUNNING) : this.settings.runningPollInterval; }
    return live ? Math.max(this.settings.pollInterval, LIVE_IDLE) : this.settings.pollInterval;
  }

  private async setupLaundry(device: Device, active: Set<string>): Promise<void> {
    const { alias, deviceType, modelName } = device.deviceInfo;
    const profile = await this.client!.profile(device.deviceId);
    const units = laundryUnits(deviceType, profile);
    if (!units.length) { throw new Error('LG\'s profile for it has nothing this plugin understands.'); }
    if (supportLevel(deviceType) === 'experimental') {
      this.log.warn(`[${alias}] ${deviceType} support is experimental. Please report how it works: `
        + 'https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues');
    }

    const machine: Machine = { device, units: [], parts: [], failures: 0 };
    for (const unit of units) {
      const name = units.length > 1 ? `${alias} ${stateLabel(unit.location)}` : alias;
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.deviceId}:${unit.location}`);
      active.add(uuid);
      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory<LaundryContext>(name, uuid, this.api.hap.Categories.OTHER);
      }
      accessory.context.deviceId = device.deviceId;
      accessory.context.location = unit.location;
      const serial = createHash('sha256').update(`${device.deviceId}:${unit.location}`).digest('hex').slice(0, 12).toUpperCase();
      const laundry = new LaundryAccessory(this, accessory, unit,
        { name, model: modelName, serial, allowControl: this.settings.allowControl,
          phaseSensors: this.settings.phaseSensors, tubCleanAfter: this.settings.tubCleanAfter },
        (payload) => this.client!.control(device.deviceId, payload),
        () => this.schedule(machine, 3));
      machine.units.push(laundry);
      machine.parts.push(new LaundryPart(laundry));
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.set(uuid, accessory);
        this.log.info(`Added "${name}" (${modelName || deviceType}).`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }
    this.machines.push(machine);
    void this.setupEnergy(machine);
    await this.poll(machine);
  }

  /** Any other appliance type (experimental): one accessory with the mapping for its type. */
  private async setupOther(device: Device, active: Set<string>): Promise<void> {
    const { alias, deviceType, modelName } = device.deviceInfo;
    const profile = await this.client!.profile(device.deviceId);
    const mapping = mappingFor(deviceType, profile);
    if (!mapping) {
      this.log.info(`"${alias}" (${deviceType}) isn't supported yet: its profile has nothing the Home app can show. To help add it, `
        + 'run lg-thinq-diagnostics (see the README for where) and attach its file to a "New appliance" issue: '
        + 'https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues');
      return;
    }
    if (supportLevel(deviceType) === 'checked') {
      this.log.info(`[${alias}] Added as ${/^[aeiou]/.test(mapping.label) ? 'an' : 'a'} ${mapping.label} (${deviceType}), checked against Home Assistant's data from a real one. `
        + 'Please report how it works: https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues');
    } else {
      this.log.warn(`[${alias}] Added as an experimental ${mapping.label} (${deviceType}). Please report how it works: `
        + 'https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues');
    }
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.deviceId}:`);
    active.add(uuid);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory<LaundryContext>(alias, uuid, categoryOf(mapping));
    }
    accessory.context.deviceId = device.deviceId;
    accessory.context.location = '';
    const machine: Machine = { device, units: [], parts: [], failures: 0 };
    const ctx: ApplianceContext = {
      log: this.log, api: this.api, accessory, device, name: alias,
      serial: createHash('sha256').update(`${device.deviceId}:`).digest('hex').slice(0, 12).toUpperCase(),
      send: (payload) => this.client!.control(device.deviceId, payload),
      refreshSoon: () => this.schedule(machine, 3),
      extraControls: this.settings.extraControls,
      options: this.settings.appliances.get(alias.trim().toLowerCase()),
    };
    machine.parts.push(mapping.create(ctx, profile));
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
      this.log.info(`Added "${alias}" (${modelName || deviceType}).`);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    this.machines.push(machine);
    void this.setupEnergy(machine);
    await this.poll(machine);
  }

  /**
   * Energy use for the Eve app, for appliances LG keeps it for: this month's kWh on an Eve
   * Consumption service on each part. Silent when LG keeps none; failures only delay it.
   */
  async setupEnergy(machine: Machine): Promise<void> {
    const client = this.client;
    if (this.stopped || !client?.energyProperties || !client.energyUsage) { return; }
    const Total = totalConsumption(this.api);
    const Consumption = consumptionService(this.api);
    const info = this.api.hap.Service.AccessoryInformation.UUID;
    const energyService = (part: Part) =>
      part.accessory.services.find((s) => s.UUID === Consumption.UUID && s.subtype === ENERGY_SUBTYPE);
    // 1.0.0 put the figure on the main tile, where Eve doesn't show it: take it off there
    for (const part of machine.parts) {
      const svc = mainService(part.accessory.services.filter((s) => s.UUID !== Consumption.UUID), info);
      const old = svc?.characteristics.find((c) => c.UUID === Total.UUID);
      if (svc && old) { svc.removeCharacteristic(old); }
    }
    /** Takes the energy figure off appliances that shouldn't show one (setting off, or LG keeps none). */
    const clear = (parts: Part[]) => {
      for (const part of parts) {
        const svc = energyService(part);
        if (svc) { part.accessory.removeService(svc); }
      }
    };
    if (!this.settings.energy) { clear(machine.parts); return; }
    const { device } = machine;
    const retryLater = () => {
      if (this.stopped) { return; }
      machine.energyTimer = setTimeout(() => { void this.setupEnergy(machine); }, ENERGY_RETRY * 1000);
      machine.energyTimer.unref?.();
    };
    let props: string[];
    try {
      props = await client.energyProperties(device.deviceId);
    } catch (err) {
      // LG keeps no figures for this model: nothing to show. Anything else: try again later
      const unsupported = err instanceof ThinQError && ['1205', '1219', '1221'].includes(err.code);
      this.log.debug(`[${device.deviceInfo.alias}] No energy figures from LG: ${(err as Error).message}`);
      if (unsupported) { clear(machine.parts); } else { retryLater(); }
      return;
    }
    // One figure for the appliance, or one per part (energyUsage_washer…) matched by its kind
    const targets: { part: Part; property: string }[] = [];
    for (const part of machine.parts) {
      const key = part.alertKey?.toLowerCase();
      const property = props.length === 1 && part === machine.parts[0] ? props[0]
        : props.find((p) => key && p.toLowerCase().endsWith(`_${key}`));
      if (property) { targets.push({ part, property }); }
    }
    clear(machine.parts.filter((p) => !targets.some((t) => t.part === p)));
    if (!targets.length) { return; }
    const check = async () => {
      let failed = false;
      for (const { part, property } of targets) {
        try {
          const wh = await client.energyUsage!(device.deviceId, property, 'MONTHLY', thisMonth(), thisMonth());
          const kwh = Math.round(wh) / 1000;
          const svc = energyService(part)
            || part.accessory.addService(new Consumption(`${part.accessory.displayName} energy`, ENERGY_SUBTYPE));
          const ch = svc.getCharacteristic(Total);
          if (ch.value !== kwh) {
            this.log.debug(`[${part.accessory.displayName}] Energy this month: ${kwh} kWh.`);
            ch.updateValue(kwh);
          }
        } catch (err) {
          failed = true;
          this.log.debug(`[${part.accessory.displayName}] Couldn't get energy use: ${(err as Error).message}`);
        }
      }
      if (this.stopped) { return; }
      // A failed check is tried again within the hour, not tomorrow
      machine.energyTimer = setTimeout(() => { void check(); }, failed ? ENERGY_RETRY * 1000 : untilNextEnergyCheck());
      machine.energyTimer.unref?.();
    };
    this.log.info(`[${device.deviceInfo.alias}] Energy use this month is shown in the Eve app (LG updates it daily).`);
    await check();
  }

  /** Check one appliance's state now, then schedule the next check. */
  async poll(machine: Machine): Promise<void> {
    if (this.stopped) { return; }
    clearTimeout(machine.timer);
    const name = machine.device.deviceInfo.alias;
    let next: number;
    try {
      const state = await this.client!.state(machine.device.deviceId);
      if (machine.failures >= FAULT_AFTER) { this.log.info(`[${name}] Reachable again.`); }
      machine.failures = 0;
      machine.state = state;
      for (const part of machine.parts) { part.update(state); }
      next = this.interval(machine);
    } catch (err) {
      next = this.settings.pollInterval;
      machine.failures++;
      const auth = err instanceof ThinQError && err.isAuth;
      if (auth) { next = AUTH_RETRY; }
      if (err instanceof ThinQError && err.isRateLimit) { next = Math.max(next, RATE_LIMIT_RETRY); }
      const msg = `[${name}] Couldn't get its state from LG: ${(err as Error).message}`;
      if (machine.failures === 1 || auth) { this.log.warn(msg); } else { this.log.debug(msg); }
      if (machine.failures === FAULT_AFTER) {
        this.log.warn(`[${name}] Unreachable for ${FAULT_AFTER} checks in a row; the Home app shows it with a fault until it answers.`);
      }
      if (machine.failures >= FAULT_AFTER) { machine.parts.forEach((p) => p.update(null)); }
    }
    this.schedule(machine, next);
  }

  private schedule(machine: Machine, seconds: number): void {
    if (this.stopped) { return; }
    clearTimeout(machine.timer);
    machine.timer = setTimeout(() => { void this.poll(machine); }, seconds * 1000);
    machine.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.discoveryTimer);
    clearTimeout(this.setupTimer);
    this.live?.stop();
    for (const m of this.machines) {
      clearTimeout(m.timer);
      clearTimeout(m.energyTimer);
      m.parts.forEach((p) => p.stop());
    }
  }
}
