// server/ohlc.ts
// Unified OHLC endpoint for candlestick charts. Wraps Yahoo chart API with
// sensible range/interval combos + in-memory cache keyed by symbol+timeframe.

export type Candle = {
  t: number;   // epoch seconds (bar open time)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
};

export type Timeframe = "1D" | "5D" | "1M" | "3M" | "1Y" | "5Y";
export type Interval = "1m" | "2m" | "5m" | "15m" | "30m" | "60m" | "1h" | "1d" | "1wk" | "1mo";

export type OHLCResponse = {
  symbol: string;
  displayName: string;
  timeframe: Timeframe;
  interval: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  candles: Candle[];
  asOf: number;
};

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

async function yFetch(url: string, timeoutMs = 10_000): Promise<any> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// Default timeframe → (range, interval). Intraday timeframes accept an interval override.
function tfToYahoo(tf: Timeframe, intervalOverride?: Interval): { range: string; interval: string } {
  // If caller explicitly requests an intraday interval, adjust range to satisfy
  // Yahoo's constraints (1m: ≤7d, 2m: ≤60d, 5m: ≤60d, 15m: ≤60d, 30m: ≤60d, 60m/1h: ≤730d).
  if (intervalOverride) {
    switch (intervalOverride) {
      case "1m":
        // 1m requires range ≤ 7d. Map 1D→1d, 5D→5d (cap), anything else→5d.
        if (tf === "1D") return { range: "1d", interval: "1m" };
        return { range: "5d", interval: "1m" };
      case "2m":
      case "5m":
      case "15m":
      case "30m":
        if (tf === "1D") return { range: "1d", interval: intervalOverride };
        if (tf === "5D") return { range: "5d", interval: intervalOverride };
        return { range: "1mo", interval: intervalOverride };
      case "60m":
      case "1h":
        if (tf === "1D") return { range: "1d", interval: "60m" };
        if (tf === "5D") return { range: "5d", interval: "60m" };
        if (tf === "1M") return { range: "1mo", interval: "60m" };
        return { range: "3mo", interval: "60m" };
      case "1d":
        return { range: tf === "1Y" ? "1y" : tf === "3M" ? "3mo" : "1mo", interval: "1d" };
      case "1wk":
        return { range: "5y", interval: "1wk" };
      case "1mo":
        return { range: "5y", interval: "1mo" };
    }
  }
  // Default behavior (no override)
  switch (tf) {
    case "1D": return { range: "1d", interval: "5m" };
    case "5D": return { range: "5d", interval: "30m" };
    case "1M": return { range: "1mo", interval: "1d" };
    case "3M": return { range: "3mo", interval: "1d" };
    case "1Y": return { range: "1y", interval: "1d" };
    case "5Y": return { range: "5y", interval: "1wk" };
  }
}

function normalizeCandles(result: any): Candle[] {
  const ts: number[] = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: ts[i], o, h, l, c, v: v ?? null });
  }
  return out;
}

export async function fetchOHLC(symbol: string, tf: Timeframe, intervalOverride?: Interval): Promise<OHLCResponse> {
  const { range, interval } = tfToYahoo(tf, intervalOverride);
  const enc = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=${interval}&range=${range}&includePrePost=false`;
  let result: any = null;
  try {
    const d = await yFetch(url);
    result = d?.chart?.result?.[0];
  } catch (e) {
    // fall through
  }
  if (!result) {
    return {
      symbol,
      displayName: symbol,
      timeframe: tf,
      interval,
      price: null, prevClose: null, change: null, changePct: null,
      sessionHigh: null, sessionLow: null,
      candles: [],
      asOf: Math.floor(Date.now() / 1000),
    };
  }
  const candles = normalizeCandles(result);
  const meta = result.meta || {};
  const price: number | null = meta.regularMarketPrice ?? candles[candles.length - 1]?.c ?? null;
  const prevClose: number | null = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  return {
    symbol,
    displayName: meta.shortName || meta.longName || symbol,
    timeframe: tf,
    interval,
    price,
    prevClose,
    change,
    changePct,
    sessionHigh: meta.regularMarketDayHigh ?? null,
    sessionLow: meta.regularMarketDayLow ?? null,
    candles,
    asOf: Math.floor(Date.now() / 1000),
  };
}
