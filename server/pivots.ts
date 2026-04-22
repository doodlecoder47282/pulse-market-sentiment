// server/pivots.ts
// Pivot math for intraday trading.
//
// Three systems, all derived from the PRIOR trading day's OHLC:
//
//   Classic (Floor Trader):
//     PP = (H + L + C) / 3
//     R1 = 2*PP - L             S1 = 2*PP - H
//     R2 = PP + (H - L)         S2 = PP - (H - L)
//     R3 = H + 2*(PP - L)       S3 = L - 2*(H - PP)
//
//   Fibonacci:
//     PP = (H + L + C) / 3
//     R1 = PP + 0.382*(H-L)     S1 = PP - 0.382*(H-L)
//     R2 = PP + 0.618*(H-L)     S2 = PP - 0.618*(H-L)
//     R3 = PP + 1.000*(H-L)     S3 = PP - 1.000*(H-L)
//
//   Camarilla (intraday reversion/breakout, purpose-built for 0DTE):
//     H1-H6 = C + (H-L) * k   where k = {1.1/12, 1.1/6, 1.1/4, 1.1/2, 1.1, 1.1*1.168}
//     L1-L6 = C - (H-L) * k
//     H3/L3  = reversion fade zones (high-probability fade targets)
//     H4/L4  = breakout triggers (commit stops beyond)
//     H5/L5  = trend-day targets
//     H6/L6  = extreme tail (session-high/low reversal)

import type { DailyOHLC } from "./quotes";

export type ClassicPivots = {
  pp: number;
  r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
};

export type FibonacciPivots = ClassicPivots; // same shape

export type CamarillaPivots = {
  h1: number; h2: number; h3: number; h4: number; h5: number; h6: number;
  l1: number; l2: number; l3: number; l4: number; l5: number; l6: number;
  pp: number;  // Classic PP included for reference
};

export type PivotBundle = {
  symbol: string;
  priorOhlc: DailyOHLC;
  classic: ClassicPivots;
  fibonacci: FibonacciPivots;
  camarilla: CamarillaPivots;
  range: number;                 // prior H-L
  midpoint: number;              // (H+L)/2
};

export function classicPivots(ohlc: DailyOHLC): ClassicPivots {
  const { h, l, c } = ohlc;
  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + range,
    s2: pp - range,
    r3: h + 2 * (pp - l),
    s3: l - 2 * (h - pp),
  };
}

export function fibonacciPivots(ohlc: DailyOHLC): FibonacciPivots {
  const { h, l, c } = ohlc;
  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pp,
    r1: pp + 0.382 * range,
    s1: pp - 0.382 * range,
    r2: pp + 0.618 * range,
    s2: pp - 0.618 * range,
    r3: pp + 1.000 * range,
    s3: pp - 1.000 * range,
  };
}

export function camarillaPivots(ohlc: DailyOHLC): CamarillaPivots {
  const { h, l, c } = ohlc;
  const range = h - l;
  const k1 = 1.1 / 12;
  const k2 = 1.1 / 6;
  const k3 = 1.1 / 4;
  const k4 = 1.1 / 2;
  const k5 = 1.1;
  const k6 = 1.1 * 1.168;
  const pp = (h + l + c) / 3;
  return {
    h1: c + range * k1, l1: c - range * k1,
    h2: c + range * k2, l2: c - range * k2,
    h3: c + range * k3, l3: c - range * k3,
    h4: c + range * k4, l4: c - range * k4,
    h5: c + range * k5, l5: c - range * k5,
    h6: c + range * k6, l6: c - range * k6,
    pp,
  };
}

export function buildPivotBundle(symbol: string, priorOhlc: DailyOHLC): PivotBundle {
  return {
    symbol,
    priorOhlc,
    classic: classicPivots(priorOhlc),
    fibonacci: fibonacciPivots(priorOhlc),
    camarilla: camarillaPivots(priorOhlc),
    range: priorOhlc.h - priorOhlc.l,
    midpoint: (priorOhlc.h + priorOhlc.l) / 2,
  };
}

/**
 * Given the current price, find the nearest pivot above and below across all
 * three systems. Used by the Playbook engine to describe proximity.
 */
export function proximityAnalysis(price: number, bundle: PivotBundle) {
  type Lvl = { name: string; system: "classic" | "fib" | "cam"; value: number };
  const levels: Lvl[] = [
    { name: "PP",  system: "classic", value: bundle.classic.pp },
    { name: "R1",  system: "classic", value: bundle.classic.r1 },
    { name: "R2",  system: "classic", value: bundle.classic.r2 },
    { name: "R3",  system: "classic", value: bundle.classic.r3 },
    { name: "S1",  system: "classic", value: bundle.classic.s1 },
    { name: "S2",  system: "classic", value: bundle.classic.s2 },
    { name: "S3",  system: "classic", value: bundle.classic.s3 },
    { name: "Fib R1", system: "fib", value: bundle.fibonacci.r1 },
    { name: "Fib R2", system: "fib", value: bundle.fibonacci.r2 },
    { name: "Fib R3", system: "fib", value: bundle.fibonacci.r3 },
    { name: "Fib S1", system: "fib", value: bundle.fibonacci.s1 },
    { name: "Fib S2", system: "fib", value: bundle.fibonacci.s2 },
    { name: "Fib S3", system: "fib", value: bundle.fibonacci.s3 },
    { name: "H3 (fade)",      system: "cam", value: bundle.camarilla.h3 },
    { name: "H4 (breakout)",  system: "cam", value: bundle.camarilla.h4 },
    { name: "H5 (trend tgt)", system: "cam", value: bundle.camarilla.h5 },
    { name: "L3 (fade)",      system: "cam", value: bundle.camarilla.l3 },
    { name: "L4 (breakdown)", system: "cam", value: bundle.camarilla.l4 },
    { name: "L5 (trend tgt)", system: "cam", value: bundle.camarilla.l5 },
  ];
  const above = levels.filter(l => l.value > price).sort((a, b) => a.value - b.value)[0] || null;
  const below = levels.filter(l => l.value < price).sort((a, b) => b.value - a.value)[0] || null;
  const nearest = levels
    .map(l => ({ ...l, dist: Math.abs(l.value - price) }))
    .sort((a, b) => a.dist - b.dist)[0];
  return { above, below, nearest };
}
