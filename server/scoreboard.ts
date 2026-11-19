// server/scoreboard.ts
//
// Reads each graded record the desk keeps and hands them to shared/scoreboard.ts. Every read is its own
// try: one record failing leaves its row "not read" and the others intact. Nothing is recomputed here.

import { buildScoreboard, scoreboardAnswer, type ScoreInputs, type ScoreRow } from "../shared/scoreboard";
import { SETTLE_MIN_DAYS } from "../shared/odteSettle";
import { editionFromEnv } from "../shared/edition";

const WINDOW_DAYS = 30;
const PERF_DAYS = 7;
const CACHE_MS = 60_000;

export interface ScoreboardView {
  asOfMs: number;
  edition: string;
  answer: string;
  rows: ScoreRow[];
  /** Records that could not be read, with the error. */
  unread: Array<{ record: string; reason: string }>;
  note: string;
}

let cache: { at: number; view: ScoreboardView } | null = null;

export async function getScoreboard(nowMs: number = Date.now()): Promise<ScoreboardView> {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.view;
  const x: ScoreInputs = { windowDays: WINDOW_DAYS };
  const unread: ScoreboardView["unread"] = [];
  const read = async (record: string, fn: () => Promise<void> | void) => {
    try { await fn(); } catch (e: any) { unread.push({ record, reason: String(e?.message ?? e).slice(0, 120) }); }
  };
  await read("whale alerts and regime calls", async () => {
    const s = (await import("./edgeStats")).computeEdgeStats(WINDOW_DAYS);
    x.whale = { graded: s.whaleAlerts.graded, pending: s.whaleAlerts.pending, hit30Rate: s.whaleAlerts.hit30Rate };
    x.regime = { graded: s.regimeCalls.graded, pending: s.regimeCalls.pending, overallHitRate: s.regimeCalls.overallHitRate, sessions: s.regimeCalls.calibrationSessions };
  });
  await read("whale follow-through", async () => {
    const o = (await import("./whaleFollowThrough")).getPerformanceSnapshot({ windowDays: PERF_DAYS }).overall;
    x.whalePerf = { windowDays: PERF_DAYS, wins: o.wins, losses: o.losses, avgPct: o.avgPct ?? null };
  });
  await read("setups", async () => {
    const l = (await import("./setupEngine")).getSetupLog();
    x.setups = { minSample: l.rules.minSample, summary: l.summary.map((s) => ({ ruleVersion: s.ruleVersion, kind: s.kind, n: s.n, positive: s.positive })) };
  });
  await read("protocols", async () => {
    const l = await (await import("./protocolEngine")).getProtocolLog(nowMs);
    x.protocols = { minGraded: l.minGraded, items: l.protocols.map((p) => ({ name: p.name, graded: p.graded, record: p.record })) };
  });
  await read("protocol replay", async () => {
    const r = await (await import("./protocolReplay")).getProtocolReplay(nowMs);
    if (r.state !== "ok" || !r.replay) throw new Error(r.reason ?? "replay unavailable");
    x.replay = { sessions: r.replay.sessionsReplayed, record: r.replay.record };
  });
  await read("0DTE settle ledger", async () => {
    const t = (await import("./odteMapLedger")).ledgerSummary("$SPX").tally;
    x.settle = { days: t.days, floor: SETTLE_MIN_DAYS, settleInStraddle: t.settleInStraddle };
  });
  const rows = buildScoreboard(x);
  const view: ScoreboardView = {
    asOfMs: nowMs, edition: editionFromEnv(), answer: scoreboardAnswer(rows), rows, unread,
    note: "Each row is a record kept elsewhere on the desk, shown with its own counts and its own floor; nothing is recomputed or combined. A floor is that record's stated minimum before its counts are read as more than counts. Whale and regime records set no floor. A row describes what happened after a flag; it is not a statement about what to do with one.",
  };
  cache = { at: nowMs, view };
  return view;
}
