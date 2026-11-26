import test from 'node:test';
import assert from 'node:assert/strict';
import { type DryerCareContext, MIN_DRY_MINUTES, recordDry, usualDryMinutes } from '../src/dryerCare';

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
