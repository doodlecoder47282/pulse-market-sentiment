// server/modelsBackoff.ts
//
// How long a failed (empty) /api/models build is held before the next read
// may rebuild it. Pure. An empty build means Schwab refused or could not
// supply the chain (often the self-throttle); retrying every 20 s from every
// poller kept the request budget exhausted. Each consecutive empty build
// doubles the hold, up to a cap; a good build resets the streak.

export const EMPTY_RETRY_BASE_MS = 20_000;
export const EMPTY_RETRY_CAP_MS = 5 * 60_000;

/** Hold after `streak` consecutive empty builds (streak >= 1). */
export function emptyRetryDelayMs(streak: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(streak) ? streak : 1));
  return Math.min(EMPTY_RETRY_CAP_MS, EMPTY_RETRY_BASE_MS * 2 ** Math.min(n - 1, 10));
}
