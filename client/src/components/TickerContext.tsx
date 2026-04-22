// TickerContext.tsx
// Global user-managed ticker watchlist + cross-tab navigation bridge.
// In-memory only (sandbox blocks localStorage) but seeded with sensible defaults.
//
// Exposes `focusChart(symbol)` which ANY component (sector web, heatmap, WEF
// theme basket, news panel, etc) can call to:
//   1. Switch the top-level Dashboard tab to "chart"
//   2. Set it as the active chart ticker
//   3. Push to the recents list (most-recent-first, deduped, capped at 10)
//   4. Add to the watchlist if not already present

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type WatchlistEntry = {
  symbol: string;
  label: string;
};

// Top-level dashboard tabs — keep in sync with Dashboard.tsx <Tabs>.
export type TabKey =
  | "signals"
  | "chart"
  | "models"
  | "tradedesk"
  | "regime"
  | "news"
  | "voices"
  | "takefive";

type TickerContextValue = {
  watchlist: WatchlistEntry[];
  activeChart: string;
  recents: string[];
  activeTab: TabKey;
  setActiveTab: (t: TabKey) => void;
  setActiveChart: (sym: string) => void;
  addTicker: (sym: string, label?: string) => void;
  removeTicker: (sym: string) => void;
  /**
   * One-call bridge: route any ticker click on any tab → Chart tab with that
   * symbol loaded + remembered in recents. This is the primary API callers
   * should use for "click a ticker, jump to chart".
   */
  focusChart: (sym: string, label?: string) => void;
};

const DEFAULTS: WatchlistEntry[] = [
  { symbol: "SPY", label: "SPY" },
  { symbol: "QQQ", label: "QQQ" },
  { symbol: "IWM", label: "IWM" },
  { symbol: "NVDA", label: "NVDA" },
  { symbol: "AAPL", label: "AAPL" },
  { symbol: "TSLA", label: "TSLA" },
  { symbol: "BTC-USD", label: "BTC" },
];

const MAX_RECENTS = 10;

const Ctx = createContext<TickerContextValue | null>(null);

export function TickerProvider({ children }: { children: ReactNode }) {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(DEFAULTS);
  const [activeChart, setActiveChart] = useState("SPY");
  const [recents, setRecents] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("signals");

  const addTicker = useCallback((sym: string, label?: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setWatchlist((cur) => {
      if (cur.find((e) => e.symbol === s)) return cur;
      return [...cur, { symbol: s, label: label?.trim() || s }];
    });
    setActiveChart(s);
  }, []);

  const removeTicker = useCallback((sym: string) => {
    setWatchlist((cur) => cur.filter((e) => e.symbol !== sym));
    setActiveChart((cur) => (cur === sym ? "SPY" : cur));
  }, []);

  const focusChart = useCallback((sym: string, label?: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    // 1. Add to watchlist if missing (doesn't duplicate — addTicker guards)
    setWatchlist((cur) => {
      if (cur.find((e) => e.symbol === s)) return cur;
      return [...cur, { symbol: s, label: label?.trim() || s }];
    });
    // 2. Set active chart
    setActiveChart(s);
    // 3. Push to recents (most-recent-first, deduped, capped)
    setRecents((cur) => [s, ...cur.filter((r) => r !== s)].slice(0, MAX_RECENTS));
    // 4. Switch to chart tab
    setActiveTab("chart");
  }, []);

  return (
    <Ctx.Provider
      value={{
        watchlist,
        activeChart,
        recents,
        activeTab,
        setActiveTab,
        setActiveChart,
        addTicker,
        removeTicker,
        focusChart,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTickers() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTickers must be used within TickerProvider");
  return v;
}
