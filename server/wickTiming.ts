// server/wickTiming.ts
//
// Wire 14 — T_high/T_low timing inference from Schwab 1-min OHLC.
//
// Bloomberg OHLC paper signal (arXiv 2509.16137) without tick stream.
// Infer high/low formation order from open/close as bar endpoints:
//   H_EARLY = (high-open) < (high-close)*0.8 (rallied fast to high, then sold)
//   H_LATE  = (high-close) < (high-open)*0.8 (high set near close)
//   L_EARLY = (open-low) < (close-low)*0.8 (sold fast to low, then rallied)
//   L_LATE  = (close-low) < (open-low)*0.8 (low set near close)
//   20% tolerance for INDETERMINATE on either side.
//
// Direction inference:
//   H_EARLY + L_LATE = BEARISH (rally then sold to fresh low into close)
//   L_EARLY + H_LATE = BULLISH (flush then bought to fresh high into close)
//   All others       = INDETERMINATE
//
// Confluence with Wire 13 signed volume:
//   STRONG = inference matches signed-volume sign
//   WEAK   = inference opposes signed-volume sign
//
// Cache: 30 seconds.

import { getPriceHistory } from "./schwab.js";
import { computeOfiTrend } from "./leeReadyOfi.js";

export type WickTimingBar = {
  ts: number;
  open: number; high: number; low: number; close: number; volume: number;
  highTiming: "EARLY" | "LATE" | "INDETERMINATE";
  lowTiming: "EARLY" | "LATE" | "INDETERMINATE";
  inference: "BULLISH" | "BEARISH" | "INDETERMINATE";
  // Signed volume from Wire 13 (lookup by ts)
  signedVolume: number;
  // Confluence with Wire 13: STRONG when inference + signedVolume aligned, WEAK otherwise
  confluence: "STRONG_BULLISH" | "STRONG_BEARISH" | "WEAK_BULLISH" | "WEAK_BEARISH" | "NEUTRAL";
};

export type WickTimingTrend = {
  bars: WickTimingBar[];      // last N bars only (lite)
  last3Inference: "BULLISH" | "BEARISH" | "MIXED" | "INDETERMINATE";
  strongCount15m: number;     // how many STRONG bars in last 15 min
  strongDirection15m: "BULLISH" | "BEARISH" | "BALANCED";
};

const CACHE_MS = 30_000;
let cache: { ts: number; trend: WickTimingTrend } | null = null;

const NEUTRAL_TREND: WickTimingTrend = {
  bars: [],
  last3Inference: "INDETERMINATE",
  strongCount15m: 0,
  strongDirection15m: "BALANCED",
};

// Tolerance: distances within 20% of each other = INDETERMINATE
const TIMING_TOLERANCE = 0.20;

function classifyHighTiming(open: number, high: number, close: number): "EARLY" | "LATE" | "INDETERMINATE" {
  const distOpenToHigh = high - open;
  const distCloseToHigh = high - close;
  if (distOpenToHigh < 0 || distCloseToHigh < 0) return "INDETERMINATE"; // shouldn't happen but safety
  const total = distOpenToHigh + distCloseToHigh;
  if (total === 0) return "INDETERMINATE";
  // High set EARLY: distOpenToHigh small (rallied to high quickly), distCloseToHigh large (then sold off)
  // High set LATE: distOpenToHigh large (drifted up), distCloseToHigh small (still near high at close)
  if (distOpenToHigh < distCloseToHigh * (1 - TIMING_TOLERANCE)) return "EARLY";
  if (distCloseToHigh < distOpenToHigh * (1 - TIMING_TOLERANCE)) return "LATE";
  return "INDETERMINATE";
}

function classifyLowTiming(open: number, low: number, close: number): "EARLY" | "LATE" | "INDETERMINATE" {
  const distOpenToLow = open - low;
  const distCloseToLow = close - low;
  if (distOpenToLow < 0 || distCloseToLow < 0) return "INDETERMINATE";
  if (distOpenToLow + distCloseToLow === 0) return "INDETERMINATE";
  // Low set EARLY: distOpenToLow small (sold to low quickly), distCloseToLow large (then rallied)
  // Low set LATE: distOpenToLow large (drifted down), distCloseToLow small (still near low at close)
  if (distOpenToLow < distCloseToLow * (1 - TIMING_TOLERANCE)) return "EARLY";
  if (distCloseToLow < distOpenToLow * (1 - TIMING_TOLERANCE)) return "LATE";
  return "INDETERMINATE";
}

function inferDirection(highTiming: WickTimingBar["highTiming"], lowTiming: WickTimingBar["lowTiming"]): WickTimingBar["inference"] {
  // H_EARLY + L_LATE → bear (rallied to high, then sold to fresh low into close)
  if (highTiming === "EARLY" && lowTiming === "LATE") return "BEARISH";
  // L_EARLY + H_LATE → bull (sold to low, then rallied to fresh high into close)
  if (lowTiming === "EARLY" && highTiming === "LATE") return "BULLISH";
  // H_EARLY + L_EARLY (both spike early): indeterminate, opening flush
  // H_LATE + L_LATE (both spike late): indeterminate, closing chop
  // INDETERMINATE in either: indeterminate
  return "INDETERMINATE";
}

function classifyConfluence(inference: WickTimingBar["inference"], signedVolume: number): WickTimingBar["confluence"] {
  if (inference === "INDETERMINATE") return "NEUTRAL";
  if (inference === "BULLISH") {
    return signedVolume > 0 ? "STRONG_BULLISH" : "WEAK_BULLISH";
  }
  // BEARISH
  return signedVolume < 0 ? "STRONG_BEARISH" : "WEAK_BEARISH";
}

export async function computeWickTiming(): Promise<WickTimingTrend> {
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.trend;

  const history = await getPriceHistory("$SPX.X", "day", 1, "minute", 1);
  if (!history.candles || history.candles.length < 2) {
    cache = { ts: Date.now(), trend: NEUTRAL_TREND };
    return NEUTRAL_TREND;
  }

  // Get Wire 13 OFI to look up signed volumes by timestamp
  let ofiByTs = new Map<number, number>();
  try {
    const ofi = await computeOfiTrend();
    for (const b of ofi.bars) ofiByTs.set(b.ts, b.signedVolume);
  } catch { /* ofi unavailable, all signedVolume = 0 */ }

  const candles = history.candles;
  const bars: WickTimingBar[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const highTiming = classifyHighTiming(c.open, c.high, c.close);
    const lowTiming = classifyLowTiming(c.open, c.low, c.close);
    const inference = inferDirection(highTiming, lowTiming);
    const signedVolume = ofiByTs.get(c.datetime) ?? 0;
    const confluence = classifyConfluence(inference, signedVolume);
    bars.push({
      ts: c.datetime,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume || 0,
      highTiming, lowTiming, inference,
      signedVolume,
      confluence,
    });
  }

  // Last 3 bars summary
  const last3 = bars.slice(-3);
  const last3Bull = last3.filter(b => b.inference === "BULLISH").length;
  const last3Bear = last3.filter(b => b.inference === "BEARISH").length;
  let last3Inference: WickTimingTrend["last3Inference"];
  if (last3Bull >= 2 && last3Bear === 0) last3Inference = "BULLISH";
  else if (last3Bear >= 2 && last3Bull === 0) last3Inference = "BEARISH";
  else if (last3Bull > 0 && last3Bear > 0) last3Inference = "MIXED";
  else last3Inference = "INDETERMINATE";

  // Last 15 STRONG bars
  const last15 = bars.slice(-15);
  const strongBull15 = last15.filter(b => b.confluence === "STRONG_BULLISH").length;
  const strongBear15 = last15.filter(b => b.confluence === "STRONG_BEARISH").length;
  const strongCount15m = strongBull15 + strongBear15;
  let strongDirection15m: WickTimingTrend["strongDirection15m"];
  if (strongBull15 > strongBear15 + 1) strongDirection15m = "BULLISH";
  else if (strongBear15 > strongBull15 + 1) strongDirection15m = "BEARISH";
  else strongDirection15m = "BALANCED";

  // Keep last 30 bars only in audit (keep response light)
  const result: WickTimingTrend = {
    bars: bars.slice(-30),
    last3Inference,
    strongCount15m,
    strongDirection15m,
  };
  cache = { ts: Date.now(), trend: result };
  console.log(
    `[wickTiming] computeWickTiming: bars=${bars.length} last3=${last3Inference} ` +
    `strongCount15m=${strongCount15m} strongDir=${strongDirection15m}`,
  );
  return result;
}
