// The level record counts what the index did at the first touch of each level, with no look-ahead in which
// levels exist and no touch counted twice.
import test from "node:test";
import assert from "node:assert/strict";
import { sessionTouches, combineLevelRecord, levelRecordAnswer, LEVEL_RECORD_RULES } from "../../shared/levelRecord";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";
import type { DayBar, IntraBar } from "../../shared/levelBoard";

const D = "2026-11-12"; // Thursday
const open = etWallToEpochMs(D, 9 * 60 + 30);
const AFTER = etWallToEpochMs("2026-11-13", 18 * 60);
// Prior day: high 7060, low 7000, close 7030 -> pivot 7030, R1 7060, S1 7000. Far-away week and month so only these are near.
const daily: DayBar[] = [
  { date: "2026-11-10", open: 7020, high: 7060, low: 7000, close: 7030 },
  { date: "2026-11-11", open: 7020, high: 7060, low: 7000, close: 7030 },
];
function session(base: number, over: Record<number, Partial<IntraBar>> = {}, n = 390): IntraBar[] {
  return Array.from({ length: n }, (_, i) => ({ t: open + i * 60_000, open: base, high: base + 0.5, low: base - 0.5, close: base, ...(over[i] ?? {}) }));
}
const touch = (r: ReturnType<typeof sessionTouches>, key: string) => r.touches!.find((t) => t.key === key);

test("a test from above that moves back first is held; one that closes through first is broke", () => {
  // Opens at 7008, dips to 6999.5 at minute 60 (touches the prior-day low 7000), then trades 7012 at minute 70.
  const held = sessionTouches(D, session(7008, { 60: { low: 6999.5 }, 70: { high: 7012 } }), daily, AFTER);
  const t = touch(held, "pdl")!;
  assert.deepEqual([t.side, t.outcome, t.touchedAt], ["below", "held", open + 60 * 60_000]);
  const broke = sessionTouches(D, session(7008, { 60: { low: 6999.5 }, 65: { low: 6993, close: 6994 } }), daily, AFTER);
  assert.equal(touch(broke, "pdl")!.outcome, "broke");
  const both = sessionTouches(D, session(7008, { 60: { low: 6999.5 }, 65: { high: 7011, low: 6993, close: 6994 } }), daily, AFTER);
  assert.equal(touch(both, "pdl")!.outcome, "broke", "one bar doing both counts as broke");
  const neither = sessionTouches(D, session(7008, { 60: { low: 6999.5 } }), daily, AFTER);
  assert.equal(touch(neither, "pdl")!.outcome, "neither");
});

test("a level above the open is a test from below, mirrored", () => {
  const r = sessionTouches(D, session(7052, { 30: { high: 7060.5 }, 40: { low: 7049 } }), daily, AFTER);
  const t = touch(r, "pdh")!;
  assert.deepEqual([t.side, t.outcome], ["above", "held"]);
  const b = sessionTouches(D, session(7052, { 30: { high: 7060.5 }, 40: { high: 7068, close: 7066 } }), daily, AFTER);
  assert.equal(touch(b, "pdh")!.outcome, "broke");
});

test("only the first touch of a level in a session counts, and a low after the horizon changes nothing", () => {
  const r = sessionTouches(D, session(7008, { 60: { low: 6999.5 }, 70: { high: 7012 }, 200: { low: 6980, close: 6981 } }), daily, AFTER);
  assert.equal(r.touches!.filter((t) => t.key === "pdl").length, 1);
  assert.equal(touch(r, "pdl")!.outcome, "held");
});

test("no look-ahead: the session's own high, low and close in the daily feed do not change the levels or outcomes", () => {
  const bars = session(7008, { 60: { low: 6999.5 }, 70: { high: 7012 } });
  const a = sessionTouches(D, bars, daily, AFTER);
  const withToday = [...daily, { date: D, open: 7008, high: 9999, low: 1, close: 5000 }];
  assert.deepEqual(sessionTouches(D, bars, withToday, AFTER), a);
  assert.ok(!a.touches!.some((t) => t.key === "wo" || t.key === "mo"), "the session's own open is not counted as a level reached later");
});

test("the opening range is only a level after 10:00, from the side price sat on then", () => {
  const over: Record<number, Partial<IntraBar>> = { 5: { high: 7018 }, 10: { low: 7004 } }; // range 7004-7018 inside the first 30 minutes
  over[45] = { high: 7018.2 }; over[50] = { low: 7007 };
  const r = sessionTouches(D, session(7010, over), daily, AFTER);
  const t = touch(r, "orh")!;
  assert.deepEqual([t.side, t.outcome, t.touchedAt], ["above", "held", open + 45 * 60_000]);
  assert.ok(!r.touches!.some((x) => x.key === "orh" && x.touchedAt < open + 30 * 60_000));
});

test("missing minutes after a touch, or a touch too near the close, are not graded", () => {
  const bars = session(7008, { 60: { low: 6999.5 }, 70: { high: 7012 } }).filter((_, i) => i < 62 || i > 66);
  assert.equal(touch(sessionTouches(D, bars, daily, AFTER), "pdl")!.outcome, "ungraded");
  const late = sessionTouches(D, session(7008, { 380: { low: 6999.5 } }), daily, AFTER);
  assert.equal(touch(late, "pdl")!.outcome, "ungraded");
});

test("sessions that cannot be read whole are skipped with a reason", () => {
  assert.match(sessionTouches(D, session(7008).slice(0, 200), daily, AFTER).skipped!, /200 of 390/);
  assert.match(sessionTouches(D, session(7008), daily.slice(0, 1), AFTER).skipped!, /newest daily bar before this session is 2026-11-10, not 2026-11-11/);
  assert.match(sessionTouches(D, session(7008), daily, open + 3_600_000).skipped!, /in progress/);
});

test("the record adds up by level and by side, and the sentence states the rule with its counts", () => {
  const a = sessionTouches(D, session(7008, { 60: { low: 6999.5 }, 70: { high: 7012 } }), daily, AFTER);
  const b = { ...sessionTouches(D, session(7008, { 60: { low: 6999.5 }, 65: { low: 6993, close: 6994 } }), daily, AFTER), date: "2026-11-13" };
  const rec = combineLevelRecord([a, b, { date: "2026-11-09", skipped: "x", touches: null }]);
  assert.equal(rec.sessions, 2);
  const pdl = rec.byLevel.find((l) => l.key === "pdl")!;
  assert.deepEqual([pdl.touches, pdl.held, pdl.broke], [2, 1, 1]);
  assert.equal(rec.total.touches, rec.byLevel.reduce((s, l) => s + l.touches, 0));
  assert.equal(rec.fromAbove.touches + rec.fromBelow.touches, rec.total.touches);
  assert.equal(rec.skipped.length, 1);
  const s = levelRecordAnswer(rec);
  assert.match(s, /^Over 2 past sessions the index reached a mapped level \d+ times \(first touch per level per session\): \d+ moved 10 points back first, \d+ closed 5 points through first, \d+ did neither in 30 minutes/);
  assert.equal(levelRecordAnswer(combineLevelRecord([])), "No past session could be read yet.");
  assert.deepEqual(LEVEL_RECORD_RULES, { awayPts: 10, throughPts: 5, horizonMin: 30, minCoverage: 0.95 });
});
