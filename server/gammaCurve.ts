// Full Gamma Curve Analyzer
// Consumes per-strike GEX (already computed via computeGEXFromChain) and surfaces
// the stuff retail tools don't show: gamma walls, vacuum zones, asymmetry, magnetism.

import { getOptionChain, computeGEXFromChain } from "./schwab";

export interface CurveStrike {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  absGex: number;
}

export interface GammaWall {
  strike: number;
  netGex: number;
  callGex: number;
  putGex: number;
  distancePct: number;       // % from spot
  rank: number;              // 1 = largest |GEX|
  type: "call_wall" | "put_wall" | "magnet";
}

export interface VacuumZone {
  loStrike: number;
  hiStrike: number;
  midStrike: number;
  width: number;             // strikes
  totalAbsGex: number;       // tiny by definition
  distancePct: number;
}

export interface AsymmetrySummary {
  positiveGexAbove: number;   // sum of positive net GEX above spot
  negativeGexAbove: number;
  positiveGexBelow: number;
  negativeGexBelow: number;
  netAbove: number;
  netBelow: number;
  asymmetryRatio: number | null;     // netAbove / |netBelow| — >1 means dealers more "long gamma" up
  bias: "damping-above" | "amplifying-below" | "balanced" | "amplifying-above" | "damping-below";
  biasNote: string;
}

export interface GammaCurveResult {
  symbol: string;
  spot: number;
  asOf: number;
  strikes: CurveStrike[];     // sorted ascending
  walls: GammaWall[];          // top 6 by |netGex|
  vacuums: VacuumZone[];       // top 3 lowest-density gaps near spot
  asymmetry: AsymmetrySummary;
  zeroGamma: number | null;    // re-priced gamma flip (gammaProfile.ts), app-wide definition
  zeroGammaCumulative?: number | null; // secondary: cumulative-by-strike sign change (legacy)
  zeroGammaMethod?: "repriced-profile";
  source: "schwab";
}

export async function buildGammaCurve(symbol: string): Promise<GammaCurveResult | { error: string }> {
  const chain = await getOptionChain(symbol, 45);
  if (!chain || "error" in chain) {
    return { error: "chain unavailable" };
  }
  const gex = computeGEXFromChain(chain as any);
  // No underlying last price: GEX is unavailable (computeGEXFromChain no
  // longer substitutes spot = 1), not a curve of near-zero values.
  if (gex.dataState === "no_spot") {
    return { error: "spot unavailable" };
  }
  const spot = (chain as any).underlying?.last ?? (chain as any).underlyingPrice ?? null;
  if (!gex.profile?.length || !Number.isFinite(spot)) {
    return { error: "insufficient chain data" };
  }

  const strikes: CurveStrike[] = (gex.profile as any[]).map(p => ({
    strike: p.strike,
    callGex: p.callGex,
    putGex: p.putGex,
    netGex: p.netGex,
    absGex: Math.abs(p.netGex),
  })).sort((a, b) => a.strike - b.strike);

  // ----- Walls (top 6 |netGex|) -----
  const ranked = [...strikes].sort((a, b) => b.absGex - a.absGex);
  const walls: GammaWall[] = ranked.slice(0, 6).map((s, i) => {
    const distPct = ((s.strike - spot) / spot) * 100;
    let type: GammaWall["type"];
    if (s.netGex > 0 && s.strike > spot) type = "call_wall";
    else if (s.netGex < 0 && s.strike < spot) type = "put_wall";
    else type = "magnet";
    return {
      strike: s.strike,
      netGex: s.netGex,
      callGex: s.callGex,
      putGex: s.putGex,
      distancePct: distPct,
      rank: i + 1,
      type,
    };
  });

  // ----- Vacuum zones (3 thinnest contiguous regions within ±5% of spot) -----
  // Slide a 5-strike window, total |netGex| inside, lowest = vacuum.
  const near = strikes.filter(s => Math.abs((s.strike - spot) / spot) <= 0.06);
  const vacuums: VacuumZone[] = [];
  if (near.length >= 5) {
    const win = 5;
    const candidates: VacuumZone[] = [];
    for (let i = 0; i <= near.length - win; i++) {
      const seg = near.slice(i, i + win);
      const total = seg.reduce((a, s) => a + s.absGex, 0);
      const lo = seg[0].strike;
      const hi = seg[seg.length - 1].strike;
      const mid = (lo + hi) / 2;
      candidates.push({
        loStrike: lo, hiStrike: hi, midStrike: mid,
        width: hi - lo,
        totalAbsGex: total,
        distancePct: ((mid - spot) / spot) * 100,
      });
    }
    // pick 3 lowest-density
    candidates.sort((a, b) => a.totalAbsGex - b.totalAbsGex);
    vacuums.push(...candidates.slice(0, 3));
  }

  // ----- Asymmetry -----
  let posAbove = 0, negAbove = 0, posBelow = 0, negBelow = 0;
  for (const s of strikes) {
    if (s.strike >= spot) {
      if (s.netGex > 0) posAbove += s.netGex; else negAbove += s.netGex;
    } else {
      if (s.netGex > 0) posBelow += s.netGex; else negBelow += s.netGex;
    }
  }
  const netAbove = posAbove + negAbove;
  const netBelow = posBelow + negBelow;
  const denom = Math.abs(netBelow);
  // Infinity does not survive JSON (it became null and the client's toFixed threw): no ratio when there is no net gamma below.
  const asymmetryRatio: number | null = denom > 0 ? netAbove / denom : null;

  // Names say what the gamma is, in the model's terms: positive dealer gamma damps moves into it,
  // negative amplifies them. (The old "compression-down" named heavy NEGATIVE gamma below spot, which the
  // model describes as amplifying, and "vacuum-down" named POSITIVE gamma below, which it describes as damping.)
  let bias: AsymmetrySummary["bias"] = "balanced";
  let biasNote = "";
  if (Math.abs(netAbove) > 2 * Math.abs(netBelow) && netAbove > 0) {
    bias = "damping-above";
    biasNote = "heavy positive gamma above spot: in the model, dealer hedging damps moves up into it";
  } else if (Math.abs(netBelow) > 2 * Math.abs(netAbove) && netBelow < 0) {
    bias = "amplifying-below";
    biasNote = "heavy negative gamma below spot: in the model, dealer hedging amplifies moves down into it";
  } else if (netAbove < 0 && Math.abs(netAbove) > Math.abs(netBelow)) {
    bias = "amplifying-above";
    biasNote = "negative gamma above spot: in the model, dealer hedging amplifies moves up into it";
  } else if (netBelow > 0 && Math.abs(netBelow) > Math.abs(netAbove)) {
    bias = "damping-below";
    biasNote = "positive gamma below spot: in the model, dealer hedging damps moves down into it";
  } else {
    biasNote = "roughly balanced gamma above and below spot";
  }

  return {
    symbol: symbol.toUpperCase(),
    spot,
    asOf: Date.now(),
    strikes,
    walls,
    vacuums,
    asymmetry: {
      positiveGexAbove: posAbove,
      negativeGexAbove: negAbove,
      positiveGexBelow: posBelow,
      negativeGexBelow: negBelow,
      netAbove, netBelow,
      asymmetryRatio,
      bias,
      biasNote,
    },
    // One flip definition everywhere: computeGEXFromChain returns the
    // re-priced flip (every contract <=45 DTE re-priced across +/-10% of spot,
    // crossing nearest spot -- gammaProfile.ts); the cumulative-by-strike
    // number is the labeled secondary.
    zeroGamma: gex.zeroGamma ?? null,
    zeroGammaCumulative: gex.zeroGammaCumulative ?? null,
    zeroGammaMethod: "repriced-profile",
    source: "schwab",
  };
}
