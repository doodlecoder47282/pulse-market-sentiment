// server/chainClock.ts
//
// Glue between option-chain rows and the ONE clock (server/timeToExpiry.ts).
// Pure: imports only timeToExpiry, exchangeCalendar and greeks.
//
//   contractYears()  T for a chain contract: calendar minutes to its real
//                    settlement instant / 525,600 (Cboe VIX convention), AM
//                    vs PM from settlementStyleOf (SPX root vs SPXW), half
//                    days from exchangeCalendar, 15-minute floor, 0 once
//                    settled (callers drop T = 0 rows).
//   dteYears()       Same clock when only an expiry date or a whole-day DTE is
//                    known (rows from feeds that carry no contract symbol).
//   ivForClock()     An implied vol is only valid with the T used to solve it
//                    (Hull, OFOD, implied volatility chapter). Schwab does not
//                    document the T behind its "volatility" field, and inside
//                    3 days the conventions differ materially, so for those
//                    expiries sigma is re-solved from the two-sided mid with
//                    our T (same rule as chainAudit.effectiveIV).

import { settlementStyleOf, timeToExpiry, type SettlementStyle } from "./timeToExpiry";
import { addDays, etDate, sessionCloseMs, sessionMinutes } from "./exchangeCalendar";
import { impliedVol } from "./greeks";

/** Expiries this close (calendar years) get sigma re-solved from the quote mid. */
export const RESOLVE_IV_MAX_T = 3 / 365;

/** "YYYY-MM-DD:N" (Schwab expiry key) or "YYYY-MM-DD" -> "YYYY-MM-DD". */
export function expiryOfKey(expKey: string): string {
  return expKey.slice(0, 10);
}

/** Settlement style of a Schwab chain contract object. */
export function contractStyle(contract: any): SettlementStyle {
  return settlementStyleOf({
    symbol: contract?.symbol ?? null,
    optionRoot: contract?.optionRoot ?? null,
    settlementType: contract?.settlementType ?? null,
  });
}

/** T in calendar years for a chain contract; 0 once it has settled. */
export function contractYears(expKey: string, contract: any, nowMs: number = Date.now()): number {
  return timeToExpiry(expiryOfKey(expKey), { nowMs, style: contractStyle(contract) }).years;
}

/**
 * T in calendar years from an expiry date (preferred) or a whole-day DTE
 * counted from today's ET date, PM settlement unless told otherwise.
 * 0 once settled.
 */
export function dteYears(
  dte: number,
  opts: { expiry?: string | null; style?: SettlementStyle; nowMs?: number } = {},
): number {
  const nowMs = opts.nowMs ?? Date.now();
  const expiry = opts.expiry ? opts.expiry.slice(0, 10) : addDays(etDate(nowMs), Math.max(0, Math.round(dte)));
  return timeToExpiry(expiry, { nowMs, style: opts.style ?? "PM" }).years;
}

/**
 * Sigma valid for T. Within RESOLVE_IV_MAX_T, solve from the bid/ask mid
 * (r = q = 0; carry over <= 3 days is negligible); otherwise, or when the
 * quote is unusable, return the vendor IV (decimal).
 */
export function ivForClock(args: {
  vendorIv: number;            // decimal
  bid: number | null | undefined;
  ask: number | null | undefined;
  spot: number;
  strike: number;
  T: number;
  type: "C" | "P";
}): number {
  const { vendorIv, bid, ask, spot, strike, T, type } = args;
  if (T > 0 && T <= RESOLVE_IV_MAX_T && bid != null && ask != null && bid > 0 && ask >= bid && spot > 0 && strike > 0) {
    const solved = impliedVol((bid + ask) / 2, spot, strike, T, 0, 0, type);
    if (solved != null && Number.isFinite(solved) && solved > 0.005 && solved < 4.99) return solved;
  }
  return vendorIv;
}

/**
 * Minutes from nowMs to today's regular-session close (16:00 ET, 13:00 ET on
 * half days, from exchangeCalendar), at least 1. On a non-trading day or
 * after the close it returns 1 (nothing left of the session).
 */
export function minutesToSessionClose(nowMs: number = Date.now()): number {
  const close = sessionCloseMs(etDate(nowMs));
  if (close == null) return 1;
  return Math.max(1, Math.floor((close - nowMs) / 60_000));
}

/**
 * Projected theta cost to the close, per share (negative = cost):
 *   thetaPerDay / (session minutes today) x minutes left in the session.
 * Same assumption the old code made (a day's decay happens during the regular
 * session), applied to the real session: 390 minutes, or 210 on a 13:00 half
 * day. The old code used 16:00 as the close and 390 as the session length,
 * so at 12:00 ET on a half day it charged 240 minutes of a 390-minute day
 * (0.615 day of theta) instead of 60 of 210 (0.286 day): 2.15x too much.
 * Multiply by 100 for $ per contract.
 */
export function projectedThetaCost(thetaPerDay: number, minutesToClose: number, nowMs: number = Date.now()): number {
  const len = sessionMinutes(etDate(nowMs)) || 390;
  return (thetaPerDay / len) * minutesToClose;
}
