import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { type Device, ThinQClient, ThinQError, clientIdFor } from './api';
import { TESTED_TYPES, alertFor, alertKind, isLaundry, laundryStatus, laundryUnits, mergeState, stateLabel } from './laundry';
import { type LaundryContext, LaundryAccessory } from './accessory';
import { type LiveClient, type LiveMessage, type LiveOptions, LiveUpdates } from './live';

/** What the platform needs from LG; ThinQClient in Homebridge, a stand-in in tests. */
export interface Client {
  devices(): Promise<Device[]>;
  profile(deviceId: string): Promise<unknown>;
  state(deviceId: string): Promise<unknown>;
  control(deviceId: string, payload: Record<string, unknown>): Promise<unknown>;
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
  /** Appliance names (as in the ThinQ app) to leave out of the Home app. */
  ignore: string[];
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
    ignore: strings(config.ignore).map((s) => s.toLowerCase()),
  };
}

/** One LG appliance: its accessories and its polling. */
interface Machine {
  device: Device;
  units: LaundryAccessory[];
  /** The last full state from LG, which live updates are merged into. */
  state?: unknown;
  timer?: NodeJS.Timeout;
  failures: number;
}

/** Waits between tries to list the appliances after a failure, in seconds. */
const DISCOVERY_RETRY = [60, 120, 300, 900];
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
  async discover(): Promise<void> {
    if (this.stopped || !this.client) { return; }
    let devices: Device[];
    try {
      devices = await this.client.devices();
    } catch (err) {
      const wait = DISCOVERY_RETRY[Math.min(this.discoveryTries, DISCOVERY_RETRY.length - 1)];
      this.discoveryTries++;
      this.log.error(`Couldn't list your LG appliances: ${(err as Error).message} Trying again in ${wait / 60} min. `
        + 'Appliances already in the Home app stay there meanwhile.');
      this.discoveryTimer = setTimeout(() => { void this.discover(); }, wait * 1000);
      this.discoveryTimer.unref?.();
      return;
    }
    this.discoveryTries = 0;

    const active = new Set<string>();
    for (const device of devices) {
      const { alias, deviceType, modelName } = device.deviceInfo;
      if (this.settings.ignore.includes(alias.toLowerCase())) {
        this.log.info(`Leaving out "${alias}" (in the ignore list).`);
        continue;
      }
      if (!isLaundry(deviceType)) {
        this.log.info(`"${alias}" (${deviceType}) isn't supported yet. To help add it, run lg-thinq-diagnostics and attach `
          + 'its file to a "New appliance" issue: https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues');
        continue;
      }
      try {
        await this.setupLaundry(device, active);
      } catch (err) {
        this.log.error(`[${alias}] Couldn't set up this ${modelName || deviceType}: ${(err as Error).message}`);
        // Keep its cached accessories: this may be a passing failure
        for (const [uuid, acc] of this.cached) {
          if (acc.context.deviceId === device.deviceId) { active.add(uuid); }
        }
      }
    }

    // Only after a successful listing: a failed one must never empty the Home app
    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => { this.cached.delete(a.UUID); this.log.info(`Removed "${a.displayName}": it's no longer on the LG account or is ignored.`); });
    }
    if (!this.machines.length) {
      this.log.warn('No supported LG appliances found on this account (this version supports washers and dryers).');
    } else {
      this.startLive();
    }
  }

  private startLive(): void {
    if (!this.settings.liveUpdates || this.live || !this.client || !isLiveClient(this.client)) { return; }
    const clientId = clientIdFor(this.settings.token);
    const storageDir = (this.api.user as { storagePath?: () => string } | undefined)?.storagePath?.() || '.';
    this.live = new LiveUpdates({
      client: this.client,
      clientId,
      log: this.log,
      storageFile: join(storageDir, 'lg-thinq-connect', `live-${clientId.slice(-16)}.json`),
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
      for (const acc of machine.units) { acc.update(laundryStatus(acc.unit, machine.state)); }
      this.schedule(machine, this.interval(machine));
    } else if (message.pushType === 'DEVICE_PUSH' && message.pushCode) {
      const kind = alertKind(message.pushCode);
      const target = alertFor(message.pushCode);
      const units = machine.units.length > 1 && target ? machine.units.filter((u) => u.unit.kind === target) : machine.units;
      (units.length ? units : machine.units).forEach((u) => u.alert(kind, message.pushCode!));
      this.schedule(machine, 2); // confirm with LG's full state
    } else {
      this.log.debug(`[${name}] Live update of type ${message.pushType}, ignored.`);
    }
  }

  /** Seconds until the next scheduled check for a machine. */
  private interval(machine: Machine): number {
    const running = machine.units.some((u) => u.status?.running || u.status?.paused);
    const live = !!this.live?.connected;
    if (running) { return live ? Math.max(this.settings.runningPollInterval, LIVE_RUNNING) : this.settings.runningPollInterval; }
    return live ? Math.max(this.settings.pollInterval, LIVE_IDLE) : this.settings.pollInterval;
  }

  private async setupLaundry(device: Device, active: Set<string>): Promise<void> {
    const { alias, deviceType, modelName } = device.deviceInfo;
    const profile = await this.client!.profile(device.deviceId);
    const units = laundryUnits(deviceType, profile);
    if (!units.length) { throw new Error('LG\'s profile for it has nothing this plugin understands.'); }
    if (!TESTED_TYPES.has(deviceType)) {
      this.log.warn(`[${alias}] ${deviceType} support is experimental. Please report how it works: `
        + 'https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues');
    }

    const machine: Machine = { device, units: [], failures: 0 };
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
      machine.units.push(new LaundryAccessory(this, accessory, unit,
        { name, model: modelName, serial, allowControl: this.settings.allowControl,
          phaseSensors: this.settings.phaseSensors, tubCleanAfter: this.settings.tubCleanAfter },
        (payload) => this.client!.control(device.deviceId, payload),
        () => this.schedule(machine, 3)));
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.set(uuid, accessory);
        this.log.info(`Added "${name}" (${modelName || deviceType}).`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }
    this.machines.push(machine);
    await this.poll(machine);
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
      for (const acc of machine.units) {
        acc.update(laundryStatus(acc.unit, state));
      }
      next = this.interval(machine);
    } catch (err) {
      next = this.settings.pollInterval;
      machine.failures++;
      const auth = err instanceof ThinQError && err.isAuth;
      if (auth) { next = AUTH_RETRY; }
      const msg = `[${name}] Couldn't get its state from LG: ${(err as Error).message}`;
      if (machine.failures === 1 || auth) { this.log.warn(msg); } else { this.log.debug(msg); }
      if (machine.failures === FAULT_AFTER) {
        this.log.warn(`[${name}] Unreachable for ${FAULT_AFTER} checks in a row; the Home app shows it with a fault until it answers.`);
      }
      if (machine.failures >= FAULT_AFTER) { machine.units.forEach((u) => u.update(null)); }
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
    this.live?.stop();
    for (const m of this.machines) {
      clearTimeout(m.timer);
      m.units.forEach((u) => u.stop());
    }
  }
}
