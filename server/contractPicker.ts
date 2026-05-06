// server/contractPicker.ts
//
// Wire 15 — Deterministic contract picker for 0DTE SPX bangers.
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
//   - Projected return >= +50% to T1 is a HARD GATE (Gate 3 in engine)
//   - A-(85) cold-boot override applies on Gate 3 only
//
// This module ONLY picks and prices. It does NOT fire alerts.
// All gate logic lives in odteAlertEngine.ts.

import type { Side } from "./odteAlertEngine";

export interface ContractDetails {
  strike: number;
  type: "CALL" | "PUT";
  delta: number;        // signed (negative for puts)
  gamma: number;
  theta: number;        // per-day (negative)
  vega: number;
  midPrice: number;
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
  projReturnPctT1: number;   // e.g. 0.80 = 80% projected return to T1
  projReturnPctT2: number;   // e.g. 1.30 = 130% projected return to T2
  projDeltaPnl: number;
  projGammaBoost: number;
  projThetaCost: number;
  projPnl: number;           // dollar-value on per-share basis
  minutesToClose: number;
}

export type ContractPickError = {
  reason: "CONTRACT_NO_STRIKE_IN_DELTA_BAND" | "CHAIN_UNAVAILABLE" | "NO_CANDIDATES";
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
  }

  const candidates: Candidate[] = [];

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

    candidates.push({ strike, delta, gamma, theta, vega, iv, midPrice: mid, bid, ask, openInterest: oi, volume: vol, key });
  }

  if (candidates.length === 0) {
    return { reason: "CONTRACT_NO_STRIKE_IN_DELTA_BAND" };
  }

  // ─── Strike selection ─────────────────────────────────────────────────────
  // Prefer strike BETWEEN spot and T1 (path-crossing).
  const loPath = Math.min(spot, t1Price);
  const hiPath = Math.max(spot, t1Price);
  const betweenCandidates = candidates.filter(
    (c) => c.strike > loPath && c.strike < hiPath,
  );

  let best: Candidate;
  if (betweenCandidates.length > 0) {
    // Among between-candidates, pick closest to ATM (smallest |strike - spot|)
    best = betweenCandidates.reduce((a, b) =>
      Math.abs(a.strike - spot) <= Math.abs(b.strike - spot) ? a : b,
    );
  } else {
    // No between-candidates — pick closest-to-ATM among all band candidates
    best = candidates.reduce((a, b) =>
      Math.abs(a.strike - spot) <= Math.abs(b.strike - spot) ? a : b,
    );
  }

  // ─── Projected return calculation (BS approximation) ─────────────────────
  // minutesToClose = minutes until 16:00 ET
  const minutesToClose = computeMinutesToClose(nowMs);

  function projReturn(targetPrice: number): {
    projDeltaPnl: number;
    projGammaBoost: number;
    projThetaCost: number;
    projPnl: number;
    projReturnPct: number;
  } {
    // move is signed by side: for call, positive SPX move = gain; for put, negative SPX move = gain
    const move = side === "call"
      ? targetPrice - spot
      : spot - targetPrice;

    // Use abs(delta) for the projection — delta is already signed by convention but
    // we want the raw magnitude times the directional move.
    const absDelta = Math.abs(best.delta);
    const projDeltaPnl = absDelta * move;

    // gamma boost uses signed move^2 (always positive addend)
    const projGammaBoost = 0.5 * best.gamma * move * move;

    // theta is per-day (negative). Theta cost = portion of day remaining.
    // theta_per_day / 390 minutes * minutesToClose
    const thetaPerDay = best.theta; // already negative, e.g. -2.50
    const projThetaCost = (thetaPerDay / 390) * minutesToClose;
    // projThetaCost is negative; we subtract it (add theta cost back as positive cost)

    const projPnl = projDeltaPnl + projGammaBoost + projThetaCost; // thetaCost already negative
    const projReturnPct = best.midPrice > 0 ? projPnl / best.midPrice : 0;

    return { projDeltaPnl, projGammaBoost, projThetaCost, projPnl, projReturnPct };
  }

  const t1Proj = projReturn(t1Price);
  const t2Proj = t2Price != null ? projReturn(t2Price) : projReturn(t1Price + (side === "call" ? 5 : -5));

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
      iv: best.iv,
      openInterest: best.openInterest,
      volume: best.volume,
      bid: best.bid,
      ask: best.ask,
      key: best.key,
      expiry,
    },
    projReturnPctT1: t1Proj.projReturnPct,
    projReturnPctT2: t2Proj.projReturnPct,
    projDeltaPnl: t1Proj.projDeltaPnl,
    projGammaBoost: t1Proj.projGammaBoost,
    projThetaCost: t1Proj.projThetaCost,
    projPnl: t1Proj.projPnl,
    minutesToClose,
  };
}

/**
 * Compute minutes remaining until 16:00 ET from nowMs.
 * Returns at least 1 (as spec'd: max(1, ...)).
 */
export function computeMinutesToClose(nowMs: number): number {
  const now = new Date(nowMs);
  // Build 16:00 ET for the current ET date
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [m, d, y] = etFmt.split("/");
  // Create a Date that represents 16:00 ET on the current ET date
  // We need to convert to UTC. Simple approach: build target as local-ET string.
  const closeEt = new Date(`${y}-${m}-${d}T16:00:00`);
  // This Date is interpreted as local time. We want it in ET.
  // Use a reliable approach: compute via getTime offset.
  const etOffsetMs = getEtOffsetMs(nowMs);
  const closeUtcMs = closeEt.getTime() - etOffsetMs;
  const diffMs = closeUtcMs - nowMs;
  return Math.max(1, Math.floor(diffMs / 60_000));
}

/**
 * Get the UTC offset for America/New_York at a given timestamp (ms).
 * Returns negative ms for behind UTC (e.g. ET is UTC-5 → -5*3600*1000).
 */
function getEtOffsetMs(nowMs: number): number {
  const now = new Date(nowMs);
  // Build a UTC-string-based approach: format in ET and compare
  const etParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(now);
  // en-CA gives "YYYY-MM-DD, HH:MM:SS"
  const etStr = etParts.replace(", ", "T");
  const etDate = new Date(etStr + "Z"); // treat as UTC to get the "epoch" of ET wall clock
  return etDate.getTime() - nowMs; // how much the ET wall clock is ahead of UTC in ms (negative for behind)
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
