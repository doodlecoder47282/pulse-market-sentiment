// shared/levelRecord.ts
//
// WHAT PRICE DID AT EACH KIND OF LEVEL. The level board names levels (prior-day high and low, pivots, prior
// week, prior month, the opening range). This counts, over past sessions, what the index did the first time
// it reached each one: moved back away from it, closed through it, or neither. It is a record of what
// happened, by level kind, in counts. It makes no claim that a level will hold next time, and the sessions
// it draws on are neighbours in time, so the counts are not independent events.
//
// How a touch is read (hand-set, versioned in LEVEL_RECORD_RULES; a change of any number is a new version):
//   - Levels at the same price are ONE price with several names (a Friday close is both the prior-day and the
//     prior-week close on Monday): one touch, counted once in the totals and once on each of its rows.
//   - A level is "above" or "below" the price as of the first minute it could be acted on: the session open
//     for calendar levels, the last close inside the range for the opening range (which exists from 10:00).
//     A session that opens beyond a level (a gap through it) meets that level from the far side.
//   - A level that starts within `awayPts` of that price is not read as a touch: price is already at it, and
//     the outcome would be noise. Such levels are counted apart ("started at the level").
//   - The TOUCH is the first 1-minute bar whose range reaches the level from that side.
//   - BROKE ("closed through"): a 1-minute bar, the touch bar included, CLOSES through the level by at least
//     `throughPts`, before the next line happens.
//   - HELD ("moved back"): after the touch bar, a 1-minute HIGH or LOW gets at least `awayPts` back away from
//     the level first. The two are measured differently on purpose (a wick away, a close through) and the
//     card says so. If one bar does both, it counts as broke.
//   - NEITHER: the horizon ends with neither. NOT GRADED: a minute is missing anywhere from the start of the
//     scan to the outcome (the first touch may have been in the gap), or the session ends inside the horizon.
//   - One touch per price per session: the first.
// Prices close to each other but not equal are read separately; a move that holds one and breaks the next
// counts once for each. Pure, no I/O.

import { calendarLevels, sessionLevels, OPENING_RANGE_MIN, type DayBar, type IntraBar, type BoardLevel } from "./levelBoard";
import { etWallToEpochMs, sessionCloseMinutes, prevTradingDay, REGULAR_OPEN_MIN } from "./exchangeCalendar";

export const LEVEL_RECORD_VERSION = "2026.11.20-1";
export interface LevelRecordRules { awayPts: number; throughPts: number; horizonMin: number; minCoverage: number }
export const LEVEL_RECORD_RULES: LevelRecordRules = { awayPts: 10, throughPts: 5, horizonMin: 30, minCoverage: 0.95 };

export type TouchOutcome = "held" | "broke" | "neither" | "ungraded";
export interface LevelTouch {
  date: string;
  /** Every level kind at this price, joined with "+" (keys) and " + " (labels). */
  key: string; label: string; keys: string[]; price: number;
  /** Where the level sat against the price before the touch: "below" is a test from above. */
  side: "above" | "below";
  touchedAt: number; outcome: TouchOutcome;
}
export type SessionTouches = { date: string; skipped: string; touches: null; startedNear?: undefined }
  | { date: string; skipped: null; touches: LevelTouch[]; /** Prices that began within awayPts of the price: not read as touches. */ startedNear: number };
/** Two levels this close in price are the same price. */
const SAME_PRICE = 0.005;

/** The first touch of each calendar and opening-range level in ONE finished session, with what followed. */
export function sessionTouches(date: string, bars: IntraBar[], daily: DayBar[], nowMs: number, rules: LevelRecordRules = LEVEL_RECORD_RULES): SessionTouches {
  const skip = (reason: string): SessionTouches => ({ date, skipped: reason, touches: null });
  const closeMin = sessionCloseMinutes(date);
  if (closeMin == null || !bars.length) return skip("not a trading session with bars");
  const openMs = etWallToEpochMs(date, REGULAR_OPEN_MIN);
  const closeMs = etWallToEpochMs(date, closeMin);
  if (nowMs < closeMs) return skip("session still in progress");
  const expected = closeMin - REGULAR_OPEN_MIN;
  if (bars[0].t !== openMs) return skip("no 1-minute bar starting at 09:30");
  if (bars.length < expected * rules.minCoverage) return skip(`${bars.length} of ${expected} 1-minute bars present`);
  const prior = daily.filter((b) => b.date < date).map((b) => b.date).sort().pop() ?? null;
  const want = prevTradingDay(date);
  if (prior !== want) return skip(prior ? `the newest daily bar before this session is ${prior}, not ${want}` : "no daily bar before this session");

  // The session's own daily bar must not leak: week open and month open read today's open, which the first bar gives.
  const before = daily.filter((b) => b.date < date);
  const levels: Array<{ lv: BoardLevel; from: number }> = calendarLevels([...before, { date, open: bars[0].open, high: bars[0].open, low: bars[0].open, close: bars[0].open }], date)
    .filter((l) => l.key !== "wo" && l.key !== "mo") // the week or month open on its first day IS the session open: not a level reached later
    .map((lv) => ({ lv, from: 0 }));
  const orEndMs = openMs + OPENING_RANGE_MIN * 60_000;
  const orIdx = bars.findIndex((b) => b.t >= orEndMs);
  if (orIdx >= 0) {
    for (const lv of sessionLevels(bars.slice(0, orIdx + 1), date, bars[orIdx].t + 60_000)) {
      if (lv.key === "orh" || lv.key === "orl") levels.push({ lv, from: orIdx });
    }
  }

  // Levels at one price become one entry with every name; calendar levels (from 0) and the opening range (from 10:00) never share one.
  const groups: Array<{ keys: string[]; labels: string[]; price: number; from: number }> = [];
  for (const { lv, from } of levels) {
    const g = groups.find((x) => x.from === from && Math.abs(x.price - lv.price) < SAME_PRICE);
    if (g) { g.keys.push(lv.key); g.labels.push(lv.label); } else groups.push({ keys: [lv.key], labels: [lv.label], price: lv.price, from });
  }

  const touches: LevelTouch[] = [];
  let startedNear = 0;
  for (const g of groups) {
    const { from, price } = g;
    if (from >= bars.length) continue;
    // Where the level sits before it can be touched: the open for calendar levels, the last close inside the range for the opening range.
    const ref = from === 0 ? bars[0].open : bars[from - 1].close;
    if (Math.abs(price - ref) < rules.awayPts) { startedNear++; continue; }
    const side: "above" | "below" = price > ref ? "above" : "below";
    let ti = -1;
    let gapBefore = false;
    for (let i = from; i < bars.length; i++) {
      if (i > 0 && bars[i].t - bars[i - 1].t > 60_000 && i > from) gapBefore = true;
      if (side === "above" ? bars[i].high >= price : bars[i].low <= price) { ti = i; break; }
    }
    if (ti < 0) continue;
    const t0 = bars[ti].t;
    const end = t0 + rules.horizonMin * 60_000;
    const through = (b: IntraBar) => (side === "above" ? b.close >= price + rules.throughPts : b.close <= price - rules.throughPts);
    const away = (b: IntraBar) => (side === "above" ? b.low <= price - rules.awayPts : b.high >= price + rules.awayPts);
    let outcome: TouchOutcome = "neither";
    let last = t0;
    let gap = gapBefore;
    let resolved = false;
    if (!gap && through(bars[ti])) { outcome = "broke"; resolved = true; } // the touch bar's own close counts
    for (let i = ti + 1; !gap && !resolved && i < bars.length && bars[i].t <= end; i++) {
      if (bars[i].t - last > 60_000) { gap = true; break; }
      last = bars[i].t;
      if (through(bars[i])) { outcome = "broke"; resolved = true; }
      else if (away(bars[i])) { outcome = "held"; resolved = true; }
    }
    if (gap || (!resolved && last < end)) outcome = "ungraded"; // a missing minute, or the session ended inside the horizon
    touches.push({ date, key: g.keys.join("+"), label: g.labels.join(" + "), keys: g.keys, price, side, touchedAt: t0, outcome });
  }
  return { date, skipped: null, touches: touches.sort((a, b) => a.touchedAt - b.touchedAt), startedNear };
}

export interface LevelTally { key: string; label: string; touches: number; held: number; broke: number; neither: number; ungraded: number }
export interface LevelRecord {
  version: string; rules: LevelRecordRules;
  sessions: number; firstSession: string | null; lastSession: string | null;
  skipped: Array<{ date: string; reason: string }>;
  byLevel: LevelTally[];
  /** Tests from above (the level was below the price) and from below, all level kinds together. */
  /** Prices that began within awayPts of the price in their session and were not read as touches. */
  startedNear: number;
  fromAbove: Omit<LevelTally, "key" | "label">;
  fromBelow: Omit<LevelTally, "key" | "label">;
  total: Omit<LevelTally, "key" | "label">;
}

const zero = () => ({ touches: 0, held: 0, broke: 0, neither: 0, ungraded: 0 });
const add = (t: ReturnType<typeof zero>, o: TouchOutcome) => { t.touches++; t[o]++; };
/** Order the board lists levels in. */
const ORDER = ["pdh", "pdl", "pdc", "pp", "r1", "s1", "orh", "orl", "pwh", "pwl", "pwc", "pmh", "pml", "pmc"];

export function combineLevelRecord(sessions: SessionTouches[], rules: LevelRecordRules = LEVEL_RECORD_RULES): LevelRecord {
  const sorted = sessions.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const done = sorted.filter((s) => s.skipped == null);
  const by = new Map<string, LevelTally>();
  const fromAbove = zero(), fromBelow = zero(), total = zero();
  let startedNear = 0;
  for (const s of done) {
    startedNear += s.startedNear ?? 0;
    for (const t of s.touches ?? []) {
      // One touch in the totals; one on the row of each level kind that sat at that price.
      add(total, t.outcome); add(t.side === "below" ? fromAbove : fromBelow, t.outcome);
      const labels = t.label.split(" + ");
      t.keys.forEach((k, i) => add(by.get(k) ?? by.set(k, { key: k, label: labels[i] ?? k, ...zero() }).get(k)!, t.outcome));
    }
  }
  const rank = (k: string) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
  return {
    version: LEVEL_RECORD_VERSION, rules,
    sessions: done.length, firstSession: done[0]?.date ?? null, lastSession: done[done.length - 1]?.date ?? null,
    skipped: sorted.filter((s) => s.skipped != null).map((s) => ({ date: s.date, reason: s.skipped! })),
    byLevel: [...by.values()].sort((a, b) => rank(a.key) - rank(b.key)),
    startedNear, fromAbove, fromBelow, total,
  };
}

/** One sentence: counts only, with the rule that defines them. */
export function levelRecordAnswer(r: LevelRecord): string {
  const notRead = r.skipped.length ? ` (${r.skipped.length} more not read)` : "";
  if (!r.sessions) return `No past session could be read yet${r.skipped.length ? ` (${r.skipped.length} not read)` : ""}.`;
  const n = `${r.sessions} past session${r.sessions === 1 ? "" : "s"}${notRead}`;
  const t = r.total;
  if (!t.touches) return `Over ${n} the index reached none of the mapped levels.`;
  const ug = t.ungraded ? `, ${t.ungraded} could not be graded` : "";
  return `Over ${n} the index reached a mapped price ${t.touches} time${t.touches === 1 ? "" : "s"} (first touch per price per session): ${t.held} traded ${r.rules.awayPts} points back first, ${t.broke} closed ${r.rules.throughPts} points through first, ${t.neither} did neither in ${r.rules.horizonMin} minutes${ug}.`;
}
