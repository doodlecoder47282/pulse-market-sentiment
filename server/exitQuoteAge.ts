// server/exitQuoteAge.ts
// Max age of the bid an exit decision may use (R3-2 item 9). Pure.
//
// The exit brain sells at the bid. The stream path is already bounded
// (streamStore.streamRecordUsable: 45 s silence, 120 s quote age). The REST
// path took the tracker's last Schwab chain row with no age check, so a
// failed poll (the tracker keeps its last rows) could stop a position out,
// or hold it, on a bid minutes old.
//
// Rule: a REST chain bid is usable only while its Schwab quote time is at
// most REST_BID_MAX_AGE_MS old. 75 s = the 60 s chain cache TTL
// (schwabDataPolicy.FRESH_TTL_MS.chains: a normal cached chain can already
// be that old) plus 15 s for the tracker's 4 s poll and Schwab's own quote
// stamp latency. An operating limit, not a model. A bid without a quote time
// has unknown age and is not used. Past the limit the action is NO_QUOTE,
// never a decision on an old price.
//
// Quote time (Schwab quoteTimeInLong) is the time of the last bid/ask
// change, so an unchanged but still-valid quote can age out; that errs
// toward NO_QUOTE (the trader is told) rather than toward a stale exit.

export const REST_BID_MAX_AGE_MS = 75_000;

export type ExitQuoteSource = "stream" | "rest_chain" | null;

export function exitBidUsable(
  source: ExitQuoteSource,
  bid: number | null,
  quoteTimeMs: number | null,
  nowMs: number,
): { usable: boolean; ageMs: number | null; reason: string | null } {
  if (bid == null || source == null) return { usable: false, ageMs: null, reason: "no bid" };
  const ageMs = quoteTimeMs != null && Number.isFinite(quoteTimeMs) ? Math.max(0, nowMs - quoteTimeMs) : null;
  // Stream quotes were already checked by streamOptionOverlay / streamRecordUsable.
  if (source === "stream") return { usable: true, ageMs, reason: null };
  if (ageMs == null) return { usable: false, ageMs: null, reason: "REST chain bid has no Schwab quote time (age unknown)" };
  if (ageMs > REST_BID_MAX_AGE_MS) {
    return { usable: false, ageMs, reason: `REST chain bid is ${Math.round(ageMs / 1000)} s old (max ${REST_BID_MAX_AGE_MS / 1000} s)` };
  }
  return { usable: true, ageMs, reason: null };
}
