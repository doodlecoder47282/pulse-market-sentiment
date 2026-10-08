// server/timeToExpiry.ts
//
// One time-to-expiry function for every greeks / gamma path.
//
// Pure module (imports only ./exchangeCalendar, which is also pure).
//
// Convention (default "calendar" basis):
//   T = minutes from now to the contract's settlement instant / 525,600
//   i.e. actual calendar minutes over a 365-day year. This is the convention
//   Cboe uses for listed SPX options in the VIX calculation, which also fixes
//   the settlement instants used here:
//     "standard SPX options are deemed to expire at the open of trading
//      (i.e., 9:30 a.m. ET)", "Weekly SPXW options are deemed to expire at
//      the close of trading (i.e., 4:00 p.m. ET)"; worked example
//      T1 = 34,484 / 525,600.
//   Source: Cboe Volatility Index Methodology,
//   https://cdn.cboe.com/api/global/us_indices/governance/Volatility_Index_Methodology_Cboe_Volatility_Index.pdf
//   AM settlement uses the Special Opening Quotation built from each
//   constituent's opening trade on expiration day:
//   https://cdn.cboe.com/api/global/us_indices/governance/SOQ-Settlement-of-Standard-AM-Settled-Index-Futures-and-Options.pdf
//   Expiring SPXW stop trading at 4:00 p.m. ET, or 1:00 p.m. ET on a half day
//   (Cboe SPX/SPXW specification); the half-day close comes from
//   exchangeCalendar.
//
// Optional "trading" basis: remaining regular-session minutes (holidays and
//   half days removed) / (252 x 390), the trading-day convention Hull
//   recommends for volatility measured over trading time (Hull, "Options,
//   Futures, and Other Derivatives", ch. "Volatility and trading days").
//   It gives zero weight to overnight and weekend variance, so it must be used
//   with a volatility measured on the same basis. Do not mix bases: an implied
//   vol solved with one T convention is only valid with that same T.
//
// Floor: DEFAULT_FLOOR_MINUTES = 15. Black-Scholes gamma ~ 1/(S*sigma*sqrt(T))
//   diverges at the money as T -> 0. With sigma = 15% and 15 calendar minutes
//   left, the 1-sd move is sigma*sqrt(15/525600) = 0.08% of spot, about 5 SPX
//   points, i.e. one strike interval. Below that, per-strike gamma collapses
//   onto one strike and aggregate exposures are dominated by pin noise rather
//   than positioning, so the remaining time is held at 15 minutes until the
//   settlement instant. After settlement the contract is expired (T = 0) and
//   callers must drop it: a settled option carries no gamma.

import {
  type IsoDate,
  etClock,
  isTradingDay,
  prevTradingDay,
  sessionCloseMs,
  sessionOpenMs,
  sessionCloseMinutes,
  REGULAR_OPEN_MIN,
  addDays,
  etWallToEpochMs,
} from "./exchangeCalendar";

export type SettlementStyle = "AM" | "PM";
export type TimeBasis = "calendar" | "trading";

/** 365 x 24 x 60 (Cboe VIX methodology). */
export const MINUTES_PER_CALENDAR_YEAR = 525_600;
/** 252 trading days x 390 regular-session minutes. */
export const TRADING_MINUTES_PER_YEAR = 252 * 390;
export const DEFAULT_FLOOR_MINUTES = 15;

/** Option roots whose standard (non-weekly) series are AM-settled at the SOQ. */
const AM_SETTLED_ROOTS = new Set(["SPX"]);

export interface ContractSettlementHint {
  /** OCC/Schwab contract symbol, e.g. "SPXW  261009C06600000" or "SPX_101626C6600". */
  symbol?: string | null;
  /** Schwab chain field, e.g. "SPXW" or "SPX". */
  optionRoot?: string | null;
  /** Schwab chain field; "A"/"AM" = AM-settled, "P"/"PM" = PM-settled. */
  settlementType?: string | null;
}

/** Root of an OCC-style option symbol ("SPXW  261009C06600000" -> "SPXW"). */
export function optionRootOf(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const m = /^([A-Z.]+?)[\s_]*\d{6}[CP]/i.exec(symbol.trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Settlement style of a contract. An explicit settlementType wins; otherwise
 * the root decides: "SPX" (standard monthly) is AM-settled, "SPXW" and all
 * equity/ETF options are PM-settled (settle on the closing price).
 */
export function settlementStyleOf(hint: ContractSettlementHint | string | null | undefined): SettlementStyle {
  if (hint == null) return "PM";
  if (typeof hint === "string") return AM_SETTLED_ROOTS.has(optionRootOf(hint) ?? hint.toUpperCase()) ? "AM" : "PM";
  const st = (hint.settlementType ?? "").toString().trim().toUpperCase();
  if (st === "A" || st === "AM") return "AM";
  if (st === "P" || st === "PM") return "PM";
  const root = (hint.optionRoot ?? "").toString().trim().toUpperCase() || optionRootOf(hint.symbol);
  return root && AM_SETTLED_ROOTS.has(root) ? "AM" : "PM";
}

/**
 * Epoch ms at which a contract with this expiration date settles.
 *   PM: session close on the expiry date (16:00 ET, 13:00 ET on half days).
 *   AM: the 09:30 ET open on the expiry date (SOQ).
 * If the date is not a trading day (an exchange-moved expiry the feed did not
 * re-date, e.g. the June 2026 monthly on Juneteenth, Fri 19 Jun), settlement
 * moves to the previous trading day with the same style: its 09:30 open for
 * AM-settled series (SOQ on Thu 18 Jun), its close for PM-settled series.
 */
export function settlementInstantMs(expiry: IsoDate, style: SettlementStyle = "PM"): number {
  const date = expiry.slice(0, 10);
  const day = isTradingDay(date) ? date : prevTradingDay(date);
  return style === "AM" ? (sessionOpenMs(day) as number) : (sessionCloseMs(day) as number);
}

/** Regular-session minutes inside [fromMs, toMs], using the exchange calendar. */
export function tradingMinutesBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let date = etClock(fromMs).date;
  const lastDate = etClock(toMs).date;
  for (let i = 0; i < 4000; i++) {
    const closeMin = sessionCloseMinutes(date);
    if (closeMin != null) {
      const open = etWallToEpochMs(date, REGULAR_OPEN_MIN);
      const close = etWallToEpochMs(date, closeMin);
      const a = Math.max(open, fromMs);
      const b = Math.min(close, toMs);
      if (b > a) total += (b - a) / 60_000;
    }
    if (date === lastDate) break;
    date = addDays(date, 1);
  }
  return total;
}

export interface TimeToExpiryOptions {
  /** Valuation instant, epoch ms. Default Date.now(). */
  nowMs?: number;
  /** Settlement style; default PM. Use settlementStyleOf() for chain contracts. */
  style?: SettlementStyle;
  /** "calendar" (default) or "trading". */
  basis?: TimeBasis;
  /** Minimum remaining minutes before settlement; default 15. */
  floorMinutes?: number;
}

export interface TimeToExpiry {
  /** T in years on the chosen basis, floored; 0 when expired. */
  years: number;
  /** Unfloored remaining minutes on the chosen basis (0 when expired). */
  minutes: number;
  /** Remaining calendar days (fractional, unfloored) for display. */
  calendarDays: number;
  settlementMs: number;
  style: SettlementStyle;
  basis: TimeBasis;
  /** True once nowMs >= settlement instant. Drop expired contracts from greeks. */
  expired: boolean;
  /** True when the floor was applied. */
  floored: boolean;
}

/**
 * Time to expiry from now to the actual settlement instant.
 * @param expiry "YYYY-MM-DD" expiration date (anything after the 10th char is ignored).
 */
export function timeToExpiry(expiry: IsoDate, opts: TimeToExpiryOptions = {}): TimeToExpiry {
  const nowMs = opts.nowMs ?? Date.now();
  const style = opts.style ?? "PM";
  const basis = opts.basis ?? "calendar";
  const floorMinutes = Math.max(0, opts.floorMinutes ?? DEFAULT_FLOOR_MINUTES);
  const settlementMs = settlementInstantMs(expiry, style);
  const calMinutes = (settlementMs - nowMs) / 60_000;
  const expired = !(calMinutes > 0);
  if (expired) {
    return { years: 0, minutes: 0, calendarDays: 0, settlementMs, style, basis, expired, floored: false };
  }
  const minutes = basis === "trading" ? tradingMinutesBetween(nowMs, settlementMs) : calMinutes;
  const perYear = basis === "trading" ? TRADING_MINUTES_PER_YEAR : MINUTES_PER_CALENDAR_YEAR;
  const floored = minutes < floorMinutes;
  const years = Math.max(minutes, floorMinutes) / perYear;
  return { years, minutes, calendarDays: calMinutes / 1440, settlementMs, style, basis, expired, floored };
}

/** Shortcut: T in years (calendar basis, 15-minute floor), 0 when expired. */
export function yearsToExpiry(expiry: IsoDate, nowMs: number = Date.now(), style: SettlementStyle = "PM"): number {
  return timeToExpiry(expiry, { nowMs, style }).years;
}
