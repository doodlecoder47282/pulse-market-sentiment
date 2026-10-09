// server/compositeWeights.ts
//
// Loads the daily history of composite gauge sub-scores from the snapshots
// table (one snapshot per ET day: the last of the day) and runs the pure
// estimator composite.estimateGaugeWeights. Cached 12 h; a failed read is
// "not estimated" with a reason, never a silent default.

import { sqlite } from "./storage";
import { estimateGaugeWeights, type EstimatedGaugeWeights } from "./composite";

type Result = { ok: true; est: EstimatedGaugeWeights } | { ok: false; reason: string; days: number };

let cache: { at: number; res: Result } | null = null;
const CACHE_MS = 12 * 3600_000;
const LOOKBACK_DAYS = 400;

export function getEstimatedGaugeWeights(now = Date.now()): Result {
  if (cache && now - cache.at < CACHE_MS) return cache.res;
  let res: Result;
  try {
    const since = Math.floor(now / 1000) - LOOKBACK_DAYS * 86400;
    // Last snapshot of each ET day (captured_at is epoch seconds; ET = UTC-5
    // standard, -4 summer: the 05:00 UTC boundary splits days outside RTH).
    const rows = sqlite.prepare(
      `SELECT payload FROM snapshots WHERE id IN (
         SELECT MAX(id) FROM snapshots WHERE captured_at >= ? GROUP BY CAST((captured_at - 18000) / 86400 AS INTEGER)
       ) ORDER BY captured_at ASC`,
    ).all(since) as Array<{ payload: string }>;
    const history: Array<Record<string, number>> = [];
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload);
        const day: Record<string, number> = {};
        for (const g of p?.composite?.gauges ?? []) {
          if (g && typeof g.name === "string" && Number.isFinite(g.value)) day[g.name] = Number(g.value);
        }
        history.push(day);
      } catch { /* unreadable row: skipped */ }
    }
    res = estimateGaugeWeights(history);
  } catch (e: any) {
    res = { ok: false, reason: `snapshot history unreadable: ${String(e?.message ?? e).slice(0, 80)}`, days: 0 };
  }
  cache = { at: now, res };
  return res;
}
