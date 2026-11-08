// Closed-loop edge tracker. Pure DB writer + grader.
// Every whale alert + regime call logs here at fire time.
// Grader cron (16:30 ET) grades anything past grading_due_at vs daily_bars.

import { db, sqlite } from "./storage";
import { predictionOutcomes } from "@shared/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { loadWhaleEntryQuote, loadWhaleExitQuote } from "./whalePersistence";
import { acceptExitQuote, askToBidReturn, etCloseMs, optionTradeDollars, usableEntryAsk, WHALE_MARKS_METHOD } from "./validationMath";
import { gradeRegimeCallOnPath } from "../shared/regimeGrade";
import { etDate, etWallToEpochMs, sessionMinutes } from "./exchangeCalendar";

/** How old the logged exit quote may be at the expiry close (the flow loop re-quotes every few minutes). */
const WHALE_EXIT_QUOTE_MAX_AGE_MS = 20 * 60_000;

export type PredictionKind = "whale_alert" | "regime_call";

export interface WhaleAlertPrediction {
  occ: string;
  symbol: string;
  type: "C" | "P" | "CALL" | "PUT";
  strike: number;
  expiration: string; // ISO date
  dte: number;
  premium: number;
  volOiRatio: number;
  isNewStrike: boolean;
  tag: string;
  delta: number;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  // gate snapshot
  gates: {
    premiumFloor: number;
    volOiRatio: number;
    minDte: number;
    requiredTag: string;
    deltaMin: number;
    deltaMax: number;
  };
  regimeAtFire?: string | null;
  detectedAt: number;
}

export interface RegimeCallPrediction {
  symbol: string;
  currentRegime: string;
  topCandidate: string;
  topProbability: number;
  confidence: number;
  drivers: { name: string; weight: number }[];
  horizonMinutes: number;
  capturedAt: number;
}

/**
 * Log a whale alert prediction. Grading scheduled for the alert's
 * expiration day at the 16:00 ET close (DST-correct).
 */
export function logWhaleAlertPrediction(p: WhaleAlertPrediction): string {
  try {
    const id = randomUUID();
    const expDate = parseExpirationToMs(p.expiration);
    const gradingDueAt = expDate;

    db.insert(predictionOutcomes)
      .values({
        predictionId: id,
        kind: "whale_alert",
        symbol: p.symbol,
        capturedAt: p.detectedAt,
        gradingDueAt,
        inputsJson: JSON.stringify({
          gates: p.gates,
          regimeAtFire: p.regimeAtFire ?? null,
        }),
        predictionJson: JSON.stringify({
          occ: p.occ,
          type: p.type,
          strike: p.strike,
          expiration: p.expiration,
          dte: p.dte,
          premium: p.premium,
          volOiRatio: p.volOiRatio,
          isNewStrike: p.isNewStrike,
          tag: p.tag,
          delta: p.delta,
          sentiment: p.sentiment,
        }),
        graded: 0,
      })
      .run();
    return id;
  } catch (e: any) {
    console.error("[outcomeLogger] whale log failed:", e?.message ?? e);
    return "";
  }
}

/**
 * Log a regime call prediction. Graded on the realised $SPX path over the
 * called horizon (shared/regimeGrade.ts), once the horizon has passed and the
 * minute bars have been persisted. Confidence < 0.30 is skipped (low-info).
 */
export function logRegimeCallPrediction(p: RegimeCallPrediction): string {
  try {
    if (p.confidence < 0.3) return "";
    const id = randomUUID();
    // Due when the horizon has elapsed plus a margin for the bar poller (2 min cadence).
    const gradingDueAt = p.capturedAt + Math.max(5, Math.min(120, p.horizonMinutes || 20)) * 60_000 + 5 * 60_000;

    db.insert(predictionOutcomes)
      .values({
        predictionId: id,
        kind: "regime_call",
        symbol: p.symbol,
        capturedAt: p.capturedAt,
        gradingDueAt,
        inputsJson: JSON.stringify({
          currentRegime: p.currentRegime,
          horizonMinutes: p.horizonMinutes,
          drivers: p.drivers,
        }),
        predictionJson: JSON.stringify({
          topCandidate: p.topCandidate,
          topProbability: p.topProbability,
          confidence: p.confidence,
        }),
        graded: 0,
      })
      .run();
    return id;
  } catch (e: any) {
    // unique constraint (rapid duplicate) is fine; swallow
    return "";
  }
}

// ─── Grader ───────────────────────────────────────────────────────────────────

export interface GradingSummary {
  ranAt: number;
  whalesGraded: number;
  regimesGraded: number;
  errors: number;
}

export async function runGrader(now: number = Date.now()): Promise<GradingSummary> {
  const summary: GradingSummary = { ranAt: now, whalesGraded: 0, regimesGraded: 0, errors: 0 };
  try {
    const due = db
      .select()
      .from(predictionOutcomes)
      .where(and(eq(predictionOutcomes.graded, 0), lte(predictionOutcomes.gradingDueAt, now)))
      .all();

    for (const row of due) {
      try {
        if (row.kind === "whale_alert") {
          if (gradeWhaleAlert(row, now)) summary.whalesGraded++;
        } else if (row.kind === "regime_call") {
          if (gradeRegimeCall(row, now)) summary.regimesGraded++;
        }
      } catch (e: any) {
        summary.errors++;
        console.error("[outcomeLogger] grade row failed:", row.predictionId, e?.message ?? e);
      }
    }
  } catch (e: any) {
    console.error("[outcomeLogger] grader failed:", e?.message ?? e);
    summary.errors++;
  }
  return summary;
}

/**
 * Grade a whale alert on real option marks (review item 8.2): bought at the
 * ask logged at detection, sold at the bid the follow-through tracker logged
 * at or shortly before the expiry close. No logged entry ask or no usable exit
 * quote -> result "ungraded_no_mark" with null returns: never estimated (the
 * old grader multiplied the underlying move by a clamp(|delta|/0.05, 4, 25)
 * leverage proxy with no theta or spread).
 * pctReturn is the realized option return (fraction of premium paid).
 */
function gradeWhaleAlert(row: any, now: number): boolean {
  const pred = JSON.parse(row.predictionJson || "{}");
  const occ = String(pred.occ ?? "");
  // Exit at the session close of the expiry date (16:00 ET; 13:00 ET on an
  // early-close day, exchange calendar via validationMath.etCloseMs). Rows
  // logged by older builds carry a 20:00 UTC due time: recompute.
  const exitTime = pred.expiration ? parseExpirationToMs(String(pred.expiration)) : Number(row.gradingDueAt);
  if (now < exitTime) return false; // not closed yet: retry on a later tick
  const ungraded = (reason: string, extra: Record<string, unknown> = {}) => {
    markGraded(row.predictionId, { result: "ungraded_no_mark", method: WHALE_MARKS_METHOD, reason, ...extra }, now, null, null, null, null);
    return false;
  };
  const entry = loadWhaleEntryQuote(occ, Number(row.capturedAt));
  const entryAsk = usableEntryAsk(entry);
  if (entryAsk == null) return ungraded("no_entry_quote_logged");
  const exitQ = loadWhaleExitQuote(occ);
  const acc = acceptExitQuote(exitQ, exitTime, WHALE_EXIT_QUOTE_MAX_AGE_MS);
  if (!acc.ok) return ungraded(acc.reason, { entryAsk, exitQuoteAt: exitQ?.at ?? null });

  const pctReturn = askToBidReturn(entryAsk, acc.bid);
  const hit30 = pctReturn >= 0.3 ? 1 : 0;
  const hit50 = pctReturn >= 0.5 ? 1 : 0;
  const hit100 = pctReturn >= 1.0 ? 1 : 0;
  // $ per contract (x100), before fees; fees are account-specific and not applied here.
  const perContract = optionTradeDollars({ entry: entryAsk, exit: acc.bid, contracts: 1, feePerContract: 0 }).perContractGross;
  markGraded(
    row.predictionId,
    {
      result: "ok",
      method: WHALE_MARKS_METHOD,
      entryAsk,
      entryBid: entry?.bid ?? null,
      entryQuoteAt: entry?.at ?? null,
      exitBid: acc.bid,
      exitQuoteAt: acc.at,
      pnlPerContractBeforeFees: perContract,
      pctReturn,
    },
    now,
    pctReturn,
    hit30,
    hit50,
    hit100,
  );
  return true;
}

/**
 * Whale outcomes graded by the old leverage proxy are NOT rewritten: stored
 * rows stay as they are. Readers exclude them at query time with
 * OUTCOME_ON_OPTION_MARKS_SQL / isOutcomeOnOptionMarks (validationMath).
 */

/**
 * Grade a regime call on the event it forecast: the realised $SPX path over
 * the called horizon, from the stored 1-minute bars (shared/regimeGrade.ts).
 * SPY calls are graded on the $SPX path too (the index the ETF tracks; the
 * percent move is the same to within basis points) and the outcome says so.
 * Rows whose bars are missing stay ungraded until a day has passed, then
 * close as insufficient_history: never a 0% move.
 */
function gradeRegimeCall(row: any, now: number): boolean {
  const pred = JSON.parse(row.predictionJson || "{}");
  const inputs = JSON.parse(row.inputsJson || "{}");
  const horizonMinutes = Math.max(5, Math.min(120, Number(inputs.horizonMinutes) || 20));
  const capturedAt = Number(row.capturedAt);
  const dateEt = etDate(capturedAt);
  const sessionCloseMs = etWallToEpochMs(dateEt, 9 * 60 + 30 + (sessionMinutes(dateEt) || 390));
  const dayStart = etWallToEpochMs(dateEt, 9 * 60 + 30) - 60_000;
  let bars: Array<{ t: number; close: number }> = [];
  try {
    bars = sqlite.prepare("SELECT t, close FROM spx_minute_bars WHERE t >= ? AND t <= ? ORDER BY t").all(dayStart, sessionCloseMs) as any;
  } catch { bars = []; }
  const g = gradeRegimeCallOnPath(bars, capturedAt, horizonMinutes, pred.topCandidate ?? pred.regime, sessionCloseMs);
  if (g.result !== "ok") {
    // Bars may still arrive (the poller lags); give up only after a day.
    if (now - capturedAt < 24 * 3600_000) return false;
    markGraded(row.predictionId, { result: "insufficient_history", method: g.method, gradedOn: "$SPX 1-min bars", horizonMinutes }, now, null, null, null, null);
    return false;
  }
  markGraded(
    row.predictionId,
    {
      result: "ok",
      method: g.method,
      gradedOn: "$SPX 1-min bars",
      horizonMinutes,
      entryT: g.entryT, exitT: g.exitT,
      entryClose: g.entryClose,
      exitClose: g.exitClose,
      movePct: g.movePct,
      absMovePct: g.absMovePct,
      threshold: g.threshold,
      expectedTrend: g.expected,
      regimeMatch: g.regimeMatch,
      truncatedAtClose: g.truncatedAtClose,
      coveredMinutes: g.coveredMinutes,
    },
    now,
    g.movePct,
    g.regimeMatch, // hit_30 = regime call matched the realised horizon path
    null,
    null,
  );
  return true;
}

function markGraded(
  predictionId: string,
  outcome: any,
  now: number,
  pctReturn: number | null,
  hit30: number | null,
  hit50: number | null,
  hit100: number | null,
) {
  db.update(predictionOutcomes)
    .set({
      graded: 1,
      gradedAt: now,
      outcomeJson: JSON.stringify(outcome),
      pctReturn,
      hit30,
      hit50,
      hit100,
    })
    .where(eq(predictionOutcomes.predictionId, predictionId))
    .run();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseExpirationToMs(exp: string): number {
  // "2026-05-08" → epoch ms of that day's session close: 16:00 ET (20:00 UTC in
  // summer, 21:00 UTC in winter), 13:00 ET on early-close days
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(exp);
  if (!m) return Date.now();
  return etCloseMs(`${m[1]}-${m[2]}-${m[3]}`);
}


// ─── Scheduler ───────────────────────────────────────────────────────────────

let started = false;
export function startGraderScheduler() {
  if (started) return;
  started = true;
  // Run every 30 minutes during weekdays. Cheap, idempotent (graded=0 filter).
  const tick = async () => {
    try {
      const s = await runGrader(Date.now());
      if (s.whalesGraded > 0 || s.regimesGraded > 0) {
        console.log(
          `[outcomeGrader] ran — whales=${s.whalesGraded} regimes=${s.regimesGraded} errors=${s.errors}`,
        );
      }
      // MISSION FIX #0 — grade 0DTE alert fires + rejects (first-touch minute
      // bars). This is the feed for empirical grade calibration.
      const { gradeOdteAlerts } = await import("./odteGrader");
      const og = await gradeOdteAlerts(Date.now());
      if (og.graded > 0 || og.insufficient > 0 || og.deferred > 0) {
        console.log(`[odteGrader] ran — graded=${og.graded} wins=${og.wins} losses=${og.losses} insufficient=${og.insufficient} deferred=${og.deferred} fromSavedBars=${og.fromSavedBars}`);
        const { invalidateCalibrationCache } = await import("./gradeCalibration");
        invalidateCalibrationCache();
      }
    } catch (e: any) {
      console.error("[outcomeGrader] tick failed:", e?.message ?? e);
    }
  };
  // First run after 60s so server fully boots
  setTimeout(tick, 60_000);
  setInterval(tick, 30 * 60 * 1000);
  console.log("[outcomeGrader] started — 30-min cadence, grades whale + regime predictions");
}
