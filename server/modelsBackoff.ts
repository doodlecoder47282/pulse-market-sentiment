// server/modelsBackoff.ts
//
// How long a failed (empty) /api/models build is held before the next read
// may rebuild it. Pure. An empty build means Schwab refused or could not
// supply the chain (often the self-throttle); retrying every 20 s from every
// poller kept the request budget exhausted. Each consecutive empty build
// doubles the hold, up to a cap; a good build resets the streak.

export const EMPTY_RETRY_BASE_MS = 20_000;
export const EMPTY_RETRY_CAP_MS = 5 * 60_000;

/** Hold after `streak` consecutive empty builds (streak >= 1), at most `capMs`. */
export function emptyRetryDelayMs(streak: number, capMs: number = EMPTY_RETRY_CAP_MS): number {
  const n = Math.max(1, Math.floor(Number.isFinite(streak) ? streak : 1));
  return Math.min(capMs, EMPTY_RETRY_BASE_MS * 2 ** Math.min(n - 1, 10));
}

/** Session cap: the self-throttle clears in a rolling minute, so in the session an
 *  empty build is retried at least every 2 min (a recovered Schwab is read promptly). */
export const EMPTY_RETRY_SESSION_CAP_MS = 2 * 60_000;

// ---- Cache gate (pure) ----------------------------------------------------
// When may a cached models build be served? Shared by the building read and
// the peek read so both apply one rule, and the peek can say WHY it missed.

export type ModelsCacheMiss = "never_built" | "expired" | "empty_hold_elapsed" | "chain_old";
export interface ModelsCacheEntry {
  /** When the build finished (ms). */
  at: number;
  /** No horizon in the build (Schwab could not supply the chain). */
  empty: boolean;
  /** Oldest chain quote time across horizons (ms), or null. */
  chainAsOfMs: number | null;
}
export interface ModelsGateArgs {
  nowMs: number;
  /** Cadence for this entry: MODELS_CACHE_MS for a good build, the backoff hold for an empty one. */
  holdMs: number;
  /** Chain max serve age right now (maxServeAgeMs("chains")). */
  chainMaxAgeMs: number;
  marketOpen: boolean;
  /** lastSettledCloseMs(now): close of the last finished session + 15 min, or null. */
  settledCloseMs: number | null;
}
export type ModelsGate = { serve: true; lastSession: boolean } | { serve: false; miss: ModelsCacheMiss };

export function modelsCacheGate(e: ModelsCacheEntry | null | undefined, a: ModelsGateArgs): ModelsGate {
  if (!e) return { serve: false, miss: "never_built" };
  if (a.nowMs - e.at >= a.holdMs) return { serve: false, miss: e.empty ? "empty_hold_elapsed" : "expired" };
  if (e.chainAsOfMs == null || a.nowMs - e.chainAsOfMs <= a.chainMaxAgeMs) return { serve: true, lastSession: false };
  // Market closed: the chain's quote time stops at the last print, so its age
  // grows all evening and weekend. A build made after the last session settled
  // holds the latest chain Schwab has (nothing settles until the next open);
  // it is served within its cadence, the same rule staleServeDecision applies
  // to a cached chain (schwabDataPolicy.ts).
  if (!a.marketOpen && a.settledCloseMs != null && e.at >= a.settledCloseMs) return { serve: true, lastSession: true };
  return { serve: false, miss: "chain_old" };
}

const etClock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(ms);

/** Plain-language reason a peek found no servable build. Each state named apart. */
export function modelsPeekReason(
  state: { inFlight: boolean; entry: ModelsCacheEntry | null | undefined; miss: ModelsCacheMiss | null },
  a: Pick<ModelsGateArgs, "nowMs" | "chainMaxAgeMs">,
): string {
  if (state.inFlight) return "a models build is running; headlines do not wait for it";
  const e = state.entry;
  if (!e || state.miss === "never_built") return "no models build since the server started; headlines do not start one (the Trade Desk or the session ticker does)";
  const at = `${etClock(e.at)} ET`;
  if (state.miss === "empty_hold_elapsed") return `the last build (${at}) had no horizon because Schwab did not supply the chain; the next Trade Desk or session-ticker read rebuilds it`;
  if (state.miss === "expired") return `the last build (${at}) is past its 30-min rebuild cadence; the next Trade Desk or session-ticker read rebuilds it`;
  const ageMin = e.chainAsOfMs != null ? Math.round((a.nowMs - e.chainAsOfMs) / 60_000) : null;
  return `the last build's chain (${ageMin ?? "?"} min old) is past the ${Math.round(a.chainMaxAgeMs / 60_000)} min limit; the next Trade Desk or session-ticker read rebuilds it`;
}
