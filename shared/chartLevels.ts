// shared/chartLevels.ts
//
// Which chain answers /api/gamma-levels for a chart symbol, and whether a set
// of levels may be drawn on that chart. Levels are only drawn on candles of
// the SAME underlying: a level is a price on its own chain's scale, and no
// fixed ratio converts SPY strikes into SPX points (or the reverse).

/** One name per underlying: SPX, ^GSPC, ^SPX and $SPX are the same index. */
export function chartUnderlying(symbol: string | null | undefined): string {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (s === "^GSPC" || s === "^SPX" || s === "$SPX" || s === "SPX" || s === "$SPX.X") return "SPX";
  return s;
}

export type LevelsSource = "spy_snapshot" | "index_not_wired" | "per_ticker";

/**
 * SPY reads the shared SPY snapshot. The S&P 500 index has no level source on
 * its own scale here (the snapshot is the SPY chain), so it is "not wired"
 * rather than answered with SPY's levels. Everything else uses its own chain.
 */
export function levelsSourceFor(symbol: string): LevelsSource {
  const u = chartUnderlying(symbol);
  if (u === "SPY") return "spy_snapshot";
  if (u === "SPX") return "index_not_wired";
  return "per_ticker";
}

export const INDEX_NOT_WIRED_REASON =
  "Dealer levels on this chart come from the SPY option chain, on SPY's price scale; they are not drawn on S&P 500 index candles. Switch the chart to SPY to see them.";

/** Levels may be drawn only when they were computed for the chart's own underlying. */
export function levelsMatchChart(levelsSymbol: string | null | undefined, chartSymbol: string | null | undefined): boolean {
  if (!levelsSymbol || !chartSymbol) return false;
  return chartUnderlying(levelsSymbol) === chartUnderlying(chartSymbol);
}
