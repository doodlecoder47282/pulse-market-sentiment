// server/mag7.ts
// Magnificent 7 indicator: AAPL, MSFT, NVDA, GOOGL, META, AMZN, TSLA.
// Computes per-stock day change + equal-weight aggregate vs SPY (breadth proxy).
// Pulls from Yahoo in parallel; matches the macro.ts caching pattern.

import { fetchIntraday, fetchDailyCloses } from "./quotes";

export type Mag7Member = {
  symbol: string;
  name: string;
  price: number | null;
  prevClose: number | null;
  changePct: number | null;
  /** Rolling 4W return */
  return4w: number | null;
  /** Last ~22 daily closes for sparkline */
  spark: number[];
  /** RSI(14) for quick overbought/oversold read */
  rsi14: number | null;
};

export type Mag7Response = {
  asOf: number;
  members: Mag7Member[];
  /** Equal-weight average day-change% */
  eqWtChange: number | null;
  /** SPY day-change% for comparison */
  spyChange: number | null;
  /** Mag7 - SPY (>0 = Mag7 leading, <0 = broad market leading) */
  alphaVsSpy: number | null;
  /** % of Mag7 members up on day (0..1) */
  breadth: number;
  /** Equal-weight 4W return */
  eqWt4w: number | null;
};

const MEMBERS: { symbol: string; name: string }[] = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "Nvidia" },
  { symbol: "GOOGL", name: "Alphabet" },
  { symbol: "META", name: "Meta" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "TSLA", name: "Tesla" },
];

function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  // Wilder's smoothing on last 15 closes.
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * 13 + g) / 14;
    avgLoss = (avgLoss * 13 + l) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function fetchMember(def: { symbol: string; name: string }): Promise<Mag7Member | null> {
  try {
    const [intra, daily] = await Promise.all([
      fetchIntraday(def.symbol, "1d", "5m").catch(() => null),
      fetchDailyCloses(def.symbol, 60).catch(() => []),
    ]);
    const closes: number[] = (daily || []).map((d) => d.c).filter((c) => c != null && isFinite(c));
    const price = intra?.price ?? (closes.length ? closes[closes.length - 1] : null);
    const prevClose = intra?.prevClose ?? (closes.length >= 2 ? closes[closes.length - 2] : null);
    const changePct = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    // 4W return = latest vs. close ~20 trading days ago
    let return4w: number | null = null;
    if (closes.length >= 21 && price != null) {
      const back = closes[closes.length - 21];
      if (back) return4w = ((price - back) / back) * 100;
    }
    return {
      symbol: def.symbol,
      name: def.name,
      price,
      prevClose,
      changePct,
      return4w,
      spark: closes.slice(-22),
      rsi14: rsi14(closes.slice(-30)),
    };
  } catch {
    return null;
  }
}

export async function buildMag7Snapshot(): Promise<Mag7Response> {
  const [spyIntra, ...memberResults] = await Promise.all([
    fetchIntraday("SPY", "1d", "5m").catch(() => null),
    ...MEMBERS.map(fetchMember),
  ]);
  const members = memberResults.filter((m): m is Mag7Member => m != null);

  const spyPrice = spyIntra?.price ?? null;
  const spyPrev = spyIntra?.prevClose ?? null;
  const spyChange = spyPrice != null && spyPrev ? ((spyPrice - spyPrev) / spyPrev) * 100 : null;

  // Aggregates
  const dayChanges = members.map((m) => m.changePct).filter((x): x is number => x != null);
  const eqWtChange = dayChanges.length ? dayChanges.reduce((a, b) => a + b, 0) / dayChanges.length : null;
  const alphaVsSpy = eqWtChange != null && spyChange != null ? eqWtChange - spyChange : null;
  const breadth = members.length ? members.filter((m) => (m.changePct ?? 0) > 0).length / members.length : 0;
  const ret4wVals = members.map((m) => m.return4w).filter((x): x is number => x != null);
  const eqWt4w = ret4wVals.length ? ret4wVals.reduce((a, b) => a + b, 0) / ret4wVals.length : null;

  return {
    asOf: Math.floor(Date.now() / 1000),
    members,
    eqWtChange,
    spyChange,
    alphaVsSpy,
    breadth,
    eqWt4w,
  };
}
