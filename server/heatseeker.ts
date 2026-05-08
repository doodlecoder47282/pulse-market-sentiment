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

type Chain = Exclude<OptionChainResponse, { error: string }>;

export interface HeatseekerStrike {
  strike: number;
  distancePct: number;        // % from spot
  // Per-strike Greek exposures (net = call - put, dealer convention)
  netGex: number;             // $ / 1% move
  callGex: number;            // call-side GEX (always >= 0)
  putGex: number;             // put-side GEX (always >= 0, contributes negatively to net)
  netDex: number;             // $ delta exposure
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

export interface HeatseekerResult {
  symbol: string;
  spot: number;
  expiry: string;             // YYYY-MM-DD
  dte: number;                // days to expiry (0 for 0DTE)
  asOf: number;
  strikes: HeatseekerStrike[];
  stickyZones: StickyZone[];  // top 5 ranked
  totals: {
    netGex: number;
    netDex: number;
    netVanna: number;
    netCharm: number;
    callWall: number | null;  // max positive GEX strike above spot
    putWall: number | null;   // max negative GEX strike below spot
    zeroGamma: number | null; // strike where cum net GEX flips
  };
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
      totals: { netGex: 0, netDex: 0, netVanna: 0, netCharm: 0, callWall: null, putWall: null, zeroGamma: null },
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
        netDex: 0,
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
        const gamma = Number(c.gamma) || 0;
        const delta = Number(c.delta) || 0;
        const vega = Number(c.vega) || 0;
        const theta = Number(c.theta) || 0;
        const oi = Number(c.openInterest) || 0;
        const vol = Number(c.totalVolume) || 0;
        const iv = Number(c.volatility) || 0; // Schwab uses 0-100 scale
        const ivDec = iv / 100;

        const s = ensure(strike);

        // Dealer convention: dealers short calls (-), long puts (+) for gamma
        // net GEX at strike = callGEX - putGEX (positive = dealers long gamma)
        const gex = gamma * oi * mult * spot * spot * 0.01;
        // Vanna ≈ -delta × (1 - |delta|) / IV (approximation when not provided)
        // Better: vanna = vega × delta / spot — but we use dvega/dspot proxy
        const vanna = vega && ivDec > 0 ? (vega * delta) / Math.max(ivDec, 0.01) : 0;
        // Charm = d(delta)/d(time) — Schwab sometimes provides `charm`, else proxy
        const charmRaw = Number(c.charm);
        const charm = isFinite(charmRaw)
          ? charmRaw
          : theta && ivDec > 0
            ? (-theta * delta * 2) / Math.max(ivDec * 100, 1)
            : 0;

        const dexContrib = delta * oi * mult * spot;
        const vannaContrib = vanna * oi * mult;
        const charmContrib = charm * oi * mult;

        if (side === "call") {
          s.callOI += oi;
          s.callVol += vol;
          s.callGex += gex;
          s.netGex += gex;
          s.netDex += dexContrib;
          s.netVanna += vannaContrib;
          s.netCharm += charmContrib;
          if (s.callIV === null && iv > 0) s.callIV = ivDec;
        } else {
          s.putOI += oi;
          s.putVol += vol;
          s.putGex += gex;
          // Puts contribute negatively to dealer net gamma (GEXbot convention).
          s.netGex -= gex;
          s.netDex -= dexContrib;
          s.netVanna -= vannaContrib;
          s.netCharm -= charmContrib;
          if (s.putIV === null && iv > 0) s.putIV = ivDec;
        }
      }
    }
  }

  processSide(chain.callExpDateMap || {}, "call");
  processSide(chain.putExpDateMap || {}, "put");

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

  // Zero gamma: cumulative net GEX from lowest strike — flips from + to - (or vice versa)
  let cum = 0;
  let zeroGamma: number | null = null;
  let prevCum = 0;
  for (const s of strikes) {
    prevCum = cum;
    cum += s.netGex;
    if (prevCum !== 0 && Math.sign(prevCum) !== Math.sign(cum)) {
      zeroGamma = s.strike;
      break;
    }
  }

  const totals = {
    netGex: strikes.reduce((a, s) => a + s.netGex, 0),
    netDex: strikes.reduce((a, s) => a + s.netDex, 0),
    netVanna: strikes.reduce((a, s) => a + s.netVanna, 0),
    netCharm: strikes.reduce((a, s) => a + s.netCharm, 0),
    callWall,
    putWall,
    zeroGamma,
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

  return {
    symbol,
    spot,
    expiry,
    dte,
    asOf: Date.now(),
    strikes,
    stickyZones,
    totals,
    availableExpiries,
    requestedExpiry: targetExpiry ?? null,
  };
}
