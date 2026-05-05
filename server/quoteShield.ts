// server/quoteShield.ts
//
// Quote-shield: defensive outlier detection on incoming feed quotes.
//
// CRITICAL: this module DOES NOT delete, suppress, or alter any quote. It only
// returns a metadata flag {suspect: true|false}. Existing calc paths are
// completely unaffected. Callers may CHOOSE to log the flag, but should never
// drop the quote based solely on this module.
//
// Approach: dual-test using both Tukey IQR (robust to mild outliers) and MAD
// (robust to fat tails). If EITHER trips, mark suspect. Both reject true
// outliers reliably; both pass clean ticks.

import { iqrFence, madFlag } from "./stats";

export type QuoteCheck = {
  suspect: boolean;
  reasons: string[];
  modZ: number; // MAD-based modified z-score
};

// Check a single new quote against a recent rolling window of quotes.
// `recent` should be the last 20–60 quotes for that symbol. We do NOT
// maintain the window here — caller passes it in (likely from existing
// tick history or last N closes).
export function checkQuote(
  newPrice: number,
  recent: number[],
): QuoteCheck {
  const reasons: string[] = [];

  if (!isFinite(newPrice)) {
    return { suspect: true, reasons: ["non-finite price"], modZ: NaN };
  }

  if (recent.length < 5) {
    // Not enough history to judge — accept by default.
    return { suspect: false, reasons: [], modZ: 0 };
  }

  const iqr = iqrFence(newPrice, recent, 3.0); // k=3.0 = "extreme" Tukey
  if (iqr.suspect) {
    reasons.push(`outside Tukey 3·IQR fence`);
  }

  const mad = madFlag(newPrice, recent, 5.0); // very conservative — only true outliers
  if (mad.suspect) {
    reasons.push(`MAD modified z = ${mad.modZ.toFixed(1)}`);
  }

  return {
    suspect: reasons.length > 0,
    reasons,
    modZ: mad.modZ,
  };
}

// Convenience wrapper: returns the same payload but also logs to stderr in
// dev mode so we have a paper trail without changing data flow.
export function checkAndLog(
  symbol: string,
  newPrice: number,
  recent: number[],
): QuoteCheck {
  const result = checkQuote(newPrice, recent);
  if (result.suspect) {
    console.warn(
      `[quoteShield] ${symbol} ${newPrice} flagged: ${result.reasons.join(", ")}`,
    );
  }
  return result;
}
