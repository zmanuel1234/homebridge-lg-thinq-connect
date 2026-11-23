// What every appliance shares: a Home app accessory, services named after the appliance, commands
// sent one at a time, and LG's problem alerts shown on a "problem" sensor.

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
  /** For an appliance with two parts (a WashTower), which part an alert is about. */
  readonly alertKey?: string;
  stop(): void;
}

/** Update a characteristic only when its value changes. */
export function set(ch: Characteristic, value: CharacteristicValue): void {
  if (ch.value !== value) { ch.updateValue(value); }
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
  protected service(type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const { Characteristic: C } = this.hap;
    const svc = this.accessory.getServiceById(type, subtype) || this.accessory.addService(type, name, subtype);
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    const configured = svc.getCharacteristic(C.ConfiguredName);
    if (!configured.value) { configured.updateValue(name); }
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
    this.problemSensor = this.service(this.hap.Service.ContactSensor, `${this.ctx.name} problem`, 'problem');
    return this.problemSensor;
  }

  protected renderProblem(error = false): void {
    if (!this.problemSensor) { return; }
    const { Characteristic: C } = this.hap;
    set(this.problemSensor.getCharacteristic(C.ContactSensorState),
      error || this.problemAlert ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
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
        this.ctx.log.warn(`[${this.ctx.name}] LG refused "${label}": ${(err as Error).message}`);
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
