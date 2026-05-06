import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Snapshot_Public } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { fmt, scoreBg, scoreColor } from "@/lib/format";
import Gauge from "@/components/Gauge";
import MetricCard from "@/components/MetricCard";
import Logo from "@/components/Logo";
import { BatmanLogoSmall } from "@/components/BatmanLogo";
import VoicesPanel from "@/components/VoicesPanel";
import NewsPanel from "@/components/NewsPanel";
import TradeDesk from "@/components/TradeDesk";
import RegimePanel from "@/components/RegimePanel";
import { Mag7Strip } from "@/components/Mag7Panel";
import FlowPanel from "@/components/FlowPanel";
import TakeFive, { TakeFiveFab } from "@/components/TakeFive";
import { MacroTicker, MacroCarousel } from "@/components/MacroCarousel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTickers, type TabKey } from "@/components/TickerContext";
import ErrorBoundary from "@/components/ErrorBoundary";
import LiveQuoteStrip from "@/components/LiveQuoteStrip";
import ShortcutsModal from "@/components/ShortcutsModal";
import { useTheme } from "@/components/ThemeContext";
import { CollapsibleCard } from "@/components/CollapsibleCard";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw, ExternalLink, ArrowDownRight, ArrowUpRight, Zap,
  Activity, Waves, MessageSquare, Newspaper, AlertTriangle,
  Keyboard, Settings, Sun, Moon, LayoutGrid, LayoutList,
} from "lucide-react";
import SchwabSettings, { SchwabStatusPill } from "@/components/SchwabSettings";
import WhaleFlowPanel from "@/components/WhaleFlowPanel";
import { ThresholdTuner } from "@/components/ThresholdTuner";
import { useEffect, useState, useRef, lazy, Suspense } from "react";

// ── Lazy-loaded heavy components (code splitting) ──────────────────────────
const ChartPanel = lazy(() => import("@/components/ChartPanel"));
const ModelsPanel = lazy(() => import("@/components/ModelsPanel"));
const GexChart = lazy(() => import("@/components/GexChart"));
const Heatseeker = lazy(() => import("@/components/Heatseeker"));

// These are lighter but still benefit from lazy loading on non-default tabs
const ChartPanelEager = lazy(() => import("@/components/ChartPanel"));
const TradeDeskPanel = lazy(() => import("@/components/TradeDesk"));
const RegimePanelLazy = lazy(() => import("@/components/RegimePanel"));
const CosmosPanelLazy = lazy(() => import("@/components/CosmosPanel"));

// ── Market status helpers ──────────────────────────────────────────────────
type MarketStatus = "OPEN" | "PRE-MARKET" | "AFTER-HOURS" | "CLOSED";

function getMarketStatus(): MarketStatus {
  // Convert to Eastern Time
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const totalMins = hours * 60 + minutes;

  // Weekend
  if (day === 0 || day === 6) return "CLOSED";

  // Regular trading hours: 9:30 AM – 4:00 PM ET
  if (totalMins >= 9 * 60 + 30 && totalMins < 16 * 60) return "OPEN";
  // Pre-market: 4:00 AM – 9:30 AM ET
  if (totalMins >= 4 * 60 && totalMins < 9 * 60 + 30) return "PRE-MARKET";
  // After-hours: 4:00 PM – 8:00 PM ET
  if (totalMins >= 16 * 60 && totalMins < 20 * 60) return "AFTER-HOURS";

  return "CLOSED";
}

function MarketStatusPill({ status }: { status: MarketStatus }) {
  const cfg = {
    OPEN: { label: "OPEN", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-400", pulse: true },
    "PRE-MARKET": { label: "PRE-MKT", cls: "border-amber-500/50 bg-amber-500/10 text-amber-400", pulse: false },
    "AFTER-HOURS": { label: "AFTER-HRS", cls: "border-amber-500/50 bg-amber-500/10 text-amber-400", pulse: false },
    CLOSED: { label: "CLOSED", cls: "border-red-500/40 bg-red-500/5 text-red-400", pulse: false },
  }[status];

  return (
    <div className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${cfg.cls}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          cfg.pulse ? "animate-pulse bg-emerald-400" : "bg-current"
        }`}
        aria-hidden
      />
      <span className="font-mono text-[10px] font-semibold tracking-wider">{cfg.label}</span>
    </div>
  );
}

function LiveClock() {
  const [time, setTime] = useState(() => {
    return new Date().toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  useEffect(() => {
    const id = setInterval(() => {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground" data-testid="live-clock">
      {time} ET
    </span>
  );
}

export default function Dashboard() {
  const { theme, toggleTheme, compact, toggleCompact } = useTheme();
  // Take Five overlay state — shared by floating FAB and tab "peek" button.
  const [take5Open, setTake5Open] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Keyboard shortcuts help modal
  const [helpOpen, setHelpOpen] = useState(false);
  // PCR DTE bucket selector — drives which horizon of put/call ratio the KeyStat shows.
  const [pcrBucket, setPcrBucket] = useState<string>("0-45D");
  // Market status — computed once per second via clock
  const [marketStatus, setMarketStatus] = useState<MarketStatus>(getMarketStatus);

  // Controlled top-level tab so sector-web / heatmap / wef cards can deep-link
  // into the Chart tab via the TickerContext bridge.
  const { activeTab, setActiveTab } = useTickers();
  const { toast } = useToast();

  // Ref for Chart tab ticker input (for "/" shortcut)
  const tickerInputRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery<Snapshot_Public>({
    queryKey: ["/api/snapshot"],
    refetchInterval: 60_000,  // auto-refresh every 60s
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const refreshMut = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/snapshot/refresh").then((r) => r.json()),
    onSuccess: (d) => {
      queryClient.setQueryData(["/api/snapshot"], d);
      toast({ title: "Snapshot updated", description: "All data refreshed." });
    },
    onError: () => {
      toast({
        title: "Refresh failed",
        description: "Couldn't refresh snapshot — check connection.",
        variant: "destructive",
      });
    },
  });

  // Market status: update every 30 seconds (cheap)
  useEffect(() => {
    setMarketStatus(getMarketStatus());
    const id = setInterval(() => setMarketStatus(getMarketStatus()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Toast on snapshot fetch error
  useEffect(() => {
    if (isError) {
      toast({
        title: "Couldn't refresh quotes — retrying",
        description: "Snapshot data may be stale.",
        variant: "destructive",
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError]);

  // auto dark mode (respect system)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (on: boolean) => document.documentElement.classList.toggle("dark", on);
    apply(mq.matches || true); // default to dark for trading feel
    mq.addEventListener("change", (e) => apply(e.matches || true));
  }, []);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    activeTab,
    setActiveTab,
    setTake5Open,
    take5Open,
    setHelpOpen,
    helpOpen,
    tickerInputRef,
  });

  if (isLoading) return <DashboardSkeleton />;

  if (isError || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-500" />
            <h2 className="text-lg font-semibold">Couldn't load snapshot</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {(error as Error)?.message ?? "Upstream data sources are unreachable."}
            </p>
            <Button className="mt-4" onClick={() => refreshMut.mutate()} data-testid="button-retry">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { composite, vol, spy, gamma, term, social, fearGreed, headlines } = data;

  return (
    <div className="min-h-screen bg-background">
      {/* Floating Take Five launcher — visible on every tab */}
      <TakeFiveFab onClick={() => setTake5Open(true)} />
      <TakeFive mode="overlay" open={take5Open} onClose={() => setTake5Open(false)} />

      {/* Keyboard shortcuts help modal */}
      <ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* Schwab settings dialog */}
      <SchwabSettings open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-2 px-3 py-3 sm:px-4 md:px-8 xl:px-10">
          {/* Left: Logo + name + BATCAVE tag */}
          <div className="flex items-center gap-3">
            <div className="text-primary"><Logo className="h-7 w-7" /></div>
            <div>
              <div className="font-semibold leading-none">Pulse</div>
              <div className="flex items-center gap-1">
                <BatmanLogoSmall className="h-3 w-6 text-amber-500" />
                <span className="font-mono text-[10px] uppercase tracking-widest text-amber-500/80">BATCAVE</span>
              </div>
            </div>
          </div>

          {/* Center: Live quotes strip (desktop only) */}
          <div className="hidden lg:flex">
            <ErrorBoundary compact label="LiveQuoteStrip">
              <LiveQuoteStrip />
            </ErrorBoundary>
          </div>

          {/* Right: Clock + market status + last-update + refresh */}
          <div className="flex items-center gap-2 md:gap-3">
            {/* Clock + market status: stacked, visible on md+ */}
            <div className="hidden items-end gap-2 md:flex">
              <div className="flex flex-col items-end gap-0.5">
                <LiveClock />
                <MarketStatusPill status={marketStatus} />
              </div>
            </div>

            {/* Live quotes on tablet (not desktop) */}
            <div className="hidden sm:flex lg:hidden">
              <ErrorBoundary compact label="LiveQuoteStrip">
                <LiveQuoteStrip />
              </ErrorBoundary>
            </div>

            <div className="hidden text-right md:block">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Last update</div>
              <div className="font-mono text-xs" data-testid="text-last-update">
                {fmt.ts(data.capturedAt)}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMut.mutate()}
              disabled={refreshMut.isPending}
              data-testid="button-refresh"
              className="px-2 sm:px-3"
            >
              <RefreshCw className={`h-3.5 w-3.5 sm:mr-2 ${refreshMut.isPending ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            {/* Schwab status pill */}
            <SchwabStatusPill onClick={() => setSettingsOpen(true)} />

            {/* Settings gear */}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Schwab & Settings"
              className="flex items-center rounded-md border border-border/60 p-1.5 text-muted-foreground/50 transition hover:border-border hover:text-muted-foreground"
              data-testid="button-settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>

            {/* Theme toggle — light / dark */}
            <button
              type="button"
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle color theme"
              className="flex items-center rounded-md border border-border/60 p-1.5 text-muted-foreground/60 transition hover:border-border hover:text-amber-500"
              data-testid="button-theme-toggle"
            >
              {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>

            {/* Compact mode — shrinks all collapsible cards at once */}
            <button
              type="button"
              onClick={toggleCompact}
              title={compact ? "Expand all cards" : "Compact all cards"}
              aria-label="Toggle compact mode"
              className={`hidden items-center rounded-md border p-1.5 transition md:flex ${
                compact
                  ? "border-amber-500/70 text-amber-500 hover:border-amber-400"
                  : "border-border/60 text-muted-foreground/60 hover:border-border hover:text-muted-foreground"
              }`}
              data-testid="button-compact-toggle"
            >
              {compact ? <LayoutGrid className="h-3.5 w-3.5" /> : <LayoutList className="h-3.5 w-3.5" />}
            </button>

            {/* Shortcut hint */}
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              title="Keyboard shortcuts (?)"
              className="hidden items-center rounded-md border border-border/60 p-1.5 text-muted-foreground/50 transition hover:border-border hover:text-muted-foreground md:flex"
              data-testid="button-shortcuts-hint"
            >
              <Keyboard className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Ticker tape — flows across the top under the header on every tab */}
      <MacroTicker />

      <main className="mx-auto max-w-[1800px] space-y-4 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-6 md:px-8 xl:px-10 xl:text-[16px]">
        {/* Rotating macro carousel — always visible above the tabs */}
        <MacroCarousel />

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)} className="w-full">
          {/* Mobile: 3-col grid wraps to 3 rows so every tab is visible. Desktop: single inline row. */}
          <div className="mb-4">
            <TabsList
              className="grid h-auto w-full grid-cols-3 gap-1 p-1 sm:grid-cols-5 md:flex md:h-10 md:w-full md:flex-nowrap md:items-center md:justify-center md:gap-0 md:p-1 xl:h-12 xl:gap-1 xl:p-1.5"
              data-testid="tabs-dashboard"
            >
              <TabsTrigger value="signals" data-testid="tab-signals" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">Signals</TabsTrigger>
              <TabsTrigger value="chart" data-testid="tab-chart" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">Chart</TabsTrigger>
              <TabsTrigger value="models" data-testid="tab-models" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">Models</TabsTrigger>
              <TabsTrigger
                value="heatseeker"
                data-testid="tab-heatseeker"
                className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold data-[state=active]:bg-gradient-to-r data-[state=active]:from-orange-500/30 data-[state=active]:to-rose-500/30 data-[state=active]:text-orange-50"
              >
                Heatseeker
              </TabsTrigger>
              <TabsTrigger value="tradedesk" data-testid="tab-tradedesk" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">Trade Desk</TabsTrigger>
              <TabsTrigger value="regime" data-testid="tab-regime" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">Regime</TabsTrigger>
              <TabsTrigger
                value="cosmos"
                data-testid="tab-cosmos"
                className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold data-[state=active]:bg-gradient-to-r data-[state=active]:from-amber-600/30 data-[state=active]:via-indigo-500/20 data-[state=active]:to-emerald-500/25 data-[state=active]:text-amber-100"
              >
                Cosmos
              </TabsTrigger>
              <TabsTrigger value="news" data-testid="tab-news" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">News</TabsTrigger>
              <TabsTrigger value="voices" data-testid="tab-voices" className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold">Voices</TabsTrigger>
              <TabsTrigger
                value="takefive"
                data-testid="tab-takefive"
                className="w-full text-[13px] sm:text-sm md:w-auto md:flex-1 md:text-sm xl:px-6 xl:text-[16px] xl:font-semibold data-[state=active]:bg-gradient-to-r data-[state=active]:from-fuchsia-600/40 data-[state=active]:via-cyan-500/30 data-[state=active]:to-amber-400/40 data-[state=active]:text-white"
              >
                Take Five
              </TabsTrigger>
            </TabsList>
          </div>

          {/* ── Chart tab (lazy) ── */}
          <TabsContent value="chart" className="space-y-6">
            <ErrorBoundary label="Chart Panel">
              <Suspense fallback={<PanelSkeleton variant="chart" />}>
                <ChartPanelEager />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          {/* ── Models tab (lazy) ── */}
          <TabsContent value="models" className="space-y-6">
            <ErrorBoundary label="Models Panel">
              <Suspense fallback={<PanelSkeleton variant="chart" />}>
                <ModelsPanel />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          {/* ── Heatseeker tab (lazy) ─ 0DTE live Greeks + sticky zones ── */}
          <TabsContent value="heatseeker" className="space-y-6">
            <ErrorBoundary label="Heatseeker">
              <Suspense fallback={<PanelSkeleton variant="chart" />}>
                <Heatseeker />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          {/* ── Trade Desk tab (lazy) ── */}
          <TabsContent value="tradedesk" className="space-y-6">
            <ErrorBoundary label="Trade Desk">
              <Suspense fallback={<PanelSkeleton variant="chart" />}>
                <TradeDeskPanel />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          {/* ── Regime tab (lazy) ── */}
          <TabsContent value="regime" className="space-y-6">
            <ErrorBoundary label="Regime Panel">
              <Suspense fallback={<PanelSkeleton variant="chart" />}>
                <RegimePanelLazy />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          {/* ── Cosmos tab (lazy) — astrology intel brief + live sky engine ── */}
          <TabsContent value="cosmos" className="space-y-6">
            <ErrorBoundary label="Cosmos Panel">
              <Suspense fallback={<PanelSkeleton variant="chart" />}>
                <CosmosPanelLazy />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          {/* ── News tab ── */}
          <TabsContent value="news" className="space-y-6">
            <ErrorBoundary label="News Panel">
              <NewsPanel />
            </ErrorBoundary>
          </TabsContent>

          {/* ── Voices tab ── */}
          <TabsContent value="voices" className="space-y-6">
            <ErrorBoundary label="Voices Panel">
              <VoicesPanel />
            </ErrorBoundary>
          </TabsContent>

          {/* ── Take Five tab ── */}
          <TabsContent value="takefive" className="space-y-6">
            <ErrorBoundary label="Take Five">
              <TakeFive mode="embedded" />
            </ErrorBoundary>
          </TabsContent>

          {/* ── Signals tab (eager — primary tab) ── */}
          <TabsContent value="signals" className="space-y-6">
            {/* Whale Flow panel — fresh detections + tracking + closed */}
            <ErrorBoundary label="Whale Flow">
              <WhaleFlowPanel />
            </ErrorBoundary>

            {/* Runtime threshold tuner — adjust whale gate without redeploy */}
            <ErrorBoundary label="Threshold Tuner">
              <ThresholdTuner />
            </ErrorBoundary>

            {/* Mag 7 quick read — strip above composite */}
            <ErrorBoundary compact label="Mag7 Strip">
              <Mag7Strip />
            </ErrorBoundary>

            {/* Put/Call flow — prominent above composite */}
            <ErrorBoundary label="Flow Panel">
              <FlowPanel onOpenSettings={() => setSettingsOpen(true)} />
            </ErrorBoundary>

            {/* Top row: composite + SPY/VIX quick panel */}
            <section className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
              {/* Composite */}
              <Card className="lg:col-span-5" data-testid="card-composite">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">Composite Sentiment</div>
                      <h2 className="mt-1 text-lg font-semibold">{composite.label}</h2>
                    </div>
                    <Badge variant="outline" className={`${scoreColor(composite.score)} border-current`}>
                      {composite.score}/100
                    </Badge>
                  </div>
                  <div className="mt-2 flex justify-center">
                    <Gauge value={composite.score} label={composite.label} size={280} />
                  </div>
                  <p className="mt-4 text-sm text-muted-foreground" data-testid="text-takeaway">{composite.takeaway}</p>
                  <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                    <div className="flex items-center gap-2 text-amber-500">
                      <Zap className="h-3.5 w-3.5" />
                      <span className="text-[11px] uppercase tracking-widest">Trading Regime</span>
                    </div>
                    <div className="mt-1 text-foreground" data-testid="text-regime">{composite.tradingRegime}</div>
                  </div>
                </CardContent>
              </Card>

              {/* Quick metrics */}
              <div className="grid auto-rows-min content-start grid-cols-2 gap-3 md:grid-cols-3 lg:col-span-7 lg:grid-cols-3">
                <MetricCard
                  testId="metric-spy"
                  label="SPY"
                  value={fmt.usd(spy.price)}
                  changePct={spy.changePct}
                  sub={`Prev ${fmt.usd(spy.prevClose)}`}
                  accent={spy.changePct >= 0 ? "bull" : "bear"}
                />
                <MetricCard
                  testId="metric-vix"
                  label="VIX"
                  value={fmt.num(vol.vix.value)}
                  changePct={vol.vix.changePct}
                  sub={vol.vix.value != null && vol.vix.value > 20 ? "Above stress line" : "Normal range"}
                  accent={vol.vix.value != null && vol.vix.value > 20 ? "warn" : "neutral"}
                />
                <MetricCard
                  testId="metric-vvix"
                  label="VVIX"
                  value={fmt.num(vol.vvix.value)}
                  changePct={vol.vvix.changePct}
                  sub="Vol-of-Vol"
                />
                <MetricCard
                  testId="metric-vix9d"
                  label="VIX 9D"
                  value={fmt.num(vol.vix9d.value)}
                  changePct={vol.vix9d.changePct}
                  sub="Front-end"
                />
                <MetricCard
                  testId="metric-vix3m"
                  label="VIX 3M"
                  value={fmt.num(vol.vix3m.value)}
                  changePct={vol.vix3m.changePct}
                  sub="Longer tenor"
                />
                <MetricCard
                  testId="metric-skew"
                  label="SKEW"
                  value={fmt.num(vol.skew.value, 1)}
                  changePct={vol.skew.changePct}
                  sub={vol.skew.value != null && vol.skew.value > 150 ? "Tail hedging elevated" : "Tail risk pricing"}
                  accent={vol.skew.value != null && vol.skew.value > 150 ? "warn" : "neutral"}
                />
              </div>
            </section>

            {/* Second row: sub-gauges breakdown */}
            <section>
              <CollapsibleCard
                id="signal-breakdown"
                title={
                  <>
                    Signal Breakdown
                    <span className="ml-2 text-xs font-normal text-muted-foreground">weighted components · 0 fear → 100 greed</span>
                  </>
                }
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {composite.gauges.map((g) => (
                    <div key={g.name} className="rounded-md border border-border bg-card/50 p-3" data-testid={`gauge-${g.name}`}>
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-medium">{g.name}</div>
                        <div className={`font-mono text-xs ${scoreColor(g.value)}`}>{Math.round(g.value)}</div>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full ${scoreBg(g.value)} transition-all`}
                          style={{ width: `${g.value}%` }}
                        />
                      </div>
                      <div className="mt-2 text-[11px] leading-snug text-muted-foreground">{g.interpretation}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground/70">weight {(g.weight * 100).toFixed(0)}%</div>
                    </div>
                  ))}
                </div>
              </CollapsibleCard>
            </section>

            {/* Third row: Gamma structure chart + term structure */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <CollapsibleCard
                id="gamma-structure"
                className="lg:col-span-8"
                title={<><Activity className="h-4 w-4" />Dealer Gamma Structure (SPY · 0-45 DTE)</>}
              >
                <>
                  <div className="mb-3 flex flex-wrap gap-3 text-xs">
                    <KeyStat
                      label="Net GEX"
                      value={fmt.bn(gamma.totalGex)}
                      tone={gamma.regime === "positive" ? "bull" : gamma.regime === "negative" ? "bear" : "neutral"}
                      sub="$ per 1% move"
                      testId="stat-net-gex"
                    />
                    <KeyStat
                      label="Regime"
                      value={gamma.regime === "positive" ? "Positive γ" : gamma.regime === "negative" ? "Negative γ" : "Near Flip"}
                      tone={gamma.regime === "positive" ? "bull" : gamma.regime === "negative" ? "bear" : "warn"}
                      sub={gamma.regime === "positive" ? "mean-reversion" : "trend/breakout"}
                    />
                    <KeyStat label="Call Wall" value={fmt.num(gamma.callWall, 0)} sub="resistance" tone="neutral" />
                    <KeyStat label="Put Wall" value={fmt.num(gamma.putWall, 0)} sub="support" tone="neutral" />
                    <KeyStat label="Zero-Γ Flip" value={gamma.zeroGamma ? fmt.num(gamma.zeroGamma, 1) : "—"} sub="regime boundary" tone="warn" />
                    <KeyStat label="Max Pain" value={fmt.num(gamma.maxPain, 0)} sub={`exp +${gamma.nearestDte}d`} tone="neutral" />
                    {(() => {
                      const buckets = gamma.pcrByBucket && gamma.pcrByBucket.length
                        ? gamma.pcrByBucket
                        : [{ label: "0-45D", dteMax: 45, pcrOi: gamma.pcrOi, pcrVol: gamma.pcrVol, callOi: 0, putOi: 0 }];
                      const active = buckets.find((b) => b.label === pcrBucket) ?? buckets[buckets.length - 1];
                      return (
                        <div className="flex flex-col gap-1" data-testid="pcr-selector">
                          <KeyStat
                            label="PCR (OI)"
                            value={fmt.num(active.pcrOi, 2)}
                            sub={`${active.label} · ${fmt.int(active.putOi)}P / ${fmt.int(active.callOi)}C`}
                            tone={active.pcrOi > 1.5 ? "warn" : "neutral"}
                          />
                          <div className="flex flex-wrap gap-1">
                            {buckets.map((b) => (
                              <button
                                key={b.label}
                                type="button"
                                onClick={() => setPcrBucket(b.label)}
                                data-testid={`pcr-bucket-${b.label}`}
                                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-mono transition ${
                                  b.label === active.label
                                    ? "border-amber-400 bg-amber-400/20 text-amber-200"
                                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                                }`}
                              >
                                {b.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  <ErrorBoundary compact label="GexChart">
                    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
                      <GexChart gamma={gamma} />
                    </Suspense>
                  </ErrorBoundary>
                  <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                    Bars above zero = dealers long gamma at that strike (stabilizing). Bars below zero = short gamma
                    (amplifying). Computed from CBOE delayed options chain; calls contribute +, puts contribute − weighted by
                    Γ × OI × 100 × S² × 1%.
                  </p>
                </>
              </CollapsibleCard>

              {/* Term structure + top OI */}
              <div className="space-y-4 lg:col-span-4">
                <CollapsibleCard
                  id="vix-term"
                  title={<><Waves className="h-4 w-4" />VIX Term Structure</>}
                >
                  <div className="space-y-3">
                    <TermBar label="VIX 9D"  value={term.vix9d}  max={40} />
                    <TermBar label="VIX 30D" value={term.vix}    max={40} highlight />
                    <TermBar label="VIX 3M"  value={term.vix3m}  max={40} />
                    <Separator />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">9D / 30D Ratio</span>
                      <span className={`font-mono ${term.ratio9dOver30d && term.ratio9dOver30d > 1 ? "text-red-500" : "text-emerald-500"}`}>
                        {term.ratio9dOver30d ? term.ratio9dOver30d.toFixed(3) : "—"}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {term.ratio9dOver30d != null && (
                        term.ratio9dOver30d < 0.95 ? "Contango — front-end calm, trend-friendly environment."
                        : term.ratio9dOver30d < 1.05 ? "Flat curve — transitional."
                        : "Backwardation — near-term stress priced in."
                      )}
                    </div>
                  </div>
                </CollapsibleCard>

                <CollapsibleCard id="top-oi" title="Top Open Interest">
                  <>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="mb-1 font-medium text-emerald-500">Calls</div>
                        {gamma.topCallOi.map((s) => (
                          <div key={`c-${s.strike}-${s.expiry}`} className="flex items-baseline justify-between gap-2 py-0.5">
                            <span className="flex min-w-0 items-baseline gap-1">
                              <span className="font-mono">{s.strike.toFixed(0)}</span>
                              {s.expiry && (
                                <span className="truncate font-mono text-[9px] text-muted-foreground/70">
                                  {s.expiry.slice(5)}·{s.dte}d
                                </span>
                              )}
                            </span>
                            <span className="font-mono text-muted-foreground">{fmt.int(s.oi)}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="mb-1 font-medium text-red-500">Puts</div>
                        {gamma.topPutOi.map((s) => (
                          <div key={`p-${s.strike}-${s.expiry}`} className="flex items-baseline justify-between gap-2 py-0.5">
                            <span className="flex min-w-0 items-baseline gap-1">
                              <span className="font-mono">{s.strike.toFixed(0)}</span>
                              {s.expiry && (
                                <span className="truncate font-mono text-[9px] text-muted-foreground/70">
                                  {s.expiry.slice(5)}·{s.dte}d
                                </span>
                              )}
                            </span>
                            <span className="font-mono text-muted-foreground">{fmt.int(s.oi)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] italic text-muted-foreground/70">Small text = dominant expiry for that strike (MM-DD·DTE)</div>
                  </>
                </CollapsibleCard>
              </div>
            </section>

            {/* Fourth row: social + Fear&Greed + headlines */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <CollapsibleCard
                id="social-chatter"
                className="lg:col-span-6"
                title={
                  <>
                    <MessageSquare className="h-4 w-4" />
                    X &amp; Reddit Chatter
                    <Badge variant="secondary" className="ml-2 font-mono text-[10px]">
                      score {social.score >= 0 ? "+" : ""}{social.score}
                    </Badge>
                  </>
                }
              >
                <>
                  <div className="mb-3 flex items-center gap-4 text-xs">
                    <span className="text-emerald-500">
                      <ArrowUpRight className="mr-1 inline h-3 w-3" />
                      {social.bullish} bullish
                    </span>
                    <span className="text-red-500">
                      <ArrowDownRight className="mr-1 inline h-3 w-3" />
                      {social.bearish} bearish
                    </span>
                    <span className="text-muted-foreground">{social.neutral} neutral</span>
                  </div>
                  {social.posts.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                      Social feed unreachable. Public X mirrors occasionally block requests — the composite still updates from
                      VIX, gamma, and Fear &amp; Greed signals.
                    </div>
                  ) : (
                    <ScrollArea className="h-[300px] pr-3">
                      <div className="space-y-2">
                        {social.posts.map((p, i) => (
                          <a
                            key={i}
                            href={p.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="block rounded-md border border-border p-2.5 text-xs hover-elevate"
                            data-testid={`post-${i}`}
                          >
                            <div className="mb-1 flex items-center gap-2">
                              <Badge variant="outline" className="text-[9px]">{p.source}</Badge>
                              {p.author && <span className="font-mono text-muted-foreground">{p.author}</span>}
                              <span className={`ml-auto text-[10px] ${fmt.toneColor(p.tone)}`}>{p.tone}</span>
                            </div>
                            <div className="leading-snug">{p.text}</div>
                          </a>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </>
              </CollapsibleCard>

              <div className="space-y-4 lg:col-span-6">
                <CollapsibleCard id="fear-greed" title="CNN Fear &amp; Greed">
                  <>
                    {fearGreed ? (
                      <div className="flex items-center gap-4">
                        <div className={`font-mono text-4xl font-bold ${scoreColor(fearGreed.value)}`} data-testid="text-fg-value">
                          {fearGreed.value}
                        </div>
                        <div>
                          <div className="text-sm font-medium">{fearGreed.label}</div>
                          <div className="text-xs text-muted-foreground">0 (fear) · 50 (neutral) · 100 (greed)</div>
                          <div className="mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-muted">
                            <div className={`h-full ${scoreBg(fearGreed.value)}`} style={{ width: `${fearGreed.value}%` }} />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">CNN feed unreachable.</div>
                    )}
                  </>
                </CollapsibleCard>

                <CollapsibleCard
                  id="headlines"
                  title={<><Newspaper className="h-4 w-4" /> Market Headlines</>}
                >
                  <>
                    {headlines.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No headlines available.</div>
                    ) : (
                      <ul className="space-y-2">
                        {headlines.map((h, i) => (
                          <li key={i}>
                            <a
                              href={h.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="flex items-start gap-2 rounded-md p-1.5 text-xs hover-elevate"
                              data-testid={`headline-${i}`}
                            >
                              <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />
                              <div>
                                <div className="leading-snug">{h.title}</div>
                                <div className="text-[10px] text-muted-foreground">{h.source}</div>
                              </div>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                </CollapsibleCard>
              </div>
            </section>

            {/* Footer / methodology */}
            <footer className="pb-10 pt-4 text-[11px] text-muted-foreground">
              <Separator className="mb-4" />
              <div className="space-y-1 leading-relaxed">
                <div>
                  <span className="font-medium text-foreground">Methodology.</span> Composite = weighted average of
                  VIX level (22%), dealer gamma regime (15%), put/call OI (12%), 9D/30D term structure (12%), social tone (10%),
                  VVIX (8%), SKEW (8%), Fear &amp; Greed (8%), AAII spread (5%). GEX proxy: Γ × OI × 100 × S² × 1% from CBOE
                  delayed chain, 0-45 DTE. Social: StockTwits cashtag streams for $SPY and $VIX (explicit bull/bear tags when posters
                  mark them, lexicon scoring otherwise) combined with r/options hot posts. Transparent and auditable, not ML.
                </div>
                <div>
                  <span className="font-medium text-foreground">Data.</span> Yahoo (indices), CBOE (SPY options chain), CNN
                  (F&amp;G). Delayed quotes. Not investment advice.
                </div>
              </div>
            </footer>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

const KEY_STAT_TOOLTIPS: Record<string, string> = {
  "Net GEX": "Net Gamma Exposure: total dealer gamma in dollars per 1% move. Positive = dealers long gamma (stabilizing); negative = short gamma (amplifying moves).",
  "Regime": "Gamma regime based on net dealer positioning. Positive gamma → mean-reversion / range-bound. Negative gamma → trend-following / breakout potential.",
  "Call Wall": "Strike with the largest positive gamma exposure (call concentration). Acts as a ceiling — dealers sell rallies above this level to hedge.",
  "Put Wall": "Strike with the largest negative gamma exposure (put concentration). Acts as a floor — dealers buy dips below this level.",
  "Zero-Γ Flip": "Zero Gamma level: the price where net dealer gamma flips sign. Below = negative gamma (amplified moves); above = positive gamma (dampened).",
  "Max Pain": "Options max pain: the strike price where the total value of outstanding options contracts is minimized. Price tends to gravitate here near expiry.",
  "PCR (OI)": "Put/Call ratio by open interest. >1.5 = heavy put positioning (fear/hedging); <0.7 = call-heavy (complacency/bullish). DTE bucket selectable below.",
  "Q-Score": "Quantitative composite sentiment score (0–100). <30 = pinned/fear, 30–60 = mixed, >60 = fragile/greed. Weights VIX, gamma, PCR, term structure, social, F&G.",
};

function KeyStat({
  label, value, sub, tone = "neutral", testId,
}: { label: string; value: string; sub?: string; tone?: "bull" | "bear" | "warn" | "neutral"; testId?: string }) {
  const toneClass =
    tone === "bull" ? "text-emerald-500"
    : tone === "bear" ? "text-red-500"
    : tone === "warn" ? "text-amber-500"
    : "text-foreground";
  const tooltip = KEY_STAT_TOOLTIPS[label];
  const inner = (
    <div className="min-w-[90px] rounded-md border border-border bg-card/50 px-2.5 py-1.5 cursor-default" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}{tooltip && <span className="ml-0.5 text-muted-foreground/40">?</span>}</div>
      <div className={`font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
  if (!tooltip) return inner;
  return (
    <UITooltip>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">{tooltip}</TooltipContent>
    </UITooltip>
  );
}

function TermBar({ label, value, max, highlight }: { label: string; value: number | null; max: number; highlight?: boolean }) {
  const pct = value != null ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px]">
        <span className={highlight ? "font-medium" : "text-muted-foreground"}>{label}</span>
        <span className="font-mono">{value != null ? value.toFixed(2) : "—"}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${highlight ? "bg-primary" : "bg-muted-foreground/50"} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-[1800px] space-y-6">
        <Skeleton className="h-14 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Skeleton className="h-[420px] lg:col-span-5" />
          <div className="grid grid-cols-3 gap-3 lg:col-span-7">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        </div>
        <Skeleton className="h-48 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Skeleton className="h-[360px] lg:col-span-8" />
          <Skeleton className="h-[360px] lg:col-span-4" />
        </div>
      </div>
    </div>
  );
}
