import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Sparkle, TrendingUp, TrendingDown, Activity, Clock,
  AlertTriangle, ChevronRight, ChevronDown, Gauge as GaugeIcon,
  Crown, Target, Zap, BarChart2, Shield, Calendar,
} from "lucide-react";
import SectorWeb from "./SectorWeb";
import WefThemePanel from "./WefThemePanel";
import ErrorBoundary from "./ErrorBoundary";
import SeasonalityPanel from "./SeasonalityPanel";
import SeasonalityResearch from "./SeasonalityResearch";
import JPMCollarPanel from "./JPMCollarPanel";
import VolCalendarPanel from "./VolCalendarPanel";

type WindowKey = "w4" | "w13" | "w52";

type AxisReading = {
  id: string;
  label: string;
  axis: "risk" | "growth" | "cyclical" | "size";
  theme: string;
  roc: number;
  z: number;
  persistenceDays: number;
  stage: "early" | "mid" | "mature";
  fresh: boolean;
  durable: boolean;
  direction: 1 | -1 | 0;
  evidence: string;
  window: WindowKey;
  conviction: number;
};

type AxisSummary = {
  axis: "risk" | "growth" | "cyclical" | "size";
  label: string;
  compositeZ: number;
  direction: 1 | -1 | 0;
  stage: "early" | "mid" | "mature";
  conviction: number;
  narrative: string;
  readings: AxisReading[];
};

type Theme = {
  kind: "fresh" | "durable";
  headline: string;
  body: string;
  evidence: string[];
  axis: AxisReading["axis"];
  conviction: number;
};

type ConstituentRow = {
  symbol: string;
  rocPct: number;
  rocZ: number;
  rsi: number | null;
  close: number;
  pctFrom20DMA: number | null;
  pctFrom52WHigh: number | null;
  role: "leader" | "mid" | "laggard";
  rank: number;
  catchupScore: number;
  catchupCandidate: boolean;
  note: string;
};

type LeadersLaggards = {
  axis: AxisReading["axis"];
  cohortLabel: string;
  cohortDescription: string;
  leaders: ConstituentRow[];
  laggards: ConstituentRow[];
  all: ConstituentRow[];
  catchupPicks: ConstituentRow[];
};

type RegimeResponse = {
  capturedAt: number;
  window: WindowKey;
  headline: string;
  narrative: string;
  axes: AxisSummary[];
  freshThemes: Theme[];
  durableThemes: Theme[];
  leadersLaggards: Record<AxisReading["axis"], LeadersLaggards>;
  warnings: string[];
  universeSize: number;
  missingSymbols: string[];
};

const WINDOW_LABELS: Record<WindowKey, string> = {
  w4: "4 weeks",
  w13: "13 weeks",
  w52: "52 weeks",
};

export default function RegimePanel() {
  const [window, setWindow] = useState<WindowKey>("w4");
  const { data, isLoading, isError, error } = useQuery<RegimeResponse>({
    queryKey: ["/api/regime", window],
    queryFn: async () =>
      apiRequest("GET", `/api/regime?window=${window}`).then((r) => r.json()),
    refetchInterval: 30 * 60_000,
    staleTime: 15 * 60_000,
  });

  if (isLoading) return <RegimeSkeleton />;

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm font-medium">Regime data unavailable</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {(error as Error)?.message ?? "Could not build the rotation snapshot."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="regime-panel">
      {/* Reactive sector web — the new "market constellation" view */}
      <SectorWeb />

      {/* WEF narrative→ticker basket mapper */}
      <WefThemePanel />

      {/* Window selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Regime Rotation Tracker</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Where capital is flowing · {data.universeSize} symbols · z-scored vs 2-year baseline
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border bg-card/50 p-1">
          {(["w4", "w13", "w52"] as WindowKey[]).map((w) => (
            <Button
              key={w}
              variant={window === w ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setWindow(w)}
              data-testid={`button-window-${w}`}
            >
              {WINDOW_LABELS[w]}
            </Button>
          ))}
        </div>
      </div>

      {/* Masthead narrative card — the "lede" of the research note */}
      <Card className="relative overflow-hidden border-primary/20" data-testid="card-masthead">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent pointer-events-none" />
        <CardContent className="relative p-6 md:p-8">
          <div className="mb-3 flex items-center gap-2">
            <Sparkle className="h-4 w-4 text-primary" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">This week's read</span>
          </div>
          <h1 className="text-xl font-semibold leading-tight md:text-[1.5rem]" data-testid="text-headline">
            {data.headline}
          </h1>
          <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-foreground/90" data-testid="text-narrative">
            {data.narrative}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {data.axes
              .filter((a) => a.direction !== 0)
              .sort((a, b) => b.conviction - a.conviction)
              .slice(0, 4)
              .map((a) => (
                <AxisChip key={a.axis} axis={a} />
              ))}
          </div>
        </CardContent>
      </Card>

      {/* Fresh + Durable columns */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ThemeColumn
          title="Fresh this week"
          subtitle="New ±2σ breaches in the last 5 trading days"
          themes={data.freshThemes}
          tone="fresh"
          icon={<Sparkle className="h-4 w-4" />}
          emptyText="No fresh ±2σ breaches. Leadership is in continuation mode."
        />
        <ThemeColumn
          title="Durable trends"
          subtitle="Same-direction |z|≥1.5 running 6+ weeks"
          themes={data.durableThemes}
          tone="durable"
          icon={<Clock className="h-4 w-4" />}
          emptyText="No durable regimes. Rotations are all early stage."
        />
      </div>

      {/* Catch-up opportunities strip — laggards with oversold RSI + big gap to leader */}
      <CatchupStrip leadersLaggards={data.leadersLaggards} />

      {/* Four-axis detail grid — each card expands to full Leaders/Laggards breakdown */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">The four axes</h3>
            <p className="text-xs text-muted-foreground">
              Click any axis to expand. Leaders show where money is flowing · laggards flag catch-up buy candidates.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {data.axes.map((a) => (
            <AxisCard
              key={a.axis}
              axis={a}
              leadersLaggards={data.leadersLaggards[a.axis]}
            />
          ))}
        </div>
      </div>

      {/* Methodology + warnings */}
      <Card>
        <CardContent className="p-5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Methodology</div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            For each axis pair (e.g. SPY/TLT), we compute the ratio's rolling rate-of-change over the selected window,
            then z-score against its own trailing 2-year distribution. A z of +2 means the current rotation is in the
            top-2.5% of the past two years. <span className="text-foreground">Fresh</span> = newly crossed ±2σ in last
            5 days. <span className="text-foreground">Durable</span> = held same-sign |z|≥1.5 for 30+ trading days (6+ weeks).
            Stage is based on persistence: ≤10 days early · 11-30 days mid · 30+ days mature. Data from Yahoo 2Y daily
            closes, 30-min server-side cache.
          </p>
          {data.warnings.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-amber-500">
                <AlertTriangle className="h-3 w-3" />
                <span className="text-[11px] uppercase tracking-wider">Warnings</span>
              </div>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ================================================================
          NEW SECTIONS: Seasonality, JPM Collar, Vol Event Calendar
          ================================================================ */}
      <Separator className="my-2" />

      {/* Section: Seasonality Research (any ticker) */}
      <div>
        <ErrorBoundary label="Seasonality Research">
          <SeasonalityResearch />
        </ErrorBoundary>
      </div>

      {/* Section: Seasonality */}
      <div>
        <div className="mb-4 flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Seasonality</h2>
          <span className="text-xs text-muted-foreground">20-year avg monthly &amp; weekly return patterns</span>
        </div>
        <ErrorBoundary label="Seasonality">
          <SeasonalityPanel />
        </ErrorBoundary>
      </div>

      {/* Section: JPM Collar + Vol Calendar side-by-side on lg */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* JPM Collar */}
        <div>
          <div className="mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">JPM Collar</h2>
            <span className="text-xs text-muted-foreground">JHEQX quarterly hedge · SPX reference lines</span>
          </div>
          <ErrorBoundary label="JPM Collar">
            <JPMCollarPanel />
          </ErrorBoundary>
        </div>

        {/* Vol Event Calendar */}
        <div>
          <div className="mb-4 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-violet-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">Vol Event Calendar</h2>
            <span className="text-xs text-muted-foreground">OPEX · VIX exp · FOMC · CPI · NFP · next 90 days</span>
          </div>
          <ErrorBoundary label="Vol Calendar">
            <VolCalendarPanel />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

// ---- subcomponents ----

function AxisChip({ axis }: { axis: AxisSummary }) {
  const { tone, Icon, label } = axisBadgeProps(axis);
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${tone}`}
      data-testid={`chip-axis-${axis.axis}`}
    >
      <Icon className="h-3 w-3" />
      <span className="font-medium">{label}</span>
      <span className="text-[10px] opacity-70">·</span>
      <span className="text-[10px] opacity-80">{describeStage(axis.stage)}</span>
    </div>
  );
}

function AxisCard({
  axis,
  leadersLaggards,
}: {
  axis: AxisSummary;
  leadersLaggards?: LeadersLaggards;
}) {
  const [expanded, setExpanded] = useState(false);
  const dirSign = axis.direction === 1 ? "+" : axis.direction === -1 ? "−" : "0";
  const dirColor =
    axis.direction === 1 ? "text-emerald-500"
    : axis.direction === -1 ? "text-red-500"
    : "text-muted-foreground";
  const stageColor =
    axis.stage === "early" ? "text-sky-400"
    : axis.stage === "mid" ? "text-amber-400"
    : "text-fuchsia-400";
  const catchupCount = leadersLaggards?.catchupPicks.length ?? 0;
  return (
    <Card data-testid={`axis-card-${axis.axis}`} className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{axis.label}</div>
            <CardTitle className={`mt-0.5 text-base font-semibold ${dirColor}`}>
              {axis.direction === 0
                ? "Balanced"
                : axis.direction > 0
                  ? titleCaseFromCopy(axisPositiveCopy(axis.axis))
                  : titleCaseFromCopy(axisNegativeCopy(axis.axis))
              }
            </CardTitle>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm">
              <span className={dirColor}>{dirSign}{Math.abs(axis.compositeZ).toFixed(2)}σ</span>
            </div>
            <div className={`text-[10px] uppercase tracking-wider ${stageColor}`}>{describeStage(axis.stage)}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <p className="text-xs leading-relaxed text-foreground/85">{axis.narrative}</p>

        {/* conviction bar */}
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <GaugeIcon className="h-3 w-3" />
              Conviction
            </span>
            <span className="font-mono">{axis.conviction}/100</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all ${convictionBg(axis.conviction, axis.direction)}`}
              style={{ width: `${axis.conviction}%` }}
            />
          </div>
        </div>

        {/* underlying readings */}
        <Separator />
        <div className="space-y-2">
          {axis.readings.map((r) => (
            <div key={r.id} className="rounded-md border border-border/60 bg-card/40 p-2.5">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[11px] text-foreground/80">{r.label}</div>
                <div className="flex items-center gap-1.5">
                  {r.fresh && (
                    <Badge variant="outline" className="border-primary/50 bg-primary/10 text-[9px] text-primary">
                      fresh
                    </Badge>
                  )}
                  {r.durable && (
                    <Badge variant="outline" className="border-fuchsia-500/50 bg-fuchsia-500/10 text-[9px] text-fuchsia-400">
                      durable
                    </Badge>
                  )}
                  <span className={`font-mono text-[11px] ${r.z >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {r.z >= 0 ? "+" : ""}{r.z.toFixed(2)}σ
                  </span>
                </div>
              </div>
              <div className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{r.evidence}</div>
            </div>
          ))}
        </div>

        {/* Leaders/Laggards expander */}
        {leadersLaggards && (
          <>
            <Separator />
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="group flex w-full items-center justify-between rounded-md border border-border/60 bg-card/30 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-card/60"
              data-testid={`toggle-leaders-laggards-${axis.axis}`}
            >
              <div className="flex items-center gap-2">
                {expanded
                  ? <ChevronDown className="h-3.5 w-3.5 text-primary" />
                  : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />}
                <span className="text-[11px] font-medium uppercase tracking-wider">
                  Leaders · Laggards · Catch-up
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {catchupCount > 0 && (
                  <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-[9px] font-mono text-amber-400">
                    <Zap className="mr-0.5 h-2.5 w-2.5" />
                    {catchupCount} buy
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {leadersLaggards.all.length} names
                </span>
              </div>
            </button>
            {expanded && <LeadersLaggardsTable ll={leadersLaggards} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LeadersLaggardsTable({ ll }: { ll: LeadersLaggards }) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/40 p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">{ll.cohortDescription}</p>

      {/* Leaders */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5">
          <Crown className="h-3 w-3 text-emerald-400" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            Leaders
          </span>
        </div>
        <div className="space-y-1">
          {ll.leaders.map((c) => (
            <ConstituentRowCard key={c.symbol} c={c} tone="leader" />
          ))}
        </div>
      </div>

      {/* Laggards */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5">
          <Target className="h-3 w-3 text-amber-400" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
            Laggards
          </span>
          <span className="text-[10px] text-muted-foreground">
            (sorted by catch-up score)
          </span>
        </div>
        <div className="space-y-1">
          {ll.laggards.map((c) => (
            <ConstituentRowCard key={c.symbol} c={c} tone="laggard" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ConstituentRowCard({
  c,
  tone,
}: {
  c: ConstituentRow;
  tone: "leader" | "laggard";
}) {
  const rocColor = c.rocPct >= 0 ? "text-emerald-400" : "text-red-400";
  const rsiColor =
    c.rsi == null ? "text-muted-foreground"
    : c.rsi >= 70 ? "text-red-400"
    : c.rsi <= 35 ? "text-amber-400"
    : "text-foreground/70";
  return (
    <div
      className={`rounded-sm border px-2 py-1.5 ${
        c.catchupCandidate
          ? "border-amber-500/40 bg-amber-500/5"
          : tone === "leader"
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-border/60 bg-card/30"
      }`}
      data-testid={`constituent-${c.symbol}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold text-foreground">{c.symbol}</span>
          <span className="text-[10px] text-muted-foreground">#{c.rank}</span>
          {c.catchupCandidate && (
            <Badge variant="outline" className="border-amber-500/60 bg-amber-500/15 font-mono text-[8.5px] text-amber-300">
              <Zap className="mr-0.5 h-2 w-2" />
              catch-up {c.catchupScore}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className={rocColor}>
            {c.rocPct >= 0 ? "+" : ""}{c.rocPct.toFixed(1)}%
          </span>
          {c.rsi != null && (
            <span className={rsiColor}>
              RSI {c.rsi.toFixed(0)}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{c.note}</div>
    </div>
  );
}

function CatchupStrip({
  leadersLaggards,
}: {
  leadersLaggards: Record<AxisReading["axis"], LeadersLaggards>;
}) {
  // Flatten all catch-up picks across axes, tag with axis, sort by score desc.
  const axes: AxisReading["axis"][] = ["risk", "growth", "cyclical", "size"];
  const picks: Array<ConstituentRow & { axis: AxisReading["axis"] }> = [];
  for (const a of axes) {
    const ll = leadersLaggards?.[a];
    if (!ll) continue;
    for (const p of ll.catchupPicks) picks.push({ ...p, axis: a });
  }
  // Dedupe by symbol, keep highest score.
  const bySym = new Map<string, ConstituentRow & { axis: AxisReading["axis"] }>();
  for (const p of picks) {
    const prev = bySym.get(p.symbol);
    if (!prev || p.catchupScore > prev.catchupScore) bySym.set(p.symbol, p);
  }
  const top = Array.from(bySym.values()).sort((a, b) => b.catchupScore - a.catchupScore).slice(0, 6);

  return (
    <Card className="border-amber-500/30 bg-gradient-to-br from-amber-500/5 via-transparent to-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-amber-400">
              <Zap className="h-4 w-4" />
              Catch-up candidates
            </CardTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Laggard ETFs with oversold RSI, below 20DMA, and a wide return gap vs their cohort leader.
              Higher score = better mean-reversion setup.
            </p>
          </div>
          <Badge variant="outline" className="font-mono text-[10px] text-amber-400">
            {top.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
            No qualifying catch-up setups right now. All laggards are either too trend-weak or not oversold enough.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {top.map((p) => (
              <div
                key={p.symbol}
                className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5"
                data-testid={`catchup-${p.symbol}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm font-semibold text-amber-300">{p.symbol}</span>
                    <Badge variant="outline" className="border-amber-500/50 bg-amber-500/15 font-mono text-[9px] text-amber-300">
                      {p.catchupScore}/100
                    </Badge>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {axisShortLabel(p.axis)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 font-mono text-[10px]">
                  <span className={p.rocPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                    {p.rocPct >= 0 ? "+" : ""}{p.rocPct.toFixed(1)}%
                  </span>
                  {p.rsi != null && (
                    <span className={p.rsi <= 35 ? "text-amber-400" : "text-muted-foreground"}>
                      RSI {p.rsi.toFixed(0)}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{p.note}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function axisShortLabel(a: AxisReading["axis"]): string {
  switch (a) {
    case "risk": return "Risk";
    case "growth": return "Growth/Value";
    case "cyclical": return "Cyclical";
    case "size": return "Size";
  }
}

function ThemeColumn({
  title, subtitle, themes, tone, icon, emptyText,
}: {
  title: string;
  subtitle: string;
  themes: Theme[];
  tone: "fresh" | "durable";
  icon: React.ReactNode;
  emptyText: string;
}) {
  const borderClass = tone === "fresh" ? "border-primary/30" : "border-fuchsia-500/30";
  const accentClass = tone === "fresh" ? "text-primary" : "text-fuchsia-400";

  return (
    <Card className={`h-full ${borderClass}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className={`flex items-center gap-2 text-sm font-semibold ${accentClass}`}>
              {icon}
              {title}
            </CardTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">
            {themes.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {themes.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          <div className="space-y-3">
            {themes.map((t, i) => (
              <article
                key={i}
                className="group rounded-md border border-border bg-card/40 p-3.5 transition-colors hover:border-border/80"
                data-testid={`theme-${tone}-${i}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <ChevronRight className={`h-3 w-3 ${accentClass}`} />
                    <h4 className="text-sm font-semibold leading-tight">{t.headline}</h4>
                  </div>
                  <Badge variant="outline" className="shrink-0 font-mono text-[9px]">
                    {t.conviction}
                  </Badge>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t.body}</p>
                <div className="mt-2.5 border-l-2 border-border/60 pl-2.5">
                  {t.evidence.map((ev, j) => (
                    <div key={j} className="font-mono text-[11px] leading-snug text-foreground/80">
                      {ev}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RegimeSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-8 w-60" />
      </div>
      <Skeleton className="h-48 w-full" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56" />)}
      </div>
    </div>
  );
}

// ---- helpers ----

function describeStage(s: "early" | "mid" | "mature"): string {
  if (s === "early") return "early";
  if (s === "mid") return "mid-cycle";
  return "mature";
}

function axisPositiveCopy(axis: AxisReading["axis"]): string {
  switch (axis) {
    case "risk": return "risk-on";
    case "growth": return "growth-led";
    case "cyclical": return "cyclical-led";
    case "size": return "small-cap-led";
  }
}
function axisNegativeCopy(axis: AxisReading["axis"]): string {
  switch (axis) {
    case "risk": return "risk-off";
    case "growth": return "value-led";
    case "cyclical": return "defensive-led";
    case "size": return "large-cap-led";
  }
}
function titleCaseFromCopy(copy: string): string {
  return copy
    .split("-")
    .map((w) => w === "on" || w === "off" || w === "led" ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

function axisBadgeProps(a: AxisSummary): { tone: string; Icon: typeof TrendingUp; label: string } {
  const pos = a.direction > 0;
  const zero = a.direction === 0;
  const copy = a.direction > 0 ? axisPositiveCopy(a.axis) : axisNegativeCopy(a.axis);
  const tone = zero
    ? "border-border/60 bg-card/50 text-muted-foreground"
    : pos
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
      : "border-red-500/40 bg-red-500/10 text-red-400";
  return { tone, Icon: pos ? TrendingUp : zero ? Activity : TrendingDown, label: zero ? a.label.toLowerCase() : copy };
}

function convictionBg(c: number, dir: 1 | -1 | 0): string {
  if (dir === 0) return "bg-muted-foreground/40";
  if (dir > 0) return c >= 60 ? "bg-emerald-500" : c >= 30 ? "bg-emerald-500/70" : "bg-emerald-500/40";
  return c >= 60 ? "bg-red-500" : c >= 30 ? "bg-red-500/70" : "bg-red-500/40";
}
