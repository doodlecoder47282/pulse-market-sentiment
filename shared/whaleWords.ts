// shared/whaleWords.ts
// The Whale Flow panel's own vocabulary, said once in plain words for a reader who has never traded an option.
// Every sentence was checked against the code that produces the thing it names (file references beside each),
// because a glossary that is simpler than the truth is a second source of error. Each entry describes what
// the label means on this screen; none says what to do about it, and none says who traded or why. Pure data.

export interface WordEntry { term: string; meaning: string }

export interface GateLike { premiumFloor: number; volOiRatio: number; minDte: number; maxDte: number; requiredTag: string; deltaMin?: number; deltaMax?: number }

const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)} million` : `$${Math.round(n).toLocaleString("en-US")}`);
// server/flowConfig.ts: requiredTag is ABOVE_ASK, AT_ASK or ANY. server/flowAlertEngine.ts and
// flowAttribution.ts: "ask side" is an estimate from scan intervals, each labelled by its last trade.
const SIDE_WORDS: Record<string, string | null> = {
  AT_ASK: "the trading seen today was mostly on the ask side (an estimate: each scan interval is labelled by whether its last trade was at or above the asking price; when too few trades have been seen, the last trade alone decides)",
  ABOVE_ASK: "the last trade was above the asking price",
  ANY: null, // no side condition
};

/** The gate line ("$2.5M • 15x • 1-3DTE • AT_ASK") as a sentence. */
export function gateSentence(g: GateLike): string {
  const dte = g.minDte === g.maxDte ? `${g.minDte} calendar day${g.minDte === 1 ? "" : "s"}` : `${g.minDte} to ${g.maxDte} calendar days`;
  const parts = [
    `an estimated ${money(g.premiumFloor)} or more traded in it today`,
    `today's volume at least ${g.volOiRatio} times the contracts already open (or none were open before today)`,
    `${dte} to expiry`,
  ];
  if (typeof g.deltaMin === "number" && typeof g.deltaMax === "number") parts.push(`a delta between ${g.deltaMin.toFixed(2)} and ${g.deltaMax.toFixed(2)} in size when Schwab reports one`);
  const side = g.requiredTag in SIDE_WORDS ? SIDE_WORDS[g.requiredTag] : `trades tagged ${g.requiredTag}`;
  if (side) parts.push(side);
  return `A contract is listed here only when all of these hold: ${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}.`;
}

/** BULLISH / BEARISH depend on the gate: with an ask-side gate they follow the contract type; with none they follow the last trade (server/flowAlertEngine.ts whaleDirection). */
export function directionSentence(requiredTag: string): string {
  return requiredTag === "ANY"
    ? "a call gains when the stock rises, a put gains when it falls. With no side condition in the gate, BULLISH, BEARISH or NEUTRAL on a row follows where the last trade printed against the quote; it is not a read of who traded or why."
    : "a call gains when the stock rises, a put gains when it falls. While the gate requires the ask side, a call row shows BULLISH and a put row BEARISH: the label names the contract type, not who traded or why.";
}

export function whaleWords(requiredTag: string = "AT_ASK"): WordEntry[] {
  return [
    { term: "whale", meaning: "one option contract (a ticker, a strike, an expiry, call or put) that passed the gate today. It is a contract with unusually large trading, not a known person or fund." },
    { term: "call / put", meaning: directionSentence(requiredTag) },
    { term: "701P 11-23 • 3DTE", meaning: "the 701 strike put expiring November 23, three calendar days to expiry." },
    // server/flowAttribution.ts, schwabFlow.ts calcMid: volume before the first scan at that scan's mid, later volume at the last trade price.
    { term: "premium ($19.61M)", meaning: "an estimate of today's dollars traded in that contract: contracts times 100 shares times a price (the quote's mid for volume before the scanner first saw it, then the last trade price in each scan interval). Not an exact sum of trades." },
    { term: "vol/OI 44.2x", meaning: "today's volume is 44.2 times the open interest, the contracts open at the start of the day. It shows today's trading is large next to what was already open; it does not show whether trades opened or closed positions." },
    { term: "NEW STRIKE", meaning: "no contracts were open at that strike before today, so the ratio above cannot be computed." },
    // server/uoaScanner.ts: per-tier scans and floors; the list also shows clusters at half their threshold.
    { term: "UOA cluster", meaning: "unusual options activity: the same contract qualified on several separate scans within a few hours: the first counting the day's volume so far, each later one the new volume since the previous scan, each worth at least a dollar floor set by the underlying's market-cap tier (index products use the top tier). The list also shows clusters halfway to firing. These are scans of quotes, not individual trades." },
    { term: "CONFLUX", meaning: "the same contract is in both the whale list and the UOA cluster list on this screen. Two lists agree it was busy; that is all it says." },
    // server/whaleFollowThrough.ts: CLOSED is the mark at or under $0.05 or 5% of entry, "not a voluntary exit".
    { term: "tracking", meaning: "after a contract is flagged, its price is followed until it expires or falls to about zero (shown as CLOSED; nobody sold it), so the record above can be counted." },
    { term: "entry / mark / mid", meaning: "entry is the midpoint between bid and ask when it was first flagged (the day's average traded price when no quote was logged); mark is Schwab's current mark, normally that midpoint; mid on a whale row is Schwab's mark, or the last trade when it sits inside the spread, otherwise the midpoint. A mid-to-mid change leaves out the spread and fees a real trade would pay." },
    { term: "peak", meaning: "the best mark-against-entry change seen on any scan since it was flagged." },
    // whaleFollowThrough.ts: session volume now minus session volume at the flag; Schwab's volume restarts each session.
    { term: "volume since flagged", meaning: "contracts traded in it after the flag, counted on the day it was flagged only. Schwab's day volume restarts each session, so on later days this reads low or zero." },
    // server/whaleScoreboard.ts.
    { term: "W / L, WIN%", meaning: "on the Whale row: closed and expired positions with a result above zero, and those at or below zero, bought at the ask when flagged and sold at the bid at the end, after per-contract fees. Positions without both quotes, and index options while no index fee is set, are left out and counted. Other rows are mid to mid without fees and say so." },
    { term: "burn", meaning: "on the Whale row: a position whose best bid while tracked would have returned at least 50% after costs, and that still ended at or below zero. Other rows use the mid." },
  ];
}

/**
 * Index options (SPX and the like): Schwab adds exchange fees on top of its commission for these, so no
 * default is assumed (server/feeConfig.ts) and a result after costs is not computed until one is set.
 * Said once per group, not on every row.
 */
export const INDEX_FEE_NOTE =
  "Index options: the result after costs is not computed for these, because the all-in fee per contract per side for index options (Schwab adds exchange fees for these) is not set on this server. The mid-to-mid change is shown; it leaves out the spread and fees.";
export const isIndexFeeReason = (reason: string | null | undefined) => /fees not configured/i.test(reason ?? "");
/** The short form shown on a row in place of the server's configuration sentence. */
export const INDEX_FEE_SHORT = "after costs: not computed (index fee not set)";

/** The same fact for the glossary, where the page cannot know whether the fee is set: said as a condition. */
export const INDEX_FEE_GLOSSARY =
  "Index options: when the all-in fee per contract per side for index options (Schwab adds exchange fees for these) is not set on this server, the result after costs is not computed for them; the mid-to-mid change is shown, which leaves out the spread and fees.";
