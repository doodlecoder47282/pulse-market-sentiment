// FlowPanel.tsx — Put/Call flow ratio dashboard panel.
// Renders:
//   1. Aggregate gauge (big read: combined PCR + zone badge)
//   2. Intraday sparkline of combined PCR (last ~20 min)
//   3. Index row: SPY QQQ IWM VIX tiles
//   4. Mag 7 row: AAPL MSFT NVDA GOOGL META AMZN TSLA tiles
//
// Polls /api/flow every 10s.
// Compact variant (FlowStrip) for the Chart tab.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useMemo } from "react";

type FlowTicker = {
  symbol: string;
  label: string;
  spot: number | null;
  putVol: number;
  callVol: number;
  putOI: number;
  callOI: number;
  pcrVolume: number | null;
  pcrOI: number | null;
  changeFromOpen: number | null;
  zone: "bullish" | "neutral" | "bearish";
  asOf: number;
};

type FlowResponse = {
  provider: "yahoo" | "schwab";
  indexGroup: FlowTicker[];
  mag7Group: FlowTicker[];
  aggregate: {
    indexPcr: number | null;
    mag7Pcr: number | null;
    combinedPcr: number | null;
    zone: "bullish" | "neutral" | "bearish";
  };
  cboe: {
    equityPcr: number | null;
    indexPcr: number | null;
    totalPcr: number | null;
    asOf: number | null;
  };
  intradaySeries: { t: number; combined: number; index: number; mag7: number }[];
  warnings: string[];
  asOf: number;
};

function zoneColor(zone: "bullish" | "neutral" | "bearish") {
  if (zone === "bearish") return {
    text: "text-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/50",
    fill: "#f43f5e",
  };
  if (zone === "bullish") return {
    text: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/50",
    fill: "#10b981",
  };
  return {
    text: "text-amber-300",
    bg: "bg-amber-500/10",
    border: "border-amber-500/50",
    fill: "#f59e0b",
  };
}

function fmtPcr(pcr: number | null): string {
  return pcr == null ? "—" : pcr.toFixed(2);
}

function zoneLabel(zone: "bullish" | "neutral" | "bearish"): string {
  if (zone === "bearish") return "HEDGING / BEARISH";
  if (zone === "bullish") return "CALL-HEAVY / BULLISH";
  return "NEUTRAL";
}

// Mini inline SVG sparkline for intraday combined P/C.
// Fixed Y-domain [0.5 .. 1.5] with zone bands (emerald <0.75 / amber 0.75-1.05 / rose >1.05),
// dashed 1.0 baseline, line path, current-value marker+label, min/max axis ticks.
function PcrSparkline({
  series,
  height = 40,
  width = 240,
  showAxis = false,
}: {
  series: { t: number; combined: number }[];
  height?: number;
  width?: number;
  showAxis?: boolean;
}) {
  // Fixed Y bounds so sparkline never looks flat.
  // Extend if any sample lies outside; else lock to [0.5, 1.5].
  const base = { min: 0.5, max: 1.5 };
  const ys = series.map((s) => s.combined).filter((v) => Number.isFinite(v));
  const yMin = ys.length ? Math.min(base.min, ...ys) : base.min;
  const yMax = ys.length ? Math.max(base.max, ...ys) : base.max;
  const pad = 4;
  const innerW = width - pad * 2 - (showAxis ? 24 : 0); // leave room for right axis label when requested
  const leftPad = pad;
  const scaleY = (v: number) => {
    const t = (v - yMin) / Math.max(0.001, yMax - yMin);
    return height - pad - t * (height - pad * 2);
  };
  const xStep = ys.length > 1 ? innerW / (ys.length - 1) : 0;
  const xOf = (i: number) => leftPad + i * xStep;

  // Zone band Y coords
  const yTop = pad;
  const yBot = height - pad;
  const yBullTop = Math.max(scaleY(0.75), yTop);
  const yBearBot = Math.min(scaleY(1.05), yBot);

  const neutralY = scaleY(1.0);
  const hasData = ys.length > 0;
  const last = hasData ? series[series.length - 1] : null;
  const lastColor = last
    ? last.combined > 1.05
      ? "#f43f5e"
      : last.combined < 0.75
        ? "#10b981"
        : "#f59e0b"
    : "#6b7280";

  const path = hasData
    ? series
        .map((s, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(2)} ${scaleY(s.combined).toFixed(2)}`)
        .join(" ")
    : "";
  // Filled area under the line
  const areaPath =
    hasData && ys.length > 1
      ? `${path} L ${xOf(ys.length - 1).toFixed(2)} ${yBot} L ${xOf(0).toFixed(2)} ${yBot} Z`
      : "";

  return (
    <svg width={width} height={height} className="overflow-visible">
      {/* Zone bands */}
      <rect x={leftPad} y={yTop} width={innerW} height={Math.max(0, yBullTop - yTop)} fill="#10b981" opacity={0.08} />
      <rect x={leftPad} y={yBullTop} width={innerW} height={Math.max(0, yBearBot - yBullTop)} fill="#f59e0b" opacity={0.08} />
      <rect x={leftPad} y={yBearBot} width={innerW} height={Math.max(0, yBot - yBearBot)} fill="#f43f5e" opacity={0.08} />

      {/* Threshold lines */}
      <line x1={leftPad} y1={scaleY(0.75)} x2={leftPad + innerW} y2={scaleY(0.75)} stroke="#10b981" strokeOpacity={0.4} strokeDasharray="2 3" strokeWidth={0.75} />
      <line x1={leftPad} y1={scaleY(1.05)} x2={leftPad + innerW} y2={scaleY(1.05)} stroke="#f43f5e" strokeOpacity={0.4} strokeDasharray="2 3" strokeWidth={0.75} />
      <line x1={leftPad} y1={neutralY} x2={leftPad + innerW} y2={neutralY} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.35} strokeDasharray="3 3" strokeWidth={0.75} />

      {hasData && (
        <>
          {areaPath && <path d={areaPath} fill={lastColor} fillOpacity={0.12} />}
          <path d={path} fill="none" stroke={lastColor} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
          {/* Current marker */}
          <circle cx={xOf(ys.length - 1)} cy={scaleY(last!.combined)} r={3} fill={lastColor} stroke="hsl(var(--background))" strokeWidth={1} />
        </>
      )}

      {/* Axis labels */}
      {showAxis && (
        <>
          <text x={leftPad + innerW + 3} y={scaleY(yMax) + 3} fontSize={8} fill="hsl(var(--muted-foreground))" opacity={0.7}>{yMax.toFixed(2)}</text>
          <text x={leftPad + innerW + 3} y={neutralY + 3} fontSize={8} fill="hsl(var(--muted-foreground))" opacity={0.7}>1.00</text>
          <text x={leftPad + innerW + 3} y={scaleY(yMin) + 3} fontSize={8} fill="hsl(var(--muted-foreground))" opacity={0.7}>{yMin.toFixed(2)}</text>
          {hasData && (
            <text
              x={xOf(ys.length - 1) - 2}
              y={scaleY(last!.combined) - 6}
              textAnchor="end"
              fontSize={9}
              fill={lastColor}
              fontWeight={600}
            >
              {last!.combined.toFixed(2)}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

// Individual ticker tile
function FlowTile({ tick }: { tick: FlowTicker }) {
  const c = zoneColor(tick.zone);
  const priceChange = tick.changeFromOpen;
  return (
    <div
      className={`flex flex-col gap-1 rounded-md border ${c.border} ${c.bg} p-2`}
      data-testid={`flow-tile-${tick.symbol}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider">{tick.label}</span>
        {priceChange != null && (
          <span
            className={`font-mono text-[9px] tabular-nums ${
              priceChange > 0 ? "text-emerald-400" : priceChange < 0 ? "text-rose-400" : "text-muted-foreground"
            }`}
          >
            {priceChange > 0 ? "+" : ""}
            {priceChange.toFixed(2)}%
          </span>
        )}
      </div>
      <div className={`font-mono text-lg font-bold tabular-nums ${c.text}`}>
        {fmtPcr(tick.pcrVolume)}
      </div>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>
          P {(tick.putVol / 1000).toFixed(0)}k
        </span>
        <span>·</span>
        <span>
          C {(tick.callVol / 1000).toFixed(0)}k
        </span>
        <span>·</span>
        <span>OI {fmtPcr(tick.pcrOI)}</span>
      </div>
    </div>
  );
}

export default function FlowPanel() {
  const { data, isLoading, isError } = useQuery<FlowResponse>({
    queryKey: ["/api/flow"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/flow");
      return r.json();
    },
    refetchInterval: 10_000,
    staleTime: 8_000,
    refetchOnWindowFocus: true,
  });

  const color = useMemo(() => zoneColor(data?.aggregate.zone ?? "neutral"), [data?.aggregate.zone]);

  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Put / Call Flow</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-28 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Put/Call flow unavailable.
        </CardContent>
      </Card>
    );
  }

  const agg = data.aggregate;
  const series = data.intradaySeries;

  return (
    <Card data-testid="flow-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-cyan-400" />
            Put / Call Flow Ratio
            <Badge variant="outline" className="ml-1 border-cyan-500/40 text-[9px] text-cyan-300">
              LIVE · 10s
            </Badge>
          </CardTitle>
          <div className="text-[10px] text-muted-foreground">
            Provider: {data.provider.toUpperCase()} · {new Date(data.asOf * 1000).toLocaleTimeString()}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top row: big aggregate read + sparkline */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[auto_1fr_auto]">
          {/* Big combined PCR */}
          <div className={`flex items-center gap-3 rounded-lg border ${color.border} ${color.bg} px-4 py-3`}>
            <div>
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Combined PCR</div>
              <div className={`font-mono text-3xl font-bold tabular-nums ${color.text}`}>
                {fmtPcr(agg.combinedPcr)}
              </div>
            </div>
            <div className="h-8 w-px bg-border/50" />
            <div className="flex flex-col gap-1">
              <Badge variant="outline" className={`${color.border} ${color.text} text-[9px]`}>
                {agg.zone === "bearish" ? <TrendingDown className="mr-1 h-2.5 w-2.5" /> : agg.zone === "bullish" ? <TrendingUp className="mr-1 h-2.5 w-2.5" /> : <Minus className="mr-1 h-2.5 w-2.5" />}
                {zoneLabel(agg.zone)}
              </Badge>
              <div className="flex gap-3 text-[10px] text-muted-foreground">
                <span>Idx <span className="font-mono text-foreground">{fmtPcr(agg.indexPcr)}</span></span>
                <span>Mag7 <span className="font-mono text-foreground">{fmtPcr(agg.mag7Pcr)}</span></span>
              </div>
            </div>
          </div>

          {/* Intraday spark */}
          <div className="flex flex-col justify-center rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Intraday PCR (last {series.length} samples)</span>
              <span className="text-[9px] text-muted-foreground">≈ {Math.round((series.length * 10) / 60)} min</span>
            </div>
            <PcrSparkline series={series} width={360} height={56} showAxis />
          </div>

          {/* Interpretation key */}
          <div className="hidden flex-col justify-center gap-1 text-[9px] text-muted-foreground md:flex">
            <div className="flex items-center gap-1"><span className="h-1.5 w-3 rounded-sm bg-emerald-500" /> &lt; 0.75 bullish</div>
            <div className="flex items-center gap-1"><span className="h-1.5 w-3 rounded-sm bg-amber-500" /> 0.75 – 1.05 neutral</div>
            <div className="flex items-center gap-1"><span className="h-1.5 w-3 rounded-sm bg-rose-500" /> &gt; 1.05 bearish/hedging</div>
          </div>
        </div>

        {/* Index row */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Index</div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {data.indexGroup.map((t) => <FlowTile key={t.symbol} tick={t} />)}
          </div>
        </div>

        {/* Mag 7 row */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mag 7</div>
          <div className="grid grid-cols-3 gap-2 md:grid-cols-7">
            {data.mag7Group.map((t) => <FlowTile key={t.symbol} tick={t} />)}
          </div>
        </div>

        {data.warnings.length > 0 && (
          <div className="text-[9px] text-amber-400/70">
            {data.warnings.join(" · ")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Compact strip for Chart tab
export function FlowStrip() {
  const { data } = useQuery<FlowResponse>({
    queryKey: ["/api/flow"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/flow");
      return r.json();
    },
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  if (!data) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2 backdrop-blur">
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }

  const agg = data.aggregate;
  const color = zoneColor(agg.zone);

  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-md border ${color.border} ${color.bg} px-3 py-2 backdrop-blur`} data-testid="flow-strip">
      <div className="flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-cyan-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">P/C Flow</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`font-mono text-lg font-bold tabular-nums ${color.text}`}>{fmtPcr(agg.combinedPcr)}</span>
        <span className={`text-[9px] font-semibold ${color.text}`}>{zoneLabel(agg.zone)}</span>
      </div>
      <div className="h-5 w-px bg-border/40" />
      <div className="flex gap-2 text-[10px]">
        <span className="text-muted-foreground">Idx <span className={`font-mono ${color.text}`}>{fmtPcr(agg.indexPcr)}</span></span>
        <span className="text-muted-foreground">Mag7 <span className={`font-mono ${color.text}`}>{fmtPcr(agg.mag7Pcr)}</span></span>
      </div>
      <div className="ml-auto">
        <PcrSparkline series={data.intradaySeries} width={140} height={28} />
      </div>
    </div>
  );
}
