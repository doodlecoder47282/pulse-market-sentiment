/**
 * MISSION FIX #0 — 0DTE Alert Grader.
 *
 * Two ledgers per fire, both from real data:
 *
 * 1. Underlying first touch (hit_t1, feeds gradeCalibration):
 *    - SPX minute candles (Schwab getPriceHistory) from the first bar that
 *      OPENS at or after the fire to the 16:00 ET close.
 *    - CALL: WIN (hit_t1=1) if a bar's high touches t1 BEFORE any bar's low
 *      touches the logged stop level. PUT mirrored. Same-bar tie = LOSS.
 *    - No stop level logged: the row is graded "insufficient_inputs" instead
 *      of inventing a stop (the old code synthesized a 0.35% stop).
 *    - realized_pct = the underlying close-out return of that plan (exit at
 *      T1, at the stop, or at the last close). pct_return keeps the best
 *      favorable excursion (MFE) as a diagnostic only (review item 7.3).
 *
 * 2. Option P&L (review item 7.2), the ledger the sizer bets on:
 *    - entry = the contract's ask at fire (contract_json.ask), $ per share;
 *    - exit = replay of the plan on the option marks the 0DTE tracker logged
 *      (odte_option_marks): -20% option stop on the mid filled at the bid,
 *      underlying T1/stop touch filled at the next logged bid, else cash
 *      settlement at intrinsic on the close (SPXW is PM, cash-settled);
 *    - marks must cover fire-to-exit with no hole over 5 minutes, otherwise
 *      an unseen option stop could be graded as a hold;
 *    - option_return = (exit - entry) / entry; hit_30 / hit_50 = realized
 *      option return >= 30% / 50% (not the old linear MFE scaling);
 *    - no entry ask or no exit mark -> option_status 'ungraded', never estimated.
 *
 * REJECTED rows get the underlying grade only (no marks are logged for them):
 * that is the counterfactual ledger for the gates.
 *
 * Rows older than MAX_LOOKBACK_DAYS are marked "insufficient_history"
 * (Schwab minute history reaches about 10 days back).
 */

import { sqlite } from "./storage";
import { getPriceHistory } from "./schwab";
import { loadOdteOptionMarks } from "./odteAuditDb";
import {
  etCloseMs as etCloseForDate, etDate, gradeOdteOptionPnl, underlyingCloseOutPct,
  summarizeOptionReturns, gradeBucketFor, type OptionLedgerBucket, type MinuteBar,
} from "./validationMath";

const MAX_LOOKBACK_DAYS = 9; // Schwab minute history reaches ~10 days back
/** Option stop the exit brain enforces (exitBrain.ts HARD_STOP_PCT = -0.20). */
const OPTION_STOP_PCT = 0.20;

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
}

function etCloseMs(fireMs: number): number {
  // 16:00 ET on the fire's ET calendar date (DST-correct).
  return etCloseForDate(etDate(fireMs));
}

function marketClosedFor(fireMs: number, now: number): boolean {
  return now >= etCloseMs(fireMs) + 10 * 60_000; // 16:10 ET buffer
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
  _candleCache = { fetchedAt: now, candles };
  return candles;
}

interface RowGrade {
  outcome: Record<string, unknown>;
  pctReturn: number | null;     // MFE, % of spot (diagnostic)
  realizedPct: number | null;   // underlying close-out, % (statistics)
  hit30: number | null;
  hit50: number | null;
  hitT1: number | null;
  option: {
    status: "graded" | "ungraded" | null;
    reason: string | null;
    entry: number | null;
    exit: number | null;
    exitAt: number | null;
    ret: number | null;
    mfe: number | null;
  };
}

const NO_OPTION: RowGrade["option"] = { status: null, reason: null, entry: null, exit: null, exitAt: null, ret: null, mfe: null };

export function gradeRow(
  row: AuditRow,
  candles: Candle[],
  now: number,
  marks: Array<{ ts: number; bid: number | null; ask: number | null; mid: number | null }> = [],
): RowGrade {
  let features: any = {};
  try { features = JSON.parse(row.features_json || "{}"); } catch { /* noop */ }
  let contract: any = {};
  try { contract = JSON.parse(row.contract_json || "{}"); } catch { /* noop */ }

  const isCall = String(row.side).toUpperCase().startsWith("C");
  const t1 = Number(row.t1_target);
  const spotAtFire = Number(features.spot ?? features.spotAtFire ?? 0);
  const stopLevel = Number(features.stopLevel ?? 0);
  const isFire = row.tier !== "REJECTED";

  const empty = (outcome: Record<string, unknown>): RowGrade =>
    ({ outcome, pctReturn: null, realizedPct: null, hit30: null, hit50: null, hitT1: null, option: NO_OPTION });

  if (!isFinite(t1) || t1 <= 0) return empty({ result: "insufficient_inputs", reason: "no t1_target" });
  if (!(stopLevel > 0)) return empty({ result: "insufficient_inputs", reason: "no stop level logged (no stop is invented)" });

  const closeMs = etCloseMs(row.detected_at);
  const bars = candles
    .filter((c) => c.datetime >= row.detected_at && c.datetime < closeMs)
    .sort((a, b) => a.datetime - b.datetime);
  if (bars.length < 3) return empty({ result: "insufficient_history", bars: bars.length });

  const spot0 = spotAtFire > 0 ? spotAtFire : bars[0].open;
  const stop = stopLevel;

  let hitT1 = 0;
  let stopped = false;
  let bestFavorable = 0; // favorable excursion in index points
  let touchBar: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const t1Touched = isCall ? b.high >= t1 : b.low <= t1;
    const stopTouched = isCall ? b.low <= stop : b.high >= stop;
    const fav = isCall ? b.high - spot0 : spot0 - b.low;
    if (fav > bestFavorable) bestFavorable = fav;
    if (stopTouched) { stopped = true; touchBar = i; break; } // conservative: same-bar tie = loss
    if (t1Touched) { hitT1 = 1; touchBar = i; break; }
  }

  const lastClose = bars[bars.length - 1].close;
  const exitUnderlying = hitT1 ? t1 : stopped ? stop : lastClose;
  const realizedPct = underlyingCloseOutPct(isCall, spot0, exitUnderlying);
  const bestFavorablePct = (bestFavorable / spot0) * 100;

  // ── Option P&L on logged marks (fires only) ───────────────────────────────
  let option: RowGrade["option"] = NO_OPTION;
  let hit30: number | null = null;
  let hit50: number | null = null;
  if (isFire) {
    const strike = Number(contract.strike);
    const entryAsk = Number(contract.ask);
    const g = gradeOdteOptionPnl({
      isCall,
      strike,
      entryAsk: strike > 0 && entryAsk > 0 ? entryAsk : null,
      entryTs: row.detected_at,
      t1,
      stopLevel: stop,
      optionStopPct: OPTION_STOP_PCT,
      closeMs,
      bars: candles,
      marks,
    });
    option = {
      status: g.status,
      reason: g.reason,
      entry: g.entryPrice,
      exit: g.exitPrice,
      exitAt: g.exitTs,
      ret: g.realizedReturn,
      mfe: g.optionMfe,
    };
    if (g.status === "graded" && g.realizedReturn != null) {
      hit30 = g.realizedReturn >= 0.30 ? 1 : 0;
      hit50 = g.realizedReturn >= 0.50 ? 1 : 0;
    }
  }

  return {
    outcome: {
      result: hitT1 ? "t1_first" : stopped ? "stop_first" : "no_touch_eod",
      method: "minute-first-touch v2; option P&L replayed on logged Schwab marks (ask in, bid out, settlement at intrinsic)",
      spotAtFire: spot0,
      t1,
      stop,
      bars: bars.length,
      touchBarIdx: touchBar,
      bestFavorablePct: Number(bestFavorablePct.toFixed(3)),
      realizedPct: Number.isFinite(realizedPct) ? Number(realizedPct.toFixed(3)) : null,
      dirMoveClosePct: Number((((isCall ? lastClose - spot0 : spot0 - lastClose) / spot0) * 100).toFixed(3)),
      option: isFire ? option : { status: "not_applicable", reason: "rejected setups have no logged marks" },
      gradedFrom: now,
    },
    pctReturn: Number(bestFavorablePct.toFixed(3)),
    realizedPct: Number.isFinite(realizedPct) ? Number(realizedPct.toFixed(3)) : null,
    hit30,
    hit50,
    hitT1,
    option,
  };
}

export async function gradeOdteAlerts(now: number = Date.now()): Promise<OdteGradingSummary> {
  const summary: OdteGradingSummary = { ranAt: now, graded: 0, wins: 0, losses: 0, insufficient: 0, errors: 0, optionGraded: 0, optionUngraded: 0 };
  try {
    const rows = sqlite
      .prepare(`SELECT * FROM odte_alert_audit WHERE graded = 0 ORDER BY detected_at ASC LIMIT 200`)
      .all() as AuditRow[];
    if (rows.length === 0) return summary;

    const due = rows.filter((r) => marketClosedFor(r.detected_at, now));
    if (due.length === 0) return summary;

    const tooOld = due.filter((r) => now - r.detected_at > MAX_LOOKBACK_DAYS * 24 * 3600_000);
    const gradeable = due.filter((r) => now - r.detected_at <= MAX_LOOKBACK_DAYS * 24 * 3600_000);

    const mark = sqlite.prepare(`
      UPDATE odte_alert_audit
      SET outcome_json = ?, pct_return = ?, realized_pct = ?, hit_30 = ?, hit_50 = ?, hit_t1 = ?, graded = 1, graded_at = ?,
          option_status = ?, option_reason = ?, option_entry = ?, option_exit = ?, option_exit_at = ?, option_return = ?, option_mfe = ?
      WHERE id = ?
    `);

    for (const r of tooOld) {
      mark.run(JSON.stringify({ result: "insufficient_history", reason: "beyond minute-history window" }),
        null, null, null, null, null, now,
        r.tier !== "REJECTED" ? "ungraded" : null, r.tier !== "REJECTED" ? "beyond_minute_history" : null,
        null, null, null, null, null, r.id);
      summary.insufficient++;
    }

    if (gradeable.length > 0) {
      const candles = await getSpxMinuteCandles();
      for (const r of gradeable) {
        try {
          const marks = r.tier !== "REJECTED" ? loadOdteOptionMarks(r.alert_id) : [];
          const g = gradeRow(r, candles, now, marks);
          const o = g.option;
          mark.run(JSON.stringify(g.outcome), g.pctReturn, g.realizedPct, g.hit30, g.hit50, g.hitT1, now,
            o.status, o.reason, o.entry, o.exit, o.exitAt, o.ret, o.mfe, r.id);
          summary.graded++;
          if (g.hitT1 === 1) summary.wins++;
          else if (g.hitT1 === 0) summary.losses++;
          else summary.insufficient++;
          if (o.status === "graded") summary.optionGraded++;
          else if (o.status === "ungraded") summary.optionUngraded++;
        } catch (e: any) {
          summary.errors++;
          console.error(`[odteGrader] row ${r.id} failed:`, e?.message ?? e);
        }
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

let _ledgerCache: { at: number; byLabel: Map<string, OptionLedgerBucket> } | null = null;

function loadLedger(now: number): Map<string, OptionLedgerBucket> {
  if (_ledgerCache && now - _ledgerCache.at < 5 * 60_000) return _ledgerCache.byLabel;
  const byLabel = new Map<string, OptionLedgerBucket>();
  try {
    const rows = sqlite
      .prepare(`SELECT score, option_return FROM odte_alert_audit
                WHERE option_status = 'graded' AND option_return IS NOT NULL AND tier != 'REJECTED'`)
      .all() as Array<{ score: number; option_return: number }>;
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const b = gradeBucketFor(Number(r.score));
      if (!b) continue;
      if (!groups.has(b.label)) groups.set(b.label, []);
      groups.get(b.label)!.push(Number(r.option_return));
    }
    for (const [label, rets] of groups) byLabel.set(label, summarizeOptionReturns(label, rets));
  } catch { /* table or columns missing: empty ledger */ }
  _ledgerCache = { at: now, byLabel };
  return byLabel;
}

/** Realized option-P&L bucket for a grade (null when the grade has no bucket). n = 0 when no fire is option-graded yet. */
export function loadOptionLedgerBucket(score: number, now: number = Date.now()): OptionLedgerBucket | null {
  const b = gradeBucketFor(score);
  if (!b) return null;
  return loadLedger(now).get(b.label) ?? { label: b.label, n: 0, wins: 0, avgWinReturn: null, avgLossReturn: null };
}

/** Whole ledger, for display: every bucket with its realized option stats. */
export function getOptionLedgerSummary(now: number = Date.now()): OptionLedgerBucket[] {
  const m = loadLedger(now);
  return ["72-79", "80-84", "85-89", "90-94", "95-100"].map((label) =>
    m.get(label) ?? { label, n: 0, wins: 0, avgWinReturn: null, avgLossReturn: null });
}
