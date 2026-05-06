// Closed-loop edge tracker. Pure DB writer + grader.
// Every whale alert + regime call logs here at fire time.
// Grader cron (16:30 ET) grades anything past grading_due_at vs daily_bars.

import { db, sqlite } from "./storage";
import { predictionOutcomes } from "@shared/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

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
 * expiration day at 20:00 UTC (16:00 ET).
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

function gradeWhaleAlert(row: any, now: number): boolean {
  const pred = JSON.parse(row.predictionJson || "{}");
  const symbol = row.symbol;
  // Get entry bar (close on or before captured_at) and exit bar (close on or before due).
  const entryBar = closeOnOrBefore(symbol, row.capturedAt);
  const exitBar = closeOnOrBefore(symbol, row.gradingDueAt);
  if (!entryBar || !exitBar) {
    // mark graded with insufficient_history so we don't keep retrying
    markGraded(row.predictionId, {
      result: "insufficient_history",
      pctReturn: null,
      hit30: null,
      hit50: null,
      hit100: null,
    }, now, null, null, null, null);
    return false;
  }
  if (exitBar.t <= entryBar.t) {
    markGraded(row.predictionId, {
      result: "no_holding_period",
      pctReturn: null,
      hit30: null,
      hit50: null,
      hit100: null,
    }, now, null, null, null, null);
    return false;
  }

  const movePct = (exitBar.close - entryBar.close) / entryBar.close;
  const tNorm = String(pred.type).toUpperCase();
  const isCall = tNorm === "CALL" || tNorm === "C";
  const directional = isCall ? movePct : -movePct;
  const delta = Number(pred.delta ?? 0);
  // Match backtester leverage model exactly: clamp(|delta|/0.05, 4, 25)
  const leverage = Math.max(4, Math.min(25, Math.abs(delta) / 0.05));
  const pctReturn = Math.max(-1, leverage * directional);

  const hit30 = pctReturn >= 0.3 ? 1 : 0;
  const hit50 = pctReturn >= 0.5 ? 1 : 0;
  const hit100 = pctReturn >= 1.0 ? 1 : 0;

  markGraded(
    row.predictionId,
    {
      result: "ok",
      entryClose: entryBar.close,
      exitClose: exitBar.close,
      movePct,
      directional,
      leverage,
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
  // "2026-05-08" → epoch ms at 20:00 UTC (16:00 ET)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exp);
  if (!m) return Date.now();
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 20, 0, 0);
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
    } catch (e: any) {
      console.error("[outcomeGrader] tick failed:", e?.message ?? e);
    }
  };
  // First run after 60s so server fully boots
  setTimeout(tick, 60_000);
  setInterval(tick, 30 * 60 * 1000);
  console.log("[outcomeGrader] started — 30-min cadence, grades whale + regime predictions");
}
