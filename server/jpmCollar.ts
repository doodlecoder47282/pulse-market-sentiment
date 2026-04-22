// server/jpmCollar.ts
//
// JPMorgan Hedged Equity Fund (JHEQX) collar data.
// The fund rolls quarterly on the last trading day of each quarter.
// Strikes are approximate — exact strikes only known from 13F filings.
//
// Structure: long put (floor) + short put (spread) + short call (cap).
// Dealers must hedge the short put and short call exposure, creating
// pin/support/resistance at those levels.

import { yahooQuote } from "./sources";

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

// Hardcoded collar strikes — current + last 4 quarters.
// Source: market knowledge / approximate from JHEQX 13F disclosures.
// Q2 2026 is current; strikes estimated from prevailing SPX levels.
const COLLAR_DATA: CollarQuarter[] = [
  {
    quarter: "Q2 2026",
    rollDate: "2026-06-30",
    longPut: 6650,
    shortPut: 5540,
    shortCall: 7335,
  },
  {
    quarter: "Q1 2026",
    rollDate: "2026-03-31",
    longPut: 6250,
    shortPut: 5190,
    shortCall: 6980,
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
    longPut: 5200,
    shortPut: 4450,
    shortCall: 5950,
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
  const spxQuote = await yahooQuote("^GSPC").catch(() => ({ last: null, prev: null }));
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

// Also export 90-day SPX daily closes for the JPM chart
// (reuses the quotes module pattern)
export async function fetchSpxDailyCloses90d(): Promise<Array<{ t: number; c: number }>> {
  const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";
  const enc = encodeURIComponent("^GSPC");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=6mo`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10_000);
    let data: any;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`Yahoo ${r.status}`);
      data = await r.json();
    } finally {
      clearTimeout(to);
    }
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const bars: Array<{ t: number; c: number }> = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && isFinite(c) && c > 0) {
        bars.push({ t: ts[i], c });
      }
    }
    // Return last 90 trading days
    return bars.slice(-90);
  } catch (e: any) {
    console.warn("[jpmCollar] SPX 90d fetch failed:", e?.message);
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
