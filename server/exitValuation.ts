// server/exitValuation.ts
//
// The 0DTE option stop and the value of an open long option if sold NOW.
// Pure.
//
// ONE stop definition everywhere (coordinator decision SF-3, matching the
// alert's printed rule "option bid -20% (bid <= $X on a $ask fill)" and the
// r2-d replay validationMath.ODTE_PLAN_RULES.optionStopPct = 0.20):
//   stop when  bid <= (1 - 0.20) x entry ask      (before fees)
// A contract whose bid is ALREADY at or below that level at entry is
// untradable under the plan (it would stop on the fill): the picker, the
// engine and the tracker reject it as SPREAD_EXCEEDS_STOP.
//
// The DISPLAYED P&L is what selling at the bid now nets after fees
// (review item 6.6; a long position is realizable at the bid: IAS 39 AG72,
// IASB Agenda Paper 9, Bid-ask spreads, Oct 2008,
// https://www.ifrs.org/content/dam/ifrs/meetings/2008/october/iasb2/fair-value-measurement/ap9-bid-ask-spreads.pdf):
//   cost        = entryFill x m + fee
//   liquidation = bid x m - fee        (0 and no fee at a zero bid)
//   netReturn   = (liquidation - cost) / cost
// Because the stop is defined before fees, the net figure at the stop reads
// slightly below -20% (e.g. -20.1% on a $10.00 fill with $0.65 fees): that is
// the fee, not slippage. Without a configured fee (index root) the net figure
// is unavailable; the stop still works.

import { ODTE_PLAN_RULES } from "./validationMath";

/** The published plan's option stop (r2-d validationMath.ODTE_PLAN_RULES): one source for the alert, the replay and the exit brain. */
export const PLAN_OPTION_STOP_PCT: number = ODTE_PLAN_RULES.optionStopPct;

export type EntryBasis = "ask_at_arm" | "last_at_arm";

/** Bid level at or below which the plan's option stop fires, $ per share. */
export function optionStopLevel(entryAsk: number, stopPct = PLAN_OPTION_STOP_PCT): number {
  return entryAsk * (1 - stopPct);
}

/** True when the plan's option stop has fired; null without a bid or entry (not evaluable). */
export function optionStopHit(bid: number | null | undefined, entryAsk: number, stopPct = PLAN_OPTION_STOP_PCT): boolean | null {
  if (bid == null || !Number.isFinite(bid) || bid < 0 || !(entryAsk > 0)) return null;
  return bid <= optionStopLevel(entryAsk, stopPct) + 1e-12;
}

/**
 * Entry check: a quote whose bid is already at or below the stop level of an
 * ask fill would stop on entry. null = no two-sided quote (cannot define the stop).
 */
export function spreadExceedsStop(bid: number | null | undefined, ask: number | null | undefined, stopPct = PLAN_OPTION_STOP_PCT): boolean | null {
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || !(ask > 0) || bid < 0 || bid > ask) return null;
  return bid <= optionStopLevel(ask, stopPct) + 1e-12;
}

export interface Liquidation {
  netReturn: number;          // fraction of cash paid
  liquidationValue: number;   // $ per contract after the exit fee
  costBasis: number;          // $ per contract incl. the opening fee
}

export function liquidationReturn(args: {
  entryFill: number;
  bid: number | null | undefined;
  feePerContract: number | null;
  multiplier?: number;
}): Liquidation | null {
  const m = args.multiplier ?? 100;
  if (args.feePerContract == null || !Number.isFinite(args.feePerContract)) return null; // fee unknown: no net figure
  const fee = Math.max(0, args.feePerContract);
  if (!(args.entryFill > 0) || args.bid == null || !Number.isFinite(args.bid) || args.bid < 0) return null;
  const cost = Math.round((args.entryFill * m + fee) * 100) / 100;
  // At a zero bid nothing can be sold: the position is worth 0 and no closing fee is paid.
  const liq = args.bid > 0 ? Math.round((args.bid * m - fee) * 100) / 100 : 0;
  return { netReturn: (liq - cost) / cost, liquidationValue: liq, costBasis: cost };
}

/** Entry fill for a tracked position: the logged ask at arm, else its last print. */
export function entryFillOf(pos: { buyPrice: number; buyAsk?: number | null }): { fill: number; basis: EntryBasis } {
  if (pos.buyAsk != null && Number.isFinite(pos.buyAsk) && pos.buyAsk > 0) return { fill: pos.buyAsk, basis: "ask_at_arm" };
  return { fill: pos.buyPrice, basis: "last_at_arm" };
}
