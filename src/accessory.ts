// One washer or dryer (or one drum of a two-drum machine) in the Home app.
//
// The Home app has no washer or dryer type, so a machine is a few standard services:
//  - a valve (the main tile): on while the machine runs, with the minutes left on the tile;
//  - "<name> done", an occupancy sensor: detected when the cycle finishes, for a notification;
//  - "<name> problem", a contact sensor: open while the machine reports an error, or after an LG
//    alert such as "drying failed" until the next cycle starts or the machine is switched off;
//  - optionally "<name> <phase>" occupancy sensors (e.g. spinning), for automations.
// Starting, pausing and resuming from the valve is off unless the "allow control" setting is on,
// and LG only accepts it after Remote Start is pressed on the machine.

import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import { type LaundryStatus, type LaundryUnit, operationPayload, stateLabel } from './laundry';

export interface LaundryContext {
  deviceId?: string;
  location?: string;
}

export interface LaundryOptions {
  name: string;
  model: string;
  /** A stable identifier to show as the serial number (not LG's device ID itself). */
  serial: string;
  allowControl: boolean;
  /** LG state words to expose as their own sensors, e.g. SPINNING. */
  phaseSensors: string[];
}

export interface Deps {
  log: Logging;
  api: API;
}

/** Sends a command body for this unit to LG. */
export type SendFn = (payload: Record<string, unknown>) => Promise<unknown>;

/** If a cycle stops being seen with this little time left, it counts as finished. */
const NEAR_END = 3 * 60;
/** How long "done" stays detected when the finish was only inferred (the machine already powered off). */
const INFERRED_DONE_MS = 60_000;

export class LaundryAccessory {
  readonly valve: Service;
  readonly doneSensor: Service;
  readonly problemSensor: Service;
  readonly phaseSensors = new Map<string, Service>();
  status: LaundryStatus | null = null;
  private inferredDoneUntil = 0;
  private inferredTimer: NodeJS.Timeout | undefined;
  /** LG said the cycle finished (live alert); kept until the next cycle or switching off. */
  private finishedAlert = false;
  /** LG's problem alert (e.g. DRYING_FAILED); kept until the next cycle or switching off. */
  problemAlert = '';

  constructor(
    private readonly deps: Deps,
    readonly accessory: PlatformAccessory<LaundryContext>,
    readonly unit: LaundryUnit,
    readonly options: LaundryOptions,
    private readonly send: SendFn,
    private readonly refreshSoon: () => void = () => {},
  ) {
    const { Service: S, Characteristic: C } = deps.api.hap;
    const name = options.name;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'LG')
      .setCharacteristic(C.Model, options.model || (unit.kind === 'washer' ? 'Washer' : 'Dryer'))
      .setCharacteristic(C.SerialNumber, options.serial);

    // Main tile
    this.valve = this.service(S.Valve, name, 'cycle');
    this.valve.setPrimaryService(true);
    this.valve.setCharacteristic(C.ValveType, C.ValveType.GENERIC_VALVE);
    // Cycles run longer than an hour, HomeKit's default limit for these
    this.valve.getCharacteristic(C.RemainingDuration).setProps({ maxValue: 86_400 });
    this.valve.getCharacteristic(C.SetDuration).setProps({ maxValue: 86_400 });
    this.valve.getCharacteristic(C.Active).onSet((value) => this.setActive(value));
    this.valve.getCharacteristic(C.StatusFault);

    this.doneSensor = this.service(S.OccupancySensor, `${name} done`, 'done');
    this.problemSensor = this.service(S.ContactSensor, `${name} problem`, 'problem');

    // Phase sensors the machine can report; ones no longer wanted are removed
    const phases = options.phaseSensors.filter((p) => unit.states.includes(p));
    for (const phase of phases) {
      this.phaseSensors.set(phase, this.service(S.OccupancySensor, `${name} ${stateLabel(phase, unit.kind).toLowerCase()}`, `phase-${phase}`));
    }
    for (const svc of [...accessory.services]) {
      if (svc.subtype?.startsWith('phase-') && !this.phaseSensors.has(svc.subtype.slice(6))) {
        accessory.removeService(svc);
      }
    }
    this.render();
  }

  /** Get or add a service, and keep its name in step with the settings. */
  private service(type: typeof Service.Valve, name: string, subtype: string): Service {
    const { Characteristic: C } = this.deps.api.hap;
    const svc = this.accessory.getServiceById(type, subtype) || this.accessory.addService(type, name, subtype);
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    // Set once: a name changed in the Home app wins after that
    const configured = svc.getCharacteristic(C.ConfiguredName);
    if (!configured.value) { configured.updateValue(name); }
    return svc;
  }

  /** New status from LG; null when LG can't be reached. */
  update(next: LaundryStatus | null): void {
    const prev = this.status;
    if (next && prev && (prev.running || prev.paused) && !next.running && !next.paused && !next.done && !next.error
      && prev.remaining <= NEAR_END) {
      // Missed the END state between two looks (the machine went straight to off): still a finish
      this.inferredDoneUntil = Date.now() + INFERRED_DONE_MS;
      clearTimeout(this.inferredTimer);
      this.inferredTimer = setTimeout(() => { this.inferredDoneUntil = 0; this.render(); }, INFERRED_DONE_MS);
      this.inferredTimer.unref?.();
    }
    if (next && (next.running || next.paused)) {
      // A new cycle (or a resumed one): earlier finishes and alerts no longer apply
      this.inferredDoneUntil = 0;
      this.finishedAlert = false;
      this.problemAlert = '';
    } else if (next && next.state === 'POWER_OFF') {
      // Switched off: alerts end (an inferred finish still shows briefly)
      this.finishedAlert = false;
      this.problemAlert = '';
    }
    if (next && prev && next.state !== prev.state) {
      const left = next.remaining ? `, ${Math.round(next.remaining / 60)} min left` : '';
      this.deps.log.info(`[${this.options.name}] ${stateLabel(next.state, this.unit.kind)}${left}.`);
      if (next.error) {
        this.deps.log.warn(`[${this.options.name}] The machine reports an error${next.errorName ? `: ${next.errorName}` : ''}.`);
      }
    }
    if (next) { this.status = next; }
    this.render(next === null);
  }

  get done(): boolean {
    return !!this.status?.done || this.finishedAlert || this.inferredDoneUntil > Date.now();
  }

  get problem(): boolean {
    return !!this.status?.error || !!this.problemAlert;
  }

  /** An LG alert for this machine, from live updates. */
  alert(kind: 'finished' | 'problem' | 'other', pushCode: string): void {
    const name = this.options.name;
    if (kind === 'finished') {
      this.deps.log.info(`[${name}] LG says the cycle is finished.`);
      const s = this.status;
      if (s && (s.state === 'POWER_OFF')) {
        // Already off: a brief "done", as when a finish is inferred
        this.inferredDoneUntil = Date.now() + INFERRED_DONE_MS;
        clearTimeout(this.inferredTimer);
        this.inferredTimer = setTimeout(() => { this.inferredDoneUntil = 0; this.render(); }, INFERRED_DONE_MS);
        this.inferredTimer.unref?.();
      } else {
        this.finishedAlert = true;
      }
    } else if (kind === 'problem') {
      this.problemAlert = pushCode;
      this.deps.log.warn(`[${name}] LG alert: ${stateLabel(pushCode, this.unit.kind)}.`);
    } else {
      this.deps.log.info(`[${name}] LG alert: ${stateLabel(pushCode, this.unit.kind)}.`);
    }
    this.render();
  }

  private render(unreachable = false): void {
    const { Characteristic: C } = this.deps.api.hap;
    const s = this.status;
    // On only while running: a paused cycle shows off, so a tap on resumes it
    set(this.valve.getCharacteristic(C.Active), s?.running ? C.Active.ACTIVE : C.Active.INACTIVE);
    set(this.valve.getCharacteristic(C.InUse), s?.running ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
    set(this.valve.getCharacteristic(C.RemainingDuration), Math.min(s?.remaining ?? 0, 86_400));
    set(this.valve.getCharacteristic(C.SetDuration), Math.min(s?.total ?? 0, 86_400));
    set(this.valve.getCharacteristic(C.StatusFault), unreachable || this.problem ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
    set(this.doneSensor.getCharacteristic(C.OccupancyDetected),
      this.done ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    set(this.problemSensor.getCharacteristic(C.ContactSensorState),
      this.problem ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
    for (const [phase, svc] of this.phaseSensors) {
      set(svc.getCharacteristic(C.OccupancyDetected),
        s?.state === phase ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
  }

  /** The valve tapped in the Home app: start or resume (on), pause (off). */
  private async setActive(value: CharacteristicValue): Promise<void> {
    const { HapStatusError, HAPStatus } = this.deps.api.hap;
    const name = this.options.name;
    const s = this.status;
    const wantOn = value === 1 || value === true;
    const refuse = (why: string, level: 'info' | 'warn' = 'info'): never => {
      this.deps.log[level](`[${name}] ${why}`);
      setTimeout(() => this.render(), 50).unref?.();
      throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    };

    if (wantOn === !!s?.running) { return; }
    if (!this.options.allowControl) {
      refuse('Ignored the tap in the Home app: control is off in the plugin settings ("Allow starting and pausing").');
    }
    if (!s?.remoteControl) {
      refuse(`Can't ${wantOn ? 'start' : 'pause'}: press Remote Start on the machine first (LG only accepts commands then).`);
    }
    const operation = wantOn ? 'START' : 'STOP';
    if (!this.unit.operations.includes(operation)) {
      refuse(`This machine doesn't accept ${operation} through LG's API.`);
    }
    try {
      await this.send(operationPayload(this.unit, operation));
      this.deps.log.info(`[${name}] Sent ${wantOn ? (s?.paused ? 'resume' : 'start') : 'pause'}.`);
    } catch (err) {
      refuse(`LG refused ${operation}: ${(err as Error).message}`, 'warn');
    } finally {
      this.refreshSoon();
    }
  }

  stop(): void {
    clearTimeout(this.inferredTimer);
  }
}

/** Update a characteristic only when its value changes (no needless events to the Home app). */
function set(ch: Characteristic, value: CharacteristicValue): void {
  if (ch.value !== value) { ch.updateValue(value); }
}
