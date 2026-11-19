// server/scoreboard.ts
//
// Reads each graded record the desk keeps and hands them to shared/scoreboard.ts. Every read is its own
// try: one record failing leaves its row "not read" and the others intact. Nothing is recomputed here, and
// no read touches the market except the replay's own (cached) one. The sample edition keeps no records, so
// its scoreboard says so instead of listing counts of simulated data.

import { buildScoreboard, scoreboardAnswer, type ScoreInputs, type ScoreRow } from "../shared/scoreboard";
import { SETTLE_MIN_DAYS } from "../shared/odteSettle";
import { protocolBook } from "../shared/protocols";
import { editionFromEnv } from "../shared/edition";

const WINDOW_DAYS = 30;
const PERF_DAYS = 7;
const CACHE_MS = 5 * 60_000;

export interface ScoreboardView {
  asOfMs: number;
  edition: string;
  answer: string;
  rows: ScoreRow[];
  /** Why each unread row could not be read. */
  unread: Array<{ record: string; reason: string }>;
  note: string;
}

const NOTE = "Each row is a record kept elsewhere on the desk, shown with its own counts and its own floor; nothing is recomputed or combined. A floor is the least number of graded cases that record asks for before its figures are shown as more than raw counts; reaching it is not a claim of edge or a calibrated probability. Whale and regime records set no floor. A row describes what happened after a flag; it is not a statement about what to do with one.";

let cache: { at: number; view: ScoreboardView } | null = null;
let inFlight: Promise<ScoreboardView> | null = null;

async function compute(nowMs: number): Promise<ScoreboardView> {
  const edition = editionFromEnv();
  if (edition === "demo") {
    const rows = buildScoreboard({ windowDays: WINDOW_DAYS, off: "the sample edition keeps no record" });
    return { asOfMs: nowMs, edition, answer: scoreboardAnswer(rows), rows, unread: [], note: NOTE };
  }
  const x: ScoreInputs = { windowDays: WINDOW_DAYS };
  const unread: ScoreboardView["unread"] = [];
  const why = (e: any) => String(e?.message ?? e).slice(0, 120);
  try {
    const s = (await import("./edgeStats")).computeEdgeStats(WINDOW_DAYS);
    x.whale = { graded: s.whaleAlerts.graded, pending: s.whaleAlerts.pending, hit30Rate: s.whaleAlerts.hit30Rate, ungradedNoMark: s.whaleAlerts.ungradedNoMark, legacyProxyExcluded: s.whaleAlerts.legacyProxyExcluded };
    x.regime = { graded: s.regimeCalls.graded, pending: s.regimeCalls.pending, overallHitRate: s.regimeCalls.overallHitRate, sessions: s.regimeCalls.calibrationSessions, legacyProxyGraded: s.regimeCalls.legacyProxyGraded };
  } catch (e) { unread.push({ record: "whale alerts", reason: why(e) }, { record: "regime calls", reason: why(e) }); }
  try {
    const o: any = (await import("./whaleFollowThrough")).getPerformanceSnapshot({ windowDays: PERF_DAYS }).overall;
    x.whalePerf = { windowDays: PERF_DAYS, wins: o.wins, losses: o.losses, avgPct: o.avgPct ?? null, excludedNoQuote: o.excludedNoQuote, excludedNoFee: o.excludedNoFee };
  } catch (e) { unread.push({ record: "whale contracts if bought", reason: why(e) }); }
  try {
    const l = (await import("./setupEngine")).getSetupLog();
    x.setups = { minSample: l.rules.minSample, summary: l.summary.map((s) => ({ ruleVersion: s.ruleVersion, kind: s.kind, n: s.n, positive: s.positive })) };
  } catch (e) { unread.push({ record: "setups", reason: why(e) }); }
  try {
    x.protocols = (await import("./protocolEngine")).getProtocolRecords();
  } catch (e) { unread.push({ record: "live protocols", reason: why(e) }); }
  try {
    const r = await (await import("./protocolReplay")).getProtocolReplay(nowMs);
    const name = protocolBook().find((p) => p.id === "sweep_reclaim")?.name ?? "sweep_reclaim";
    if (r.state === "ok" && r.replay) x.replay = r.replay.sessionsReplayed ? { sessions: r.replay.sessionsReplayed, name, record: r.replay.record } : { off: "no past session could be replayed yet" };
    else unread.push({ record: "protocol replay", reason: r.reason ?? "replay unavailable" });
  } catch (e) { unread.push({ record: "protocol replay", reason: why(e) }); }
  try {
    const t = (await import("./odteMapLedger")).ledgerSummary("$SPX").tally;
    x.settle = { days: t.days, floor: SETTLE_MIN_DAYS, settleInStraddle: t.settleInStraddle };
  } catch (e) { unread.push({ record: "0DTE morning map", reason: why(e) }); }
  const rows = buildScoreboard(x);
  return { asOfMs: nowMs, edition, answer: scoreboardAnswer(rows), rows, unread, note: NOTE };
}

export async function getScoreboard(nowMs: number = Date.now()): Promise<ScoreboardView> {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.view;
  if (inFlight) return inFlight;
  inFlight = compute(nowMs).then((view) => { cache = { at: nowMs, view }; return view; }).finally(() => { inFlight = null; });
  return inFlight;
}
