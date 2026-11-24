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

import { SETTLE_MARGIN_MS, settledThrough } from "./breadthMath";
export { SETTLE_MARGIN_MS, settledThrough };
import { etClock, etDate, sessionCloseMinutes } from "./exchangeCalendar";

/** A symbol whose fetch came back without the expected session is not asked again sooner than this (the retry skips the request cache). */
export const BEHIND_RETRY_MS = 20 * 60_000;
/** Fewer rows than this from a 2-year daily request is a failed read, not a short history. */
export const MIN_ROWS = 30;

export interface BarRow { date: string; close: number; t: number }
/** What the store remembers about a symbol: the newest session a post-close fetch returned, and when it was asked. */
export interface BarsMark { through: string; checkedAt: number }

export interface SettledBarsStore {
  getBarsMark(symbol: string): BarsMark | null;
  /** Upsert `rows`, remove any row dated after `removeAfter`, and record the mark (`through`, `checkedAt`). */
  storeSettledDailyBars(symbol: string, rows: BarRow[], through: string, checkedAt: number, removeAfter: string): void;
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
  /** For each symbol in `failed` or `behind`: what the last answer was, in plain words. */
  why: Record<string, string>;
}

const inFlight = new Map<string, Promise<FetchedBars>>();

/** One vendor answer: the rows, when the vendor produced them, and whether it is an old copy served after a failed refresh. */
export interface FetchedBars { rows: BarRow[]; asOfMs: number | null; stale?: boolean; /** Why there are no rows, or why the copy is old, in the vendor layer's words. */ reason?: string | null }

/**
 * Bring each symbol's stored daily bars up to the last completed session.
 * `fetchRows` returns the vendor's daily history (it may include the open session's partial bar). `retry` is
 * true when the last answer lacked the expected session, so the caller can skip its cache.
 * Which rows are settled is judged at the time the vendor produced the answer, not at the time it is stored:
 * a copy fetched at 11:00 and served from a cache at 16:30 holds an 11:00 price for today.
 */
export async function refreshSettledDailyBars(
  symbols: readonly string[],
  fetchRows: (symbol: string, retry: boolean) => Promise<FetchedBars>,
  store: SettledBarsStore,
  nowMs: number,
  batch = 6,
): Promise<RefreshResult> {
  const expected = settledThrough(nowMs);
  const cached: string[] = [];
  const behind: string[] = [];
  const need: string[] = [];
  const why: Record<string, string> = {};
  const hhmm = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  for (const sym of symbols) {
    const mark = store.getBarsMark(sym);
    if (mark && mark.through >= expected) cached.push(sym);
    else if (mark && nowMs - mark.checkedAt < BEHIND_RETRY_MS) { behind.push(sym); why[sym] = `bars to ${mark.through}; asked ${Math.round((nowMs - mark.checkedAt) / 60_000)} min ago, next ask after ${BEHIND_RETRY_MS / 60_000} min`; }
    else need.push(sym);
  }

  const failed: string[] = [];
  const fetched: string[] = [];
  for (let i = 0; i < need.length; i += batch) {
    await Promise.all(need.slice(i, i + batch).map(async (sym) => {
      const mark = store.getBarsMark(sym);
      // A retry is a second ask for the same session: the last check already wanted `expected` and did not get it.
      const retry = mark != null && mark.through < expected && settledThrough(mark.checkedAt) === expected;
      // Callers that overlap (several screens asking for the regime at once) share one request per symbol.
      const key = `${sym}|${retry ? 1 : 0}`;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = fetchRows(sym, retry).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      let got: FetchedBars;
      try { got = await pending; } catch (e: any) { failed.push(sym); why[sym] = `request failed: ${String(e?.message ?? e).slice(0, 80)}`; return; }
      // An old copy served because the refresh failed is a failed read, and an answer with no known time cannot be judged.
      if (got.stale) { failed.push(sym); why[sym] = `old copy served${got.asOfMs != null ? ` (from ${hhmm(got.asOfMs)} ET)` : ""}: ${got.reason ?? "refresh failed"}`; return; }
      if (got.asOfMs == null || !Number.isFinite(got.asOfMs)) { failed.push(sym); why[sym] = got.reason ?? (got.rows.length ? "answer without a time" : "no answer"); return; }
      if (got.rows.length < MIN_ROWS) { failed.push(sym); why[sym] = `${got.rows.length} rows returned`; return; }
      const asOfSession = settledThrough(Math.min(got.asOfMs, nowMs));
      const settled = settledRows(got.rows, asOfSession < expected ? asOfSession : expected);
      if (settled.length < MIN_ROWS) { failed.push(sym); why[sym] = `${settled.length} completed sessions returned`; return; }
      const newest = settled.reduce((m, r) => (r.date > m ? r.date : m), settled[0].date);
      // Read the mark again: a caller that started after this one may already have stored a later session.
      const latest = store.getBarsMark(sym);
      if (latest && latest.through > expected) { cached.push(sym); return; }
      // The mark never moves back: a lagging answer does not undo a session already read after its close.
      const through = latest && latest.through > newest ? latest.through : newest;
      // Rows after `expected` are an open session's partial bar. Rows up to it are kept even when this answer lacks them.
      store.storeSettledDailyBars(sym, settled, through, nowMs, expected);
      if (through >= expected) { fetched.push(sym); return; }
      behind.push(sym);
      const rawNewest = got.rows.reduce((m, r) => (r.date > m ? r.date : m), got.rows[0].date);
      why[sym] = `answer from ${hhmm(got.asOfMs)} ET${retry ? " (cache skipped)" : ""} has bars to ${rawNewest}`;
    }));
  }
  return { fetched, cached, failed, behind, expected, why };
}
