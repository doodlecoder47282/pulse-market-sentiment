// server/mlGreekFeatures.ts
//
// Greek-aware feature builder for the ML quantile overlay (Model B).
//
// Pulls live state from:
//   - buildGammaLevelsEnhanced output (computed + user-target dealer levels)
//   - fetchOHLC("^SPX", "1D", "5m")     (today's 5min RTH bars)
//   - snapshot helpers (VIX, prev VIX, etc.)
//
// Honest disclosure (also referenced in train_quantile_impl.py and the UI):
//   the historical training set does NOT carry per-bar real Greek snapshots.
//   The trainer SYNTHESIZES plausible distance-to-level features. So the model
//   has learned to USE these signals (sign of net GEX, distance to nearest wall
//   in ATR units, regime ordinals), but the absolute calibration of those
//   distances at production time will be approximate. As live Greek snapshots
//   accumulate per bar, this module is the place to swap synthetic for real.
//
// All returned values are guaranteed finite numbers (NaN/null/undefined → 0).
// Result is cached for 30s to keep DB / chain pulls reasonable.

import type { GammaLevelsEnhanced } from "./gammaLevels";
import { fetchOHLC } from "./ohlc";

// ─── Cache ──────────────────────────────────────────────────────────────────

let CACHE: { at: number; data: Record<string, number> } | null = null;
const CACHE_MS = 30_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function _safe(n: any): number {
  if (n == null) return 0;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v;
}

function _logRet(a: number, b: number): number {
  if (!a || !b || a <= 0 || b <= 0) return 0;
  return Math.log(b / a);
}

function _stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}

function _mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function _atrFromBars(bars: { h: number; l: number; c: number }[], lookback: number): number {
  if (bars.length < 2) return 0;
  const slice = bars.slice(-lookback);
  if (slice.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].h - slice[i].l,
      Math.abs(slice[i].h - slice[i - 1].c),
      Math.abs(slice[i].l - slice[i - 1].c),
    );
    if (Number.isFinite(tr)) {
      sum += tr;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

// ─── Feature builder ────────────────────────────────────────────────────────

export interface MlFeatureInputs {
  /** GammaLevelsEnhanced object (already built by caller). */
  levels: GammaLevelsEnhanced | null;
  /** Current SPX spot. */
  spxNow: number | null;
  /** Current VIX value. */
  vix: number | null;
  /** Previous-session VIX close (for intraday change pct). */
  vixPrev: number | null;
}

/**
 * Build feature dict from injected inputs. All values numeric & finite.
 * Pulls today's SPX 5min bars internally for vol / ATR / trend features.
 */
export async function buildMlFeaturesFromInputs(
  inputs: MlFeatureInputs,
): Promise<Record<string, number>> {
  const { levels, vix, vixPrev } = inputs;
  let { spxNow } = inputs;

  // Pull today's 5min SPX bars (cached upstream by /api/ohlc cache).
  let bars: { t: number; o: number; h: number; l: number; c: number; v: number | null }[] = [];
  try {
    const ohlc = await fetchOHLC("^SPX", "1D", "5m");
    bars = ohlc?.candles ?? [];
    if (spxNow == null && ohlc?.price != null) spxNow = ohlc.price;
  } catch {
    bars = [];
  }

  const spot = _safe(spxNow ?? bars[bars.length - 1]?.c ?? 0);

  // ── Time features (ET, but we use raw NY-local hour from the bar timestamp) ──
  const now = new Date();
  // Use America/New_York wall clock via Intl
  const nyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of nyParts) partMap[p.type] = p.value;
  const hourEt = Number(partMap.hour ?? "12");
  const minEt = Number(partMap.minute ?? "0");
  const dowMap: Record<string, number> = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 };
  const dow = dowMap[partMap.weekday ?? "Wed"] ?? 2;
  const fracHour = hourEt + minEt / 60;
  const isFirst30 = fracHour >= 9.5 && fracHour < 10.0 ? 1 : 0;
  const isPostLunch = fracHour >= 13.0 && fracHour < 15.5 ? 1 : 0;
  const isLast30 = fracHour >= 15.5 && fracHour < 16.0 ? 1 : 0;

  // ── Vol / ATR / trend over recent bars ───────────────────────────────────
  // 5-minute log returns
  const logRets: number[] = [];
  for (let i = 1; i < bars.length; i++) logRets.push(_logRet(bars[i - 1].c, bars[i].c));

  // Last 30min = 6 bars; last 5min = 1 bar (just last log return)
  const last6 = logRets.slice(-6);
  const last1 = logRets.slice(-1);

  // Annualization factor for intraday RTH: 78 5min bars/day × 252 days
  const ANN = Math.sqrt(78 * 252);
  const realizedVol30m = _stdev(last6) * ANN;
  const realizedVol5m = _stdev(last1.length > 0 ? last1 : [0]) * ANN;
  const trend30m = _mean(last6);
  const trend5m = _mean(last1);
  const atr5m = _atrFromBars(bars, 6);
  const atr30m = _atrFromBars(bars, 6); // 30min window approx

  // Use ATR_30m as denominator for distance features. Floor at small value.
  const atrDen = atr30m > 0.5 ? atr30m : Math.max(1, spot * 0.001);

  // ── Greek levels (with safe nullish defaults) ────────────────────────────
  const callWall = _safe(levels?.callWall?.value);
  const putWall = _safe(levels?.putWall?.value);
  const flip = _safe(levels?.gammaFlip?.value ?? spot); // fall back to spot
  const maxPain = _safe(levels?.mopex?.value);
  const zomma = _safe(levels?.zomma?.value);
  const upVomma = _safe(levels?.vommaUpper?.value);
  const dnVomma = _safe(levels?.vommaLower?.value);
  const vannaLvl = _safe(levels?.vanna?.value);
  const charmLvl = _safe(levels?.charm?.value);

  const distAtr = (lvl: number) => (lvl > 0 ? (lvl - spot) / atrDen : 0);

  const distCall = distAtr(callWall);
  const distPut = distAtr(putWall);
  const distFlip = distAtr(flip);
  const distMaxPain = distAtr(maxPain);
  const distZomma = distAtr(zomma);
  const distUpVomma = distAtr(upVomma);
  const distDnVomma = distAtr(dnVomma);
  const distVanna = distAtr(vannaLvl);
  const distCharm = distAtr(charmLvl);

  // Net GEX sign: +1 above flip (positive gamma regime), -1 below, 0 if no flip
  let netGexSign = 0;
  if (flip > 0 && spot > 0) {
    if (spot > flip) netGexSign = 1;
    else if (spot < flip) netGexSign = -1;
  }

  // GEX magnitude — sum of |gex| across top strikes, normalized by 1e9
  let netGexMag = 0;
  const topGex = levels?.topGexStrikes ?? [];
  for (const s of topGex) netGexMag += Math.abs(_safe(s.gex));
  netGexMag = netGexMag / 1e9;

  // VIX features
  const vixLevel = _safe(vix);
  const vixPrevSafe = _safe(vixPrev);
  const vixChangePct =
    vixPrevSafe > 0 && vixLevel > 0 ? (vixLevel - vixPrevSafe) / vixPrevSafe : 0;

  // ── Legacy v2 feature names (so v2 model can still consume the dict) ─────
  // The v2 model expects: hour_of_day, minute_of_hour, day_of_week,
  // gex_regime_ord, net_gex_b, realized_vol_5min, realized_vol_30min,
  // bar_return_1min, momentum_15min, distance_from_open_pct,
  // is_post_lunch, is_first_30min, is_last_30min.
  const openPrice = bars[0]?.o ?? spot;
  const distFromOpen = openPrice > 0 ? (spot - openPrice) / openPrice : 0;
  const momentum15 = logRets.slice(-3).reduce((s, x) => s + x, 0); // 3 × 5m = 15m
  const barReturn1 = logRets.slice(-1)[0] ?? 0;
  // ordinal-style regime: -1 / 0 / 1 mapping
  const gexRegimeOrd = netGexSign;
  const netGexB = netGexMag; // already normalized to ~bn scale
  // Keep these in the un-annualized stdev form the v2 model was trained on
  const rv5Raw = _stdev(last1.length > 0 ? last1 : [0]);
  const rv30Raw = _stdev(last6);

  const out: Record<string, number> = {
    // ── Time ──
    hour_of_day: fracHour,
    minute_of_hour: minEt,
    day_of_week: dow,
    is_first_30min: isFirst30,
    is_post_lunch: isPostLunch,
    is_last_30min: isLast30,

    // ── Spot + macro ──
    spx_spot: spot,
    vix_level: vixLevel,
    vix_change_pct: vixChangePct,

    // ── Vol / ATR / trend ──
    realized_vol_30m: realizedVol30m,
    realized_vol_5m: realizedVol5m,
    atr_5m: atr5m,
    trend_30m: trend30m,
    trend_5m: trend5m,

    // ── Distance-to-level (in ATR units) ──
    dist_to_callwall_atr: distCall,
    dist_to_putwall_atr: distPut,
    dist_to_flip_atr: distFlip,
    dist_to_maxpain_atr: distMaxPain,
    dist_to_zomma_atr: distZomma,
    dist_to_upvomma_atr: distUpVomma,
    dist_to_dnvomma_atr: distDnVomma,
    vanna_level_dist_atr: distVanna,
    charm_level_dist_atr: distCharm,

    // ── Regime ──
    net_gex_sign: netGexSign,
    net_gex_magnitude: netGexMag,

    // ── Legacy v2 names (also acceptable by v2 model) ──
    realized_vol_5min: rv5Raw,
    realized_vol_30min: rv30Raw,
    bar_return_1min: barReturn1,
    momentum_15min: momentum15,
    distance_from_open_pct: distFromOpen,
    gex_regime_ord: gexRegimeOrd,
    net_gex_b: netGexB,
    vix_pct_of_5d_avg: 1.0, // unknown in this fast path; safe default
  };

  // Final NaN sweep
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (!Number.isFinite(v)) out[k] = 0;
  }
  return out;
}

/**
 * Cached wrapper. Caller injects level/snapshot accessor to avoid circular imports.
 */
export async function buildMlFeatures(
  resolveInputs: () => Promise<MlFeatureInputs>,
): Promise<Record<string, number>> {
  if (CACHE && Date.now() - CACHE.at < CACHE_MS) return CACHE.data;
  const inputs = await resolveInputs();
  const data = await buildMlFeaturesFromInputs(inputs);
  CACHE = { at: Date.now(), data };
  return data;
}

export function _resetMlFeaturesCache() {
  CACHE = null;
}
