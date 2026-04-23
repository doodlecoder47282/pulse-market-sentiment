// ChartPanel.tsx
// Full Chart tab: watchlist sidebar + multi-engine candlestick chart + gamma
// overlay + intraday granularity + P/C flow strip.
// Engines: "svg" (our custom), "lightweight" (TV open-source), "tv" (full TV widget).

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { CandlestickChart, type Candle, type GammaLevels } from "./CandlestickChart";
import LightweightCandlestick from "./LightweightCandlestick";
import TradingViewWidget from "./TradingViewWidget";
import Mag7Panel from "./Mag7Panel";
import { FlowStrip } from "./FlowPanel";
import ExposurePanel from "./ExposurePanel";
import UnusualFlowPanel from "./UnusualFlowPanel";
import { useTickers } from "./TickerContext";
import { Plus, X, Zap, CandlestickChart as CsIcon, Activity, Layers, Sigma, Flame } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import GammaLevelsStrip from "./GammaLevelsStrip";
import GammaContextBanner from "./GammaContextBanner";

type Timeframe = "1D" | "5D" | "1M" | "3M" | "1Y" | "5Y";
const TIMEFRAMES: Timeframe[] = ["1D", "5D", "1M", "3M", "1Y", "5Y"];

type Interval = "1m" | "5m" | "15m" | "30m" | "60m" | "1d" | "1wk" | "tick";
type Engine = "svg" | "lightweight" | "tv";
type ViewMode = "price" | "greeks" | "flow";

// Allowed intraday intervals per timeframe (Yahoo constraints)
const INTERVAL_OPTIONS: Record<Timeframe, Interval[]> = {
  "1D": ["1m", "5m", "15m", "30m", "60m", "tick"],
  "5D": ["5m", "15m", "30m", "60m", "tick"],
  "1M": ["60m", "1d", "tick"],
  "3M": ["1d"],
  "1Y": ["1d"],
  "5Y": ["1wk"],
};

// Default interval per timeframe
const DEFAULT_INTERVAL: Record<Timeframe, Interval> = {
  "1D": "5m",
  "5D": "30m",
  "1M": "1d",
  "3M": "1d",
  "1Y": "1d",
  "5Y": "1wk",
};

type OHLCResponse = {
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

type GammaResponse = {
  symbol: string;
  supported: boolean;
  spot?: number;
  levels: (GammaLevels & { totalGex: number; callWallGex: number; putWallGex: number }) | null;
  asOf?: number;
};

export default function ChartPanel() {
  const { watchlist, activeChart, setActiveChart, addTicker, removeTicker, recents, focusChart } = useTickers();
  const [tf, setTf] = useState<Timeframe>("1D");
  const [interval, setIntervalState] = useState<Interval>(DEFAULT_INTERVAL["1D"]);
  const [engine, setEngine] = useState<Engine>("lightweight");
  const [showGamma, setShowGamma] = useState(true);
  const [newSymbol, setNewSymbol] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("price");

  const onTfChange = (newTf: Timeframe) => {
    setTf(newTf);
    // Reset interval to sensible default for new TF
    setIntervalState(DEFAULT_INTERVAL[newTf]);
  };

  // Tick chart is a stub — requires Schwab feed
  const tickStub = interval === "tick";

  const ohlcQuery = useQuery<OHLCResponse>({
    queryKey: ["/api/ohlc", activeChart, tf, interval],
    queryFn: async () => {
      const iv = interval === "tick" ? "1m" : interval; // fallback for tick stub
      const r = await apiRequest(
        "GET",
        `/api/ohlc?symbol=${encodeURIComponent(activeChart)}&tf=${tf}&interval=${iv}`
      );
      return r.json();
    },
    refetchInterval: tf === "1D" || tf === "5D" ? 10_000 : 60_000,
    staleTime: 8_000,
    refetchOnWindowFocus: true,
    enabled: engine !== "tv", // TV widget fetches its own data
  });

  // Gamma query keyed on (symbol, timeframe) so future backend can return
  // timeframe-specific expiry buckets (weekly vs monthly vs quarterly)
  // without client churn. Today backend ignores tf and returns current
  // snapshot; we pass it anyway so QueryClient refetches when user changes tf.
  const gammaQuery = useQuery<GammaResponse>({
    queryKey: ["/api/gamma-levels", activeChart, tf],
    queryFn: async () => {
      const r = await apiRequest(
        "GET",
        `/api/gamma-levels?symbol=${encodeURIComponent(activeChart)}&tf=${tf}`
      );
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 50_000,
  });

  const ohlc = ohlcQuery.data;
  const gamma = gammaQuery.data;
  const gammaSupported = gamma?.supported && gamma.levels;

  const handleAdd = () => {
    if (!newSymbol.trim()) return;
    addTicker(newSymbol);
    setNewSymbol("");
  };

  const priceDisplay = useMemo(() => {
    if (!ohlc || ohlc.price == null) return null;
    const up = (ohlc.changePct ?? 0) > 0;
    const down = (ohlc.changePct ?? 0) < 0;
    const color = up ? "text-emerald-400" : down ? "text-rose-400" : "text-muted-foreground";
    return { price: ohlc.price, changePct: ohlc.changePct, color };
  }, [ohlc]);

  return (
    <div className="space-y-4" data-testid="chart-panel-wrapper">
      <Mag7Panel />

      {/* Flow strip above the chart for quick P/C read */}
      <FlowStrip />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr_240px]" data-testid="chart-panel">
        {/* Watchlist sidebar */}
        <aside className="space-y-2 rounded-xl border border-border/60 bg-card/40 p-3 backdrop-blur">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Watchlist</div>
            <Badge variant="outline" className="text-[9px]">{watchlist.length}</Badge>
          </div>

          <div className="flex gap-1">
            <Input
              placeholder="Add ticker"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              className="h-7 px-2 text-xs"
              data-testid="input-add-ticker"
            />
            <Button size="sm" variant="outline" onClick={handleAdd} className="h-7 px-2" data-testid="button-add-ticker">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="space-y-1 pt-1">
            {watchlist.map((w) => {
              const isActive = w.symbol === activeChart;
              return (
                <div
                  key={w.symbol}
                  className={[
                    "group flex items-center gap-1 rounded-md border px-2 py-1.5 transition cursor-pointer",
                    isActive ? "border-cyan-500/50 bg-cyan-500/10" : "border-border/40 hover:border-border",
                  ].join(" ")}
                  onClick={() => setActiveChart(w.symbol)}
                  data-testid={`watchlist-${w.symbol}`}
                >
                  <span className={`text-xs font-semibold ${isActive ? "text-cyan-300" : ""}`}>{w.label}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {w.symbol === "SPY" && (
                      <Zap className="h-2.5 w-2.5 text-amber-400" aria-label="Gamma available" />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeTicker(w.symbol); }}
                      className="text-muted-foreground/40 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                      data-testid={`remove-${w.symbol}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-2 text-[10px] leading-tight text-muted-foreground">
            <Zap className="inline h-2.5 w-2.5 text-amber-400" /> = gamma walls available
          </div>
        </aside>

        {/* Main chart area */}
        <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4 backdrop-blur">
          {/* Recents strip — quick-flip between tickers you clicked from elsewhere */}
          {recents.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">Recent</span>
              {recents.map((sym) => (
                <button
                  key={sym}
                  onClick={() => focusChart(sym)}
                  className={[
                    "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition",
                    sym === activeChart
                      ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                      : "border-border/50 text-muted-foreground hover:border-cyan-500/40 hover:text-cyan-200",
                  ].join(" ")}
                  data-testid={`recent-${sym}`}
                >
                  {sym}
                </button>
              ))}
            </div>
          )}

          {/* Chart header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-3">
              <div className="text-2xl font-bold tracking-tight" data-testid="text-chart-symbol">{activeChart}</div>
              {priceDisplay && engine !== "tv" && (
                <>
                  <div className="font-mono text-xl tabular-nums">
                    {priceDisplay.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </div>
                  <div className={`font-mono text-sm tabular-nums ${priceDisplay.color}`}>
                    {priceDisplay.changePct != null
                      ? `${priceDisplay.changePct >= 0 ? "+" : ""}${priceDisplay.changePct.toFixed(2)}%`
                      : "—"}
                  </div>
                </>
              )}
              {ohlc && engine !== "tv" && (
                <div className="text-[10px] text-muted-foreground">{ohlc.displayName}</div>
              )}
            </div>

            {/* View mode + Engine selector */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-md border border-border/40 p-0.5" data-testid="view-selector">
                <EngineButton active={viewMode === "price"} onClick={() => setViewMode("price")} icon={<CsIcon className="h-3 w-3" />} label="Price" />
                <EngineButton active={viewMode === "greeks"} onClick={() => setViewMode("greeks")} icon={<Sigma className="h-3 w-3" />} label="Greeks" />
                <EngineButton active={viewMode === "flow"} onClick={() => setViewMode("flow")} icon={<Flame className="h-3 w-3" />} label="Flow" />
              </div>
              {viewMode === "price" && (
              <div className="flex rounded-md border border-border/40 p-0.5" data-testid="engine-selector">
                <EngineButton active={engine === "svg"} onClick={() => setEngine("svg")} icon={<Activity className="h-3 w-3" />} label="SVG" />
                <EngineButton active={engine === "lightweight"} onClick={() => setEngine("lightweight")} icon={<CsIcon className="h-3 w-3" />} label="Light" />
                <EngineButton active={engine === "tv"} onClick={() => setEngine("tv")} icon={<Layers className="h-3 w-3" />} label="TV" />
              </div>
              )}
              {viewMode === "price" && gammaSupported && engine !== "tv" && (
                <button
                  onClick={() => setShowGamma((v) => !v)}
                  className={[
                    "flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition",
                    showGamma ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-border/40 text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                  data-testid="toggle-gamma"
                >
                  <Zap className="h-3 w-3" /> Gamma {showGamma ? "On" : "Off"}
                </button>
              )}
              {viewMode === "price" && (
              <div className="flex rounded-md border border-border/40 p-0.5">
                {TIMEFRAMES.map((t) => (
                  <button
                    key={t}
                    onClick={() => onTfChange(t)}
                    className={[
                      "rounded px-2 py-0.5 text-[11px] font-semibold tracking-wider transition",
                      tf === t ? "bg-cyan-500/20 text-cyan-300" : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                    data-testid={`tf-${t}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              )}
            </div>
          </div>

          {/* Interval sub-row */}
          {viewMode === "price" && INTERVAL_OPTIONS[tf].length > 1 && (
            <div className="flex flex-wrap items-center gap-1 text-[10px]">
              <span className="pr-1 uppercase tracking-wider text-muted-foreground">Granularity</span>
              {INTERVAL_OPTIONS[tf].map((iv) => {
                const isTick = iv === "tick";
                const label = isTick ? "Tick" : iv;
                return (
                  <button
                    key={iv}
                    onClick={() => setIntervalState(iv)}
                    className={[
                      "rounded border px-1.5 py-0.5 font-mono uppercase tracking-wider transition",
                      interval === iv
                        ? isTick
                          ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                          : "border-cyan-500/50 bg-cyan-500/10 text-cyan-300"
                        : "border-border/40 text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                    data-testid={`iv-${iv}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Engine-agnostic GEX banner — renders above every engine including
              TV, so the user always has call wall / put wall / 0γ / max pain
              context with distance-from-spot. */}
          {viewMode === "price" && showGamma && (
            <GammaContextBanner
              spot={
                engine === "tv"
                  ? gamma?.spot ?? null
                  : ohlc?.price ?? gamma?.spot ?? null
              }
              levels={gamma?.levels ?? null}
              symbol={activeChart}
              supported={!!gammaSupported}
              asOf={gamma?.asOf}
              timeframe={tf}
              engine={engine}
            />
          )}

          {/* Tick stub banner */}
          {viewMode === "price" && tickStub && (
            <div className="rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-[11px]">
              <div className="font-semibold text-violet-300">Tick chart requires a paid feed</div>
              <div className="mt-0.5 text-muted-foreground">
                Displaying 1m candles. Connect a tick feed for true intraday streaming.
              </div>
            </div>
          )}

          {/* Greeks view: exposure profile panel */}
          {viewMode === "greeks" ? (
            <ExposurePanel symbol={activeChart} />
          ) : viewMode === "flow" ? (
            <UnusualFlowPanel symbol={activeChart} />
          ) : (
          <>
          {/* The chart — engine-specific */}
          {engine === "tv" ? (
            <TradingViewWidget symbol={activeChart} interval={interval === "tick" ? "1m" : interval} height={640} />
          ) : ohlcQuery.isLoading && !ohlc ? (
            <div className="flex h-[440px] items-center justify-center rounded-lg border border-border/40 bg-muted/10 text-sm text-muted-foreground">
              Loading candles…
            </div>
          ) : ohlcQuery.isError ? (
            <div className="flex h-[440px] items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/5 text-sm text-rose-400">
              Failed to load candles. Try another ticker.
            </div>
          ) : engine === "lightweight" ? (
            <LightweightCandlestick
              candles={ohlc?.candles ?? []}
              gamma={gammaSupported && showGamma ? gamma!.levels : null}
              symbol={activeChart}
              height={460}
              showVolume
              showGamma={showGamma}
            />
          ) : (
            <CandlestickChart
              candles={ohlc?.candles ?? []}
              gamma={gammaSupported && showGamma ? gamma!.levels : null}
              symbol={activeChart}
              height={460}
              showVolume
              showGamma={showGamma}
            />
          )}

          {/* Footer stats */}
          {ohlc && ohlc.candles.length > 0 && engine !== "tv" && (
            <div className="grid grid-cols-2 gap-2 border-t border-border/40 pt-2 text-[11px] md:grid-cols-5">
              <Stat label="Range" value={`${ohlc.sessionLow?.toFixed(2) ?? "—"} – ${ohlc.sessionHigh?.toFixed(2) ?? "—"}`} />
              <Stat label="Candles" value={String(ohlc.candles.length)} />
              <Stat label="Interval" value={ohlc.interval} />
              <Stat label="Prev close" value={ohlc.prevClose?.toFixed(2) ?? "—"} />
              <Stat label="Updated" value={new Date(ohlc.asOf * 1000).toLocaleTimeString()} />
            </div>
          )}
          </>
          )}
        </section>

        {/* Gamma levels strip — right column (hidden on mobile, shown as chips above) */}
        <aside className="space-y-3" data-testid="gamma-levels-sidebar">
          <GammaLevelsStrip />
        </aside>
      </div>
    </div>
  );
}

function EngineButton({
  active, onClick, icon, label,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition",
        active ? "bg-cyan-500/20 text-cyan-300" : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
      data-testid={`engine-${label.toLowerCase()}`}
    >
      {icon} {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono tabular-nums">{value}</div>
    </div>
  );
}
