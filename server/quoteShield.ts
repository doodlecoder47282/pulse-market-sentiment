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

// ─── In-memory rolling window per symbol (flag-only — never gates anything) ──
const MAX_WINDOW = 60;
const windows: Map<string, number[]> = new Map();
const lastFlag: Map<string, QuoteCheck & { ts: number }> = new Map();

/**
 * Observer entry-point: pass every newly-ingested price through this. The
 * function silently maintains a per-symbol rolling window and returns the
 * shield decision. Callers MUST NOT use the result to alter quote flow —
 * only to log or surface in diagnostics.
 */
export function observeQuote(symbol: string, price: number): QuoteCheck {
  try {
    if (!isFinite(price) || price <= 0) {
      return { suspect: true, reasons: ["non-finite or non-positive"], modZ: NaN };
    }
    const arr = windows.get(symbol) ?? [];
    const result = checkQuote(price, arr);
    arr.push(price);
    while (arr.length > MAX_WINDOW) arr.shift();
    windows.set(symbol, arr);
    lastFlag.set(symbol, { ...result, ts: Date.now() });
    if (result.suspect) {
      console.warn(
        `[quoteShield] ${symbol} suspect price ${price.toFixed(2)} — ${result.reasons.join(", ")} (modZ=${result.modZ.toFixed(2)})`,
      );
    }
    return result;
  } catch {
    return { suspect: false, reasons: [], modZ: 0 };
  }
}

/** Read-only export of last-flag-per-symbol for the diagnostics endpoint. */
export function shieldStatus(): Array<{
  symbol: string;
  suspect: boolean;
  reasons: string[];
  modZ: number;
  windowSize: number;
  ageSeconds: number;
}> {
  const out: Array<any> = [];
  for (const [symbol, flag] of lastFlag.entries()) {
    out.push({
      symbol,
      suspect: flag.suspect,
      reasons: flag.reasons,
      modZ: flag.modZ,
      windowSize: windows.get(symbol)?.length ?? 0,
      ageSeconds: Math.round((Date.now() - flag.ts) / 1000),
    });
  }
  return out;
}

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
