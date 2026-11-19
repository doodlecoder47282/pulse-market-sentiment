// The replay runs the live sweep rule over past sessions and grades each arm with the live grader.
import test from "node:test";
import assert from "node:assert/strict";
import { replaySweepReclaim, joinBars, replayAnswer } from "../../shared/protocolReplay";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";
import type { DayBar, IntraBar } from "../../shared/levelBoard";

const D = "2026-11-12"; // Thursday
const open = etWallToEpochMs(D, 9 * 60 + 30);
const AFTER = etWallToEpochMs("2026-11-13", 18 * 60);
const daily: DayBar[] = [
  { date: "2026-11-10", open: 7010, high: 7050, low: 6990, close: 7020 },
  { date: "2026-11-11", open: 7020, high: 7060, low: 7000, close: 7030 }, // prior-day low 7000
];
/** A full session at `base`, with each minute's bar overridable. */
function session(base: number, over: Record<number, Partial<IntraBar>> = {}, n = 390): IntraBar[] {
  return Array.from({ length: n }, (_, i) => ({ t: open + i * 60_000, open: base, high: base + 0.5, low: base - 0.5, close: base, ...(over[i] ?? {}) }));
}
/** Dip 5 points under 7000 at minute 60, back above by minute 64, flat at 7003 after unless overridden. */
function sweepDay(after: Record<number, Partial<IntraBar>> = {}): IntraBar[] {
  const over: Record<number, Partial<IntraBar>> = {};
  for (let i = 0; i < 60; i++) over[i] = { open: 7010, high: 7010.5, low: 7009.5, close: 7010 };
  over[60] = { open: 7010, high: 7010, low: 6995, close: 6996 };
  over[61] = { open: 6996, high: 6999, low: 6995.5, close: 6998 };
  for (let i = 62; i < 390; i++) over[i] = { open: 7003, high: 7003.5, low: 7002.5, close: 7003 };
  return session(7003, { ...over, ...after });
}

test("joinBars: 5-minute bars anchored at 09:30, a bucket still forming is left out", () => {
  const m = session(100, { 3: { high: 105 }, 4: { close: 101 } }, 12);
  const j = joinBars(m, open, 5, open + 12 * 60_000);
  assert.equal(j.length, 2);
  assert.deepEqual([j[0].t, j[0].high, j[0].close], [open, 105, 101]);
  assert.equal(joinBars(m, open, 5, open + 9 * 60_000).length, 1);
});

test("a sweep under the prior-day low that reclaims arms once and is graded on the bars after it", () => {
  const reached = replaySweepReclaim(daily, sweepDay({ 100: { high: 7020 } }), AFTER);
  assert.equal(reached.sessionsReplayed, 1);
  assert.equal(reached.events.length, 1, "one arm inside the horizon, not one per minute");
  const e = reached.events[0];
  assert.match(e.levelLabel, /prior-day low/);
  assert.equal(e.cancelPrice, 6995);
  assert.equal(e.expectPrice, e.entry + 15);
  assert.equal(e.status, "expected");
  assert.ok(e.armedAt > open + 62 * 60_000, "armed only after the reclaim bar completed");

  const cancelled = replaySweepReclaim(daily, sweepDay({ 100: { low: 6990 } }), AFTER);
  assert.equal(cancelled.events[0].status, "cancelled");
  const neither = replaySweepReclaim(daily, sweepDay(), AFTER);
  assert.equal(neither.events[0].status, "neither");
  assert.match(replayAnswer(neither), /1 past session .*armed 1 time: 0 reached the rule's outcome price, 0 cancelled, 1 neither/);
});

test("the replay never looks ahead: bars after the arm do not change whether or when it armed", () => {
  const a = replaySweepReclaim(daily, sweepDay({ 100: { high: 7020 } }), AFTER).events[0];
  const b = replaySweepReclaim(daily, sweepDay({ 100: { low: 6990 } }), AFTER).events[0];
  assert.deepEqual([a.armedAt, a.entry, a.levelPrice], [b.armedAt, b.entry, b.levelPrice]);
});

test("a quiet session arms nothing; sessions that cannot be replayed honestly are skipped with a reason", () => {
  const quiet = replaySweepReclaim(daily, session(7010), AFTER);
  assert.deepEqual([quiet.sessionsReplayed, quiet.events.length], [1, 0]);
  assert.match(replayAnswer(quiet), /never armed/);
  assert.match(replaySweepReclaim(daily, sweepDay().slice(0, 200), AFTER).skipped[0].reason, /200 of 390 1-minute bars/);
  assert.match(replaySweepReclaim(daily, sweepDay().slice(1), AFTER).skipped[0].reason, /09:30/);
  assert.match(replaySweepReclaim(daily, sweepDay(), open + 120 * 60_000).skipped[0].reason, /in progress/);
  assert.match(replaySweepReclaim([], sweepDay(), AFTER).skipped[0].reason, /no daily bar/);
  assert.match(replaySweepReclaim(daily, sweepDay(), AFTER, { calendarFrom: "2026-12-01" }).skipped[0].reason, /release calendar is not complete/);
  assert.equal(replayAnswer(replaySweepReclaim([], [], AFTER)), "No past session could be replayed yet.");
});

test("a tier-1 release near the sweep keeps the rule from arming, as it does live", () => {
  const ev = [{ date: D, time: "10:35", name: "CPI" as const, tier: 1 as const }];
  const r = replaySweepReclaim(daily, sweepDay(), AFTER, { events: ev });
  assert.ok(!r.events.some((e) => e.armedAt < etWallToEpochMs(D, 10 * 60 + 50)), "nothing arms inside the release window");
});
