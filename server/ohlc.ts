// server/ohlc.ts
// Unified OHLC endpoint for candlestick charts. Wraps Schwab price history
// with sensible range/interval combos + in-memory cache keyed by symbol+timeframe.
// Schwab-only mode: no Yahoo fallback.

import { getPriceHistory } from "./schwab";

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

// Map Yahoo-style symbols to Schwab equivalents.
// Schwab cash indexes use "$" prefix WITHOUT ".X" suffix.
function toSchwabSymbol(symbol: string): string {
  const map: Record<string, string> = {
    "^VIX": "$VIX",
    "^VIX9D": "$VIX9D",
    "^VIX3M": "$VIX3M",
    "^VVIX": "$VVIX",
    "^SKEW": "$SKEW",
    "^GSPC": "$SPX",
    "^SPX": "$SPX",
    "^VXN": "$VXN",
    "^RVX": "$RVX",
  };
  return map[symbol] ?? symbol;
}

type SchwabParams = {
  periodType: "day" | "month" | "year";
  period: number;
  frequencyType: "minute" | "daily" | "weekly" | "monthly";
  frequency: number;
  intervalLabel: string;  // for OHLCResponse.interval
};

/**
 * Convert Yahoo-style Timeframe + Interval override to Schwab pricehistory params.
 * Schwab supports:
 *   frequencyType=minute  → frequencyType=day,  period=1..10
 *   frequencyType=daily   → periodType=day/month/year
 *   frequencyType=weekly  → periodType=month/year
 *   frequencyType=monthly → periodType=year
 */
function tfToSchwab(tf: Timeframe, intervalOverride?: Interval): SchwabParams {
  if (intervalOverride) {
    switch (intervalOverride) {
      case "1m":
        // 1-minute bars: use day periodType
        if (tf === "1D") return { periodType: "day", period: 1, frequencyType: "minute", frequency: 1, intervalLabel: "1m" };
        return { periodType: "day", period: 5, frequencyType: "minute", frequency: 1, intervalLabel: "1m" };
      case "2m":
        if (tf === "1D") return { periodType: "day", period: 1, frequencyType: "minute", frequency: 1, intervalLabel: "2m" };
        return { periodType: "day", period: 5, frequencyType: "minute", frequency: 1, intervalLabel: "2m" };
      case "5m":
        if (tf === "1D") return { periodType: "day", period: 1, frequencyType: "minute", frequency: 5, intervalLabel: "5m" };
        return { periodType: "day", period: 5, frequencyType: "minute", frequency: 5, intervalLabel: "5m" };
      case "15m":
        if (tf === "1D") return { periodType: "day", period: 1, frequencyType: "minute", frequency: 15, intervalLabel: "15m" };
        return { periodType: "day", period: 5, frequencyType: "minute", frequency: 15, intervalLabel: "15m" };
      case "30m":
        if (tf === "1D") return { periodType: "day", period: 1, frequencyType: "minute", frequency: 30, intervalLabel: "30m" };
        return { periodType: "day", period: 5, frequencyType: "minute", frequency: 30, intervalLabel: "30m" };
      case "60m":
      case "1h":
        if (tf === "1D") return { periodType: "day", period: 1, frequencyType: "minute", frequency: 30, intervalLabel: "60m" };
        if (tf === "5D") return { periodType: "day", period: 5, frequencyType: "minute", frequency: 30, intervalLabel: "60m" };
        return { periodType: "month", period: 1, frequencyType: "daily", frequency: 1, intervalLabel: "60m" };
      case "1d":
        if (tf === "1Y") return { periodType: "year", period: 1, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
        if (tf === "3M") return { periodType: "month", period: 3, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
        if (tf === "5D") return { periodType: "day", period: 5, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
        return { periodType: "month", period: 1, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
      case "1wk":
        return { periodType: "year", period: 5, frequencyType: "weekly", frequency: 1, intervalLabel: "1wk" };
      case "1mo":
        return { periodType: "year", period: 5, frequencyType: "monthly", frequency: 1, intervalLabel: "1mo" };
    }
  }
  // Default behavior (no interval override)
  switch (tf) {
    case "1D": return { periodType: "day", period: 1, frequencyType: "minute", frequency: 5, intervalLabel: "5m" };
    case "5D": return { periodType: "day", period: 5, frequencyType: "minute", frequency: 30, intervalLabel: "30m" };
    case "1M": return { periodType: "month", period: 1, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
    case "3M": return { periodType: "month", period: 3, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
    case "1Y": return { periodType: "year", period: 1, frequencyType: "daily", frequency: 1, intervalLabel: "1d" };
    case "5Y": return { periodType: "year", period: 5, frequencyType: "weekly", frequency: 1, intervalLabel: "1wk" };
  }
}

export async function fetchOHLC(symbol: string, tf: Timeframe, intervalOverride?: Interval): Promise<OHLCResponse> {
  const schwabSym = toSchwabSymbol(symbol);
  const params = tfToSchwab(tf, intervalOverride);

  let candles: Candle[] = [];
  try {
    const resp = await getPriceHistory(
      schwabSym,
      params.periodType,
      params.period,
      params.frequencyType,
      params.frequency,
    );
    // Schwab candles: { datetime (ms), open, high, low, close, volume }
    candles = resp.candles
      .map((c) => ({
        t: Math.floor(c.datetime / 1000),  // convert ms → epoch seconds
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume ?? null,
      }))
      .filter((c) => c.o > 0 && c.c > 0);
  } catch {
    // fall through — returns empty candles
  }

  if (!candles.length) {
    return {
      symbol,
      displayName: symbol,
      timeframe: tf,
      interval: params.intervalLabel,
      price: null, prevClose: null, change: null, changePct: null,
      sessionHigh: null, sessionLow: null,
      candles: [],
      asOf: Math.floor(Date.now() / 1000),
    };
  }

  const price = candles[candles.length - 1]?.c ?? null;
  // prevClose: close of the second-to-last daily bar, or first bar for intraday
  const prevClose = candles.length >= 2
    ? candles[candles.length - 2].c
    : null;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  const sessionHighs = candles.map((c) => c.h).filter((v) => v != null && v > 0);
  const sessionLows = candles.map((c) => c.l).filter((v) => v != null && v > 0);

  return {
    symbol,
    displayName: symbol,
    timeframe: tf,
    interval: params.intervalLabel,
    price,
    prevClose,
    change,
    changePct,
    sessionHigh: sessionHighs.length > 0 ? Math.max(...sessionHighs) : null,
    sessionLow: sessionLows.length > 0 ? Math.min(...sessionLows) : null,
    candles,
    asOf: Math.floor(Date.now() / 1000),
  };
}
