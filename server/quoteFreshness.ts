// server/quoteFreshness.ts
//
// Pure helper: is a Schwab quote fresh enough to present as live?
//
// During the regular session a quote's own timestamp (Schwab quoteTime, else
// tradeTime) should advance continuously: our quote cache refreshes every
// 30 s and the header polls every 5 s. A quote whose timestamp is more than
// QUOTE_STALE_AFTER_MS old while the market is open means the feed is not
// refreshing (or schwabFetch served an old cached payload after a 403/429/5xx
// or throttle), so it is flagged stale. Outside the regular session an old
// quote is normal (stale = false, age still reported). Unknown age during the
// session is stale = null (unknown), never "live".

import { isRegularSessionOpen } from "./exchangeCalendar";

/** Two minutes: 4x the 30 s quote cache TTL; generous for SPY/SPX/VIX, which update every few seconds. */
export const QUOTE_STALE_AFTER_MS = 120_000;

export interface QuoteFreshness {
  /** now - quote timestamp, ms; null when the quote carried no timestamp. */
  ageMs: number | null;
  /** true = old during the session; false = fresh or market closed; null = age unknown during the session. */
  stale: boolean | null;
  marketOpen: boolean;
}

export function quoteFreshness(quoteTimeMs: number | null | undefined, nowMs: number = Date.now()): QuoteFreshness {
  const marketOpen = isRegularSessionOpen(nowMs);
  if (quoteTimeMs == null || !Number.isFinite(quoteTimeMs) || quoteTimeMs <= 0) {
    return { ageMs: null, stale: marketOpen ? null : false, marketOpen };
  }
  const ageMs = Math.max(0, nowMs - quoteTimeMs);
  return { ageMs, stale: marketOpen ? ageMs > QUOTE_STALE_AFTER_MS : false, marketOpen };
}
