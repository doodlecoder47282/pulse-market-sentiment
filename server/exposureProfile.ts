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
  zeroCharmSpot: number | null; // spot where Charm flips sign
  zeroVannaSpot: number | null; // spot where VEX flips sign
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
  const zeroCharmSpot = findZeroCrossing(curve.map((p) => ({ x: p.spot, y: p.charm })));
  const zeroVannaSpot = findZeroCrossing(curve.map((p) => ({ x: p.spot, y: p.vex })));

  // Exposures at actual current spot.
  const currentE = exposuresAt(precomputed, spot, r, q);
  const current: ExposurePoint = { spot, ...currentE };

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
    zeroVannaSpot,
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

function rangeOf(xs: number[]): { min: number; max: number } {
  return { min: Math.min(...xs), max: Math.max(...xs) };
}
