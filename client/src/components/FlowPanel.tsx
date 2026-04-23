// FlowPanel.tsx — Put/Call flow ratio dashboard panel.
// Renders:
//   1. Aggregate gauge (big read: combined PCR + zone badge)
//   2. Intraday sparkline of combined PCR (last ~20 min)
//   3. Index row: SPY QQQ IWM VIX tiles
//   4. Mag 7 row: AAPL MSFT NVDA GOOGL META AMZN TSLA tiles
//   5. [NEW] Intraday call/put volume chart with P/C ratio over time
//
// Polls /api/flow every 10s.
// Compact variant (FlowStrip) for the Chart tab.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Area, ComposedChart,
} from "recharts";
import { FlowAlertsPanel } from "./FlowAlertsPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

interface IntradayVolSample {
  t: number;
  timeLabel: string;
  callVolume: number;
  putVolume: number;
  pcRatio: number | null;
}

interface IntradayFlowTicker {
  symbol: string;
  label: string;
  series: IntradayVolSample[];
  currentCallVol: number;
  currentPutVol: number;
  currentPcr: number | null;
  isEstimated: boolean;
}

interface IntradayFlowResponse {
  tickers: IntradayFlowTicker[];
  asOf: string;
  marketOpen: boolean;
  estimated: boolean;
}

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

function fmtVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

// Mini inline SVG sparkline for intraday combined P/C.
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
  const base = { min: 0.5, max: 1.5 };
  const ys = series.map((s) => s.combined).filter((v) => Number.isFinite(v));
  const yMin = ys.length ? Math.min(base.min, ...ys) : base.min;
  const yMax = ys.length ? Math.max(base.max, ...ys) : base.max;
  const pad = 4;
  const innerW = width - pad * 2 - (showAxis ? 24 : 0);
  const leftPad = pad;
  const scaleY = (v: number) => {
    const t = (v - yMin) / Math.max(0.001, yMax - yMin);
    return height - pad - t * (height - pad * 2);
  };
  const xStep = ys.length > 1 ? innerW / (ys.length - 1) : 0;
  const xOf = (i: number) => leftPad + i * xStep;

  const yTop = pad;
  const yBot = height - pad;
  const yBullTop = Math.max(scaleY(0.75), yTop);
  const yBearBot = Math.min(scaleY(1.05), yBot);
  const neutralY = scaleY(1.0);
  const hasData = ys.length > 0;
  const last = hasData ? series[series.length - 1] : null;
  const lastColor = last
    ? last.combined > 1.05 ? "#f43f5e" : last.combined < 0.75 ? "#10b981" : "#f59e0b"
    : "#6b7280";

  const path = hasData
    ? series.map((s, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(2)} ${scaleY(s.combined).toFixed(2)}`).join(" ")
    : "";
  const areaPath = hasData && ys.length > 1
    ? `${path} L ${xOf(ys.length - 1).toFixed(2)} ${yBot} L ${xOf(0).toFixed(2)} ${yBot} Z`
    : "";

  return (
    <svg width={width} height={height} className="overflow-visible">
      <rect x={leftPad} y={yTop} width={innerW} height={Math.max(0, yBullTop - yTop)} fill="#10b981" opacity={0.08} />
      <rect x={leftPad} y={yBullTop} width={innerW} height={Math.max(0, yBearBot - yBullTop)} fill="#f59e0b" opacity={0.08} />
      <rect x={leftPad} y={yBearBot} width={innerW} height={Math.max(0, yBot - yBearBot)} fill="#f43f5e" opacity={0.08} />
      <line x1={leftPad} y1={scaleY(0.75)} x2={leftPad + innerW} y2={scaleY(0.75)} stroke="#10b981" strokeOpacity={0.4} strokeDasharray="2 3" strokeWidth={0.75} />
      <line x1={leftPad} y1={scaleY(1.05)} x2={leftPad + innerW} y2={scaleY(1.05)} stroke="#f43f5e" strokeOpacity={0.4} strokeDasharray="2 3" strokeWidth={0.75} />
      <line x1={leftPad} y1={neutralY} x2={leftPad + innerW} y2={neutralY} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.35} strokeDasharray="3 3" strokeWidth={0.75} />
      {hasData && (
        <>
          {areaPath && <path d={areaPath} fill={lastColor} fillOpacity={0.12} />}
          <path d={path} fill="none" stroke={lastColor} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={xOf(ys.length - 1)} cy={scaleY(last!.combined)} r={3} fill={lastColor} stroke="hsl(var(--background))" strokeWidth={1} />
        </>
      )}
      {showAxis && (
        <>
          <text x={leftPad + innerW + 3} y={scaleY(yMax) + 3} fontSize={8} fill="hsl(var(--muted-foreground))" opacity={0.7}>{yMax.toFixed(2)}</text>
          <text x={leftPad + innerW + 3} y={neutralY + 3} fontSize={8} fill="hsl(var(--muted-foreground))" opacity={0.7}>1.00</text>
          <text x={leftPad + innerW + 3} y={scaleY(yMin) + 3} fontSize={8} fill="hsl(var(--muted-foreground))" opacity={0.7}>{yMin.toFixed(2)}</text>
          {hasData && (
            <text x={xOf(ys.length - 1) - 2} y={scaleY(last!.combined) - 6} textAnchor="end" fontSize={9} fill={lastColor} fontWeight={600}>
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
    <div className={`flex flex-col gap-1 rounded-md border ${c.border} ${c.bg} p-2`} data-testid={`flow-tile-${tick.symbol}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider">{tick.label}</span>
        {priceChange != null && (
          <span className={`font-mono text-[9px] tabular-nums ${priceChange > 0 ? "text-emerald-400" : priceChange < 0 ? "text-rose-400" : "text-muted-foreground"}`}>
            {priceChange > 0 ? "+" : ""}{priceChange.toFixed(2)}%
          </span>
        )}
      </div>
      <div className={`font-mono text-lg font-bold tabular-nums ${c.text}`}>{fmtPcr(tick.pcrVolume)}</div>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>P {(tick.putVol / 1000).toFixed(0)}k</span>
        <span>·</span>
        <span>C {(tick.callVol / 1000).toFixed(0)}k</span>
        <span>·</span>
        <span>OI {fmtPcr(tick.pcrOI)}</span>
      </div>
    </div>
  );
}

// ─── Intraday Volume Chart ────────────────────────────────────────────────────
function IntradayVolChart({ ticker, estimated }: { ticker: IntradayFlowTicker; estimated: boolean }) {
  const series = ticker.series;
  if (!series.length) return (
    <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
      No intraday data yet — accumulating samples…
    </div>
  );

  const maxVol = Math.max(...series.map((s) => Math.max(s.callVolume, s.putVolume)), 1);

  // Tooltip
  const CustomTip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const s = payload[0]?.payload;
    if (!s) return null;
    return (
      <div className="rounded-lg border border-border bg-popover p-2 text-xs shadow-lg">
        <div className="mb-1 font-semibold">{s.timeLabel}</div>
        <div className="flex justify-between gap-4">
          <span className="text-emerald-400">Calls</span>
          <span className="font-mono text-emerald-300">{fmtVol(s.callVolume)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-rose-400">Puts</span>
          <span className="font-mono text-rose-300">{fmtVol(s.putVolume)}</span>
        </div>
        {s.pcRatio != null && (
          <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-border/50">
            <span className="text-muted-foreground">P/C ratio</span>
            <span className={`font-mono ${s.pcRatio > 1.05 ? "text-rose-400" : s.pcRatio < 0.75 ? "text-emerald-400" : "text-amber-400"}`}>
              {s.pcRatio.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Stats strip */}
      <div className="flex flex-wrap gap-3 text-[10px]">
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Total Calls</div>
          <div className="font-mono font-semibold text-emerald-400">{fmtVol(ticker.currentCallVol)}</div>
        </div>
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Total Puts</div>
          <div className="font-mono font-semibold text-rose-400">{fmtVol(ticker.currentPutVol)}</div>
        </div>
        <div className="rounded-md border border-border/40 bg-card/40 px-2 py-1">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Current P/C</div>
          <div className={`font-mono font-semibold ${ticker.currentPcr != null && ticker.currentPcr > 1.05 ? "text-rose-400" : ticker.currentPcr != null && ticker.currentPcr < 0.75 ? "text-emerald-400" : "text-amber-400"}`}>
            {fmtPcr(ticker.currentPcr)}
          </div>
        </div>
        <div className="rounded-md border border-border/40 bg-card/40 px-2 py-1">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Direction</div>
          <div className={`font-mono font-semibold flex items-center gap-0.5 ${ticker.currentPcr != null && ticker.currentPcr < 0.75 ? "text-emerald-400" : ticker.currentPcr != null && ticker.currentPcr > 1.05 ? "text-rose-400" : "text-amber-400"}`}>
            {ticker.currentPcr != null && ticker.currentPcr < 0.75
              ? <><TrendingUp className="h-3 w-3" /> BULLISH</>
              : ticker.currentPcr != null && ticker.currentPcr > 1.05
              ? <><TrendingDown className="h-3 w-3" /> BEARISH</>
              : <><Minus className="h-3 w-3" /> NEUTRAL</>
            }
          </div>
        </div>
        {estimated && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-400/70">
            <div className="text-[9px] uppercase tracking-wider">Mode</div>
            <div className="font-mono font-semibold text-[10px]">Estimated dist.</div>
          </div>
        )}
      </div>

      {/* Call / Put volume chart */}
      <div className="h-[200px] sm:h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
            <XAxis
              dataKey="timeLabel"
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v) => fmtVol(v)}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              width={42}
              domain={[0, maxVol * 1.1]}
            />
            <Tooltip content={<CustomTip />} />
            {/* Fill under calls */}
            <Area
              type="monotone"
              dataKey="callVolume"
              stroke="#10b981"
              strokeWidth={2.5}
              fill="#10b981"
              fillOpacity={0.12}
              dot={false}
              name="Calls"
            />
            {/* Fill under puts */}
            <Area
              type="monotone"
              dataKey="putVolume"
              stroke="#ef4444"
              strokeWidth={2.5}
              fill="#ef4444"
              fillOpacity={0.12}
              dot={false}
              name="Puts"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground px-2">
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-emerald-500" /> Calls (cumulative)</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-rose-500" /> Puts (cumulative)</span>
      </div>

      {/* P/C Ratio over time */}
      <div className="h-[120px]">
        <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground px-1">P/C Ratio Over Time</div>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 2, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
            <XAxis
              dataKey="timeLabel"
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 2]}
              tickFormatter={(v) => v.toFixed(1)}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              width={32}
            />
            <Tooltip formatter={(v: any) => [typeof v === "number" ? v.toFixed(2) : "—", "P/C"]} />
            {/* Threshold reference lines */}
            <ReferenceLine y={0.7} stroke="#10b981" strokeDasharray="3 4" strokeWidth={1} opacity={0.5} label={{ value: "0.7 bullish", position: "right", fontSize: 8, fill: "#10b981", opacity: 0.6 }} />
            <ReferenceLine y={1.0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeWidth={1} opacity={0.4} />
            <ReferenceLine y={1.3} stroke="#ef4444" strokeDasharray="3 4" strokeWidth={1} opacity={0.5} label={{ value: "1.3 bearish", position: "right", fontSize: 8, fill: "#ef4444", opacity: 0.6 }} />
            <Line
              type="monotone"
              dataKey="pcRatio"
              stroke="#f59e0b"
              strokeWidth={1.75}
              dot={false}
              connectNulls
              name="P/C"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Intraday flow section wrapper ────────────────────────────────────────────
function IntradayFlowSection() {
  const [selectedTicker, setSelectedTicker] = useState("SPY");

  const { data, isLoading } = useQuery<IntradayFlowResponse>({
    queryKey: ["/api/flow-intraday"],
    queryFn: async () => apiRequest("GET", "/api/flow-intraday").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 55_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading && !data) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const ticker = data.tickers.find((t) => t.symbol === selectedTicker) ?? data.tickers[0];

  return (
    <div className="space-y-3 pt-1">
      {/* Separator */}
      <div className="border-t border-border/40" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Intraday Call/Put Volume</span>
          {!data.marketOpen && (
            <Badge variant="outline" className="text-[9px] text-muted-foreground border-border/50">After Hours</Badge>
          )}
          {data.estimated && (
            <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/40">Estimated Distribution</Badge>
          )}
        </div>
        {/* Ticker pills */}
        <div className="flex gap-1">
          {data.tickers.map((t) => (
            <button
              key={t.symbol}
              onClick={() => setSelectedTicker(t.symbol)}
              data-testid={`flow-intraday-ticker-${t.symbol}`}
              className={[
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold transition",
                selectedTicker === t.symbol
                  ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-300"
                  : "border-border/50 text-muted-foreground hover:border-cyan-500/30",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {ticker && <IntradayVolChart ticker={ticker} estimated={ticker.isEstimated} />}
    </div>
  );
}

export default function FlowPanel({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  const [chainSymbol, setChainSymbol] = useState("SPX");
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
        {/* ─── FLOW ALERTS — Schwab-driven, Flow tab only ─── */}
      <div className="mb-4">
        <FlowAlertsPanel symbol={chainSymbol} onOpenSettings={onOpenSettings} />
      </div>

      {/* Symbol selector for chain */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Chain Symbol</span>
        <Select value={chainSymbol} onValueChange={setChainSymbol}>
          <SelectTrigger className="h-6 w-24 text-[10px]" data-testid="chain-symbol-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="SPX">SPX</SelectItem>
            <SelectItem value="SPY">SPY</SelectItem>
            <SelectItem value="QQQ">QQQ</SelectItem>
            <SelectItem value="IWM">IWM</SelectItem>
          </SelectContent>
        </Select>
      </div>

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

        {/* ─── Intraday Call/Put Volume Chart ─── */}
        <IntradayFlowSection />
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
