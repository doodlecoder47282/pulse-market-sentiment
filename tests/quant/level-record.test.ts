// The level record counts what the index did at the first touch of each price, with no look-ahead in which
// levels exist, no price counted twice, and no touch graded on bars it cannot see.
import test from "node:test";
import assert from "node:assert/strict";
import { sessionTouches, combineLevelRecord, levelRecordAnswer, LEVEL_RECORD_RULES } from "../../shared/levelRecord";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";
import type { DayBar, IntraBar } from "../../shared/levelBoard";

const D = "2026-11-12"; // Thursday
const open = etWallToEpochMs(D, 9 * 60 + 30);
const AFTER = etWallToEpochMs("2026-11-13", 18 * 60);
// Prior day: high 7060, low 7000, close 7030 -> pivot 7030, R1 7060, S1 7000 (each price carries two names).
const daily: DayBar[] = [
  { date: "2026-11-10", open: 7020, high: 7060, low: 7000, close: 7030 },
  { date: "2026-11-11", open: 7020, high: 7060, low: 7000, close: 7030 },
];
const flat = (p: number): Partial<IntraBar> => ({ open: p, high: p + 0.5, low: p - 0.5, close: p });
/** 390 one-minute bars: `first` until minute `at`, the touch bar, then `then`, with overrides. */
function path(first: number, at: number, touchBar: Partial<IntraBar>, then: number, over: Record<number, Partial<IntraBar>> = {}, n = 390): IntraBar[] {
  return Array.from({ length: n }, (_, i) => ({ t: open + i * 60_000, ...(i < at ? flat(first) : i === at ? { ...flat(then), ...touchBar } : flat(then)), ...(over[i] ?? {}) } as IntraBar));
}
/** Opens 7015, dips to 6999.5 at minute 60 (the prior-day low / S1 at 7000), then sits at 7003. */
const dip = (over: Record<number, Partial<IntraBar>> = {}, n = 390) => path(7015, 60, { low: 6999.5 }, 7003, over, n);
/** Opens 7045, pokes to 7060.5 at minute 30 (the prior-day high / R1 at 7060), then sits at 7057. */
const poke = (over: Record<number, Partial<IntraBar>> = {}) => path(7045, 30, { high: 7060.5 }, 7057, over);
const touch = (r: ReturnType<typeof sessionTouches>, key: string) => r.touches!.find((t) => t.keys.includes(key));

test("a test from above that trades back first is held; a close through first is broke", () => {
  const held = touch(sessionTouches(D, dip({ 70: { high: 7010 } }), daily, AFTER), "pdl")!;
  assert.deepEqual([held.side, held.outcome, held.touchedAt], ["below", "held", open + 60 * 60_000]);
  assert.equal(touch(sessionTouches(D, dip({ 65: { low: 6993, close: 6995 } }), daily, AFTER), "pdl")!.outcome, "broke");
  assert.equal(touch(sessionTouches(D, dip({ 65: { high: 7011, low: 6993, close: 6995 } }), daily, AFTER), "pdl")!.outcome, "broke", "one bar doing both counts as broke");
  assert.equal(touch(sessionTouches(D, dip(), daily, AFTER), "pdl")!.outcome, "neither");
});

test("a level above the open is a test from below, mirrored", () => {
  const t = touch(sessionTouches(D, poke({ 40: { low: 7050 } }), daily, AFTER), "pdh")!;
  assert.deepEqual([t.side, t.outcome], ["above", "held"]);
  assert.equal(touch(sessionTouches(D, poke({ 40: { high: 7068, close: 7065 } }), daily, AFTER), "pdh")!.outcome, "broke");
});

test("the touch bar's own close through the level is a break, whatever follows", () => {
  const bars = path(7045, 30, { high: 7070, close: 7068 }, 7057, { 31: { low: 7049 } });
  assert.equal(touch(sessionTouches(D, bars, daily, AFTER), "pdh")!.outcome, "broke");
});

test("levels at the same price are one touch with every name, counted once in the totals and once on each row", () => {
  const r = sessionTouches(D, dip({ 70: { high: 7010 } }), daily, AFTER);
  const t = touch(r, "pdl")!;
  assert.deepEqual(t.keys.slice().sort(), ["pdl", "s1"]);
  assert.equal(r.touches!.filter((x) => x.price === 7000).length, 1);
  const rec = combineLevelRecord([r]);
  assert.equal(rec.total.touches, r.touches!.length);
  assert.equal(rec.byLevel.find((l) => l.key === "pdl")!.held, 1);
  assert.equal(rec.byLevel.find((l) => l.key === "s1")!.held, 1);
  // Monday: the prior-week close is Friday's close, which is also the prior-day close.
  const MON = "2026-11-16";
  const mOpen = etWallToEpochMs(MON, 9 * 60 + 30);
  const wk: DayBar[] = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map((date) => ({ date, open: 7020, high: 7060, low: 7000, close: 7040 }));
  const bars = path(7055, 20, { low: 7039.5 }, 7043, { 30: { high: 7051 } }).map((b, i) => ({ ...b, t: mOpen + i * 60_000 }));
  const mon = sessionTouches(MON, bars, wk, etWallToEpochMs("2026-11-17", 18 * 60));
  const close = mon.touches!.find((x) => x.keys.includes("pdc"))!;
  assert.ok(close.keys.includes("pwc"), "one price, two names");
  assert.equal(mon.touches!.filter((x) => Math.abs(x.price - 7040) < 0.01).length, 1, "counted once, not once per name");
});

test("only the first touch of a price in a session counts, and a low after the horizon changes nothing", () => {
  const r = sessionTouches(D, dip({ 70: { high: 7010 }, 200: { low: 6980, close: 6981 } }), daily, AFTER);
  assert.equal(r.touches!.filter((t) => t.keys.includes("pdl")).length, 1);
  assert.equal(touch(r, "pdl")!.outcome, "held");
});

test("a price that starts within the away distance is not read as a touch; it is counted apart", () => {
  const r = sessionTouches(D, path(7003, 60, {}, 7003), daily, AFTER); // opens 3 points over the prior-day low
  assert.equal(touch(r, "pdl"), undefined);
  assert.ok(r.startedNear! >= 1);
  assert.ok(combineLevelRecord([r]).startedNear >= 1);
});

test("no look-ahead: the session's own high, low and close in the daily feed do not change the levels or outcomes", () => {
  const bars = dip({ 70: { high: 7010 } });
  const a = sessionTouches(D, bars, daily, AFTER);
  assert.deepEqual(sessionTouches(D, bars, [...daily, { date: D, open: 7015, high: 9999, low: 1, close: 5000 }], AFTER), a);
  assert.ok(!a.touches!.some((t) => t.keys.includes("wo") || t.keys.includes("mo")), "the session's own open is not a level reached later");
});

test("the opening range is only a level after 10:00, from the side price sat on then", () => {
  const over: Record<number, Partial<IntraBar>> = { 5: { high: 7018 }, 10: { low: 7004 } }; // range 7004-7018
  for (let i = 20; i < 45; i++) over[i] = flat(7006);
  over[45] = { ...flat(7016), high: 7018.2 };
  for (let i = 46; i < 390; i++) over[i] = flat(7015);
  over[50] = { ...flat(7015), low: 7007 };
  const r = sessionTouches(D, path(7012, 0, {}, 7012, over), daily, AFTER);
  const t = touch(r, "orh")!;
  assert.deepEqual([t.side, t.outcome, t.touchedAt], ["above", "held", open + 45 * 60_000]);
});

test("a missing minute before or after the touch, or a touch too near the close, is not graded", () => {
  const after = dip({ 70: { high: 7010 } }).filter((_, i) => i < 62 || i > 66);
  assert.equal(touch(sessionTouches(D, after, daily, AFTER), "pdl")!.outcome, "ungraded");
  const before = dip({ 70: { high: 7010 } }).filter((_, i) => i < 40 || i > 45);
  assert.equal(touch(sessionTouches(D, before, daily, AFTER), "pdl")!.outcome, "ungraded", "the first touch may have been inside the gap");
  const late = sessionTouches(D, path(7015, 380, { low: 6999.5 }, 7003), daily, AFTER);
  assert.equal(touch(late, "pdl")!.outcome, "ungraded");
});

test("sessions that cannot be read whole are skipped with a reason, and the sentence says how many", () => {
  assert.match(sessionTouches(D, dip({}, 200), daily, AFTER).skipped!, /200 of 390/);
  assert.match(sessionTouches(D, dip(), daily.slice(0, 1), AFTER).skipped!, /newest daily bar before this session is 2026-11-10, not 2026-11-11/);
  assert.match(sessionTouches(D, dip(), daily, open + 3_600_000).skipped!, /in progress/);
  const rec = combineLevelRecord([sessionTouches(D, dip({ 70: { high: 7010 } }), daily, AFTER), { date: "2026-11-09", skipped: "x", touches: null }]);
  assert.match(levelRecordAnswer(rec), /^Over 1 past session \(1 more not read\) the index reached a mapped price \d+ times? \(first touch per price per session\): \d+ traded 10 points back first, \d+ closed 5 points through first, \d+ did neither in 30 minutes/);
  assert.equal(levelRecordAnswer(combineLevelRecord([])), "No past session could be read yet.");
  assert.equal(rec.fromAbove.touches + rec.fromBelow.touches, rec.total.touches);
  assert.deepEqual(LEVEL_RECORD_RULES, { awayPts: 10, throughPts: 5, horizonMin: 30, minCoverage: 0.95 });
});
