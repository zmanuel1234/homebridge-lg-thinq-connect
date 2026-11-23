// Cooktops: which burners are on, for "the stove is still on" notifications and automations (a hood
// fan that follows the cooktop). LG's official API reports each cooking zone's state and power
// level; on the models that allow it, it can also switch every zone off. Turning burners on from
// the Home app isn't offered: that should happen at the cooktop.

import type { Service } from 'homebridge';
import { Appliance, type ApplianceContext, set } from './base';
import { field } from '../api';

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

/** Whether a cooktop profile can be switched off as a whole (operation.operationMode: POWER_OFF). */
function canPowerOff(profile: unknown): boolean {
  const props = field(profile, 'property');
  for (const e of [...entries(props), asObj(profile) || {}]) {
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
    if (canPowerOff(profile) && ctx.extraControls !== false) {
      this.offSwitch = this.service(S.Switch, `${ctx.name} all burners off`, 'power-off');
      keep.add('power-off');
      // A button: on sends "everything off", then it turns itself back off
      this.offSwitch.getCharacteristic(C.On).onSet(async (v) => {
        if (v !== true && v !== 1) { return; }
        setTimeout(() => this.offSwitch && set(this.offSwitch.getCharacteristic(C.On), false), 1000).unref?.();
        await this.command('Switched every burner off', { operation: { operationMode: 'POWER_OFF' } });
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
      for (const e of entries(state)) {
        const zone = zoneOf(e);
        const word = field(field(e, 'cookingZone'), 'currentState');
        if (!zone || typeof word !== 'string') { continue; }
        this.on.set(zone, ON_STATES.has(word));
      }
      if (was !== this.busy) {
        const on = [...this.on].filter(([, v]) => v).map(([z]) => zoneLabel(z));
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
