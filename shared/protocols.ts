// shared/protocols.ts
//
// THE PROTOCOL BOOK: if-then rules for the index, each with a trigger a machine can check, the behaviour
// the rule's author expects after it, the price that cancels it, and a structure TYPE. Versioned: changing a
// threshold bumps PROTOCOL_BOOK_VERSION so the record of one version never mixes with another's.
//
// The starter book below is the owner's own description of how he reads the tape (2026-11-18), turned into
// thresholds. Every threshold is hand-set and none has been tested: the record starts at zero. A protocol
// that arms is a stated condition that was met, logged and graded later against 1-minute bars. It is not a
// forecast, it carries no odds, and the desk places no orders.
//
// Pure: the server feeds it the level board (shared/levelBoard.ts), the day's bars and the calendar.

import type { BoardLevel, IntraBar } from "./levelBoard";

export const PROTOCOL_BOOK_VERSION = "2026.11.18-1";
/** Graded events a protocol needs before it stops being labelled untested. */
export const PROTOCOL_MIN_GRADED = 30;

export interface ProtocolRules {
  /** SPX counts as at the wall within this fraction of the price. */
  atLevelPct: number;
  /** No protocol arms inside this many minutes before a tier-1 release, or this many after. */
  newsBeforeMin: number;
  newsAfterMin: number;
  /** No protocol arms in the first / last minutes of the session. */
  notBeforeMin: number;
  notAfterMin: number;
  wallRejection: { expectPts: number; cancelPts: number; horizonMin: number };
  sweepReclaim: { minSweepPts: number; maxSweepPts: number; lookbackMin: number; expectPts: number; horizonMin: number };
}

export const PROTOCOL_RULES: ProtocolRules = {
  atLevelPct: 0.001,
  newsBeforeMin: 30, newsAfterMin: 15,
  notBeforeMin: 15, notAfterMin: 45,
  wallRejection: { expectPts: 20, cancelPts: 10, horizonMin: 90 },
  sweepReclaim: { minSweepPts: 2, maxSweepPts: 10, lookbackMin: 15, expectPts: 15, horizonMin: 90 },
};

export type ProtocolId = "wall_rejection" | "sweep_reclaim" | "news_window";

export interface ProtocolDef {
  id: ProtocolId;
  name: string;
  /** The trigger in words, with the thresholds in it. */
  trigger: string;
  expected: string;
  cancel: string;
  /** A type of structure, never a contract or a size. */
  structure: string;
  /** false: armed times are counted but nothing is graded (there is no price behaviour to grade). */
  graded: boolean;
  /** Level keys whose touch this protocol watches (for the level-hit log). */
  watches: string[];
}

/** Support levels a sweep can run under. */
export const SWEEP_LEVEL_KEYS = ["pdl", "orl", "magnetBelow", "s1", "pwl", "straddleLow"];

export function protocolBook(r: ProtocolRules = PROTOCOL_RULES): ProtocolDef[] {
  return [
    {
      id: "wall_rejection",
      name: "Rejection at the wall above",
      trigger: `SPX within ${(r.atLevelPct * 100).toFixed(1)}% of the wall above, with VIX firm on the day and tech lagging the market.`,
      expected: `SPX trades ${r.wallRejection.expectPts} points below the armed price within ${r.wallRejection.horizonMin} minutes.`,
      cancel: `SPX trades ${r.wallRejection.cancelPts} points above the wall first.`,
      structure: "bearish, defined risk (a put debit spread is one such type)",
      graded: true,
      watches: ["wallAbove"],
    },
    {
      id: "sweep_reclaim",
      name: "Sweep under a level and reclaim",
      trigger: `Within the last ${r.sweepReclaim.lookbackMin} minutes SPX traded ${r.sweepReclaim.minSweepPts} to ${r.sweepReclaim.maxSweepPts} points under a support level and the latest bar closed back above it.`,
      expected: `SPX trades ${r.sweepReclaim.expectPts} points above the armed price within ${r.sweepReclaim.horizonMin} minutes.`,
      cancel: "SPX trades below the low of the sweep first.",
      structure: "bullish, defined risk (a call debit spread is one such type)",
      graded: true,
      watches: SWEEP_LEVEL_KEYS,
    },
    {
      id: "news_window",
      name: "News window",
      trigger: `A tier-1 release (CPI, NFP, PCE, FOMC) is within ${r.newsBeforeMin} minutes ahead or ${r.newsAfterMin} minutes behind.`,
      expected: "Nothing is expected of price. While this is armed the other protocols do not arm.",
      cancel: `${r.newsAfterMin} minutes after the release.`,
      structure: "none: this rule only holds the other two",
      graded: false,
      watches: [],
    },
  ];
}

export interface ProtocolCtx {
  nowMs: number;
  sessionOpen: boolean;
  minutesSinceOpen: number | null;
  minutesToClose: number | null;
  spx: number | null;
  /** The index's board levels (merged keys such as "pdl+s1" are matched by part). */
  levels: BoardLevel[];
  tech: "leading" | "lagging" | "in line" | "unknown";
  vix: "firm" | "soft" | "flat" | "unknown";
  calendarKnown: boolean;
  minutesToTier1: number | null;
  minutesSinceTier1: number | null;
  /** Today's index bars, oldest first (1 or 5 minute). */
  bars: IntraBar[];
}

/** met: true / false, or null when the input was not read (never treated as met). */
export interface Condition { name: string; met: boolean | null; detail: string }

export interface ProtocolEval {
  id: ProtocolId;
  armed: boolean;
  conditions: Condition[];
  direction: "up" | "down" | null;
  /** Price when armed, the level it armed on, and the two prices the grader watches. */
  entry: number | null;
  level: BoardLevel | null;
  expectPrice: number | null;
  cancelPrice: number | null;
  horizonMin: number | null;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const hasKey = (l: BoardLevel, key: string) => l.key.split("+").includes(key);
const k = (n: number) => Math.round(n).toLocaleString("en-US");

function newsCondition(c: ProtocolCtx, r: ProtocolRules): { inWindow: boolean | null; detail: string } {
  if (!c.calendarKnown) return { inWindow: null, detail: "the release calendar's validity has passed: not read" };
  const ahead = fin(c.minutesToTier1) && c.minutesToTier1 <= r.newsBeforeMin;
  const behind = fin(c.minutesSinceTier1) && c.minutesSinceTier1 <= r.newsAfterMin;
  if (ahead) return { inWindow: true, detail: `a tier-1 release is ${c.minutesToTier1} minutes ahead` };
  if (behind) return { inWindow: true, detail: `a tier-1 release was ${c.minutesSinceTier1} minutes ago` };
  return { inWindow: false, detail: fin(c.minutesToTier1) ? `next tier-1 release in ${c.minutesToTier1} minutes` : "no tier-1 release ahead on the calendar" };
}

function sessionCondition(c: ProtocolCtx, r: ProtocolRules): Condition {
  if (!c.sessionOpen || !fin(c.minutesSinceOpen) || !fin(c.minutesToClose)) return { name: "session window", met: false, detail: "the regular session is not open" };
  const okWin = c.minutesSinceOpen >= r.notBeforeMin && c.minutesToClose >= r.notAfterMin;
  return { name: "session window", met: okWin, detail: okWin ? `${Math.round(c.minutesSinceOpen)} minutes after the open` : `outside the window (not in the first ${r.notBeforeMin} or last ${r.notAfterMin} minutes)` };
}

function blank(id: ProtocolId, conditions: Condition[]): ProtocolEval {
  return { id, armed: false, conditions, direction: null, entry: null, level: null, expectPrice: null, cancelPrice: null, horizonMin: null };
}
const allMet = (cs: Condition[]) => cs.every((x) => x.met === true);

export function evalWallRejection(c: ProtocolCtx, r: ProtocolRules = PROTOCOL_RULES): ProtocolEval {
  const wall = c.levels.find((l) => hasKey(l, "wallAbove")) ?? null;
  const news = newsCondition(c, r);
  const at = fin(c.spx) && wall ? Math.abs(c.spx - wall.price) <= c.spx * r.atLevelPct : null;
  const conditions: Condition[] = [
    { name: "SPX at the wall above", met: !fin(c.spx) || !wall ? null : at, detail: !fin(c.spx) ? "no SPX price read" : !wall ? "no wall above on the option map" : `SPX ${k(c.spx)}, wall ${k(wall.price)} (${Math.abs(c.spx - wall.price).toFixed(1)} points away)` },
    { name: "VIX firm", met: c.vix === "unknown" ? null : c.vix === "firm", detail: `VIX is ${c.vix === "unknown" ? "not read" : c.vix} on the day` },
    { name: "tech lagging", met: c.tech === "unknown" ? null : c.tech === "lagging", detail: `tech is ${c.tech === "unknown" ? "not read" : c.tech}` },
    { name: "no tier-1 release near", met: news.inWindow == null ? null : !news.inWindow, detail: news.detail },
    sessionCondition(c, r),
  ];
  if (!allMet(conditions) || !fin(c.spx) || !wall) return blank("wall_rejection", conditions);
  return {
    id: "wall_rejection", armed: true, conditions, direction: "down", entry: c.spx, level: wall,
    expectPrice: c.spx - r.wallRejection.expectPts, cancelPrice: wall.price + r.wallRejection.cancelPts, horizonMin: r.wallRejection.horizonMin,
  };
}

/** The deepest qualifying sweep in the lookback: a support level, the low under it, and the reclaim close. */
export function findSweep(c: Pick<ProtocolCtx, "bars" | "levels" | "nowMs">, r: ProtocolRules = PROTOCOL_RULES): { level: BoardLevel; low: number; close: number } | null {
  const from = c.nowMs - r.sweepReclaim.lookbackMin * 60_000;
  const recent = c.bars.filter((b) => b.t >= from && b.t <= c.nowMs).sort((a, b) => a.t - b.t);
  if (recent.length < 2) return null;
  const last = recent[recent.length - 1];
  const low = Math.min(...recent.map((b) => b.low));
  let best: { level: BoardLevel; low: number; close: number } | null = null;
  for (const l of c.levels) {
    if (!SWEEP_LEVEL_KEYS.some((key) => hasKey(l, key))) continue;
    const under = l.price - low;
    if (under < r.sweepReclaim.minSweepPts || under > r.sweepReclaim.maxSweepPts) continue;
    if (!(last.close > l.price)) continue;
    // The sweep must have started from above the level inside the window, not from a session already under it.
    if (!(recent[0].open > l.price || recent.some((b) => b.high > l.price && b.t < last.t))) continue;
    if (!best || l.price > best.level.price) best = { level: l, low, close: last.close };
  }
  return best;
}

export function evalSweepReclaim(c: ProtocolCtx, r: ProtocolRules = PROTOCOL_RULES): ProtocolEval {
  const news = newsCondition(c, r);
  const sweep = c.bars.length ? findSweep(c, r) : null;
  const conditions: Condition[] = [
    { name: "sweep under a support level and reclaim", met: !c.bars.length ? null : !!sweep, detail: !c.bars.length ? "no index bars read today" : sweep ? `traded to ${k(sweep.low)}, ${(sweep.level.price - sweep.low).toFixed(1)} points under ${k(sweep.level.price)} (${sweep.level.label}), last close ${k(sweep.close)}` : `no sweep of ${r.sweepReclaim.minSweepPts} to ${r.sweepReclaim.maxSweepPts} points under a support level in the last ${r.sweepReclaim.lookbackMin} minutes` },
    { name: "no tier-1 release near", met: news.inWindow == null ? null : !news.inWindow, detail: news.detail },
    sessionCondition(c, r),
  ];
  if (!allMet(conditions) || !sweep) return blank("sweep_reclaim", conditions);
  return {
    id: "sweep_reclaim", armed: true, conditions, direction: "up", entry: sweep.close, level: sweep.level,
    expectPrice: sweep.close + r.sweepReclaim.expectPts, cancelPrice: sweep.low, horizonMin: r.sweepReclaim.horizonMin,
  };
}

export function evalNewsWindow(c: ProtocolCtx, r: ProtocolRules = PROTOCOL_RULES): ProtocolEval {
  const news = newsCondition(c, r);
  const conditions: Condition[] = [{ name: "tier-1 release near", met: news.inWindow, detail: news.detail }];
  return { ...blank("news_window", conditions), armed: news.inWindow === true };
}

export function evalProtocols(c: ProtocolCtx, r: ProtocolRules = PROTOCOL_RULES): ProtocolEval[] {
  return [evalWallRejection(c, r), evalSweepReclaim(c, r), evalNewsWindow(c, r)];
}

export type ProtocolOutcome = "expected" | "cancelled" | "neither" | "open" | "ungraded";
export interface ProtocolGrade { status: ProtocolOutcome; at: number | null; reason: string | null; barsUsed: number }

/**
 * Replay bars after the protocol armed. "expected": the expected price traded before the cancel price.
 * "cancelled": the cancel price traded first, or both inside one bar (the order inside a bar is unknown, so
 * it is counted against the protocol). "neither": the horizon ended with neither. Bars at or before the arm
 * time and after the horizon are ignored.
 */
export function gradeProtocol(e: { direction: "up" | "down"; expectPrice: number; cancelPrice: number; armedAt: number; horizonMin: number }, bars: IntraBar[], nowMs: number): ProtocolGrade {
  const end = e.armedAt + e.horizonMin * 60_000;
  const seq = bars.filter((b) => b.t > e.armedAt && b.t <= end).sort((a, b) => a.t - b.t);
  if (!seq.length) return { status: nowMs < end ? "open" : "ungraded", at: null, reason: nowMs < end ? "horizon still open" : "no bars after the arm time", barsUsed: 0 };
  for (const b of seq) {
    const hitExpect = e.direction === "down" ? b.low <= e.expectPrice : b.high >= e.expectPrice;
    const hitCancel = e.direction === "down" ? b.high >= e.cancelPrice : b.low <= e.cancelPrice;
    if (hitCancel) return { status: "cancelled", at: b.t, reason: hitExpect ? "both prices inside one bar: counted as cancelled" : null, barsUsed: seq.length };
    if (hitExpect) return { status: "expected", at: b.t, reason: null, barsUsed: seq.length };
  }
  const last = seq[seq.length - 1];
  if (nowMs < end && last.t < end - 60_000) return { status: "open", at: null, reason: "horizon still open", barsUsed: seq.length };
  return { status: "neither", at: last.t, reason: "neither price traded inside the horizon", barsUsed: seq.length };
}

export interface ProtocolRecord { armed: number; expected: number; cancelled: number; neither: number; open: number; ungraded: number; graded: number; tested: boolean; text: string }
/** Counts only. No rate is formed: a share of a handful of events would read as odds. */
export function protocolRecord(statuses: string[], graded: boolean): ProtocolRecord {
  const n = (s: string) => statuses.filter((x) => x === s).length;
  const expected = n("expected"), cancelled = n("cancelled"), neither = n("neither"), open = n("open"), ungraded = n("ungraded");
  const g = expected + cancelled + neither;
  const armed = statuses.length;
  const text = !graded ? `armed ${armed} time${armed === 1 ? "" : "s"}; not graded (nothing is expected of price)`
    : g === 0 ? `untested: 0 graded${armed ? `, ${open} open${ungraded ? `, ${ungraded} could not be graded` : ""}` : ""}`
    : `${g} graded: ${expected} did what was expected, ${cancelled} cancelled, ${neither} neither${open ? `; ${open} open` : ""}${g < PROTOCOL_MIN_GRADED ? `. Too few to judge (under ${PROTOCOL_MIN_GRADED}).` : "."}`;
  return { armed, expected, cancelled, neither, open, ungraded, graded: g, tested: graded && g >= PROTOCOL_MIN_GRADED, text };
}

export interface LevelHit { key: string; label: string; price: number; direction: "up" | "down" }
/** Levels the price crossed between two reads (prev on one side, cur on or past the other). */
export function levelHits(prev: number | null | undefined, cur: number | null | undefined, levels: BoardLevel[]): LevelHit[] {
  if (!fin(prev) || !fin(cur) || prev === cur) return [];
  const out: LevelHit[] = [];
  for (const l of levels) {
    if (!fin(l.price)) continue;
    if (prev < l.price && cur >= l.price) out.push({ key: l.key, label: l.label, price: l.price, direction: "up" });
    else if (prev > l.price && cur <= l.price) out.push({ key: l.key, label: l.label, price: l.price, direction: "down" });
  }
  return out;
}

/** Names of the protocols that watch a level (matched by any part of a merged key). */
export function protocolsWatching(levelKey: string, book: ProtocolDef[] = protocolBook()): string[] {
  const parts = levelKey.split("+");
  return book.filter((p) => p.watches.some((w) => parts.includes(w))).map((p) => p.name);
}
