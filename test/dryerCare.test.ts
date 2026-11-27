import test from 'node:test';
import assert from 'node:assert/strict';
import { type DryerCareContext, MIN_DRY_MINUTES, noteEstimate, recordDry, recordOverrun, usualDryMinutes } from '../src/dryerCare';

const dries = (ctx: DryerCareContext, minutes: number[], percent = 30) => minutes.map((m) => recordDry(ctx, m, percent));

test('vent check: nothing until the usual drying time is known (8 dries), then quiet for normal ones', () => {
  const ctx: DryerCareContext = {};
  const r = dries(ctx, [50, 55, 48, 52, 60, 50, 54]);
  assert.ok(r.every((x) => !x.warn && !x.changed));
  assert.equal(usualDryMinutes(ctx), undefined, '7 dries: not known yet');
  dries(ctx, [51]);
  assert.equal(usualDryMinutes(ctx), 52, 'the median of the dries before the newest 3');
});

test('vent check: one big load doesn\'t warn; two slow dries among the newest three do', () => {
  const ctx: DryerCareContext = {};
  dries(ctx, [50, 52, 48, 50, 51, 49, 50, 52]);
  // One big, wet load: the median of the newest three ignores it
  assert.equal(recordDry(ctx, 90, 30).warn, false);
  assert.equal(recordDry(ctx, 50, 30).warn, false);
  assert.equal(recordDry(ctx, 51, 30).warn, false);
  // Two of the newest three at least 30 % over the usual 50 (65 min)
  assert.equal(recordDry(ctx, 66, 30).warn, false);
  assert.equal(recordDry(ctx, 68, 30).warn, true);
});

test('vent check: a blocked vent and its cleaning, step by step', () => {
  const ctx: DryerCareContext = {};
  dries(ctx, [50, 50, 50, 50, 50, 50, 50, 50]);
  assert.deepEqual(recordDry(ctx, 70, 30), { warn: false, changed: false, recent: 50, usual: 50 });
  const on = recordDry(ctx, 72, 30);
  assert.deepEqual(on, { warn: true, changed: true, recent: 70, usual: 50 });
  assert.equal(ctx.ventBaseline, 50, 'the usual time is kept while the warning is on');
  // Still slow: no new change
  assert.deepEqual(recordDry(ctx, 75, 30), { warn: true, changed: false, recent: 72, usual: 50 });
  // Vent cleaned: two normal dries bring the median of the newest three back under 65
  assert.equal(recordDry(ctx, 50, 30).warn, true, 'one normal dry isn\'t enough yet');
  const off = recordDry(ctx, 49, 30);
  assert.deepEqual(off, { warn: false, changed: true, recent: 50, usual: 50 });
  assert.equal(ctx.ventBaseline, undefined);
  assert.ok(!ctx.dryMinutes!.some((m) => m >= 65), 'the slow dries are dropped, so they never become the usual');
  assert.equal(usualDryMinutes(ctx), 50);
});

test('vent check: short dries don\'t count; off (0 %) only records', () => {
  const ctx: DryerCareContext = {};
  assert.equal(recordDry(ctx, MIN_DRY_MINUTES - 1, 30).warn, false);
  assert.equal(ctx.dryMinutes, undefined, 'a short timed dry isn\'t kept');
  dries(ctx, [50, 50, 50, 50, 50, 50, 50, 50, 90, 90, 90], 0);
  assert.equal(ctx.ventBaseline, undefined, 'never warns with the check off');
  assert.equal(ctx.dryMinutes!.length, 11, 'but the times are kept, so turning it on later has them');
});

test('vent check: keeps the newest 20 dries', () => {
  const ctx: DryerCareContext = {};
  dries(ctx, Array.from({ length: 30 }, (_, i) => 40 + (i % 3)));
  assert.equal(ctx.dryMinutes!.length, 20);
});

test('estimate check: the first estimate from 5 min in, the largest after; how far each dry runs past it', () => {
  const ctx: DryerCareContext = {};
  noteEstimate(ctx, 60_000, 40 * 60);
  assert.equal(ctx.dryEstimate, undefined, 'the figure at the start is a rough guess');
  noteEstimate(ctx, 6 * 60_000, 34 * 60);
  noteEstimate(ctx, 20 * 60_000, 31 * 60);
  noteEstimate(ctx, 40 * 60_000, 5 * 60);
  assert.equal(ctx.dryEstimate, 40);
  assert.equal(ctx.dryEstimateMax, 51, 'the dryer extended it');
  const r = recordOverrun(ctx, 52, 30)!;
  assert.deepEqual(r, { overrun: 30, estimate: 40, largest: 51, recent: [30], wouldWarn: false });
  assert.equal(ctx.dryEstimate, undefined, 'cleared for the next dry');
});

test('estimate check: would warn when 2 of the newest 3 ran past the limit; short dries and dries without an estimate don\'t count', () => {
  const ctx: DryerCareContext = {};
  const one = (estimate: number, minutes: number) => {
    ctx.dryEstimate = estimate;
    return recordOverrun(ctx, minutes, 30);
  };
  assert.equal(one(10, MIN_DRY_MINUTES - 1), undefined);
  assert.equal(recordOverrun(ctx, 50, 30), undefined, 'no estimate (a dry already running at a restart)');
  assert.equal(one(50, 45)!.overrun, -10, 'finished early');
  assert.equal(one(40, 56)!.wouldWarn, false, 'one slow dry');
  const r = one(60, 80)!;
  assert.deepEqual(r.recent, [-10, 40, 33]);
  assert.equal(r.wouldWarn, true);
  assert.equal(one(50, 50)!.wouldWarn, true, 'still 2 of the newest 3');
  assert.equal(one(50, 52)!.wouldWarn, false, 'back to normal');
  for (let i = 0; i < 12; i++) { one(50, 50); }
  assert.equal(ctx.overruns!.length, 10);
});
