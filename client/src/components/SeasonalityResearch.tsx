// SeasonalityResearch.tsx
// "SEASONALITY RESEARCH — ANY TICKER" — free-form ticker search.
// Reuses SeasonalityPanel chart infrastructure pattern.
// Calls /api/seasonality/:symbol?lookback=N

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ComposedChart, AreaChart, LineChart, Line, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  ReferenceArea, BarChart, Bar, Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TrendingUp, TrendingDown, BarChart2, Search, ExternalLink,
  ChevronDown, ChevronUp, Calendar,
} from "lucide-react";

// ─── Types (mirror SeasonalityPanel) ─────────────────────────────────────────
interface SeasonalityBar {
  month?: number;
  week?: number;
  avgReturn: number;
  medianReturn: number;
  winRate: number;
  sampleSize: number;
  best: number;
  worst: number;
  stdDev: number;
  currentYearReturn: number | null;
}

interface OptimalWindow {
  buyDayOfYear: number;
  buyDate: string;
  sellDayOfYear: number;
  sellDate: string;
  geometricAvgReturn: number;
  winRate: number;
  yearsTested: number;
  confidenceLabel: "Excellent" | "Good" | "Fair" | "Weak" | "Insufficient";
}

interface YearlySeasonality {
  dailyCumulativePath: Array<{
    dayOfYear: number;
    avgCumulativeReturn: number;
    stdDev: number;
    frequencyPositive: number;
    currentYearCumulativeReturn: number | null;
  }>;
  fullYearAvg: number;
  fullYearMedian: number;
  fullYearWinRate: number;
  bestYear: { year: number; return: number };
  worstYear: { year: number; return: number };
  presidentialCycleYear: 1 | 2 | 3 | 4;
  presidentialCycleAvg: number | null;
  currentDecadeAvg: number | null;
  optimalWindow: OptimalWindow | null;
  yearsCovered: string[];
  analysisText: string;
}

interface SeasonalityTicker {
  symbol: string;
  displayName: string;
  monthly: SeasonalityBar[];
  weekly: SeasonalityBar[];
  yearly: YearlySeasonality;
  lookbackYears: number;
  strongestMonth: { month: number; avgReturn: number; winRate: number };
  weakestMonth: { month: number; avgReturn: number; winRate: number };
  yearsCovered: string[];
}

interface SeasonalityResponse {
  tickers: SeasonalityTicker[];
  asOf: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const LOOKBACK_OPTIONS = [5, 10, 20] as const;
type LookbackYears = typeof LOOKBACK_OPTIONS[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtPct(v: number, sign = true): string {
  return `${sign && v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function fmtPctShort(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function winRatePct(wr: number): string {
  return `${Math.round(wr * 100)}%`;
}
function confidenceColor(label: string): string {
  if (label === "Excellent") return "text-emerald-400 border-emerald-500/50";
  if (label === "Good") return "text-cyan-400 border-cyan-500/50";
  if (label === "Fair") return "text-amber-400 border-amber-500/50";
  return "text-rose-400 border-rose-500/50";
}
function getMonthTicks(): { index: number; label: string }[] {
  return MONTH_LABELS.map((m, i) => ({
    index: Math.round((i / 12) * 252),
    label: m,
  }));
}
function dayIndexToMonthLabel(dayIdx: number): string {
  const monthIdx = Math.floor((dayIdx / 252) * 12);
  return MONTH_LABELS[Math.min(monthIdx, 11)];
}

// Map symbol to equityclock slug
function toEquityClockSlug(symbol: string): string {
  const s = symbol.toUpperCase();
  const MAP: Record<string, string> = {
    "^GSPC": "sp-500",
    "^SPX": "sp-500",
    "SPY": "spy",
    "QQQ": "qqq",
    "IWM": "iwm",
    "^VIX": "vix",
    "VIX": "vix",
    "GLD": "gld",
    "SLV": "slv",
    "USO": "uso",
    "HYG": "hyg",
    "TLT": "tlt",
    "XLF": "xlf",
    "XLE": "xle",
    "XLK": "xlk",
    "XLV": "xlv",
    "XLU": "xlu",
    "XLB": "xlb",
    "XLP": "xlp",
    "XLI": "xli",
    "XLRE": "xlre",
    "BTC-USD": "btc-usd",
    "ETH-USD": "eth-usd",
    "CL=F": "crude-oil",
    "GC=F": "gold",
    "SI=F": "silver",
    "NG=F": "natural-gas",
    "ZB=F": "us-treasury-bonds",
    "DX=F": "us-dollar",
  };
  if (MAP[s]) return MAP[s];
  // Generic: lowercase, strip special chars
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}

// ─── Tooltips ─────────────────────────────────────────────────────────────────
function YearlyTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const avgEntry = payload.find((p: any) => p.dataKey === "avgReturn");
  const curEntry = payload.find((p: any) => p.dataKey === "currentYear");
  const freqEntry = payload.find((p: any) => p.dataKey === "freqPositive");
  return (
    <div className="rounded-lg border border-border bg-popover p-2.5 text-xs shadow-lg" style={{ minWidth: 180 }}>
      <div className="mb-1.5 font-semibold text-foreground">Day {label}</div>
      {avgEntry && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Avg cumulative</span>
          <span className="font-mono tabular-nums text-slate-300">{fmtPct(avgEntry.value)}</span>
        </div>
      )}
      {curEntry?.value != null && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-cyan-300">YTD</span>
          <span className="font-mono tabular-nums text-cyan-300">{fmtPct(curEntry.value)}</span>
        </div>
      )}
      {freqEntry != null && (
        <div className="flex items-center justify-between gap-4 mt-1">
          <span className="text-muted-foreground">Freq. positive</span>
          <span className="font-mono tabular-nums text-blue-300">{Math.round(freqEntry.value)}%</span>
        </div>
      )}
    </div>
  );
}

function BarTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-border bg-popover p-2.5 text-xs shadow-lg" style={{ minWidth: 200 }}>
      <div className="mb-1.5 font-semibold text-foreground">{label}</div>
      <div className="space-y-0.5">
        <Row label="Avg return" val={fmtPct(p.avgReturn)} color={p.avgReturn >= 0 ? "text-emerald-400" : "text-rose-400"} />
        <Row label="Median" val={fmtPct(p.medianReturn)} color="text-slate-300" />
        <Row label="Win rate" val={winRatePct(p.winRate)} color="text-cyan-300" />
        <Row label="Std dev" val={fmtPct(p.stdDev, false)} color="text-muted-foreground" />
        <Row label="Best" val={fmtPct(p.best)} color="text-emerald-400" />
        <Row label="Worst" val={fmtPct(p.worst)} color="text-rose-400" />
        <Row label="Sample" val={`${p.sampleSize} yrs`} color="text-muted-foreground" />
      </div>
    </div>
  );
}

function Row({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${color}`}>{val}</span>
    </div>
  );
}

function StatChip({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm font-semibold tabular-nums ${color}`}>{val}</div>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function ResearchSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-14" />)}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-28" />
      <Skeleton className="h-40" />
    </div>
  );
}

// ─── Results view ─────────────────────────────────────────────────────────────
function ResearchResults({ ticker, lookback }: { ticker: SeasonalityTicker; lookback: LookbackYears }) {
  const [showAnalysis, setShowAnalysis] = useState(true);
  const yearly = ticker.yearly;
  const opt = yearly.optimalWindow;

  // Downsample path
  const path = yearly.dailyCumulativePath;
  const step = Math.max(1, Math.floor(path.length / 60));
  const chartData = path.filter((_, i) => i % step === 0).map((p) => ({
    day: p.dayOfYear,
    monthLabel: dayIndexToMonthLabel(p.dayOfYear - 1),
    avgReturn: parseFloat(p.avgCumulativeReturn.toFixed(3)),
    bandHigh: parseFloat((p.avgCumulativeReturn + p.stdDev).toFixed(3)),
    bandLow: parseFloat((p.avgCumulativeReturn - p.stdDev).toFixed(3)),
    currentYear: p.currentYearCumulativeReturn != null ? parseFloat(p.currentYearCumulativeReturn.toFixed(3)) : null,
    freqPositive: parseFloat((p.frequencyPositive * 100).toFixed(1)),
  }));

  // Today's position
  const todayIdx = (() => {
    for (let i = chartData.length - 1; i >= 0; i--) {
      if (chartData[i].currentYear != null) return i;
    }
    return -1;
  })();
  const todayDay = todayIdx >= 0 ? chartData[todayIdx].day : null;
  const todayAvg = todayIdx >= 0 ? chartData[todayIdx].avgReturn : null;
  const todayYtd = todayIdx >= 0 ? chartData[todayIdx].currentYear : null;
  const delta = todayAvg != null && todayYtd != null ? todayYtd - todayAvg : null;

  const currentYear = new Date().getFullYear();

  // Monthly chart data
  const monthlyData = ticker.monthly.map((m) => ({
    label: MONTH_LABELS[(m.month ?? 1) - 1],
    month: m.month,
    avgReturn: parseFloat(m.avgReturn.toFixed(3)),
    medianReturn: parseFloat(m.medianReturn.toFixed(3)),
    winRate: m.winRate,
    sampleSize: m.sampleSize,
    best: parseFloat(m.best.toFixed(3)),
    worst: parseFloat(m.worst.toFixed(3)),
    stdDev: parseFloat(m.stdDev.toFixed(3)),
    bandHigh: parseFloat((m.avgReturn + m.stdDev).toFixed(3)),
    bandLow: parseFloat((m.avgReturn - m.stdDev).toFixed(3)),
    currentYearReturn: m.currentYearReturn,
  }));

  const slug = toEquityClockSlug(ticker.symbol);
  const equityClockUrl = `https://charts.equityclock.com/${slug}-seasonal-chart`;

  return (
    <div className="space-y-3">
      {/* Header row: stats + EquityClock link */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-bold text-cyan-300">{ticker.symbol}</span>
          <Badge variant="outline" className="text-[10px] font-mono text-muted-foreground">
            {lookback}Y lookback
          </Badge>
          {ticker.yearsCovered.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {ticker.yearsCovered[0]}–{ticker.yearsCovered[ticker.yearsCovered.length - 1]}
            </span>
          )}
        </div>
        <a
          href={equityClockUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/5 px-2.5 py-1 text-[11px] text-cyan-400 transition hover:bg-cyan-500/15"
          data-testid="link-equityclock"
        >
          <ExternalLink className="h-3 w-3" />
          View on EquityClock
        </a>
      </div>

      {/* YTD stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip label="YTD" val={todayYtd != null ? fmtPct(todayYtd) : "—"} color={todayYtd != null && todayYtd >= 0 ? "text-cyan-300" : "text-rose-400"} />
        <StatChip label={`${lookback}Y avg to-date`} val={todayAvg != null ? fmtPct(todayAvg) : "—"} color="text-slate-300" />
        <StatChip label="Full-year avg" val={fmtPct(yearly.fullYearAvg)} color={yearly.fullYearAvg >= 0 ? "text-emerald-400" : "text-rose-400"} />
        <StatChip label="Win rate" val={winRatePct(yearly.fullYearWinRate)} color="text-amber-300" />
      </div>

      {/* Delta chip */}
      {delta != null && (
        <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${
          Math.abs(delta) <= 0.5
            ? "border-border/50 bg-muted/20 text-muted-foreground"
            : delta > 0
              ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-400"
              : "border-rose-500/40 bg-rose-500/5 text-rose-400"
        }`}>
          {delta > 0.5 ? <TrendingUp className="h-3 w-3" /> : delta < -0.5 ? <TrendingDown className="h-3 w-3" /> : null}
          {Math.abs(delta) <= 0.5 ? "In line with historical path" : `${delta > 0 ? "Above" : "Below"} historical path (${fmtPctShort(delta)} vs avg)`}
        </div>
      )}

      {/* Optimal window banner */}
      {opt && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${confidenceColor(opt.confidenceLabel)} bg-current/5`} style={{ borderColor: "currentcolor" }}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">Optimal Seasonal Window</span>
            <span>BUY: <span className="font-mono font-bold">{opt.buyDate}</span></span>
            <span>SELL: <span className="font-mono font-bold">{opt.sellDate}</span></span>
            <span>Geo avg: <span className="font-mono font-bold">{fmtPct(opt.geometricAvgReturn)}</span></span>
            <span>Win rate: <span className="font-mono font-bold">{winRatePct(opt.winRate)}</span></span>
            <Badge variant="outline" className={`text-[9px] ${confidenceColor(opt.confidenceLabel)}`}>{opt.confidenceLabel}</Badge>
          </div>
        </div>
      )}

      {/* Main cumulative path chart */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            {lookback}-Year Avg Seasonal Path — {ticker.symbol}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="day"
                  type="number"
                  domain={[0, 252]}
                  ticks={getMonthTicks().map((m) => m.index)}
                  tickFormatter={(v) => {
                    const mi = Math.round((v / 252) * 12);
                    return MONTH_LABELS[Math.min(mi, 11)];
                  }}
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip content={<YearlyTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />

                {opt && (
                  <ReferenceArea
                    x1={Math.floor(opt.buyDayOfYear / step) * step}
                    x2={Math.floor(opt.sellDayOfYear / step) * step}
                    fill="#10b981"
                    fillOpacity={0.06}
                    strokeOpacity={0}
                  />
                )}
                {todayDay != null && (
                  <ReferenceLine
                    x={Math.floor((todayDay - 1) / step) * step + step}
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    label={{ value: "TODAY", position: "insideTopLeft", fontSize: 9, fill: "#f59e0b" }}
                  />
                )}
                <Area type="monotone" dataKey="bandHigh" stroke="none" fill="#64748b" fillOpacity={0.12} legendType="none" />
                <Area type="monotone" dataKey="bandLow" stroke="none" fill="#64748b" fillOpacity={0.0} legendType="none" />
                <Line type="monotone" dataKey="avgReturn" stroke="#94a3b8" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: "#94a3b8" }} name="Avg" />
                <Line type="monotone" dataKey="currentYear" stroke="#22d3ee" strokeWidth={2.5} dot={false} connectNulls={false} activeDot={{ r: 4, fill: "#22d3ee" }} name={`${currentYear}`} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-4 px-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-400" /> {lookback}yr avg</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-cyan-400" /> {currentYear} YTD</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-slate-500/25" /> ±1σ band</span>
            {opt && <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-emerald-500/20" /> Seasonal window</span>}
          </div>
        </CardContent>
      </Card>

      {/* Frequency of positive returns */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" />
            Frequency of Positive Returns (% of years positive at each day)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[110px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis
                  dataKey="day"
                  type="number"
                  domain={[0, 252]}
                  ticks={getMonthTicks().map((m) => m.index)}
                  tickFormatter={(v) => {
                    const mi = Math.round((v / 252) * 12);
                    return MONTH_LABELS[Math.min(mi, 11)];
                  }}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false} tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false} tickLine={false}
                  width={36}
                />
                <Tooltip content={<YearlyTooltip />} />
                <ReferenceLine y={50} stroke="hsl(var(--border))" strokeDasharray="3 3" strokeWidth={1} />
                <ReferenceLine y={70} stroke="#10b981" strokeDasharray="2 4" strokeWidth={0.75} opacity={0.5} />
                <Area type="monotone" dataKey="freqPositive" stroke="#3b82f6" strokeWidth={1.5} fill="#3b82f6" fillOpacity={0.1} dot={false} />
                {todayDay != null && (
                  <ReferenceLine x={Math.floor((todayDay - 1) / step) * step + step} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 px-2 text-[9px] text-muted-foreground">
            Blue = % of historical years positive at each calendar day. Above 70% = strong seasonal tailwind.
          </div>
        </CardContent>
      </Card>

      {/* Monthly stats table + bar chart */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" /> Monthly Seasonality
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={monthlyData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `${v.toFixed(1)}%`} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={48} />
                <Tooltip content={<BarTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                <Area type="monotone" dataKey="bandHigh" stroke="none" fill="#64748b" fillOpacity={0.12} legendType="none" />
                <Area type="monotone" dataKey="bandLow" stroke="none" fill="#64748b" fillOpacity={0.0} legendType="none" />
                <Line type="monotone" dataKey="avgReturn" stroke="#64748b" strokeWidth={1.5} dot={{ r: 3, fill: "#64748b" }} activeDot={{ r: 4 }} name="Avg" />
                <Line type="monotone" dataKey="medianReturn" stroke="#a78bfa" strokeWidth={1} strokeDasharray="4 2" dot={false} activeDot={{ r: 3 }} name="Median" />
                <Line type="monotone" dataKey="currentYearReturn" stroke="#22d3ee" strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4, fill: "#22d3ee" }} name={`${currentYear}`} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4 px-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-500" /> avg</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-violet-400" style={{ borderTop: "1.5px dashed #a78bfa" }} /> median</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-cyan-400" /> {currentYear}</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-slate-500/25" /> ±1σ</span>
          </div>
        </CardContent>
      </Card>

      {/* Monthly stats table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr className="border-b border-border/50">
              <th className="text-left px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">Month</th>
              <th className="text-right px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">Avg</th>
              <th className="text-right px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">Median</th>
              <th className="text-right px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">WR</th>
              <th className="text-right px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">StdDev</th>
              <th className="text-right px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">Best</th>
              <th className="text-right px-2 py-1 text-muted-foreground font-semibold uppercase tracking-wider">Worst</th>
            </tr>
          </thead>
          <tbody>
            {ticker.monthly.map((m, i) => (
              <tr key={i} className={`border-b border-border/20 ${i % 2 === 0 ? "" : "bg-card/20"}`}>
                <td className="px-2 py-1 font-semibold text-foreground/80">{MONTH_LABELS[(m.month ?? 1) - 1]}</td>
                <td className={`px-2 py-1 text-right font-mono tabular-nums ${m.avgReturn >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(m.avgReturn)}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-300">{fmtPct(m.medianReturn)}</td>
                <td className={`px-2 py-1 text-right font-mono tabular-nums ${m.winRate >= 0.7 ? "text-emerald-400" : m.winRate < 0.45 ? "text-rose-400" : "text-slate-300"}`}>{winRatePct(m.winRate)}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">{fmtPct(m.stdDev, false)}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-emerald-400">{fmtPct(m.best)}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-rose-400">{fmtPct(m.worst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Strongest / weakest summary */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-3 py-1 text-[11px]">
          <TrendingUp className="h-3 w-3 text-emerald-400" />
          <span className="text-muted-foreground">Strongest:</span>
          <span className="font-semibold text-emerald-400">{MONTH_LABELS[(ticker.strongestMonth.month ?? 1) - 1]}</span>
          <span className="font-mono text-emerald-300">({fmtPctShort(ticker.strongestMonth.avgReturn)}, {winRatePct(ticker.strongestMonth.winRate)} WR)</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/5 px-3 py-1 text-[11px]">
          <TrendingDown className="h-3 w-3 text-rose-400" />
          <span className="text-muted-foreground">Weakest:</span>
          <span className="font-semibold text-rose-400">{MONTH_LABELS[(ticker.weakestMonth.month ?? 1) - 1]}</span>
          <span className="font-mono text-rose-300">({fmtPctShort(ticker.weakestMonth.avgReturn)}, {winRatePct(ticker.weakestMonth.winRate)} WR)</span>
        </div>
      </div>

      {/* Analysis text */}
      <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2.5">
        <button
          className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground"
          onClick={() => setShowAnalysis((v) => !v)}
        >
          <span>Seasonal Analysis</span>
          {showAnalysis ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {showAnalysis && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{yearly.analysisText}</p>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SeasonalityResearch() {
  const [inputValue, setInputValue] = useState("");
  const [submittedSymbol, setSubmittedSymbol] = useState<string | null>(null);
  const [lookback, setLookback] = useState<LookbackYears>(20);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery<SeasonalityResponse>({
    queryKey: ["/api/seasonality-research", submittedSymbol, lookback],
    queryFn: async () => {
      if (!submittedSymbol) throw new Error("No symbol");
      return apiRequest("GET", `/api/seasonality/${encodeURIComponent(submittedSymbol)}?lookback=${lookback}`).then((r) => {
        if (!r.ok) throw new Error(`Ticker not found: ${submittedSymbol}`);
        return r.json();
      });
    },
    enabled: !!submittedSymbol,
    staleTime: 23 * 60 * 60_000,
    retry: 1,
  });

  const handleSubmit = useCallback(() => {
    const sym = inputValue.trim().toUpperCase();
    if (!sym || sym.length < 1 || sym.length > 20) return;
    if (!/^[A-Z0-9^.\-=]+$/.test(sym)) return;
    setSubmittedSymbol(sym);
  }, [inputValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  const ticker = data?.tickers?.[0];

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-card/30 p-4" data-testid="seasonality-research">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between"
        onClick={() => setIsCollapsed((v) => !v)}
        data-testid="button-seasonality-research-toggle"
      >
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-cyan-400" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-cyan-400">
            SEASONALITY RESEARCH — ANY TICKER
          </span>
        </div>
        {isCollapsed ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>

      {!isCollapsed && (
        <div className="mt-4 space-y-4">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-1 items-center gap-2 min-w-[220px]">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value.toUpperCase().replace(/[^A-Z0-9^.\-=]/g, ""))}
                onKeyDown={handleKeyDown}
                placeholder="QQQ, BTC-USD, ^GSPC, CL=F…"
                className="h-8 font-mono text-xs uppercase"
                maxLength={20}
                data-testid="input-seasonality-symbol"
              />
            </div>

            {/* Lookback selector */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground mr-0.5">Lookback</span>
              {LOOKBACK_OPTIONS.map((yr) => (
                <button
                  key={yr}
                  data-testid={`seasonality-research-lookback-${yr}`}
                  onClick={() => setLookback(yr)}
                  className={[
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold transition",
                    lookback === yr
                      ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
                      : "border-border/50 text-muted-foreground hover:border-amber-500/30",
                  ].join(" ")}
                >
                  {yr}Y
                </button>
              ))}
            </div>

            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!inputValue.trim() || isLoading}
              className="h-8 px-4 text-xs"
              data-testid="button-seasonality-research-submit"
            >
              <Search className="h-3 w-3 mr-1.5" />
              Research
            </Button>
          </div>

          {/* Content */}
          {!submittedSymbol && (
            <div className="rounded-lg border border-dashed border-border/50 bg-card/20 p-6 text-center text-xs text-muted-foreground">
              Enter any Yahoo Finance symbol above. Equity, ETF, index (^GSPC), crypto (BTC-USD), futures (CL=F), or forex.
            </div>
          )}

          {submittedSymbol && isLoading && <ResearchSkeleton />}

          {submittedSymbol && isError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-400">
              {(error as Error)?.message ?? `No data found for "${submittedSymbol}". Verify the Yahoo Finance symbol.`}
            </div>
          )}

          {ticker && !isLoading && !isError && (
            <ResearchResults ticker={ticker} lookback={lookback} />
          )}
        </div>
      )}
    </div>
  );
}
