// server/macro.ts
// Macro carousel — categorized cross-asset quotes for the top-of-page ticker tape
// + rotating carousel. Pulls Yahoo chart API for all symbols in parallel.
//
// Categories: Equities / Bonds / Credit / Commods / FX / Crypto
// All quotes show last price, day change, day change%, plus a small 1M sparkline
// so the carousel feels alive.

import { fetchIntraday, fetchDailyCloses } from "./quotes";

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

  // FX (Yahoo uses =X suffix)
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
    const spark: number[] = (daily || []).map((d) => d.c).filter((c) => c != null && isFinite(c));
    const price = intra?.price ?? (spark.length ? spark[spark.length - 1] : null);
    const prevClose = intra?.prevClose ?? (spark.length >= 2 ? spark[spark.length - 2] : null);
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
  // Fire everything in parallel; Yahoo tolerates ~25 concurrent requests fine.
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
