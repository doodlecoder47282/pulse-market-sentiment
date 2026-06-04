// server/jpmCollar.ts
//
// JPMorgan Hedged Equity Fund (JHEQX) collar data.
// The fund rolls quarterly on the last trading day of each quarter.
// Strikes are approximate — exact strikes only known from 13F filings.
//
// Structure: long put (floor) + short put (spread) + short call (cap).
// Dealers must hedge the short put and short call exposure, creating
// pin/support/resistance at those levels.

import { getQuote } from "./sources";

export interface CollarQuarter {
  quarter: string;   // "Q2 2026"
  rollDate: string;  // "2026-06-30" — last trading day of the quarter
  longPut: number;   // Dealer sees long put = floor protection
  shortPut: number;  // Short put spread leg
  shortCall: number; // Cap / ceiling
}

export interface JPMCollarResponse {
  current: CollarQuarter & {
    spxNow: number;
    distToLongPut: number;    // points below long put
    distToShortPut: number;   // points below short put
    distToShortCall: number;  // points above short call
    pctToLongPut: number;
    pctToShortPut: number;
    pctToShortCall: number;
    daysToRoll: number;
  };
  history: CollarQuarter[];
  asOf: string;
}

// Hardcoded collar strikes — current + history.
// Sources: VolSignals (Q2 2026 confirmed), Tickmill institutional note,
// SpotGamma, JHEQX 13F disclosures. Strikes are exact at the roll.
//
// Q2 2026: 5,210 / 6,180 put spread vs 6,865 short call (live as of Mar 31 2026 close)
// Executed via CME SME (Month-End) product, BTIC at 4pm fix.
const COLLAR_DATA: CollarQuarter[] = [
  {
    quarter: "Q2 2026",
    rollDate: "2026-06-30",
    longPut: 6180,
    shortPut: 5210,
    shortCall: 6865,
  },
  {
    quarter: "Q1 2026",
    rollDate: "2026-03-31",
    longPut: 6475,
    shortPut: 5310,
    shortCall: 7155,
  },
  {
    quarter: "Q4 2025",
    rollDate: "2025-12-31",
    longPut: 5900,
    shortPut: 4980,
    shortCall: 6640,
  },
  {
    quarter: "Q3 2025",
    rollDate: "2025-09-30",
    longPut: 5550,
    shortPut: 4760,
    shortCall: 6310,
  },
  {
    quarter: "Q2 2025",
    rollDate: "2025-06-30",
    longPut: 5290,
    shortPut: 4460,
    shortCall: 5880,
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
  const spxNow = spxQuote.last ?? 5800; // fallback if feed unavailable

  // Current quarter is the first entry (most recent)
  const current = COLLAR_DATA[0];
  const history = COLLAR_DATA.slice(1);

  const distToLongPut = spxNow - current.longPut;
  const distToShortPut = spxNow - current.shortPut;
  const distToShortCall = current.shortCall - spxNow;

  const data: JPMCollarResponse = {
    current: {
      ...current,
      spxNow,
      distToLongPut,
      distToShortPut,
      distToShortCall,
      pctToLongPut: (distToLongPut / spxNow) * 100,
      pctToShortPut: (distToShortPut / spxNow) * 100,
      pctToShortCall: (distToShortCall / spxNow) * 100,
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
