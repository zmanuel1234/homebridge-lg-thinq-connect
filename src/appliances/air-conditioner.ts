// Air conditioners as a heater/cooler tile: on/off, cool / heat / auto, the room temperature, the
// set temperature, fan speed (Auto at the top of the slider) and swing. The approach follows
// homebridge-lg-thinqconnect-ac (MIT), which runs this on the same LG API; the sample data is Home
// Assistant's (see test fixtures).
//
// Extras, for what a unit's profile offers (and the "extra controls" setting allows): switches for
// air purify, energy saving, the display light, the swing direction the tile doesn't move, jet
// mode, and dry and fan-only modes; air quality, humidity and filter sensors; and in auto mode,
// separate heating and cooling set points when the unit uses two of them ("two-set"). Per
// appliance (settings): cooling or heating only, which way the tile swings, a room temperature sensor.
// Newer units' airflow styles (forest wind, air guide…) as switches, and errors (runState ERROR) on the
// problem sensor. Fan speed reads windStrength, or windStrengthDetail on units with only that.
//
// LG modes without a heater/cooler equivalent (fan only, dry, air clean) show as on and idle.

import type { CharacteristicValue, Service } from 'homebridge';
import { field } from '../api';
import { alertKind } from '../laundry';
import { Appliance, type ApplianceContext, set, limit } from './base';
import { AirSensors, alertCodes } from './sensors';
import {
  type Obj, type Range, cToF, enumValues, fToC, fieldOf, levelFor, levelPercent, powerField, resources, speedLevels,
  stateValue, temperatureC, temperatureRangeC, unitOf, writable,
} from './profile';

export { alertCodes } from './sensors';

const MODES = ['COOL', 'HEAT', 'AUTO'] as const;
type Mode = typeof MODES[number];

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** How long a mode picked while off waits for the same Home app action's on/off (ms). */
const PENDING_ON_MS = 150;
/** A mode written this soon after an off isn't a request to switch on (ms). */
const RECENT_OFF_MS = 2000;

/** Airflow styles some units offer (windDirection.*), with names for the Home app. */
const AIRFLOW_STYLES: [string, string][] = [
  ['airGuideWind', 'air guide'], ['autoFitWind', 'auto-fit airflow'], ['concentrationWind', 'focused airflow'],
  ['forestWind', 'forest wind'], ['highCeilingWind', 'high ceiling'], ['longPowerWind', 'long-range airflow'],
  ['mannerWind', 'gentle airflow'], ['swirlWind', 'swirl'],
];

/** An extra on/off control: how to read it from the state, and the command for on or off. */
interface Extra {
  subtype: string;
  label: string;
  read(state: unknown): boolean | undefined;
  payload(on: boolean): Record<string, unknown>;
  service?: Service;
  value: boolean;
}

export class AirConditioner extends Appliance {
  readonly tile: Service;
  readonly extras: Extra[] = [];
  private readonly sensors: AirSensors;
  private readonly res: Obj;
  private readonly power?: { name: string; canWrite: boolean };
  private readonly modes: Mode[];
  private readonly speeds: string[];
  private readonly swingFields: string[] = [];
  /** windStrength, or windStrengthDetail on units that only have that. */
  private readonly windKey: string;
  /** The unit reports an error (runState ERROR). */
  private error = false;
  /** The tile offers fewer modes than the unit has (cooling or heating only). */
  private readonly restricted: boolean;
  private readonly roomSensor?: Service;
  private readonly ranges: Partial<Record<Mode, Range>>;
  private readonly twoSetRanges?: { heat?: Range; cool?: Range };
  on = false;
  private mode = 'COOL';
  private lastMode: Mode = 'COOL';
  private current = 22;
  target = 22;
  private twoSet = false;
  private heatTarget?: number;
  private coolTarget?: number;
  private unit: 'C' | 'F' = 'C';
  private speed = 0;
  private wind = '';
  private swing = false;

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    this.res = resources(profile);
    this.power = powerField(this.res);
    const jobModes = enumValues(fieldOf(this.res, 'airConJobMode', 'currentJobMode'), 'w');
    const opts = ctx.options || {};
    const only = opts.acModes === 'cool' ? 'COOL' : opts.acModes === 'heat' ? 'HEAT' : undefined;
    const offered = MODES.filter((m) => jobModes.includes(m));
    // Cooling or heating only (a unit used one way): the tile offers just that, if the unit has it
    this.modes = only && offered.includes(only) ? [only] : offered;
    this.restricted = this.modes.length < offered.length;
    if (only && !offered.includes(only)) {
      ctx.log.warn(`[${ctx.name}] Set to ${opts.acModes === 'cool' ? 'cooling' : 'heating'} only, but this unit has no ${only.toLowerCase()} mode: showing all its modes.`);
    }
    // Fan speed: windStrength (it has Auto); windStrengthDetail only on units without it
    this.windKey = writable(fieldOf(this.res, 'airFlow', 'windStrength')) ? 'windStrength'
      : writable(fieldOf(this.res, 'airFlow', 'windStrengthDetail')) ? 'windStrengthDetail' : 'windStrength';
    const wind = fieldOf(this.res, 'airFlow', this.windKey);
    this.speeds = writable(wind) ? speedLevels(wind) : [];
    const swings = ['rotateUpDown', 'rotateLeftRight'].filter((f) => writable(fieldOf(this.res, 'windDirection', f)));
    const wanted = opts.acSwing === 'left-right' ? ['rotateLeftRight'] : opts.acSwing === 'both' ? swings : ['rotateUpDown'];
    // The axes the tile's swing moves; up-down unless chosen otherwise, or the only one the unit has
    this.swingFields = swings.filter((f) => wanted.includes(f));
    if (!this.swingFields.length && swings.length) { this.swingFields = [swings[0]]; }
    const any = this.tempRange('targetTemperature');
    this.ranges = {
      COOL: this.tempRange('coolTargetTemperature') || any,
      HEAT: this.tempRange('heatTargetTemperature') || any,
      AUTO: this.tempRange('autoTargetTemperature') || any,
    };
    if (this.res.twoSetTemperatureInUnits) {
      this.twoSetRanges = {
        heat: temperatureRangeC(this.res, 'twoSetTemperatureInUnits', 'heatTargetTemperature'),
        cool: temperatureRangeC(this.res, 'twoSetTemperatureInUnits', 'coolTargetTemperature'),
      };
    }

    this.tile = this.service(S.HeaterCooler, ctx.name, 'climate');
    this.tile.setPrimaryService(true);
    this.tile.getCharacteristic(C.Active).onSet((v) => this.setPower(v));
    const target = this.tile.getCharacteristic(C.TargetHeaterCoolerState);
    const valid = this.modes.map((m) => this.hkMode(m)).sort((a, b) => a - b);
    if (valid.length) { limit(target, { validValues: valid }); }
    target.onSet((v) => this.setMode(v));
    this.tile.getCharacteristic(C.CoolingThresholdTemperature).onSet((v) => this.setThreshold('cool', Number(v)));
    this.tile.getCharacteristic(C.HeatingThresholdTemperature).onSet((v) => this.setThreshold('heat', Number(v)));
    this.applyRange();
    if (this.speeds.length) {
      this.tile.getCharacteristic(C.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet((v) => this.setSpeed(Number(v)));
    } else if (this.tile.testCharacteristic(C.RotationSpeed)) {
      this.tile.removeCharacteristic(this.tile.getCharacteristic(C.RotationSpeed));
    }
    if (this.swingFields.length) {
      this.tile.getCharacteristic(C.SwingMode).onSet((v) => this.setSwing(v));
    } else if (this.tile.testCharacteristic(C.SwingMode)) {
      this.tile.removeCharacteristic(this.tile.getCharacteristic(C.SwingMode));
    }

    const keep = new Set(['climate']);
    // Portable units alert when their water tank is full: a problem sensor for that
    const errorState = enumValues(fieldOf(this.res, 'runState', 'currentState'), 'r').includes('ERROR');
    if (errorState || alertCodes(profile).some((c) => alertKind(c) === 'problem')) {
      this.addProblemSensor();
      keep.add('problem');
    }
    this.sensors = new AirSensors(this, this.res, ctx.name, (t, n, s) => this.service(t, n, s), keep, true);
    if (opts.temperatureSensor) {
      this.roomSensor = this.service(S.TemperatureSensor, `${ctx.name} room temperature`, 'room-temperature');
      limit(this.roomSensor.getCharacteristic(C.CurrentTemperature), { minValue: -40, maxValue: 100 });
      keep.add('room-temperature');
    }
    if ((opts.extraControls ?? ctx.extraControls) !== false) {
      for (const extra of this.findExtras(jobModes)) {
        extra.service = this.service(S.Switch, `${ctx.name} ${extra.label}`, extra.subtype);
        extra.service.getCharacteristic(C.On).onSet((v) => this.setExtra(extra, v === true || v === 1));
        this.extras.push(extra);
        keep.add(extra.subtype);
      }
    }
    this.prune(keep);
    this.render();
  }

  /** The extra controls this unit's profile offers. */
  private findExtras(jobModes: string[]): Extra[] {
    const out: Extra[] = [];
    const add = (e: Omit<Extra, 'value'>) => { out.push({ ...e, value: false }); };
    const airClean = enumValues(fieldOf(this.res, 'operation', 'airCleanOperationMode'), 'w');
    if (airClean.includes('START')) {
      // Some units don't report it back: the switch then shows the last command
      add({ subtype: 'air-purify', label: 'air purify',
        read: (s) => { const v = stateValue(s, 'operation', 'airCleanOperationMode'); return v === undefined ? undefined : v === 'START'; },
        payload: (on) => ({ operation: { airCleanOperationMode: on ? 'START' : 'STOP' } }) });
    }
    if (writable(fieldOf(this.res, 'powerSave', 'powerSaveEnabled'))) {
      add({ subtype: 'energy-saving', label: 'energy saving',
        read: (s) => bool(stateValue(s, 'powerSave', 'powerSaveEnabled')),
        payload: (on) => ({ powerSave: { powerSaveEnabled: on } }) });
    }
    const light = fieldOf(this.res, 'display', 'light');
    if (writable(light)) {
      const onOff = enumValues(light, 'w').includes('ON');
      add({ subtype: 'display-light', label: 'display light',
        read: (s) => { const v = stateValue(s, 'display', 'light'); return onOff ? (v === undefined ? undefined : v === 'ON') : bool(v); },
        payload: (on) => ({ display: { light: onOff ? (on ? 'ON' : 'OFF') : on } }) });
    }
    // The axis the tile's swing doesn't move gets a switch of its own
    for (const [f, sub, label] of [['rotateLeftRight', 'swing-left-right', 'swing left-right'], ['rotateUpDown', 'swing-up-down', 'swing up-down']] as const) {
      if (this.swingFields.length && !this.swingFields.includes(f) && writable(fieldOf(this.res, 'windDirection', f))) {
        add({ subtype: sub, label,
          read: (s) => bool(stateValue(s, 'windDirection', f)),
          payload: (on) => ({ windDirection: { [f]: on } }) });
      }
    }
    const windKey = this.windKey;
    if (enumValues(fieldOf(this.res, 'airFlow', windKey), 'w').includes('POWER')) {
      add({ subtype: 'jet', label: 'jet mode',
        read: (s) => { const v = stateValue(s, 'airFlow', windKey); return v === undefined ? undefined : v === 'POWER'; },
        payload: (on) => ({ airFlow: { [windKey]: on ? 'POWER' : (this.speeds.includes('AUTO') ? 'AUTO' : this.speeds.at(-1) || 'HIGH') } }) });
    }
    // Airflow styles on newer units (LG's Python toolkit 1.0.14), each on or off
    for (const [name, label] of AIRFLOW_STYLES) {
      const desc = fieldOf(this.res, 'windDirection', name);
      if (!writable(desc) || field(desc, 'type') !== 'boolean') { continue; }
      add({ subtype: `wind-${name}`, label,
        read: (s) => bool(stateValue(s, 'windDirection', name)),
        payload: (on) => ({ windDirection: { [name]: on } }) });
    }
    for (const [mode, label] of [['AIR_DRY', 'dry mode'], ['FAN', 'fan mode']] as const) {
      if (!jobModes.includes(mode)) { continue; }
      add({ subtype: `mode-${mode}`, label,
        read: (s) => { const v = stateValue(s, 'airConJobMode', 'currentJobMode'); return v === undefined ? undefined : v === mode; },
        payload: (on) => ({ airConJobMode: { currentJobMode: on ? mode : (this.modes.includes(this.lastMode) ? this.lastMode : this.modes[0] || 'COOL') } }) });
    }
    return out;
  }

  private tempRange(name: string): Range | undefined {
    const c = temperatureRangeC(this.res, 'temperatureInUnits', name);
    if (c) { return c; }
    // The plain resource is in the unit the AC displays: an air conditioner set point above 40 is °F
    const r = temperatureRangeC(this.res, 'temperature', name);
    if (!r || r.max <= 40) { return r; }
    return { min: Math.round(fToC(r.min) * 2) / 2, max: Math.round(fToC(r.max) * 2) / 2, step: 0.5 };
  }

  private hkMode(m: Mode): number {
    const T = this.hap.Characteristic.TargetHeaterCoolerState;
    return m === 'HEAT' ? T.HEAT : m === 'AUTO' ? T.AUTO : T.COOL;
  }

  /** Two set points in auto mode: when the unit offers them and has them turned on. */
  private get usesTwoSet(): boolean {
    return !!this.twoSetRanges && this.twoSet && this.lastMode === 'AUTO';
  }

  /** The set temperature limits for the current mode (they differ by mode on some units). */
  private applyRange(): void {
    const { Characteristic: C } = this.hap;
    const r = this.ranges[this.lastMode] || { min: 16, max: 30, step: 1 };
    const two = this.usesTwoSet;
    const pairs = [
      [C.CoolingThresholdTemperature, two ? this.twoSetRanges?.cool || r : r, two ? this.coolTarget ?? this.target : this.target],
      [C.HeatingThresholdTemperature, two ? this.twoSetRanges?.heat || r : r, two ? this.heatTarget ?? this.target : this.target],
    ] as const;
    for (const [ch, range, value] of pairs) {
      const c = this.tile.getCharacteristic(ch);
      limit(c, { minValue: range.min, maxValue: range.max, minStep: range.step });
      set(c, Math.min(Math.max(value, range.min), range.max));
    }
  }

  update(state: unknown): void {
    this.unreachable = state === null;
    if (state !== null && state !== undefined) {
      const wasOn = this.on;
      if (this.power) { this.on = stateValue(state, 'operation', this.power.name) === 'POWER_ON'; }
      if (this.on !== wasOn) { this.problemAlert = ''; } // switched off and on: an emptied tank
      const run = stateValue(state, 'runState', 'currentState');
      if (typeof run === 'string') {
        if (run === 'ERROR' && !this.error) { this.ctx.log.warn(`[${this.ctx.name}] The air conditioner reports an error.`); }
        this.error = run === 'ERROR';
      }
      const mode = stateValue(state, 'airConJobMode', 'currentJobMode');
      if (typeof mode === 'string') {
        this.mode = mode;
        if ((MODES as readonly string[]).includes(mode)) { this.lastMode = mode as Mode; }
      }
      this.unit = unitOf(state, 'temperature');
      // temperature (in the unit the AC shows) first: live updates change it; temperatureInUnits as backup
      const read = (name: string) => temperatureC(field(state, 'temperature'), name) ?? temperatureC(field(state, 'temperatureInUnits'), name);
      this.current = read('currentTemperature') ?? this.current;
      this.target = read('targetTemperature') ?? this.target;
      if (this.twoSetRanges) {
        const enabled = stateValue(state, 'twoSetTemperature', 'twoSetEnabled');
        if (typeof enabled === 'boolean') { this.twoSet = enabled; }
        const two = field(state, 'twoSetTemperatureInUnits');
        this.heatTarget = temperatureC(two, 'heatTargetTemperature') ?? this.heatTarget;
        this.coolTarget = temperatureC(two, 'coolTargetTemperature') ?? this.coolTarget;
      }
      if (this.speeds.length) {
        const w = stateValue(state, 'airFlow', this.windKey);
        if (typeof w === 'string') { this.wind = w; }
        this.speed = levelPercent(this.speeds, this.wind) || 100;
      }
      if (this.swingFields.length) { this.swing = this.swingFields.some((f) => stateValue(state, 'windDirection', f) === true); }
      for (const e of this.extras) {
        const v = e.read(state);
        if (v !== undefined) { e.value = v; }
      }
      this.sensors.update(state);
    }
    this.applyRange();
    this.render();
  }

  private render(): void {
    const { Characteristic: C } = this.hap;
    set(this.tile.getCharacteristic(C.Active), this.on ? C.Active.ACTIVE : C.Active.INACTIVE);
    // A mode the tile doesn't offer (set on the remote) shows as the tile's first one
    const shown = this.modes.includes(this.lastMode) ? this.lastMode : this.modes[0] || 'COOL';
    set(this.tile.getCharacteristic(C.TargetHeaterCoolerState), this.hkMode(shown));
    const H = C.CurrentHeaterCoolerState;
    set(this.tile.getCharacteristic(H), !this.on ? H.INACTIVE : this.mode === 'HEAT' ? H.HEATING : this.mode === 'COOL' ? H.COOLING : H.IDLE);
    set(this.tile.getCharacteristic(C.CurrentTemperature), this.current);
    if (this.roomSensor) { set(this.roomSensor.getCharacteristic(C.CurrentTemperature), Math.max(-40, Math.min(100, this.current))); }
    if (this.speeds.length) { set(this.tile.getCharacteristic(C.RotationSpeed), this.speed); }
    if (this.swingFields.length) {
      set(this.tile.getCharacteristic(C.SwingMode), this.swing ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED);
    }
    for (const e of this.extras) { set(e.service!.getCharacteristic(C.On), e.value); }
    this.renderProblem(this.error);
  }

  override get busy(): boolean { return this.on; }

  private setPower(v: CharacteristicValue): Promise<void> {
    if (!this.power?.canWrite) { return this.refuse('This air conditioner can\'t be switched on or off through LG\'s API.'); }
    const on = v === 1 || v === true;
    this.powerWrite = { on, at: Date.now() };
    // A mode picked while off waits briefly for this: off wins, on sends power then that mode once
    const picked = this.cancelPendingOn();
    if (on === this.on) { return this.switching ?? Promise.resolve(); }
    if (!on) { return this.switchPower(false); }
    // Cooling or heating only: a unit left in another mode on its remote is switched to the tile's
    const restrictedMode = this.restricted && !(this.modes as string[]).includes(this.mode) ? this.modes[0] : undefined;
    return this.switchPower(true, picked ?? restrictedMode);
  }

  /** A mode picked on the tile while off, waiting to see whether the same action also switches it off. */
  private pendingOn?: { mode: Mode; timer: NodeJS.Timeout; done: (p: Promise<void>) => void };

  /** Cancels a waiting power-on; returns its mode (the caller now decides). */
  /** Homebridge is shutting down: a pending switch-on is dropped, not sent. */
  override stop(): void {
    if (this.pendingOn) { clearTimeout(this.pendingOn.timer); this.pendingOn = undefined; }
    super.stop();
  }

  private cancelPendingOn(): Mode | undefined {
    const p = this.pendingOn;
    if (!p) { return undefined; }
    clearTimeout(p.timer);
    this.pendingOn = undefined;
    // The mode write itself succeeds: what happens next is the power write's
    p.done(Promise.resolve());
    return p.mode;
  }

  /** The last on/off written from the Home app: an off just written keeps a mode from switching it back on. */
  private powerWrite?: { on: boolean; at: number };

  /** The power change under way, so a second write in the same action shares its result. */
  private switching?: Promise<void>;

  /**
   * Power, then (if given) a mode: two commands, one after the other, as LG takes one kind of
   * change per command and refuses a mode while the unit is off.
   */
  private switchPower(on: boolean, mode?: Mode): Promise<void> {
    this.on = on;
    let run = this.command(on ? 'Switched on' : 'Switched off', { operation: { [this.power!.name]: on ? 'POWER_ON' : 'POWER_OFF' } })
      .catch((err: unknown) => {
        // Back to what it was, unless LG reported a newer state meanwhile
        if (this.on === on) { this.on = !on; }
        throw err;
      });
    if (mode) {
      run = run.then(() => this.command(`Mode ${mode.toLowerCase()}`, { airConJobMode: { currentJobMode: mode } }))
        .then(() => { this.mode = mode; this.lastMode = mode; this.applyRange(); });
    }
    const switching = run.finally(() => { if (this.switching === switching) { this.switching = undefined; } });
    this.switching = switching;
    return switching;
  }

  private setMode(v: CharacteristicValue): Promise<void> {
    const T = this.hap.Characteristic.TargetHeaterCoolerState;
    const mode: Mode = v === T.HEAT ? 'HEAT' : v === T.AUTO ? 'AUTO' : 'COOL';
    if (!this.modes.includes(mode)) { return this.refuse(`This air conditioner has no ${mode.toLowerCase()} mode.`); }
    const justOff = this.powerWrite && !this.powerWrite.on && Date.now() - this.powerWrite.at < RECENT_OFF_MS;
    if (justOff) {
      // Switched off in the same action (a scene restoring "off, cooling"): keep the mode for next time
      this.lastMode = mode;
      this.applyRange();
      return Promise.resolve();
    }
    if (!this.on && this.power?.canWrite && !this.switching) {
      // A mode picked on an air conditioner that's off switches it on in that mode (LG refuses a
      // mode change while off), unless the same Home app action switches it off or on itself
      this.cancelPendingOn();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingOn = undefined;
          this.switchPower(true, mode).then(resolve, reject);
        }, PENDING_ON_MS);
        this.pendingOn = { mode, timer, done: (p) => { p.then(resolve, reject); } };
      });
    }
    // Switching on right now (same action): the mode follows the power command
    if (this.switching) { return this.switching.then(() => this.setMode(v)); }
    if (mode === this.mode) { return Promise.resolve(); }
    return this.command(`Mode ${mode.toLowerCase()}`, { airConJobMode: { currentJobMode: mode } })
      .then(() => { this.lastMode = mode; this.mode = mode; this.applyRange(); });
  }

  /** A set point from the tile: one set temperature, or in two-set auto mode, heating or cooling. */
  private setThreshold(which: 'cool' | 'heat', celsius: number): Promise<void> {
    if (this.usesTwoSet) {
      const current = which === 'cool' ? this.coolTarget : this.heatTarget;
      if (current !== undefined && Math.abs(celsius - current) < 0.01) { return Promise.resolve(); }
      const [value, unit] = this.unit === 'F' ? [Math.round(cToF(celsius)), 'F'] : [celsius, 'C'];
      return this.command(`${which === 'cool' ? 'Cooling' : 'Heating'} set to ${value} °${unit}`,
        { twoSetTemperatureInUnits: { [`${which}TargetTemperature`]: value, unit } })
        .then(() => { if (which === 'cool') { this.coolTarget = celsius; } else { this.heatTarget = celsius; } });
    }
    if (Math.abs(celsius - this.target) < 0.01) { return Promise.resolve(); }
    if (this.unit === 'F') {
      // The unit shows °F: send whole °F, as its own controls do
      const f = Math.round(cToF(celsius));
      return this.command(`Set to ${f} °F`, { temperature: { targetTemperature: f, unit: 'F' } }).then(() => { this.target = celsius; });
    }
    return this.command(`Set to ${celsius} °C`, { temperature: { targetTemperature: celsius } }).then(() => { this.target = celsius; });
  }

  private setSpeed(percent: number): Promise<void> {
    if (percent === 0) { return Promise.resolve(); } // the Home app sends 0 before switching off
    const level = levelFor(this.speeds, percent);
    if (level === this.wind) { return Promise.resolve(); }
    return this.command(`Fan ${level.toLowerCase()}`, { airFlow: { [this.windKey]: level } }).then(() => { this.wind = level; });
  }

  private setSwing(v: CharacteristicValue): Promise<void> {
    const on = v === this.hap.Characteristic.SwingMode.SWING_ENABLED;
    return this.command(on ? 'Swing on' : 'Swing off', { windDirection: Object.fromEntries(this.swingFields.map((f) => [f, on])) });
  }

  private setExtra(extra: Extra, on: boolean): Promise<void> {
    if (on === extra.value) { return Promise.resolve(); }
    return this.command(`${extra.label[0].toUpperCase()}${extra.label.slice(1)} ${on ? 'on' : 'off'}`, extra.payload(on))
      .then(() => { extra.value = on; });
  }

  private refuse(why: string): Promise<void> {
    this.ctx.log.info(`[${this.ctx.name}] ${why}`);
    setTimeout(() => this.render(), 50).unref?.();
    return Promise.reject(new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
  }
}
