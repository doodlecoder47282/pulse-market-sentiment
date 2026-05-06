// server/mtfStack.ts
//
// Multi-timeframe SMA/EMA stack analyzer for the Exit Brain.
// Pulls 1m bars from Schwab (getPriceHistory) for the requested symbol,
// aggregates up to 5/15/30/60/240m, computes 13EMA + 15/20/21 SMAs on each,
// scores stack health 0..100, returns a cross-TF composite score.
//
// 30-second in-memory cache keyed by symbol so the 30s exit-brain eval cadence
// doesn't hammer Schwab. Read-only, try/catch wrapped at every API boundary,
// fails silent — never throws into callers.
//
// Score interpretation (per TF + composite):
//   80-100 = full stack alignment (bullish or bearish), trade w/ trend
//   55-79  = mostly aligned, minor cross
//   30-54  = mixed / chop
//   0-29   = stack inverted vs position side → exit signal
//
// For the Exit Brain specifically: if the 1m + 5m health vs your *position
// side* drops below 35, that's one of the 5 confluence categories firing.

import { getPriceHistory, type PriceHistoryResponse } from "./schwab";

export type Bar = {
  t: number; // epoch ms (bar open)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type TfKey = "1m" | "5m" | "15m" | "30m" | "1h" | "4h";

export type TfSnapshot = {
  tf: TfKey;
  closes: number[];      // last N closes used in calc (debug)
  ema13: number | null;
  sma15: number | null;
  sma20: number | null;
  sma21: number | null;
  close: number | null;
  // slope = % change of EMA13 over last 5 bars (positive=up)
  slopePct: number | null;
  // alignment: bull = close > ema13 > sma15 > sma20 > sma21
  //            bear = close < ema13 < sma15 < sma20 < sma21
  alignment: "bull" | "bear" | "mixed" | "insufficient";
  // 0..100 health — higher = cleaner stack regardless of direction
  health: number;
  // health *for a given side* — used by Exit Brain.
  // healthForLong: high = good for long, low = bad for long
  healthForLong: number;
  healthForShort: number;
};

export type MtfStack = {
  symbol: string;
  asOf: number;
  source: "schwab" | "mixed";
  tfs: Record<TfKey, TfSnapshot>;
  // Composite scores weighted toward shorter TFs for 0DTE:
  //   1m:0.30 · 5m:0.30 · 15m:0.20 · 30m:0.10 · 1h:0.07 · 4h:0.03
  compositeForLong: number;   // 0..100
  compositeForShort: number;  // 0..100
};

// ─── Indicator math ─────────────────────────────────────────────────────

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  // seed with SMA of first n
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i];
  e /= n;
  for (let i = n; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

// EMA series so we can measure slope across last 5 bars
function emaSeries(values: number[], n: number): number[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i];
  e /= n;
  out.push(e);
  for (let i = n; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// ─── Bar aggregation ────────────────────────────────────────────────────

function aggregate(bars: Bar[], minutesPerBar: number): Bar[] {
  if (minutesPerBar <= 1) return bars.slice();
  const bucketMs = minutesPerBar * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / bucketMs) * bucketMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ─── Snapshot computation ───────────────────────────────────────────────

function snapshotForTf(tf: TfKey, bars: Bar[]): TfSnapshot {
  const closes = bars.map((b) => b.c);
  const ema13 = ema(closes, 13);
  const sma15 = sma(closes, 15);
  const sma20 = sma(closes, 20);
  const sma21 = sma(closes, 21);
  const close = closes.length ? closes[closes.length - 1] : null;

  // Slope: pct change of EMA13 over last 5 bars
  let slopePct: number | null = null;
  const eSeries = emaSeries(closes, 13);
  if (eSeries.length >= 6) {
    const prev = eSeries[eSeries.length - 6];
    const cur = eSeries[eSeries.length - 1];
    if (prev !== 0) slopePct = ((cur - prev) / prev) * 100;
  }

  let alignment: TfSnapshot["alignment"] = "insufficient";
  if (close != null && ema13 != null && sma15 != null && sma20 != null && sma21 != null) {
    const bull = close > ema13 && ema13 > sma15 && sma15 > sma20 && sma20 > sma21;
    const bear = close < ema13 && ema13 < sma15 && sma15 < sma20 && sma20 < sma21;
    alignment = bull ? "bull" : bear ? "bear" : "mixed";
  }

  // Health 0..100: cleaner stack = higher
  let health = 0;
  let healthForLong = 50;
  let healthForShort = 50;
  if (close != null && ema13 != null && sma15 != null && sma20 != null && sma21 != null) {
    // base from alignment
    if (alignment === "bull" || alignment === "bear") health = 75;
    else health = 35;

    // boost from slope magnitude (capped)
    if (slopePct != null) {
      const slopeBoost = Math.min(15, Math.abs(slopePct) * 8);
      health = Math.min(100, health + slopeBoost);
    }

    // distance of close from ema13 in % — used to penalize "extended"
    const dist = ((close - ema13) / ema13) * 100;

    // Direction-adjusted scores
    if (alignment === "bull") {
      healthForLong = health;
      healthForShort = 100 - health;
    } else if (alignment === "bear") {
      healthForShort = health;
      healthForLong = 100 - health;
    } else {
      // mixed — slightly favor whichever side close-vs-ema13 leans
      if (dist > 0) {
        healthForLong = 50 + Math.min(15, dist * 5);
        healthForShort = 100 - healthForLong;
      } else {
        healthForShort = 50 + Math.min(15, Math.abs(dist) * 5);
        healthForLong = 100 - healthForShort;
      }
    }

    // slope penalty/boost on side scores
    if (slopePct != null) {
      const adj = Math.max(-12, Math.min(12, slopePct * 6));
      healthForLong = Math.max(0, Math.min(100, healthForLong + adj));
      healthForShort = Math.max(0, Math.min(100, healthForShort - adj));
    }
  }

  return {
    tf,
    closes: closes.slice(-30),
    ema13,
    sma15,
    sma20,
    sma21,
    close,
    slopePct,
    alignment,
    health: Math.round(health),
    healthForLong: Math.round(healthForLong),
    healthForShort: Math.round(healthForShort),
  };
}

// ─── Schwab fetch + 30s cache ───────────────────────────────────────────

type CacheEntry = { at: number; bars: Bar[]; source: "schwab" };
const CACHE_MS = 30_000;
const cache = new Map<string, CacheEntry>();

async function fetch1mBars(symbol: string): Promise<{ bars: Bar[]; source: "schwab" }> {
  const cached = cache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    return { bars: cached.bars, source: cached.source };
  }

  // Schwab: 10 days of 1-minute bars is enough for 4h aggregation context
  // periodType="day", period=10, frequencyType="minute", frequency=1
  let resp: PriceHistoryResponse | null = null;
  try {
    resp = await getPriceHistory(symbol, "day", 10, "minute", 1);
  } catch {
    resp = null;
  }
  if (!resp || !resp.candles?.length) {
    return { bars: [], source: "schwab" };
  }

  const bars: Bar[] = resp.candles.map((c: any) => ({
    t: c.datetime,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume ?? 0,
  })).filter((b) => Number.isFinite(b.c) && b.c > 0);

  cache.set(symbol, { at: now, bars, source: resp.source });
  return { bars, source: resp.source };
}

// ─── Public API ─────────────────────────────────────────────────────────

const TF_MINUTES: Record<TfKey, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
};

const COMPOSITE_WEIGHTS: Record<TfKey, number> = {
  "1m": 0.30,
  "5m": 0.30,
  "15m": 0.20,
  "30m": 0.10,
  "1h": 0.07,
  "4h": 0.03,
};

export async function getMtfStack(symbol: string): Promise<MtfStack> {
  const { bars, source } = await fetch1mBars(symbol);

  const tfs = {} as Record<TfKey, TfSnapshot>;
  for (const tf of Object.keys(TF_MINUTES) as TfKey[]) {
    const minutes = TF_MINUTES[tf];
    const aggBars = aggregate(bars, minutes);
    tfs[tf] = snapshotForTf(tf, aggBars);
  }

  let compositeForLong = 0;
  let compositeForShort = 0;
  for (const tf of Object.keys(COMPOSITE_WEIGHTS) as TfKey[]) {
    const w = COMPOSITE_WEIGHTS[tf];
    compositeForLong += tfs[tf].healthForLong * w;
    compositeForShort += tfs[tf].healthForShort * w;
  }

  return {
    symbol,
    asOf: Date.now(),
    source,
    tfs,
    compositeForLong: Math.round(compositeForLong),
    compositeForShort: Math.round(compositeForShort),
  };
}

// ─── Exit-brain helper: stack collapse detection ────────────────────────
// Returns true if the stack against the position side has collapsed enough
// to count as one of the 5 confluence categories.

export function isStackCollapse(stack: MtfStack, side: "long" | "short"): {
  collapsed: boolean;
  score: number;       // composite for that side
  reason: string;
} {
  const score = side === "long" ? stack.compositeForLong : stack.compositeForShort;
  // Below 35 = stack working *against* the position
  const collapsed = score < 35;
  let reason = "";
  if (collapsed) {
    const oneM = side === "long" ? stack.tfs["1m"].healthForLong : stack.tfs["1m"].healthForShort;
    const fiveM = side === "long" ? stack.tfs["5m"].healthForLong : stack.tfs["5m"].healthForShort;
    const fifteenM = side === "long" ? stack.tfs["15m"].healthForLong : stack.tfs["15m"].healthForShort;
    const weak: string[] = [];
    if (oneM < 35) weak.push("1m");
    if (fiveM < 35) weak.push("5m");
    if (fifteenM < 35) weak.push("15m");
    reason = `stack collapse (${weak.join("+") || "composite"}) score=${score}`;
  }
  return { collapsed, score, reason };
}
