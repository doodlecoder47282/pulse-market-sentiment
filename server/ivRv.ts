// IV vs RV (Implied Vol vs Realized Vol) Engine
// For any symbol with daily_bars history + an option chain on Schwab:
//   - Computes trailing realized vol (close-to-close) at 5/10/20/30/60d windows
//   - Pulls ATM IV at 30/60/90d tenors from the option chain
//   - Computes IV/RV ratio (the cleanest "options fairly priced" signal)
//   - Persists daily snapshot to iv_rv_daily for percentile rank context
//
// Edge: this is what every options desk uses to decide vol seller vs vol buyer regardless of direction.

import { sqlite } from "./storage";
import { getOptionChain } from "./schwab";

// ----- helpers -----
function nyDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function annualize(stdDevDailyLogReturn: number): number {
  return stdDevDailyLogReturn * Math.sqrt(252);
}

function realizedVol(closes: number[]): number | null {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  return annualize(Math.sqrt(variance));
}

function loadCloses(symbol: string, lookbackDays: number): number[] {
  const sym = symbol.toUpperCase();
  const rows = sqlite.prepare(
    `SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?`
  ).all(sym, lookbackDays + 1) as { date: string; close: number }[];
  // newest first → reverse so closes ascend chronologically
  return rows.reverse().map(r => r.close);
}

export interface RealizedVolBreakdown {
  rv5: number | null;
  rv10: number | null;
  rv20: number | null;
  rv30: number | null;
  rv60: number | null;
}

export function computeRealizedVol(symbol: string): RealizedVolBreakdown {
  return {
    rv5: realizedVol(loadCloses(symbol, 5)),
    rv10: realizedVol(loadCloses(symbol, 10)),
    rv20: realizedVol(loadCloses(symbol, 20)),
    rv30: realizedVol(loadCloses(symbol, 30)),
    rv60: realizedVol(loadCloses(symbol, 60)),
  };
}

// ----- ATM IV pull from chain -----
// Schwab chain has volatility per option contract. Pull mid-IV at strikes nearest spot
// across the 30/60/90 DTE expirations.

interface AtmIvResult {
  iv30: number | null;
  iv60: number | null;
  iv90: number | null;
  spotUsed: number | null;
}

async function atmIvByTenor(symbol: string): Promise<AtmIvResult> {
  try {
    const chain = await getOptionChain(symbol, 100);
    if (!chain || "error" in chain) return { iv30: null, iv60: null, iv90: null, spotUsed: null };
    const spot = (chain as any).underlyingPrice as number | undefined;
    if (!Number.isFinite(spot as number)) return { iv30: null, iv60: null, iv90: null, spotUsed: null };

    const callMap = (chain as any).callExpDateMap as Record<string, Record<string, any[]>>;
    const putMap = (chain as any).putExpDateMap as Record<string, Record<string, any[]>>;
    if (!callMap || !putMap) return { iv30: null, iv60: null, iv90: null, spotUsed: spot ?? null };

    const targets = [30, 60, 90];
    const result: { [k: string]: number | null } = { iv30: null, iv60: null, iv90: null };

    // Schwab key is `YYYY-MM-DD:DTE`
    const allKeys = Object.keys(callMap);
    const parsed = allKeys.map(k => {
      const [date, dte] = k.split(":");
      return { key: k, date, dte: parseInt(dte, 10) };
    }).filter(x => Number.isFinite(x.dte));

    for (const target of targets) {
      // Find expiration whose DTE is closest to target.
      let best: typeof parsed[0] | null = null;
      let bestDiff = Infinity;
      for (const p of parsed) {
        const d = Math.abs(p.dte - target);
        if (d < bestDiff) { bestDiff = d; best = p; }
      }
      if (!best || bestDiff > target * 0.6) continue;

      // ATM = strike closest to spot. Average call & put IV for that strike.
      const callStrikes = callMap[best.key] ?? {};
      const putStrikes = putMap[best.key] ?? {};
      const allStrikes = new Set([...Object.keys(callStrikes), ...Object.keys(putStrikes)]);
      let bestStrike: string | null = null;
      let bestStrikeDiff = Infinity;
      for (const s of allStrikes) {
        const sn = parseFloat(s);
        const d = Math.abs(sn - (spot as number));
        if (d < bestStrikeDiff) { bestStrikeDiff = d; bestStrike = s; }
      }
      if (!bestStrike) continue;

      const callOpt = (callStrikes[bestStrike] ?? [])[0];
      const putOpt = (putStrikes[bestStrike] ?? [])[0];
      const ivs: number[] = [];
      if (callOpt && Number.isFinite(callOpt.volatility) && callOpt.volatility > 0) ivs.push(callOpt.volatility);
      if (putOpt && Number.isFinite(putOpt.volatility) && putOpt.volatility > 0) ivs.push(putOpt.volatility);
      if (!ivs.length) continue;

      // Schwab returns IV as a percentage (e.g. 18.5). Normalize to decimal.
      const avg = ivs.reduce((a, b) => a + b, 0) / ivs.length;
      result[`iv${target}`] = avg / 100;
    }

    return { ...(result as any), spotUsed: spot ?? null };
  } catch (e) {
    return { iv30: null, iv60: null, iv90: null, spotUsed: null };
  }
}

// ----- Combined snapshot + persistence -----
export interface IvRvSnapshot {
  symbol: string;
  asOf: string;
  rv: RealizedVolBreakdown;
  iv: { iv30: number | null; iv60: number | null; iv90: number | null };
  ratio: { iv30_rv20: number | null; iv30_rv30: number | null; iv60_rv60: number | null };
  verdict: "rich" | "fair" | "cheap" | "insufficient";
  notes: string;
  rvCones: { window: number; current: number | null; p10: number | null; p50: number | null; p90: number | null }[];
  spot: number | null;
  source: "schwab" | "no-data";
}

function ratio(iv: number | null, rv: number | null): number | null {
  if (iv == null || rv == null || rv <= 0) return null;
  return iv / rv;
}

function persist(symbol: string, snap: IvRvSnapshot): void {
  try {
    sqlite.prepare(`
      INSERT OR REPLACE INTO iv_rv_daily
        (symbol, date, rv_5, rv_10, rv_20, rv_30, rv_60, iv_30, iv_60, iv_90, captured_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      symbol.toUpperCase(),
      snap.asOf,
      snap.rv.rv5, snap.rv.rv10, snap.rv.rv20, snap.rv.rv30, snap.rv.rv60,
      snap.iv.iv30, snap.iv.iv60, snap.iv.iv90,
      Date.now()
    );
  } catch {}
}

function rvConePercentiles(symbol: string, windowDays: number): { p10: number | null; p50: number | null; p90: number | null } {
  const col = `rv_${windowDays}`;
  try {
    const rows = sqlite.prepare(
      `SELECT ${col} as v FROM iv_rv_daily WHERE symbol = ? AND ${col} IS NOT NULL ORDER BY date DESC LIMIT 252`
    ).all(symbol.toUpperCase()) as { v: number }[];
    const xs = rows.map(r => r.v).filter(Number.isFinite).sort((a, b) => a - b);
    if (xs.length < 30) return { p10: null, p50: null, p90: null };
    const pick = (p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
    return { p10: pick(0.1), p50: pick(0.5), p90: pick(0.9) };
  } catch {
    return { p10: null, p50: null, p90: null };
  }
}

export async function computeIvRvSnapshot(symbol: string): Promise<IvRvSnapshot> {
  const sym = symbol.toUpperCase();
  const rv = computeRealizedVol(sym);
  const ivAtm = await atmIvByTenor(sym);
  const ratio_30_20 = ratio(ivAtm.iv30, rv.rv20);
  const ratio_30_30 = ratio(ivAtm.iv30, rv.rv30);
  const ratio_60_60 = ratio(ivAtm.iv60, rv.rv60);

  let verdict: IvRvSnapshot["verdict"] = "insufficient";
  let notes = "";
  // Use IV30/RV30 as the primary verdict ratio when available, else fall back.
  const primary = ratio_30_30 ?? ratio_30_20 ?? ratio_60_60;
  if (primary != null) {
    if (primary >= 1.25) { verdict = "rich"; notes = "options expensive vs realized — favor selling premium / spreads"; }
    else if (primary <= 0.95) { verdict = "cheap"; notes = "options cheap vs realized — favor buying premium / long gamma"; }
    else { verdict = "fair"; notes = "options near fair value — directional thesis must carry"; }
  } else {
    notes = "insufficient option chain or daily bars to grade";
  }

  const asOf = nyDate(Date.now());
  const snap: IvRvSnapshot = {
    symbol: sym,
    asOf,
    rv,
    iv: { iv30: ivAtm.iv30, iv60: ivAtm.iv60, iv90: ivAtm.iv90 },
    ratio: { iv30_rv20: ratio_30_20, iv30_rv30: ratio_30_30, iv60_rv60: ratio_60_60 },
    verdict,
    notes,
    rvCones: [],
    spot: ivAtm.spotUsed,
    source: ivAtm.spotUsed != null ? "schwab" : "no-data",
  };

  // Persist before computing cones so today's row contributes to future percentile context.
  persist(sym, snap);

  const cones = [5, 10, 20, 30, 60].map(w => {
    const cur = (rv as any)[`rv${w}`] as number | null;
    const pct = rvConePercentiles(sym, w);
    return { window: w, current: cur, p10: pct.p10, p50: pct.p50, p90: pct.p90 };
  });
  snap.rvCones = cones;

  return snap;
}
