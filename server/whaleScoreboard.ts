// server/whaleScoreboard.ts
//
// Whale Performance scoreboard on tradable prices (review: the scoreboard
// was mid-to-mid while the backtest buys the ask and sells the bid). Pure.
//
// Each terminal whale position is scored as a long option bought at the ASK
// logged at detection and sold at the BID logged at the terminal moment
// (premium blown to ~0, or the last quote at/before the expiry close), with
// the broker fee per contract per side, exactly like whaleBacktest.ts and the
// outcome grader. A long position can be sold at the bid, not the mid
// (IAS 39 AG72: the quoted price for an asset held is "usually the current bid
// price"; IASB Agenda Paper 9, Fair Value Measurement, Bid-ask spreads, Oct 2008,
// https://www.ifrs.org/content/dam/ifrs/meetings/2008/october/iasb2/fair-value-measurement/ap9-bid-ask-spreads.pdf).
//
//   pnlPerContract = (bid_exit - ask_entry) x 100 - fees     (cents-exact)
//   fees           = 2 x fee, or 1 x fee when the exit bid is 0 (expired
//                    worthless: no closing trade)
//   netReturn      = pnlPerContract / (ask_entry x 100 + fee)   (return on cash paid)
//   win            = pnlPerContract > 0  (net, the same basis as the $ P&L)
// Positions without a logged entry ask or exit bid are EXCLUDED and counted
// (never scored as 0).

import { optionTradeDollars, toCents, usableEntryAsk, OPTION_MULTIPLIER } from "./validationMath";

/** Schwab's published online option commission, $ per contract per side
 *  (Schwab pricing summary: "$0 base commission, plus $0.65 per contract",
 *  https://www.schwab.com/public/file/P-3346815). Index options also carry
 *  exchange index fees that are not included, so index results are slightly high. */
export const SCOREBOARD_FEE_PER_CONTRACT = 0.65;

export const SCOREBOARD_BASIS = "ask_in_bid_out_net_fees" as const;
export const SCOREBOARD_BASIS_NOTE =
  "bought at the logged ask at detection, sold at the logged bid at the terminal moment; $0.65 per contract per side " +
  "(index exchange fees not included); win = positive P&L after fees; positions without both quotes are excluded and counted";

export interface ScoredTrade {
  pnlPerContract: number;   // $ per contract, after fees
  netReturn: number;        // pnlPerContract / (ask x 100 + fee)
  win: boolean;
  settled: boolean;         // exit bid 0: no closing trade, one fee
}

export function scoreAskToBid(args: {
  entryBid?: number | null;
  entryAsk: number | null | undefined;
  exitBid: number | null | undefined;
  feePerContract?: number;
  multiplier?: number;
}): ScoredTrade | null {
  const ask = usableEntryAsk({ bid: args.entryBid ?? null, ask: args.entryAsk ?? null });
  const bid = args.exitBid;
  if (ask == null || bid == null || !Number.isFinite(bid) || bid < 0) return null;
  const fee = Math.max(0, args.feePerContract ?? SCOREBOARD_FEE_PER_CONTRACT);
  const mult = args.multiplier ?? OPTION_MULTIPLIER;
  const settled = bid === 0;
  const d = optionTradeDollars({ entry: ask, exit: bid, contracts: 1, multiplier: mult, feePerContract: fee, settled });
  const costC = toCents(ask * mult) + toCents(fee);
  return {
    pnlPerContract: d.perContractNet,
    netReturn: costC > 0 ? (d.perContractNet * 100) / costC : NaN,
    win: d.perContractNet > 0,
    settled,
  };
}

export interface ScoreboardRow {
  source: string;
  count: number;          // scored positions
  wins: number;
  losses: number;
  burns: number;          // peak net >= +50% but final net <= 0 (only where the peak bid was logged)
  burnsEvaluated: number; // positions with a logged peak bid
  winRate: number;        // wins / count
  avgPct: number;         // mean netReturn
  totalPnLPct: number;    // sum netReturn
  avgPeakPct: number;     // mean peak netReturn over burnsEvaluated
  bestPct: number;
  worstPct: number;
  avgPnlPerContract: number; // $ per contract, after fees
  excludedNoQuote: number;   // terminal positions without an entry ask or exit bid
  priceBasis: string;
}

export function buildScoreboardRow(
  source: string,
  trades: Array<{ trade: ScoredTrade; peakNetReturn: number | null }>,
  excludedNoQuote: number,
  priceBasis: string = SCOREBOARD_BASIS,
): ScoreboardRow {
  let wins = 0, losses = 0, burns = 0, burnsEvaluated = 0;
  let sum = 0, sumPeak = 0, sumPnl = 0;
  let best = -Infinity, worst = Infinity;
  for (const { trade, peakNetReturn } of trades) {
    if (trade.win) wins++; else losses++;
    sum += trade.netReturn;
    sumPnl += trade.pnlPerContract;
    best = Math.max(best, trade.netReturn);
    worst = Math.min(worst, trade.netReturn);
    if (peakNetReturn != null && Number.isFinite(peakNetReturn)) {
      burnsEvaluated++;
      sumPeak += peakNetReturn;
      if (peakNetReturn >= 0.5 && trade.netReturn <= 0) burns++;
    }
  }
  const n = trades.length;
  return {
    source, count: n, wins, losses, burns, burnsEvaluated,
    winRate: n > 0 ? wins / n : 0,
    avgPct: n > 0 ? sum / n : 0,
    totalPnLPct: sum,
    avgPeakPct: burnsEvaluated > 0 ? sumPeak / burnsEvaluated : 0,
    bestPct: n > 0 ? best : 0,
    worstPct: n > 0 ? worst : 0,
    avgPnlPerContract: n > 0 ? Math.round((sumPnl / n) * 100) / 100 : 0,
    excludedNoQuote,
    priceBasis,
  };
}

// ─── Backtest aggregation (whaleBacktest.ts) on the net basis ─────────────────
// Review item: winners were counted from the pre-fee option return while the
// dollar P&L was after fees, so a trade that made +$0.50 gross and paid $1.30
// in fees counted as a winner with a negative dollar result. Everything here
// is net: win = pnlPerContract > 0 and the return is net on cash paid.

/** Net return on the cash paid for one contract: pnlPerContract / (ask x mult + fee). */
export function netReturnOnCost(pnlPerContract: number | null | undefined, entryAsk: number | null | undefined, feePerContract: number, multiplier = OPTION_MULTIPLIER): number | null {
  if (pnlPerContract == null || !Number.isFinite(pnlPerContract) || entryAsk == null || !(entryAsk > 0)) return null;
  const costC = toCents(entryAsk * multiplier) + toCents(Math.max(0, feePerContract));
  return costC > 0 ? (toCents(pnlPerContract)) / costC : null;
}

export interface NetGroupStats { n: number; winners: number; losers: number; winRate: number; avgPctReturn: number; medianPctReturn: number; totalDollarPnl: number }

/** Win rate, mean/median net return and $ total over executed trades, all net of fees. */
export function netGroupStats(trades: Array<{ netPctReturn: number | null; pnlPerContract: number | null; dollarPnl: number | null }>): NetGroupStats {
  const ok = trades.filter((t) => t.netPctReturn != null && Number.isFinite(t.netPctReturn) && t.pnlPerContract != null);
  const winners = ok.filter((t) => (t.pnlPerContract as number) > 0).length;
  const rets = ok.map((t) => t.netPctReturn as number).sort((a, b) => a - b);
  const n = ok.length;
  const median = n === 0 ? 0 : n % 2 ? rets[(n - 1) / 2] : (rets[n / 2 - 1] + rets[n / 2]) / 2;
  return {
    n,
    winners,
    losers: n - winners,
    winRate: n ? winners / n : 0,
    avgPctReturn: n ? rets.reduce((a, b) => a + b, 0) / n : 0,
    medianPctReturn: median,
    totalDollarPnl: Math.round(ok.reduce((a, t) => a + (t.dollarPnl ?? 0), 0) * 100) / 100,
  };
}
