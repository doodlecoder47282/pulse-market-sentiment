// shared/flowLabels.ts
//
// One source for the names and method notes of the flow reads, used by the
// server (API labels, Discord cards) and the client (panel text). The names
// say what the data is, not what we wish it were:
//
// - The app sees chain snapshots (each contract's cumulative day volume and
//   its latest print), not OPRA time and sales. A "heavy contract" is a
//   contract whose cumulative day volume x mid is large; it can be thousands
//   of small trades, so it is not a block print.
// - "Last-print side" tags a contract's whole day volume by where its most
//   recent print sat against the current bid/ask (the chain snapshot's last
//   print and quote, which can be from different moments). It
//   is not trade-by-trade aggressor classification (Lee & Ready 1991 classify
//   each trade against the prevailing quote).
// - "Signed tick volume" signs each 1-minute SPY bar's whole volume by the
//   close-to-close change (tick rule on bars). It is neither Lee-Ready nor
//   order-flow imbalance in the Cont-Kukanov-Stoikov (2014) sense, which
//   measures changes in best bid/ask depth.

export const HEAVY_CONTRACT = "heavy contract";
export const HEAVY_CONTRACTS = "heavy contracts";
export const LAST_PRINT_SIDE = "last-print side";
export const SIGNED_TICK_VOLUME = "signed tick volume";

export const HEAVY_CONTRACT_NOTE =
  "Heavy contract = cumulative day volume x mid on one contract (can be many small trades), not a block print.";

export const LAST_PRINT_SIDE_NOTE =
  "Last-print side: each contract's whole day volume is tagged by where its latest print sat versus the current bid/ask. Not trade-by-trade aggressor data; the latest print and the current quote can be from different moments. Directional color only.";

export const SIGNED_TICK_VOLUME_NOTE =
  "Signed tick volume: tick rule on 1-minute SPY closes; each bar's whole volume takes the sign of its close-to-close change (zero change keeps the last sign). Not Lee-Ready trade classification and not order-book OFI.";
