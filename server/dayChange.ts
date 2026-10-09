// server/dayChange.ts
//
// One definition of "day change": the latest price minus the close of the
// regular session BEFORE the session that price belongs to.
//
// Pure module (imports only ./exchangeCalendar). The network side lives in
// quotes.ts (resolveSessionPrevClose), which feeds this module Schwab's quote
// and daily bars.
//
// Sources of the prior close, in order:
//   1. Schwab quote `closePrice` (the previous session's close) or, if it is
//      missing, `lastPrice - netChange` (Schwab defines netChange against that
//      same close). Used only when the price being compared is from today's ET
//      session, because the quote's close always refers to the session before
//      "now".
//   2. Schwab DAILY bars: the last daily bar dated before the price's session
//      date. Used when the price is from an earlier session (weekend,
//      pre-market with no bars yet today) or the quote is unavailable.
//   3. Otherwise unavailable (null) -- never the first intraday bar (that is
//      change since the open) and never the previous candle (a one-bar change).

import { type IsoDate, etDate } from "./exchangeCalendar";

export type PrevCloseSource =
  | "schwab_quote_close"
  | "schwab_quote_net_change"
  | "daily_bar"
  | "unavailable";

export interface DailyBarLike {
  /** Bar timestamp, epoch SECONDS. */
  t: number;
  /** Close, $ per share (index points for cash indexes). */
  c: number;
}

export interface QuoteCloseLike {
  /** Schwab quote closePrice: documented as the previous session close (may roll after 16:00 ET). */
  closePrice?: number | null;
  lastPrice?: number | null;
  netChange?: number | null;
  /** Schwab regularMarketLastPrice: last regular-session trade. */
  regularMarketLast?: number | null;
}

export interface PrevCloseResult {
  prevClose: number | null;
  source: PrevCloseSource;
  /** ET date of the session whose close was used, when known. */
  prevCloseDate: IsoDate | null;
  /** true when Schwab's quote closePrice was found to be today's close (rolled) and was not used. */
  closeRolled?: boolean;
  /** Why prevClose is unavailable, when it is. */
  reason?: string;
}

const NOON_SHIFT_MS = 12 * 3600 * 1000;

/**
 * ET session date of a DAILY bar. Schwab stamps daily candles at local
 * midnight; shifting by +12 h before taking the ET date gives the same answer
 * whether the stamp is midnight Central, Eastern or UTC.
 */
export function dailyBarSessionDate(tSec: number): IsoDate {
  return etDate(tSec * 1000 + NOON_SHIFT_MS);
}

/** ET date of an intraday bar (true timestamp), epoch seconds. */
export function intradayBarSessionDate(tSec: number): IsoDate {
  return etDate(tSec * 1000);
}

/** Close of the last daily bar whose session date is strictly before `beforeDate`. */
export function prevCloseFromDailyBars(
  bars: readonly DailyBarLike[] | null | undefined,
  beforeDate: IsoDate,
): { close: number; date: IsoDate } | null {
  if (!bars || !bars.length) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b || !(b.c > 0) || !isFinite(b.c)) continue;
    const d = dailyBarSessionDate(b.t);
    if (d < beforeDate) return { close: b.c, date: d };
  }
  return null;
}

/** Close of the daily bar dated exactly `date`, if present. */
export function dailyBarCloseOn(
  bars: readonly DailyBarLike[] | null | undefined,
  date: IsoDate,
): number | null {
  if (!bars || !bars.length) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b || !(b.c > 0) || !isFinite(b.c)) continue;
    if (dailyBarSessionDate(b.t) === date) return b.c;
  }
  return null;
}

/**
 * Two closes "match" when they differ by at most max(0.5 cent, 1 bp): a daily
 * bar close and a quote closePrice for the same session agree to the cent,
 * while two different sessions' closes almost never do.
 */
export function sameClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.005, 1e-4 * Math.max(Math.abs(a), Math.abs(b)));
}

/**
 * Prior close for a price observed in session `priceSessionDate`.
 *
 * Schwab's quote `closePrice` is documented as the previous close, but quote
 * feeds commonly roll it to the CURRENT session's close some time after
 * 16:00 ET (Schwab does not document when). If it has rolled, last -
 * closePrice is ~0 and "day change" silently reads flat. So the quote close is
 * checked against the session dates of Schwab daily bars whenever they are
 * available (always after the close, see quotes.resolveSessionPrevClose):
 *   - closePrice equals the close of the bar BEFORE the price's session
 *       -> confirmed prior close (source schwab_quote_close).
 *   - closePrice equals the close of the bar OF the price's session (and that
 *     bar's close differs from the prior bar's) -> it rolled: use the prior
 *     daily bar (source daily_bar, closeRolled true).
 *   - no bars and the regular session is over, and closePrice equals the
 *     regular-session last price -> cannot tell a rolled close from a truly
 *     flat day: unavailable (reason given), never a fabricated 0 or a guess.
 *   - otherwise the quote close is used (before the close it cannot have rolled).
 * @param priceSessionDate ET date of the session the price belongs to (null = unknown, treated as today)
 * @param todayEt          today's ET date
 * @param prevTradingDate  previous trading day before today (for labelling the quote close)
 * @param afterSessionClose true once today's regular session has closed (roll possible)
 */
export function resolvePrevClose(args: {
  priceSessionDate: IsoDate | null;
  todayEt: IsoDate;
  prevTradingDate?: IsoDate | null;
  quote?: QuoteCloseLike | null;
  dailyBars?: readonly DailyBarLike[] | null;
  afterSessionClose?: boolean;
}): PrevCloseResult {
  const sessionDate = args.priceSessionDate ?? args.todayEt;
  const q = args.quote;
  const fromBars = prevCloseFromDailyBars(args.dailyBars, sessionDate);
  if (q && sessionDate === args.todayEt) {
    let quoteClose: number | null = null;
    let quoteSource: PrevCloseSource = "schwab_quote_close";
    if (q.closePrice != null && isFinite(q.closePrice) && q.closePrice > 0) {
      quoteClose = q.closePrice;
    } else if (q.lastPrice != null && q.netChange != null && isFinite(q.lastPrice) && isFinite(q.netChange)) {
      const pc = q.lastPrice - q.netChange;
      if (pc > 0) { quoteClose = pc; quoteSource = "schwab_quote_net_change"; }
    }
    if (quoteClose != null) {
      const sessionBarClose = dailyBarCloseOn(args.dailyBars, sessionDate);
      if (fromBars && sameClose(quoteClose, fromBars.close)) {
        return { prevClose: quoteClose, source: quoteSource, prevCloseDate: fromBars.date, closeRolled: false };
      }
      if (sessionBarClose != null && sameClose(quoteClose, sessionBarClose)
          && !(fromBars && sameClose(sessionBarClose, fromBars.close))) {
        // The quote's "previous close" is this session's close: it rolled.
        if (fromBars) return { prevClose: fromBars.close, source: "daily_bar", prevCloseDate: fromBars.date, closeRolled: true };
        return { prevClose: null, source: "unavailable", prevCloseDate: null, closeRolled: true,
          reason: "Schwab quote close has rolled to today's close and no earlier daily bar is available" };
      }
      if (!args.dailyBars?.length && args.afterSessionClose) {
        const lastRegular = q.regularMarketLast ?? q.lastPrice ?? null;
        if (lastRegular != null && isFinite(lastRegular) && sameClose(quoteClose, lastRegular)) {
          return { prevClose: null, source: "unavailable", prevCloseDate: null,
            reason: "after the close the Schwab quote close equals the last price: rolled or flat cannot be told apart without daily bars" };
        }
      }
      return { prevClose: quoteClose, source: quoteSource, prevCloseDate: args.prevTradingDate ?? null, closeRolled: false };
    }
  }
  if (fromBars) return { prevClose: fromBars.close, source: "daily_bar", prevCloseDate: fromBars.date };
  return { prevClose: null, source: "unavailable", prevCloseDate: null };
}

/** change ($ per share / index points) and changePct (percent), null when either input is missing. */
export function dayChange(
  price: number | null | undefined,
  prevClose: number | null | undefined,
): { change: number | null; changePct: number | null } {
  if (price == null || prevClose == null || !isFinite(price) || !isFinite(prevClose) || prevClose <= 0) {
    return { change: null, changePct: null };
  }
  const change = price - prevClose;
  return { change, changePct: (change / prevClose) * 100 };
}
