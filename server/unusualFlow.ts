// server/unusualFlow.ts
//
// Unusual options flow derived from CBOE delayed chain.
// Flags contracts where:
//   - Volume >> Open Interest (Vol/OI ratio >= 2.0) — fresh positioning
//   - Notional (volume × mid × 100) is material
//   - DTE <= 90 (short/mid-dated, where most speculative flow lives)
//
// For each flagged contract:
//   symbol, type (C/P), strike, expiration, dte
//   volume, openInterest, volOiRatio, isNewStrike
//   mid, last, bid, ask
//   notional (volume * mid * 100)
//   iv
//   tag: "ABOVE_ASK" | "AT_ASK" | "AT_BID" | "BELOW_BID" | "MID"  (derived from last vs bid/ask)
//   sentiment: "BULLISH" | "BEARISH" | "NEUTRAL"  (C above ask → BULLISH, P above ask → BEARISH, etc.)
//
// Mid-price logic (improved over naive (bid+ask)/2):
//   If last falls within the bid-ask spread (inRange), use last — it
//   represents the most recent transaction and is more precise than the
//   theoretical mid. Otherwise fall back to (bid+ask)/2.  This is the
//   approach used by most institutional flow scanners: last is the "true"
//   price when it's inside the market; outside the market it's stale/print error.
//
// Schwab-ready stub: when Schwab API lands, swap `getCboeChain` for the Schwab
// equivalent. This module returns the same shape regardless of source.

import { getCboeChain } from "./cboeCache";

const OCC_RE = /^([A-Z]+)(\d{6})([CP])(\d{8})$/;

export type FlowTag = "ABOVE_ASK" | "AT_ASK" | "AT_BID" | "BELOW_BID" | "MID";
export type FlowSentiment = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface UnusualFlowContract {
  occ: string;             // full OCC symbol
  type: "C" | "P";
  strike: number;
  expiration: string;      // YYYY-MM-DD
  dte: number;
  volume: number;
  openInterest: number;
  volOiRatio: number;
  isNewStrike: boolean;    // OI = 0 → brand-new opening position; replaces the fake 99 ratio
  bid: number;
  ask: number;
  last: number;
  mid: number;
  notional: number;        // $ value — volume * mid * 100
  iv: number;
  tag: FlowTag;
  sentiment: FlowSentiment;
}

export interface UnusualFlowResponse {
  provider: "cboe" | "schwab";
  symbol: string;
  spot: number | null;
  contracts: UnusualFlowContract[];
  summary: {
    flaggedCount: number;
    callNotional: number;
    putNotional: number;
    callPutNotionalRatio: number | null;
    aboveAskNotional: number;
    belowBidNotional: number;
    netSentimentNotional: number;   // bullish - bearish
    topTag: FlowTag | null;
  };
  asOf: number;
}

// ─── Math helpers ────────────────────────────────────────────────────────────

/**
 * inRange — returns true if `last` falls strictly between bid and ask
 * (inclusive of the quoted market, exclusive of crosses or stale prints).
 * We use a small tolerance of 0.5 cent to allow for rounding in delayed feeds.
 */
function inRange(last: number, bid: number, ask: number): boolean {
  if (!last || last <= 0 || !bid || !ask || ask < bid) return false;
  const tol = 0.005;  // $0.005 — half a cent tolerance for feed rounding
  return last >= bid - tol && last <= ask + tol;
}

/**
 * calcMid — improved mid-price calculation.
 *
 * Priority:
 *   1. `last` if it falls within the bid-ask spread — it is the most recent
 *      real transaction and more precise than the theoretical mid.
 *   2. (bid + ask) / 2  if both are valid — standard theoretical mid.
 *   3. `last` alone — if bid/ask are missing or inverted, take last as fallback.
 *   4. 0 (caller discards the contract) if none are valid.
 *
 * Why this beats naive (bid+ask)/2:
 *   Many options have wide spreads (0.05–0.30), so the "mid" can be materially
 *   different from where the last print landed. If the last print is inside the
 *   market it tells us the real negotiated price — use that.
 */
function calcMid(last: number, bid: number, ask: number): number {
  const hasSpread = bid > 0 && ask > 0 && ask >= bid;
  if (hasSpread && inRange(last, bid, ask)) return last;
  if (hasSpread) return (bid + ask) / 2;
  if (last > 0) return last;
  return 0;
}

// ─── Tag / Sentiment ─────────────────────────────────────────────────────────

/**
 * deriveTag — map last-trade price to a qualitative tape-side descriptor.
 *
 * "ABOVE ASK"  → aggressive buyer hit above the offer (very bullish on calls)
 * "AT ASK"     → buyer lifted the offer (buyer-initiated)
 * "AT BID"     → seller hit the bid (seller-initiated)
 * "BELOW BID"  → aggressive seller went through the bid (very bearish on calls)
 * "MID"        → crossed inside the spread or ambiguous
 *
 * Tolerance is 10% of the spread, floored at $0.01, to handle small rounding
 * differences in delayed feeds.
 */
function deriveTag(last: number, bid: number, ask: number): FlowTag {
  if (!last || last <= 0 || !bid || !ask || ask < bid) return "MID";
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const tol = Math.max(0.01, spread * 0.1);
  if (last > ask + tol) return "ABOVE_ASK";
  if (Math.abs(last - ask) <= tol) return "AT_ASK";
  if (last < bid - tol) return "BELOW_BID";
  if (Math.abs(last - bid) <= tol) return "AT_BID";
  if (Math.abs(last - mid) <= tol) return "MID";
  // between bid+tol and ask-tol
  return "MID";
}

/**
 * deriveSentiment — map (option type, tape tag) to a directional bias.
 *
 * Logic verified against standard options-flow methodology:
 *   Call bought at/above ask  = bullish (buyer initiating long delta)
 *   Call sold at/below bid    = bearish (seller reducing / shorting delta)
 *   Put bought at/above ask   = bearish (buyer initiating short delta hedge)
 *   Put sold at/below bid     = bullish (seller = put underwriter, collecting premium)
 *   Mid-spread or ambiguous   = neutral
 *
 * Note: "ABOVE_ASK" can indicate institutional sweeps crossing multiple
 * exchanges — same directional signal as AT_ASK but higher urgency.
 */
function deriveSentiment(type: "C" | "P", tag: FlowTag): FlowSentiment {
  // Buyer-initiated (ABOVE_ASK / AT_ASK) on calls = bullish, on puts = bearish.
  // Seller-initiated (BELOW_BID / AT_BID) on calls = bearish, on puts = bullish.
  if (tag === "ABOVE_ASK" || tag === "AT_ASK") return type === "C" ? "BULLISH" : "BEARISH";
  if (tag === "BELOW_BID" || tag === "AT_BID") return type === "C" ? "BEARISH" : "BULLISH";
  return "NEUTRAL";
}

// ─── Main builder ────────────────────────────────────────────────────────────

export async function buildUnusualFlow(
  symbol: string,
  opts?: { minVolOi?: number; minVolume?: number; maxDte?: number; limit?: number },
): Promise<UnusualFlowResponse> {
  const minVolOi = opts?.minVolOi ?? 2.0;
  const minVolume = opts?.minVolume ?? 100;
  const maxDte = opts?.maxDte ?? 90;
  const limit = opts?.limit ?? 40;

  const chain = await getCboeChain(symbol);
  const data = chain?.data ?? {};
  const spot = Number(data.current_price) || null;
  const opts2: any[] = data.options ?? [];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const flagged: UnusualFlowContract[] = [];

  for (const o of opts2) {
    const occ = String(o.option ?? "");
    const m = OCC_RE.exec(occ);
    if (!m) continue;
    const ymd = m[2];
    const year = 2000 + parseInt(ymd.slice(0, 2));
    const month = parseInt(ymd.slice(2, 4)) - 1;
    const day = parseInt(ymd.slice(4, 6));
    const exp = new Date(Date.UTC(year, month, day));
    const dte = Math.round((exp.getTime() - today.getTime()) / 86400000);
    if (dte < 0 || dte > maxDte) continue;

    const strike = parseInt(m[4]) / 1000;
    const type = m[3] as "C" | "P";
    const volume = Number(o.volume ?? 0);
    const openInterest = Number(o.open_interest ?? 0);
    if (volume < minVolume) continue;

    // Vol/OI ratio.
    // When OI = 0, the strike has NO prior open interest — this is a brand-new
    // opening position (often an institutional initiation). We flag it with
    // isNewStrike=true and use volume alone for the notional calculation.
    // We no longer fake volOiRatio=99 to force inclusion; instead we include
    // the contract when volume >= minVolume regardless of ratio, and the UI
    // can display a "NEW" badge based on isNewStrike.
    const isNewStrike = openInterest === 0;
    const volOiRatio = openInterest > 0 ? volume / openInterest : volume >= minVolume ? Infinity : 0;
    if (!isNewStrike && volOiRatio < minVolOi) continue;
    if (isNewStrike && volume < minVolume) continue;

    const bid = Number(o.bid ?? 0);
    const ask = Number(o.ask ?? 0);
    const last = Number(o.last_trade_price ?? 0);

    // Improved mid-price: prefer last if in-spread, else (bid+ask)/2
    const mid = calcMid(last, bid, ask);
    if (!mid || mid <= 0) continue;

    // Notional = volume × mid × 100
    // The ×100 multiplier reflects the OCC standard: 1 equity option contract
    // controls 100 shares. This is correct for all listed US equity options.
    const notional = volume * mid * 100;
    if (notional < 25_000) continue; // skip micro-flow

    const iv = Number(o.iv ?? 0);
    const tag = deriveTag(last, bid, ask);
    const sentiment = deriveSentiment(type, tag);
    const expStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    // Store a finite volOiRatio for display (cap Infinity at a display-safe value)
    const displayVolOiRatio = isNewStrike ? 0 : volOiRatio;

    flagged.push({
      occ,
      type,
      strike,
      expiration: expStr,
      dte,
      volume,
      openInterest,
      volOiRatio: displayVolOiRatio,
      isNewStrike,
      bid,
      ask,
      last,
      mid,
      notional,
      iv,
      tag,
      sentiment,
    });
  }

  // Sort by notional desc
  flagged.sort((a, b) => b.notional - a.notional);
  const top = flagged.slice(0, limit);

  const callNotional = flagged.filter((c) => c.type === "C").reduce((a, b) => a + b.notional, 0);
  const putNotional = flagged.filter((c) => c.type === "P").reduce((a, b) => a + b.notional, 0);
  const aboveAskNotional = flagged.filter((c) => c.tag === "ABOVE_ASK" || c.tag === "AT_ASK").reduce((a, b) => a + b.notional, 0);
  const belowBidNotional = flagged.filter((c) => c.tag === "BELOW_BID" || c.tag === "AT_BID").reduce((a, b) => a + b.notional, 0);
  const netSentimentNotional = flagged
    .filter((c) => c.sentiment !== "NEUTRAL")
    .reduce((a, b) => a + (b.sentiment === "BULLISH" ? b.notional : -b.notional), 0);

  // topTag: most common tag by notional
  const tagNotional: Record<FlowTag, number> = {
    ABOVE_ASK: 0, AT_ASK: 0, MID: 0, AT_BID: 0, BELOW_BID: 0,
  };
  for (const c of flagged) tagNotional[c.tag] += c.notional;
  const topTag = (Object.entries(tagNotional).sort((a, b) => b[1] - a[1])[0]?.[0] as FlowTag) ?? null;

  return {
    provider: "cboe",
    symbol: symbol.toUpperCase(),
    spot,
    contracts: top,
    summary: {
      flaggedCount: flagged.length,
      callNotional,
      putNotional,
      callPutNotionalRatio: callNotional > 0 ? putNotional / callNotional : null,
      aboveAskNotional,
      belowBidNotional,
      netSentimentNotional,
      topTag,
    },
    asOf: Math.floor(Date.now() / 1000),
  };
}
