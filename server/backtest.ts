/**
 * Backtest engine — historical accuracy of key dealer levels.
 *
 * Methodology: "proxy-vol-regime-v1"
 *   Free feeds (Yahoo) don't give 5y true option chains, so we reconstruct
 *   analytic proxies that align with how our live engine places levels
 *   when OI is sparse:
 *
 *     - zeroGamma     = trailing 20D EMA (γ-flip proxy; Perfiliev 2023)
 *     - callWall      = close + k1 * ATR20 * (VIX/20)          (resistance)
 *     - putWall       = close - k1 * ATR20 * (VIX/20)          (support)
 *     - upsidePivot   = close + σ * sqrt(DTE/252) * k2         (bull path target)
 *     - downsidePivot = close - σ * sqrt(DTE/252) * k2, clamped by maxDropPct
 *     - mopexMaxPain  = nearest round-25 strike to close (institutional clustering)
 *     - dominantMag   = larger of |callWall-S|, |putWall-S| from S
 *     - extremeVac    = 2σ band (low-liquidity vacuum edge)
 *     - vommaPocket   = 1.5σ band (vol-of-vol compression)
 *
 *   For each historical date D and each horizon H:
 *     predict level at D, then walk [D+1, D+H] and check:
 *       touched  = price came within tolerance (25bps default, 50bps tails)
 *       held     = touched AND reversed ≥50% back into range within horizon
 *       absDist  = |closeAtHorizonEnd - predictedLevel| in bps
 *       breach1% = realized went >1% past level
 *
 *   Upgrade path to true dealer-level reconstruction: Polygon.io flat files
 *   or ORATS historical chains. UI labels this "proxy mode" so nobody
 *   mistakes proxy hit-rates for true dealer-level hit-rates.
 */

import { db } from "./storage";
import { backtestLevels, backtestObservations } from "@shared/schema";
import { eq, and } from "drizzle-orm";

const METHODOLOGY = "proxy-vol-regime-v1";

export type BacktestHorizon = "daily" | "weekly" | "monthly" | "quarterly";
export type LevelKind =
  | "callWall"
  | "putWall"
  | "zeroGamma"
  | "dominantMag"
  | "upsidePivot"
  | "downsidePivot"
  | "mopexMaxPain"
  | "extremeVac"
  | "vommaPocket";

const HORIZON_DAYS: Record<BacktestHorizon, number> = {
  daily: 1,
  weekly: 5,
  monthly: 21,
  quarterly: 63,
};

const MAX_DROP_PCT: Record<BacktestHorizon, number> = {
  daily: 0.03,
  weekly: 0.05,
  monthly: 0.07,
  quarterly: 0.12,
};

// Tolerance bands for "touched" (basis points from level)
const TOUCH_BPS: Record<LevelKind, number> = {
  callWall: 25,
  putWall: 25,
  zeroGamma: 20,
  dominantMag: 30,
  upsidePivot: 40,
  downsidePivot: 40,
  mopexMaxPain: 25,
  extremeVac: 50,
  vommaPocket: 40,
};

interface Bar { date: string; t: number; o: number; h: number; l: number; c: number; }

async function yFetch(url: string, timeoutMs = 20_000): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function toYmd(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  // Use UTC for Yahoo timestamps (they're already normalized to trade-date UTC)
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// TODO: Schwab-only mode — Yahoo source removed, using Schwab getPriceHistory.
async function fetchDailyBars(symbol: string, years: number): Promise<Bar[]> {
  try {
    const { getPriceHistory } = await import("./schwab");
    const schwabSymMap: Record<string, string> = {
      "^GSPC": "$SPX.X", "^SPX": "$SPX.X", "^VIX": "$VIX.X",
      "SPY": "SPY", "QQQ": "QQQ",
    };
    const schwabSym = schwabSymMap[symbol] ?? symbol;
    const period = Math.min(years, 10);
    const resp = await getPriceHistory(schwabSym, "year", period, "daily", 1);
    return resp.candles
      .filter((c) => c.open != null && c.close != null && c.open > 0 && c.close > 0)
      .map((c) => ({
        date: toYmd(Math.floor(c.datetime / 1000)),
        t: Math.floor(c.datetime / 1000),
        o: c.open, h: c.high, l: c.low, c: c.close,
      }));
  } catch {
    return [];
  }
}

// ---- indicator helpers ----

function rollingAtr(bars: Bar[], period: number): number[] {
  // True Range
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { tr.push(bars[i].h - bars[i].l); continue; }
    const prev = bars[i - 1].c;
    tr.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prev),
      Math.abs(bars[i].l - prev)
    ));
  }
  // SMA of TR (classic Wilder is EMA, SMA is close enough for proxy + simpler)
  const out: number[] = new Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rollingEma(series: number[], period: number): number[] {
  const alpha = 2 / (period + 1);
  const out: number[] = new Array(series.length).fill(NaN);
  let ema = NaN;
  for (let i = 0; i < series.length; i++) {
    if (isNaN(ema)) {
      if (i >= period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += series[j];
        ema = sum / period;
        out[i] = ema;
      }
    } else {
      ema = series[i] * alpha + ema * (1 - alpha);
      out[i] = ema;
    }
  }
  return out;
}

function realizedVol(bars: Bar[], period: number): number[] {
  // Annualized σ of log returns over trailing `period` bars
  const logs: number[] = new Array(bars.length).fill(NaN);
  for (let i = 1; i < bars.length; i++) logs[i] = Math.log(bars[i].c / bars[i - 1].c);
  const out: number[] = new Array(bars.length).fill(NaN);
  for (let i = period; i < bars.length; i++) {
    const slice = logs.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    out[i] = Math.sqrt(variance * 252);
  }
  return out;
}

// ---- level proxies for a given date D ----

interface DateLevels {
  close: number;
  callWall: number;
  putWall: number;
  zeroGamma: number;
  dominantMag: number;
  upsidePivot: Record<BacktestHorizon, number>;
  downsidePivot: Record<BacktestHorizon, number>;
  mopexMaxPain: number;
  extremeVac: { up: number; dn: number };
  vommaPocket: { up: number; dn: number };
}

function computeLevels(
  idx: number,
  bars: Bar[],
  atr20: number[],
  ema20: number[],
  vix: number,      // vix close at date
  rv20: number[],   // realized vol array
): DateLevels | null {
  const c = bars[idx].c;
  const a = atr20[idx];
  const e = ema20[idx];
  const rv = rv20[idx];
  if (!isFinite(a) || !isFinite(e) || !isFinite(rv) || !isFinite(vix)) return null;

  const volMult = vix / 20;                  // vol regime multiplier
  const sigmaDaily = rv / Math.sqrt(252);    // daily σ as fraction
  const k1 = 1.5;                            // walls: 1.5 ATR at VIX=20
  const k2 = 1.15;                           // pivots: ~1.15 σ band (matches spec scenarios)

  const callWall = c + k1 * a * volMult;
  const putWall  = c - k1 * a * volMult;
  const domUp = callWall - c, domDn = c - putWall;
  const dominantMag = domUp >= domDn ? callWall : putWall;

  const upsidePivot: Record<BacktestHorizon, number> = {} as any;
  const downsidePivot: Record<BacktestHorizon, number> = {} as any;
  (Object.keys(HORIZON_DAYS) as BacktestHorizon[]).forEach(h => {
    const dte = HORIZON_DAYS[h];
    const band = c * sigmaDaily * Math.sqrt(dte) * k2;
    upsidePivot[h] = c + band;
    const unclamped = c - band;
    const floor = c * (1 - MAX_DROP_PCT[h]);
    downsidePivot[h] = Math.max(unclamped, floor);
  });

  // Max-pain proxy: nearest 25-point cluster (SPX) or 5-point (lower priced)
  const step = c >= 1000 ? 25 : 5;
  const mopexMaxPain = Math.round(c / step) * step;

  const extremeVac = {
    up: c + 2 * c * sigmaDaily * Math.sqrt(HORIZON_DAYS.weekly),
    dn: c - 2 * c * sigmaDaily * Math.sqrt(HORIZON_DAYS.weekly),
  };
  const vommaPocket = {
    up: c + 1.5 * c * sigmaDaily * Math.sqrt(HORIZON_DAYS.weekly),
    dn: c - 1.5 * c * sigmaDaily * Math.sqrt(HORIZON_DAYS.weekly),
  };

  return { close: c, callWall, putWall, zeroGamma: e, dominantMag,
           upsidePivot, downsidePivot, mopexMaxPain, extremeVac, vommaPocket };
}

// ---- forward-walk scoring ----

interface Observation {
  date: string;
  horizon: BacktestHorizon;
  levelKind: LevelKind;
  predictedPrice: number;
  realizedClose: number;
  realizedHigh: number;
  realizedLow: number;
  touched: number;
  held: number;
  absDistBps: number;
  breachBeyondPct: number;
}

function scoreLevel(
  date: string,
  horizon: BacktestHorizon,
  kind: LevelKind,
  predicted: number,
  startClose: number,
  forwardBars: Bar[],
): Observation | null {
  if (forwardBars.length === 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of forwardBars) {
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
  }
  const endClose = forwardBars[forwardBars.length - 1].c;

  const tolBps = TOUCH_BPS[kind];
  const tol = (tolBps / 10000) * predicted;
  const touched = (lo <= predicted + tol && hi >= predicted - tol) ? 1 : 0;

  // Held: touched AND reversed ≥50% of the initial distance (startClose→predicted) back
  let held = 0;
  if (touched) {
    const initDist = Math.abs(predicted - startClose);
    const reversalTarget = predicted > startClose
      ? predicted - 0.5 * initDist   // resistance: price should fall back to halfway
      : predicted + 0.5 * initDist;  // support:   price should rise back to halfway
    if (predicted > startClose) {
      // after touching resistance, did any subsequent low come back down?
      let touchedIdx = -1;
      for (let i = 0; i < forwardBars.length; i++) if (forwardBars[i].h >= predicted - tol) { touchedIdx = i; break; }
      if (touchedIdx >= 0) {
        for (let j = touchedIdx; j < forwardBars.length; j++) if (forwardBars[j].l <= reversalTarget) { held = 1; break; }
      }
    } else {
      let touchedIdx = -1;
      for (let i = 0; i < forwardBars.length; i++) if (forwardBars[i].l <= predicted + tol) { touchedIdx = i; break; }
      if (touchedIdx >= 0) {
        for (let j = touchedIdx; j < forwardBars.length; j++) if (forwardBars[j].h >= reversalTarget) { held = 1; break; }
      }
    }
  }

  const absDistBps = Math.abs(endClose - predicted) / predicted * 10000;
  const breachBeyondPct = (predicted > startClose ? hi > predicted * 1.01 : lo < predicted * 0.99) ? 1 : 0;

  return {
    date, horizon, levelKind: kind,
    predictedPrice: predicted,
    realizedClose: endClose,
    realizedHigh: hi,
    realizedLow: lo,
    touched, held, absDistBps, breachBeyondPct,
  };
}

// ---- aggregation ----

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- main entrypoint ----

let runningBackfill = false;

export async function runBackfill(yearsLookback = 5): Promise<{
  status: string;
  datesProcessed: number;
  observations: number;
  aggregates: number;
}> {
  if (runningBackfill) return { status: "already-running", datesProcessed: 0, observations: 0, aggregates: 0 };
  runningBackfill = true;
  try {
    // 1. Fetch price history — SPX (^GSPC) for levels, ^VIX for vol regime
    const [spx, vix] = await Promise.all([
      fetchDailyBars("^GSPC", yearsLookback),
      fetchDailyBars("^VIX",  yearsLookback),
    ]);
    if (spx.length < 100) throw new Error(`SPX history too short: ${spx.length} bars`);

    // Align VIX to SPX by date
    const vixByDate = new Map(vix.map(b => [b.date, b.c]));

    // 2. Precompute indicators
    const atr20  = rollingAtr(spx, 20);
    const closes = spx.map(b => b.c);
    const ema20  = rollingEma(closes, 20);
    const rv20   = realizedVol(spx, 20);

    // 3. Walk each date, compute proxy levels, score forward
    const observations: Observation[] = [];
    const maxHorizon = HORIZON_DAYS.quarterly;

    for (let i = 30; i < spx.length - maxHorizon; i++) {
      const date = spx[i].date;
      const vixClose = vixByDate.get(date);
      if (vixClose == null) continue;

      const lv = computeLevels(i, spx, atr20, ema20, vixClose, rv20);
      if (!lv) continue;

      // For each horizon, score every level
      (Object.keys(HORIZON_DAYS) as BacktestHorizon[]).forEach(h => {
        const fwd = spx.slice(i + 1, i + 1 + HORIZON_DAYS[h]);
        if (fwd.length === 0) return;

        const pushObs = (kind: LevelKind, pred: number) => {
          const o = scoreLevel(date, h, kind, pred, lv.close, fwd);
          if (o) observations.push(o);
        };

        pushObs("callWall",      lv.callWall);
        pushObs("putWall",       lv.putWall);
        pushObs("zeroGamma",     lv.zeroGamma);
        pushObs("dominantMag",   lv.dominantMag);
        pushObs("upsidePivot",   lv.upsidePivot[h]);
        pushObs("downsidePivot", lv.downsidePivot[h]);
        pushObs("mopexMaxPain",  lv.mopexMaxPain);
        // extremeVac / vommaPocket: score the nearer side to spot
        pushObs("extremeVac",    lv.extremeVac.dn);  // downside vacuum tested more
        pushObs("vommaPocket",   lv.vommaPocket.dn);
      });
    }

    // 4. Wipe + insert observations
    db.delete(backtestObservations).run();
    // SQLite has a parameter limit (~32k). Chunk inserts.
    const CHUNK = 500;
    for (let i = 0; i < observations.length; i += CHUNK) {
      db.insert(backtestObservations).values(observations.slice(i, i + CHUNK)).run();
    }

    // 5. Aggregate → backtest_levels
    db.delete(backtestLevels).run();
    const now = Math.floor(Date.now() / 1000);
    const agg = new Map<string, Observation[]>();
    for (const o of observations) {
      const k = `${o.horizon}|${o.levelKind}`;
      if (!agg.has(k)) agg.set(k, []);
      agg.get(k)!.push(o);
    }
    let aggCount = 0;
    for (const [k, arr] of agg) {
      const [horizon, levelKind] = k.split("|") as [BacktestHorizon, LevelKind];
      const n = arr.length;
      const touchRate = arr.reduce((a, b) => a + b.touched, 0) / n;
      const holdRate  = arr.reduce((a, b) => a + b.held, 0) / n;
      const avgAbsDist = arr.reduce((a, b) => a + b.absDistBps, 0) / n;
      const medAbsDist = median(arr.map(a => a.absDistBps));
      const breachPct  = arr.reduce((a, b) => a + b.breachBeyondPct, 0) / n;
      db.insert(backtestLevels).values({
        horizon, levelKind, sampleSize: n,
        touchRate, holdRate,
        avgAbsDistBps: avgAbsDist,
        medianAbsDistBps: medAbsDist,
        breachBeyondPct: breachPct,
        computedAt: now,
        methodology: METHODOLOGY,
      }).run();
      aggCount++;
    }

    return {
      status: "ok",
      datesProcessed: spx.length - 30 - maxHorizon,
      observations: observations.length,
      aggregates: aggCount,
    };
  } finally {
    runningBackfill = false;
  }
}

export interface BacktestSummary {
  methodology: string;
  computedAt: number | null;
  byLevel: Record<string, {
    horizon: BacktestHorizon;
    levelKind: LevelKind;
    sampleSize: number;
    touchRate: number;
    holdRate: number;
    avgAbsDistBps: number;
    medianAbsDistBps: number;
    breachBeyondPct: number;
  }>;
}

export function getBacktestSummary(): BacktestSummary {
  const rows = db.select().from(backtestLevels).all();
  const byLevel: BacktestSummary["byLevel"] = {};
  let maxComputed = 0;
  for (const r of rows) {
    const key = `${r.horizon}|${r.levelKind}`;
    byLevel[key] = {
      horizon: r.horizon as BacktestHorizon,
      levelKind: r.levelKind as LevelKind,
      sampleSize: r.sampleSize,
      touchRate: r.touchRate,
      holdRate: r.holdRate,
      avgAbsDistBps: r.avgAbsDistBps,
      medianAbsDistBps: r.medianAbsDistBps,
      breachBeyondPct: r.breachBeyondPct,
    };
    if (r.computedAt > maxComputed) maxComputed = r.computedAt;
  }
  return {
    methodology: METHODOLOGY,
    computedAt: maxComputed || null,
    byLevel,
  };
}
