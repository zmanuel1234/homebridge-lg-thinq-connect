// What every appliance shares: a Home app accessory, services named after the appliance, commands
// sent one at a time, and LG's problem alerts shown on a "problem" sensor.

import { ThinQError } from '../api';
import { displayName, keepOrUpdate, namedBefore } from '../names';
import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { Device } from '../api';
import type { LaundryContext } from '../accessory';

export interface ApplianceContext {
  log: Logging;
  api: API;
  accessory: PlatformAccessory<LaundryContext>;
  device: Device;
  /** The name in the Home app (the ThinQ app's name for it). */
  name: string;
  serial: string;
  /** Sends a command body to LG for this appliance. */
  send: (payload: Record<string, unknown>) => Promise<unknown>;
  /** Asks the platform to check this appliance's state again shortly (after a command). */
  refreshSoon: () => void;
  /** Add extra switches (air conditioner modes, air purifier sleep mode…); default true. */
  extraControls?: boolean;
  /** This appliance's own options from the settings (matched by its ThinQ name). */
  options?: ApplianceOptions;
  /** Problem (and other notification) sensors as occupancy sensors instead of contact sensors. */
  sensorsAsOccupancy?: boolean;
}

/**
 * The problem sensor: a contact sensor (open = a problem; the default) or, by setting, an
 * occupancy sensor (detected = a problem), like the other sensors. The one of the other kind, left
 * from before the setting changed, is removed.
 */
export function problemSensor(
  accessory: PlatformAccessory, hap: API['hap'], asOccupancy: boolean,
  service: (type: WithUUID<typeof Service>, name: string, subtype: string) => Service, name: string,
): Service {
  const { Service: S } = hap;
  const [wanted, other] = asOccupancy ? [S.OccupancySensor, S.ContactSensor] : [S.ContactSensor, S.OccupancySensor];
  const old = accessory.getServiceById(other, 'problem');
  if (old) { accessory.removeService(old); }
  return service(wanted, name, 'problem');
}

/** Shows a problem (or none) on a problem sensor of either kind; also any on/off sensor of either kind (open/detected = on). */
export function showProblem(svc: Service, hap: API['hap'], problem: boolean): void {
  const { Characteristic: C, Service: S } = hap;
  if (svc.UUID === S.OccupancySensor.UUID) {
    set(svc.getCharacteristic(C.OccupancyDetected), problem ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  } else {
    set(svc.getCharacteristic(C.ContactSensorState), problem ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
  }
}

/** Options for one appliance, from the "Options per appliance" setting. */
export interface ApplianceOptions {
  /** Washers, dryers and other cycle appliances: overrides "Allow starting and pausing". */
  allowControl?: boolean;
  /** Overrides the general energy setting for this appliance. */
  energy?: boolean;
  /** Washers, dryers and other cycle appliances (not ovens): overrides the power switch setting. */
  powerSwitch?: boolean;
  /** Overrides the global "extra controls" setting for this appliance. */
  extraControls?: boolean;
  /** Air conditioners: the modes on the tile (cooling only, heating only, or all it has). */
  acModes?: 'all' | 'cool' | 'heat';
  /** Air conditioners: what the tile's swing control moves. */
  acSwing?: 'up-down' | 'left-right' | 'both';
  /** Air conditioners: the room temperature as a sensor of its own, for automations (purifiers that measure it always get one). */
  temperatureSensor?: boolean;
  /** Washers, dryers and other cycle appliances: leave out the Remote Start sensor. */
  hideRemoteStart?: boolean;
  /** What it is (from LG's device type), for the options the settings screen shows for it. */
  type?: string;
  // The settings below override the general ones for this appliance; unset, the general one applies
  /** Finished, error and reminder sensors as contact or occupancy sensors. */
  sensorType?: 'contact' | 'occupancy';
  /** Washers, dryers and other cycle appliances: phase sensors. */
  phaseSensors?: string[];
  /** Minutes "done" stays on after the machine switches itself off. */
  doneHoldMinutes?: number;
  /** Washers: LG's cycle count at which the tub-clean reminder turns on; 0 = off. */
  tubCleanAfter?: number;
  /** Dryers: dries after which the lint-filter reminder turns on; 0 = off. */
  lintFilterAfter?: number;
  /** Dryers: the lint-filter reminder goes off when the next dry starts. */
  lintFilterAutoClear?: boolean;
  /** Dryers: % longer than usual for the vent check; 0 = off. */
  ventCheckPercent?: number;
}

/** One appliance (or one part of one) in the Home app, kept up to date from LG's state. */
export interface Part {
  readonly accessory: PlatformAccessory<LaundryContext>;
  /** New full state from LG; null when LG can't be reached. */
  update(state: unknown): void;
  /** An LG alert for this appliance (from live updates). */
  alert(kind: 'finished' | 'problem' | 'other', pushCode: string): void;
  /** A cycle or similar is under way: check more often. */
  readonly busy: boolean;
  /** Was busy at the last update before this one (an alert may arrive just after a cycle ends). */
  readonly wasBusy?: boolean;
  /** For an appliance with two parts (a WashTower), which part an alert is about. */
  readonly alertKey?: string;
  stop(): void;
}

/**
 * Narrows a characteristic's limits without HAP warnings: a new characteristic still holds HAP's
 * default value (often outside the new limits), so a valid one is put in place first.
 */
export function limit(ch: Characteristic, props: { minValue?: number; maxValue?: number; minStep?: number; validValues?: number[] }): Characteristic {
  let v = typeof ch.value === 'number' ? ch.value : undefined;
  if (props.validValues?.length && (v === undefined || !props.validValues.includes(v))) { v = props.validValues[0]; }
  if (v !== undefined && props.minValue !== undefined && v < props.minValue) { v = props.minValue; }
  if (v !== undefined && props.maxValue !== undefined && v > props.maxValue) { v = props.maxValue; }
  if (v !== undefined && v !== ch.value) { ch.value = v; } // no event: it's set up, not a change
  return ch.setProps(props);
}

/**
 * Update a characteristic when its value changes, or when it carries an error status: HAP-NodeJS
 * keeps the error from a refused tap and returns it for every later read (the Home app then shows
 * "No Response") until a value is pushed again.
 */
export function set(ch: Characteristic, value: CharacteristicValue): void {
  if (ch.value !== value || ch.statusCode !== 0) { ch.updateValue(value); }
}

export abstract class Appliance implements Part {
  readonly accessory: PlatformAccessory<LaundryContext>;
  /** LG's problem alert (e.g. WATER_IS_FULL); cleared when the state shows the appliance fine again. */
  protected problemAlert = '';
  protected problemSensor: Service | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  protected unreachable = false;

  constructor(protected readonly ctx: ApplianceContext) {
    this.accessory = ctx.accessory;
    const { Service: S, Characteristic: C } = ctx.api.hap;
    ctx.accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'LG')
      .setCharacteristic(C.Model, ctx.device.deviceInfo.modelName || ctx.device.deviceInfo.deviceType)
      .setCharacteristic(C.SerialNumber, ctx.serial);
  }

  get busy(): boolean { return false; }

  get hap() { return this.ctx.api.hap; }

  abstract update(state: unknown): void;

  /** LG alerts: problems open the problem sensor (if there is one); the rest are logged. */
  alert(kind: 'finished' | 'problem' | 'other', pushCode: string): void {
    const words = pushCode.toLowerCase().split('_').join(' ');
    if (kind === 'problem') {
      this.problemAlert = pushCode;
      this.ctx.log.warn(`[${this.ctx.name}] LG alert: ${words[0].toUpperCase()}${words.slice(1)}.`);
      this.renderProblem();
    } else {
      this.ctx.log.info(`[${this.ctx.name}] LG alert: ${words[0].toUpperCase()}${words.slice(1)}.`);
    }
  }

  stop(): void {}

  /** Get or add a service, and keep its name in step (a name changed in the Home app wins). */
  protected service(type: WithUUID<typeof Service>, raw: string, subtype: string): Service {
    const { Characteristic: C } = this.hap;
    const name = displayName(this.ctx.name, raw);
    const svc = this.accessory.getServiceById(type, subtype) || this.accessory.addService(type, name, subtype);
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    const configured = svc.getCharacteristic(C.ConfiguredName);
    // An earlier default from before the appliance was renamed in the ThinQ app follows the rename
    const was = namedBefore(raw, this.ctx.name, (this.accessory.context as { applianceName?: string }).applianceName);
    const shown = keepOrUpdate(configured.value, name, was ? [was] : []);
    if (shown) { configured.updateValue(shown); }
    return svc;
  }

  /** Removes services of this accessory whose subtype isn't in `keep` (settings or profile changed). */
  protected prune(keep: Set<string>): void {
    for (const svc of [...this.accessory.services]) {
      if (svc.subtype && !keep.has(svc.subtype)) { this.accessory.removeService(svc); }
    }
  }

  /** A "<name> problem" contact sensor: open after an LG problem alert until the state is fine. */
  protected addProblemSensor(): Service {
    this.problemSensor = problemSensor(this.accessory, this.hap, !!this.ctx.sensorsAsOccupancy,
      (type, name, subtype) => this.service(type, name, subtype), `${this.ctx.name} problem`);
    return this.problemSensor;
  }

  protected renderProblem(error = false): void {
    if (!this.problemSensor) { return; }
    showProblem(this.problemSensor, this.hap, error || !!this.problemAlert);
  }

  /**
   * Sends a command, one at a time per appliance: a Home app scene sets several characteristics
   * at once, and LG rejects overlapping commands (as homebridge-lg-thinqconnect-ac found).
   * A refusal is logged and shown in the Home app as an error.
   */
  protected command(label: string, payload: Record<string, unknown>): Promise<void> {
    const run = async () => {
      try {
        await this.ctx.send(payload);
        this.ctx.log.info(`[${this.ctx.name}] ${label}.`);
      } catch (err) {
        if (err instanceof ThinQError && err.unconfirmed) {
          // LG may well have carried it out: the next check shows what happened
          this.ctx.log[err.timedOut ? 'warn' : 'info'](
            `[${this.ctx.name}] Sent "${label}", but LG didn't confirm it (${err.message}): checking the appliance.`);
          return;
        }
        this.ctx.log.warn(`[${this.ctx.name}] LG refused "${label}": ${(err as Error).message}`);
        // The Home app shows the error; the next check pushes the values again, which clears it
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        this.ctx.refreshSoon();
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
