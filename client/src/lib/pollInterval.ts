// client/src/lib/pollInterval.ts
//
// Poll pacing by the exchange session clock (shared/exchangeCalendar.ts, the
// same calendar the server serves data by). A live poller (3-15 s) is for the
// regular session; outside it (overnight, weekends, holidays) the same panel
// re-asks every OFF_SESSION_MS instead. Nothing it would learn changes faster
// than that: the server labels a closed-market payload last_session and
// serves it from its cache, so a 5-second loop on a Saturday only spends the
// server's request budget and the laptop's battery re-reading Friday's close.
//
// Pre- and post-market (04:00-09:30, 16:00-20:00 ET on a trading day) keep a
// slower live cadence: quotes and minute bars do move then.

import { isRegularSessionOpen, isTradingDay, etDate } from "@shared/exchangeCalendar";

export const OFF_SESSION_MS = 5 * 60_000;
export const EXTENDED_HOURS_FACTOR = 6;

/** 04:00-20:00 ET on a trading day, outside the regular session. */
export function inExtendedHours(ms: number = Date.now()): boolean {
  if (isRegularSessionOpen(ms)) return false;
  const d = etDate(ms);
  if (!isTradingDay(d)) return false;
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ms)));
  return h >= 4 && h < 20;
}

/**
 * The interval a panel should poll at: `liveMs` in the regular session,
 * `liveMs * EXTENDED_HOURS_FACTOR` (at most OFF_SESSION_MS) in extended hours,
 * OFF_SESSION_MS otherwise. Pass as react-query's refetchInterval function so
 * it is re-evaluated on every tick (the session opens while the tab is open).
 */
export function pacedInterval(liveMs: number, ms: number = Date.now()): number {
  if (isRegularSessionOpen(ms)) return liveMs;
  if (inExtendedHours(ms)) return Math.min(OFF_SESSION_MS, liveMs * EXTENDED_HOURS_FACTOR);
  return OFF_SESSION_MS;
}

/** react-query refetchInterval that re-evaluates the pace on every tick. */
export function livePoll(liveMs: number): () => number {
  return () => pacedInterval(liveMs);
}
