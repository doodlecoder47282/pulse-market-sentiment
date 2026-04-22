// SeasonalityPanel.tsx
// Historical seasonality charts — 20yr avg monthly/weekly returns + current year overlay.
// Uses Recharts LineChart with two lines: historical avg (muted) + current year (accent).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, BarChart2 } from "lucide-react";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface SeasonalityTicker {
  symbol: string;
  displayName: string;
  monthly: Array<{ month: number; avgReturn: number; currentYearReturn: number | null }>;
  weekly: Array<{ week: number; avgReturn: number; currentYearReturn: number | null }>;
  lookbackYears: number;
}

interface SeasonalityResponse {
  tickers: SeasonalityTicker[];
  asOf: string;
}

const TICKER_LIST = [
  { symbol: "SPY",  label: "SPY / SPX" },
  { symbol: "QQQ",  label: "QQQ" },
  { symbol: "IWM",  label: "IWM" },
  { symbol: "VIX",  label: "VIX" },
  { symbol: "HYG",  label: "HYG" },
  { symbol: "USO",  label: "USO" },
  { symbol: "GLD",  label: "GLD" },
  { symbol: "SLV",  label: "SLV" },
];

function PanelSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {TICKER_LIST.map((t) => <Skeleton key={t.symbol} className="h-7 w-16 rounded-full" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-52" />
        <Skeleton className="h-52" />
      </div>
    </div>
  );
}

function formatPct(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string | number;
}

function CustomTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border border-border bg-popover p-2.5 text-xs shadow-lg"
      style={{ minWidth: 140 }}
    >
      <div className="mb-1 font-semibold text-foreground">{label}</div>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="font-mono tabular-nums" style={{ color: entry.color }}>
            {entry.value != null ? formatPct(entry.value) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SeasonalityPanel() {
  const [activeTicker, setActiveTicker] = useState("SPY");

  const { data, isLoading, isError } = useQuery<SeasonalityResponse>({
    queryKey: ["/api/seasonality"],
    queryFn: async () => apiRequest("GET", "/api/seasonality").then((r) => r.json()),
    staleTime: 23 * 60 * 60_000, // 23 hr — matches 24hr server cache
    refetchInterval: 24 * 60 * 60_000,
  });

  if (isLoading) return <PanelSkeleton />;

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-400">
        Seasonality data unavailable. Historical data fetches from Yahoo — may be temporarily rate-limited.
      </div>
    );
  }

  const ticker = data.tickers.find((t) => t.symbol === activeTicker) ?? data.tickers[0];
  if (!ticker) return null;

  // Build monthly chart data
  const monthlyData = ticker.monthly.map((m) => ({
    label: MONTH_LABELS[m.month - 1],
    "20yr Avg": m.avgReturn,
    "Current Year": m.currentYearReturn,
  }));

  // Build weekly chart data (show weekly 1-52)
  const weeklyData = ticker.weekly.map((w) => ({
    label: `W${w.week}`,
    "20yr Avg": w.avgReturn,
    "Current Year": w.currentYearReturn,
  }));

  // Current month vs 20yr avg
  const now = new Date();
  const curMonth = now.getMonth(); // 0-indexed
  const curMonthData = ticker.monthly[curMonth];
  const avgThisMonth = curMonthData?.avgReturn ?? 0;
  const currentThisMonth = curMonthData?.currentYearReturn ?? null;

  const isCurAboveAvg = currentThisMonth != null && currentThisMonth > avgThisMonth;

  return (
    <div className="space-y-4" data-testid="seasonality-panel">
      {/* Ticker selector */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="seasonality-ticker-selector">
        {TICKER_LIST.map((t) => (
          <button
            key={t.symbol}
            data-testid={`seasonality-ticker-${t.symbol}`}
            onClick={() => setActiveTicker(t.symbol)}
            className={[
              "rounded-full border px-3 py-1 text-xs font-semibold transition",
              activeTicker === t.symbol
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-300"
                : "border-border/50 text-muted-foreground hover:border-cyan-500/30 hover:text-cyan-200",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {ticker.lookbackYears}yr lookback
        </span>
      </div>

      {/* Current month summary card */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border/60 bg-card/50 px-4 py-2.5 text-sm">
        <div className="text-muted-foreground">
          {MONTH_LABELS[curMonth]} vs 20yr avg
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">20yr:</span>
          <span className={`font-mono tabular-nums font-semibold ${avgThisMonth >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {formatPct(avgThisMonth)}
          </span>
        </div>
        {currentThisMonth != null && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">2026:</span>
            <span className={`font-mono tabular-nums font-semibold ${currentThisMonth >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {formatPct(currentThisMonth)}
            </span>
            {isCurAboveAvg
              ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
              : <TrendingDown className="h-3.5 w-3.5 text-rose-400" />
            }
            <Badge
              variant="outline"
              className={isCurAboveAvg ? "border-emerald-500/50 text-emerald-400 text-[10px]" : "border-rose-500/50 text-rose-400 text-[10px]"}
            >
              {isCurAboveAvg ? "Above avg" : "Below avg"}
            </Badge>
          </div>
        )}
      </div>

      {/* Side-by-side charts */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Monthly chart */}
        <Card className="border-border/60 bg-card/40">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <BarChart2 className="h-3.5 w-3.5" />
              Monthly Seasonality
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => `${v.toFixed(1)}%`}
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                  <Line
                    type="monotone"
                    dataKey="20yr Avg"
                    stroke="#64748b"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 4, fill: "#64748b" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="Current Year"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    activeDot={{ r: 4, fill: "#22d3ee" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center gap-4 px-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-500" /> 20yr avg</span>
              <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-cyan-400" /> Current year</span>
            </div>
          </CardContent>
        </Card>

        {/* Weekly chart */}
        <Card className="border-border/60 bg-card/40">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <BarChart2 className="h-3.5 w-3.5" />
              Weekly Seasonality
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weeklyData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    interval={7}
                  />
                  <YAxis
                    tickFormatter={(v) => `${v.toFixed(1)}%`}
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                  <Line
                    type="monotone"
                    dataKey="20yr Avg"
                    stroke="#64748b"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 4, fill: "#64748b" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="Current Year"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    activeDot={{ r: 4, fill: "#22d3ee" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center gap-4 px-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-500" /> 20yr avg</span>
              <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-cyan-400" /> Current year</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
