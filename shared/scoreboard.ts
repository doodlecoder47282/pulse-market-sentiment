// shared/scoreboard.ts
//
// THE SCOREBOARD: one row per thing the desk flags, with what happened afterwards. Each record already exists
// on its own tab (Edge Lab, Trade Desk, the 0DTE map); nothing here is recomputed. The point of putting them
// side by side is that "is the desk getting better" needs an answer that is a count: how many times a flag
// fired, how many of those have been graded, what the graded ones did, and whether that is enough to read.
//
// A row never forms a rate of its own. Counts come from the source; a floor is shown only where the source
// sets one (it is that record's own rule for "enough to read"), and a record with no floor is labelled so.
// Nothing here says a flag is good or bad to act on. Pure, no I/O.

export type ScoreState = "enough" | "too_few" | "none" | "no_floor" | "never" | "unavailable";

export interface ScoreRow {
  id: string;
  /** What fired. */
  what: string;
  /** What "graded" means for it, in a few words. */
  graded: string;
  /** Graded cases, or null when the record was not read. */
  n: number | null;
  /** The source's own floor for reading the record; null when it sets none. */
  floor: number | null;
  /** The counts, in words. */
  result: string;
  state: ScoreState;
  /** Tab that holds the full record. */
  where: string;
}

export interface ScoreInputs {
  windowDays: number;
  /** Edge Lab whale alerts (hit30Rate is a fraction). */
  whale?: { graded: number; pending: number; hit30Rate: number } | null;
  /** Whale follow-through, all sources of whale rows together. */
  whalePerf?: { windowDays: number; wins: number; losses: number; avgPct: number | null } | null;
  regime?: { graded: number; pending: number; overallHitRate: number; sessions?: number } | null;
  setups?: { minSample: number; summary: Array<{ ruleVersion: string; kind: string; n: number; positive: number }> } | null;
  protocols?: { minGraded: number; items: Array<{ name: string; graded: boolean; record: { graded: number; expected: number; cancelled: number; neither: number } }> } | null;
  replay?: { sessions: number; record: { graded: number; expected: number; cancelled: number; neither: number } } | null;
  settle?: { days: number; floor: number; settleInStraddle: { yes: number; of: number } } | null;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const stateOf = (n: number, floor: number | null): ScoreState => (n <= 0 ? "none" : floor == null ? "no_floor" : n >= floor ? "enough" : "too_few");
const unread = (id: string, what: string, graded: string, where: string): ScoreRow => ({ id, what, graded, n: null, floor: null, result: "not read", state: "unavailable", where });

export function buildScoreboard(x: ScoreInputs): ScoreRow[] {
  const rows: ScoreRow[] = [];

  const W = "Whale alerts";
  if (!x.whale || !fin(x.whale.graded)) rows.push(unread("whale", W, "option up 30% or more at expiry", "Edge Lab"));
  else {
    const hits = Math.round((fin(x.whale.hit30Rate) ? x.whale.hit30Rate : 0) * x.whale.graded);
    rows.push({ id: "whale", what: `${W}, last ${x.windowDays} days`, graded: "option up 30% or more at expiry", n: x.whale.graded, floor: null,
      result: x.whale.graded ? `${hits} of ${x.whale.graded} finished up 30% or more; ${x.whale.pending} pending` : `none graded; ${x.whale.pending} pending`,
      state: stateOf(x.whale.graded, null), where: "Edge Lab" });
  }

  const P = "Whale contracts if bought";
  if (!x.whalePerf) rows.push(unread("whale-perf", P, "closed, ask in and bid out, after fees", "Signals"));
  else {
    const n = x.whalePerf.wins + x.whalePerf.losses;
    const a = fin(x.whalePerf.avgPct) ? Math.round(x.whalePerf.avgPct * 100) : null;
    rows.push({ id: "whale-perf", what: `${P}, last ${x.whalePerf.windowDays} days`, graded: "closed, ask in and bid out, after fees", n, floor: null,
      result: n ? `${x.whalePerf.wins} of ${n} closed with a gain${a == null ? "" : `; average result ${a > 0 ? "+" : a < 0 ? "−" : ""}${Math.abs(a)}%`}` : "none closed with both quotes",
      state: stateOf(n, null), where: "Signals" });
  }

  if (!x.setups) rows.push(unread("setups", "Setups", "exit replayed on minute bars, after costs", "Trade Desk"));
  else if (!x.setups.summary.length) rows.push({ id: "setups", what: "Setups", graded: "exit replayed on minute bars, after costs", n: 0, floor: x.setups.minSample, result: "none graded", state: "none", where: "Trade Desk" });
  else for (const s of x.setups.summary) rows.push({
    id: `setup:${s.ruleVersion}:${s.kind}`, what: `Setup: ${s.kind} (rules ${s.ruleVersion})`, graded: "exit replayed on minute bars, after costs", n: s.n, floor: x.setups.minSample,
    result: `${s.positive} of ${s.n} ended with a gain`, state: stateOf(s.n, x.setups.minSample), where: "Trade Desk",
  });

  if (!x.protocols) rows.push(unread("protocols", "Protocols, live", "outcome price before cancel price, on minute bars", "Trade Desk"));
  else for (const p of x.protocols.items.filter((p) => p.graded)) rows.push({
    id: `protocol:${p.name}`, what: `Protocol, live: ${p.name}`, graded: "outcome price before cancel price, on minute bars", n: p.record.graded, floor: x.protocols.minGraded,
    result: p.record.graded ? `${p.record.expected} reached the rule's outcome price, ${p.record.cancelled} cancelled, ${p.record.neither} neither` : "none graded",
    state: stateOf(p.record.graded, x.protocols.minGraded), where: "Trade Desk",
  });

  if (x.replay) rows.push({
    id: "replay", what: `Protocol, replayed over ${x.replay.sessions} past session${x.replay.sessions === 1 ? "" : "s"}: Sweep under a level and reclaim`, graded: "same rule and grader, on past bars", n: x.replay.record.graded, floor: null,
    result: x.replay.record.graded ? `${x.replay.record.expected} reached the rule's outcome price, ${x.replay.record.cancelled} cancelled, ${x.replay.record.neither} neither` : "none graded",
    // A replay is never "enough": its cases are not independent and it is not the live record.
    state: x.replay.record.graded ? "never" : "none", where: "Trade Desk",
  });

  if (!x.settle) rows.push(unread("settle", "0DTE morning map", "settle inside the morning straddle range", "Trade Desk"));
  else rows.push({
    id: "settle", what: "0DTE morning map", graded: "settle inside the morning straddle range", n: x.settle.settleInStraddle.of, floor: x.settle.floor,
    result: x.settle.settleInStraddle.of ? `${x.settle.settleInStraddle.yes} of ${x.settle.settleInStraddle.of} settled inside the range` : "no settled day",
    state: stateOf(x.settle.settleInStraddle.of, x.settle.floor), where: "Trade Desk",
  });

  if (!x.regime || !fin(x.regime.graded)) rows.push(unread("regime", "Regime calls", "the called regime held over its horizon", "Edge Lab"));
  else {
    const hits = Math.round((fin(x.regime.overallHitRate) ? x.regime.overallHitRate : 0) * x.regime.graded);
    rows.push({ id: "regime", what: `Regime calls, last ${x.windowDays} days`, graded: "the called regime held over its horizon", n: x.regime.graded, floor: null,
      result: x.regime.graded ? `${hits} of ${x.regime.graded} held${fin(x.regime.sessions) ? `; these come from ${x.regime.sessions} session${x.regime.sessions === 1 ? "" : "s"}, and calls inside one session share an outcome` : ""}` : `none graded; ${x.regime.pending} pending`,
      state: stateOf(x.regime.graded, null), where: "Edge Lab" });
  }
  return rows;
}

export const SCORE_STATE_LABEL: Record<ScoreState, string> = {
  enough: "at its floor",
  too_few: "too few to read",
  none: "nothing graded",
  no_floor: "no floor set",
  never: "replay: never counts as tested",
  unavailable: "not read",
};

/** The one-sentence answer: how many records can be read at all. Counts of records, not a judgement of any of them. */
export function scoreboardAnswer(rows: ScoreRow[]): string {
  const withFloor = rows.filter((r) => r.floor != null && r.state !== "unavailable");
  const enough = withFloor.filter((r) => r.state === "enough").length;
  const unreadN = rows.filter((r) => r.state === "unavailable").length;
  const tail = unreadN ? ` ${unreadN} record${unreadN === 1 ? " was" : "s were"} not read.` : "";
  if (!withFloor.length) return `No record with a floor was read.${tail}`;
  if (enough === withFloor.length) return `All ${enough} records that set a floor have reached it.${tail}`;
  return `${enough} of ${withFloor.length} records that set a floor have reached it; the rest have too few graded cases to read.${tail}`;
}
