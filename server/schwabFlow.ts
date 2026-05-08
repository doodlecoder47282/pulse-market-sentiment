// ─────────────────────────────────────────────────────────────────────────────
// schwabFlow.ts — Schwab-native unusual options flow detector.
//
// Replaces the CBOE-backed buildUnusualFlow for ticker scanning. Why Schwab:
//   - No rate-limiting (we're authenticated)
//   - Real-time greeks (delta, gamma) — needed for delta-floor sanity check
//   - Mark price + bid/ask/last all in one payload
//   - Volume + OI native (no OCC parsing)
//
// Output shape mirrors UnusualFlowContract (drop-in compatible) plus a `delta`
// field so the BANGERS / whale gates can do delta-aware filtering.
// ─────────────────────────────────────────────────────────────────────────────

import { getOptionChain } from "./schwab";
import type { UnusualFlowContract, FlowTag, FlowSentiment } from "./unusualFlow";

export interface SchwabFlowContract extends UnusualFlowContract {
  delta: number;          // signed: calls 0..1, puts -1..0
  gamma: number;
  theta: number;
  vega: number;
  iv: number;             // already on UnusualFlowContract but Schwab fills it
  mark: number;           // theo mid from Schwab
}

export interface SchwabFlowResponse {
  provider: "schwab";
  symbol: string;
  spot: number | null;
  contracts: SchwabFlowContract[];
  asOf: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function inRange(last: number, bid: number, ask: number): boolean {
  if (!last || last <= 0 || !bid || !ask || ask < bid) return false;
  const tol = 0.005;
  return last >= bid - tol && last <= ask + tol;
}

function calcMid(last: number, bid: number, ask: number, mark: number): number {
  // Prefer Schwab's mark when sane, else apply UnusualFlow.calcMid logic
  if (mark > 0 && bid > 0 && ask > 0 && mark >= bid && mark <= ask) return mark;
  const hasSpread = bid > 0 && ask > 0 && ask >= bid;
  if (hasSpread && inRange(last, bid, ask)) return last;
  if (hasSpread) return (bid + ask) / 2;
  if (last > 0) return last;
  return 0;
}

function deriveTag(last: number, bid: number, ask: number): FlowTag {
  if (!last || !bid || !ask) return "MID";
  const tol = 0.01;
  if (last > ask + tol) return "ABOVE_ASK";
  if (Math.abs(last - ask) <= tol) return "AT_ASK";
  if (last < bid - tol) return "BELOW_BID";
  if (Math.abs(last - bid) <= tol) return "AT_BID";
  return "MID";
}

function deriveSentiment(type: "C" | "P", tag: FlowTag): FlowSentiment {
  // Calls bought aggressively = bullish; puts bought aggressively = bearish.
  if (type === "C") {
    if (tag === "ABOVE_ASK" || tag === "AT_ASK") return "BULLISH";
    if (tag === "BELOW_BID" || tag === "AT_BID") return "BEARISH";
  } else {
    if (tag === "ABOVE_ASK" || tag === "AT_ASK") return "BEARISH";
    if (tag === "BELOW_BID" || tag === "AT_BID") return "BULLISH";
  }
  return "NEUTRAL";
}

// ─── Main builder ────────────────────────────────────────────────────────────
export async function buildSchwabFlow(
  symbol: string,
  opts?: { minVolOi?: number; minVolume?: number; maxDte?: number; limit?: number },
): Promise<SchwabFlowResponse | { error: string; symbol: string }> {
  const minVolOi = opts?.minVolOi ?? 2.0;
  const minVolume = opts?.minVolume ?? 100;
  const maxDte = opts?.maxDte ?? 90;
  const limit = opts?.limit ?? 200;

  // Schwab uses '$SPX.X' for the S&P 500 cash index options chain.
  // User passes 'SPX' — normalize here so the rest of the system stays clean.
  // Schwab cash indexes use "$" prefix WITHOUT ".X" suffix.
  const schwabSymbol = symbol === "SPX" ? "$SPX" : symbol;
  const chain = await getOptionChain(schwabSymbol, maxDte);
  if ("error" in chain) {
    return { error: chain.error, symbol };
  }

  const spot = chain.underlying?.last ?? null;
  const contracts: SchwabFlowContract[] = [];

  function processSide(map: Record<string, Record<string, any[]>>, type: "C" | "P") {
    for (const expKey of Object.keys(map)) {
      // Schwab returns "2026-05-16:11" — strip the colon-day-suffix
      const expDate = expKey.split(":")[0];
      const strikesObj = map[expKey];
      for (const strikeStr of Object.keys(strikesObj)) {
        const list = strikesObj[strikeStr];
        if (!Array.isArray(list)) continue;
        for (const c of list) {
          const strike = Number(c.strikePrice ?? strikeStr);
          if (!isFinite(strike)) continue;

          const dte = Number(c.daysToExpiration ?? 0);
          if (dte < 0 || dte > maxDte) continue;

          const volume = Number(c.totalVolume ?? 0);
          if (volume < minVolume) continue;

          const openInterest = Number(c.openInterest ?? 0);
          const isNewStrike = openInterest === 0;
          const volOiRatio = isNewStrike ? Number.POSITIVE_INFINITY : volume / openInterest;
          if (!isNewStrike && volOiRatio < minVolOi) continue;

          const bid = Number(c.bid ?? 0);
          const ask = Number(c.ask ?? 0);
          const last = Number(c.last ?? 0);
          const mark = Number(c.mark ?? 0);
          const mid = calcMid(last, bid, ask, mark);
          if (mid <= 0) continue;

          const notional = volume * mid * 100;
          const tag = deriveTag(last, bid, ask);
          const sentiment = deriveSentiment(type, tag);

          // Schwab returns -999 / -0 sometimes when greeks aren't computed; clamp
          let delta = Number(c.delta ?? 0);
          if (!isFinite(delta) || Math.abs(delta) > 1.5) delta = 0;
          let gamma = Number(c.gamma ?? 0);
          if (!isFinite(gamma)) gamma = 0;
          let theta = Number(c.theta ?? 0);
          if (!isFinite(theta)) theta = 0;
          let vega = Number(c.vega ?? 0);
          if (!isFinite(vega)) vega = 0;
          let iv = Number(c.volatility ?? 0);
          if (!isFinite(iv) || iv < 0) iv = 0;

          contracts.push({
            occ: String(c.symbol ?? `${symbol}_${expDate}_${type}_${strike}`),
            type,
            strike,
            expiration: expDate,
            dte,
            volume,
            openInterest,
            volOiRatio: isNewStrike ? 999 : volOiRatio,  // 999 sentinel for display
            isNewStrike,
            bid,
            ask,
            last,
            mid,
            notional,
            iv,
            tag,
            sentiment,
            // Extended fields
            delta,
            gamma,
            theta,
            vega,
            mark,
          });
        }
      }
    }
  }

  try {
    processSide(chain.callExpDateMap ?? {}, "C");
    processSide(chain.putExpDateMap ?? {}, "P");
  } catch (e: any) {
    return { error: `process_chain_failed: ${e?.message ?? e}`, symbol };
  }

  // Sort by notional desc, take top `limit`
  contracts.sort((a, b) => b.notional - a.notional);
  const trimmed = contracts.slice(0, limit);

  return {
    provider: "schwab",
    symbol,
    spot,
    contracts: trimmed,
    asOf: Date.now(),
  };
}
