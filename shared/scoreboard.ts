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

export type ScoreState = "enough" | "too_few" | "none" | "no_floor" | "never" | "off" | "unavailable";

export interface ScoreRow {
  id: string;
  /** What fired. */
  what: string;
  /** What "graded" means for it, in a few words. */
  graded: string;
  /** Graded cases, or null when the record was not read or is not kept. */
  n: number | null;
  /** The source's own floor for reading the record; null when it sets none. */
  floor: number | null;
  /** The counts, in words. */
  result: string;
  state: ScoreState;
  /** Tab that holds the full record. */
  where: string;
}

type Rec = { graded: number; expected: number; cancelled: number; neither: number; open?: number; ungraded?: number };
/** A record that is switched off rather than unread (the sample edition keeps none; no session replayable yet). */
export type Off = { off: string };
const isOff = (v: unknown): v is Off => !!v && typeof (v as any).off === "string";

export interface ScoreInputs {
  windowDays: number;
  /** Set when no record is kept at all (the sample edition): every row is "off" with this reason. */
  off?: string;
  /** Edge Loop whale alerts (hit30Rate is a fraction). */
  whale?: { graded: number; pending: number; hit30Rate: number; ungradedNoMark?: number; legacyProxyExcluded?: number } | null;
  /** Whale follow-through: whale positions only. */
  whalePerf?: { windowDays: number; wins: number; losses: number; avgPct: number | null; excludedNoQuote?: number; excludedNoFee?: number } | null;
  regime?: { graded: number; pending: number; overallHitRate: number; sessions?: number; legacyProxyGraded?: number } | null;
  setups?: { minSample: number; summary: Array<{ ruleVersion: string; kind: string; n: number; positive: number }> } | null;
  protocols?: { minGraded: number; bookVersion: string; items: Array<{ name: string; graded: boolean; record: Rec }> } | null;
  replay?: { sessions: number; name: string; record: Rec } | Off | null;
  /** `days`: settled days (what the ledger's floor counts). */
  settle?: { days: number; floor: number; settleInStraddle: { yes: number; of: number } } | null;
}

/** Setup kinds in words, as the setup log names them; an unknown kind keeps its id with underscores opened out. */
export const SETUP_KIND_TEXT: Record<string, string> = {
  fade_call_wall: "fade at the call wall", fade_put_wall: "fade at the put wall", breakout_above: "breakout above the call wall", breakout_below: "breakout below the put wall",
};
const kindText = (k: string) => SETUP_KIND_TEXT[k] ?? k.replace(/_/g, " ");

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const stateOf = (n: number, floor: number | null): ScoreState => (n <= 0 ? "none" : floor == null ? "no_floor" : n >= floor ? "enough" : "too_few");
const DESK = "Desk";

const G = {
  whale: "option up 30% or more at expiry",
  perf: "closed, ask in and bid out, after fees",
  setup: "exit replayed on minute bars, after costs",
  protocol: "outcome price before cancel price, on minute bars",
  replay: "same rule and grader, on past bars",
  settle: "settle inside the morning straddle range",
  regime: "index move over the called horizon against a move-size threshold (a proxy, not the regime itself)",
};
const recText = (r: Rec): string => {
  const tail = `${r.open ? `; ${r.open} open` : ""}${r.ungraded ? `; ${r.ungraded} could not be graded` : ""}`;
  return r.graded ? `${r.expected} reached the rule's outcome price, ${r.cancelled} cancelled, ${r.neither} neither${tail}` : `none graded${tail}`;
};

export function buildScoreboard(x: ScoreInputs): ScoreRow[] {
  const rows: ScoreRow[] = [];
  const gone = (id: string, what: string, graded: string, where: string, off?: string) =>
    rows.push({ id, what, graded, n: null, floor: null, result: off ?? x.off ?? "not read", state: off || x.off ? "off" : "unavailable", where });

  const W = "Whale alerts";
  if (x.off || !x.whale || !fin(x.whale.graded)) gone("whale", W, G.whale, DESK);
  else {
    const w = x.whale;
    const hits = Math.round((fin(w.hit30Rate) ? w.hit30Rate : 0) * w.graded);
    const left = `${w.ungradedNoMark ? `; ${w.ungradedNoMark} resolved with no usable mark, not graded` : ""}${w.legacyProxyExcluded ? `; ${w.legacyProxyExcluded} older rows left out` : ""}`;
    rows.push({ id: "whale", what: `${W}, last ${x.windowDays} days`, graded: G.whale, n: w.graded, floor: null,
      result: `${w.graded ? `${hits} of ${w.graded} finished up 30% or more` : "none graded"}; ${w.pending} pending${left}`,
      state: stateOf(w.graded, null), where: DESK });
  }

  const P = "Whale contracts if bought";
  if (x.off || !x.whalePerf) gone("whale-perf", P, G.perf, "Signals");
  else {
    const p = x.whalePerf;
    const n = p.wins + p.losses;
    const a = fin(p.avgPct) ? Math.round(p.avgPct * 100) : null;
    const out = (p.excludedNoQuote ?? 0) + (p.excludedNoFee ?? 0);
    const left = out ? `; ${out} left out for a missing quote or fee` : "";
    rows.push({ id: "whale-perf", what: `${P}, last ${p.windowDays} days`, graded: G.perf, n, floor: null,
      result: `${n ? `${p.wins} of ${n} closed with a gain${a == null ? "" : `; average result ${a > 0 ? "+" : a < 0 ? "−" : ""}${Math.abs(a)}%`}` : "none closed with a scoreable result"}${left}`,
      state: stateOf(n, null), where: "Signals" });
  }

  if (x.off || !x.setups) gone("setups", "Setups", G.setup, DESK);
  else if (!x.setups.summary.length) rows.push({ id: "setups", what: "Setups", graded: G.setup, n: 0, floor: x.setups.minSample, result: "none graded", state: "none", where: DESK });
  else for (const s of x.setups.summary) rows.push({
    id: `setup:${s.ruleVersion}:${s.kind}`, what: `Setup: ${kindText(s.kind)} (rules ${s.ruleVersion})`, graded: G.setup, n: s.n, floor: x.setups.minSample,
    result: `${s.positive} of ${s.n} ended with a gain`, state: stateOf(s.n, x.setups.minSample), where: DESK,
  });

  if (x.off || !x.protocols) gone("protocols", "Protocols, live", G.protocol, DESK);
  else for (const p of x.protocols.items.filter((p) => p.graded)) rows.push({
    id: `protocol:${p.name}`, what: `Protocol, live: ${p.name} (book ${x.protocols.bookVersion})`, graded: G.protocol, n: p.record.graded, floor: x.protocols.minGraded,
    result: recText(p.record), state: stateOf(p.record.graded, x.protocols.minGraded), where: DESK,
  });

  // The replay always has a row: a replay that failed to read must not vanish from the list or the headline.
  const R = "Protocol, replayed over past sessions";
  if (x.off) gone("replay", R, G.replay, DESK);
  else if (isOff(x.replay)) gone("replay", R, G.replay, DESK, x.replay.off);
  else if (!x.replay) gone("replay", R, G.replay, DESK);
  else rows.push({
    id: "replay", what: `Protocol, replayed over ${x.replay.sessions} past session${x.replay.sessions === 1 ? "" : "s"}: ${x.replay.name}`, graded: G.replay, n: x.replay.record.graded, floor: null,
    result: recText(x.replay.record),
    // A replay is never "enough": its cases are not independent and it is not the live record.
    state: x.replay.record.graded ? "never" : "none", where: DESK,
  });

  if (x.off || !x.settle) gone("settle", "0DTE morning map", G.settle, DESK);
  else {
    const t = x.settle;
    const unreadDays = t.days - t.settleInStraddle.of;
    rows.push({
      id: "settle", what: "0DTE morning map", graded: G.settle, n: t.days, floor: t.floor,
      result: t.days ? `${t.settleInStraddle.yes} of ${t.settleInStraddle.of} settled inside the range${unreadDays > 0 ? `; ${unreadDays} settled day${unreadDays === 1 ? "" : "s"} had no range read` : ""}` : "no settled day",
      state: stateOf(t.days, t.floor), where: DESK,
    });
  }

  if (x.off || !x.regime || !fin(x.regime.graded)) gone("regime", "Regime calls", G.regime, DESK);
  else {
    const g = x.regime;
    const hits = Math.round((fin(g.overallHitRate) ? g.overallHitRate : 0) * g.graded);
    const left = `${fin(g.sessions) ? `; counted one per session: ${g.sessions} (calls inside one session share an outcome)` : ""}${g.legacyProxyGraded ? `; ${g.legacyProxyGraded} older rows left out` : ""}`;
    rows.push({ id: "regime", what: `Regime calls, last ${x.windowDays} days`, graded: G.regime, n: g.graded, floor: null,
      result: `${g.graded ? `${hits} of ${g.graded} matched the move-size proxy on the called horizon` : "none graded"}; ${g.pending} pending${left}`,
      state: stateOf(g.graded, null), where: DESK });
  }
  return rows;
}

export const SCORE_STATE_LABEL: Record<ScoreState, string> = {
  enough: "floor reached",
  too_few: "under its floor",
  none: "nothing graded",
  no_floor: "no floor set",
  never: "replay: never counts as tested",
  off: "not kept",
  unavailable: "not read",
};

/** The one-sentence answer: how many rows can be read at all. Counts of rows, not a judgement of any of them. */
export function scoreboardAnswer(rows: ScoreRow[]): string {
  const live = rows.filter((r) => r.state !== "off");
  if (!live.length) return "No record is kept in this edition.";
  const withFloor = live.filter((r) => r.floor != null && r.state !== "unavailable");
  const enough = withFloor.filter((r) => r.state === "enough").length;
  const unreadN = live.filter((r) => r.state === "unavailable").length;
  const tail = unreadN ? ` ${unreadN} row${unreadN === 1 ? " was" : "s were"} not read.` : "";
  if (!withFloor.length) return `No row with a floor was read.${tail}`;
  const k = withFloor.length;
  if (enough === k) return `${k === 1 ? "The one row that sets a floor has" : `All ${k} rows that set a floor have`} reached it.${tail}`;
  return `${enough} of ${k} row${k === 1 ? "" : "s"} that set a floor ${k === 1 ? "has" : "have"} reached it; the other${k - enough === 1 ? " has" : "s have"} fewer graded cases than the floor.${tail}`;
}
