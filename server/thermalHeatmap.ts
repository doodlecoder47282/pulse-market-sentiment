// server/thermalHeatmap.ts
//
// Dealer greek exposure by strike and expiry for the Thermal heatmap. Pure:
// takes a Schwab option chain (callExpDateMap / putExpDateMap as Schwab
// returns them) and spot, returns the grid the client draws. The route
// (/api/heatmap/thermal) only fetches the chain and calls buildThermalHeatmap.
//
// Method, with the choices stated so the panel can show them:
//   position   open interest ONLY (Schwab openInterest). OCC publishes OI once
//              a day, the morning after each session, so the map shows
//              positions as of the prior close marked at today's spot and
//              vol. Today's volume is NOT blended in: volume is traded
//              contracts, not net dealer exposure (Cboe, "Evaluating the
//              market impact of SPX 0DTE options"; SpotGamma, "Gamma
//              exposure (GEX)"). It is reported per cell for context.
//   dealer sign +1 per call contract, -1 per put contract: the SqueezeMetrics
//              convention (dealers long calls, short puts). This is a modeled
//              assumption, not observed positioning; vendors disagree (Options
//              Analysis Suite assumes the reverse) and Cboe's tagged 0DTE data
//              found market-maker flow close to balanced. The payload carries
//              the convention so the client can say so.
//   greeks     Black-Scholes on one clock for every greek: T = calendar time
//              to the contract's settlement instant (chainClock.contractYears:
//              AM-settled SPX vs PM SPXW, half days), sigma = the vendor IV,
//              re-solved from the mid inside 3 days (chainClock.ivForClock),
//              r = FLIP_RATE, q = the symbol's dividend yield. The gamma flip
//              uses the same basis (gammaProfile.repricedFlipFromChain), so
//              the flip line and the cells agree. A contract with no usable
//              sigma (Schwab's -999 closed-market sentinel, or no vendor IV
//              and no quote to re-solve from) is NOT priced: vendor gamma on
//              an undocumented clock would put one number on a different
//              basis from the rest, and the sentinel itself would price as
//              -999. Such contracts are counted (method.contractsNoSigma).
//   units      gex   $ change in dealer delta notional per 1% spot move
//                    = gamma x OI x 100 x S^2 x 0.01 (gammaProfile.dollarGexPerPct)
//              vanna $ delta per +1 vol point; charm $ delta over min(1 day, T);
//              vomma $ vega per +1 vol point; zomma $ GEX per +1 vol point
//              (greekExposure.contractExposure).
//   grid       strikes within +-15% of spot; the 12 nearest expiries.
//   levels     call wall = largest positive strike total at or above spot;
//              put wall = most negative strike total at or below spot;
//              gamma flip = re-priced zero crossing nearest spot.

import { contractYears, ivForClock } from "./chainClock";
import { gamma as bsGamma } from "./greeks";
import { contractExposure } from "./greekExposure";
import { dividendYieldFor, dollarGexPerPct, flipInputs, FLIP_RATE, repricedFlipFromChain, type FlipInputs } from "./gammaProfile";

export type ThermalGreek = "gex" | "vanna" | "charm" | "vomma" | "zomma";
export const THERMAL_GREEKS: readonly ThermalGreek[] = ["gex", "vanna", "charm", "vomma", "zomma"];

export interface ThermalCell {
  expIdx: number;
  strikeIdx: number;
  expiry: string;
  dte: number;
  strike: number;
  /** The selected greek's exposure (same number as the matching field below). */
  exposure: number;
  gex: number;
  vanna: number;
  charm: number;
  vomma: number;
  zomma: number;
  callOI: number;
  putOI: number;
  /** Contracts traded today (Schwab totalVolume), context only: not in any exposure. */
  callVolume: number;
  putVolume: number;
}

export interface ThermalExpiry {
  label: string;
  dte: number;
  /** Largest |exposure| in this column, for per-date shading and its legend. */
  maxAbs: number;
}

export interface ThermalHeatmap {
  symbol: string;
  asOf: number;
  spot: number;
  greek: ThermalGreek;
  /** Always "oi": kept for older clients that showed the mode. */
  weightMode: "oi";
  strikes: number[];
  expiries: ThermalExpiry[];
  cells: ThermalCell[];
  maxAbs: number;
  strikeTotals: Array<{ strike: number; total: number; totalAbs: number }>;
  levels: { callWall: number | null; callWallValue: number; putWall: number | null; putWallValue: number; gammaFlip: number | null };
  flipInputs: FlipInputs;
  /** What the numbers assume, for the panel's legend. */
  method: {
    position: "open_interest";
    positionAsOf: "prior_close";
    dealerSign: { call: 1; put: -1 };
    dealerSignNote: string;
    greeks: "black_scholes_one_clock";
    r: number;
    q: number;
    units: Record<ThermalGreek, string>;
    strikeBandPct: number;
    maxExpiries: number;
    /** Contracts with open interest that were priced into the grid. */
    contractsUsed: number;
    /** Contracts skipped because they had no open interest (volume-only rows are not exposure). */
    contractsWithoutOI: number;
    /** Contracts with OI whose settlement instant has passed (T <= 0). */
    contractsSettled: number;
    /** Contracts with OI and time left but no usable implied vol (Schwab -999 sentinel, no quote). */
    contractsNoSigma: number;
  };
  /** "ok": priced cells; "no_iv": OI present but Schwab gave no implied vols (closed market); "empty": nothing with OI. */
  dataState: "ok" | "no_iv" | "empty";
  reason: string | null;
  source: string;
}

export interface ThermalOptions {
  nowMs?: number;
  /** Rate and dividend yield (decimal); default FLIP_RATE and dividendYieldFor(symbol). */
  r?: number;
  q?: number;
  strikeBandPct?: number;
  maxExpiries?: number;
}

export const THERMAL_STRIKE_BAND_PCT = 0.15;
export const THERMAL_MAX_EXPIRIES = 12;
export const DEALER_SIGN_NOTE =
  "Dealers assumed long every call and short every put (SqueezeMetrics convention). Modeled, not observed: vendors disagree and Cboe's tagged 0DTE data found market-maker flow close to balanced.";

export const THERMAL_UNITS: Record<ThermalGreek, string> = {
  gex: "$ change in dealer delta notional per 1% move in spot",
  vanna: "$ change in dealer delta notional per +1 implied-vol point",
  charm: "$ change in dealer delta notional over one day (or to settlement inside a day), spot and vol unchanged",
  vomma: "$ change in dealer vega (per vol point) per +1 implied-vol point",
  zomma: "$ change in GEX (per 1% move) per +1 implied-vol point",
};

type Cell = { gex: number; vanna: number; charm: number; vomma: number; zomma: number; callOI: number; putOI: number; callVolume: number; putVolume: number; unpricedOI: number };

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Parses "YYYY-MM-DD:N" into its DTE; the label is the date part. */
export function expiryKeyParts(key: string): { label: string; dte: number } {
  const [label, dteStr] = key.split(":");
  const dte = parseFloat(dteStr ?? "");
  return { label: label ?? key, dte: Number.isFinite(dte) ? dte : 30 };
}

export function buildThermalHeatmap(
  chain: { callExpDateMap?: Record<string, Record<string, any[]>>; putExpDateMap?: Record<string, Record<string, any[]>>; source?: string },
  symbol: string,
  spot: number,
  greek: ThermalGreek,
  opts: ThermalOptions = {},
): ThermalHeatmap {
  const nowMs = opts.nowMs ?? Date.now();
  const r = opts.r ?? FLIP_RATE;
  const q = opts.q ?? dividendYieldFor(symbol);
  const bandPct = opts.strikeBandPct ?? THERMAL_STRIKE_BAND_PCT;
  const maxExpiries = opts.maxExpiries ?? THERMAL_MAX_EXPIRIES;

  const matrix = new Map<string, Map<number, Cell>>();
  let contractsWithoutOI = 0;
  let contractsUsed = 0;
  let contractsSettled = 0;
  let contractsNoSigma = 0;

  const getCell = (ek: string, k: number): Cell => {
    let em = matrix.get(ek);
    if (!em) { em = new Map(); matrix.set(ek, em); }
    let c = em.get(k);
    if (!c) { c = { gex: 0, vanna: 0, charm: 0, vomma: 0, zomma: 0, callOI: 0, putOI: 0, callVolume: 0, putVolume: 0, unpricedOI: 0 }; em.set(k, c); }
    return c;
  };

  const passes: Array<{ side: "C" | "P"; map: Record<string, Record<string, any[]>> }> = [
    { side: "C", map: chain.callExpDateMap ?? {} },
    { side: "P", map: chain.putExpDateMap ?? {} },
  ];
  for (const { side, map } of passes) {
    for (const ek of Object.keys(map)) {
      for (const sk of Object.keys(map[ek] ?? {})) {
        const strike = parseFloat(sk);
        if (!Number.isFinite(strike) || strike <= 0) continue;
        for (const c of map[ek][sk] ?? []) {
          const oi = Math.max(0, Math.round(num(c?.openInterest)));
          const vol = Math.max(0, Math.round(num(c?.totalVolume)));
          if (oi === 0 && vol === 0) continue;
          // One clock: calendar time to this contract's settlement instant; settled -> no cell.
          const T = contractYears(ek, c, nowMs);
          if (!(T > 0)) { if (oi > 0) contractsSettled++; continue; }
          const cell = getCell(ek, strike);
          if (side === "C") cell.callVolume += vol; else cell.putVolume += vol;
          if (oi === 0) { contractsWithoutOI++; continue; }
          const ivPct = num(c?.volatility);
          const sigma = ivForClock({
            vendorIv: ivPct > 0 && ivPct < 500 ? ivPct / 100 : 0,
            bid: num(c?.bid), ask: num(c?.ask), spot, strike, T, type: side, r, q,
          });
          if (!(sigma > 0)) { contractsNoSigma++; cell.unpricedOI += oi; continue; }
          const gamma = bsGamma(spot, strike, sigma, T, r, q);
          if (side === "C") cell.callOI += oi; else cell.putOI += oi;
          contractsUsed++;
          const sign = side === "C" ? 1 : -1;
          cell.gex += sign * dollarGexPerPct(gamma, oi, spot);
          const x = contractExposure({ spot, strike, sigma, T, contracts: oi, r, q, type: side });
          cell.vanna += sign * x.vannaPerVolPt;
          cell.charm += sign * x.charmPerDay;
          cell.vomma += sign * x.vommaPerVolPt;
          cell.zomma += sign * x.zommaPerVolPt;
        }
      }
    }
  }

  // Expiries with at least one live cell, nearest first, capped; strikes only
  // from the expiries shown (a strike seen only in a hidden expiry or on a
  // settled contract is not an observed zero).
  const expiryList = Array.from(matrix.entries())
    .filter(([, em]) => em.size > 0)
    .map(([key]) => ({ key, ...expiryKeyParts(key) }))
    .sort((a, b) => a.dte - b.dte)
    .slice(0, maxExpiries);
  const strikeSet = new Set<number>();
  for (const e of expiryList) matrix.get(e.key)!.forEach((_cell, k) => strikeSet.add(k));
  const strikes = Array.from(strikeSet)
    .filter((s) => s >= spot * (1 - bandPct) && s <= spot * (1 + bandPct))
    .sort((a, b) => a - b);

  const cells: ThermalCell[] = [];
  const colMax = new Array<number>(expiryList.length).fill(0);
  let maxAbs = 0;
  expiryList.forEach((exp, ei) => {
    const em = matrix.get(exp.key);
    if (!em) return;
    strikes.forEach((strike, si) => {
      const cell = em.get(strike);
      if (!cell) return;
      // A traded contract with missing IV is unknown, not a zero-height node.
      if (cell.unpricedOI > 0 && cell.callOI + cell.putOI === 0) return;
      if (cell.callOI + cell.putOI === 0 && cell.callVolume + cell.putVolume === 0) return;
      const exposure = cell[greek] || 0;
      const a = Math.abs(exposure);
      if (a > maxAbs) maxAbs = a;
      if (a > colMax[ei]) colMax[ei] = a;
      cells.push({
        expIdx: ei, strikeIdx: si, expiry: exp.label, dte: exp.dte, strike, exposure,
        gex: cell.gex, vanna: cell.vanna, charm: cell.charm, vomma: cell.vomma, zomma: cell.zomma,
        callOI: cell.callOI, putOI: cell.putOI, callVolume: cell.callVolume, putVolume: cell.putVolume,
      });
    });
  });

  // Per-strike totals over the expiries shown (the side rail reads the same grid as the cells).
  const shown = new Set(expiryList.map((e) => e.key));
  const strikeTotals = strikes.map((strike) => {
    let total = 0, totalAbs = 0;
    matrix.forEach((em, ek) => {
      if (!shown.has(ek)) return;
      const cell = em.get(strike);
      if (cell) { const v = cell[greek] || 0; total += v; totalAbs += Math.abs(v); }
    });
    return { strike, total, totalAbs };
  });

  let callWall: number | null = null, callWallValue = 0;
  let putWall: number | null = null, putWallValue = 0;
  let gammaFlip: number | null = null;
  if (greek === "gex") {
    for (const st of strikeTotals) {
      if (st.strike >= spot && st.total > callWallValue) { callWallValue = st.total; callWall = st.strike; }
      if (st.strike <= spot && st.total < putWallValue) { putWallValue = st.total; putWall = st.strike; }
    }
    gammaFlip = repricedFlipFromChain(chain as any, spot, {
      r, q, nowMs,
      expiryKeys: expiryList.map((e) => e.key),
      weight: (c: any) => Math.max(0, Math.round(num(c?.openInterest))),
    }).zeroGamma;
  }

  return {
    symbol,
    asOf: nowMs,
    spot,
    greek,
    weightMode: "oi",
    strikes,
    expiries: expiryList.map((e, i) => ({ label: e.label, dte: e.dte, maxAbs: colMax[i] })),
    cells,
    maxAbs,
    strikeTotals,
    levels: { callWall, callWallValue, putWall, putWallValue, gammaFlip },
    flipInputs: flipInputs({ weight: "open_interest", universe: "all-expiries-in-request", expiryKeys: expiryList.map((e) => e.key) }),
    method: {
      position: "open_interest",
      positionAsOf: "prior_close",
      dealerSign: { call: 1, put: -1 },
      dealerSignNote: DEALER_SIGN_NOTE,
      greeks: "black_scholes_one_clock",
      r, q,
      units: THERMAL_UNITS,
      strikeBandPct: bandPct,
      maxExpiries,
      contractsUsed,
      contractsWithoutOI,
      contractsSettled,
      contractsNoSigma,
    },
    dataState: contractsUsed > 0 ? "ok" : contractsNoSigma > 0 ? "no_iv" : "empty",
    reason: contractsUsed > 0 ? null
      : contractsNoSigma > 0 ? `Schwab gave no implied vols for ${contractsNoSigma} contracts with open interest (closed market); exposure cannot be priced`
      : "no contracts with open interest in this chain",
    source: chain.source ?? "schwab",
  };
}
