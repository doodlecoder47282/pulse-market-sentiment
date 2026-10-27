// ─────────────────────────────────────────────────────────────────────────────
// schwabFlow.ts — Schwab-native unusual options flow detector.
//
// The unusual-flow scanner (the CBOE-backed builder was removed). Why Schwab:
//   - No rate-limiting (we're authenticated)
//   - Real-time greeks (delta, gamma) — needed for delta-floor sanity check
//   - Mark price + bid/ask/last all in one payload
//   - Volume + OI native (no OCC parsing)
//
// Output shape mirrors UnusualFlowContract (drop-in compatible) plus a `delta`
// field so the BANGERS / whale gates can do delta-aware filtering.
// ─────────────────────────────────────────────────────────────────────────────

import { getOptionChain, getOptionChainLadder } from "./schwab";
import type { UnusualFlowContract, FlowTag, FlowSentiment } from "./unusualFlow";
import { schwabNum } from "./schwabChainRows";

export interface SchwabFlowContract extends UnusualFlowContract {
  delta: number;          // signed: calls 0..1, puts -1..0
  gamma: number;
  theta: number;
  vega: number;
  iv: number;             // Schwab `volatility`, in PERCENT (23.4 = 23.4%); 0 when not computed
  mark: number;           // theo mid from Schwab
  /** Schwab tradeTimeInLong / quoteTimeInLong (epoch ms); null when absent. Needed to attribute volume to prints (flowAttribution.ts). */
  tradeTimeMs: number | null;
  quoteTimeMs: number | null;
}

export interface SchwabFlowResponse {
  provider: "schwab";
  symbol: string;
  spot: number | null;
  contracts: SchwabFlowContract[];
  /** Contracts Schwab listed without volume or open interest (or with -999): not scanned, not "new strikes". */
  skippedMissingFields: number;
  /** Epoch ms: when Schwab produced the chain (was the time of this call). */
  asOf: number;
  /** true = a refresh failed and an older chain (within its max age) was scanned. */
  stale?: boolean;
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
  opts?: { minVolOi?: number; minVolume?: number; maxDte?: number; limit?: number; /** Tests: scan this chain instead of reading Schwab. */ chain?: any },
): Promise<SchwabFlowResponse | { error: string; symbol: string }> {
  const minVolOi = opts?.minVolOi ?? 2.0;
  const minVolume = opts?.minVolume ?? 100;
  const maxDte = opts?.maxDte ?? 90;
  const limit = opts?.limit ?? 200;

  // Schwab uses '$SPX.X' for the S&P 500 cash index options chain.
  // User passes 'SPX' — normalize here so the rest of the system stays clean.
  // Schwab cash indexes use "$" prefix WITHOUT ".X" suffix.
  const schwabSymbol = symbol === "SPX" ? "$SPX" : symbol;
  // One 0-90 DTE $SPX request at 300 strikes is ~70 expiries and Schwab
  // answers 502. Past 14 DTE read it as dated segments (same as /api/option-chain).
  const chain = opts?.chain ?? (maxDte > 14 ? await getOptionChainLadder(schwabSymbol, maxDte) : await getOptionChain(schwabSymbol, maxDte));
  if ("error" in chain) {
    return { error: chain.error, symbol };
  }

  const spot = chain.underlying?.last ?? null;
  const contracts: SchwabFlowContract[] = [];
  let skippedMissingFields = 0;

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

          // Missing is not zero: a contract Schwab reports without volume or
          // open interest (or with its -999 sentinel) is skipped and counted,
          // never read as a new strike with infinite volume/OI.
          const volumeN = schwabNum(c.totalVolume);
          const oiN = schwabNum(c.openInterest);
          if (volumeN == null || oiN == null) { skippedMissingFields++; continue; }
          const volume = volumeN;
          if (volume < minVolume) continue;

          const openInterest = oiN;
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
          // Greeks: schwabNum drops -999 sentinels; 0 means "not computed" here.
          let delta = schwabNum(c.delta) ?? 0;
          if (Math.abs(delta) > 1.5) delta = 0;
          const gamma = schwabNum(c.gamma) ?? 0;
          const theta = schwabNum(c.theta) ?? 0;
          const vega = schwabNum(c.vega) ?? 0;
          // iv is Schwab's `volatility`: PERCENT (23.4 = 23.4%), never multiplied again on display.
          let iv = schwabNum(c.volatility) ?? 0;
          if (iv < 0 || iv >= 500) iv = 0;
          const tradeTimeMs = typeof c.tradeTimeInLong === "number" && c.tradeTimeInLong > 0 ? c.tradeTimeInLong : null;
          const quoteTimeMs = typeof c.quoteTimeInLong === "number" && c.quoteTimeInLong > 0 ? c.quoteTimeInLong : null;

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
            tradeTimeMs,
            quoteTimeMs,
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
    skippedMissingFields,
    asOf: chain.asOfMs,
    stale: chain.stale,
  };
}
