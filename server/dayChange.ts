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
  /** Schwab quote closePrice: previous session close. */
  closePrice?: number | null;
  lastPrice?: number | null;
  netChange?: number | null;
}

export interface PrevCloseResult {
  prevClose: number | null;
  source: PrevCloseSource;
  /** ET date of the session whose close was used, when known. */
  prevCloseDate: IsoDate | null;
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

/**
 * Prior close for a price observed in session `priceSessionDate`.
 * @param priceSessionDate ET date of the session the price belongs to (null = unknown, treated as today)
 * @param todayEt          today's ET date
 * @param prevTradingDate  previous trading day before today (for labelling the quote close)
 */
export function resolvePrevClose(args: {
  priceSessionDate: IsoDate | null;
  todayEt: IsoDate;
  prevTradingDate?: IsoDate | null;
  quote?: QuoteCloseLike | null;
  dailyBars?: readonly DailyBarLike[] | null;
}): PrevCloseResult {
  const sessionDate = args.priceSessionDate ?? args.todayEt;
  const q = args.quote;
  if (q && sessionDate === args.todayEt) {
    if (q.closePrice != null && isFinite(q.closePrice) && q.closePrice > 0) {
      return { prevClose: q.closePrice, source: "schwab_quote_close", prevCloseDate: args.prevTradingDate ?? null };
    }
    if (q.lastPrice != null && q.netChange != null && isFinite(q.lastPrice) && isFinite(q.netChange)) {
      const pc = q.lastPrice - q.netChange;
      if (pc > 0) return { prevClose: pc, source: "schwab_quote_net_change", prevCloseDate: args.prevTradingDate ?? null };
    }
  }
  const fromBars = prevCloseFromDailyBars(args.dailyBars, sessionDate);
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
