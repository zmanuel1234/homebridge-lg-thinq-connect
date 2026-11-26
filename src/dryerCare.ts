// Dryer care reminders the plugin works out itself, since LG's API reports neither:
//  - the lint filter: dries counted since the "lint filter cleaned" button was last pressed;
//  - the vent: how long recent dries took, against what's usual for this dryer. A blocked vent
//    makes drying take longer; LG's dryers warn about restricted airflow only on their display.
// Kept in the accessory's context, so both survive Homebridge restarts.

/** What's kept with the dryer's accessory. */
export interface DryerCareContext {
  /** Dries finished since the lint filter was last marked cleaned. */
  lintDries?: number;
  /** Minutes of drying (running, not paused) of recent finished dries, oldest first. */
  dryMinutes?: number[];
  /** How many of the newest dryMinutes were recorded while the vent warning was on. */
  slowDries?: number;
  /** The usual drying time (minutes) the vent warning compares with; set while the warning is on. */
  ventBaseline?: number;
  /** Drying time so far of the cycle under way (ms), and since when it has been running. */
  runMs?: number;
  runSince?: number;
}

/** Dries shorter than this (minutes) aren't a sign of anything: a short timed dry or a stopped one. */
export const MIN_DRY_MINUTES = 15;
/** Dries kept for the comparison. */
const KEEP = 20;
/** The newest dries compared with the usual (their median, so one big load doesn't count). */
const RECENT = 3;
/** Dries needed before the usual one is known: RECENT plus at least this many earlier ones. */
const BASELINE_MIN = 5;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The usual drying time: the median of earlier normal dries, or undefined while there are too few. */
export function usualDryMinutes(ctx: DryerCareContext): number | undefined {
  const all = ctx.dryMinutes || [];
  const slow = Math.min(ctx.slowDries || 0, all.length);
  const earlier = all.slice(0, Math.max(0, all.length - Math.max(RECENT, slow)));
  return earlier.length >= BASELINE_MIN ? median(earlier) : undefined;
}

export interface VentResult {
  /** The warning is on after this dry. */
  warn: boolean;
  /** It came on, or went off, with this dry. */
  changed: boolean;
  recent?: number;
  usual?: number;
}

/**
 * Records a finished dry and decides the vent warning: on when the median of the newest dries is
 * at least `percent` % over the usual one; off again once it's back under (the vent was cleaned).
 */
export function recordDry(ctx: DryerCareContext, minutes: number, percent: number): VentResult {
  const before = ctx.ventBaseline !== undefined;
  const result = (warn: boolean, recent?: number, usual?: number): VentResult => ({ warn, changed: warn !== before, recent, usual });
  if (minutes < MIN_DRY_MINUTES) { return result(before); }
  const list = [...(ctx.dryMinutes || []), Math.round(minutes)].slice(-KEEP);
  ctx.dryMinutes = list;
  if (before) { ctx.slowDries = Math.min((ctx.slowDries || 0) + 1, list.length); }
  if (list.length < RECENT) { return result(before); }
  const recent = median(list.slice(-RECENT));
  const usual = ctx.ventBaseline ?? usualDryMinutes(ctx);
  if (usual === undefined || percent <= 0) { return result(before, recent, usual); }
  const slow = recent >= usual * (1 + percent / 100);
  if (slow && !before) {
    // The newest dries are the slow ones; the usual time is kept until they're back to normal
    ctx.ventBaseline = usual;
    ctx.slowDries = RECENT;
  } else if (!slow && before) {
    // Back to normal: the slow dries from the warning are dropped, so they never become the usual
    const n = Math.min(ctx.slowDries || 0, list.length);
    const limit = usual * (1 + percent / 100);
    ctx.dryMinutes = [...list.slice(0, list.length - n), ...list.slice(list.length - n).filter((m) => m < limit)];
    ctx.ventBaseline = undefined;
    ctx.slowDries = 0;
  }
  return result(slow, recent, usual);
}
