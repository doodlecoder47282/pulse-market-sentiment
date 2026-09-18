/**
 * MISSION FIX #1 — Empirical grade calibration.
 *
 * The position sizer used to map grade -> win probability with a hardcoded
 * linear function (80 -> 0.50, 100 -> 0.78). That mapping was asserted, not
 * fitted — if real 90-grade setups win 56% instead of 62%, Kelly sizing is
 * systematically oversized on every trade.
 *
 * This module replaces the assertion with evidence:
 *   1. Reads graded fires from odte_alert_audit (hit_t1 = win definition:
 *      T1 touched before the stop, first-touch minute grading).
 *   2. Buckets by grade, computes realized win rate + Wilson 95% interval.
 *   3. Fits isotonic regression (pool-adjacent-violators) over the buckets —
 *      monotonic by construction: a higher grade can never map to a lower
 *      fitted probability.
 *   4. getWinProb(grade) serves the fitted curve when there's enough sample
 *      (MIN_TOTAL graded fires AND MIN_BUCKET in the grade's bucket), else
 *      falls back to the legacy linear prior — clearly flagged as "prior".
 *
 * REJECTED rows are surfaced separately as a counterfactual (did the gates
 * actually filter out losers?) but never enter the fitted curve — they were
 * rejected for reasons beyond grade, so pooling them would bias it.
 */

import { sqlite } from "./storage";

export const MIN_TOTAL = 40;   // graded fires before the fitted curve activates
export const MIN_BUCKET = 8;   // graded fires in a bucket before it's trusted

const BUCKETS: { lo: number; hi: number; label: string }[] = [
  { lo: 72, hi: 79, label: "72-79" },
  { lo: 80, hi: 84, label: "80-84" },
  { lo: 85, hi: 89, label: "85-89" },
  { lo: 90, hi: 94, label: "90-94" },
  { lo: 95, hi: 100, label: "95-100" },
];

export interface CalibrationBucket {
  label: string;
  lo: number;
  hi: number;
  n: number;
  wins: number;
  winRate: number | null;       // raw realized
  wilsonLo: number | null;      // 95% Wilson interval
  wilsonHi: number | null;
  fitted: number | null;        // isotonic-fitted probability
  prior: number;                // legacy linear map at bucket center
}

export interface CalibrationReport {
  asOf: number;
  source: "fitted" | "prior";
  totalGradedFires: number;
  buckets: CalibrationBucket[];
  rejectedCounterfactual: { n: number; winRate: number | null; note: string };
  note: string;
}

function legacyPrior(score: number): number {
  if (score < 80) return 0.45;
  return Math.max(0.45, Math.min(0.85, 0.50 + (score - 80) * (0.28 / 20)));
}

function wilson(wins: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.96, p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Pool-adjacent-violators: weighted isotonic fit over bucket win rates. */
function pav(values: { y: number; w: number }[]): number[] {
  const blocks = values.map((v) => ({ sum: v.y * v.w, w: v.w, idxs: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    const cur = blocks[i], nxt = blocks[i + 1];
    if (cur.sum / cur.w > nxt.sum / nxt.w + 1e-12) {
      cur.sum += nxt.sum; cur.w += nxt.w; cur.idxs += nxt.idxs;
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  const out: number[] = [];
  for (const b of blocks) {
    const mean = b.sum / b.w;
    for (let k = 0; k < b.idxs; k++) out.push(mean);
  }
  return out;
}

interface FireRow { score: number; hit_t1: number }

function loadGradedFires(): FireRow[] {
  try {
    return sqlite
      .prepare(`SELECT score, hit_t1 FROM odte_alert_audit
                WHERE graded = 1 AND hit_t1 IS NOT NULL AND tier != 'REJECTED'`)
      .all() as FireRow[];
  } catch { return []; }
}

let _cache: { at: number; report: CalibrationReport } | null = null;

export function getCalibrationReport(force = false): CalibrationReport {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < 5 * 60_000) return _cache.report;

  const fires = loadGradedFires();
  const total = fires.length;

  const bucketStats = BUCKETS.map((b) => {
    const rows = fires.filter((f) => f.score >= b.lo && f.score <= b.hi);
    const wins = rows.filter((f) => f.hit_t1 === 1).length;
    const n = rows.length;
    const wr = n > 0 ? wins / n : null;
    const wl = n > 0 ? wilson(wins, n) : null;
    return {
      label: b.label, lo: b.lo, hi: b.hi, n, wins,
      winRate: wr, wilsonLo: wl?.lo ?? null, wilsonHi: wl?.hi ?? null,
      fitted: null as number | null,
      prior: legacyPrior((b.lo + b.hi) / 2),
    };
  });

  // Isotonic fit over buckets with data; buckets without data inherit the prior.
  const withData = bucketStats.filter((b) => b.n > 0);
  if (withData.length >= 2) {
    const fitted = pav(withData.map((b) => ({ y: b.winRate as number, w: b.n })));
    withData.forEach((b, i) => { b.fitted = Math.max(0.30, Math.min(0.92, fitted[i])); });
  } else if (withData.length === 1) {
    withData[0].fitted = Math.max(0.30, Math.min(0.92, withData[0].winRate as number));
  }

  let rejected: { n: number; winRate: number | null } = { n: 0, winRate: null };
  try {
    const r = sqlite
      .prepare(`SELECT COUNT(*) n, AVG(hit_t1) wr FROM odte_alert_audit
                WHERE graded = 1 AND hit_t1 IS NOT NULL AND tier = 'REJECTED'`)
      .get() as any;
    rejected = { n: Number(r?.n ?? 0), winRate: r?.wr != null ? Number(r.wr) : null };
  } catch { /* noop */ }

  const source: "fitted" | "prior" = total >= MIN_TOTAL ? "fitted" : "prior";
  const report: CalibrationReport = {
    asOf: now,
    source,
    totalGradedFires: total,
    buckets: bucketStats,
    rejectedCounterfactual: {
      ...rejected,
      note: "graded rejected setups — if these win as often as fires, the gates aren't filtering",
    },
    note: source === "fitted"
      ? `isotonic fit over ${total} graded fires; buckets under ${MIN_BUCKET} samples still use the prior`
      : `only ${total} graded fires (< ${MIN_TOTAL}) — serving the legacy linear prior until the ledger fills`,
  };
  _cache = { at: now, report };
  return report;
}

/**
 * Grade -> win probability. Fitted when the evidence supports it; otherwise
 * the legacy prior. Also returns the source so downstream consumers (sizer UI)
 * can display "fitted" vs "prior" honestly.
 */
export function getWinProb(score: number): { p: number; source: "fitted" | "prior" } {
  const rep = getCalibrationReport();
  if (rep.source === "fitted") {
    const b = rep.buckets.find((x) => score >= x.lo && score <= x.hi);
    if (b && b.n >= MIN_BUCKET && b.fitted != null) return { p: b.fitted, source: "fitted" };
  }
  return { p: legacyPrior(score), source: "prior" };
}

export function invalidateCalibrationCache(): void { _cache = null; }
