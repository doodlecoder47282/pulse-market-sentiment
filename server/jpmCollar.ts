// server/jpmCollar.ts
//
// JPMorgan Hedged Equity Fund (JHEQX) collar data.
// The fund rolls quarterly on the last trading day of each quarter.
// Exact strikes are disclosed by the fund itself only in its portfolio
// holdings (Form N-PORT, public with a 60-day lag; annual/semiannual N-CSR).
// 13F does not cover these index options. Each row below says how it was
// verified; rows without a reputable source are labeled "unverified".
//
// Structure: long put (floor) + short put (spread) + short call (cap).
// Dealers must hedge the short put and short call exposure, creating
// pin/support/resistance at those levels.

import { getQuote } from "./sources";

export interface CollarQuarter {
  quarter: string;   // "Q2 2026": the quarter the collar covers
  rollDate: string;  // "2026-06-30": expiry = the next roll (last trading day of the quarter)
  longPut: number;   // Dealer sees long put = floor protection
  shortPut: number;  // Short put spread leg
  shortCall: number; // Cap / ceiling
  /** "verified": every strike stated by reputable reporting or the fund's
   *  filings; "partial": at least one strike confirmed; "unverified":
   *  secondary/vendor sources only. */
  verification?: "verified" | "partial" | "unverified";
  source?: string;
}

export interface JPMCollarResponse {
  current: CollarQuarter & {
    /** SPX last; null when the quote is unavailable (never a made-up level). */
    spxNow: number | null;
    spxAvailable: boolean;
    /** True once rollDate has passed: these strikes expired and the next
     *  reset's strikes are not on file, so they are historical, not live. */
    expired: boolean;
    staleNote: string | null;
    distToLongPut: number | null;    // points below long put (null: no SPX quote)
    distToShortPut: number | null;   // points below short put
    distToShortCall: number | null;  // points above short call
    pctToLongPut: number | null;
    pctToShortPut: number | null;
    pctToShortCall: number | null;
    daysToRoll: number;
  };
  history: CollarQuarter[];
  asOf: string;
}

// Hand-entered collar strikes, newest first. A row's rollDate is the date the
// collar EXPIRES (the next quarterly roll); it is set at the previous roll.
//
// Not entered (round-2 research, 2026-10-08): the collar set at the
// 2026-06-30 roll (expired 2026-09-30) and the one set at the 2026-09-30 roll
// (live until 2026-12-31). The only strikes found for them were unsourced
// estimates (a blog and social-media posts); the fund's 2026-06-30 N-PORT
// (JPMorgan Trust I, accession 0002071691-26-021121) would state them but
// could not be read in full. Enter them only with a reputable source.
const COLLAR_DATA: CollarQuarter[] = [
  {
    quarter: "Q2 2026",
    rollDate: "2026-06-30",
    longPut: 6180,
    shortPut: 5210,
    shortCall: 6865,
    // Executed via CME SME (Month-End) product, BTIC at 4pm fix (vendor note).
    verification: "unverified",
    source: "VolSignals / Tickmill notes (secondary); not confirmed by a news wire or fund filing",
  },
  {
    quarter: "Q1 2026",
    rollDate: "2026-03-31",
    longPut: 6475,
    shortPut: 5310,
    shortCall: 7155,
    verification: "partial",
    source: "level 6,475 confirmed as 'one of the collar levels' by MarketWatch (Dow Jones), 'A trap door could open up under the S&P 500 after this influential options trade expires on Tuesday', 2026-03-31; its leg (long put) is inferred, not stated; 5,310 and 7,155 from secondary sources",
  },
  {
    // Corrected in round 2: the table had 5,900 / 4,980 / 6,640.
    quarter: "Q4 2025",
    rollDate: "2025-12-31",
    longPut: 6330,
    shortPut: 5340,
    shortCall: 7000,
    verification: "verified",
    source: "MarketWatch (Dow Jones), Steve Goldstein, 'A giant JPMorgan fund just reset its hedging strategy. What it did and what it means.', 2025-10-01: put spread 5,340-6,330, call sold at 7,000",
  },
  {
    quarter: "Q3 2025",
    rollDate: "2025-09-30",
    longPut: 5550,
    shortPut: 4760,
    shortCall: 6310,
    verification: "unverified",
    source: "secondary sources (vendor notes); not confirmed",
  },
  {
    quarter: "Q2 2025",
    rollDate: "2025-06-30",
    longPut: 5290,
    shortPut: 4460,
    shortCall: 5880,
    verification: "unverified",
    source: "secondary sources (vendor notes); not confirmed",
  },
];

function daysUntil(dateStr: string): number {
  const rollDate = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  const msPerDay = 86400000;
  return Math.max(0, Math.round((rollDate.getTime() - now.getTime()) / msPerDay));
}

// 1-hour in-memory cache
let collarCache: { at: number; data: JPMCollarResponse } | null = null;
const COLLAR_CACHE_MS = 60 * 60_000;

export async function buildJPMCollarSnapshot(): Promise<JPMCollarResponse> {
  if (collarCache && Date.now() - collarCache.at < COLLAR_CACHE_MS) {
    return collarCache.data;
  }

  // Fetch current SPX price
  const spxQuote = await getQuote("^GSPC").catch(() => ({ last: null, prev: null })); // getQuote is Schwab-backed
  const spxLast = spxQuote.last;
  const spxAvailable = spxLast != null && Number.isFinite(spxLast) && spxLast > 0;
  // No quote -> null distances. (Was a hard-coded 5,800 "fallback" spot.)
  const spxNow: number | null = spxAvailable ? (spxLast as number) : null;

  // Current quarter is the first entry (most recent)
  const current = COLLAR_DATA[0];
  const history = COLLAR_DATA.slice(1);

  // The table is hand-maintained. Once the latest roll date has passed, the
  // strikes on file have expired and the new reset is missing: say so instead
  // of presenting expired strikes as the live collar.
  const todayEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const expired = todayEt > current.rollDate;
  const staleNote = expired
    ? `Strikes on file expired at the ${current.rollDate} roll. The resets of 2026-06-30 and 2026-09-30 are not entered: no reputable source for their strikes was found (only unsourced estimates). Shown as historical reference only.`
    : null;

  const distToLongPut = spxNow != null ? spxNow - current.longPut : null;
  const distToShortPut = spxNow != null ? spxNow - current.shortPut : null;
  const distToShortCall = spxNow != null ? current.shortCall - spxNow : null;
  const pct = (d: number | null) => (d != null && spxNow != null ? (d / spxNow) * 100 : null);

  const data: JPMCollarResponse = {
    current: {
      ...current,
      spxNow,
      spxAvailable,
      expired,
      staleNote,
      distToLongPut,
      distToShortPut,
      distToShortCall,
      pctToLongPut: pct(distToLongPut),
      pctToShortPut: pct(distToShortPut),
      pctToShortCall: pct(distToShortCall),
      daysToRoll: daysUntil(current.rollDate),
    },
    history,
    asOf: new Date().toISOString(),
  };

  collarCache = { at: Date.now(), data };
  return data;
}

// Also export 90-day SPX daily closes for the JPM chart via Schwab
// TODO: Schwab-only mode — Yahoo source removed, using Schwab getPriceHistory.
export async function fetchSpxDailyCloses90d(): Promise<Array<{ t: number; c: number }>> {
  try {
    const { getPriceHistory } = await import("./schwab");
    const resp = await getPriceHistory("$SPX", "month", 6, "daily", 1);
    const bars = resp.candles
      .filter((c) => c.close != null && isFinite(c.close) && c.close > 0)
      .map((c) => ({ t: Math.floor(c.datetime / 1000), c: c.close }));
    return bars.slice(-90);
  } catch (e: any) {
    console.warn("[jpmCollar] Schwab SPX 90d fetch failed:", e?.message);
    return [];
  }
}

// SPX daily closes cache — 15min TTL
let spxClosesCache: { at: number; data: Array<{ t: number; c: number }> } | null = null;
const SPX_CACHE_MS = 15 * 60_000;

export async function getCachedSpxCloses(): Promise<Array<{ t: number; c: number }>> {
  if (spxClosesCache && Date.now() - spxClosesCache.at < SPX_CACHE_MS) {
    return spxClosesCache.data;
  }
  const data = await fetchSpxDailyCloses90d();
  spxClosesCache = { at: Date.now(), data };
  return data;
}
