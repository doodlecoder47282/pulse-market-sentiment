// server/cusumWatchdog.ts
//
// CUSUM drift watchdog over the Pulse calibration outcome stream.
//
// Reads from the existing pulse_outcomes SQLite table (created by
// calibration.ts) — we never write to it, never touch it. Pure observer.
//
// The series we monitor is `brier_total - trivial_total_per_day`. If Pulse
// is stable, this hovers around its baseline. If it drifts UPWARD (we're
// getting worse vs trivial), CUSUM accumulates and trips a watchdog flag.
//
// Status badge:
//   HEALTHY   — drift is within 4σ
//   DRIFTING  — drift > 4σ but ≤ 5σ — caution
//   BROKEN    — drift > 5σ — model is empirically worse than trivial

import Database from "better-sqlite3";
import { cusum } from "./stats";

const sqlite = new Database("data.db");

export function watchdogStatus(days: number = 60): {
  ok: boolean;
  status: "HEALTHY" | "DRIFTING" | "BROKEN" | "INSUFFICIENT_DATA";
  n: number;
  cValue: number;
  baseline: number;
  thresholds: { warn: number; alarm: number };
  reason: string;
} {
  try {
    const rows = sqlite
      .prepare(
        `SELECT brier_total, outcome_bull, outcome_base, outcome_bear
         FROM pulse_outcomes
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(days) as Array<{
      brier_total: number;
      outcome_bull: number;
      outcome_base: number;
      outcome_bear: number;
    }>;

    if (rows.length < 10) {
      return {
        ok: true,
        status: "INSUFFICIENT_DATA",
        n: rows.length,
        cValue: 0,
        baseline: 0,
        thresholds: { warn: 0, alarm: 0 },
        reason: `need ≥10 settled days, have ${rows.length}`,
      };
    }

    // Per-day error series: pulse Brier minus trivial-forecaster Brier on the
    // same day. Positive = pulse is worse than trivial = bad.
    const errors = rows.map((r) => {
      const trivialDay =
        Math.pow(1 / 3 - r.outcome_bull, 2) +
        Math.pow(1 / 3 - r.outcome_base, 2) +
        Math.pow(1 / 3 - r.outcome_bear, 2);
      return r.brier_total - trivialDay;
    });

    const result = cusum(errors);
    return {
      ok: result.status !== "BROKEN",
      status: result.status,
      n: rows.length,
      cValue: result.c,
      baseline: result.baseline,
      thresholds: { warn: result.h_warn, alarm: result.h_alarm },
      reason: result.status === "HEALTHY"
        ? "model tracking baseline"
        : result.status === "DRIFTING"
        ? "model drifting vs trivial — watch closely"
        : "model worse than trivial — investigate",
    };
  } catch (e: any) {
    return {
      ok: true, // fail open — never break callers
      status: "INSUFFICIENT_DATA",
      n: 0,
      cValue: 0,
      baseline: 0,
      thresholds: { warn: 0, alarm: 0 },
      reason: `watchdog error: ${e?.message ?? e}`,
    };
  }
}
