// server/schwabSymbols.ts
//
// One map from the app's Yahoo-style index tickers to Schwab's index symbols.
// Pure module (no imports) so quotes.ts, sources.ts and tests share it.
//
// Schwab index symbols take a "$" prefix and no ".X" suffix:
//   - schwab-py client docs, Movers.Index enum: DJI = '$DJI', COMPX = '$COMPX',
//     SPX = '$SPX' (https://schwab-py.readthedocs.io/en/latest/client.html)
//   - jkoelker/zephyr Schwab skill: "Prefix indices/volatility products with `$`
//     (e.g., `$SPX`, `$VIX`, `$VIX1D`)" (https://tomevault.io/tome/jkoelker/zephyr)
//   - this app, observed live earlier: $VIX answers, $VIX.X returns nothing.
// The other volatility indices ($VIX9D, $VIX3M, $VVIX, $SKEW, $VXN, $RVX) and
// $NDX / $RUT follow the same convention but were not individually confirmed
// against a live Schwab response. If Schwab returns no quote for one, the input
// is unavailable (null + reason); nothing substitutes another vendor or ticker.

const YAHOO_TO_SCHWAB: Record<string, string> = {
  "^VIX": "$VIX",
  "^VIX1D": "$VIX1D",
  "^VIX9D": "$VIX9D",
  "^VIX3M": "$VIX3M",
  "^VVIX": "$VVIX",
  "^SKEW": "$SKEW",
  "^GSPC": "$SPX",
  "^SPX": "$SPX",
  "^NDX": "$NDX",
  "^RUT": "$RUT",
  "^VXN": "$VXN",
  "^RVX": "$RVX",
  "^DJI": "$DJI",
  "^IXIC": "$COMPX",
};

/** Index inputs the app reads, with the Schwab symbol each comes from. */
export const SCHWAB_INDEX_INPUTS: ReadonlyArray<{ input: string; schwab: string; confirmed: boolean }> = [
  { input: "SPX", schwab: "$SPX", confirmed: true },
  { input: "VIX", schwab: "$VIX", confirmed: true },
  { input: "Nasdaq Composite", schwab: "$COMPX", confirmed: true },
  { input: "Dow", schwab: "$DJI", confirmed: true },
  { input: "VIX1D", schwab: "$VIX1D", confirmed: false },
  { input: "VIX9D", schwab: "$VIX9D", confirmed: false },
  { input: "VIX3M", schwab: "$VIX3M", confirmed: false },
  { input: "VVIX", schwab: "$VVIX", confirmed: false },
  { input: "SKEW", schwab: "$SKEW", confirmed: false },
  { input: "NDX", schwab: "$NDX", confirmed: false },
  { input: "RUT", schwab: "$RUT", confirmed: false },
];

/**
 * Yahoo-style ("^VIX"), legacy Schwab ("$VIX.X") or bare cash-index names
 * ("SPX", "NDX", "RUT", "VIX") -> Schwab symbol. Other tickers pass through.
 */
export function toSchwabSymbol(symbol: string): string {
  const s = String(symbol ?? "").trim();
  if (YAHOO_TO_SCHWAB[s]) return YAHOO_TO_SCHWAB[s];
  if (s.startsWith("$") && s.endsWith(".X")) return s.slice(0, -2);
  return s;
}

/** Bare cash-index ticker -> Schwab "$" symbol, for option-chain requests. */
export const CASH_INDEX_TO_SCHWAB: Record<string, string> = {
  SPX: "$SPX",
  SPXW: "$SPX",
  NDX: "$NDX",
  RUT: "$RUT",
  VIX: "$VIX",
};
