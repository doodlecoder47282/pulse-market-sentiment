// server/schwabQuoteFields.ts
//
// Regular-session fields of one Schwab /marketdata/v1/quotes entry. Pure.
//
// Schwab returns the last REGULAR-session trade in a separate `regular`
// object (regular.regularMarketLastPrice, regular.regularMarketTradeTime),
// not inside `quote`. The parser used to read quote.regularMarketLastPrice,
// which REST never fills, so the field was always null from REST. `quote`
// is still read as a fallback for payloads that carry it there.

export interface RegularFields {
  /** Last regular-session trade price, null when absent or not positive. */
  regularMarketLast: number | null;
  /** Time of that trade, epoch ms, null when absent. */
  regularMarketTradeTimeMs: number | null;
}

const pos = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function regularFields(entry: unknown): RegularFields {
  const e = (entry ?? {}) as Record<string, any>;
  const reg = (e.regular ?? {}) as Record<string, any>;
  const q = (e.quote ?? e.fundamental ?? {}) as Record<string, any>;
  return {
    regularMarketLast: pos(reg.regularMarketLastPrice) ?? pos(q.regularMarketLastPrice),
    regularMarketTradeTimeMs: pos(reg.regularMarketTradeTime) ?? pos(q.regularMarketTradeTime),
  };
}
