// server/exitValuation.ts
//
// What an open long option is worth if it is sold NOW (review item 6.6). Pure.
//
// The exit brain used to judge drawdown on the last print or the mid every
// 30 s, but a 0DTE long is sold at the bid and pays the closing fee, so a
// "-20%" stop on the mid fires after the position has already lost more than
// 20% of the cash paid. A long position's realizable value is the bid (IAS 39
// AG72: the quoted price for an asset held is "usually the current bid price";
// IASB Agenda Paper 9, Bid-ask spreads, Oct 2008,
// https://www.ifrs.org/content/dam/ifrs/meetings/2008/october/iasb2/fair-value-measurement/ap9-bid-ask-spreads.pdf).
//
//   cost            = entryFill x m + fee           (cash paid, opening fee in)
//   liquidation     = bid x m - fee                 (cash received if sold now)
//   netReturn       = (liquidation - cost) / cost
// entryFill is the ask at arm when it was logged (what a market buy paid),
// else the last print at arm, and the result says which. No bid: null
// (missing, never a 0% read).

export type EntryBasis = "ask_at_arm" | "last_at_arm";

export interface Liquidation {
  netReturn: number;          // fraction of cash paid
  liquidationValue: number;   // $ per contract after the exit fee
  costBasis: number;          // $ per contract incl. the opening fee
}

export function liquidationReturn(args: {
  entryFill: number;
  bid: number | null | undefined;
  feePerContract: number;
  multiplier?: number;
}): Liquidation | null {
  const m = args.multiplier ?? 100;
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
