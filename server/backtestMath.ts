// server/backtestMath.ts
//
// Pure scoring for the volatility-band level backtest (backtest.ts), so it
// can be tested on plain Node. Round-2 item 6 (review 8.4).
//
// ONE touch rule for every level kind, real or baseline:
//   touched  <=> the horizon's [low, high] comes within tol of the level,
//   tol      =  TOUCH_TOL_ATR_FRACTION x ATR20 at the forecast date (points).
// The old table gave each kind its own band (20-50 bps; baselines 30), so a
// wide-band kind could "beat" the baselines through its tolerance alone.
// Osler (2000) scores published support/resistance levels and random
// artificial levels with the SAME hit criterion and compares them
// (C. Osler, "Support for Resistance: Technical Analysis and Intraday
// Exchange Rates", FRBNY Economic Policy Review 6(2):53-68,
// https://www.newyorkfed.org/medialibrary/media/research/epr/00v06n2/0007osle.html).
// Her intraday band is a fixed 0.01% of price; on daily bars over 1-63 days
// the band has to scale with volatility or calm and wild regimes are not
// comparable, so it is a fraction of the 20-day average true range (Wilder
// 1978), known at the forecast date (no look-ahead). 0.25 ATR is ~25 bps at
// a typical 1% SPX daily range: the middle of the old 20-50 bps table, now
// vol-scaled and identical for every level kind.
//
// Overlapping windows: forecasts made every trading day with 5-63 day
// horizons share most of their forward bars, so pooled counts overstate the
// independent evidence. nonOverlappingStats keeps every Nth forecast date per
// horizon (N = horizon in trading days), the counts the overlay shows, with
// Wilson 95% intervals (validationMath.wilsonInterval).

import { wilsonInterval } from "./validationMath";

export const TOUCH_TOL_ATR_FRACTION = 0.25;
export const TOUCH_RULE = `touched = the horizon's range came within ${TOUCH_TOL_ATR_FRACTION} x ATR20 (at the forecast date) of the level; same rule for every level and baseline`;

export interface DailyBar { date: string; h: number; l: number; c: number }

/** Touch tolerance in index points; null when ATR is unknown (the observation is not scored). */
export function touchTolerancePts(atr: number): number | null {
  return Number.isFinite(atr) && atr > 0 ? TOUCH_TOL_ATR_FRACTION * atr : null;
}

export interface LevelObservation {
  date: string;
  horizon: string;
  levelKind: string;
  predictedPrice: number;
  realizedClose: number;
  realizedHigh: number;
  realizedLow: number;
  touched: number;
  held: number;
  absDistBps: number;
  breachBeyondPct: number;
}

/**
 * Score one level over its forward bars [D+1, D+H].
 * held = touched AND then reversed by max(0.5 x initial distance, 0.5 x ATR)
 * back toward where price started. breach = more than 1% past the level.
 */
export function scoreLevelObservation(
  date: string, horizon: string, kind: string, predicted: number, startClose: number, forwardBars: DailyBar[], atr: number,
): LevelObservation | null {
  if (forwardBars.length === 0 || !(predicted > 0)) return null;
  const tol = touchTolerancePts(atr);
  if (tol == null) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of forwardBars) {
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
  }
  const endClose = forwardBars[forwardBars.length - 1].c;
  const touched = (lo <= predicted + tol && hi >= predicted - tol) ? 1 : 0;

  let held = 0;
  if (touched) {
    const initDist = Math.abs(predicted - startClose);
    const revDist = Math.max(0.5 * initDist, 0.5 * atr);
    const resistance = predicted > startClose;
    const reversalTarget = resistance ? predicted - revDist : predicted + revDist;
    let touchedIdx = -1;
    for (let i = 0; i < forwardBars.length; i++) {
      if (resistance ? forwardBars[i].h >= predicted - tol : forwardBars[i].l <= predicted + tol) { touchedIdx = i; break; }
    }
    if (touchedIdx >= 0) {
      for (let j = touchedIdx; j < forwardBars.length; j++) {
        if (resistance ? forwardBars[j].l <= reversalTarget : forwardBars[j].h >= reversalTarget) { held = 1; break; }
      }
    }
  }
  const absDistBps = Math.abs(endClose - predicted) / predicted * 10000;
  const breachBeyondPct = (predicted > startClose ? hi > predicted * 1.01 : lo < predicted * 0.99) ? 1 : 0;
  return { date, horizon, levelKind: kind, predictedPrice: predicted, realizedClose: endClose, realizedHigh: hi, realizedLow: lo, touched, held, absDistBps, breachBeyondPct };
}

export interface NonOverlapStats {
  n: number;
  touchRate: number | null;
  touchWilsonLo: number | null;
  touchWilsonHi: number | null;
  holdRate: number | null;
  holdWilsonLo: number | null;
  holdWilsonHi: number | null;
  medianAbsDistBps: number | null;
}

/**
 * Forecast dates kept so no two forward windows overlap: every `stride`-th
 * distinct date in order (stride = horizon in trading days). Scored dates are
 * consecutive trading days or have holes (a missing VIX close), and a hole
 * only widens the spacing, so kept windows never share a bar.
 */
export function nonOverlappingDates(dates: string[], stride: number): Set<string> {
  const sorted = Array.from(new Set(dates)).sort();
  const s = Math.max(1, Math.floor(stride));
  return new Set(sorted.filter((_, i) => i % s === 0));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Touch / hold rates with Wilson 95% intervals on the non-overlapping subset of one (horizon, kind). */
export function nonOverlappingStats(obs: Array<{ date: string; touched: number; held: number; absDistBps: number }>, kept: Set<string>): NonOverlapStats {
  const xs = obs.filter((o) => kept.has(o.date));
  const n = xs.length;
  if (n === 0) return { n: 0, touchRate: null, touchWilsonLo: null, touchWilsonHi: null, holdRate: null, holdWilsonLo: null, holdWilsonHi: null, medianAbsDistBps: null };
  const t = xs.reduce((s, o) => s + (o.touched ? 1 : 0), 0);
  const h = xs.reduce((s, o) => s + (o.held ? 1 : 0), 0);
  const wt = wilsonInterval(t, n), wh = wilsonInterval(h, n);
  return {
    n, touchRate: t / n, touchWilsonLo: wt.lo, touchWilsonHi: wt.hi,
    holdRate: h / n, holdWilsonLo: wh.lo, holdWilsonHi: wh.hi,
    medianAbsDistBps: median(xs.map((o) => o.absDistBps)),
  };
}

/** What the volatility-band backtest can and cannot claim (round-2 item 9). */
export const DEALER_LEVEL_DATA_STATE = {
  dataState: "proxy_no_options_data" as const,
  dealerLevelsTested: false,
  blockedOn: "historical option chains (open interest and greeks per strike per day: ORATS, Polygon flat files or Cboe DataShop); none connected, none bought without the owner's approval",
};
