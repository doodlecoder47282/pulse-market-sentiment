/**
 * server/heatseeker.ts
 * 0DTE Heatseeker: per-strike live Greeks + sticky-zone ranking.
 *
 * Filters chain to the nearest expiry (0DTE if same-day, else next expiry),
 * aggregates GEX / DEX / Vanna / Charm per strike around spot, detects
 * sticky zones via composite score combining:
 *   - |GEX| density (dealer gamma concentration)
 *   - OI density (contract clustering)
 *   - Charm acceleration (intraday delta drift toward zero)
 *
 * Returned to the frontend every 5s (client-driven polling).
 */

import type { OptionChainResponse } from "./schwab";
import { contractYears, ivForClock } from "./chainClock";
import { contractExposure, deltaRQ } from "./greekExposure";
import {
  bsGamma, cumulativeStrikeFlip, dealerConventionSensitivity, dividendYieldFor, flipInputs, FLIP_RATE,
  repricedFlipFromRows, rowsFromChain, type DealerSensitivity, type FlipInputs,
} from "./gammaProfile";

type Chain = Exclude<OptionChainResponse, { error: string }>;

export interface HeatseekerStrike {
  strike: number;
  distancePct: number;        // % from spot
  // Per-strike Greek exposures (net = call - put, naive dealer convention:
  // dealers long calls, short puts). GEX uses Black-Scholes gamma on the
  // shared clock with the flip's r and q (same basis as the flip and
  // totals.gexAtSpotRepriced), not the vendor gamma.
  netGex: number;             // $ / 1% move
  callGex: number;            // call-side GEX (always >= 0)
  putGex: number;             // put-side GEX (always >= 0, contributes negatively to net)
  /** $ delta exposure. null = no contract at this strike has a usable delta
   *  (missing, not zero); a strike with some deltas missing sums the known ones
   *  and counts the rest in dexMissingContracts. */
  netDex: number | null;
  /** Contracts with open interest at this strike that have no usable delta. */
  dexMissingContracts?: number;
  netVanna: number;           // $ / 1% vol move
  netCharm: number;           // $ / day
  // Raw OI & volume
  callOI: number;
  putOI: number;
  totalOI: number;
  callVol: number;
  putVol: number;
  totalVol: number;
  // IV snapshot (ATM weighted)
  callIV: number | null;
  putIV: number | null;
}

export interface StickyZone {
  strike: number;
  distancePct: number;
  score: number;              // 0-100 composite
  rank: number;               // 1 = stickiest
  components: {
    gexContribution: number;  // 0-100
    oiContribution: number;   // 0-100
    charmContribution: number;// 0-100
  };
  interpretation: string;     // human-readable
}

export interface PivotBand {
  center: number;          // volume/gamma-weighted centroid — sub-strike precision
  low: number;             // tight band bounds
  high: number;
  role: "pin" | "exhaust-high" | "exhaust-low" | "accelerant" | "flip";
  strength: number;        // 0-100 composite intensity at the peak
  freshness: number;       // 0-100 — today's volume vs standing OI (fresh positioning)
  side: "above" | "below" | "at";
  distancePct: number;     // centroid distance from spot, %
  read: string;            // plain-language one-liner
}

export interface HeatseekerResult {
  symbol: string;
  spot: number;
  expiry: string;             // YYYY-MM-DD
  dte: number;                // days to expiry (0 for 0DTE)
  asOf: number;
  strikes: HeatseekerStrike[];
  stickyZones: StickyZone[];  // top 5 ranked
  pivotBands: PivotBand[];    // tight confluence bands, sorted by price
  /** "unavailable": no chain / no expiry, every total is null (missing, not 0). */
  dataState: "ok" | "unavailable";
  reason?: string | null;
  totals: {
    /** Net dealer GEX, $ per 1% move, over EVERY strike of this expiry,
     *  re-priced gamma: equals gexAtSpotRepriced, so its sign is the regime
     *  sign Trade Desk uses. null when no contract has a usable sigma. */
    netGex: number | null;
    /** Same, summed over the displayed strike window only. */
    netGexWindow?: number | null;
    netGexScope?: "full-expiry-repriced";
    netDex: number | null;
    /** "ok": every contract with OI has a delta; "partial": some missing (sum
     *  of the known ones, see dexCoverage); "unavailable": none (netDex null). */
    dexState?: "ok" | "partial" | "unavailable";
    dexCoverage?: { contractsWithDelta: number; contractsMissingDelta: number; oiMissingShare: number | null; basis: string };
    netVanna: number | null;
    netCharm: number | null;
    callWall: number | null;  // max positive GEX strike above spot
    putWall: number | null;   // max negative GEX strike below spot
    /** Gamma flip: spot level where re-priced net dealer gamma (every contract
     *  of this expiry re-priced with Black-Scholes at each hypothetical spot)
     *  changes sign, nearest current spot. Same definition as the Signals panel. */
    zeroGamma: number | null;
    /** Secondary, legacy: first strike where cumulative per-strike GEX (at
     *  today's spot) changes sign. Not a flip level; shown for reference only. */
    zeroGammaCumulative?: number | null;
    zeroGammaMethod?: "repriced-profile";
    /** Re-priced net dealer GEX at spot over the full expiry (sign = regime). */
    gexAtSpotRepriced?: number | null;
    /** Sign of gexAtSpotRepriced when material (>= 1e-6 of the profile's
     *  peak |GEX|); null = "no material gamma at spot", not long or short. */
    gexSignAtSpot?: 1 | -1 | null;
    /** The flip sits inside a valley where net gamma is ~0: its exact level is not meaningful. */
    zeroGammaInValley?: boolean;
    /** r and q of every Black-Scholes term here (GEX, vanna, charm, flip). */
    basis?: { r: number; q: number };
    /** Sign convention of netGex / netDex / netVanna / netCharm. */
    exposureConvention?: "dealer-naive: calls +, puts -";
  };
  /** Weight and universe the flip was computed from. */
  flipInputs?: FlipInputs;
  /** Net GEX and flip under alternative dealer-positioning assumptions. */
  dealerSensitivity?: DealerSensitivity;
  availableExpiries: { date: string; dte: number }[]; // every expiry present in chain
  requestedExpiry: string | null; // what the caller asked for (null = nearest auto-pick)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseExpiry(expKey: string): { date: string; dte: number } {
  // Schwab format: "YYYY-MM-DD:N" where N = days-to-expiry
  const [date, dteStr] = expKey.split(":");
  return { date, dte: parseInt(dteStr || "0", 10) };
}

function dollarMult(symbol: string): number {
  // SPX is $100 per 1.00 delta per share equivalent; equities $100/contract.
  // For notional dollar exposures we use 100 × spot × 100 for % moves.
  return 100;
}

// ─── Main builder ──────────────────────────────────────────────────────────

export function buildHeatseeker(
  chain: Chain,
  symbol: string,
  spot: number,
  targetExpiry?: string | null, // YYYY-MM-DD; null/undef = nearest
  nowMsArg?: number,            // valuation instant (tests); default now
): HeatseekerResult {
  const mult = dollarMult(symbol);

  // 1. Inventory every expiry present in chain (used for picker UI)
  const allExpKeys = new Set<string>([
    ...Object.keys(chain.callExpDateMap || {}),
    ...Object.keys(chain.putExpDateMap || {}),
  ]);

  const sortedExps = Array.from(allExpKeys)
    .map((k) => ({ key: k, ...parseExpiry(k) }))
    .sort((a, b) => a.dte - b.dte);

  const availableExpiries = sortedExps.map((e) => ({ date: e.date, dte: e.dte }));

  if (sortedExps.length === 0) {
    return {
      symbol,
      spot,
      expiry: "",
      dte: 0,
      asOf: Date.now(),
      strikes: [],
      stickyZones: [],
      pivotBands: [],
      // No chain: totals are missing (null), not zero activity.
      dataState: "unavailable",
      reason: "no expiries in the chain",
      totals: { netGex: null, netGexWindow: null, netDex: null, netVanna: null, netCharm: null, callWall: null, putWall: null, zeroGamma: null, zeroGammaCumulative: null, zeroGammaMethod: "repriced-profile", gexAtSpotRepriced: null, gexSignAtSpot: null },
      availableExpiries: [],
      requestedExpiry: targetExpiry ?? null,
    };
  }

  // 2. Pick target expiry. Caller-supplied date → exact match if present, else
  // closest available expiry by absolute calendar distance (prefer on/after when
  // distances tie). No target → nearest expiry (preserves legacy 0DTE behavior).
  let picked = sortedExps[0];
  if (targetExpiry) {
    const exact = sortedExps.find((e) => e.date === targetExpiry);
    if (exact) {
      picked = exact;
    } else {
      const target = new Date(targetExpiry + "T00:00:00Z").getTime();
      let best = sortedExps[0];
      let bestDist = Infinity;
      for (const e of sortedExps) {
        const t = new Date(e.date + "T00:00:00Z").getTime();
        const dist = Math.abs(t - target);
        // Tiebreak: prefer expiries on/after the target.
        const onAfter = t >= target;
        const bestOnAfter = new Date(best.date + "T00:00:00Z").getTime() >= target;
        if (dist < bestDist || (dist === bestDist && onAfter && !bestOnAfter)) {
          best = e;
          bestDist = dist;
        }
      }
      picked = best;
    }
  }

  const expKey = picked.key;
  const expiry = picked.date;
  const dte = picked.dte;

  // Time to expiry per CONTRACT on the one clock (server/timeToExpiry.ts via
  // chainClock): calendar minutes to the real settlement instant / 525,600,
  // AM-settled SPX vs PM SPXW, 13:00 close on half days, 15-minute floor.
  // A contract that has settled (T = 0) is dropped. Replaces dte/365 and the
  // hard-coded 16:00 close.
  const nowMs = nowMsArg ?? Date.now();
  // ONE Black-Scholes basis for every term (GEX, vanna, charm, flip): the
  // flip's rate and this underlying's dividend yield (S&P 500 index yield for
  // SPX/SPY/XSP, 0 for anything else unless known).
  const r = FLIP_RATE;
  const q = dividendYieldFor(symbol);

  // 2. Aggregate per-strike
  const strikeMap = new Map<number, HeatseekerStrike>();

  function ensure(strike: number): HeatseekerStrike {
    let s = strikeMap.get(strike);
    if (!s) {
      s = {
        strike,
        distancePct: ((strike - spot) / spot) * 100,
        netGex: 0,
        callGex: 0,
        putGex: 0,
        netDex: null,
        dexMissingContracts: 0,
        netVanna: 0,
        netCharm: 0,
        callOI: 0,
        putOI: 0,
        totalOI: 0,
        callVol: 0,
        putVol: 0,
        totalVol: 0,
        callIV: null,
        putIV: null,
      };
      strikeMap.set(strike, s);
    }
    return s;
  }

  function processSide(
    map: Record<string, Record<string, any[]>>,
    side: "call" | "put",
  ) {
    const strikesObj = map?.[expKey];
    if (!strikesObj) return;
    for (const strikeStr of Object.keys(strikesObj)) {
      const strike = parseFloat(strikeStr);
      if (!isFinite(strike)) continue;
      const contracts = strikesObj[strikeStr] || [];
      for (const c of contracts) {
        const T = contractYears(expKey, c, nowMs);
        if (!(T > 0)) continue; // settled: no risk left
        const vega = Number(c.vega) || 0;
        const theta = Number(c.theta) || 0;
        const oi = Number(c.openInterest) || 0;
        const vol = Number(c.totalVolume) || 0;
        const iv = Number(c.volatility) || 0; // Schwab uses 0-100 scale
        // sigma valid for OUR T (re-solved from the mid inside 3 days)
        const ivDec = ivForClock({
          vendorIv: iv > 0 && iv < 500 ? iv / 100 : 0,
          bid: Number(c.bid), ask: Number(c.ask), spot, strike, T, type: side === "call" ? "C" : "P",
        });

        const s = ensure(strike);

        // Naive dealer convention (SqueezeMetrics / SpotGamma): customers buy
        // puts and sell calls, so dealers are LONG call gamma and SHORT put
        // gamma. Net GEX at strike = callGEX - putGEX (positive = dealers long
        // gamma). This ignores customers who sell puts or buy calls; see
        // dealerSensitivity for how much that assumption matters.
        //
        // GEX ($ per 1% move: gamma x OI x 100 x S^2 x 0.01) uses Black-Scholes
        // gamma at OUR clock T and sigma valid for that T, with the flip's
        // r = FLIP_RATE and q = FLIP_DIV_YIELD: exactly the per-contract term
        // gammaProfile sums for gexAtSpotRepriced, so the "Net GEX" stat, the
        // per-strike bars and the Trade Desk regime sign all agree. The vendor
        // gamma (undocumented T convention; -999 sentinels when closed) is no
        // longer used.
        const g = ivDec > 0 ? bsGamma(spot, strike, ivDec, T, r, q, side === "call" ? "C" : "P") : 0;

        // Vanna and charm in $ from strike, spot, sigma and our T
        // (server/greekExposure.ts, same r and q as GEX), so the vendor's undocumented
        // delta clock is not mixed with ours. Charm is the $ delta change over
        // min(1 calendar day, T): for the 0DTE expiry Heatseeker defaults to,
        // charm/365 extrapolated the instantaneous rate past settlement.
        const x = ivDec > 0 ? contractExposure({ spot, strike, sigma: ivDec, T, contracts: oi, multiplier: mult, gamma: g, r, q, type: side === "call" ? "C" : "P" }) : null;
        const gex = x ? x.gexPerPct : 0;

        // $ delta (round 3, N2-2): Black-Scholes delta on OUR clock and sigma
        // (same basis as GEX, vanna and charm); Schwab's delta only when no
        // sigma exists and it is a real value in [-1, 1] (not absent, not the
        // -999 sentinel). Neither -> MISSING (counted), never a zero delta.
        const typeCP = side === "call" ? "C" : "P";
        const vendorDelta = c.delta != null && c.delta !== "" ? Number(c.delta) : NaN;
        const delta: number | null = ivDec > 0
          ? deltaRQ(spot, strike, ivDec, T, r, q, typeCP)
          : Number.isFinite(vendorDelta) && Math.abs(vendorDelta) <= 1 ? vendorDelta : null;
        const dexContrib: number | null = delta != null && Number.isFinite(delta) ? delta * oi * mult * spot : null;
        if (oi > 0) {
          if (dexContrib == null) { dexMissing.n++; dexMissing.oi += oi; s.dexMissingContracts = (s.dexMissingContracts ?? 0) + 1; }
          else dexMissing.known++;
        }
        dexMissing.oiTotal += oi;
        const vannaContrib = x ? x.vannaPerVolPt : 0; // $ per +1 vol point
        const charmContrib = x ? x.charmPerDay : 0;   // $ per calendar day (or to settlement)

        if (side === "call") {
          s.callOI += oi;
          s.callVol += vol;
          s.callGex += gex;
          s.netGex += gex;
          if (dexContrib != null) s.netDex = (s.netDex ?? 0) + dexContrib;
          s.netVanna += vannaContrib;
          s.netCharm += charmContrib;
          if (s.callIV === null && iv > 0) s.callIV = ivDec;
        } else {
          s.putOI += oi;
          s.putVol += vol;
          s.putGex += gex;
          // Puts contribute negatively to dealer net gamma (GEXbot convention).
          s.netGex -= gex;
          if (dexContrib != null) s.netDex = (s.netDex ?? 0) - dexContrib;
          s.netVanna -= vannaContrib;
          s.netCharm -= charmContrib;
          if (s.putIV === null && iv > 0) s.putIV = ivDec;
        }
      }
    }
  }

  const dexMissing = { n: 0, oi: 0, known: 0, oiTotal: 0 };
  processSide(chain.callExpDateMap || {}, "call");
  processSide(chain.putExpDateMap || {}, "put");

  // Full-expiry net GEX (every strike, before the display window trim).
  let netGexAll = 0;
  for (const s of Array.from(strikeMap.values())) netGexAll += s.netGex;

  // 3. Trim to strikes within an adaptive window — wider on longer-dated expiries
  // because dealer hedging clusters spread out as DTE grows.
  // 0DTE: ±5%, weekly: ±7%, monthly+: ±10%
  const windowPct = dte <= 1 ? 5 : dte <= 14 ? 7 : 10;
  const strikes = Array.from(strikeMap.values())
    .filter((s) => Math.abs(s.distancePct) <= windowPct)
    .map((s) => ({ ...s, totalOI: s.callOI + s.putOI, totalVol: s.callVol + s.putVol }))
    .sort((a, b) => a.strike - b.strike);

  // 4. Totals, walls, zero gamma
  let callWall: number | null = null;
  let putWall: number | null = null;
  let callWallVal = -Infinity;
  let putWallVal = Infinity;

  for (const s of strikes) {
    if (s.strike >= spot && s.netGex > callWallVal) {
      callWallVal = s.netGex;
      callWall = s.strike;
    }
    if (s.strike <= spot && s.netGex < putWallVal) {
      putWallVal = s.netGex;
      putWall = s.strike;
    }
  }

  // Gamma flip — ONE definition app-wide: re-price every contract of this
  // expiry (all strikes, not just the display window) at hypothetical spots
  // across the window and take the zero crossing of net dealer gamma nearest
  // spot (gammaProfile.ts). Same per-contract clock as the greeks above
  // (rowsFromChain defaults to chainClock.contractYears).
  const flipRows = rowsFromChain(chain, { expiryKeys: [expKey], spot, nowMs });
  const flipOpts = {
    r,
    q,
    lowPct: 1 - windowPct / 100,
    highPct: 1 + windowPct / 100,
    nLevels: 121,
    nowMs,
  };
  const flip = repricedFlipFromRows(flipRows, spot, flipOpts);
  const zeroGamma: number | null = flip.rowsUsed > 0 ? flip.zeroGamma : null;
  const dealerSensitivity = dealerConventionSensitivity(flipRows, spot, flipOpts);
  // Legacy cumulative-by-strike number, kept as a labeled secondary only.
  const zeroGammaCumulative = cumulativeStrikeFlip(strikes);

  const priced = flip.rowsUsed > 0;
  const totals = {
    netGex: priced ? netGexAll : null,
    netGexWindow: priced ? strikes.reduce((a, s) => a + s.netGex, 0) : null,
    netGexScope: "full-expiry-repriced" as const,
    // Empty display window, or no delta anywhere: missing (null), not a zero total.
    netDex: strikes.some((s) => s.netDex != null) ? strikes.reduce((a, s) => a + (s.netDex ?? 0), 0) : null,
    dexState: (dexMissing.known === 0 && dexMissing.n > 0) || !strikes.some((s) => s.netDex != null)
      ? "unavailable" as const
      : dexMissing.n > 0 ? "partial" as const : "ok" as const,
    dexCoverage: {
      contractsWithDelta: dexMissing.known,
      contractsMissingDelta: dexMissing.n,
      oiMissingShare: dexMissing.oiTotal > 0 ? dexMissing.oi / dexMissing.oiTotal : null,
      basis: "Black-Scholes delta on the shared clock (vendor delta only without a sigma); expiry-wide counts",
    },
    netVanna: strikes.length ? strikes.reduce((a, s) => a + s.netVanna, 0) : null,
    netCharm: strikes.length ? strikes.reduce((a, s) => a + s.netCharm, 0) : null,
    callWall,
    putWall,
    zeroGamma,
    zeroGammaCumulative,
    zeroGammaMethod: "repriced-profile" as const,
    gexAtSpotRepriced: flip.rowsUsed > 0 ? flip.gexAtSpot : null,
    gexSignAtSpot: flip.gexSignAtSpot ?? null,
    zeroGammaInValley: flip.zeroGammaInValley ?? false,
    basis: { r, q },
    exposureConvention: "dealer-naive: calls +, puts -" as const,
  };

  // 5. Sticky-zone composite score
  const maxAbsGex = Math.max(...strikes.map((s) => Math.abs(s.netGex)), 1);
  const maxOI = Math.max(...strikes.map((s) => s.totalOI), 1);
  const maxAbsCharm = Math.max(...strikes.map((s) => Math.abs(s.netCharm)), 1);

  const scored = strikes.map((s) => {
    const gexContribution = (Math.abs(s.netGex) / maxAbsGex) * 100;
    const oiContribution = (s.totalOI / maxOI) * 100;
    const charmContribution = (Math.abs(s.netCharm) / maxAbsCharm) * 100;
    // Weight: GEX 50%, OI 30%, Charm 20%
    const score = gexContribution * 0.5 + oiContribution * 0.3 + charmContribution * 0.2;

    let interpretation = "";
    if (s.netGex > 0 && s.totalOI > maxOI * 0.5) {
      interpretation = "Dealer long-gamma pin — suppresses moves through this strike";
    } else if (s.netGex < 0 && s.totalOI > maxOI * 0.5) {
      interpretation = "Negative gamma — accelerant strike, breakouts amplify here";
    } else if (charmContribution > 70) {
      interpretation = "Charm magnet — delta drift pulls price toward this level late in day";
    } else if (oiContribution > 70) {
      interpretation = "Heavy OI cluster — potential magnet or battleground";
    } else {
      interpretation = "Moderate sticky factor";
    }

    return {
      strike: s.strike,
      distancePct: s.distancePct,
      score,
      rank: 0,
      components: { gexContribution, oiContribution, charmContribution },
      interpretation,
    };
  });

  const stickyZones = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((z, i) => ({ ...z, rank: i + 1 }));

  // 6. Pivot bands — tight, defined levels with sub-strike precision.
  //
  // Sticky zones answer "which strikes matter". Pivot bands answer "exactly
  // where does price stall or accelerate" — by finding local peaks of a
  // composite intensity (gamma notional 45%, today's volume 25%, OI 15%,
  // charm 15%), then computing a volume+gamma-weighted centroid across the
  // peak and its adjacent strikes. Band width = weighted dispersion around
  // the centroid, clamped tight (0DTE: max ±0.12% of spot).
  const maxVol = Math.max(...strikes.map((s) => s.totalVol), 1);
  const intensity = strikes.map((s) =>
    (Math.abs(s.netGex) / maxAbsGex) * 45 +
    (s.totalVol / maxVol) * 25 +
    (s.totalOI / maxOI) * 15 +
    (Math.abs(s.netCharm) / maxAbsCharm) * 15,
  );

  const maxBandHalf = spot * (dte <= 1 ? 0.0012 : dte <= 14 ? 0.0025 : 0.005);
  const minBandHalf = spot * 0.0003;

  const rawBands: PivotBand[] = [];
  for (let i = 0; i < strikes.length; i++) {
    const iv = intensity[i];
    if (iv < 22) continue;
    const prev = intensity[i - 1] ?? -1;
    const next = intensity[i + 1] ?? -1;
    if (iv < prev || iv < next) continue; // local peak only

    // Weighted centroid across peak ±1 strike — weight blends intensity with
    // today's volume so fresh flow drags the pivot toward where it's trading.
    let wSum = 0, cSum = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(strikes.length - 1, i + 1); j++) {
      const w = intensity[j] * (1 + strikes[j].totalVol / maxVol);
      wSum += w;
      cSum += strikes[j].strike * w;
    }
    const center = wSum > 0 ? cSum / wSum : strikes[i].strike;
    let varSum = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(strikes.length - 1, i + 1); j++) {
      const w = intensity[j] * (1 + strikes[j].totalVol / maxVol);
      varSum += w * (strikes[j].strike - center) ** 2;
    }
    const spread = wSum > 0 ? Math.sqrt(varSum / wSum) : 0;
    const half = Math.min(maxBandHalf, Math.max(minBandHalf, spread * 0.6));

    const s = strikes[i];
    const distPct = ((center - spot) / spot) * 100;
    const side: PivotBand["side"] = Math.abs(distPct) < 0.05 ? "at" : distPct > 0 ? "above" : "below";
    const freshness = Math.round(Math.min(100, (s.totalVol / Math.max(1, s.totalOI)) * 50));

    let role: PivotBand["role"];
    if (zeroGamma !== null && Math.abs(s.strike - zeroGamma) < spot * 0.001) role = "flip";
    else if (s.netGex < 0) role = "accelerant";
    else if (side === "at") role = "pin";
    else if (side === "above") role = "exhaust-high";
    else role = "exhaust-low";

    const c = center.toFixed(1);
    const read =
      role === "flip" ? `gamma flips sign near ${c} — crossing it changes the whole tape from damped to amplified` :
      role === "accelerant" ? `dealers are short gamma at ${c} — a push through this band speeds up, don't fade the first touch` :
      role === "pin" ? `heavy long-gamma directly ${side === "at" ? "at spot" : "nearby"} — price gets pulled back to ${c}, moves away stall` :
      role === "exhaust-high" ? `rallies run out of fuel into ${c} — dealers sell here; look for volume exhaustion before fading` :
      `flushes find a floor near ${c} — dealers buy here; watch for the bounce unless volume keeps expanding`;

    rawBands.push({
      center: Math.round(center * 10) / 10,
      low: Math.round((center - half) * 10) / 10,
      high: Math.round((center + half) * 10) / 10,
      role,
      strength: Math.round(iv),
      freshness,
      side,
      distancePct: Math.round(distPct * 100) / 100,
      read,
    });
  }

  // Merge overlapping bands (keep the stronger), cap at 7 closest to spot.
  rawBands.sort((a, b) => b.strength - a.strength);
  const merged: PivotBand[] = [];
  for (const b of rawBands) {
    if (merged.some((m) => b.low <= m.high && b.high >= m.low)) continue;
    merged.push(b);
  }
  const pivotBands = merged
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, 7)
    .sort((a, b) => b.center - a.center);

  return {
    symbol,
    spot,
    expiry,
    dte,
    asOf: Date.now(),
    strikes,
    stickyZones,
    pivotBands,
    dataState: strikes.length > 0 ? "ok" : "unavailable",
    reason: strikes.length > 0 ? null : "no strikes with data inside the display window",
    totals,
    flipInputs: flipInputs({ weight: "open_interest", universe: "single-expiry", expiryKeys: [expKey] }),
    dealerSensitivity,
    availableExpiries,
    requestedExpiry: targetExpiry ?? null,
  };
}
