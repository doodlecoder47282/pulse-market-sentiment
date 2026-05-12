// server/pivotProjection.ts
//
// Pivot Point Projection — replaces the forward "cone" idea with a stacked
// magnet map for the next 1-2 months. Inputs are entirely from our own data:
//
//   • Monthly Classic Pivots (PP, R1-R3, S1-S3) — derived from PRIOR MONTH OHLC
//     These are the floor-trader levels that retail/algos actually fade.
//   • Quarterly Fibonacci Pivots (PP, R1-R3, S1-S3) — from PRIOR QUARTER OHLC
//     Institutional swing levels. Wider spacing, slower drift.
//   • Gamma walls from /api/gamma-levels-enhanced (callWall, putWall, gammaFlip)
//   • SMA stack: 20d / 50d / 200d
//   • Volume nodes (top 3 high-volume price levels from last 90 daily bars)
//   • RSI(14) extreme zones (70/30) projected onto price
//
// Confluence Score per level:
//   +1 for each independent system within ±0.5% of the level price band.
//   3+ confluence = high-conviction magnet.
//
// Setup pattern tags (named for memory):
//   • Pivot Reclaim    — close above PP after trading below for ≥3 sessions
//   • Pivot Rejection  — close below PP after touching from below
//   • Magnet Drift     — price grinding toward stacked level (≥3 confluence)
//   • Stack Break      — clean break of 3+ confluence level on >1.5σ volume

export type PivotSystem = "monthlyClassic" | "quarterlyFib";

/** Local OHLC type for the prior aggregated period (no timestamp needed). */
export type PeriodOHLC = { o: number; h: number; l: number; c: number };

export type PivotLevel = {
  /** Display label (e.g. "M-R1", "Q-PP", "callWall") */
  label: string;
  /** Source: which calc produced it */
  source:
    | "monthlyClassic"
    | "quarterlyFib"
    | "gammaWall"
    | "sma"
    | "volumeNode"
    | "rsiExtreme";
  price: number;
  /** Confluence count — number of other independent sources within ±0.5% */
  confluence: number;
  /** Co-located system labels at this band (for tooltip "stacked with…") */
  stackedWith: string[];
  /** Distance from current spot, % */
  distPct: number;
  /** "above" or "below" current price */
  side: "above" | "below" | "at";
  /** High-conviction tier */
  tier: "magnet" | "key" | "minor";
};

export type PatternTag = {
  setup: "pivot-reclaim" | "pivot-rejection" | "magnet-drift" | "stack-break";
  message: string;
  confidence: number; // 0-1
};

export type PivotProjectionResponse = {
  symbol: string;
  spot: number;
  asOf: string;
  monthlyPriorOhlc: PeriodOHLC;
  quarterlyPriorOhlc: PeriodOHLC;
  levels: PivotLevel[];
  // Historical reaction markers — for each level, how many times in last 90d
  // did price come within 0.3% of it and reverse 0.5%+ in the next 5 days?
  historicalReactions: Record<string, number>;
  patterns: PatternTag[];
};

function classicPivots(ohlc: PeriodOHLC) {
  const { h, l, c } = ohlc;
  const pp = (h + l + c) / 3;
  const r = h - l;
  return {
    pp,
    r1: 2 * pp - l,
    r2: pp + r,
    r3: h + 2 * (pp - l),
    s1: 2 * pp - h,
    s2: pp - r,
    s3: l - 2 * (h - pp),
  };
}

function fibPivots(ohlc: PeriodOHLC) {
  const { h, l, c } = ohlc;
  const pp = (h + l + c) / 3;
  const r = h - l;
  return {
    pp,
    r1: pp + 0.382 * r,
    r2: pp + 0.618 * r,
    r3: pp + 1.0 * r,
    s1: pp - 0.382 * r,
    s2: pp - 0.618 * r,
    s3: pp - 1.0 * r,
  };
}

function sma(closes: number[], n: number): number {
  if (closes.length < n) return NaN;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/** Wilder RSI(14). */
function rsi14(closes: number[]): number | null {
  const p = 14;
  if (closes.length < p + 2) return null;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) g += ch;
    else l -= ch;
  }
  g /= p;
  l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gg = ch > 0 ? ch : 0;
    const ll = ch < 0 ? -ch : 0;
    g = (g * (p - 1) + gg) / p;
    l = (l * (p - 1) + ll) / p;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

/** Top N volume-weighted price clusters from daily bars (volume-by-price proxy). */
function volumeNodes(
  bars: Array<{ close: number; volume?: number }>,
  n: number,
  binPct = 0.005,
): number[] {
  const prices = bars.map((b) => b.close);
  if (prices.length === 0) return [];
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const binSize = (max - min) * binPct;
  if (binSize <= 0) return [];
  const bins = new Map<number, number>(); // binCenter -> volume
  for (const b of bars) {
    const idx = Math.round((b.close - min) / binSize);
    const center = min + idx * binSize;
    const v = b.volume ?? 1;
    bins.set(center, (bins.get(center) ?? 0) + v);
  }
  return Array.from(bins.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([price]) => price);
}

/**
 * Aggregate daily bars into a single OHLC for a calendar period.
 * `kind = "month"` aggregates the most recent COMPLETED calendar month.
 * `kind = "quarter"` aggregates the most recent COMPLETED quarter.
 */
function priorPeriodOhlc(
  bars: Array<{ t: number; open?: number; high?: number; low?: number; close: number }>,
  kind: "month" | "quarter",
): PeriodOHLC | null {
  if (bars.length === 0) return null;
  const now = new Date();
  let startMs: number;
  let endMs: number;
  if (kind === "month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    startMs = start.getTime() / 1000;
    endMs = end.getTime() / 1000;
  } else {
    const curQ = Math.floor(now.getMonth() / 3);
    const startMonth = (curQ - 1) * 3;
    const start = new Date(now.getFullYear(), startMonth, 1);
    const end = new Date(now.getFullYear(), startMonth + 3, 0, 23, 59, 59);
    startMs = start.getTime() / 1000;
    endMs = end.getTime() / 1000;
  }
  const slice = bars.filter((b) => b.t >= startMs && b.t <= endMs);
  if (slice.length === 0) return null;
  const o = slice[0].open ?? slice[0].close;
  const c = slice[slice.length - 1].close;
  const h = Math.max(...slice.map((b) => b.high ?? b.close));
  const l = Math.min(...slice.map((b) => b.low ?? b.close));
  return { o, h, l, c };
}

function computeConfluence(
  candidates: Array<{ label: string; source: PivotLevel["source"]; price: number }>,
  bandPct = 0.005,
): PivotLevel[] {
  const out: PivotLevel[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const me = candidates[i];
    const band = me.price * bandPct;
    const others = candidates
      .filter((_, idx) => idx !== i)
      .filter((c) => Math.abs(c.price - me.price) <= band && c.source !== me.source);
    const stacked = others.map((o) => o.label);
    out.push({
      label: me.label,
      source: me.source,
      price: me.price,
      confluence: 1 + stacked.length,
      stackedWith: stacked,
      distPct: 0, // filled later
      side: "at",
      tier: "minor",
    });
  }
  return out;
}

function countHistoricalReactions(
  closes: number[],
  levelPrice: number,
  toleranceBps = 30,
  reversalBps = 50,
  lookbackBars = 90,
): number {
  const slice = closes.slice(-lookbackBars);
  let touches = 0;
  for (let i = 0; i < slice.length - 5; i++) {
    const dist = Math.abs(slice[i] - levelPrice) / levelPrice;
    if (dist > toleranceBps / 10000) continue;
    // Look 5 bars forward — did price reverse ≥ reversalBps?
    const future = slice.slice(i + 1, i + 6);
    if (future.length < 3) continue;
    const maxMove = Math.max(...future.map((p) => Math.abs(p - slice[i]) / slice[i]));
    if (maxMove >= reversalBps / 10000) touches++;
  }
  return touches;
}

export interface PivotProjectionInputs {
  symbol: string;
  spot: number;
  /** Last ~6 months of daily bars (need at least 130 for quarterly + SMA200) */
  bars: Array<{
    t: number;
    open?: number;
    high?: number;
    low?: number;
    close: number;
    volume?: number;
  }>;
  /** Optional gamma levels from /api/gamma-levels-enhanced (may be null) */
  gammaWalls?: {
    callWall: number | null;
    putWall: number | null;
    gammaFlip: number | null;
    zeroGamma?: number | null;
  } | null;
}

export function buildPivotProjection(
  inp: PivotProjectionInputs,
): PivotProjectionResponse {
  const { symbol, spot, bars } = inp;
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1] ?? spot;

  // Anchor OHLC: prior calendar month + prior quarter
  const mOhlc =
    priorPeriodOhlc(bars, "month") ?? {
      o: last,
      h: last * 1.05,
      l: last * 0.95,
      c: last,
    };
  const qOhlc =
    priorPeriodOhlc(bars, "quarter") ?? {
      o: last,
      h: last * 1.1,
      l: last * 0.9,
      c: last,
    };

  const mc = classicPivots(mOhlc);
  const qf = fibPivots(qOhlc);

  // Build raw candidate list
  type Candidate = { label: string; source: PivotLevel["source"]; price: number };
  const candidates: Candidate[] = [];

  // Monthly classic
  candidates.push(
    { label: "M-PP", source: "monthlyClassic", price: mc.pp },
    { label: "M-R1", source: "monthlyClassic", price: mc.r1 },
    { label: "M-R2", source: "monthlyClassic", price: mc.r2 },
    { label: "M-R3", source: "monthlyClassic", price: mc.r3 },
    { label: "M-S1", source: "monthlyClassic", price: mc.s1 },
    { label: "M-S2", source: "monthlyClassic", price: mc.s2 },
    { label: "M-S3", source: "monthlyClassic", price: mc.s3 },
  );
  // Quarterly fib
  candidates.push(
    { label: "Q-PP", source: "quarterlyFib", price: qf.pp },
    { label: "Q-R1", source: "quarterlyFib", price: qf.r1 },
    { label: "Q-R2", source: "quarterlyFib", price: qf.r2 },
    { label: "Q-R3", source: "quarterlyFib", price: qf.r3 },
    { label: "Q-S1", source: "quarterlyFib", price: qf.s1 },
    { label: "Q-S2", source: "quarterlyFib", price: qf.s2 },
    { label: "Q-S3", source: "quarterlyFib", price: qf.s3 },
  );
  // Gamma walls
  if (inp.gammaWalls) {
    if (inp.gammaWalls.callWall)
      candidates.push({ label: "callWall", source: "gammaWall", price: inp.gammaWalls.callWall });
    if (inp.gammaWalls.putWall)
      candidates.push({ label: "putWall", source: "gammaWall", price: inp.gammaWalls.putWall });
    if (inp.gammaWalls.gammaFlip)
      candidates.push({ label: "gammaFlip", source: "gammaWall", price: inp.gammaWalls.gammaFlip });
    if (inp.gammaWalls.zeroGamma)
      candidates.push({ label: "zeroGamma", source: "gammaWall", price: inp.gammaWalls.zeroGamma });
  }
  // SMAs
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  if (isFinite(s20)) candidates.push({ label: "SMA20", source: "sma", price: s20 });
  if (isFinite(s50)) candidates.push({ label: "SMA50", source: "sma", price: s50 });
  if (isFinite(s200)) candidates.push({ label: "SMA200", source: "sma", price: s200 });
  // Volume nodes
  const vNodes = volumeNodes(bars, 3);
  vNodes.forEach((v, i) =>
    candidates.push({ label: `VN${i + 1}`, source: "volumeNode", price: v }),
  );
  // RSI projection — not a price level by itself, but we mark the price at which
  // RSI(14) would currently equal 70 or 30 if held flat from now. Skip — too noisy
  // for monthly horizon. Keep RSI for pattern detection only.

  // Compute confluence
  const levels = computeConfluence(candidates);

  // Fill side, dist, tier
  for (const lv of levels) {
    lv.distPct = ((lv.price - last) / last) * 100;
    lv.side = lv.price > last ? "above" : lv.price < last ? "below" : "at";
    lv.tier =
      lv.confluence >= 3 ? "magnet" : lv.confluence === 2 ? "key" : "minor";
  }

  // Sort by price ascending (chart-friendly)
  levels.sort((a, b) => a.price - b.price);

  // Historical reactions for each level
  const histReactions: Record<string, number> = {};
  for (const lv of levels) {
    histReactions[lv.label] = countHistoricalReactions(closes, lv.price);
  }

  // Pattern detection
  const patterns: PatternTag[] = [];
  const r14 = rsi14(closes);

  // Pivot Reclaim: M-PP — count sessions below in last 5 bars
  const recent5 = closes.slice(-6);
  const mppBelows = recent5.slice(0, 5).filter((p) => p < mc.pp).length;
  if (mppBelows >= 3 && last > mc.pp) {
    patterns.push({
      setup: "pivot-reclaim",
      message: `M-PP reclaim — closed above ${mc.pp.toFixed(2)} after ${mppBelows} sessions below`,
      confidence: 0.65,
    });
  }

  // Pivot Rejection: touched M-PP from below in last 3 bars, closed lower
  const recent3 = bars.slice(-3);
  if (
    recent3.length === 3 &&
    last < mc.pp &&
    recent3.some(
      (b) =>
        (b.high ?? b.close) >= mc.pp * 0.998 && (b.high ?? b.close) <= mc.pp * 1.002,
    )
  ) {
    patterns.push({
      setup: "pivot-rejection",
      message: `M-PP rejection — wicked through ${mc.pp.toFixed(2)} and closed lower`,
      confidence: 0.6,
    });
  }

  // Magnet drift: any level within 1.5% above OR below with confluence ≥ 3
  const magnets = levels.filter((l) => l.tier === "magnet" && Math.abs(l.distPct) <= 1.5);
  if (magnets.length > 0) {
    const m = magnets.reduce((a, b) =>
      Math.abs(a.distPct) < Math.abs(b.distPct) ? a : b,
    );
    patterns.push({
      setup: "magnet-drift",
      message: `Drifting toward ${m.label} (${m.price.toFixed(2)}, ${m.distPct >= 0 ? "+" : ""}${m.distPct.toFixed(2)}%) · stacked with ${m.stackedWith.join(", ")}`,
      confidence: 0.55 + Math.min(0.3, (m.confluence - 3) * 0.1),
    });
  }

  // Stack break — find the closest 3+ confluence level we just punched through
  // in the last 3 bars
  const last3High = Math.max(...bars.slice(-3).map((b) => b.high ?? b.close));
  const last3Low = Math.min(...bars.slice(-3).map((b) => b.low ?? b.close));
  const brokenUp = levels.find(
    (l) => l.tier === "magnet" && l.price < last && l.price > last3Low * 1.001,
  );
  const brokenDown = levels.find(
    (l) => l.tier === "magnet" && l.price > last && l.price < last3High * 0.999,
  );
  if (brokenUp) {
    patterns.push({
      setup: "stack-break",
      message: `Broke above stacked level ${brokenUp.label} (${brokenUp.price.toFixed(2)}, ${brokenUp.stackedWith.length} sources) · trail stops below`,
      confidence: 0.7,
    });
  }
  if (brokenDown) {
    patterns.push({
      setup: "stack-break",
      message: `Broke below stacked level ${brokenDown.label} (${brokenDown.price.toFixed(2)}, ${brokenDown.stackedWith.length} sources)`,
      confidence: 0.7,
    });
  }

  // RSI extreme tag
  if (r14 != null) {
    if (r14 >= 70) {
      patterns.push({
        setup: "magnet-drift",
        message: `RSI(14) ${r14.toFixed(1)} overbought — bias mean reversion toward nearest support magnet`,
        confidence: 0.5,
      });
    } else if (r14 <= 30) {
      patterns.push({
        setup: "magnet-drift",
        message: `RSI(14) ${r14.toFixed(1)} oversold — bias bounce toward nearest resistance magnet`,
        confidence: 0.5,
      });
    }
  }

  return {
    symbol,
    spot: last,
    asOf: new Date().toISOString(),
    monthlyPriorOhlc: mOhlc,
    quarterlyPriorOhlc: qOhlc,
    levels,
    historicalReactions: histReactions,
    patterns,
  };
}
