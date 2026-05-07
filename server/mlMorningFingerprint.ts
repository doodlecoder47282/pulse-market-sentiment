// server/mlMorningFingerprint.ts
//
// Morning fingerprint feature builder for Model D (Morning Anchor).
// Layered on top of the v3 feature dict produced by mlGreekFeatures.
//
// Computes the 9 frozen + live morning-relative features:
//   morn_orb_range_atr, morn_orb_hi_pct, morn_orb_lo_pct,
//   morn_open_drive_atr, morn_opening_vol_z, morn_gap_atr, morn_vwap_dev_atr,
//   bars_since_anchor, spot_vs_anchor_atr
//
// Anchor bar = 9:45 ET (after the first 15 minutes). When called before 9:45
// or with insufficient bars, returns { ready: false, ... } and the route falls
// back to v3-only projection.

import { fetchOHLC } from "./ohlc";

const ANCHOR_MIN_FROM_OPEN = 15; // 9:30 + 15 = 9:45 ET
const RTH_OPEN_MIN = 570; // 9:30 ET
const RTH_CLOSE_MIN = 960; // 16:00 ET

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface MorningFingerprintResult {
  ready: boolean;
  reason?: string;
  // Frozen features (set once at 9:45 ET)
  morn_orb_range_atr: number;
  morn_orb_hi_pct: number;
  morn_orb_lo_pct: number;
  morn_open_drive_atr: number;
  morn_opening_vol_z: number;
  morn_gap_atr: number;
  morn_vwap_dev_atr: number;
  // Live features
  bars_since_anchor: number;
  spot_vs_anchor_atr: number;
  // Diagnostics
  anchor_close: number | null;
  anchor_time_et: string | null;
}

function _etMinutesNow(): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mn = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + mn;
}

function _safe(n: any): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function _stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}

const EMPTY: MorningFingerprintResult = {
  ready: false,
  morn_orb_range_atr: 0,
  morn_orb_hi_pct: 0,
  morn_orb_lo_pct: 0,
  morn_open_drive_atr: 0,
  morn_opening_vol_z: 0,
  morn_gap_atr: 0,
  morn_vwap_dev_atr: 0,
  bars_since_anchor: 0,
  spot_vs_anchor_atr: 0,
  anchor_close: null,
  anchor_time_et: null,
};

/**
 * Build the morning fingerprint from today's SPY 5min RTH bars.
 * symbol: "SPY" for the SPY-scale projector; "^SPX" for the SPX-scale path.
 * prevClose: previous session close (for gap feature)
 * atrUnit: ATR-like denominator in points; we use atr5m * sqrt(78) ≈ daily.
 *          When called from the route, prefer to pass atr5m directly.
 */
export async function buildMorningFingerprint(opts: {
  symbol: string;
  prevClose: number | null;
  atr5m: number; // 5-minute ATR (in price points), used as ATR denominator
  spot: number;
}): Promise<MorningFingerprintResult> {
  const { symbol, prevClose, atr5m, spot } = opts;

  // Pre-9:45 ET: not ready
  const etMin = _etMinutesNow();
  if (etMin < RTH_OPEN_MIN + ANCHOR_MIN_FROM_OPEN) {
    return { ...EMPTY, reason: "pre_anchor" };
  }

  // Need at least 3 5min bars (15 min) of today's tape
  let bars: Bar[] = [];
  try {
    const ohlc = await fetchOHLC(symbol, "1D", "5m");
    bars = (ohlc?.candles ?? []) as Bar[];
  } catch {
    bars = [];
  }
  if (bars.length < 3) {
    return { ...EMPTY, reason: "insufficient_bars" };
  }

  // First 3 5-min bars = 9:30, 9:35, 9:40 (closes at 9:45)
  const morning = bars.slice(0, 3);
  const openPrice = morning[0].o;
  const anchorClose = morning[morning.length - 1].c;

  // ATR denominator with floor
  const atrDen = atr5m > 0.5 ? atr5m : Math.max(1, spot * 0.001);
  // Use a "daily-ish" ATR for the gap and ORB-range features to match training.
  // Approximate: sqrt(78) * 5m ATR ≈ daily ATR.
  const dailyAtr = atrDen * Math.sqrt(78);

  // ORB high / low across the 3 bars
  const orbHi = Math.max(morning[0].h, morning[1].h, morning[2].h);
  const orbLo = Math.min(morning[0].l, morning[1].l, morning[2].l);
  const orbRange = orbHi - orbLo;
  const orbHiPct = openPrice > 0 ? ((orbHi - openPrice) / openPrice) * 100 : 0;
  const orbLoPct = openPrice > 0 ? ((orbLo - openPrice) / openPrice) * 100 : 0;

  // Opening drive (9:30 -> 9:45)
  const drive = anchorClose - openPrice;

  // Opening vol z-score: morning vol vs full-day-so-far vol baseline
  // We use return stdev (5min log returns) ratio.
  const morningRets: number[] = [];
  for (let i = 1; i < morning.length; i++) {
    if (morning[i - 1].c > 0 && morning[i].c > 0) {
      morningRets.push(Math.log(morning[i].c / morning[i - 1].c));
    }
  }
  const allRets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0 && bars[i].c > 0) {
      allRets.push(Math.log(bars[i].c / bars[i - 1].c));
    }
  }
  const morningRv = _stdev(morningRets);
  const fullRv = _stdev(allRets);
  const openingVolZ =
    fullRv > 1e-9 ? (morningRv / fullRv) - 1.0 : 0.0;

  // Gap from prior close
  const prevC = _safe(prevClose);
  const gap = prevC > 0 ? openPrice - prevC : 0;

  // VWAP of first 3 bars (using close as proxy for typical price)
  const vwap = (morning[0].c + morning[1].c + morning[2].c) / 3;
  const vwapDev = anchorClose - vwap;

  // Live features (depend on current spot)
  const spotVsAnchor = atrDen > 0 ? (spot - anchorClose) / atrDen : 0;

  // bars_since_anchor: number of 5min bars since 9:45 ET (anchor)
  // anchor is at end of bar idx 2; current bar idx = bars.length - 1
  const barsSinceAnchor = Math.max(0, bars.length - 3);

  return {
    ready: true,
    morn_orb_range_atr: dailyAtr > 0 ? orbRange / dailyAtr : 0,
    morn_orb_hi_pct: orbHiPct,
    morn_orb_lo_pct: orbLoPct,
    morn_open_drive_atr: dailyAtr > 0 ? drive / dailyAtr : 0,
    morn_opening_vol_z: Math.max(-3, Math.min(3, openingVolZ)),
    morn_gap_atr: dailyAtr > 0 ? gap / dailyAtr : 0,
    morn_vwap_dev_atr: dailyAtr > 0 ? vwapDev / dailyAtr : 0,
    bars_since_anchor: barsSinceAnchor,
    spot_vs_anchor_atr: spotVsAnchor,
    anchor_close: anchorClose,
    anchor_time_et: "09:45",
  };
}

/**
 * Compute a confidence weight for blending Model D vs v3.
 * Pre-9:45 ET: 0% (not ready).
 * 9:45-10:30 ET: ramp 0% -> 70% (peak weight after 45 min of post-anchor evolution).
 * 10:30-15:00 ET: hold near 70% (morning fingerprint still relevant).
 * 15:00-16:00 ET: decay 70% -> 30% (intraday dominant, morning faded).
 * Returns a number in [0, 0.7].
 */
export function computeMorningBlendWeight(): number {
  const etMin = _etMinutesNow();
  // Convert to fractional hour-of-day for clarity
  if (etMin < 585) return 0;            // pre-9:45 ET
  if (etMin < 630) {                     // 9:45 - 10:30 ramp
    return ((etMin - 585) / 45) * 0.7;
  }
  if (etMin < 900) return 0.7;           // 10:30 - 15:00 plateau
  if (etMin < 960) {                     // 15:00 - 16:00 decay
    return 0.7 * (1 - (etMin - 900) / 60) + 0.3 * ((etMin - 900) / 60);
  }
  return 0;                              // post-close
}

/**
 * Blend two quantile band sets. Output keys = union of horizons.
 * For overlapping horizons (e.g. 30, 60), returns w * morning + (1-w) * v3.
 * Non-overlapping morning-only horizons (120, 180, 240) pass through.
 */
export interface QBands { q10: number; q25: number; q50: number; q75: number; q90: number }

export function blendBands(
  v3: Record<string, QBands> | null,
  morning: Record<string, QBands> | null,
  weight: number,
): Record<string, QBands> {
  const out: Record<string, QBands> = {};
  if (v3) {
    for (const [k, b] of Object.entries(v3)) {
      out[k] = { ...b };
    }
  }
  if (!morning || weight <= 0) return out;
  for (const [k, mb] of Object.entries(morning)) {
    const v3b = out[k];
    if (v3b) {
      out[k] = {
        q10: weight * mb.q10 + (1 - weight) * v3b.q10,
        q25: weight * mb.q25 + (1 - weight) * v3b.q25,
        q50: weight * mb.q50 + (1 - weight) * v3b.q50,
        q75: weight * mb.q75 + (1 - weight) * v3b.q75,
        q90: weight * mb.q90 + (1 - weight) * v3b.q90,
      };
    } else {
      // Morning-only horizon (120/180/240) - pass through
      out[k] = { ...mb };
    }
  }
  return out;
}
