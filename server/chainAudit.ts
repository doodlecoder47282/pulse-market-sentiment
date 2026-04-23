/**
 * server/chainAudit.ts
 * 10 institutional-grade SPX option chain computations.
 * Consumes raw Schwab OptionChainResponse and returns a typed ChainAuditResult.
 *
 * Computations:
 *  1. DEX (Delta Exposure) profile
 *  2. Live Vanna Exposure
 *  3. Live Charm Exposure
 *  4. IV Skew per expiry (25-delta skew)
 *  5. Term Structure (ATM IV by DTE)
 *  6. Unusual Volume Detection (volOiRatio > 2.0)
 *  7. Dealer Positioning Score (-100..+100)
 *  8. GEX Decay Ladder by DTE bucket
 *  9. Pinning Probability (nearest expiry)
 * 10. Vol Risk Premium (VRP)
 */

import type { OptionChainResponse } from "./schwab";

// ─── Internal contract shape ──────────────────────────────────────────────────

interface Contract {
  strike: number;
  side: "call" | "put";
  expiry: string;              // "YYYY-MM-DD"
  dte: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  iv: number;                  // Schwab "volatility" field (0-100 scale, we normalise to 0-1)
  theoreticalIV: number | null;
  oi: number;
  volume: number;
  mark: number;
  last: number;
  bid: number;
  ask: number;
  inTheMoney: boolean;
}

// ─── Public result types ──────────────────────────────────────────────────────

export interface DEXStrike {
  strike: number;
  callDex: number;
  putDex: number;
  netDex: number;
}

export interface DEXResult {
  profile: DEXStrike[];
  maxPositive: { strike: number; value: number } | null;
  maxNegative: { strike: number; value: number } | null;
  flipStrike: number | null;  // cumulative net DEX flips sign from spot upward
  totalCallDex: number;
  totalPutDex: number;
  totalNetDex: number;
}

export interface VannaStrike {
  strike: number;
  vannaExposure: number;
}

export interface VannaResult {
  profile: VannaStrike[];
  peakVannaStrike: number | null;
  totalVannaDollarPerVolPct: number;  // $ per 1% vol move
}

export interface CharmStrike {
  strike: number;
  charmExposure: number;
}

export interface CharmResult {
  profile: CharmStrike[];
  peakCharmStrike: number | null;
  totalCharmPerDay: number;
}

export interface SkewEntry {
  expiry: string;
  dte: number;
  put25IV: number | null;
  call25IV: number | null;
  atmIV: number | null;
  skew: number | null;         // putIV - callIV
  elevatedFear: boolean;
}

export interface TermStructureEntry {
  expiry: string;
  dte: number;
  atmIV: number | null;
}

export interface TermStructureResult {
  term: TermStructureEntry[];
  contango: boolean | null;
  steepness: number | null;    // back - front in vol points
}

export interface UnusualContract {
  symbol: string;
  strike: number;
  side: "call" | "put";
  expiry: string;
  dte: number;
  volume: number;
  oi: number;
  volOiRatio: number;
  lastPrice: number;
  dollarVolume: number;
  deltaNotional: number;
}

export interface DealerScoreResult {
  score: number;               // -100..+100
  rawLong: number;
  rawShort: number;
  regime: "long_gamma" | "short_gamma" | "neutral";
}

export interface GEXBucket {
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  totalGex: number;
  contractCount: number;
}

export interface GEXDecayResult {
  zerodte: GEXBucket;
  short: GEXBucket;     // 1-2 DTE
  weekly: GEXBucket;    // 3-7 DTE
  monthly: GEXBucket;   // 8+ DTE
  combined: GEXBucket;
}

export interface PinStrike {
  strike: number;
  prob: number;             // percentage 0-100
  distance: number;         // points from spot
}

export interface VRPEntry {
  expiry: string;
  dte: number;
  marketIV: number | null;
  theoreticalIV: number | null;
  vrp: number | null;       // theoreticalIV - marketIV
  signal: "sell_vol" | "buy_vol" | "neutral" | "n/a";
}

export interface ChainAuditResult {
  // 1
  dex: DEXResult;
  // 2
  vanna: VannaResult;
  // 3
  charm: CharmResult;
  // 4
  skew: SkewEntry[];
  // 5
  termStructure: TermStructureResult;
  // 6
  unusualVolume: UnusualContract[];
  // 7
  dealerScore: DealerScoreResult;
  // 8
  gexDecay: GEXDecayResult;
  // 9
  pinning: PinStrike[];
  // 10
  vrp: VRPEntry[];

  // Metadata
  contractsProcessed: number;
  expiriesFound: number;
  dataQuality: "full" | "partial" | "minimal";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert Schwab expiry key like "2025-05-16:5" → "2025-05-16" */
function parseExpiryKey(key: string): string {
  return key.split(":")[0];
}

/** Parse DTE from expiry string "YYYY-MM-DD" vs today */
function parseDTE(expiryDate: string): number {
  const now = new Date();
  const exp = new Date(expiryDate + "T16:00:00-05:00"); // treat as 4pm ET
  const diff = (exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff));
}

/** Safe divide */
function safeDivide(a: number, b: number): number {
  if (b === 0 || !isFinite(b)) return 0;
  return a / b;
}

/** Normalise Schwab IV from percentage (e.g. 22.5) to decimal (0.225) */
function normIV(rawIV: number | null | undefined): number {
  if (rawIV == null || !isFinite(rawIV) || rawIV <= 0) return 0;
  // Schwab returns volatility as a percentage (e.g. 22.5 = 22.5%)
  return rawIV > 2 ? rawIV / 100 : rawIV;
}

// ─── Extract contracts from Schwab chain maps ─────────────────────────────────

function extractContracts(
  callExpDateMap: Record<string, Record<string, any[]>>,
  putExpDateMap: Record<string, Record<string, any[]>>,
): Contract[] {
  const contracts: Contract[] = [];

  function processMap(map: Record<string, Record<string, any[]>>, side: "call" | "put") {
    for (const expKey of Object.keys(map)) {
      const expiry = parseExpiryKey(expKey);
      const dte = parseDTE(expiry);
      const strikesObj = map[expKey];
      for (const strikeStr of Object.keys(strikesObj)) {
        const strike = parseFloat(strikeStr);
        if (!isFinite(strike)) continue;
        for (const c of strikesObj[strikeStr]) {
          const iv = normIV(c.volatility);
          const theoreticalIV = c.theoreticalVolatility != null && isFinite(c.theoreticalVolatility)
            ? normIV(c.theoreticalVolatility)
            : null;
          contracts.push({
            strike,
            side,
            expiry,
            dte,
            delta: c.delta ?? 0,
            gamma: c.gamma ?? 0,
            theta: c.theta ?? 0,
            vega: c.vega ?? 0,
            rho: c.rho ?? 0,
            iv,
            theoreticalIV,
            oi: c.openInterest ?? 0,
            volume: c.totalVolume ?? 0,
            mark: c.mark ?? 0,
            last: c.last ?? 0,
            bid: c.bid ?? 0,
            ask: c.ask ?? 0,
            inTheMoney: c.inTheMoney ?? false,
          });
        }
      }
    }
  }

  processMap(callExpDateMap, "call");
  processMap(putExpDateMap, "put");
  return contracts;
}

// ─── 1. DEX ───────────────────────────────────────────────────────────────────

function computeDEX(contracts: Contract[], spot: number): DEXResult {
  const strikeMap = new Map<number, DEXStrike>();

  for (const c of contracts) {
    if (!strikeMap.has(c.strike)) {
      strikeMap.set(c.strike, { strike: c.strike, callDex: 0, putDex: 0, netDex: 0 });
    }
    const row = strikeMap.get(c.strike)!;
    // delta × OI × 100 (puts keep their negative sign naturally from Schwab)
    const dex = c.delta * c.oi * 100;
    if (c.side === "call") row.callDex += dex;
    else row.putDex += dex;
    row.netDex = row.callDex + row.putDex;
  }

  const profile = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

  const maxPositive = profile.reduce<DEXStrike | null>((best, p) =>
    p.netDex > (best?.netDex ?? -Infinity) ? p : best, null);
  const maxNegative = profile.reduce<DEXStrike | null>((best, p) =>
    p.netDex < (best?.netDex ?? Infinity) ? p : best, null);

  // Flip strike: walking up from spot, first strike where cumulative net DEX flips sign
  const aboveSpot = profile.filter(p => p.strike >= spot);
  let cumDex = 0;
  let flipStrike: number | null = null;
  for (const p of aboveSpot) {
    const prev = cumDex;
    cumDex += p.netDex;
    if ((prev < 0 && cumDex >= 0) || (prev > 0 && cumDex <= 0)) {
      flipStrike = p.strike;
      break;
    }
  }

  const totalCallDex = profile.reduce((s, p) => s + p.callDex, 0);
  const totalPutDex = profile.reduce((s, p) => s + p.putDex, 0);
  const totalNetDex = totalCallDex + totalPutDex;

  return {
    profile,
    maxPositive: maxPositive ? { strike: maxPositive.strike, value: maxPositive.netDex } : null,
    maxNegative: maxNegative ? { strike: maxNegative.strike, value: maxNegative.netDex } : null,
    flipStrike,
    totalCallDex,
    totalPutDex,
    totalNetDex,
  };
}

// ─── 2. Vanna ─────────────────────────────────────────────────────────────────

function computeVanna(contracts: Contract[], spot: number): VannaResult {
  const strikeMap = new Map<number, number>();

  for (const c of contracts) {
    if (c.oi <= 0 || c.iv <= 0 || c.vega === 0) continue;
    // vanna ≈ vega × delta / (S × IV) — approximation from greeks Schwab provides
    const vanna = safeDivide(c.vega * c.delta, spot * c.iv);
    // Vanna exposure in $ per 1% vol move = vanna × OI × 100 × S × 0.01
    const vannaExp = vanna * c.oi * 100 * spot * 0.01;
    strikeMap.set(c.strike, (strikeMap.get(c.strike) ?? 0) + vannaExp);
  }

  const profile: VannaStrike[] = Array.from(strikeMap.entries())
    .map(([strike, vannaExposure]) => ({ strike, vannaExposure }))
    .sort((a, b) => a.strike - b.strike);

  const peakVannaStrike = profile.reduce<VannaStrike | null>(
    (best, p) => Math.abs(p.vannaExposure) > Math.abs(best?.vannaExposure ?? 0) ? p : best,
    null,
  )?.strike ?? null;

  const totalVannaDollarPerVolPct = profile.reduce((s, p) => s + p.vannaExposure, 0);

  return { profile, peakVannaStrike, totalVannaDollarPerVolPct };
}

// ─── 3. Charm ─────────────────────────────────────────────────────────────────

function computeCharm(contracts: Contract[], spot: number): CharmResult {
  const strikeMap = new Map<number, number>();

  for (const c of contracts) {
    if (c.oi <= 0 || c.dte <= 0) continue;
    const T = c.dte / 365; // years to expiry
    // charm ≈ -theta × delta / (S × T)
    const charm = safeDivide(-c.theta * c.delta, spot * T);
    // charmExposure = charm × OI × 100 × S
    const charmExp = charm * c.oi * 100 * spot;
    strikeMap.set(c.strike, (strikeMap.get(c.strike) ?? 0) + charmExp);
  }

  const profile: CharmStrike[] = Array.from(strikeMap.entries())
    .map(([strike, charmExposure]) => ({ strike, charmExposure }))
    .sort((a, b) => a.strike - b.strike);

  const peakCharmStrike = profile.reduce<CharmStrike | null>(
    (best, p) => Math.abs(p.charmExposure) > Math.abs(best?.charmExposure ?? 0) ? p : best,
    null,
  )?.strike ?? null;

  const totalCharmPerDay = profile.reduce((s, p) => s + p.charmExposure, 0);

  return { profile, peakCharmStrike, totalCharmPerDay };
}

// ─── 4. IV Skew per expiry ────────────────────────────────────────────────────

function computeIVSkew(contracts: Contract[]): SkewEntry[] {
  // Group by expiry
  const byExpiry = new Map<string, { dte: number; calls: Contract[]; puts: Contract[] }>();
  for (const c of contracts) {
    if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, { dte: c.dte, calls: [], puts: [] });
    const g = byExpiry.get(c.expiry)!;
    if (c.side === "call") g.calls.push(c);
    else g.puts.push(c);
  }

  const entries: SkewEntry[] = [];

  for (const [expiry, group] of byExpiry) {
    const { dte, calls, puts } = group;

    // ATM IV: call and put closest to delta=0.50 / -0.50
    const atmCall = calls.filter(c => c.iv > 0).sort((a, b) =>
      Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5)
    )[0];
    const atmPut = puts.filter(c => c.iv > 0).sort((a, b) =>
      Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5)
    )[0];
    const atmIV = atmCall && atmPut ? (atmCall.iv + atmPut.iv) / 2
      : atmCall?.iv ?? atmPut?.iv ?? null;

    // 25-delta: call closest to delta=0.25, put closest to delta=-0.25
    const call25 = calls.filter(c => c.iv > 0).sort((a, b) =>
      Math.abs(a.delta - 0.25) - Math.abs(b.delta - 0.25)
    )[0];
    const put25 = puts.filter(c => c.iv > 0).sort((a, b) =>
      Math.abs(a.delta + 0.25) - Math.abs(b.delta + 0.25)
    )[0];

    const put25IV = put25?.iv ?? null;
    const call25IV = call25?.iv ?? null;
    const skew = put25IV != null && call25IV != null ? put25IV - call25IV : null;

    entries.push({
      expiry,
      dte,
      put25IV,
      call25IV,
      atmIV,
      skew,
      elevatedFear: skew != null && skew > 0.03,
    });
  }

  return entries.sort((a, b) => a.dte - b.dte);
}

// ─── 5. Term Structure ────────────────────────────────────────────────────────

function computeTermStructure(contracts: Contract[], spot: number): TermStructureResult {
  const byExpiry = new Map<string, { dte: number; contracts: Contract[] }>();
  for (const c of contracts) {
    if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, { dte: c.dte, contracts: [] });
    byExpiry.get(c.expiry)!.contracts.push(c);
  }

  const term: TermStructureEntry[] = [];

  for (const [expiry, group] of byExpiry) {
    const { dte, contracts: cs } = group;
    // ATM: contract closest to spot by strike
    const byDist = cs.filter(c => c.iv > 0).sort((a, b) =>
      Math.abs(a.strike - spot) - Math.abs(b.strike - spot)
    );
    // Average ATM call + put IV
    const atmCall = byDist.filter(c => c.side === "call")[0];
    const atmPut = byDist.filter(c => c.side === "put")[0];
    const atmIV = atmCall && atmPut ? (atmCall.iv + atmPut.iv) / 2
      : atmCall?.iv ?? atmPut?.iv ?? null;

    term.push({ expiry, dte, atmIV });
  }

  term.sort((a, b) => a.dte - b.dte);

  // Contango: front IV < back IV
  const validEntries = term.filter(e => e.atmIV != null);
  let contango: boolean | null = null;
  let steepness: number | null = null;
  if (validEntries.length >= 2) {
    const front = validEntries[0].atmIV!;
    const back = validEntries[validEntries.length - 1].atmIV!;
    contango = front < back;
    steepness = back - front;
  }

  return { term, contango, steepness };
}

// ─── 6. Unusual Volume ────────────────────────────────────────────────────────

function computeUnusualVolume(contracts: Contract[], spot: number): UnusualContract[] {
  const flagged: UnusualContract[] = [];

  for (const c of contracts) {
    if (c.volume <= 0 || c.oi <= 0) continue;
    const volOiRatio = c.volume / c.oi;
    if (volOiRatio < 2.0) continue;

    const price = c.mark > 0 ? c.mark : (c.bid + c.ask) / 2;
    const dollarVolume = price * c.volume * 100;
    const deltaNotional = c.delta * c.oi * 100 * spot;

    flagged.push({
      symbol: `${c.side.toUpperCase()}_${c.strike}_${c.expiry}`,
      strike: c.strike,
      side: c.side,
      expiry: c.expiry,
      dte: c.dte,
      volume: c.volume,
      oi: c.oi,
      volOiRatio,
      lastPrice: price,
      dollarVolume,
      deltaNotional,
    });
  }

  // Sort by volOiRatio × dollarVolume descending, take top 20
  return flagged
    .sort((a, b) => b.volOiRatio * b.dollarVolume - a.volOiRatio * a.dollarVolume)
    .slice(0, 20);
}

// ─── 7. Dealer Positioning Score ─────────────────────────────────────────────

function computeDealerScore(contracts: Contract[], spot: number): DealerScoreResult {
  // Gaussian decay: bandwidth ~2% of spot
  const bandwidth = 0.02 * spot;

  let callScore = 0;
  let putScore = 0;

  for (const c of contracts) {
    if (c.oi <= 0) continue;
    const weight = Math.exp(-Math.abs(c.strike - spot) / bandwidth);
    const deltaCont = Math.abs(c.delta) * c.oi * 100;
    if (c.side === "call") callScore += weight * deltaCont;
    else putScore += weight * deltaCont;
  }

  // Positive = dealers long delta (calls dominate near ATM)
  // Negative = dealers short delta (puts dominate near ATM)
  const rawScore = callScore - putScore;
  const maxRaw = callScore + putScore;
  const normalised = maxRaw > 0 ? (rawScore / maxRaw) * 100 : 0;

  return {
    score: Math.round(normalised * 10) / 10,
    rawLong: callScore,
    rawShort: putScore,
    regime: normalised > 10 ? "long_gamma"
           : normalised < -10 ? "short_gamma"
           : "neutral",
  };
}

// ─── 8. GEX Decay Ladder ─────────────────────────────────────────────────────

function computeSingleGEXBucket(contracts: Contract[], spot: number): GEXBucket {
  const strikeMap = new Map<number, { callGex: number; putGex: number; netGex: number }>();

  for (const c of contracts) {
    if (!strikeMap.has(c.strike)) strikeMap.set(c.strike, { callGex: 0, putGex: 0, netGex: 0 });
    const row = strikeMap.get(c.strike)!;
    const gex = c.gamma * c.oi * 100 * spot * spot * 0.01;
    if (c.side === "call") row.callGex += gex;
    else row.putGex -= gex;
    row.netGex = row.callGex + row.putGex;
  }

  const profile = Array.from(strikeMap.entries())
    .map(([strike, v]) => ({ strike, ...v }))
    .sort((a, b) => a.strike - b.strike);

  if (!profile.length) return { callWall: null, putWall: null, zeroGamma: null, totalGex: 0, contractCount: 0 };

  const aboveSpot = profile.filter(p => p.strike >= spot);
  const belowSpot = profile.filter(p => p.strike < spot);
  const callWall = aboveSpot.reduce<typeof profile[0] | null>(
    (best, p) => (!best || p.callGex > best.callGex ? p : best), null);
  const putWall = belowSpot.reduce<typeof profile[0] | null>(
    (best, p) => (!best || p.putGex < best.putGex ? p : best), null);

  let cumGex = 0;
  let zeroGamma: number | null = null;
  for (const p of profile) {
    const prev = cumGex;
    cumGex += p.netGex;
    if ((prev < 0 && cumGex >= 0) || (prev > 0 && cumGex <= 0)) {
      zeroGamma = p.strike;
      break;
    }
  }

  const totalGex = profile.reduce((s, p) => s + p.netGex, 0);

  return {
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
    zeroGamma,
    totalGex,
    contractCount: contracts.length,
  };
}

function computeGEXDecay(contracts: Contract[], spot: number): GEXDecayResult {
  const zeroContracts = contracts.filter(c => c.dte === 0);
  const shortContracts = contracts.filter(c => c.dte >= 1 && c.dte <= 2);
  const weeklyContracts = contracts.filter(c => c.dte >= 3 && c.dte <= 7);
  const monthlyContracts = contracts.filter(c => c.dte >= 8);

  return {
    zerodte: computeSingleGEXBucket(zeroContracts, spot),
    short: computeSingleGEXBucket(shortContracts, spot),
    weekly: computeSingleGEXBucket(weeklyContracts, spot),
    monthly: computeSingleGEXBucket(monthlyContracts, spot),
    combined: computeSingleGEXBucket(contracts, spot),
  };
}

// ─── 9. Pinning Probability ───────────────────────────────────────────────────

function computePinning(contracts: Contract[], spot: number): PinStrike[] {
  // Nearest expiry only
  const sortedDTE = [...new Set(contracts.map(c => c.dte))].sort((a, b) => a - b);
  const nearestDTE = sortedDTE[0] ?? 0;
  const nearest = contracts.filter(c => c.dte === nearestDTE);

  if (!nearest.length) return [];

  const bandwidth = 0.005 * spot; // 0.5% of spot

  const strikeMap = new Map<number, number>();
  for (const c of nearest) {
    const diff = c.strike - spot;
    const pinScore = Math.abs(c.gamma) * c.oi * Math.exp(
      -(diff * diff) / (2 * bandwidth * bandwidth)
    );
    strikeMap.set(c.strike, (strikeMap.get(c.strike) ?? 0) + pinScore);
  }

  const total = Array.from(strikeMap.values()).reduce((s, v) => s + v, 0);
  if (total <= 0) return [];

  return Array.from(strikeMap.entries())
    .map(([strike, score]) => ({
      strike,
      prob: total > 0 ? (score / total) * 100 : 0,
      distance: strike - spot,
    }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 5);
}

// ─── 10. Vol Risk Premium ─────────────────────────────────────────────────────

function computeVRP(contracts: Contract[], spot: number): VRPEntry[] {
  const byExpiry = new Map<string, { dte: number; contracts: Contract[] }>();
  for (const c of contracts) {
    if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, { dte: c.dte, contracts: [] });
    byExpiry.get(c.expiry)!.contracts.push(c);
  }

  const entries: VRPEntry[] = [];

  for (const [expiry, group] of byExpiry) {
    const { dte, contracts: cs } = group;
    // Find ATM contracts (closest to spot)
    const atmContracts = cs
      .filter(c => c.iv > 0)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
      .slice(0, 4);

    if (!atmContracts.length) {
      entries.push({ expiry, dte, marketIV: null, theoreticalIV: null, vrp: null, signal: "n/a" });
      continue;
    }

    // Average ATM market IV
    const marketIVs = atmContracts.map(c => c.iv).filter(v => v > 0);
    const marketIV = marketIVs.length > 0 ? marketIVs.reduce((a, b) => a + b, 0) / marketIVs.length : null;

    // Average ATM theoretical IV (Schwab's model)
    const theoreticalIVs = atmContracts
      .map(c => c.theoreticalIV)
      .filter((v): v is number => v != null && v > 0);
    const theoreticalIV = theoreticalIVs.length > 0
      ? theoreticalIVs.reduce((a, b) => a + b, 0) / theoreticalIVs.length
      : null;

    let vrp: number | null = null;
    let signal: VRPEntry["signal"] = "n/a";

    if (marketIV != null && theoreticalIV != null) {
      vrp = theoreticalIV - marketIV;
      if (vrp < -0.01) signal = "sell_vol";       // mkt IV > theoretical → expensive
      else if (vrp > 0.01) signal = "buy_vol";    // theoretical > mkt → cheap
      else signal = "neutral";
    } else if (marketIV != null) {
      signal = "n/a";
    }

    entries.push({ expiry, dte, marketIV, theoreticalIV, vrp, signal });
  }

  return entries.sort((a, b) => a.dte - b.dte);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build the full chain audit from a Schwab OptionChainResponse.
 * @param chain - raw Schwab chain (must be non-error variant)
 * @param spot  - current underlying price
 */
export function buildChainAudit(
  chain: Exclude<OptionChainResponse, { error: string }>,
  spot: number,
): ChainAuditResult {
  const contracts = extractContracts(chain.callExpDateMap, chain.putExpDateMap);

  const expiries = [...new Set(contracts.map(c => c.expiry))];

  // Data quality assessment
  const hasGreeks = contracts.some(c => c.delta !== 0 && c.gamma !== 0);
  const hasTheoreticalIV = contracts.some(c => c.theoreticalIV != null && c.theoreticalIV > 0);
  const dataQuality: ChainAuditResult["dataQuality"] =
    !hasGreeks ? "minimal"
    : !hasTheoreticalIV ? "partial"
    : "full";

  return {
    dex: computeDEX(contracts, spot),
    vanna: computeVanna(contracts, spot),
    charm: computeCharm(contracts, spot),
    skew: computeIVSkew(contracts),
    termStructure: computeTermStructure(contracts, spot),
    unusualVolume: computeUnusualVolume(contracts, spot),
    dealerScore: computeDealerScore(contracts, spot),
    gexDecay: computeGEXDecay(contracts, spot),
    pinning: computePinning(contracts, spot),
    vrp: computeVRP(contracts, spot),
    contractsProcessed: contracts.length,
    expiriesFound: expiries.length,
    dataQuality,
  };
}
