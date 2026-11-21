// shared/whaleWords.ts
// The Whale Flow panel's own vocabulary, said once in plain words for a reader who has never traded an option.
// Each entry describes what the label means on this screen; none says what to do about it. Pure data.

export interface WordEntry { term: string; meaning: string }

export interface GateLike { premiumFloor: number; volOiRatio: number; minDte: number; maxDte: number; requiredTag: string }

const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)} million` : `$${Math.round(n).toLocaleString("en-US")}`);
const TAG_WORDS: Record<string, string> = {
  AT_ASK: "trades printed at the seller's asking price (the buyer paid up)",
  AT_BID: "trades printed at the buyer's bid price (the seller accepted less)",
  MID: "trades printed between the bid and the ask",
};

/** The gate line ("$2.5M • 15x • 1-3DTE • AT_ASK") as a sentence. */
export function gateSentence(g: GateLike): string {
  const dte = g.minDte === g.maxDte ? `${g.minDte} day${g.minDte === 1 ? "" : "s"}` : `${g.minDte} to ${g.maxDte} days`;
  const tag = TAG_WORDS[g.requiredTag] ?? `trades tagged ${g.requiredTag}`;
  return `A contract is listed here only when all of these hold: at least ${money(g.premiumFloor)} paid for it today, today's volume at least ${g.volOiRatio} times the contracts that were already open, ${dte} to expiry, and ${tag}.`;
}

export const WHALE_WORDS: WordEntry[] = [
  { term: "whale", meaning: "one option contract (a ticker, a strike, an expiry, call or put) that passed the size gate today. It is a contract with unusually large trading, not a known person or fund." },
  { term: "call / put", meaning: "a call gains when the stock rises, a put gains when it falls. BULLISH and BEARISH on a row only say which of the two it is; they are not a read of who traded or why." },
  { term: "701P 11-23 · 3DTE", meaning: "the 701 strike put expiring November 23, three days to expiry." },
  { term: "premium ($19.61M)", meaning: "dollars paid for that contract today: price times contracts times 100 shares each." },
  { term: "vol/OI 44.2x", meaning: "today's volume is 44.2 times the open interest, the contracts that existed before today. A high number means most of today's trading is new." },
  { term: "NEW STRIKE", meaning: "no contracts were open at that strike before today, so the ratio above cannot be computed." },
  { term: "CONFLUX", meaning: "the same contract also appears in the unusual-activity list below. Two lists agree it was busy; that is all it says." },
  { term: "UOA cluster", meaning: "unusual options activity: several large prints in one contract close together in time." },
  { term: "tracking", meaning: "after a contract is flagged, its price is followed until it closes or expires, so the record above can be counted." },
  { term: "entry / mark / mid", meaning: "entry is the price when it was flagged; mark is the price now; mid is halfway between the bid and the ask. A mid-to-mid change leaves out the spread and fees a real trade would pay." },
  { term: "peak", meaning: "the best mid-to-mid change seen since it was flagged." },
  { term: "volume since flagged", meaning: "contracts traded in it after the flag." },
  { term: "W / L, WIN%", meaning: "closed positions that made or lost money after costs, bought at the ask and sold at the bid." },
  { term: "burn", meaning: "a position that was up at least 50% at its peak and still closed flat or down." },
];

/**
 * Index options (SPX and the like) carry exchange fees that differ by broker and are not set on this server,
 * so a result after fees is not computed for them. Said once per group, not on every row.
 */
export const INDEX_FEE_NOTE =
  "Index options: the result after costs is not computed for these, because the all-in fee per contract for index options is not set on the server (it differs by broker). The mid-to-mid change is shown; it leaves out the spread and fees.";
export const isIndexFeeReason = (reason: string | null | undefined) => /fees not configured/i.test(reason ?? "");
