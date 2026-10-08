// Closed-loop edge tracker. Pure DB writer + grader.
// Every whale alert + regime call logs here at fire time.
// Grader cron (16:30 ET) grades anything past grading_due_at vs daily_bars.

import { db, sqlite } from "./storage";
import { predictionOutcomes } from "@shared/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { loadWhaleEntryQuote, loadWhaleExitQuote } from "./whalePersistence";
import { acceptExitQuote, askToBidReturn, etCloseMs, optionTradeDollars, usableEntryAsk, WHALE_MARKS_METHOD } from "./validationMath";

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
 * Log a regime call prediction. Grading scheduled for next trading day +1
 * at 20:00 UTC. Confidence < 0.30 is skipped (low-info predictions).
 */
export function logRegimeCallPrediction(p: RegimeCallPrediction): string {
  try {
    if (p.confidence < 0.3) return "";
    const id = randomUUID();
    // Grade ~26h after capture so next-session close is available.
    const gradingDueAt = p.capturedAt + 26 * 60 * 60 * 1000;

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
  // Exit at the 16:00 ET close of the expiry date. Rows logged by older builds
  // carry a 20:00 UTC due time, which is 15:00 ET in winter: recompute.
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

function gradeRegimeCall(row: any, now: number): boolean {
  // Grade by checking realized SPY/^GSPC move direction over horizon.
  // For now we score based on whether predicted regime category implies
  // directional bias and the realized move matches.
  const pred = JSON.parse(row.predictionJson || "{}");
  const symbol = row.symbol === "^GSPC" ? "SPY" : row.symbol;

  const entryBar = closeOnOrBefore(symbol, row.capturedAt);
  const exitBar = closeOnOrBefore(symbol, row.gradingDueAt);
  if (!entryBar || !exitBar || exitBar.t <= entryBar.t) {
    markGraded(row.predictionId, { result: "insufficient_history" }, now, null, null, null, null);
    return false;
  }
  const movePct = (exitBar.close - entryBar.close) / entryBar.close;
  const absMove = Math.abs(movePct);
  const top = String(pred.topCandidate || pred.regime || "");

  // Implied direction by regime bucket
  let expectedTrend: "trend" | "chop" | "neutral" = "neutral";
  if (top.startsWith("TREND")) expectedTrend = "trend";
  else if (top.startsWith("CHOP")) expectedTrend = "chop";

  // Trend regime "hits" if abs move >= 0.5%; chop regime hits if abs move < 0.5%.
  let regimeMatch = 0;
  if (expectedTrend === "trend" && absMove >= 0.005) regimeMatch = 1;
  else if (expectedTrend === "chop" && absMove < 0.005) regimeMatch = 1;
  else if (expectedTrend === "neutral") regimeMatch = absMove < 0.005 ? 1 : 0;

  // Treat regimeMatch as the "hit" signal. pctReturn = signed move percent in pp.
  const pctReturn = movePct;
  markGraded(
    row.predictionId,
    {
      result: "ok",
      entryClose: entryBar.close,
      exitClose: exitBar.close,
      movePct,
      absMovePct: absMove,
      expectedTrend,
      regimeMatch,
    },
    now,
    pctReturn,
    regimeMatch, // hit_30 = regime call correct
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
  // "2026-05-08" → epoch ms of 16:00 ET that day (20:00 UTC in summer, 21:00 UTC in winter)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(exp);
  if (!m) return Date.now();
  return etCloseMs(`${m[1]}-${m[2]}-${m[3]}`);
}

function closeOnOrBefore(symbol: string, atMs: number): { close: number; t: number; date: string } | null {
  try {
    // daily_bars.t is stored in unix SECONDS (not ms). Convert.
    const atSec = Math.floor(atMs / 1000);
    const stmt = sqlite.prepare(
      `SELECT date, close, t FROM daily_bars
         WHERE symbol = ? AND t <= ?
         ORDER BY t DESC LIMIT 1`,
    );
    const row: any = stmt.get(symbol, atSec);
    if (!row) return null;
    // Return t as ms for consistent downstream comparisons.
    return { close: Number(row.close), t: Number(row.t) * 1000, date: String(row.date) };
  } catch {
    return null;
  }
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
      if (og.graded > 0 || og.insufficient > 0) {
        console.log(`[odteGrader] ran — graded=${og.graded} wins=${og.wins} losses=${og.losses} insufficient=${og.insufficient}`);
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
