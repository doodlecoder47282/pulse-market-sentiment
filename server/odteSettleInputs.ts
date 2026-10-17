// server/odteSettleInputs.ts
//
// Settle, session high and low from today's regular-session minute candles
// (Schwab price history). Pure, no storage, so the ledger's inputs are
// unit-tested; server/odteMapLedger.ts calls it after the close.

import { etDate, REGULAR_OPEN_MIN, sessionCloseMinutes } from "./exchangeCalendar";

function etMinutes(ms: number): number {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/** Settle, high and low from today's regular-session candles. */
export function settleFromCandles(candles: any[], nowMs: number): { settle: number; sessionHigh: number; sessionLow: number } | null {
  const date = etDate(nowMs);
  const close = sessionCloseMinutes(date) ?? 960;
  const today = (candles || []).filter((c) => typeof c?.datetime === "number" && etDate(c.datetime) === date && etMinutes(c.datetime) >= REGULAR_OPEN_MIN && etMinutes(c.datetime) < close);
  if (!today.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const c of today) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const last = today[today.length - 1];
  if (!(last.close > 0) || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  // A tape that stops short of the close is partial, not a settle: the last bar
  // must start within the final five minutes of the session.
  if (etMinutes(last.datetime) < close - 5) return null;
  return { settle: last.close, sessionHigh: hi, sessionLow: lo };
}

