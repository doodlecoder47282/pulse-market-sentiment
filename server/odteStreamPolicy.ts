// 0DTE tracker stream policy (pure; unit-testable).
//
// The tracker's streamed option contracts are $SPX contracts: armed positions
// (streamStore owner "odte") and fired 0DTE alerts (owner "odte_alerts").
// When the $SPX chain fails and the tracker falls back to the SPY chain for
// context, the SPY rows (keyed SPY_...) can never match those contracts, so
// re-syncing either owner from the SPY chain would drop the $SPX
// subscriptions and stop the per-update marks the grader replays. Only the
// $SPX chain may re-sync them; on a fallback they are left as they are.
export type OdteStreamOwner = "odte" | "odte_alerts";

export function streamOwnersSyncedBy(chainSymbol: string): OdteStreamOwner[] {
  return chainSymbol === "$SPX" ? ["odte", "odte_alerts"] : [];
}

/**
 * Option symbols to stream for armed positions. A position whose symbol is
 * not in the current snapshot keeps its remembered symbol (never dropped
 * because one poll lacked it).
 */
export function armedStreamSymbols(
  tracked: ReadonlyArray<{ status: string; contractKey: string; optionSymbol?: string | null }>,
  contracts: ReadonlyArray<{ key: string; optionSymbol?: string | null }>,
): string[] {
  const out: string[] = [];
  for (const t of tracked) {
    if (t.status !== "active") continue;
    const sym = t.optionSymbol ?? contracts.find((c) => c.key === t.contractKey)?.optionSymbol ?? null;
    if (sym && !out.includes(sym)) out.push(sym);
  }
  return out;
}
