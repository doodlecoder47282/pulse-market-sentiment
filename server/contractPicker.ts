// server/contractPicker.ts
//
// Wire 15 — Deterministic contract picker for 0DTE SPX bangers.
// Wire 16 — Bid-ask spread gate + spread-aware projection.
//
// Reads the full Schwab 0DTE option chain via getOptionChain("$SPX.X"),
// selects the best strike in the delta band [0.35, 0.50], computes a
// Black-Scholes-style projected return to T1 (and T2), and returns a
// typed ContractDetails struct.
//
// Constraints (verbatim from user):
//   - Delta band: abs(delta) in [0.35, 0.50]
//   - Prefer the strike that sits BETWEEN current spot AND T1 level
//     (so the path crosses the strike). If no candidate between, take
//     closest-to-ATM in the band.
//   - No strike in band → reject alert (reason: CONTRACT_NO_STRIKE_IN_DELTA_BAND)
//   - Projected return >= +30% to T1 is a HARD GATE (Gate 3 in engine) [Wire 16: was 50%]
//   - A-(85) cold-boot override applies on Gate 3 only
//
// Wire 16 additions:
//   - Bid-ask spread gate: spreadPct = (ask - bid) / midPrice > 5% → reject.
//     Try next-best strike; if none passes → CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT
//   - Spread-aware projection: entryPrice = midPrice + halfSpread (paying near ask).
//
// Round 2 (R2-C 7): the projection reprices the contract by Black-Scholes AT
// the target with the expected time to reach it, sells at the projected bid
// and pays fees (t1Projection.ts), instead of time-now delta/gamma plus the
// whole decay to the close.
//   - New audit fields: contractBid, contractAsk, contractMidPrice, contractEntryPrice,
//     contractSpreadPct
//
// This module ONLY picks and prices. It does NOT fire alerts.
// All gate logic lives in odteAlertEngine.ts.

import type { Side } from "./odteAlertEngine";
import { minutesToSessionClose } from "./chainClock";
import { odteProjectionFee, projectToTarget, type TargetProjection } from "./t1Projection";

export interface ContractDetails {
  strike: number;
  type: "CALL" | "PUT";
  delta: number;        // signed (negative for puts)
  gamma: number;
  theta: number;        // per-day (negative)
  vega: number;
  midPrice: number;
  entryPrice: number;   // Wire 16: midPrice + halfSpread (honest fill estimate)
  spreadPct: number;    // Wire 16: (ask - bid) / midPrice
  iv: number;           // decimal (e.g. 0.20 = 20%)
  openInterest: number;
  volume: number;
  bid: number | null;
  ask: number | null;
  key: string;
  expiry: string;
}

export interface ContractPickResult {
  contract: ContractDetails;
  projReturnPctT1: number;   // fraction of cash paid if T1 is reached (ask in, projected bid out, fees)
  projReturnPctT2: number;   // same for T2
  projDeltaPnl: number;      // $ per share: BS delta now x move
  projGammaBoost: number;    // $ per share: rest of the move repricing
  projThetaCost: number;     // $ per share: decay until the expected T1 touch, at the target (<= 0)
  projPnl: number;           // $ per share after spread and fees (= projPnlPerContract / 100)
  /** Full T1 projection detail (added): touch time, model touch probability, exit bid. */
  projectionT1?: TargetProjection;
  minutesToClose: number;
  // Wire 16 audit fields
  contractBid: number | null;
  contractAsk: number | null;
  contractMidPrice: number;
  contractEntryPrice: number;
  contractSpreadPct: number;
}

export type ContractPickError = {
  reason: "CONTRACT_NO_STRIKE_IN_DELTA_BAND" | "CHAIN_UNAVAILABLE" | "NO_CANDIDATES" | "CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT" | "PROJECTION_UNAVAILABLE";
  detail?: string;
};

// ─── Schwab chain contract shape ─────────────────────────────────────────────
// Schwab callExpDateMap / putExpDateMap entries look like:
//   { expDate: { strikeStr: [ { delta, gamma, theta, vega, iv, bid, ask, last,
//                               openInterest, volume, totalVolume, ... } ] } }

/**
 * Pick the best 0DTE SPX contract for the given side + spot + T1 target.
 * Returns ContractPickResult or ContractPickError.
 *
 * Wire 16: applies bid-ask spread gate (>5% → reject, try next-best) and
 * uses spread-aware entry price in projection denominator.
 *
 * @param side          "call" | "put"
 * @param spot          current SPX spot price
 * @param t1Price       T1 target price
 * @param t2Price       T2 target price (may be null — uses T1 for T2 proj then)
 * @param nowMs         current timestamp in ms (for minutesToClose calc)
 */
export async function pickContractForSide(
  side: Side,
  spot: number,
  t1Price: number,
  t2Price: number | null,
  nowMs: number,
): Promise<ContractPickResult | ContractPickError> {
  // Import at call-time to avoid circular deps
  const { getOptionChain } = await import("./schwab");

  let chain: Awaited<ReturnType<typeof getOptionChain>>;
  try {
    chain = await getOptionChain("$SPX.X", 0);
  } catch (e: any) {
    return { reason: "CHAIN_UNAVAILABLE", detail: e?.message ?? "getOptionChain threw" };
  }

  if ("error" in chain) {
    return { reason: "CHAIN_UNAVAILABLE", detail: chain.error };
  }

  // ─── Extract 0DTE contracts for the requested side ────────────────────────
  const expMap = side === "call" ? chain.callExpDateMap : chain.putExpDateMap;
  if (!expMap || Object.keys(expMap).length === 0) {
    return { reason: "CHAIN_UNAVAILABLE", detail: "empty expDateMap for side " + side };
  }

  // Find today's ET date string (YYYY-MM-DD) — Schwab expDate keys look like "2025-01-17:0"
  const etNow = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
  // en-US format → "MM/DD/YYYY", convert to "YYYY-MM-DD"
  const [month, day, year] = etNow.split("/");
  const todayEt = `${year}-${month}-${day}`;

  // Schwab key is "YYYY-MM-DD:N" where N = DTE. 0DTE = ":0", but sometimes ":1" on the same day.
  // Look for the earliest-expiry key that matches today OR just take the key with the smallest DTE.
  const expKeys = Object.keys(expMap);
  let todayKey: string | null = null;
  let minDte = Infinity;
  for (const k of expKeys) {
    const parts = k.split(":");
    const dte = parseInt(parts[1] ?? "999", 10);
    if (parts[0] === todayEt && dte < minDte) {
      todayKey = k;
      minDte = dte;
    }
  }
  // Fallback: if no exact today match, just take the minimum DTE
  if (!todayKey) {
    for (const k of expKeys) {
      const parts = k.split(":");
      const dte = parseInt(parts[1] ?? "999", 10);
      if (dte < minDte) {
        todayKey = k;
        minDte = dte;
      }
    }
  }

  if (!todayKey) {
    return { reason: "CHAIN_UNAVAILABLE", detail: "no 0DTE expiry key found" };
  }

  const strikesObj = expMap[todayKey];
  if (!strikesObj || Object.keys(strikesObj).length === 0) {
    return { reason: "CHAIN_UNAVAILABLE", detail: "empty strikes for expKey " + todayKey };
  }

  // ─── Build candidate list ─────────────────────────────────────────────────
  interface Candidate {
    strike: number;
    delta: number;    // signed
    gamma: number;
    theta: number;    // per-day, negative
    vega: number;
    iv: number;
    midPrice: number;
    bid: number | null;
    ask: number | null;
    openInterest: number;
    volume: number;
    key: string;
    // Wire 16 fields
    entryPrice: number;    // midPrice + halfSpread
    spreadPct: number;     // (ask - bid) / midPrice
    halfSpread: number;    // (ask - bid) / 2
  }

  const allBandCandidates: Candidate[] = [];

  for (const [strikeStr, contracts] of Object.entries(strikesObj)) {
    const strike = parseFloat(strikeStr);
    if (!isFinite(strike)) continue;
    const contracts_arr = contracts as any[];
    if (!contracts_arr.length) continue;
    const c = contracts_arr[0];

    const delta: number = typeof c.delta === "number" ? c.delta : 0;
    const gamma: number = typeof c.gamma === "number" ? c.gamma : 0;
    const theta: number = typeof c.theta === "number" ? c.theta : 0;
    const vega: number = typeof c.vega === "number" ? c.vega : 0;
    const iv: number = typeof c.volatility === "number" ? c.volatility / 100
                     : typeof c.iv === "number" ? c.iv
                     : 0;

    const bid: number | null = typeof c.bid === "number" ? c.bid : null;
    const ask: number | null = typeof c.ask === "number" ? c.ask : null;
    const last: number | null = typeof c.last === "number" ? c.last
                              : typeof c.lastPrice === "number" ? c.lastPrice : null;
    const mid: number = bid != null && ask != null
      ? (bid + ask) / 2
      : last ?? 0;

    if (mid <= 0) continue;

    const absDelta = Math.abs(delta);
    if (absDelta < 0.35 || absDelta > 0.50) continue;

    const oi: number = typeof c.openInterest === "number" ? c.openInterest : 0;
    const vol: number = typeof c.totalVolume === "number" ? c.totalVolume
                      : typeof c.volume === "number" ? c.volume : 0;

    const key = c.symbol ?? `SPX_${strike}_${side.toUpperCase()[0]}_${todayEt}`;

    // Wire 16: compute spread metrics
    const halfSpread: number = (bid != null && ask != null) ? (ask - bid) / 2 : 0;
    const entryPrice: number = mid + halfSpread;  // paying near ask — honest fill
    const spreadPct: number = (bid != null && ask != null && mid > 0) ? (ask - bid) / mid : 0;

    allBandCandidates.push({ strike, delta, gamma, theta, vega, iv, midPrice: mid, bid, ask,
      openInterest: oi, volume: vol, key, entryPrice, spreadPct, halfSpread });
  }

  if (allBandCandidates.length === 0) {
    return { reason: "CONTRACT_NO_STRIKE_IN_DELTA_BAND" };
  }

  // ─── Strike selection (path-crossing preference) ──────────────────────────
  const loPath = Math.min(spot, t1Price);
  const hiPath = Math.max(spot, t1Price);

  // Sort candidates: between-path preferred, then closest to ATM
  function sortByPathAndAtm(cands: Candidate[]): Candidate[] {
    const between = cands.filter(c => c.strike > loPath && c.strike < hiPath);
    const fallback = cands;
    const pool = between.length > 0 ? between : fallback;
    return [...pool].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  }

  const sorted = sortByPathAndAtm(allBandCandidates);

  // Wire 16: bid-ask spread gate — try candidates in order; pick first with spreadPct <= 5%
  const MAX_SPREAD_PCT = 0.05;
  let best: Candidate | null = null;

  for (const cand of sorted) {
    if (cand.spreadPct <= MAX_SPREAD_PCT) {
      best = cand;
      break;
    }
  }

  if (!best) {
    // No candidate has a tight-enough spread
    return {
      reason: "CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT",
      detail: `All ${allBandCandidates.length} delta-band candidates have spreadPct > 5%`,
    };
  }

  // ─── Projected return if T1 / T2 is reached (t1Projection.ts) ────────────
  // minutesToClose = minutes until today's close (13:00 ET on half days)
  const minutesToClose = computeMinutesToClose(nowMs);
  const proj = (targetPrice: number) => projectToTarget({
    spot, strike: best!.strike, type: side === "call" ? "C" : "P", target: targetPrice,
    expiry: todayKey!.split(":")[0] ?? todayEt, symbol: best!.key,
    bid: best!.bid, ask: best!.ask, vendorIv: best!.iv, minutesToClose, nowMs,
    feePerContract: odteProjectionFee(),
  });
  const t1P = proj(t1Price);
  const t2P = proj(t2Price != null ? t2Price : t1Price + (side === "call" ? 5 : -5));
  if (!t1P || !t2P) {
    return { reason: "PROJECTION_UNAVAILABLE", detail: "no two-sided quote or usable sigma for the picked strike" };
  }

  const expiry = todayKey.split(":")[0] ?? todayEt;

  return {
    contract: {
      strike: best.strike,
      type: side === "call" ? "CALL" : "PUT",
      delta: best.delta,
      gamma: best.gamma,
      theta: best.theta,
      vega: best.vega,
      midPrice: best.midPrice,
      entryPrice: best.entryPrice,
      spreadPct: best.spreadPct,
      iv: best.iv,
      openInterest: best.openInterest,
      volume: best.volume,
      bid: best.bid,
      ask: best.ask,
      key: best.key,
      expiry,
    },
    projReturnPctT1: t1P.projReturnPct,
    projReturnPctT2: t2P.projReturnPct,
    projDeltaPnl: t1P.projDeltaPnl,
    projGammaBoost: t1P.projGammaBoost,
    projThetaCost: t1P.projThetaCost,
    projPnl: t1P.projPnlPerContract / 100,
    projectionT1: t1P,
    minutesToClose,
    // Wire 16 audit fields
    contractBid: best.bid,
    contractAsk: best.ask,
    contractMidPrice: best.midPrice,
    contractEntryPrice: best.entryPrice,
    contractSpreadPct: best.spreadPct,
  };
}

/**
 * Minutes remaining until today's session close (16:00 ET, 13:00 ET on half
 * days, exchangeCalendar). Returns at least 1 (as spec'd: max(1, ...)).
 */
export function computeMinutesToClose(nowMs: number): number {
  return minutesToSessionClose(nowMs);
}

/**
 * Compute 5-day annualized realized vol from Schwab daily SPX bars.
 * Uses ln-returns, annualizes by sqrt(252).
 * Returns null if insufficient data.
 */
export async function computeRv5d(): Promise<number | null> {
  try {
    const { getPriceHistory } = await import("./schwab");
    // Fetch 10 trading days to ensure we have 5 returns even with gaps
    const resp = await getPriceHistory("$SPX.X", "day", 10, "daily", 1);
    const candles = resp.candles;
    if (!candles || candles.length < 6) return null;

    // Take last 6 closes → 5 log-returns
    const closes = candles.slice(-6).map((c) => c.close);
    if (closes.some((c) => !isFinite(c) || c <= 0)) return null;

    const logReturns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }

    // Variance (population — 5 obs)
    const n = logReturns.length;
    const mean = logReturns.reduce((s, r) => s + r, 0) / n;
    const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
    const dailyVol = Math.sqrt(variance);
    const annualizedVol = dailyVol * Math.sqrt(252);

    return isFinite(annualizedVol) ? annualizedVol : null;
  } catch {
    return null;
  }
}
