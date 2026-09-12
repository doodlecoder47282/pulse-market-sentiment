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
import { invNormCDF } from "./chainAudit";

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
      pivotBands: [],
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

  // Fractional years to expiry. For 0DTE use remaining minutes to 16:00 ET
  // (15-minute floor) so vanna/charm don't blow up or vanish at T=0.
  let T: number;
  if (dte >= 1) {
    T = dte / 365;
  } else {
    const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const close = new Date(nowEt);
    close.setHours(16, 0, 0, 0);
    const mins = Math.max(15, (close.getTime() - nowEt.getTime()) / 60000);
    T = mins / (365 * 24 * 60);
  }

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

        // True Black-Scholes vanna/charm recovered from delta + IV (same d1
        // recovery as chainAudit). Replaces the old vega*delta/iv and
        // -theta*delta*2/iv proxies, which had the wrong shape across strikes.
        let vanna = 0;
        let charm = 0;
        if (ivDec > 0 && T > 0) {
          const prob = side === "call" ? delta : delta + 1;
          if (prob > 0 && prob < 1) {
            const d1v = invNormCDF(prob);
            const d2v = d1v - ivDec * Math.sqrt(T);
            const phi = Math.exp(-0.5 * d1v * d1v) / Math.sqrt(2 * Math.PI);
            vanna = (-phi * d2v) / ivDec;   // dDelta per 1.0 vol move
            charm = (phi * d2v) / (2 * T);  // dDelta per year (r=q=0)
          }
        }

        const dexContrib = delta * oi * mult * spot;
        const vannaContrib = vanna * oi * mult * spot * 0.01; // $ per 1% vol move
        const charmContrib = (charm * oi * mult * spot) / 365; // $ per calendar day

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
    totals,
    availableExpiries,
    requestedExpiry: targetExpiry ?? null,
  };
}
