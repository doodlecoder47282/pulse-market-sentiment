// server/cusumWatchdog.ts
//
// CUSUM skill watchdog over the Pulse calibration outcome stream.
//
// Reads from the existing pulse_outcomes SQLite table (created by
// calibration.ts) — we never write to it, never touch it. Pure observer.
//
// The series we monitor is d_t = brier_total_t − climatology_brier_t, oldest →
// newest, where climatology is the ONE base-rate forecaster shared with
// calibration.ts (stats.climatologyBaseline). The CUSUM target is 0 = no skill,
// so a model that is persistently worse than the base rate trips the alarm.
// (The old version used each series' own mean as target and a uniform 1/3
// baseline, so a model that always lost to trivial still read HEALTHY.)
//
// Status badge (stats.skillWatchdog):
//   HEALTHY   — window mean beats climatology and CUSUM ≤ 4σ
//   DRIFTING  — no demonstrated skill (mean ≥ 0) or CUSUM in (4σ, 5σ]
//   BROKEN    — CUSUM > 5σ, or worse than climatology with t ≥ 2

import Database from "better-sqlite3";
import { skillWatchdog } from "./stats";

const sqlite = new Database("data.db");

export function watchdogStatus(days: number = 60): {
  ok: boolean;
  status: "HEALTHY" | "DRIFTING" | "BROKEN" | "INSUFFICIENT_DATA";
  n: number;
  cValue: number;
  baseline: number;
  thresholds: { warn: number; alarm: number };
  reason: string;
  skill?: {
    reference: string;
    meanDiff: number;
    tStat: number | null;
    bss: number | null;
    modelBrier: number;
    climatologyBrier: number;
    climatologyFreqs: number[];
  };
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

    // SQL returns newest-first; CUSUM must run oldest → newest.
    const chron = [...rows].reverse();
    const w = skillWatchdog(
      chron.map((r) => ({
        modelBrier: r.brier_total,
        outcome: [r.outcome_bull, r.outcome_base, r.outcome_bear],
      })),
    );
    return {
      ok: w.status !== "BROKEN",
      status: w.status,
      n: rows.length,
      cValue: w.cusum.c,
      baseline: w.cusum.baseline,
      thresholds: { warn: w.cusum.h_warn, alarm: w.cusum.h_alarm },
      reason: w.reason,
      skill: {
        reference: "climatology (realized base rates over the window)",
        meanDiff: w.meanDiff,
        tStat: w.tStat,
        bss: w.bss,
        modelBrier: w.modelBrier,
        climatologyBrier: w.climatologyBrier,
        climatologyFreqs: w.climatologyFreqs,
      },
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
