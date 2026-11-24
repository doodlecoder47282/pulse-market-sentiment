// Stored daily bars hold completed sessions only.
//
// Two defects this replaces (both refreshers had them):
//   1. A fetch made while the session was open stored today's bar with the price at that moment. From the
//      next day the store already "had" that date, so it was never read again and the mid-session price
//      stayed as that day's close.
//   2. A fetch that answered without the newest completed session counted as done, and the symbol was not
//      tried again until the next 6-hour pass.
//
// The rule now: a bar is stored only for a session that has closed (plus a short margin for the vendor to
// post it), and a symbol is current only when a fetch made after that close has returned that session.

import { lastCompletedSession } from "./breadthMath";
import { etClock, etDate, sessionCloseMinutes } from "./exchangeCalendar";

/** After the close, wait this long before the day's bar is taken as the session's bar. */
export const SETTLE_MARGIN_MS = 20 * 60_000;
/** A symbol whose fetch came back without the expected session is not asked again sooner than this. */
export const BEHIND_RETRY_MS = 20 * 60_000;
/** Fewer rows than this from a 2-year daily request is a failed read, not a short history. */
export const MIN_ROWS = 30;

export interface BarRow { date: string; close: number; t: number }
/** What the store remembers about a symbol: the newest session a post-close fetch returned, and when it was asked. */
export interface BarsMark { through: string; checkedAt: number }

export interface SettledBarsStore {
  getBarsMark(symbol: string): BarsMark | null;
  /** Replace the symbol's rows with `rows`, remove any row dated after `through`, and record the mark. */
  storeSettledDailyBars(symbol: string, rows: BarRow[], through: string, checkedAt: number): void;
}

/** The newest session (New York date) whose daily bar is final enough to store. */
export function settledThrough(nowMs: number): string {
  return lastCompletedSession(nowMs - SETTLE_MARGIN_MS);
}

/**
 * The end time to send with a daily-history request on the evening of a session.
 *
 * Without an end time the vendor's daily history stops at the previous business day's close, so from the
 * close until midnight New York the session that just finished is missing (seen live on 2026-11-23: after
 * the close the newest daily bar was still Friday's). On that evening this returns one fixed instant, the
 * close plus the margin, so the request is the same all evening and is cached once. At any other time the
 * default already reaches the last completed session and this returns null.
 */
export function settledEndDateMs(nowMs: number): number | null {
  const today = etDate(nowMs);
  if (settledThrough(nowMs) !== today) return null;
  const close = sessionCloseMinutes(today);
  if (close == null) return null;
  const clock = etClock(nowMs);
  const sinceSettle = clock.minutes - (close + SETTLE_MARGIN_MS / 60_000);
  if (sinceSettle < 0) return null;
  return Math.floor(nowMs / 60_000) * 60_000 - sinceSettle * 60_000;
}

export type BarsState = "current" | "behind" | "missing";

/** Stored bars against the session they should reach. */
export function barsState(latest: string | null | undefined, through: string): BarsState {
  if (!latest) return "missing";
  return latest >= through ? "current" : "behind";
}

/** Rows for completed sessions only: the open session's partial bar is dropped. */
export function settledRows<T extends { date: string }>(rows: T[], through: string): T[] {
  return rows.filter((r) => r.date <= through);
}

export interface RefreshResult {
  /** Fetched and now holding the expected session. */
  fetched: string[];
  /** Already held the expected session from a post-close fetch. */
  cached: string[];
  /** The request failed or returned too little to store. */
  failed: string[];
  /** The request answered, but without the expected session; older bars are kept and labelled. */
  behind: string[];
  expected: string;
}

/**
 * Bring each symbol's stored daily bars up to the last completed session.
 * `fetchRows` returns the vendor's daily history (it may include the open session's partial bar).
 */
export async function refreshSettledDailyBars(
  symbols: readonly string[],
  fetchRows: (symbol: string) => Promise<BarRow[]>,
  store: SettledBarsStore,
  nowMs: number,
  batch = 6,
): Promise<RefreshResult> {
  const expected = settledThrough(nowMs);
  const cached: string[] = [];
  const behind: string[] = [];
  const need: string[] = [];
  for (const sym of symbols) {
    const mark = store.getBarsMark(sym);
    if (mark && mark.through >= expected) cached.push(sym);
    else if (mark && nowMs - mark.checkedAt < BEHIND_RETRY_MS) behind.push(sym);
    else need.push(sym);
  }

  const failed: string[] = [];
  const fetched: string[] = [];
  for (let i = 0; i < need.length; i += batch) {
    await Promise.all(need.slice(i, i + batch).map(async (sym) => {
      let rows: BarRow[];
      try { rows = await fetchRows(sym); } catch { failed.push(sym); return; }
      if (rows.length < MIN_ROWS) { failed.push(sym); return; }
      const settled = settledRows(rows, expected);
      if (settled.length < MIN_ROWS) { failed.push(sym); return; }
      const newest = settled.reduce((m, r) => (r.date > m ? r.date : m), settled[0].date);
      store.storeSettledDailyBars(sym, settled, newest, nowMs);
      (newest >= expected ? fetched : behind).push(sym);
    }));
  }
  return { fetched, cached, failed, behind, expected };
}
