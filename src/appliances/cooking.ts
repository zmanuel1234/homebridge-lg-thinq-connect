// Cooktops: which burners are on, for "the stove is still on" notifications and automations (a hood
// fan that follows the cooktop). LG's official API reports each cooking zone's state and power
// level; on the models that allow it, it can also switch every zone off. Turning burners on from
// the Home app isn't offered: that should happen at the cooktop.

import type { Service } from 'homebridge';
import { Appliance, type ApplianceContext, set } from './base.js';
import { field } from '../api.js';

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);

/** The entries of a profile's or state's property list (one per zone), or the single object. */
function entries(value: unknown): Obj[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(asObj).filter((e): e is Obj => !!e);
}

const zoneOf = (entry: Obj): string => {
  const name = field(field(entry, 'location'), 'locationName');
  return typeof name === 'string' ? name : '';
};

/** "LEFT_FRONT" → "left front", "BURNER_3" → "burner 3". */
export function zoneLabel(zone: string): string {
  return zone.toLowerCase().split('_').join(' ');
}

/** LG's zone states that mean the burner is on (PAUSE: on but held, still hot). */
const ON_STATES = new Set(['COOK', 'PAUSE']);

/**
 * Whether a cooktop profile can be switched off as a whole (operation.operationMode: POWER_OFF).
 * LG puts it in the profile's extensionProperty (as its own toolkits read it); also looked for in
 * the zones and at the top, in case a model differs.
 */
function canPowerOff(profile: unknown): boolean {
  const props = field(profile, 'property');
  for (const e of [...entries(field(profile, 'extensionProperty')), ...entries(props), asObj(profile) || {}]) {
    const w = field(field(field(field(e, 'operation'), 'operationMode'), 'value'), 'w');
    if (Array.isArray(w) && w.includes('POWER_OFF')) { return true; }
  }
  return false;
}

export class Cooktop extends Appliance {
  /** Main tile: on while any burner is. */
  readonly anyOn: Service;
  readonly zones = new Map<string, Service>();
  readonly offSwitch: Service | undefined;
  private on = new Map<string, boolean>();
  private levels = new Map<string, number>();

  constructor(ctx: ApplianceContext, profile: unknown) {
    super(ctx);
    const { Service: S, Characteristic: C } = this.hap;
    const keep = new Set<string>(['in-use', 'problem']);
    this.anyOn = this.service(S.OccupancySensor, ctx.name, 'in-use');
    this.anyOn.setPrimaryService(true);
    const zones = entries(field(profile, 'property')).map(zoneOf).filter(Boolean);
    for (const zone of [...new Set(zones)]) {
      const subtype = `zone-${zone}`;
      this.zones.set(zone, this.service(S.OccupancySensor, `${ctx.name} ${zoneLabel(zone)}`, subtype));
      keep.add(subtype);
    }
    if (canPowerOff(profile) && (ctx.options?.extraControls ?? ctx.extraControls) !== false) {
      this.offSwitch = this.service(S.Switch, `${ctx.name} all burners off`, 'power-off');
      keep.add('power-off');
      // A button: on sends "everything off", then it turns itself back off
      this.offSwitch.getCharacteristic(C.On).onSet(async (v) => {
        if (v !== true && v !== 1) { return; }
        try {
          await this.command('Switched every burner off', { operation: { operationMode: 'POWER_OFF' } });
        } finally {
          // Back off after a moment, whatever LG answered (also clears the error a refusal leaves)
          setTimeout(() => this.offSwitch && set(this.offSwitch.getCharacteristic(C.On), false), 1000).unref?.();
        }
      });
    }
    this.addProblemSensor();
    this.prune(keep);
    this.update(undefined);
  }

  override get busy(): boolean { return [...this.on.values()].some(Boolean); }

  update(state: unknown): void {
    const { Characteristic: C } = this.hap;
    this.unreachable = state === null;
    if (state) {
      const was = this.busy;
      // The full state (live updates are merged into it): a zone it no longer lists is off
      const listed = new Set(entries(state).map(zoneOf));
      for (const zone of this.on.keys()) {
        if (!listed.has(zone)) { this.on.set(zone, false); }
      }
      let changed = false;
      for (const e of entries(state)) {
        const zone = zoneOf(e);
        const word = field(field(e, 'cookingZone'), 'currentState');
        const level = field(field(e, 'power'), 'powerLevel');
        if (typeof level === 'number' && zone && level !== this.levels.get(zone)) { this.levels.set(zone, level); changed = true; }
        if (!zone || typeof word !== 'string') { continue; }
        if (this.on.get(zone) !== ON_STATES.has(word)) { changed = true; }
        this.on.set(zone, ON_STATES.has(word));
      }
      // The Home app has nothing for a burner's level: it's in the log (with the zone's timer)
      if (was !== this.busy || (changed && this.busy)) {
        const on = [...this.on].filter(([, v]) => v).map(([z]) => {
          const level = this.levels.get(z);
          const e = entries(state).find((x) => zoneOf(x) === z);
          const left = (Number(field(field(e, 'timer'), 'remainHour')) || 0) * 60 + (Number(field(field(e, 'timer'), 'remainMinute')) || 0);
          return `${zoneLabel(z)}${level ? ` (level ${level}${left ? `, ${left} min left` : ''})` : ''}`;
        });
        this.ctx.log.info(`[${this.ctx.name}] ${on.length ? `On: ${on.join(', ')}` : 'All burners off'}.`);
        if (this.busy) { this.problemAlert = ''; }
      }
    }
    const occ = (v: boolean) => (v ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    set(this.anyOn.getCharacteristic(C.OccupancyDetected), occ(this.busy));
    for (const [zone, svc] of this.zones) {
      set(svc.getCharacteristic(C.OccupancyDetected), occ(!!this.on.get(zone)));
    }
    this.renderProblem();
  }
}
