// One washer or dryer (or one drum of a two-drum machine) in the Home app.
//
// The Home app has no washer or dryer type, so a machine is a few standard services:
//  - a valve (the main tile): on while the machine runs, with the minutes left on the tile;
//  - "<name> done", an occupancy sensor: detected when the cycle finishes, for a notification;
//  - "<name> problem", a contact sensor: open while the machine reports an error, or after an LG
//    alert such as "drying failed" until the next cycle starts or the machine is switched off;
//  - optionally "<name> <phase>" occupancy sensors (e.g. spinning), for automations;
//  - dishwashers: "<name> door" (contact sensor) and "<name> rinse aid low" (occupancy sensor),
//    when the machine reports them;
//  - optionally "<name> tub clean", an occupancy sensor: detected once the washer's cycle count
//    (as LG counts it) reaches the setting, as a reminder to run Tub Clean;
//  - "<name> remote start", an occupancy sensor: on while Remote Start is on at the machine, for a
//    notification or an automation that starts it (machines that report it, when control is allowed);
//  - ovens that accept a temperature: "<name> temperature", a thermostat: heat starts the oven at
//    the set temperature, off stops it. LG doesn't report the oven's actual temperature, so the
//    current temperature shows the one it's set to.
// Starting, pausing and resuming from the valve is off unless the "allow control" setting is on,
// and LG only accepts it after Remote Start is pressed on the machine.

import { ThinQError } from './api';
import { displayName, keepOrUpdate } from './names';
import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import { type LaundryStatus, type LaundryUnit, operationPayload, ovenStartPayload, stateLabel } from './laundry';
import { limit } from './appliances/base';

export interface LaundryContext {
  deviceId?: string;
  location?: string;
}

/** Minutes "done" stays on by default after the machine switches itself off from finished. */
const DEFAULT_DONE_HOLD_MIN = 120;
/** How long the tile shows a start or pause sent from the Home app before LG reports it. */
const PENDING_MS = 30_000;
/**
 * How long after a start the program time is compared with the one chosen before it. LG reports a
 * program switch within about a second (Speed Wash 15 min → Normal 65 min, 1 s after the start);
 * the washer's own adjustment for the load comes later (65 → 53 min after 43 s), so it's left out.
 */
const START_CHECK_MS = 15_000;
/** A change in program time this large (seconds) after a start means another program. */
const PROGRAM_CHANGE = 10 * 60;

export interface LaundryOptions {
  name: string;
  model: string;
  /** A stable identifier to show as the serial number (not LG's device ID itself). */
  serial: string;
  allowControl: boolean;
  /** LG state words to expose as their own sensors, e.g. SPINNING. */
  phaseSensors: string[];
  /** Cycles counted by LG at which the tub-clean reminder turns on; 0 = no reminder. */
  tubCleanAfter: number;
  /** Minutes "done" stays on after the machine switches itself off straight from finished (default 120). */
  doneHoldMinutes?: number;
  /** The Remote Start sensor (when the machine reports it and control is allowed); default on. */
  remoteStartSensor?: boolean;
}

export interface Deps {
  log: Logging;
  api: API;
}

/** Sends a command body for this unit to LG. */
export type SendFn = (payload: Record<string, unknown>) => Promise<unknown>;

/** Where an oven starts if no temperature was chosen yet: 350 °F, or 175 °C. */
const DEFAULT_OVEN_F = 350;
const DEFAULT_OVEN_C = 175;
/** How long a temperature chosen in the Home app wins over the one the oven last reported. */
const OVEN_TARGET_HOLD_MS = 30_000;
/** A thermostat set to heat waits this long, so a temperature set in the same Home app action goes with it. */
const OVEN_START_DELAY_MS = 400;
/** After a start, a new temperature this soon is sent again (the oven may not report running yet). */
const OVEN_RESEND_MS = 10_000;
const toC = (f: number): number => (f - 32) * 5 / 9;

/** A "finished" alert while a cycle still has more than this left (seconds) is ignored as premature. */
const EARLY_ALERT_LEFT = 10 * 60;

/** If a cycle stops being seen with this little time left, it counts as finished. */
const NEAR_END = 3 * 60;
/** How long "done" stays detected when the finish was only inferred (the machine already powered off). */
const INFERRED_DONE_MS = 60_000;
/** A cycle count of 0 after a real one is only believed when it lasts this long (seen: 16 → 0 → 16 at power-on). */
const ZERO_COUNT_MS = 30_000;

export class LaundryAccessory {
  readonly valve: Service;
  readonly doneSensor: Service;
  readonly problemSensor: Service;
  readonly phaseSensors = new Map<string, Service>();
  readonly tubCleanSensor: Service | undefined;
  readonly doorSensor: Service | undefined;
  readonly rinseAidSensor: Service | undefined;
  readonly ovenThermostat: Service | undefined;
  /** After a start from the Home app: the program time chosen before it, checked for a few minutes. */
  private startCheck: { programTime: number; until: number } | undefined;
  /** When LG started reporting a cycle count of 0 after a real one (0: it isn't). */
  private zeroCountSince = 0;
  /**
   * A start (on) or pause (off) sent from the Home app that LG hasn't reported yet: the tile shows
   * it meanwhile, and taps asking for the same aren't sent again (seen: a dryer took 7 s to report
   * running, the tile showed off, and four more starts were sent).
   */
  private pending: { on: boolean; until: number } | undefined;
  readonly remoteStartSensor: Service | undefined;
  /** The temperature to start the oven at (°C), from the Home app or the oven. */
  private ovenTarget = DEFAULT_OVEN_C;
  /** Until when the Home app's temperature wins over the oven's report. */
  private ovenTargetHeldUntil = 0;
  /** When a start was last sent. */
  private ovenStartedAt = 0;
  /** The unit the oven shows, once it has reported one. */
  private ovenUnit: 'C' | 'F' | undefined;
  status: LaundryStatus | null = null;
  private inferredDoneUntil = 0;
  private inferredTimer: NodeJS.Timeout | undefined;
  /** A "finished" alert that came with a lot of time still shown: applied unless the next state is still mid-cycle. */
  private heldFinish = false;
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
      .setCharacteristic(C.Model, options.model || stateLabel(unit.kind))
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

    // Dishwasher door and rinse aid, when reported
    this.doorSensor = this.optional(unit.hasDoor, S.ContactSensor, `${name} door`, 'door');
    this.rinseAidSensor = this.optional(unit.hasRinseAid, S.OccupancySensor, `${name} rinse aid low`, 'rinse-aid');

    // Tub-clean reminder: washers that report a cycle count, when the setting is on
    const tubClean = accessory.getServiceById(S.OccupancySensor, 'tub-clean');
    if (options.tubCleanAfter > 0 && unit.kind === 'washer' && unit.countsCycles) {
      this.tubCleanSensor = this.service(S.OccupancySensor, `${name} tub clean`, 'tub-clean');
    } else if (tubClean) {
      accessory.removeService(tubClean);
    }

    // Remote Start on at the machine: only useful when the Home app may start it
    this.remoteStartSensor = this.optional(unit.reportsRemoteStart && options.allowControl && unit.kind !== 'oven'
      && options.remoteStartSensor !== false,
      S.OccupancySensor, `${name} remote start`, 'remote-start');

    // Oven temperature, when the oven accepts one
    this.ovenThermostat = this.optional(!!unit.oven, S.Thermostat, `${name} temperature`, 'oven-temperature');
    if (this.ovenThermostat && unit.oven) {
      const r = unit.oven.ranges;
      const c = r.C || { min: Math.floor(toC(r.F!.min)), max: Math.ceil(toC(r.F!.max)), step: 0.5 };
      // Half degrees when the oven also works in °F, so every whole °F can be chosen; rounded for LG when sent
      const step = r.F ? Math.min(0.5, c.step) : c.step;
      this.ovenTarget = Math.min(c.max, Math.max(c.min, r.F ? toC(DEFAULT_OVEN_F) : DEFAULT_OVEN_C));
      const t = this.ovenThermostat;
      limit(t.getCharacteristic(C.TargetTemperature), { minValue: c.min, maxValue: c.max, minStep: step });
      limit(t.getCharacteristic(C.CurrentTemperature), { minValue: 0, maxValue: Math.max(c.max, 100) });
      limit(t.getCharacteristic(C.TargetHeatingCoolingState), { validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT] });
      limit(t.getCharacteristic(C.CurrentHeatingCoolingState), { validValues: [C.CurrentHeatingCoolingState.OFF, C.CurrentHeatingCoolingState.HEAT] });
      t.getCharacteristic(C.TemperatureDisplayUnits).updateValue(r.F && !r.C ? C.TemperatureDisplayUnits.FAHRENHEIT : C.TemperatureDisplayUnits.CELSIUS);
      t.getCharacteristic(C.TargetHeatingCoolingState).onSet((v) => this.setOvenHeat(v === C.TargetHeatingCoolingState.HEAT));
      t.getCharacteristic(C.TargetTemperature).onSet((v) => this.setOvenTemperature(Number(v)));
    }
    this.render();
  }

  /** A service the machine may or may not have: added when it does, removed when it doesn't. */
  private optional(wanted: boolean, type: typeof Service.Valve, name: string, subtype: string): Service | undefined {
    if (wanted) { return this.service(type, name, subtype); }
    const old = this.accessory.getServiceById(type, subtype);
    if (old) { this.accessory.removeService(old); }
    return undefined;
  }

  /** Get or add a service, and keep its name in step with the settings. */
  private service(type: typeof Service.Valve, raw: string, subtype: string): Service {
    const { Characteristic: C } = this.deps.api.hap;
    const name = displayName(this.options.name, raw);
    const svc = this.accessory.getServiceById(type, subtype) || this.accessory.addService(type, name, subtype);
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    // Set once: a name changed in the Home app wins after that
    const configured = svc.getCharacteristic(C.ConfiguredName);
    const shown = keepOrUpdate(configured.value, name);
    if (shown) { configured.updateValue(shown); }
    return svc;
  }

  /** New status from LG; null when LG can't be reached. */
  update(incoming: LaundryStatus | null): void {
    const prev = this.status;
    const next = this.steadyCount(incoming, prev);
    this.checkProgramAfterStart(next);
    if (this.heldFinish && next) {
      this.heldFinish = false;
      if (next.running && next.remaining > EARLY_ALERT_LEFT) {
        this.deps.log.debug(`[${this.options.name}] The earlier "finished" alert was premature: the cycle is still running.`);
      } else if (!next.running && !next.paused) {
        this.deps.log.info(`[${this.options.name}] LG says the cycle is finished.`);
        this.finishedAlert = next.state !== 'POWER_OFF';
        if (!this.finishedAlert) { this.briefDone(); }
      }
    }
    if (next && prev && (prev.running || prev.paused) && !next.running && !next.paused && !next.done && !next.error
      && prev.total > 0 && prev.state !== 'DETECTING' && prev.remaining <= NEAR_END) {
      // Missed the END state between two looks (the machine went straight to off): still a finish.
      // Only when a time was known: early on (DETECTING) LG reports 0 left, and stopping then isn't a finish.
      this.briefDone();
    }
    if (next && (next.running || next.paused)) {
      // A new cycle (or a resumed one): earlier finishes and alerts no longer apply
      this.inferredDoneUntil = 0;
      this.finishedAlert = false;
      this.problemAlert = '';
    } else if (next && next.state === 'POWER_OFF') {
      // Switched off: alerts end (an inferred finish still shows briefly)
      if (prev?.state === 'END' || (this.finishedAlert && prev?.state !== 'WRINKLE_CARE')) {
        // Straight from finished (many washers switch themselves off a minute later): the laundry is
        // still waiting, so "done" stays on until the machine is next used. From wrinkle care
        // someone switched it off at the machine, so it ends.
        this.holdDone();
      }
      this.finishedAlert = false;
      this.problemAlert = '';
    } else if (next && !next.done && !next.error && prev?.state === 'POWER_OFF') {
      // Switched on again: the next load
      this.inferredDoneUntil = 0;
    }
    if (next && prev && next.state !== prev.state) {
      const left = next.remaining ? `, ${Math.round(next.remaining / 60)} min left` : '';
      const course = next.course && (next.running || next.paused) ? ` (${stateLabel(next.course).toLowerCase()})` : '';
      const wait = next.startsIn ? `, starts in ${duration(next.startsIn)}` : '';
      this.deps.log.info(`[${this.options.name}] ${stateLabel(next.state, this.unit.kind)}${course}${left}${wait}.`);
      if (next.error) {
        this.deps.log.warn(`[${this.options.name}] The machine reports an error${next.errorName ? `: ${next.errorName}` : ''}.`);
      }
    }
    const count = next?.cycleCount;
    // LG sends the new count in an update of its own, right after the end
    if (count !== undefined && prev?.cycleCount !== undefined && count > prev.cycleCount && prev.cycleCount > 0) {
      this.deps.log.info(`[${this.options.name}] LG now counts ${count} cycles.`);
    }
    if (this.tubCleanSensor && count !== undefined && count >= this.options.tubCleanAfter
      && (prev?.cycleCount === undefined || prev.cycleCount < this.options.tubCleanAfter)) {
      this.deps.log.info(`[${this.options.name}] Time for a Tub Clean: LG counts ${count} cycles (reminder set at ${this.options.tubCleanAfter}).`);
    }
    if (next) { this.status = next; }
    this.render(next === null);
  }

  /**
   * LG's API can only send START, and some machines then run their default program instead of the
   * one chosen on the dial (seen on an LG washer: Speed Wash, 15 min, became Normal, 65 min). Right
   * after a start from the Home app, a program time that jumps says so in the log.
   */
  private checkProgramAfterStart(next: LaundryStatus | null): void {
    const check = this.startCheck;
    if (!check || !next) { return; }
    if (Date.now() > check.until) { this.startCheck = undefined; return; }
    if (!next.running || !next.total || next.state === 'DETECTING') { return; }
    this.startCheck = undefined;
    if (Math.abs(next.total - check.programTime) >= PROGRAM_CHANGE) {
      const min = (s: number) => duration(s);
      this.deps.log.warn(`[${this.options.name}] The cycle time changed from ${min(check.programTime)} to ${min(next.total)} `
        + 'right after the start from the Home app: LG may have started the washer\'s default program rather than the '
        + 'one chosen on it (LG\'s API can only send "start", not a program).');
    }
  }

  /** Running, or what was just asked from the Home app until LG reports it (or 30 s pass). */
  private shownOn(s: LaundryStatus | null | undefined): boolean {
    const p = this.pending;
    if (p && (Date.now() > p.until || !!s?.running === p.on)) { this.pending = undefined; }
    return this.pending ? this.pending.on : !!s?.running;
  }

  /** "Done" for a minute: the machine is already off, so nothing else would end it. */
  private briefDone(): void {
    this.keepDone(Math.max(INFERRED_DONE_MS, this.holdMs));
  }

  /** "Done" kept after the machine switched itself off from finished, until it's next used. */
  private holdDone(): void {
    if (this.holdMs > 0) { this.keepDone(this.holdMs); }
  }

  /** Ovens finish cooking, not a load to take out: their "done" ends with them. */
  private get holdMs(): number {
    return this.unit.kind === 'oven' ? 0 : (this.options.doneHoldMinutes ?? DEFAULT_DONE_HOLD_MIN) * 60_000;
  }

  private keepDone(ms: number): void {
    this.inferredDoneUntil = Date.now() + ms;
    clearTimeout(this.inferredTimer);
    this.inferredTimer = setTimeout(() => { this.inferredDoneUntil = 0; this.render(); }, ms);
    this.inferredTimer.unref?.();
  }

  /**
   * LG briefly reports a cycle count of 0 when a washer is switched on, then the real one (seen:
   * 16 → 0 → 16). Believing it would switch the tub-clean sensor off and on (with a notification)
   * at every power-on, so a 0 after a real count only counts once it has lasted a while.
   */
  private steadyCount(next: LaundryStatus | null, prev: LaundryStatus | null): LaundryStatus | null {
    if (!next || next.cycleCount !== 0 || !prev?.cycleCount) { this.zeroCountSince = 0; return next; }
    if (!this.zeroCountSince) { this.zeroCountSince = Date.now(); }
    if (Date.now() - this.zeroCountSince >= ZERO_COUNT_MS) { return next; }
    return { ...next, cycleCount: prev.cycleCount };
  }

  get done(): boolean {
    return !!this.status?.done || this.finishedAlert || this.inferredDoneUntil > Date.now();
  }

  /**
   * Remote Start is on and the machine waits to be started. LG's flag alone also stays on during a
   * cycle and comes on by itself in a dryer's wrinkle care, where "start" would begin a new cycle.
   */
  get waitingForStart(): boolean {
    const s = this.status;
    return !!s?.remoteControl && !s.running && !s.paused && !s.done && !s.error && s.state !== 'POWER_OFF';
  }

  get problem(): boolean {
    return !!this.status?.error || !!this.problemAlert;
  }

  /** An LG alert for this machine, from live updates. */
  alert(kind: 'finished' | 'problem' | 'other', pushCode: string): void {
    const name = this.options.name;
    if (kind === 'finished') {
      const s = this.status;
      // Some washers send "washing is complete" while still weighing the load: not a finish
      if (s?.running && s.state === 'DETECTING') {
        this.deps.log.debug(`[${name}] Ignored LG's "${pushCode}" alert: the machine is still detecting the load.`);
        return;
      }
      // With a lot of time still shown, the next state decides (a sensor dry can end early)
      if (s?.running && s.remaining > EARLY_ALERT_LEFT) {
        this.deps.log.debug(`[${name}] LG's "${pushCode}" alert with ${Math.round(s.remaining / 60)} min still shown: waiting for the next state.`);
        this.heldFinish = true;
        return;
      }
      this.deps.log.info(`[${name}] LG says the cycle is finished.`);
      if (s && (s.state === 'POWER_OFF')) {
        // Already off: a brief "done", as when a finish is inferred
        this.briefDone();
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
    const on = this.shownOn(s);
    set(this.valve.getCharacteristic(C.Active), on ? C.Active.ACTIVE : C.Active.INACTIVE);
    set(this.valve.getCharacteristic(C.InUse), on ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
    set(this.valve.getCharacteristic(C.RemainingDuration), Math.min(s?.remaining ?? 0, 86_400));
    set(this.valve.getCharacteristic(C.SetDuration), Math.min(s?.total ?? 0, 86_400));
    set(this.valve.getCharacteristic(C.StatusFault), unreachable || this.problem ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
    set(this.doneSensor.getCharacteristic(C.OccupancyDetected),
      this.done ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    set(this.problemSensor.getCharacteristic(C.ContactSensorState),
      this.problem ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
    if (this.doorSensor && s?.doorOpen !== undefined) {
      set(this.doorSensor.getCharacteristic(C.ContactSensorState),
        s.doorOpen ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
    }
    if (this.rinseAidSensor && s?.rinseAidLow !== undefined) {
      set(this.rinseAidSensor.getCharacteristic(C.OccupancyDetected),
        s.rinseAidLow ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
    if (this.tubCleanSensor) {
      const due = s?.cycleCount !== undefined && s.cycleCount >= this.options.tubCleanAfter;
      set(this.tubCleanSensor.getCharacteristic(C.OccupancyDetected),
        due ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
    if (this.remoteStartSensor) {
      set(this.remoteStartSensor.getCharacteristic(C.OccupancyDetected),
        this.waitingForStart ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
    if (this.ovenThermostat) {
      const t = this.ovenThermostat;
      const set_ = s?.setTemperature;
      const heating = !!(s?.running || s?.paused);
      if (s?.temperatureUnit) { this.ovenUnit = s.temperatureUnit; }
      // The oven's temperature counts while it's on, unless one was just chosen in the Home app
      if (set_ && heating && Date.now() > this.ovenTargetHeldUntil) {
        this.ovenTarget = set_.unit === 'F' ? toC(set_.value) : set_.value;
      }
      const maxC = t.getCharacteristic(C.TargetTemperature).props.maxValue ?? 300;
      const minC = t.getCharacteristic(C.TargetTemperature).props.minValue ?? 0;
      set(t.getCharacteristic(C.TargetTemperature), Math.min(maxC, Math.max(minC, this.ovenTarget)));
      const shown = set_ ? Math.round((set_.unit === 'F' ? toC(set_.value) : set_.value) * 10) / 10 : 0;
      set(t.getCharacteristic(C.CurrentTemperature), heating ? Math.min(shown, t.getCharacteristic(C.CurrentTemperature).props.maxValue ?? 300) : 0);
      set(t.getCharacteristic(C.CurrentHeatingCoolingState), heating ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
      set(t.getCharacteristic(C.TargetHeatingCoolingState), heating ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
      if (this.ovenUnit) {
        set(t.getCharacteristic(C.TemperatureDisplayUnits),
          this.ovenUnit === 'F' ? C.TemperatureDisplayUnits.FAHRENHEIT : C.TemperatureDisplayUnits.CELSIUS);
      }
    }
    for (const [phase, svc] of this.phaseSensors) {
      set(svc.getCharacteristic(C.OccupancyDetected),
        s?.state === phase ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
  }

  /** Refuses a Home app action: logged, the tile set back, and an error shown in the Home app. */
  private refuse(why: string, level: 'info' | 'warn' = 'info'): never {
    const { HapStatusError, HAPStatus } = this.deps.api.hap;
    this.deps.log[level](`[${this.options.name}] ${why}`);
    setTimeout(() => this.render(), 50).unref?.();
    throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
  }

  /** Control must be allowed in the settings, and remote control on at the appliance. */
  private checkControl(action: string): void {
    if (!this.options.allowControl) {
      this.refuse('Ignored the tap in the Home app: control is off in the plugin settings ("Allow starting and pausing").');
    }
    if (!this.status?.remoteControl) {
      this.refuse(this.unit.kind === 'oven'
        ? `Can't ${action}: turn on remote control on the oven first (LG only accepts commands then).`
        : `Can't ${action}: press Remote Start on the machine first (LG only accepts commands then).`);
    }
  }

  /** Self-cleaning: no cooking commands (they could end the clean). */
  private get ovenCleaning(): boolean {
    return this.status?.state === 'CLEANING';
  }

  /** °F when the oven shows °F, or only takes °F. */
  private get ovenPrefersF(): boolean {
    return this.ovenUnit === 'F' || (!this.ovenUnit && !this.unit.oven?.ranges.C);
  }

  /** The cook mode for a start: the oven's current one if it accepts it, else its first (bake). */
  private get ovenMode(): string | undefined {
    const s = this.status;
    return s?.cookMode && this.unit.oven?.cookModes.includes(s.cookMode) ? s.cookMode : this.unit.oven?.cookModes[0];
  }

  /** The oven thermostat set to heat (start at the set temperature) or off (stop). */
  private async setOvenHeat(on: boolean): Promise<void> {
    const s = this.status;
    if (on === !!(s?.running || s?.paused)) { return; }
    this.checkControl(on ? 'start the oven' : 'stop the oven');
    if (!on) { return this.sendOperation('STOP', 'Sent stop.'); }
    if (this.ovenCleaning) { this.refuse('The oven is self-cleaning: it can\'t be started now.'); }
    if (!this.unit.operations.includes('START')) { this.refuse('This oven doesn\'t accept START through LG\'s API.'); }
    // A scene or the thermostat screen may set the temperature in the same action: let it arrive first
    await new Promise((r) => setTimeout(r, OVEN_START_DELAY_MS));
    await this.sendOvenStart('Sent start');
  }

  private async sendOvenStart(label: string): Promise<void> {
    const mode = this.ovenMode;
    const payload = ovenStartPayload(this.unit, this.ovenTarget, mode, this.ovenPrefersF);
    const t = payload.temperature as { targetTemperature: number; unit: string };
    this.ovenStartedAt = Date.now();
    await this.sendPayload(payload, `${label}: ${mode ? `${stateLabel(mode).toLowerCase()}, ` : ''}${t.targetTemperature} °${t.unit}.`, 'START');
  }

  /**
   * A new temperature from the Home app: sent right away while the oven is cooking (or was just
   * started), else kept for the next start. A paused oven isn't restarted by it.
   */
  private async setOvenTemperature(celsius: number): Promise<void> {
    if (!Number.isFinite(celsius)) { return; }
    const s = this.status;
    this.ovenTarget = celsius;
    this.ovenTargetHeldUntil = Date.now() + OVEN_TARGET_HOLD_MS;
    const cooking = !!s?.running && !this.ovenCleaning;
    const justStarted = Date.now() - this.ovenStartedAt < OVEN_RESEND_MS && !s?.paused;
    if (!cooking && !justStarted) { return; }
    this.checkControl('change the oven temperature');
    await this.sendOvenStart('Sent temperature');
  }

  private async sendOperation(operation: string, done: string): Promise<void> {
    if (!this.unit.operations.includes(operation)) { this.refuse(`This appliance doesn't accept ${operation} through LG's API.`); }
    await this.sendPayload(operationPayload(this.unit, operation), done, operation);
  }

  private async sendPayload(payload: Record<string, unknown>, done: string, what: string): Promise<void> {
    try {
      await this.send(payload);
      this.deps.log.info(`[${this.options.name}] ${done}`);
    } catch (err) {
      if (err instanceof ThinQError && err.unconfirmed) {
        // LG may well have carried it out (seen: the washer started, LG answered 2211): check
        this.deps.log[err.timedOut ? 'warn' : 'info'](
          `[${this.options.name}] ${done.replace(/\.$/, '')}, but LG didn't confirm it (${err.message}): checking the machine.`);
        return;
      }
      this.startCheck = undefined;
      this.refuse(`LG refused ${what}: ${(err as Error).message}`, 'warn');
    } finally {
      this.refreshSoon();
    }
  }

  /** The valve tapped in the Home app: start or resume (on), pause (off). */
  private async setActive(value: CharacteristicValue): Promise<void> {
    const s = this.status;
    const wantOn = value === 1 || value === true;
    if (wantOn === !!s?.running) { return; }
    // Already sent, LG hasn't reported it yet: don't send it again
    if (this.pending && this.pending.on === wantOn && Date.now() <= this.pending.until) { return; }
    if (this.ovenThermostat && wantOn) {
      // An oven starts from its thermostat, always with a temperature and mode
      if (s?.paused) { this.refuse('The oven is paused: resume it at the oven.'); }
      return this.setOvenHeat(true);
    }
    this.checkControl(wantOn ? 'start' : 'pause');
    const operation = wantOn ? 'START' : 'STOP';
    if (!this.unit.operations.includes(operation)) {
      this.refuse(`This machine doesn't accept ${operation} through LG's API.`);
    }
    if (wantOn && !s?.paused && s?.programTime && this.unit.kind === 'washer') {
      this.startCheck = { programTime: s.programTime, until: Date.now() + START_CHECK_MS };
    }
    await this.sendPayload(operationPayload(this.unit, operation), `Sent ${wantOn ? (s?.paused ? 'resume' : 'start') : 'pause'}.`, operation);
    // Sent (or LG didn't confirm): show it until LG reports it
    this.pending = { on: wantOn, until: Date.now() + PENDING_MS };
    this.render();
  }

  stop(): void {
    clearTimeout(this.inferredTimer);
  }
}

/**
 * Update a characteristic when its value changes, or when it carries an error status: HAP-NodeJS
 * keeps the error from a refused tap and returns it for every later read (the Home app then shows
 * "No Response") until a value is pushed again.
 */
function set(ch: Characteristic, value: CharacteristicValue): void {
  if (ch.value !== value || ch.statusCode !== 0) { ch.updateValue(value); }
}

/** "2 h 30 min", "45 min" */
function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
