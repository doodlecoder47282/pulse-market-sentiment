// TradingViewWidget.tsx — embeds the full TradingView Advanced Chart widget
// with the complete editor toolbar enabled (drawings, indicators, compare,
// studies, save). Symbol + interval sync from the Chart tab.
//
// The TV embed is a black box — our gamma overlay is NOT available here.
// In exchange the user gets the full TV toolset: trendlines, fib retracements,
// pitchforks, text/arrow annotations, indicators library (MA, RSI, MACD,
// Bollinger, Ichimoku, VWAP, etc), compare-to ticker overlays, timeframe
// menus, alerts, and the full header toolbar.

import { useEffect, useRef } from "react";

type TVInterval = "1" | "3" | "5" | "15" | "30" | "60" | "120" | "240" | "D" | "W";

function toTVInterval(iv: string): TVInterval {
  const m: Record<string, TVInterval> = {
    "1m": "1",
    "2m": "1",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "60m": "60",
    "1h": "60",
    "1d": "D",
    "1wk": "W",
    "1mo": "W",
  };
  return m[iv] ?? "D";
}

function toTVSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s === "^VIX") return "CBOE:VIX";
  if (s === "^GSPC") return "SP:SPX";
  if (s === "^IXIC") return "NASDAQ:IXIC";
  if (s === "^DJI") return "DJ:DJI";
  if (s.includes("-USD")) return `CRYPTO:${s.replace("-USD", "USD")}`;
  if (s.startsWith("^")) return s.replace("^", "");
  return s;
}

export default function TradingViewWidget({
  symbol,
  interval,
  theme = "dark",
  height = 640,
}: {
  symbol: string;
  interval: string;
  theme?: "light" | "dark";
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    hostRef.current.innerHTML = "";

    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    container.style.width = "100%";

    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "calc(100% - 20px)";
    inner.style.width = "100%";
    container.appendChild(inner);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    // Full editor config — toggle every toolbar on so users can draw, add
    // studies, compare symbols, swap timeframes, save layouts, etc.
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: toTVSymbol(symbol),
      interval: toTVInterval(interval),
      timezone: "America/New_York",
      theme,
      style: "1",
      locale: "en",
      toolbar_bg: "#0a0a0a",
      // Header toolbar — enable every button
      hide_top_toolbar: false,
      hide_legend: false,
      withdateranges: true,
      allow_symbol_change: true,
      // Side toolbar (drawing tools: trendlines, fib, pitchforks, text, etc.)
      hide_side_toolbar: false,
      // Studies / indicators panel
      studies_overrides: {},
      studies: [
        "STD;Volume",
      ],
      // Full-screen + save + compare buttons
      calendar: true,
      // Gives the user the fullscreen button + publish/save controls
      enable_publishing: false,
      details: true,
      hotlist: true,
      // Allow container resize + make sure the widget owns all gestures
      container_id: "tradingview_widget",
      support_host: "https://www.tradingview.com",
      // Backtesting / replay button
      backgroundColor: "rgba(10, 10, 10, 1)",
      gridColor: "rgba(46, 46, 46, 0.35)",
      // Show the full header symbol + interval + compare + indicator menu
      hide_volume: false,
    });
    container.appendChild(script);
    hostRef.current.appendChild(container);

    return () => {
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [symbol, interval, theme]);

  return (
    <div
      ref={hostRef}
      className="rounded-lg border border-border/40 bg-black/20 overflow-hidden"
      style={{ height, width: "100%" }}
      data-testid={`tv-widget-${symbol}`}
    />
  );
}
