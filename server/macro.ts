// server/macro.ts
// Macro carousel: categorized cross-asset quotes for the top-of-page ticker
// tape + rotating carousel. Collection, caching and price meaning live in
// server/macroCore.ts (pure, unit-tested); this file wires it to Schwab (one
// batched quote request per build, daily history only when a completed
// session is missing) and to the public crypto/FX fallbacks below.

import { getQuotes, getPriceHistory } from "./schwab";
import { toSchwabSymbol } from "./schwabSymbols";
import { createMacroBuilder, type MacroResponse, type TickerDef, type DailyBarsIn } from "./macroCore";

export type { MacroCategory, MacroQuote, MacroResponse } from "./macroCore";

// --------- External fallbacks (Schwab can't quote crypto or =X FX pairs) ---------
// CoinGecko (free, no key) for crypto. Frankfurter (ECB, free, no key) for FX.
// Cached 60s in-memory to avoid hammering free public endpoints.

type CacheEntry<T> = { ts: number; data: T };
const _cache: Record<string, CacheEntry<any>> = {};
const CACHE_MS = 60_000;

function cacheGet<T>(key: string): T | null {
  const e = _cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_MS) return null;
  return e.data as T;
}
function cacheSet<T>(key: string, data: T) {
  _cache[key] = { ts: Date.now(), data };
}

const CG_IDS: Record<string, string> = {
  "BTC-USD": "bitcoin",
  "ETH-USD": "ethereum",
};

async function fetchCryptoFallback(symbol: string): Promise<{ price: number | null; prevClose: number | null; spark: number[] } | null> {
  const id = CG_IDS[symbol];
  if (!id) return null;
  const cached = cacheGet<any>("cg:" + id);
  if (cached) return cached;
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const prices: [number, number][] = j?.prices || [];
    const closes = prices.map((p) => p[1]).filter((c) => c != null && isFinite(c));
    if (closes.length < 2) return null;
    const price = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const out = { price, prevClose, spark: closes.slice(-22) };
    cacheSet("cg:" + id, out);
    return out;
  } catch {
    return null;
  }
}

// Frankfurter symbol map (USD-based). DXY built from EUR/JPY/GBP/CAD/SEK/CHF basket weights.
const FX_MAP: Record<string, { invert?: boolean; quote: string }> = {
  "EURUSD=X": { quote: "EUR", invert: true },  // EUR/USD = 1 / (USD->EUR)
  "GBPUSD=X": { quote: "GBP", invert: true },  // GBP/USD = 1 / (USD->GBP)
  "USDJPY=X": { quote: "JPY" },                // USD/JPY direct
};

async function fetchFxLatest(): Promise<Record<string, number> | null> {
  const cached = cacheGet<Record<string, number>>("fx:latest");
  if (cached) return cached;
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY,CAD,SEK,CHF", { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const rates = j?.rates || {};
    cacheSet("fx:latest", rates);
    return rates;
  } catch {
    return null;
  }
}

async function fetchFxHistorical(symbol: string): Promise<number[] | null> {
  const cached = cacheGet<number[]>("fx:hist:" + symbol);
  if (cached) return cached;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 32 * 86400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const url = `https://api.frankfurter.dev/v1/${fmt(start)}..${fmt(end)}?base=USD&symbols=EUR,GBP,JPY,CAD,SEK,CHF`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const ratesByDate: Record<string, Record<string, number>> = j?.rates || {};
    const dates = Object.keys(ratesByDate).sort();
    const out: number[] = [];
    for (const d of dates) {
      const r2 = ratesByDate[d];
      if (!r2) continue;
      const v = computeFxFromBasket(symbol, r2);
      if (v != null && isFinite(v)) out.push(v);
    }
    const sliced = out.slice(-22);
    cacheSet("fx:hist:" + symbol, sliced);
    return sliced;
  } catch {
    return null;
  }
}

// Compute the quoted pair value from a USD->X rates object.
function computeFxFromBasket(symbol: string, rates: Record<string, number>): number | null {
  if (symbol === "DX-Y.NYB") {
    // ICE DXY formula:
    // 50.14348112 * EUR^-0.576 * JPY^0.136 * GBP^-0.119 * CAD^0.091 * SEK^0.042 * CHF^0.036
    const eur = rates["EUR"], jpy = rates["JPY"], gbp = rates["GBP"], cad = rates["CAD"], sek = rates["SEK"], chf = rates["CHF"];
    if ([eur, jpy, gbp, cad, sek, chf].some((v) => v == null)) return null;
    // ICE uses EUR/USD (so 1/EUR), GBP/USD (1/GBP), USD/JPY=JPY, USD/CAD=CAD, USD/SEK=SEK, USD/CHF=CHF
    const eurusd = 1 / eur;
    const gbpusd = 1 / gbp;
    return 50.14348112
      * Math.pow(eurusd, -0.576)
      * Math.pow(jpy, 0.136)
      * Math.pow(gbpusd, -0.119)
      * Math.pow(cad, 0.091)
      * Math.pow(sek, 0.042)
      * Math.pow(chf, 0.036);
  }
  const def = FX_MAP[symbol];
  if (!def) return null;
  const r = rates[def.quote];
  if (r == null) return null;
  return def.invert ? 1 / r : r;
}

async function fetchFxFallback(symbol: string): Promise<{ price: number | null; prevClose: number | null; spark: number[] } | null> {
  const [latest, spark] = await Promise.all([fetchFxLatest(), fetchFxHistorical(symbol)]);
  if (!latest || !spark || spark.length < 2) return null;
  const price = computeFxFromBasket(symbol, latest);
  const prevClose = spark[spark.length - 2];
  if (price == null) return null;
  return { price, prevClose, spark };
}

async function schwabDailyBars(symbol: string): Promise<DailyBarsIn> {
  // ~1 month of daily bars (the same request quotes.fetchDailyCloses made).
  const r = await getPriceHistory(toSchwabSymbol(symbol), "month", 1, "daily", 1);
  return {
    bars: r.candles.map((c) => ({ t: Math.floor(c.datetime / 1000), c: c.close })),
    dataState: r.dataState ?? (r.candles.length ? "ok" : "unavailable"),
    reason: r.reason ?? null,
  };
}

async function publicFallback(def: TickerDef) {
  return def.category === "crypto" ? fetchCryptoFallback(def.symbol)
    : def.category === "fx" ? fetchFxFallback(def.symbol)
    : null;
}

const builder = createMacroBuilder({
  now: () => Date.now(),
  // Batched: one /quotes request carries every Schwab-covered symbol.
  getQuotes: async (symbols) => (await getQuotes(symbols.map(toSchwabSymbol))).map((q) => ({
    ...q,
    // getQuotes returns the caller's symbol; map back if toSchwabSymbol changed it.
    symbol: symbols.find((s) => toSchwabSymbol(s) === q.symbol) ?? q.symbol,
  })),
  getDailyBars: schwabDailyBars,
  getFallback: publicFallback,
});

/** One snapshot; concurrent callers share one build (server/macroCore.ts). */
export function buildMacroSnapshot(): Promise<MacroResponse> {
  return builder.build();
}

/** Drop cached daily history (all symbols, or one): the next build re-reads it. */
export function invalidateMacroHistory(symbol?: string): void {
  builder.invalidateHistory(symbol);
}
