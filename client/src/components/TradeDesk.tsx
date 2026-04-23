// Trade Desk — SPX/SPY/VIX intraday charts + pivots + gamma map + squeeze + playbook
// Bloomberg dark aesthetic: near-black background, amber accents, monospace data,
// tight rows. Zero-decorative — every pixel carries information.

import { useState, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { GammaStructure } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmt } from "@/lib/format";
import {
  LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer,
  Tooltip as RTooltip, CartesianGrid, Area, AreaChart,
} from "recharts";
import {
  Activity, Target, Zap, Gauge as GaugeIcon, TrendingUp, TrendingDown,
  AlertTriangle, Crosshair, LineChart as LineIcon, ChevronDown, ChevronUp,
  Copy, Check,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// --- Types matching /api/trade-desk payload ----------------------------------

type Bar = { t: number; o: number | null; h: number | null; l: number | null; c: number | null; v: number | null };
type QuoteSeries = {
  symbol: string;
  displayName: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  bars: Bar[];
  interval: string;
  range: string;
  asOf: number;
};
type ClassicPivots = { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number };
type CamarillaPivots = { h1: number; h2: number; h3: number; h4: number; h5: number; h6: number; l1: number; l2: number; l3: number; l4: number; l5: number; l6: number; pp: number };
type PivotBundle = {
  symbol: string;
  priorOhlc: { t: number; o: number; h: number; l: number; c: number };
  classic: ClassicPivots;
  fibonacci: ClassicPivots;
  camarilla: CamarillaPivots;
  range: number;
  midpoint: number;
};

type GammaMap = {
  zeroGamma: number | null;
  distanceToFlip: number | null;
  distanceToFlipPct: number | null;
  hedgeZones: Array<{ strike: number; gex: number; zone: string; note: string }>;
  regime: "positive" | "negative" | "neutral";
  netGex: number;
  narrative: string;
  gexCrossoverStrike?: number | null;
  gammaProfile?: { spot: number; gex: number }[];
};

type Squeeze = {
  score: number;
  probability: number;
  direction: "up" | "down" | "neutral";
  label: string;
  triggers: string[];
  riskFactors: string[];
  timeHorizon: string;
};

type Playbook = {
  headline: string;
  bias: "bullish" | "bearish" | "neutral" | "volatile";
  conviction: "high" | "moderate" | "low";
  summary: string;
  scenarios: Array<{ name: string; trigger: string; target: string; invalidation: string; odds: "primary" | "secondary" | "tail" }>;
  keyLevels: { resistance: Array<{ level: number; label: string }>; support: Array<{ level: number; label: string }> };
  gameplan: string[];
};

type TradeDeskPayload = {
  capturedAt: number;
  range: "1d" | "5d";
  interval: string;
  quotes: { spx: QuoteSeries | null; spy: QuoteSeries | null; vix: QuoteSeries | null };
  pivots: { spx: PivotBundle | null; spy: PivotBundle | null; vix: PivotBundle | null };
  gammaMap: GammaMap;
  squeeze: Squeeze;
  playbook: Playbook;
  composite: { score: number; label: string };
  voicesBias: { score: number; sampleSize: number } | null;
};

type PivotSystem = "classic" | "fib" | "cam" | "all";

// -----------------------------------------------------------------------------

export default function TradeDesk() {
  const [range, setRange] = useState<"1d" | "5d">("1d");
  const [pivotSystem, setPivotSystem] = useState<PivotSystem>("all");

  const { data, isLoading, isError, error } = useQuery<TradeDeskPayload>({
    queryKey: ["/api/trade-desk", range],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/trade-desk?range=${range}`);
      return r.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  if (isLoading) return <TradeDeskSkeleton />;

  if (isError || !data) {
    return (
      <Card className="border-amber-500/30">
        <CardContent className="p-6 text-center">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-500" />
          <div className="text-sm text-muted-foreground">
            Trade Desk feed unreachable: {(error as Error)?.message || "unknown error"}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Command bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/20 bg-gradient-to-r from-amber-500/5 to-transparent px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-amber-500" />
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">Trade Desk</div>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <div className="font-mono text-[11px] text-muted-foreground">
            LIVE · {fmt.ts(data.capturedAt)} · {data.interval} bars
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ToggleGroup
            label="Window"
            value={range}
            onChange={(v) => setRange(v as "1d" | "5d")}
            options={[{ v: "1d", l: "1D" }, { v: "5d", l: "5D" }]}
          />
          <ToggleGroup
            label="Pivots"
            value={pivotSystem}
            onChange={(v) => setPivotSystem(v as PivotSystem)}
            options={[
              { v: "all", l: "All" },
              { v: "classic", l: "Classic" },
              { v: "fib", l: "Fib" },
              { v: "cam", l: "Cam" },
            ]}
          />
        </div>
      </div>

      {/* Playbook + Squeeze header */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <PlaybookCard playbook={data.playbook} />
        </div>
        <div className="lg:col-span-4">
          <SqueezeDial squeeze={data.squeeze} />
        </div>
      </section>

      {/* Three intraday charts with pivot overlays */}
      <section className="space-y-4">
        <IntradayChart
          title="S&P 500 Index"
          symbol="^GSPC"
          quote={data.quotes.spx}
          pivots={data.pivots.spx}
          system={pivotSystem}
          accent="amber"
          range={range}
        />
        <IntradayChart
          title="SPDR S&P 500 ETF"
          symbol="SPY"
          quote={data.quotes.spy}
          pivots={data.pivots.spy}
          system={pivotSystem}
          accent="emerald"
          range={range}
        />
        <IntradayChart
          title="CBOE Volatility Index"
          symbol="^VIX"
          quote={data.quotes.vix}
          pivots={data.pivots.vix}
          system={pivotSystem}
          accent="rose"
          range={range}
          inverted
        />
      </section>

      {/* Gamma Map */}
      <section>
        <GammaMapCard gammaMap={data.gammaMap} spot={data.quotes.spy?.price ?? null} />
      </section>

      {/* EOD Play Maker */}
      <section>
        <EodPlayMaker />
      </section>

      {/* Footnote */}
      <footer className="pb-6 pt-2 text-[10px] leading-relaxed text-muted-foreground">
        <Separator className="mb-3" />
        <div>
          Pivot math from prior session OHLC. Classic floor-trader, Fibonacci (0.382/0.618/1.000), Camarilla (1.1/12 → 1.1×1.168).
          Gamma map derived from CBOE SPY chain (0-45 DTE) — delayed. Squeeze indicator is rules-based from dealer gamma,
          VIX term, SKEW, and wall distance; not ML. Not investment advice.
        </div>
      </footer>
    </div>
  );
}

// --- Subcomponents -----------------------------------------------------------

function ToggleGroup({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ v: string; l: string }>;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex rounded-sm border border-border bg-card/50 p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            data-testid={`toggle-${label.toLowerCase()}-${o.v}`}
            className={
              "px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors " +
              (value === o.v
                ? "rounded-sm bg-amber-500/20 text-amber-500"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

// Playbook Card
function PlaybookCard({ playbook }: { playbook: Playbook }) {
  const biasColor =
    playbook.bias === "bullish" ? "text-emerald-500 border-emerald-500/40 bg-emerald-500/10"
    : playbook.bias === "bearish" ? "text-red-500 border-red-500/40 bg-red-500/10"
    : playbook.bias === "volatile" ? "text-amber-500 border-amber-500/40 bg-amber-500/10"
    : "text-muted-foreground border-border bg-muted/30";

  return (
    <Card className="border-amber-500/20" data-testid="card-playbook">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex-1 min-w-[260px]">
            <div className="mb-1 flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">AI Daily Playbook</span>
            </div>
            <h2 className="font-mono text-lg font-semibold leading-tight text-foreground" data-testid="text-playbook-headline">
              {playbook.headline}
            </h2>
          </div>
          <div className="flex gap-2">
            <Badge variant="outline" className={`font-mono text-[10px] uppercase ${biasColor}`} data-testid="badge-bias">
              {playbook.bias}
            </Badge>
            <Badge variant="outline" className="border-border bg-card font-mono text-[10px] uppercase text-muted-foreground">
              {playbook.conviction} conviction
            </Badge>
          </div>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground" data-testid="text-playbook-summary">
          {playbook.summary}
        </p>

        {/* Key levels */}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <LevelColumn title="Resistance" items={playbook.keyLevels.resistance} tone="bear" />
          <LevelColumn title="Support"    items={playbook.keyLevels.support}    tone="bull" />
        </div>

        {/* Scenarios */}
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">Scenarios</div>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
            {playbook.scenarios.map((s, i) => (
              <div
                key={i}
                className={
                  "rounded-sm border p-2.5 text-[11px] leading-snug " +
                  (s.odds === "primary" ? "border-amber-500/30 bg-amber-500/5"
                    : s.odds === "secondary" ? "border-border bg-card/30"
                    : "border-border/50 bg-card/10 opacity-80")
                }
                data-testid={`scenario-${i}`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <div className="font-mono font-semibold text-foreground">{s.name}</div>
                  <Badge variant="outline" className="border-border bg-card font-mono text-[9px] uppercase">
                    {s.odds}
                  </Badge>
                </div>
                <Row k="trigger" v={s.trigger} />
                <Row k="target" v={s.target} />
                <Row k="invalid" v={s.invalidation} />
              </div>
            ))}
          </div>
        </div>

        {/* Gameplan */}
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">Gameplan</div>
          <ul className="space-y-1.5">
            {playbook.gameplan.map((g, i) => (
              <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-foreground" data-testid={`gameplan-${i}`}>
                <span className="mt-0.5 font-mono text-amber-500">▸</span>
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="mt-0.5 flex gap-1.5">
      <span className="w-14 flex-shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{k}</span>
      <span className="flex-1 text-foreground/90">{v}</span>
    </div>
  );
}

function LevelColumn({
  title, items, tone,
}: { title: string; items: Array<{ level: number; label: string }>; tone: "bull" | "bear" }) {
  const color = tone === "bear" ? "text-red-400" : "text-emerald-400";
  const arrow = tone === "bear" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />;
  return (
    <div className="rounded-sm border border-border bg-card/30 p-2.5">
      <div className={`mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}>
        {arrow} {title}
      </div>
      <div className="space-y-0.5">
        {items.slice(0, 6).map((lv, i) => (
          <div key={i} className="flex items-center justify-between font-mono text-[11px]">
            <span className="text-muted-foreground">{lv.label}</span>
            <span className={`tabular-nums ${color}`}>{lv.level.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Squeeze Dial
function SqueezeDial({ squeeze }: { squeeze: Squeeze }) {
  // Map score -100..+100 to angle -90..+90 (semi-circle).
  const angle = Math.max(-100, Math.min(100, squeeze.score)) * 0.9; // degrees
  const color =
    squeeze.direction === "up" && Math.abs(squeeze.score) > 40 ? "text-emerald-500"
    : squeeze.direction === "down" && Math.abs(squeeze.score) > 40 ? "text-red-500"
    : "text-amber-500";

  return (
    <Card className="h-full border-amber-500/20" data-testid="card-squeeze">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <GaugeIcon className="h-4 w-4 text-amber-500" />
          Gamma Squeeze Indicator
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative mx-auto h-[130px] w-full max-w-[240px]">
          {/* semi-circle gauge */}
          <svg viewBox="0 0 200 110" className="h-full w-full">
            {/* gradient arc */}
            <defs>
              <linearGradient id="sq-gradient" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="50%" stopColor="#f59e0b" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
            </defs>
            <path
              d="M 15 100 A 85 85 0 0 1 185 100"
              fill="none"
              stroke="url(#sq-gradient)"
              strokeWidth="10"
              opacity="0.35"
            />
            <path
              d="M 15 100 A 85 85 0 0 1 185 100"
              fill="none"
              stroke="url(#sq-gradient)"
              strokeWidth="2"
            />
            {/* tick marks */}
            {[-90, -60, -30, 0, 30, 60, 90].map((a, i) => {
              const rad = (a - 90) * (Math.PI / 180);
              const x1 = 100 + 85 * Math.cos(rad);
              const y1 = 100 + 85 * Math.sin(rad);
              const x2 = 100 + 78 * Math.cos(rad);
              const y2 = 100 + 78 * Math.sin(rad);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1" className="text-muted-foreground" />;
            })}
            {/* needle */}
            <g transform={`rotate(${angle} 100 100)`}>
              <line x1="100" y1="100" x2="100" y2="25" stroke="currentColor" strokeWidth="2.5" className={color} strokeLinecap="round" />
              <circle cx="100" cy="100" r="5" fill="currentColor" className={color} />
            </g>
          </svg>
          {/* label placeholder below semi-circle; no labels in SVG to keep it clean */}
        </div>

        <div className="mt-1 text-center">
          <div className={`font-mono text-2xl font-bold tabular-nums ${color}`} data-testid="text-squeeze-score">
            {squeeze.score > 0 ? "+" : ""}{squeeze.score}
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {squeeze.label}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-amber-500">
            {squeeze.probability}% · {squeeze.direction.toUpperCase()} · {squeeze.timeHorizon}
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {squeeze.triggers.length > 0 && (
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-emerald-500">Triggers</div>
              <ul className="space-y-0.5">
                {squeeze.triggers.slice(0, 4).map((t, i) => (
                  <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-foreground/80">
                    <span className="text-emerald-500">+</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {squeeze.riskFactors.length > 0 && (
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-red-400">Risk</div>
              <ul className="space-y-0.5">
                {squeeze.riskFactors.slice(0, 3).map((t, i) => (
                  <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-foreground/80">
                    <span className="text-red-400">−</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Intraday chart with pivot overlays
// -----------------------------------------------------------------------------

type AccentKey = "amber" | "emerald" | "rose";
const ACCENTS: Record<AccentKey, { stroke: string; fill: string; cls: string }> = {
  amber:   { stroke: "#f59e0b", fill: "rgba(245,158,11,0.08)", cls: "text-amber-500" },
  emerald: { stroke: "#10b981", fill: "rgba(16,185,129,0.08)", cls: "text-emerald-500" },
  rose:    { stroke: "#fb7185", fill: "rgba(251,113,133,0.08)", cls: "text-rose-400" },
};

function IntradayChart({
  title, symbol, quote, pivots, system, accent, range, inverted,
}: {
  title: string;
  symbol: string;
  quote: QuoteSeries | null;
  pivots: PivotBundle | null;
  system: PivotSystem;
  accent: AccentKey;
  range: "1d" | "5d";
  inverted?: boolean;
}) {
  const a = ACCENTS[accent];
  const bars = quote?.bars ?? [];

  const chartData = useMemo(() => {
    return bars
      .filter((b) => b.c != null)
      .map((b) => ({
        t: b.t,
        price: b.c,
        high: b.h,
        low: b.l,
        label: new Date(b.t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      }));
  }, [bars]);

  // Collect pivot levels per system
  type LvlLine = { name: string; value: number; color: string; dash: string; intensity: number; showLabel?: boolean };
  const lines: LvlLine[] = useMemo(() => {
    if (!pivots) return [];
    const out: LvlLine[] = [];
    const classicColor = "#60a5fa";  // blue-400
    const fibColor = "#a78bfa";      // violet-400
    const camColor = "#f59e0b";      // amber-500

    if (system === "classic" || system === "all") {
      const p = pivots.classic;
      out.push(
        { name: "PP", value: p.pp, color: classicColor, dash: "3 3", intensity: 0.9 },
        { name: "R1", value: p.r1, color: classicColor, dash: "3 3", intensity: 0.6 },
        { name: "R2", value: p.r2, color: classicColor, dash: "3 3", intensity: 0.45 },
        { name: "R3", value: p.r3, color: classicColor, dash: "3 3", intensity: 0.3 },
        { name: "S1", value: p.s1, color: classicColor, dash: "3 3", intensity: 0.6 },
        { name: "S2", value: p.s2, color: classicColor, dash: "3 3", intensity: 0.45 },
        { name: "S3", value: p.s3, color: classicColor, dash: "3 3", intensity: 0.3 },
      );
    }
    if (system === "fib" || system === "all") {
      const p = pivots.fibonacci;
      out.push(
        { name: "F-R1", value: p.r1, color: fibColor, dash: "2 4", intensity: 0.6 },
        { name: "F-R2", value: p.r2, color: fibColor, dash: "2 4", intensity: 0.5 },
        { name: "F-R3", value: p.r3, color: fibColor, dash: "2 4", intensity: 0.35 },
        { name: "F-S1", value: p.s1, color: fibColor, dash: "2 4", intensity: 0.6 },
        { name: "F-S2", value: p.s2, color: fibColor, dash: "2 4", intensity: 0.5 },
        { name: "F-S3", value: p.s3, color: fibColor, dash: "2 4", intensity: 0.35 },
      );
    }
    if (system === "cam" || system === "all") {
      const p = pivots.camarilla;
      out.push(
        { name: "H3", value: p.h3, color: camColor, dash: "1 0", intensity: 0.85 },
        { name: "H4", value: p.h4, color: camColor, dash: "1 0", intensity: 1.0 },
        { name: "H5", value: p.h5, color: camColor, dash: "4 2", intensity: 0.5 },
        { name: "L3", value: p.l3, color: camColor, dash: "1 0", intensity: 0.85 },
        { name: "L4", value: p.l4, color: camColor, dash: "1 0", intensity: 1.0 },
        { name: "L5", value: p.l5, color: camColor, dash: "4 2", intensity: 0.5 },
      );
    }
    // Label collision avoidance: sort by value, then walk once and hide labels
    // that would stack within ~1.4% of the chart's price range. Priority: keep
    // higher-intensity labels; suppress neighbours. This stops the right-edge
    // label mush when Classic+Fib+Cam are all overlaid.
    if (out.length > 0 && chartData.length > 0) {
      const prices = chartData.map((c) => c.price as number);
      const range = Math.max(...prices) - Math.min(...prices);
      // Minimum spacing between labels, in price units. ~1.4% of range keeps
      // the label list short on tight intraday charts.
      const minGap = Math.max(range * 0.025, range * 0.014);
      const sorted = [...out].sort((a, b) => b.value - a.value); // top-down
      let lastShownValue: number | null = null;
      for (const lv of sorted) {
        if (lastShownValue == null || Math.abs(lv.value - lastShownValue) >= minGap) {
          lv.showLabel = true;
          lastShownValue = lv.value;
        } else {
          lv.showLabel = false;
        }
      }
    }
    return out;
  }, [pivots, system, chartData]);

  // Chart y-domain: include price + visible pivot levels
  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!chartData.length) return undefined;
    const prices = chartData.map((c) => c.price as number);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    // include pivots only if they're within 3% of price (keep chart readable)
    const mid = (min + max) / 2;
    for (const lv of lines) {
      if (Math.abs(lv.value - mid) / mid < 0.035) {
        min = Math.min(min, lv.value);
        max = Math.max(max, lv.value);
      }
    }
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }, [chartData, lines]);

  const chg = quote?.changePct ?? 0;
  // Flip semantics for VIX (negative changePct is "green" for the market)
  const chgTone = inverted
    ? (chg > 0 ? "text-red-500" : chg < 0 ? "text-emerald-500" : "text-muted-foreground")
    : (chg > 0 ? "text-emerald-500" : chg < 0 ? "text-red-500" : "text-muted-foreground");

  return (
    <Card data-testid={`chart-${symbol}`}>
      <CardContent className="p-4">
        {/* Header row */}
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-2">
              <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.18em] ${a.cls}`}>{symbol}</span>
              <span className="text-[11px] text-muted-foreground">{title}</span>
            </div>
            <div className="mt-0.5 flex items-baseline gap-3">
              <span className="font-mono text-2xl font-bold tabular-nums text-foreground" data-testid={`price-${symbol}`}>
                {quote?.price != null ? quote.price.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : "—"}
              </span>
              <span className={`font-mono text-xs tabular-nums ${chgTone}`}>
                {quote?.change != null ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}` : "—"}
                {" "}({fmt.pct(chg, 2)})
              </span>
            </div>
          </div>

          {/* Session stats + pivot quick ref */}
          <div className="flex flex-wrap items-end gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            <MiniStat label="Open" value={quote?.sessionOpen} />
            <MiniStat label="High" value={quote?.sessionHigh} tone="emerald" />
            <MiniStat label="Low"  value={quote?.sessionLow}  tone="red" />
            <MiniStat label="Prev" value={quote?.prevClose} />
            {pivots && (
              <MiniStat label="PP" value={pivots.classic.pp} tone="amber" />
            )}
          </div>
        </div>

        {/* Chart */}
        {chartData.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center rounded-sm border border-dashed border-border text-xs text-muted-foreground">
            No bars returned for this range.
          </div>
        ) : (
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 60, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id={`grad-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={a.stroke} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={a.stroke} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 6" stroke="hsl(var(--border))" strokeOpacity={0.25} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9, fontFamily: "var(--font-mono)" }}
                  stroke="hsl(var(--border))"
                  minTickGap={40}
                  interval={range === "5d" ? 50 : 30}
                />
                <YAxis
                  orientation="right"
                  domain={yDomain as any}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  stroke="hsl(var(--border))"
                  width={55}
                  tickFormatter={(v) => v.toFixed(symbol === "^VIX" ? 2 : 1)}
                />
                <RTooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                  formatter={(v: any) => [typeof v === "number" ? v.toFixed(2) : v, "Price"]}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={a.stroke}
                  strokeWidth={1.5}
                  fill={`url(#grad-${symbol})`}
                  isAnimationActive={false}
                  dot={false}
                />
                {/* Pivot overlays — labels are "NAME PRICE" (e.g. "PP 7083.83")
                    so the user never has to eyeball the Y-axis to decode which
                    dashed line is which. Collision suppression hides labels that
                    would stack; the side-panel list has every level regardless. */}
                {lines.map((lv, i) => {
                  const priceStr = lv.value.toFixed(symbol === "^VIX" ? 2 : 2);
                  return (
                    <ReferenceLine
                      key={i}
                      y={lv.value}
                      stroke={lv.color}
                      strokeOpacity={lv.intensity}
                      strokeDasharray={lv.dash}
                      label={lv.showLabel ? {
                        value: `${lv.name} ${priceStr}`,
                        position: "insideLeft",
                        fill: lv.color,
                        fillOpacity: Math.min(1, lv.intensity + 0.3),
                        fontSize: 9.5,
                        fontWeight: 600,
                        fontFamily: "var(--font-mono)",
                        offset: 6,
                      } : undefined}
                    />
                  );
                })}
                {/* prev close reference */}
                {quote?.prevClose != null && (
                  <ReferenceLine
                    y={quote.prevClose}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="5 5"
                    strokeOpacity={0.5}
                    label={{
                      value: `Prev ${quote.prevClose.toFixed(2)}`,
                      position: "insideTopLeft",
                      fill: "hsl(var(--muted-foreground))",
                      fontSize: 9,
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Full pivot table — every level with its price, color-coded by
            system. This is the authoritative reference; the chart labels
            are just a convenience. */}
        {pivots && <PivotTable pivots={pivots} system={system} spot={quote?.price ?? null} symbol={symbol} />}

        {/* Legend + prior OHLC */}
        {pivots && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[9.5px] font-mono text-muted-foreground">
            {(system === "classic" || system === "all") && (
              <span><span className="inline-block h-0.5 w-3 bg-blue-400 align-middle" /> Classic</span>
            )}
            {(system === "fib" || system === "all") && (
              <span><span className="inline-block h-0.5 w-3 bg-violet-400 align-middle" /> Fibonacci</span>
            )}
            {(system === "cam" || system === "all") && (
              <span><span className="inline-block h-0.5 w-3 bg-amber-500 align-middle" /> Camarilla</span>
            )}
            <span className="ml-auto">Prior: O {pivots.priorOhlc.o.toFixed(2)} H {pivots.priorOhlc.h.toFixed(2)} L {pivots.priorOhlc.l.toFixed(2)} C {pivots.priorOhlc.c.toFixed(2)}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, tone = "neutral" }: { label: string; value: number | null | undefined; tone?: "amber" | "emerald" | "red" | "neutral" }) {
  const cls =
    tone === "amber" ? "text-amber-500"
    : tone === "emerald" ? "text-emerald-500"
    : tone === "red" ? "text-red-500"
    : "text-foreground";
  return (
    <div className="flex flex-col items-end">
      <span>{label}</span>
      <span className={`font-mono text-[11px] tabular-nums ${cls}`}>
        {value != null && isFinite(value) ? value.toFixed(2) : "—"}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Gamma Map — per-strike GEX ladder + zero-gamma + hedge zones
// -----------------------------------------------------------------------------

// Gamma Profile Curve — Perfiliev-style hypothetical-spot vs. total-gamma chart
function GammaProfileCurve({
  profile, spot, zeroGamma,
}: {
  profile: { spot: number; gex: number }[];
  spot: number | null;
  zeroGamma: number | null;
}) {
  const data = useMemo(
    () => profile.map((p) => ({ spot: p.spot, gexBn: p.gex / 1e9 })),
    [profile],
  );
  if (!data.length) return null;
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.gexBn)));

  return (
    <div className="mb-4 rounded-sm border border-border bg-card/30 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <LineIcon className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">
            Gamma Profile · total γ vs. hypothetical spot
          </span>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          Perfiliev · 60 levels · 0.9 · S → 1.1 · S
        </span>
      </div>
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gex-pos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gex-neg" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#ef4444" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 6" stroke="hsl(var(--border))" strokeOpacity={0.25} vertical={false} />
            <XAxis
              dataKey="spot"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9, fontFamily: "var(--font-mono)" }}
              stroke="hsl(var(--border))"
              tickFormatter={(v) => v.toFixed(0)}
              minTickGap={50}
            />
            <YAxis
              orientation="right"
              domain={[-maxAbs * 1.08, maxAbs * 1.08]}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9, fontFamily: "var(--font-mono)" }}
              stroke="hsl(var(--border))"
              width={44}
              tickFormatter={(v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "B"}
            />
            <RTooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 4,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
              labelFormatter={(v: any) => `Spot ${Number(v).toFixed(2)}`}
              formatter={(v: any) => [
                (v >= 0 ? "+$" : "−$") + Math.abs(Number(v)).toFixed(2) + "B / 1%",
                "Net GEX",
              ]}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeOpacity={0.5} />
            {/* Two areas: positive in green, negative in red. Recharts doesn't split a single
                area by sign natively, so we render two series: one clipped to >=0, one to <=0. */}
            <Area
              type="monotone"
              dataKey={(d: any) => Math.max(0, d.gexBn)}
              stroke="#10b981"
              strokeWidth={1.5}
              fill="url(#gex-pos)"
              isAnimationActive={false}
              dot={false}
              name="+γ"
            />
            <Area
              type="monotone"
              dataKey={(d: any) => Math.min(0, d.gexBn)}
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="url(#gex-neg)"
              isAnimationActive={false}
              dot={false}
              name="−γ"
            />
            {zeroGamma != null && (
              <ReferenceLine
                x={zeroGamma}
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                label={{
                  value: `Zero-γ ${zeroGamma.toFixed(2)}`,
                  position: "insideTopRight",
                  fill: "#f59e0b",
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                }}
              />
            )}
            {spot != null && (
              <ReferenceLine
                x={spot}
                stroke="hsl(var(--foreground))"
                strokeWidth={1}
                strokeOpacity={0.6}
                label={{
                  value: `Spot ${spot.toFixed(2)}`,
                  position: "insideBottomRight",
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[9.5px] font-mono text-muted-foreground">
        <span><span className="inline-block h-1.5 w-3 bg-emerald-500/60 align-middle" /> Positive γ (dealers dampen)</span>
        <span><span className="inline-block h-1.5 w-3 bg-red-500/60 align-middle" /> Negative γ (dealers amplify)</span>
        <span><span className="inline-block h-0.5 w-3 bg-amber-500 align-middle" /> Zero-γ flip</span>
      </div>
    </div>
  );
}

function GammaMapCard({ gammaMap, spot }: { gammaMap: GammaMap; spot: number | null }) {
  // We show hedge zones as horizontal strikes with bars.
  const zones = gammaMap.hedgeZones.slice().sort((a, b) => b.strike - a.strike);
  const maxAbs = Math.max(1, ...zones.map((z) => Math.abs(z.gex))); // for bar scale

  const zoneLabel: Record<string, string> = {
    "call-wall": "CALL WALL",
    "put-wall": "PUT WALL",
    "secondary-resistance": "RES",
    "secondary-support": "SUP",
    "local-extreme": "EXT",
  };
  const zoneColor: Record<string, string> = {
    "call-wall": "text-red-400",
    "put-wall": "text-emerald-400",
    "secondary-resistance": "text-red-400/70",
    "secondary-support": "text-emerald-400/70",
    "local-extreme": "text-amber-500",
  };

  const regimeColor =
    gammaMap.regime === "positive" ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/5"
    : gammaMap.regime === "negative" ? "text-red-500 border-red-500/30 bg-red-500/5"
    : "text-amber-500 border-amber-500/30 bg-amber-500/5";

  return (
    <Card data-testid="card-gamma-map">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-amber-500" />
          Gamma Map & Dealer Hedge Zones (SPY)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Status row */}
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <GammaTile label="Regime" valueClass={`border ${regimeColor} rounded-sm`} value={
            <span className="px-1.5 py-0.5 font-mono text-[11px] uppercase">
              {gammaMap.regime === "positive" ? "Positive γ" : gammaMap.regime === "negative" ? "Negative γ" : "Near Flip"}
            </span>
          }/>
          <GammaTile label="Net GEX" value={
            <span className={`font-mono text-sm ${gammaMap.netGex >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {fmt.bn(gammaMap.netGex)}
            </span>
          }/>
          <GammaTile label="Zero-γ Flip" value={
            <span className="font-mono text-sm text-amber-500">
              {gammaMap.zeroGamma != null ? gammaMap.zeroGamma.toFixed(2) : "—"}
            </span>
          }/>
          <GammaTile label="Spot Δ to Flip" value={
            <span className={`font-mono text-sm ${
              gammaMap.distanceToFlip == null ? "text-muted-foreground"
              : gammaMap.distanceToFlip >= 0 ? "text-emerald-500" : "text-red-500"
            }`}>
              {gammaMap.distanceToFlipPct != null ? fmt.pct(gammaMap.distanceToFlipPct, 2) : "—"}
            </span>
          }/>
        </div>

        {/* Narrative */}
        <p className="mb-4 rounded-sm border border-border bg-card/30 p-3 text-[11.5px] leading-relaxed text-muted-foreground" data-testid="text-gamma-narrative">
          {gammaMap.narrative}
        </p>

        {/* Gamma Profile Curve (Perfiliev-style) */}
        {gammaMap.gammaProfile && gammaMap.gammaProfile.length > 0 && (
          <GammaProfileCurve
            profile={gammaMap.gammaProfile}
            spot={spot}
            zeroGamma={gammaMap.zeroGamma}
          />
        )}

        {/* GEX Crossover Strike (legacy — smaller, for reference) */}
        {gammaMap.gexCrossoverStrike != null && (
          <div className="mb-4 flex items-center justify-between rounded-sm border border-border/50 bg-card/20 px-3 py-1.5 text-[10px] font-mono text-muted-foreground">
            <span className="uppercase tracking-wider">GEX Crossover Strike (legacy)</span>
            <span className="tabular-nums text-foreground/70">{gammaMap.gexCrossoverStrike.toFixed(2)}</span>
            <span className="text-[9px] normal-case tracking-normal text-muted-foreground/80">
              strike where cumulative per-strike GEX flips · centroid of positioning
            </span>
          </div>
        )}

        {/* Ladder */}
        <div className="rounded-sm border border-border">
          <div className="grid grid-cols-[70px_1fr_90px_80px] gap-2 border-b border-border bg-card/30 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Strike</span>
            <span>GEX exposure</span>
            <span className="text-right">Zone</span>
            <span className="text-right">Dist</span>
          </div>
          <div className="divide-y divide-border/40">
            {zones.map((z, i) => {
              const barWidth = Math.min(100, (Math.abs(z.gex) / maxAbs) * 100);
              const isCall = z.gex >= 0;
              const distPct = spot ? ((z.strike - spot) / spot) * 100 : 0;
              const isSpotRow = spot && Math.abs(distPct) < 0.05;
              return (
                <div
                  key={i}
                  className={
                    "grid grid-cols-[70px_1fr_90px_80px] items-center gap-2 px-3 py-1.5 text-[11px] " +
                    (isSpotRow ? "bg-amber-500/10" : "")
                  }
                  data-testid={`gamma-row-${z.strike}`}
                >
                  <span className="font-mono tabular-nums text-foreground">{z.strike.toFixed(0)}</span>
                  <div className="flex h-4 w-full items-center">
                    {/* Center axis */}
                    <div className="relative h-full w-full">
                      <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
                      {/* bar */}
                      {isCall ? (
                        <div
                          className="absolute left-1/2 top-0.5 h-3 rounded-sm bg-red-400/60"
                          style={{ width: `${barWidth / 2}%` }}
                        />
                      ) : (
                        <div
                          className="absolute top-0.5 h-3 rounded-sm bg-emerald-400/60"
                          style={{ width: `${barWidth / 2}%`, right: "50%" }}
                        />
                      )}
                    </div>
                  </div>
                  <span className={`text-right font-mono text-[10px] uppercase ${zoneColor[z.zone] ?? "text-muted-foreground"}`}>
                    {zoneLabel[z.zone] ?? z.zone}
                  </span>
                  <span className={`text-right font-mono tabular-nums text-[10.5px] ${
                    distPct >= 0 ? "text-red-400/80" : "text-emerald-400/80"
                  }`}>
                    {distPct >= 0 ? "+" : ""}{distPct.toFixed(2)}%
                  </span>
                </div>
              );
            })}
            {/* spot marker row if no zone is near spot */}
            {spot && (
              <div className="border-t border-amber-500/30 bg-amber-500/5 px-3 py-1 text-center font-mono text-[10px] uppercase tracking-wider text-amber-500">
                ● Spot {spot.toFixed(2)}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 text-[10px] leading-snug text-muted-foreground">
          Red bars (right) = call-side hedging pressure (resistance — dealers sell shares as spot rises).
          Green bars (left) = put-side (support — dealers buy as spot falls). Zero-γ flip is where net dealer hedging sign changes.
        </div>
      </CardContent>
    </Card>
  );
}

function GammaTile({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-sm border border-border bg-card/30 px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 ${valueClass ?? ""}`}>{value}</div>
    </div>
  );
}

// --- Pivot Table -------------------------------------------------------------
// Full reference table: every pivot level with its price, grouped by system.
// Highlights the level closest to current spot (emerald) so traders can
// immediately see what's in play.

function PivotTable({
  pivots,
  system,
  spot,
  symbol,
}: {
  pivots: PivotBundle;
  system: PivotSystem;
  spot: number | null;
  symbol: string;
}) {
  // Build flat arrays of {name, price} per system
  const classicRows = [
    { name: "R3", price: pivots.classic.r3 },
    { name: "R2", price: pivots.classic.r2 },
    { name: "R1", price: pivots.classic.r1 },
    { name: "PP", price: pivots.classic.pp },
    { name: "S1", price: pivots.classic.s1 },
    { name: "S2", price: pivots.classic.s2 },
    { name: "S3", price: pivots.classic.s3 },
  ];
  const fibRows = [
    { name: "F-R3", price: pivots.fibonacci.r3 },
    { name: "F-R2", price: pivots.fibonacci.r2 },
    { name: "F-R1", price: pivots.fibonacci.r1 },
    { name: "F-PP", price: pivots.fibonacci.pp },
    { name: "F-S1", price: pivots.fibonacci.s1 },
    { name: "F-S2", price: pivots.fibonacci.s2 },
    { name: "F-S3", price: pivots.fibonacci.s3 },
  ];
  const camRows = [
    { name: "H4", price: pivots.camarilla.h4 },
    { name: "H3", price: pivots.camarilla.h3 },
    { name: "H2", price: pivots.camarilla.h2 },
    { name: "H1", price: pivots.camarilla.h1 },
    { name: "CPP", price: pivots.camarilla.pp },
    { name: "L1", price: pivots.camarilla.l1 },
    { name: "L2", price: pivots.camarilla.l2 },
    { name: "L3", price: pivots.camarilla.l3 },
    { name: "L4", price: pivots.camarilla.l4 },
  ];

  // Find closest level across all systems (for emerald highlight)
  const allRows = [...classicRows, ...fibRows, ...camRows];
  const closest = spot != null
    ? allRows.reduce((best, r) => (Math.abs(r.price - spot) < Math.abs(best.price - spot) ? r : best), allRows[0])
    : null;

  const decimals = symbol === "VIX" ? 2 : 2;

  const renderRow = (r: { name: string; price: number }, accentClass: string) => {
    const isClosest = closest && r.name === closest.name && r.price === closest.price;
    const above = spot != null && r.price > spot;
    const distance = spot != null ? r.price - spot : null;
    const distancePct = spot != null && spot !== 0 ? ((r.price - spot) / spot) * 100 : null;
    return (
      <div
        key={r.name}
        className={`flex items-center justify-between rounded-sm border px-2 py-1 ${
          isClosest
            ? "border-emerald-500/50 bg-emerald-500/10"
            : "border-border/60 bg-card/30"
        }`}
        data-testid={`pivot-row-${symbol}-${r.name}`}
      >
        <span className={`text-[10px] font-semibold tracking-wider ${accentClass}`}>{r.name}</span>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[11px] tabular-nums text-foreground">
            {r.price.toFixed(decimals)}
          </span>
          {distance != null && distancePct != null && (
            <span
              className={`font-mono text-[8.5px] tabular-nums ${
                above ? "text-emerald-500/70" : "text-red-500/70"
              }`}
            >
              {above ? "+" : ""}
              {distancePct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
    );
  };

  const showClassic = system === "classic" || system === "all";
  const showFib = system === "fib" || system === "all";
  const showCam = system === "cam" || system === "all";

  const colCount = (showClassic ? 1 : 0) + (showFib ? 1 : 0) + (showCam ? 1 : 0);
  const gridCls =
    colCount === 3 ? "md:grid-cols-3"
    : colCount === 2 ? "md:grid-cols-2"
    : "md:grid-cols-1";

  return (
    <div className="mt-3 rounded-md border border-border bg-card/20 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {symbol} Pivot Levels · Prior-Day Basis
        </div>
        {spot != null && (
          <div className="font-mono text-[10px] tabular-nums text-foreground">
            Spot <span className="text-emerald-500">{spot.toFixed(decimals)}</span>
          </div>
        )}
      </div>
      <div className={`grid grid-cols-1 gap-2 ${gridCls}`}>
        {showClassic && (
          <div className="space-y-1">
            <div className="mb-1 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-blue-400">
              <span className="inline-block h-0.5 w-3 bg-blue-400" />
              Classic
            </div>
            {classicRows.map((r) => renderRow(r, "text-blue-400"))}
          </div>
        )}
        {showFib && (
          <div className="space-y-1">
            <div className="mb-1 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-violet-400">
              <span className="inline-block h-0.5 w-3 bg-violet-400" />
              Fibonacci
            </div>
            {fibRows.map((r) => renderRow(r, "text-violet-400"))}
          </div>
        )}
        {showCam && (
          <div className="space-y-1">
            <div className="mb-1 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-amber-500">
              <span className="inline-block h-0.5 w-3 bg-amber-500" />
              Camarilla
            </div>
            {camRows.map((r) => renderRow(r, "text-amber-500"))}
          </div>
        )}
      </div>
      <div className="mt-2 text-[9px] text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-sm border border-emerald-500/50 bg-emerald-500/10 align-middle" />{" "}
        Level closest to spot · % shows distance from spot
      </div>
    </div>
  );
}

// ─── Bat SVG icon ──────────────────────────────────────────────────────────
function BatIconSvg({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 50" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-label="BATCAVE" className={className}>
      <path d="M50,10 C45,15 40,10 35,12 C28,8 20,5 12,10 C8,15 5,20 8,25 C12,22 18,22 20,18 C22,22 20,28 25,30 C30,28 35,32 40,30 C45,33 50,30 50,35 C50,30 55,33 60,30 C65,32 70,28 75,30 C80,28 78,22 80,18 C82,22 88,22 92,25 C95,20 92,15 88,10 C80,5 72,8 65,12 C60,10 55,15 50,10 Z" />
    </svg>
  );
}

// ─── Copy button helper ────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded border border-border/50 bg-card/40 px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-amber-500/40 hover:text-amber-400"
      data-testid="button-copy-output"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ─── Model output panel ────────────────────────────────────────────────────
function ModelOutputPanel({
  label, modelSlug, content, error, isLoading,
}: {
  label: string;
  modelSlug: string;
  content: string | null;
  error: string | null;
  isLoading: boolean;
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">{label}</span>
          <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">{modelSlug}</Badge>
        </div>
        {content && <CopyButton text={content} />}
      </div>
      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
        </div>
      )}
      {error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-[11px] text-rose-400">
          {error}
        </div>
      )}
      {content && !isLoading && (
        <div className="prose prose-invert prose-xs max-w-none rounded border border-border/40 bg-card/30 p-3 text-[11px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
      {!content && !error && !isLoading && (
        <div className="rounded border border-dashed border-border/40 bg-card/20 p-4 text-center text-[11px] text-muted-foreground">
          Output appears here after generation.
        </div>
      )}
    </div>
  );
}

// ─── EOD Play Maker form field helper ─────────────────────────────────────
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ─── EOD Play Maker ─────────────────────────────────────────────────────────
function EodPlayMaker() {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Form state — pre-filled with sensible defaults / locked weekly targets
  const [spx, setSpx] = useState("7100");
  const [vix, setVix] = useState("18.5");
  const [iv, setIv] = useState("1.2");
  const [qscore, setQscore] = useState("35");
  const [gex, setGex] = useState("+2.1");
  const [callWall, setCallWall] = useState("7150");
  const [putWall, setPutWall] = useState("7000");
  const [zeroGamma, setZeroGamma] = useState("7075");
  const [hvl, setHvl] = useState("7100");
  const [gammaFlip, setGammaFlip] = useState("7075");
  // Locked weekly targets
  const [upside, setUpside] = useState("7140");
  const [downside, setDownside] = useState("6950");
  const [t2up, setT2up] = useState("7270");
  const [t2down, setT2down] = useState("6885");
  const [mopex, setMopex] = useState("7025");
  const [vanna, setVanna] = useState("7089");
  const [zomma, setZomma] = useState("7070");
  const [charm, setCharm] = useState("7128");
  const [negGamma, setNegGamma] = useState("7100");
  const [upperVomma, setUpperVomma] = useState("7265");
  const [lowerVomma, setLowerVomma] = useState("6960");
  const [pcRatio, setPcRatio] = useState("0.85");
  const [opex, setOpex] = useState(false);
  const [notes, setNotes] = useState("");

  // Compute regime from qscore
  const qNum = parseFloat(qscore) || 0;
  const regimeBucket = qNum < 30 ? "Pinned" : qNum < 60 ? "Mixed" : "Fragile";

  // Result state
  const [result, setResult] = useState<{ claude: string | null; gpt: string | null; errors: { claude: string | null; gpt: string | null } } | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        spx, vix, iv, qscore, gex, callWall, putWall, zeroGamma, hvl, gammaFlip,
        upside, downside, t2up, t2down, mopex, vanna, zomma, charm, negGamma, upperVomma, lowerVomma,
        pcRatio, opex, notes,
      };
      const r = await apiRequest("POST", "/api/eod-setup", body);
      return r.json();
    },
    onSuccess: (data) => setResult(data),
  });

  const inputCls = "h-7 font-mono text-xs bg-card/40 border-border/60";

  return (
    <div className="rounded-lg border border-amber-500/20 bg-gradient-to-br from-amber-500/5 via-transparent to-transparent" data-testid="eod-play-maker">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between px-4 py-3"
        onClick={() => setIsCollapsed((v) => !v)}
        data-testid="button-eod-toggle"
      >
        <div className="flex items-center gap-2">
          <BatIconSvg className="h-5 w-5 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-amber-400">
            EOD 0DTE SPX PLAY MAKER — BATCAVE
          </span>
          <Badge variant="outline" className="text-[9px] text-amber-500/60 border-amber-500/30">
            Claude + GPT
          </Badge>
        </div>
        {isCollapsed ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-4 space-y-4">
          <Separator className="mb-1" />

          {/* Form */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {/* Market state */}
            <div className="space-y-2">
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-amber-400 mb-1">Market State</div>
              <FieldRow label="SPX Spot">
                <Input value={spx} onChange={(e) => setSpx(e.target.value)} className={inputCls} data-testid="input-spx" />
              </FieldRow>
              <FieldRow label="VIX">
                <Input value={vix} onChange={(e) => setVix(e.target.value)} className={inputCls} data-testid="input-vix" />
              </FieldRow>
              <FieldRow label="1D IV %">
                <Input value={iv} onChange={(e) => setIv(e.target.value)} className={inputCls} data-testid="input-iv" />
              </FieldRow>
              <FieldRow label="Q-Score">
                <div className="flex items-center gap-2">
                  <Input value={qscore} onChange={(e) => setQscore(e.target.value)} className={inputCls + " flex-1"} data-testid="input-qscore" />
                  <Badge variant="outline" className={`shrink-0 text-[9px] ${
                    qNum < 30 ? "border-emerald-500/40 text-emerald-400" :
                    qNum < 60 ? "border-amber-500/40 text-amber-400" :
                    "border-rose-500/40 text-rose-400"
                  }`}>{regimeBucket}</Badge>
                </div>
              </FieldRow>
              <FieldRow label="P/C Ratio">
                <Input value={pcRatio} onChange={(e) => setPcRatio(e.target.value)} className={inputCls} data-testid="input-pc-ratio" />
              </FieldRow>
              <FieldRow label="OPEX Today">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={opex} onChange={(e) => setOpex(e.target.checked)} className="accent-amber-500" data-testid="checkbox-opex" />
                  <span className="text-[10px] text-muted-foreground">{opex ? "YES — size down 30-50%" : "No"}</span>
                </label>
              </FieldRow>
            </div>

            {/* Dealer positioning */}
            <div className="space-y-2">
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-amber-400 mb-1">Dealer Positioning</div>
              <FieldRow label="Total GEX ($B)">
                <Input value={gex} onChange={(e) => setGex(e.target.value)} className={inputCls} placeholder="+2.1" data-testid="input-gex" />
              </FieldRow>
              <FieldRow label="Call Wall">
                <Input value={callWall} onChange={(e) => setCallWall(e.target.value)} className={inputCls} data-testid="input-call-wall" />
              </FieldRow>
              <FieldRow label="Put Wall">
                <Input value={putWall} onChange={(e) => setPutWall(e.target.value)} className={inputCls} data-testid="input-put-wall" />
              </FieldRow>
              <FieldRow label="Zero Gamma">
                <Input value={zeroGamma} onChange={(e) => setZeroGamma(e.target.value)} className={inputCls} data-testid="input-zero-gamma" />
              </FieldRow>
              <FieldRow label="HVL">
                <Input value={hvl} onChange={(e) => setHvl(e.target.value)} className={inputCls} data-testid="input-hvl" />
              </FieldRow>
              <FieldRow label="Gamma Flip">
                <Input value={gammaFlip} onChange={(e) => setGammaFlip(e.target.value)} className={inputCls} data-testid="input-gamma-flip" />
              </FieldRow>
            </div>

            {/* Weekly targets */}
            <div className="space-y-2">
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-amber-400 mb-1">Weekly Targets (Locked)</div>
              <FieldRow label="Upside">
                <Input value={upside} onChange={(e) => setUpside(e.target.value)} className={inputCls} data-testid="input-upside" />
              </FieldRow>
              <FieldRow label="Downside">
                <Input value={downside} onChange={(e) => setDownside(e.target.value)} className={inputCls} data-testid="input-downside" />
              </FieldRow>
              <FieldRow label="T2 Up">
                <Input value={t2up} onChange={(e) => setT2up(e.target.value)} className={inputCls} data-testid="input-t2up" />
              </FieldRow>
              <FieldRow label="T2 Down">
                <Input value={t2down} onChange={(e) => setT2down(e.target.value)} className={inputCls} data-testid="input-t2down" />
              </FieldRow>
              <FieldRow label="MOPEX">
                <Input value={mopex} onChange={(e) => setMopex(e.target.value)} className={inputCls} data-testid="input-mopex" />
              </FieldRow>
              <FieldRow label="VANNA">
                <Input value={vanna} onChange={(e) => setVanna(e.target.value)} className={inputCls} data-testid="input-vanna" />
              </FieldRow>
              <FieldRow label="ZOMMA">
                <Input value={zomma} onChange={(e) => setZomma(e.target.value)} className={inputCls} data-testid="input-zomma" />
              </FieldRow>
              <FieldRow label="CHARM">
                <Input value={charm} onChange={(e) => setCharm(e.target.value)} className={inputCls} data-testid="input-charm" />
              </FieldRow>
              <FieldRow label="NEG γ">
                <Input value={negGamma} onChange={(e) => setNegGamma(e.target.value)} className={inputCls} data-testid="input-neg-gamma" />
              </FieldRow>
              <FieldRow label="Upper Vomma">
                <Input value={upperVomma} onChange={(e) => setUpperVomma(e.target.value)} className={inputCls} data-testid="input-upper-vomma" />
              </FieldRow>
              <FieldRow label="Lower Vomma">
                <Input value={lowerVomma} onChange={(e) => setLowerVomma(e.target.value)} className={inputCls} data-testid="input-lower-vomma" />
              </FieldRow>
            </div>
          </div>

          {/* Notes */}
          <div>
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Trader Notes</div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Current tape observations, catalyst, anything relevant to the setup..."
              className="min-h-[60px] text-xs font-mono bg-card/40 border-border/60"
              data-testid="input-notes"
            />
          </div>

          {/* Generate button */}
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="w-full h-9 text-xs font-semibold uppercase tracking-wider bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40"
            variant="outline"
            data-testid="button-generate-eod"
          >
            <BatIconSvg className="h-4 w-4 mr-2" />
            {mutation.isPending ? "Generating Brief..." : "Generate EOD Brief"}
          </Button>

          {/* Error */}
          {mutation.isError && (
            <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-400">
              Request failed: {(mutation.error as Error)?.message ?? "Unknown error"}
            </div>
          )}

          {/* Output columns */}
          {(result || mutation.isPending) && (
            <div className="flex flex-col gap-4 md:flex-row" data-testid="eod-output">
              <ModelOutputPanel
                label="CLAUDE"
                modelSlug="claude_sonnet_4_6"
                content={result?.claude ?? null}
                error={result?.errors?.claude ?? null}
                isLoading={mutation.isPending}
              />
              <ModelOutputPanel
                label="GPT"
                modelSlug="gpt_5_1"
                content={result?.gpt ?? null}
                error={result?.errors?.gpt ?? null}
                isLoading={mutation.isPending}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Skeleton ----------------------------------------------------------------

function TradeDeskSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-full" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Skeleton className="h-64 lg:col-span-8" />
        <Skeleton className="h-64 lg:col-span-4" />
      </div>
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
