// server/macro.ts
// Macro carousel — categorized cross-asset quotes for the top-of-page ticker tape
// + rotating carousel. Pulls via Schwab API (through quotes.ts wrappers).
//
// Categories: Equities / Bonds / Credit / Commods / FX / Crypto
// All quotes show last price, day change, day change%, plus a small 1M sparkline
// so the carousel feels alive.

import { fetchIntraday, fetchDailyCloses } from "./quotes";

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



export type MacroCategory =
  | "equities"
  | "bonds"
  | "credit"
  | "commods"
  | "fx"
  | "crypto";

export type MacroQuote = {
  category: MacroCategory;
  symbol: string;      // raw symbol we query (e.g. "EURUSD=X")
  display: string;     // pretty display name
  label: string;       // short ticker used in UI (e.g. "EUR/USD")
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** Last ~22 daily closes for sparkline. */
  spark: number[];
};

export type MacroResponse = {
  asOf: number; // epoch seconds
  groups: {
    category: MacroCategory;
    label: string;
    quotes: MacroQuote[];
  }[];
  /** Flat list for ticker tape (in display order). */
  tape: MacroQuote[];
};

// ----- Universe -----

type TickerDef = {
  symbol: string;
  label: string;
  category: MacroCategory;
};

const UNIVERSE: TickerDef[] = [
  // Equities — index ETFs
  { symbol: "SPY", label: "SPY", category: "equities" },
  { symbol: "QQQ", label: "QQQ", category: "equities" },
  { symbol: "IWM", label: "IWM", category: "equities" },
  { symbol: "DIA", label: "DIA", category: "equities" },

  // Bonds — duration ladder
  { symbol: "SHY", label: "SHY 1-3Y", category: "bonds" },
  { symbol: "IEF", label: "IEF 7-10Y", category: "bonds" },
  { symbol: "TLT", label: "TLT 20+Y", category: "bonds" },

  // Credit
  { symbol: "HYG", label: "HYG HY", category: "credit" },
  { symbol: "LQD", label: "LQD IG", category: "credit" },
  { symbol: "JNK", label: "JNK HY", category: "credit" },

  // Commodities
  { symbol: "USO", label: "Oil", category: "commods" },
  { symbol: "UNG", label: "NatGas", category: "commods" },
  { symbol: "GLD", label: "Gold", category: "commods" },
  { symbol: "SLV", label: "Silver", category: "commods" },
  { symbol: "CPER", label: "Copper", category: "commods" },
  { symbol: "CORN", label: "Corn", category: "commods" },
  { symbol: "WEAT", label: "Wheat", category: "commods" },

  // FX
  { symbol: "DX-Y.NYB", label: "DXY", category: "fx" },
  { symbol: "EURUSD=X", label: "EUR/USD", category: "fx" },
  { symbol: "USDJPY=X", label: "USD/JPY", category: "fx" },
  { symbol: "GBPUSD=X", label: "GBP/USD", category: "fx" },

  // Crypto
  { symbol: "BTC-USD", label: "BTC", category: "crypto" },
  { symbol: "ETH-USD", label: "ETH", category: "crypto" },
];

const CATEGORY_LABELS: Record<MacroCategory, string> = {
  equities: "Equities",
  bonds: "Bonds",
  credit: "Credit",
  commods: "Commodities",
  fx: "FX",
  crypto: "Crypto",
};

const CATEGORY_ORDER: MacroCategory[] = [
  "equities",
  "bonds",
  "credit",
  "commods",
  "fx",
  "crypto",
];

async function fetchOne(def: TickerDef): Promise<MacroQuote | null> {
  try {
    // Intraday for latest price + daily closes for sparkline.
    const [intra, daily] = await Promise.all([
      fetchIntraday(def.symbol, "1d", "5m").catch(() => null),
      fetchDailyCloses(def.symbol, 30).catch(() => []),
    ]);
    let spark: number[] = (daily || []).map((d) => d.c).filter((c) => c != null && isFinite(c));
    let price: number | null = intra?.price ?? (spark.length ? spark[spark.length - 1] : null);
    let prevClose: number | null = intra?.prevClose ?? (spark.length >= 2 ? spark[spark.length - 2] : null);

    // Schwab can't quote crypto or =X FX pairs — fall back to public endpoints.
    if ((price == null || spark.length < 2) && def.category === "crypto") {
      const fb = await fetchCryptoFallback(def.symbol);
      if (fb) {
        price = fb.price;
        prevClose = fb.prevClose;
        spark = fb.spark;
      }
    } else if ((price == null || spark.length < 2) && def.category === "fx") {
      const fb = await fetchFxFallback(def.symbol);
      if (fb) {
        price = fb.price;
        prevClose = fb.prevClose;
        spark = fb.spark;
      }
    }

    if (price == null) return null;
    const change = price != null && prevClose != null ? price - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
    return {
      category: def.category,
      symbol: def.symbol,
      display: intra?.displayName || def.label,
      label: def.label,
      price,
      prevClose,
      change,
      changePct,
      spark: spark.slice(-22),
    };
  } catch {
    return null;
  }
}

export async function buildMacroSnapshot(): Promise<MacroResponse> {
  // Fire everything in parallel.
  const results = await Promise.all(UNIVERSE.map(fetchOne));
  const quotes = results.filter((q): q is MacroQuote => q != null);

  const groups = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    quotes: quotes.filter((q) => q.category === cat),
  })).filter((g) => g.quotes.length > 0);

  // Tape order: equities, crypto, fx, commods, bonds, credit — high-velocity first
  const tapeOrder: MacroCategory[] = ["equities", "crypto", "fx", "commods", "bonds", "credit"];
  const tape = tapeOrder.flatMap((cat) => quotes.filter((q) => q.category === cat));

  return {
    asOf: Math.floor(Date.now() / 1000),
    groups,
    tape,
  };
}
