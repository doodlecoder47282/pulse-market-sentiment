// server/exposureProfile.ts
//
// Dealer exposure profiles — DEX / GEX / VEX / Charm across a band of spot
// levels. Same methodology as gammaProfile.ts (Perfiliev-style re-evaluation
// at hypothetical spot levels) but extended to the full second-order Greek
// suite that matters for flow analysis.
//
// EzOptions exposure formulas (contract multiplier = 100):
//   DEX   = Δ     × OI × 100 × S              ($ directional exposure)
//   GEX   = Γ     × OI × 100 × S² × 0.01      ($ per 1% spot move)
//   VEX   = Vanna × OI × 100 × S  × 0.01      ($ of dΔ per 1% vol)
//   Charm = Charm × OI × 100 × S  / 365       ($ of dΔ per calendar day)
//
// Sign convention: dealers are assumed SHORT customer-owned options, so
//   call OI contributes +Greek (dealer short call = positive gamma for dealer
//     when customer is long? No — dealer is SHORT gamma on call OI, hedges by
//     buying more as price rises).
// We follow Perfiliev / SpotGamma / MenthorQ: calls contribute +, puts −.
// That's what makes "positive GEX = vol-suppressing" work as an intuition.

import { computeGreeks, type GreekSet } from "./greeks";

export type OptionType = "C" | "P";

export interface ExposureRow {
  type: OptionType;
  strike: number;
  iv: number;     // decimal (0.15 = 15%)
  oi: number;     // open interest (contracts)
  dte: number;    // calendar days to expiry
}

export interface ExposurePoint {
  spot: number;
  dex: number;
  gex: number;
  vex: number;    // vanna exposure
  charm: number;  // charm exposure (per day)
}

export interface ExposureProfile {
  symbol: string;
  asOf: number;
  currentSpot: number;
  r: number;
  q: number;
  curve: ExposurePoint[];       // spot levels from lowPct·S → highPct·S
  current: ExposurePoint;       // exposures evaluated at actual current spot
  zeroGammaSpot: number | null; // spot where GEX flips sign
  zeroCharmSpot: number | null; // spot where Charm flips sign (primary — nearest to spot)
  zeroCharmSpots: number[];     // ALL charm sign-flips across the curve (Selz #1 — charm-zero CLUSTER)
  zeroVannaSpot: number | null; // spot where VEX flips sign
  charmSlope: number;           // dCharm/dS at spot — "tightening rate" (Selz #2)
  // True net-C per Perfiliev Table VIII: Σ charm_strike × OI_strike × 100, NO spot factor,
  // NO /365 normalisation. Signed with dealer convention (calls +, puts −). Units: shares of
  // delta decay per trading year. Used by masterAlpha for standardised charm z-score.
  netCTrue: number;
  ranges: {
    dex:   { min: number; max: number };
    gex:   { min: number; max: number };
    vex:   { min: number; max: number };
    charm: { min: number; max: number };
  };
  contractCount: number;        // how many option rows contributed
}

/**
 * Perfiliev's convention: 262 trading days/yr, 1/262 floor for 0DTE.
 * Input dte is CALENDAR days; convert to trading days first.
 */
function toTradingYears(dteCalendar: number): number {
  const tradingDays = Math.max(1, Math.round(dteCalendar * (262 / 365)));
  return tradingDays / 262;
}

/**
 * Evaluate all four exposures at a given spot, summed across the chain.
 * Each row's Greeks are recomputed at that hypothetical spot (same approach
 * as gammaProfile.ts for the zero-gamma curve).
 */
function exposuresAt(
  rows: Array<ExposureRow & { T: number; sign: number }>,
  S: number, r: number, q: number,
): { dex: number; gex: number; vex: number; charm: number } {
  let dex = 0, gex = 0, vex = 0, ch = 0;
  for (const row of rows) {
    const g: GreekSet = computeGreeks(S, row.strike, row.iv, row.T, r, q, row.type);
    const oiMult = row.oi * 100;
    // Sign: calls +1, puts -1 (dealer-hedge convention matches gammaProfile.ts)
    dex += row.sign * g.delta  * oiMult * S;
    gex += row.sign * g.gamma  * oiMult * S * S * 0.01;
    vex += row.sign * g.vanna  * oiMult * S * 0.01;
    ch  += row.sign * g.charm  * oiMult * S / 365;
  }
  return { dex, gex, vex, charm: ch };
}

/**
 * Build the full exposure profile.
 *
 * @param rows    All option rows (IV + OI per contract, 0-45 DTE recommended)
 * @param spot    Current underlying spot price
 * @param opts    Overrides — r, q, nLevels, lowPct, highPct
 */
export function buildExposureProfile(
  symbol: string,
  rows: ExposureRow[],
  spot: number,
  opts: { r?: number; q?: number; nLevels?: number; lowPct?: number; highPct?: number } = {},
): ExposureProfile {
  const r = opts.r ?? 0.05;
  const q = opts.q ?? 0.013;
  const nLevels = opts.nLevels ?? 60;
  const lowPct = opts.lowPct ?? 0.9;
  const highPct = opts.highPct ?? 1.1;

  const lo = lowPct * spot;
  const hi = highPct * spot;
  const step = (hi - lo) / (nLevels - 1);

  const precomputed = rows
    .filter((row) => row.iv > 0 && row.oi > 0 && row.dte >= 0)
    .map((row) => ({
      ...row,
      T: toTradingYears(row.dte),
      sign: row.type === "C" ? 1 : -1,
    }));

  const curve: ExposurePoint[] = [];
  for (let i = 0; i < nLevels; i++) {
    const S = lo + i * step;
    const e = exposuresAt(precomputed, S, r, q);
    curve.push({ spot: S, ...e });
  }

  // Zero-crossings for GEX / Charm / VEX.
  const zeroGammaSpot = findZeroCrossing(curve.map((p) => ({ x: p.spot, y: p.gex })));
  const charmPts = curve.map((p) => ({ x: p.spot, y: p.charm }));
  // Primary charmZero must be the dealer-relevant root — the crossing NEAREST to spot,
  // restricted to ±1.5% band. Far-out crossings at the wings (±10%) are numerical artifacts,
  // not actionable drift targets. Full cluster (zeroCharmSpots) keeps every crossing for Selz #1.
  const zeroCharmSpots = findAllZeroCrossings(charmPts);
  const zeroCharmSpot = pickNearestWithin(zeroCharmSpots, spot, 0.015)
                     ?? pickNearestWithin(zeroCharmSpots, spot, 0.03)
                     ?? null;
  const zeroVannaSpot = findZeroCrossing(curve.map((p) => ({ x: p.spot, y: p.vex })));

  // Charm slope at current spot — 1st-order finite difference on the curve window around spot.
  let charmSlope = 0;
  if (curve.length >= 3) {
    let idx = 0;
    for (let i = 1; i < curve.length; i++) {
      if (Math.abs(curve[i].spot - spot) < Math.abs(curve[idx].spot - spot)) idx = i;
    }
    const lo = curve[Math.max(0, idx - 1)];
    const hi = curve[Math.min(curve.length - 1, idx + 1)];
    const dS = hi.spot - lo.spot;
    if (dS !== 0) charmSlope = (hi.charm - lo.charm) / dS;
  }

  // Exposures at actual current spot.
  const currentE = exposuresAt(precomputed, spot, r, q);
  const current: ExposurePoint = { spot, ...currentE };

  // True net-C aggregate per locked formula: Σ charm_strike × OI_strike × 100.
  // No spot factor, no /365 — this matches Perfiliev Table VIII / paper Table IX inputs
  // against which the β_C regression and NETC_SD_M = $80M stdev are calibrated.
  // Dealer sign convention: calls +1, puts −1 (dealers short customer OI).
  let netCTrue = 0;
  for (const row of precomputed) {
    const g: GreekSet = computeGreeks(spot, row.strike, row.iv, row.T, r, q, row.type);
    netCTrue += row.sign * g.charm * row.oi * 100;
  }

  const ranges = {
    dex:   rangeOf(curve.map((p) => p.dex)),
    gex:   rangeOf(curve.map((p) => p.gex)),
    vex:   rangeOf(curve.map((p) => p.vex)),
    charm: rangeOf(curve.map((p) => p.charm)),
  };

  return {
    symbol,
    asOf: Math.floor(Date.now() / 1000),
    currentSpot: spot,
    r, q,
    curve,
    current,
    zeroGammaSpot,
    zeroCharmSpot,
    zeroCharmSpots,
    zeroVannaSpot,
    charmSlope,
    netCTrue,
    ranges,
    contractCount: precomputed.length,
  };
}

function findZeroCrossing(points: { x: number; y: number }[]): number | null {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.y === 0) return a.x;
    if (a.y * b.y < 0) {
      return a.x - a.y * (b.x - a.x) / (b.y - a.y);
    }
  }
  return null;
}

// Pick the root nearest to spot within a percentage band (e.g. 0.015 = ±1.5%).
// Returns null if no root lies inside the band. Used for charmZero to restrict
// selection to the dealer-hedging-relevant region around current spot.
function pickNearestWithin(roots: number[], spot: number, bandPct: number): number | null {
  if (!roots.length || !(spot > 0)) return null;
  const maxDist = spot * bandPct;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const r of roots) {
    const d = Math.abs(r - spot);
    if (d <= maxDist && d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  return best;
}

// All sign-flips along the curve — used for Selz #1 charm-zero CLUSTER.
function findAllZeroCrossings(points: { x: number; y: number }[]): number[] {
  const zeros: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.y === 0) { zeros.push(a.x); continue; }
    if (a.y * b.y < 0) {
      zeros.push(a.x - a.y * (b.x - a.x) / (b.y - a.y));
    }
  }
  return zeros;
}

function rangeOf(xs: number[]): { min: number; max: number } {
  return { min: Math.min(...xs), max: Math.max(...xs) };
}
