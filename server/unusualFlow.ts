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
//   volume, openInterest, volOiRatio
//   mid, last, bid, ask
//   notional (volume * mid * 100)
//   iv
//   tag: "ABOVE_ASK" | "AT_ASK" | "AT_BID" | "BELOW_BID" | "MID"  (derived from last vs bid/ask)
//   sentiment: "BULLISH" | "BEARISH" | "NEUTRAL"  (C above ask → BULLISH, P above ask → BEARISH, etc.)
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
  bid: number;
  ask: number;
  last: number;
  mid: number;
  notional: number;         // $ value — volume * mid * 100
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

function deriveSentiment(type: "C" | "P", tag: FlowTag): FlowSentiment {
  // Buyer-initiated (ABOVE_ASK / AT_ASK) on calls = bullish, on puts = bearish.
  // Seller-initiated (BELOW_BID / AT_BID) on calls = bearish, on puts = bullish.
  if (tag === "ABOVE_ASK" || tag === "AT_ASK") return type === "C" ? "BULLISH" : "BEARISH";
  if (tag === "BELOW_BID" || tag === "AT_BID") return type === "C" ? "BEARISH" : "BULLISH";
  return "NEUTRAL";
}

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

    // Vol/OI ratio. If OI=0, treat as "new opening" — floor at 2.0 if volume >= minVolume.
    const volOiRatio = openInterest > 0 ? volume / openInterest : volume >= minVolume ? 99 : 0;
    if (volOiRatio < minVolOi) continue;

    const bid = Number(o.bid ?? 0);
    const ask = Number(o.ask ?? 0);
    const last = Number(o.last_trade_price ?? 0);
    const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : last;
    if (!mid || mid <= 0) continue;
    const notional = volume * mid * 100;
    if (notional < 25_000) continue; // skip micro-flow

    const iv = Number(o.iv ?? 0);
    const tag = deriveTag(last, bid, ask);
    const sentiment = deriveSentiment(type, tag);
    const expStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    flagged.push({
      occ,
      type,
      strike,
      expiration: expStr,
      dte,
      volume,
      openInterest,
      volOiRatio,
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
