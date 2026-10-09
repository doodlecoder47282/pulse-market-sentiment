// server/unusualFlow.ts
//
// Shared types for the unusual options flow panel. The scanner itself is
// schwabFlow.buildSchwabFlow (Schwab option chain); the CBOE delayed-chain
// builder that lived here was removed with the CBOE data path (user decision
// 2026-10-08: Schwab is the only market-data source).
//
// Flagged contract fields:
//   symbol, type (C/P), strike, expiration, dte
//   volume, openInterest, volOiRatio, isNewStrike
//   mid, last, bid, ask
//   notional (volume * mid * 100)
//   iv
//   tag: "ABOVE_ASK" | "AT_ASK" | "AT_BID" | "BELOW_BID" | "MID"  (latest print vs bid/ask)
//   sentiment: "BULLISH" | "BEARISH" | "NEUTRAL"

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
  provider: "schwab";
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
  /** Epoch seconds: when Schwab produced the chain behind this result. */
  asOf: number;
  /** "ok" = Schwab chain scanned (an empty list is an observed empty result); "unavailable" = Schwab did not answer. */
  dataState?: "ok" | "unavailable";
  /** Human-readable note (e.g. why the result is unavailable). */
  note?: string;
}
