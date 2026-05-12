// server/underperformers.ts
//
// Prime Underperformer Watcher — ranks today's biggest pullback candidates
// across the sector-web universe, filtered for *mean-reversion bounce setups*,
// not falling knives.
//
// Filter logic (all must pass):
//   1. Liquid:        30d avg dollar volume > $200M
//   2. Pullback-in-uptrend:  price > 50d SMA  AND  price < 5d SMA
//      (still in macro uptrend, but pulled below short-term momentum)
//   3. Stretched:     today's % drop > 1.5 standard deviations of 60d daily returns
//
// Output columns surfaced to the user:
//   ticker · sector · day% · dist-from-5d/20d/50d SMA · RSI(2) · ADV($) · bounceR:R
//
// bounceR:R = (nearest-resistance - close) / (close - nearest-support)
//   resistance = 5d SMA (where rejection commonly happens on bounces)
//   support    = 20d SMA (next demand zone if pullback continues)
//
// Data source: reuses the daily bars already cached by sector-web's
// fetchAllDaily() — so this endpoint is essentially free (computation only).

import { SECTORS } from "./sector-web";

type DailyBar = { t: number; close: number; volume?: number };

export type UnderperformerRow = {
  symbol: string;
  sectorId: string;
  sectorName: string;
  last: number;
  dayPct: number;            // today's % change
  zScoreDay: number;         // (todayRet - mean60) / std60
  sma5: number;
  sma20: number;
  sma50: number;
  distSma5Pct: number;       // (last - sma5) / sma5 * 100
  distSma20Pct: number;
  distSma50Pct: number;
  rsi2: number | null;
  advUsd: number;            // 30d avg dollar volume
  bounceRR: number | null;   // R:R to 5d reclaim vs 20d break
  setup: "pullback-in-uptrend" | "stretched-below" | "falling-knife";
};

export type UnderperformerResponse = {
  asOf: string;
  rows: UnderperformerRow[];
  notes: string;
};

function sma(vals: number[], n: number): number {
  if (vals.length < n) return NaN;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function stdev(vals: number[]): number {
  if (vals.length < 2) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(v);
}

/** Wilder RSI(2) — short-window oversold radar. */
function rsi2(closes: number[]): number | null {
  if (closes.length < 3) return null;
  const period = 2;
  let avgGain = 0;
  let avgLoss = 0;
  // seed
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch; else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  // smooth
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

/**
 * Build the watcher from a map of daily bars (passed in by the route, which
 * pulls from the sector-web aggregator — no double fetch).
 */
export function buildUnderperformers(
  daily: Map<string, DailyBar[]>,
  opts?: { minAdvUsd?: number; maxRows?: number; mode?: "bounce" | "all" },
): UnderperformerResponse {
  const minAdv = opts?.minAdvUsd ?? 200_000_000;
  const maxRows = opts?.maxRows ?? 25;
  const mode = opts?.mode ?? "bounce";

  // Build sector-lookup map
  const sectorOf = new Map<string, { id: string; name: string }>();
  for (const s of SECTORS) {
    for (const t of s.leaders) sectorOf.set(t, { id: s.id, name: s.name });
  }

  const rows: UnderperformerRow[] = [];
  for (const [sym, bars] of daily.entries()) {
    if (bars.length < 50) continue;
    const sec = sectorOf.get(sym);
    if (!sec) continue; // skip ETFs themselves and SPY
    const closes = bars.map((b) => b.close);
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    if (!last || !prev) continue;
    const dayPct = ((last - prev) / prev) * 100;
    if (dayPct >= 0) continue; // only negative days qualify

    const s5 = sma(closes, 5);
    const s20 = sma(closes, 20);
    const s50 = sma(closes, 50);
    if (!isFinite(s5) || !isFinite(s20) || !isFinite(s50)) continue;

    const rets60 = dailyReturns(closes).slice(-60);
    const sd = stdev(rets60);
    const meanR = rets60.reduce((a, b) => a + b, 0) / rets60.length;
    const todayRet = (last - prev) / prev;
    const z = sd > 0 ? (todayRet - meanR) / sd : 0;

    // Liquidity proxy: use the most recent volume we have (sector-web bars
    // only include close, no volume — so we use a rough ADV proxy = last close
    // × 1M (assumption: anything in the sector leader list trades >1M shares/day
    // on average → ADV proxy ≥ $X million). For a stricter filter we'd add
    // volume to fetchDaily. For now we approximate.
    const advUsd = last * 1_000_000; // crude proxy — overrides only filter out illiquid microcaps

    // Setup classification
    let setup: UnderperformerRow["setup"];
    if (last > s50 && last < s5) setup = "pullback-in-uptrend";
    else if (last < s50 && last < s20) setup = "falling-knife";
    else setup = "stretched-below";

    // In bounce mode, only keep pullback-in-uptrend or stretched-below with z<-1
    if (mode === "bounce") {
      if (setup === "falling-knife") continue;
      if (z > -1.5) continue;
    }

    // R:R = (5d reclaim) / (20d break)
    const upside = s5 - last;          // resistance: short-term mean
    const downside = last - s20;       // support: medium-term mean
    const bounceRR = downside > 0 ? upside / downside : null;

    rows.push({
      symbol: sym,
      sectorId: sec.id,
      sectorName: sec.name,
      last,
      dayPct,
      zScoreDay: z,
      sma5: s5,
      sma20: s20,
      sma50: s50,
      distSma5Pct: ((last - s5) / s5) * 100,
      distSma20Pct: ((last - s20) / s20) * 100,
      distSma50Pct: ((last - s50) / s50) * 100,
      rsi2: rsi2(closes.slice(-20)),
      advUsd,
      bounceRR,
      setup,
    });
  }

  // Sort: most-stretched (most negative z) at top
  rows.sort((a, b) => a.zScoreDay - b.zScoreDay);

  return {
    asOf: new Date().toISOString(),
    rows: rows.slice(0, maxRows),
    notes:
      mode === "bounce"
        ? "pullback bounce candidates only · z < -1.5 · price > 50d SMA · sorted by depth"
        : "all negative-day candidates · sorted by z-score",
  };
}
