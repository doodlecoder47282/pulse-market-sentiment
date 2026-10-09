/**
 * MISSION FIX #0 — 0DTE Alert Grader.
 *
 * Every fire is graded by replaying the PUBLISHED plan (the alert text and
 * this replay share validationMath.ODTE_PLAN_RULES; round-2 item 7.1):
 *   - stop: option bid <= entry x 0.80, or a 5-minute candle CLOSE beyond the
 *     stop level (the old grader stopped on any 1-minute touch, which the
 *     alert never said);
 *   - T1: sell half on the first 1-minute touch when the alert has a T2
 *     (all when it has none); the runner keeps the stop until a 5-minute
 *     close beyond T1 arms the trail (T1 -/+ 3), and is sold at T2;
 *   - still open at the session close (13:00 ET on half days): cash
 *     settlement at intrinsic on the official close.
 *
 * Two ledgers per fire, both from real data:
 * 1. Underlying (hit_t1, feeds gradeCalibration): T1 reached before the
 *    whole position was stopped. realized_pct = the plan's underlying
 *    close-out (legs at T1/T2/the stop candle's close, rest at the last
 *    close). pct_return keeps the best favorable excursion as a diagnostic.
 * 2. Option P&L (review item 7.2), the ledger the sizer bets on: the same
 *    plan on the option marks the 0DTE tracker logged (odte_option_marks):
 *    ask in, bid out, settlement at intrinsic; quantity-weighted exit and the
 *    settled fraction (no closing fee on it) are stored. Marks must cover
 *    fire-to-exit with no hole over 5 minutes. No entry ask, no exit mark or
 *    a hole -> option_status 'ungraded', never estimated.
 *
 * REJECTED rows get the underlying grade only (no marks are logged for them):
 * that is the counterfactual ledger for the gates.
 *
 * Minute bars (review item 7.7): Schwab's live minute history (about 10
 * days) merged with the Schwab bars persisted in spx_minute_bars, so a fire
 * missed by a grader outage is still graded from the saved session. A row
 * whose session has no complete bars stays pending while live history can
 * still supply them (MAX_LOOKBACK_DAYS); after that it is marked
 * insufficient_history with the reason. Bars are never filled or estimated.
 */

import { sqlite } from "./storage";
import { getPriceHistory } from "./schwab";
import { loadOdteOptionMarks } from "./odteAuditDb";
import {
  etCloseMs as etCloseForDate, etDate, gradeOdteOptionPnl, replayOdtePlan, planUnderlyingCloseOutPct,
  summarizeOptionReturns, gradeBucketFor, netOptionReturn, wilsonInterval, gradeLabelStatus,
  ODTE_PLAN_RULES, MIN_FIRES_FOR_POINT_ESTIMATE, savedMinuteBarsSql, mergeMinuteBars,
  type OptionLedgerBucket, type MinuteBar,
} from "./validationMath";

const MAX_LOOKBACK_DAYS = 9; // Schwab live minute history reaches ~10 days back
/** Option stop the plan publishes (alert text "-20%"; exitBrain HARD_STOP_PCT = -0.20). */
const OPTION_STOP_PCT = ODTE_PLAN_RULES.optionStopPct;

interface AuditRow {
  id: number;
  alert_id: string;
  detected_at: number;
  score: number;
  tier: string;
  setup: string;
  side: string;
  features_json: string;
  contract_json: string;
  t1_target: number;
  entry_price: number;
}

type Candle = MinuteBar;

export interface OdteGradingSummary {
  ranAt: number;
  graded: number;
  wins: number;
  losses: number;
  insufficient: number;
  errors: number;
  optionGraded: number;
  optionUngraded: number;
  /** Rows left pending because their session's bars are not complete yet (retried next run). */
  deferred: number;
  /** Rows graded from persisted spx_minute_bars rather than live Schwab history. */
  fromSavedBars: number;
}

function etCloseMs(fireMs: number): number {
  // Session close on the fire's ET date: 16:00 ET, 13:00 ET on half days.
  return etCloseForDate(etDate(fireMs));
}

function marketClosedFor(fireMs: number, now: number): boolean {
  return now >= etCloseMs(fireMs) + 10 * 60_000; // close + 10 min buffer
}

/** Minute-candle cache per grading run — one Schwab call per run, not per row. */
let _candleCache: { fetchedAt: number; candles: Candle[] } | null = null;

async function getSpxMinuteCandles(): Promise<Candle[]> {
  const now = Date.now();
  if (_candleCache && now - _candleCache.fetchedAt < 5 * 60_000) return _candleCache.candles;
  const resp = await getPriceHistory("$SPX", "day", 10, "minute", 1);
  const candles: Candle[] = (resp.candles ?? [])
    .filter((c: any) => c.close != null && isFinite(c.close))
    .map((c: any) => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close }));
  // An empty answer (throttle, token) is not cached: the next run retries.
  if (candles.length > 0) _candleCache = { fetchedAt: now, candles };
  return candles;
}

/**
 * Persisted Schwab $SPX 1-minute bars (spx_minute_bars), read with the
 * column layout the table actually has (validationMath.savedMinuteBarsSql).
 */
let _savedSql: string | null = null;
export function loadSavedSpxMinuteBars(fromMs: number, toMs: number): Candle[] {
  try {
    if (!_savedSql) {
      const cols = (sqlite.prepare("PRAGMA table_info(spx_minute_bars)").all() as Array<{ name: string }>).map((c) => c.name);
      _savedSql = savedMinuteBarsSql(cols);
    }
    if (!_savedSql) return [];
    return (sqlite.prepare(_savedSql).all(fromMs, toMs) as Candle[])
      .filter((b) => [b.datetime, b.open, b.high, b.low, b.close].every((v) => typeof v === "number" && Number.isFinite(v)));
  } catch { return []; }
}

/** Live and saved bars for one session window, de-duplicated by bar open (live wins). */
function barsForWindow(live: Candle[], fromMs: number, toMs: number): { bars: Candle[]; savedUsed: boolean } {
  const saved = loadSavedSpxMinuteBars(fromMs, toMs);
  const liveIn = live.filter((b) => b.datetime >= fromMs && b.datetime < toMs);
  const bars = mergeMinuteBars(saved, liveIn);
  return { bars, savedUsed: saved.length > 0 && liveIn.length < bars.length };
}

/**
 * Official SPX closing values by ET date from Schwab daily bars: the PM
 * settlement value of SPXW (Cboe: PM-settled on the closing value). Used for
 * held-to-close grades; the last minute-bar close is the fallback, labeled.
 */
let _dailyCache: { fetchedAt: number; byDate: Map<string, number> } | null = null;
async function getSpxDailyCloses(): Promise<Map<string, number>> {
  const now = Date.now();
  if (_dailyCache && now - _dailyCache.fetchedAt < 30 * 60_000) return _dailyCache.byDate;
  const byDate = new Map<string, number>();
  try {
    // One year, so fires graded late from saved bars still settle on the official close.
    const resp = await getPriceHistory("$SPX", "year", 1, "daily", 1);
    for (const c of (resp.candles ?? []) as any[]) {
      if (typeof c.close === "number" && Number.isFinite(c.close) && typeof c.datetime === "number") {
        // Daily candle datetime is the session start; midday of that session gives its ET date.
        byDate.set(etDate(c.datetime + 12 * 3600_000), c.close);
      }
    }
  } catch { /* fallback to minute bars */ }
  if (byDate.size > 0) _dailyCache = { fetchedAt: now, byDate };
  return byDate;
}

interface RowGrade {
  outcome: Record<string, unknown>;
  pctReturn: number | null;     // MFE, % of spot (diagnostic)
  realizedPct: number | null;   // underlying close-out of the plan, % (statistics)
  hit30: number | null;
  hit50: number | null;
  hitT1: number | null;
  /** True when the row could not be graded only because bars are missing (retry while history may still arrive). */
  retryable: boolean;
  option: {
    status: "graded" | "ungraded" | null;
    reason: string | null;
    entry: number | null;
    exit: number | null;
    exitAt: number | null;
    ret: number | null;
    mfe: number | null;
    settledFrac: number | null;
  };
}

const NO_OPTION: RowGrade["option"] = { status: null, reason: null, entry: null, exit: null, exitAt: null, ret: null, mfe: null, settledFrac: null };

export function gradeRow(
  row: AuditRow,
  candles: Candle[],
  now: number,
  marks: Array<{ ts: number; bid: number | null; ask: number | null; mid: number | null }> = [],
  officialClose: number | null = null,
): RowGrade {
  let features: any = {};
  try { features = JSON.parse(row.features_json || "{}"); } catch { /* noop */ }
  let contract: any = {};
  try { contract = JSON.parse(row.contract_json || "{}"); } catch { /* noop */ }

  const isCall = String(row.side).toUpperCase().startsWith("C");
  const t1 = Number(row.t1_target);
  const spotAtFire = Number(features.spot ?? features.spotAtFire ?? 0);
  const stopLevel = Number(features.stopLevel ?? 0);
  const t2Raw = Number(features.t2Price ?? NaN);
  const t2 = Number.isFinite(t2Raw) && t2Raw > 0 ? t2Raw : null;
  const trailRaw = Number(features.t2TrailingStopLevel ?? NaN);
  const trail = Number.isFinite(trailRaw) && trailRaw > 0 ? trailRaw : null; // null -> engine rule T1 -/+ 3
  const isFire = row.tier !== "REJECTED";

  const empty = (outcome: Record<string, unknown>, retryable = false): RowGrade =>
    ({ outcome, pctReturn: null, realizedPct: null, hit30: null, hit50: null, hitT1: null, retryable, option: NO_OPTION });

  if (!isFinite(t1) || t1 <= 0) return empty({ result: "insufficient_inputs", reason: "no t1_target" });
  if (!(stopLevel > 0)) return empty({ result: "insufficient_inputs", reason: "no stop level logged (no stop is invented)" });

  const closeMs = etCloseMs(row.detected_at);
  const planIn = { isCall, entryTs: row.detected_at, closeMs, t1, stopLevel, t2, trailStopLevel: trail, spot0: spotAtFire > 0 ? spotAtFire : null };
  const plan = replayOdtePlan(planIn, candles);
  if (plan.status !== "ok") {
    return empty({ result: "insufficient_history", reason: plan.status, gapAt: plan.gapAt, bars: plan.barsUsed }, true);
  }
  const firstBar = candles.filter((c) => c.datetime >= row.detected_at).sort((a, b) => a.datetime - b.datetime)[0];
  const spot0 = spotAtFire > 0 ? spotAtFire : firstBar.open;
  const realizedPct = planUnderlyingCloseOutPct(isCall, spot0, plan);
  const bestFavorablePct = (plan.mfePts / spot0) * 100;
  const hitT1 = plan.hitT1 ? 1 : 0;

  // ── Option P&L on logged marks (fires only) ───────────────────────────────
  let option: RowGrade["option"] = NO_OPTION;
  let hit30: number | null = null;
  let hit50: number | null = null;
  let fills: unknown = null;
  if (isFire) {
    const strike = Number(contract.strike);
    const entryAsk = Number(contract.ask);
    const g = gradeOdteOptionPnl({
      isCall,
      strike,
      entryAsk: strike > 0 && entryAsk > 0 ? entryAsk : null,
      entryTs: row.detected_at,
      t1,
      stopLevel,
      t2,
      trailStopLevel: trail,
      optionStopPct: OPTION_STOP_PCT,
      closeMs,
      bars: candles,
      marks,
      settlementValue: officialClose,
    });
    option = {
      status: g.status,
      reason: g.reason,
      entry: g.entryPrice,
      exit: g.exitPrice,
      exitAt: g.exitTs,
      ret: g.realizedReturn,
      mfe: g.optionMfe,
      settledFrac: g.status === "graded" ? g.settledFraction : null,
    };
    fills = g.fills.map((f) => ({ kind: f.kind, fraction: f.fraction, price: f.price, ts: f.ts }));
    if (g.status === "graded" && g.realizedReturn != null) {
      hit30 = g.realizedReturn >= 0.30 ? 1 : 0;
      hit50 = g.realizedReturn >= 0.50 ? 1 : 0;
    }
  }

  const legs = plan.legs.map((l) => ({ kind: l.kind, fraction: l.fraction, at: l.time, underlying: l.underlyingPx }));
  return {
    outcome: {
      result: plan.hitT1 ? "t1_first" : plan.stoppedBeforeT1 ? "stop_first" : "no_touch_eod",
      method: "plan replay v2 (5-min close stop, half at T1, runner to T2)",
      plan: ODTE_PLAN_RULES.version,
      optionMethod: "same plan on logged Schwab marks: ask in, bid out, -20% stop on the bid, PM settlement at intrinsic",
      settlementSource: isFire ? (officialClose != null && officialClose > 0 ? "official_close_daily_bar" : "last_minute_bar_close") : null,
      spotAtFire: spot0,
      t1,
      t2,
      stop: stopLevel,
      trailStop: trail ?? (isCall ? t1 - ODTE_PLAN_RULES.trailOffsetPts : t1 + ODTE_PLAN_RULES.trailOffsetPts),
      trailArmedAt: plan.trailArmedAt,
      legs,
      remainingAtClose: plan.remaining,
      bars: plan.barsUsed,
      bestFavorablePct: Number(bestFavorablePct.toFixed(3)),
      realizedPct: Number.isFinite(realizedPct) ? Number(realizedPct.toFixed(3)) : null,
      option: isFire ? { ...option, fills } : { status: "not_applicable", reason: "rejected setups have no logged marks" },
      gradedFrom: now,
    },
    pctReturn: Number(bestFavorablePct.toFixed(3)),
    realizedPct: Number.isFinite(realizedPct) ? Number(realizedPct.toFixed(3)) : null,
    hit30,
    hit50,
    hitT1,
    retryable: false,
    option,
  };
}

export async function gradeOdteAlerts(now: number = Date.now()): Promise<OdteGradingSummary> {
  const summary: OdteGradingSummary = { ranAt: now, graded: 0, wins: 0, losses: 0, insufficient: 0, errors: 0, optionGraded: 0, optionUngraded: 0, deferred: 0, fromSavedBars: 0 };
  try {
    const rows = sqlite
      .prepare(`SELECT * FROM odte_alert_audit WHERE graded = 0 ORDER BY detected_at ASC LIMIT 200`)
      .all() as AuditRow[];
    if (rows.length === 0) return summary;

    const due = rows.filter((r) => marketClosedFor(r.detected_at, now));
    if (due.length === 0) return summary;

    const mark = sqlite.prepare(`
      UPDATE odte_alert_audit
      SET outcome_json = ?, pct_return = ?, realized_pct = ?, hit_30 = ?, hit_50 = ?, hit_t1 = ?, graded = 1, graded_at = ?,
          option_status = ?, option_reason = ?, option_entry = ?, option_exit = ?, option_exit_at = ?, option_return = ?, option_mfe = ?,
          option_settled_frac = ?
      WHERE id = ?
    `);

    // Live Schwab history only reaches ~10 days; older rows use saved bars alone.
    const anyRecent = due.some((r) => now - r.detected_at <= MAX_LOOKBACK_DAYS * 24 * 3600_000);
    let live: Candle[] = [];
    if (anyRecent) { try { live = await getSpxMinuteCandles(); } catch { live = []; } }
    const closes = await getSpxDailyCloses();
    for (const r of due) {
      try {
        const tooOld = now - r.detected_at > MAX_LOOKBACK_DAYS * 24 * 3600_000;
        const closeMs = etCloseMs(r.detected_at);
        const { bars, savedUsed } = barsForWindow(tooOld ? [] : live, r.detected_at - 5 * 60_000, closeMs);
        const marks = r.tier !== "REJECTED" ? loadOdteOptionMarks(r.alert_id) : [];
        const g = gradeRow(r, bars, now, marks, closes.get(etDate(r.detected_at)) ?? null);
        if (g.retryable && !tooOld) { summary.deferred++; continue; } // bars may still arrive
        if (g.retryable) {
          g.outcome = { ...g.outcome, reason: `beyond live minute history and no complete saved bars (${String(g.outcome.reason ?? "")})` };
          if (r.tier !== "REJECTED") g.option = { ...g.option, status: "ungraded", reason: "beyond_minute_history" };
        }
        const o = g.option;
        mark.run(JSON.stringify({ ...g.outcome, barsSource: savedUsed ? "schwab_live+saved_spx_minute_bars" : "schwab_live" }),
          g.pctReturn, g.realizedPct, g.hit30, g.hit50, g.hitT1, now,
          o.status, o.reason, o.entry, o.exit, o.exitAt, o.ret, o.mfe, o.settledFrac, r.id);
        if (savedUsed) summary.fromSavedBars++;
        if (g.hitT1 === 1) { summary.graded++; summary.wins++; }
        else if (g.hitT1 === 0) { summary.graded++; summary.losses++; }
        else summary.insufficient++;
        if (o.status === "graded") summary.optionGraded++;
        else if (o.status === "ungraded") summary.optionUngraded++;
      } catch (e: any) {
        summary.errors++;
        console.error(`[odteGrader] row ${r.id} failed:`, e?.message ?? e);
      }
    }
  } catch (e: any) {
    summary.errors++;
    console.error("[odteGrader] failed:", e?.message ?? e);
  }
  if (summary.graded > 0 || summary.insufficient > 0) _ledgerCache = null;
  return summary;
}

// ─── Option-P&L ledger by grade bucket (feeds positionSizer) ─────────────────

type LedgerRow = { score: number; entry: number; exit: number; settled: boolean | number };
let _ledgerCache: { at: number; rows: LedgerRow[] } | null = null;

/** Option-graded fires (entry ask, quantity-weighted exit, settled fraction); cached 5 min. */
function loadLedgerRows(now: number): LedgerRow[] {
  if (_ledgerCache && now - _ledgerCache.at < 5 * 60_000) return _ledgerCache.rows;
  let rows: LedgerRow[] = [];
  try {
    rows = (sqlite
      .prepare(`SELECT score, option_entry, option_exit, option_reason, option_settled_frac FROM odte_alert_audit
                WHERE option_status = 'graded' AND option_entry > 0 AND option_exit IS NOT NULL AND tier != 'REJECTED'`)
      .all() as Array<{ score: number; option_entry: number; option_exit: number; option_reason: string; option_settled_frac: number | null }>)
      .map((r) => ({
        score: Number(r.score),
        entry: Number(r.option_entry),
        exit: Number(r.option_exit),
        // Plan-v2 rows store the fraction held to cash settlement (no closing
        // fee on it). Older single-exit rows: settled holds and worthless
        // expiries pay no closing fee.
        settled: r.option_settled_frac != null && Number.isFinite(Number(r.option_settled_frac))
          ? Number(r.option_settled_frac)
          : r.option_reason === "settled_at_close" || Number(r.option_exit) === 0,
      }));
  } catch { /* table or columns missing: empty ledger */ }
  _ledgerCache = { at: now, rows };
  return rows;
}

/**
 * Ledger buckets with realized returns NET of `feePerContract` ($ per
 * contract per side): the stored option_return is gross, and the sizer's
 * planned loss includes fees, so p, b, L and the log-optimal Kelly must too.
 */
function loadLedger(now: number, feePerContract: number): Map<string, OptionLedgerBucket> {
  const groups = new Map<string, number[]>();
  for (const r of loadLedgerRows(now)) {
    const b = gradeBucketFor(r.score);
    if (!b) continue;
    const net = netOptionReturn(r.entry, r.exit, feePerContract, r.settled);
    if (net == null) continue;
    if (!groups.has(b.label)) groups.set(b.label, []);
    groups.get(b.label)!.push(net);
  }
  const byLabel = new Map<string, OptionLedgerBucket>();
  for (const [label, rets] of Array.from(groups)) byLabel.set(label, summarizeOptionReturns(label, rets));
  return byLabel;
}

/** Realized option-P&L bucket for a grade, net of fees (null when the grade has no bucket). n = 0 when no fire is option-graded yet. */
export function loadOptionLedgerBucket(score: number, now: number = Date.now(), feePerContract = 0): OptionLedgerBucket | null {
  const b = gradeBucketFor(score);
  if (!b) return null;
  return loadLedger(now, feePerContract).get(b.label) ?? { label: b.label, n: 0, wins: 0, avgWinReturn: null, avgLossReturn: null, returns: [] };
}

/** Ledger bucket plus the evidence a grade letter is shown with (review item 7.6). */
export type OptionLedgerBucketReport = OptionLedgerBucket & {
  winRate: number | null;
  wilsonLo: number | null;
  wilsonHi: number | null;
  /** "heuristic" until the bucket has MIN_FIRES_FOR_POINT_ESTIMATE option-graded fires. */
  labelStatus: "heuristic" | "ledger_backed";
  minFiresForLedgerBacked: number;
};

/** Whole ledger, for display: every bucket with its realized option stats, net of feePerContract. */
export function getOptionLedgerSummary(now: number = Date.now(), feePerContract = 0): OptionLedgerBucketReport[] {
  const m = loadLedger(now, feePerContract);
  return ["72-79", "80-84", "85-89", "90-94", "95-100"].map((label) => {
    const b = m.get(label) ?? { label, n: 0, wins: 0, avgWinReturn: null, avgLossReturn: null, returns: [] };
    const w = wilsonInterval(b.wins, b.n);
    return {
      ...b,
      winRate: b.n > 0 ? b.wins / b.n : null,
      wilsonLo: b.n > 0 ? w.lo : null,
      wilsonHi: b.n > 0 ? w.hi : null,
      labelStatus: gradeLabelStatus(b.n),
      minFiresForLedgerBacked: MIN_FIRES_FOR_POINT_ESTIMATE,
    };
  });
}

/** Gross ledger bucket for the alert text (never throws: null when the DB is unavailable). */
export function gradeEvidenceFor(score: number): OptionLedgerBucket | null {
  try { return loadOptionLedgerBucket(score); } catch { return null; }
}
