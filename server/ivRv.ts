// IV vs RV (Implied Vol vs Realized Vol) Engine
// For any symbol with daily_bars history + an option chain on Schwab:
//   - Computes trailing realized vol (close-to-close) at 5/10/20/30/60d windows
//   - Pulls ATM IV at 30/60/90d tenors from the option chain
//   - Computes IV/RV ratios (descriptive only)
//   - Forecasts realized vol over the IV30 tenor with HAR-RV (Corsi 2009,
//     server/harRv.ts) and grades IV30 - forecast as a z-score against its
//     own history (the verdict). Fixed IV/RV cut-offs are no longer used:
//     IV sits above realized on average (variance risk premium), so a fixed
//     ratio mostly measures that premium, not richness.
//   - Persists daily snapshot to iv_rv_daily for percentile rank context
//
// The verdict is a relative-value read, not a tested trading edge.

import { sqlite } from "./storage";
import { getOptionChain } from "./schwab";
import { harVolForecast, spreadVerdict, spreadZScore, SPREAD_MIN_HISTORY, SPREAD_Z_CUT, type SpreadZ } from "./harRv";

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

/** Closes with their dates, oldest first (for no-look-ahead history). */
function loadDatedCloses(symbol: string, lookbackDays: number): { date: string; close: number }[] {
  const rows = sqlite.prepare(
    `SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?`
  ).all(symbol.toUpperCase(), lookbackDays + 1) as { date: string; close: number }[];
  return rows.reverse().filter((r) => Number.isFinite(r.close) && r.close > 0);
}

/** Past IV30 snapshots (before `beforeDate`), oldest first. */
function loadIv30History(symbol: string, beforeDate: string, limit = 252): { date: string; iv30: number }[] {
  try {
    const rows = sqlite.prepare(
      `SELECT date, iv_30 AS iv30 FROM iv_rv_daily WHERE symbol = ? AND iv_30 IS NOT NULL AND date < ? ORDER BY date DESC LIMIT ?`
    ).all(symbol.toUpperCase(), beforeDate, limit) as { date: string; iv30: number }[];
    return rows.reverse().filter((r) => Number.isFinite(r.iv30) && r.iv30 > 0);
  } catch {
    return [];
  }
}

/** HAR horizon matching a 30-calendar-day IV: ~21 trading sessions. */
const HAR_HORIZON = 21;
const HAR_LOOKBACK = 1300; // ~5 years of daily closes

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
  /** What the verdict is based on. */
  verdictBasis?: "har-spread-zscore";
  /** HAR-RV forecast of annualized realized vol over the next 21 sessions. */
  forecast?: { harVol21d: number | null; r2: number | null; returnsUsed: number; method: string };
  /** IV30 - HAR forecast (decimal vol) and its z-score vs its own history. */
  spread?: SpreadZ & { minHistory: number; zCut: number };
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

  const asOf = nyDate(Date.now());

  // HAR-RV forecast now, and the same forecast at each past IV30 snapshot
  // using only closes up to that date (no look-ahead).
  const dated = loadDatedCloses(sym, HAR_LOOKBACK);
  const closesNow = dated.filter((r) => r.date <= asOf).map((r) => r.close);
  const har = harVolForecast(closesNow, HAR_HORIZON);
  const pastSpreads: number[] = [];
  if (har) {
    for (const h of loadIv30History(sym, asOf)) {
      const upTo = dated.filter((r) => r.date <= h.date).map((r) => r.close);
      const f = harVolForecast(upTo, HAR_HORIZON);
      if (f) pastSpreads.push(h.iv30 - f.annualVol);
    }
  }
  const spreadNow = ivAtm.iv30 != null && har ? ivAtm.iv30 - har.annualVol : NaN;
  const sz = spreadZScore(spreadNow, pastSpreads);
  const verdict: IvRvSnapshot["verdict"] = Number.isFinite(spreadNow) ? spreadVerdict(sz.z) : "insufficient";
  let notes: string;
  if (ivAtm.iv30 == null) notes = "no 30-day ATM implied vol from the Schwab chain: nothing to grade";
  else if (!har) notes = `HAR forecast unavailable: need >= 250 daily returns in daily_bars (have ${Math.max(0, closesNow.length - 1)})`;
  else if (sz.z == null) notes = `IV30 - HAR forecast = ${(spreadNow * 100).toFixed(1)} vol pts; z-score needs ${SPREAD_MIN_HISTORY} past snapshots (have ${sz.historyN})`;
  else notes = verdict === "rich"
    ? `IV30 sits ${sz.z.toFixed(1)} sd above its usual premium to forecast vol: options rich vs their own history`
    : verdict === "cheap"
      ? `IV30 sits ${Math.abs(sz.z).toFixed(1)} sd below its usual premium to forecast vol: options cheap vs their own history`
      : `IV30 premium to forecast vol within ${SPREAD_Z_CUT} sd of its history: fair`;
  const snap: IvRvSnapshot = {
    symbol: sym,
    asOf,
    rv,
    iv: { iv30: ivAtm.iv30, iv60: ivAtm.iv60, iv90: ivAtm.iv90 },
    ratio: { iv30_rv20: ratio_30_20, iv30_rv30: ratio_30_30, iv60_rv60: ratio_60_60 },
    verdict,
    verdictBasis: "har-spread-zscore",
    forecast: {
      harVol21d: har ? har.annualVol : null,
      r2: har ? har.fit.r2 : null,
      returnsUsed: har ? har.returnsUsed : Math.max(0, closesNow.length - 1),
      method: "HAR-RV (Corsi 2009) on squared daily log returns, direct 21-session forecast, annualized x sqrt(252)",
    },
    spread: { ...sz, minHistory: SPREAD_MIN_HISTORY, zCut: SPREAD_Z_CUT },
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
