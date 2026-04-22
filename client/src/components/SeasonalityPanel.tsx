// SeasonalityPanel.tsx
// Equityclock-style seasonal analysis: Yearly (flagship), Monthly, Weekly views.
// Yearly: avg cumulative path + current YTD, buy/sell markers, frequency-of-positive,
//         optimal seasonal window, presidential cycle, analysis text.
// Monthly/Weekly: avg, median, win rate, stddev, best/worst, current year overlay.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Area, AreaChart, ComposedChart, ReferenceArea,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, BarChart2, Calendar, ChevronDown, ChevronUp, Info } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────
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

// ─── Constants ──────────────────────────────────────────────────────────────
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const TICKER_LIST = [
  { symbol: "SPY", label: "SPY / SPX" },
  { symbol: "QQQ", label: "QQQ" },
  { symbol: "IWM", label: "IWM" },
  { symbol: "VIX", label: "VIX" },
  { symbol: "HYG", label: "HYG" },
  { symbol: "USO", label: "USO" },
  { symbol: "GLD", label: "GLD" },
  { symbol: "SLV", label: "SLV" },
  { symbol: "BTC", label: "BTC-USD" },
];

const LOOKBACK_OPTIONS = [5, 10, 20] as const;
type LookbackYears = typeof LOOKBACK_OPTIONS[number];

const CYCLE_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Year 1 — Post-Election",
  2: "Year 2 — Midterm",
  3: "Year 3 — Pre-Election",
  4: "Year 4 — Election",
};

// ─── Helpers ────────────────────────────────────────────────────────────────
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

// Map 0-based trading day index (0..251) to approximate month label
function dayIndexToMonthLabel(dayIdx: number): string {
  // 252 trading days ~ 12 months, each ~21 trading days
  const monthIdx = Math.floor((dayIdx / 252) * 12);
  return MONTH_LABELS[Math.min(monthIdx, 11)];
}

// For X-axis ticks: show month labels at approximate day index boundaries
function getMonthTicks(): { index: number; label: string }[] {
  return MONTH_LABELS.map((m, i) => ({
    index: Math.round((i / 12) * 252),
    label: m,
  }));
}

// ─── Loading skeleton ────────────────────────────────────────────────────────
function PanelSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {TICKER_LIST.map((t) => <Skeleton key={t.symbol} className="h-7 w-16 rounded-full" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

// ─── Custom yearly chart tooltip ─────────────────────────────────────────────
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
          <span className="text-cyan-300">2026 YTD</span>
          <span className="font-mono tabular-nums text-cyan-300">{fmtPct(curEntry.value)}</span>
        </div>
      )}
      {avgEntry && curEntry?.value != null && (
        <div className="flex items-center justify-between gap-4 border-t border-border/50 mt-1 pt-1">
          <span className="text-muted-foreground">vs avg</span>
          <span className={`font-mono tabular-nums ${curEntry.value - avgEntry.value >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {fmtPct(curEntry.value - avgEntry.value)}
          </span>
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

// ─── Monthly/Weekly tooltip ───────────────────────────────────────────────────
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
        {p.currentYearReturn != null && (
          <Row label="2026" val={fmtPct(p.currentYearReturn)} color={p.currentYearReturn >= 0 ? "text-cyan-300" : "text-rose-400"} />
        )}
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

// ─── Seasonal Strength Bar ────────────────────────────────────────────────────
function SeasonalStrengthBar({ monthly }: { monthly: SeasonalityBar[] }) {
  // Bucket each month by avg return + win rate
  return (
    <div className="mt-3">
      <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">Seasonal Strength by Month</div>
      <div className="flex w-full rounded overflow-hidden" style={{ height: 14 }}>
        {monthly.map((m, i) => {
          const strong = m.avgReturn > 0.5 && m.winRate > 0.55;
          const weak = m.avgReturn < -0.3 || m.winRate < 0.45;
          const bg = strong ? "bg-emerald-500/60" : weak ? "bg-rose-500/50" : "bg-muted/50";
          return (
            <div key={i} className={`flex-1 ${bg} border-r border-black/10 last:border-0`} title={`${MONTH_LABELS[i]}: ${fmtPct(m.avgReturn)} avg, ${winRatePct(m.winRate)} win rate`} />
          );
        })}
      </div>
      <div className="mt-0.5 flex w-full">
        {MONTH_LABELS.map((m, i) => (
          <div key={i} className="flex-1 text-center text-[8px] text-muted-foreground/60">{m[0]}</div>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-3 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-emerald-500/60" /> Strong</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-rose-500/50" /> Weak</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-muted/50" /> Neutral</span>
      </div>
    </div>
  );
}

// ─── Yearly View (equityclock flagship) ────────────────────────────────────────
function YearlyView({ ticker, lookback }: { ticker: SeasonalityTicker; lookback: LookbackYears }) {
  const [showInfo, setShowInfo] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(true);
  const yearly = ticker.yearly;

  // Downsample path to ~60 points for chart performance
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

  // Today's position — last non-null current year value
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

  const opt = yearly.optimalWindow;
  const cycleLabel = CYCLE_LABELS[yearly.presidentialCycleYear];

  // Month-boundary ticks for X-axis
  const monthTicks = getMonthTicks().map((m) => Math.floor(m.index / step) * step + step);

  // Tracking status
  const trackChip = delta == null ? null : Math.abs(delta) <= 0.5
    ? { label: "In line with historical path", color: "text-muted-foreground border-border/50", bg: "bg-muted/20" }
    : delta > 0
    ? { label: `Tracking above historical path (${fmtPctShort(delta)} vs avg)`, color: "text-emerald-400 border-emerald-500/40", bg: "bg-emerald-500/5" }
    : { label: `Tracking below historical path (${fmtPctShort(delta)} vs avg)`, color: "text-rose-400 border-rose-500/40", bg: "bg-rose-500/5" };

  return (
    <div className="space-y-3">
      {/* YTD stats card */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip label="2026 YTD" val={todayYtd != null ? fmtPct(todayYtd) : "—"} color={todayYtd != null && todayYtd >= 0 ? "text-cyan-300" : "text-rose-400"} />
        <StatChip label={`${lookback}Y avg to-date`} val={todayAvg != null ? fmtPct(todayAvg) : "—"} color="text-slate-300" />
        <StatChip label="Full-year avg" val={fmtPct(yearly.fullYearAvg)} color={yearly.fullYearAvg >= 0 ? "text-emerald-400" : "text-rose-400"} />
        <StatChip label="Win rate" val={winRatePct(yearly.fullYearWinRate)} color="text-amber-300" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip label="Full-year median" val={fmtPct(yearly.fullYearMedian)} color="text-slate-300" />
        <StatChip label="Best year" val={`${yearly.bestYear.year} (${fmtPctShort(yearly.bestYear.return)})`} color="text-emerald-400" />
        <StatChip label="Worst year" val={`${yearly.worstYear.year} (${fmtPctShort(yearly.worstYear.return)})`} color="text-rose-400" />
        {yearly.presidentialCycleAvg != null && (
          <StatChip
            label={`Cycle Y${yearly.presidentialCycleYear} avg`}
            val={fmtPct(yearly.presidentialCycleAvg)}
            color={yearly.presidentialCycleAvg >= 0 ? "text-amber-300" : "text-rose-400"}
          />
        )}
      </div>

      {/* Tracking chip */}
      {trackChip && (
        <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${trackChip.color} ${trackChip.bg}`}>
          {delta != null && delta > 0.5 ? <TrendingUp className="h-3 w-3" /> : delta != null && delta < -0.5 ? <TrendingDown className="h-3 w-3" /> : null}
          {trackChip.label}
        </div>
      )}

      {/* Optimal window banner */}
      {opt && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${confidenceColor(opt.confidenceLabel)} bg-current/5`} style={{ borderColor: "currentcolor" }}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">Optimal Seasonal Window</span>
            <span>🟢 BUY: <span className="font-mono font-bold">{opt.buyDate}</span></span>
            <span>🔴 SELL: <span className="font-mono font-bold">{opt.sellDate}</span></span>
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
            Average {lookback}-Year Seasonal Pattern — {ticker.symbol}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[260px]">
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

                {/* Optimal window shading */}
                {opt && (
                  <ReferenceArea
                    x1={Math.floor(opt.buyDayOfYear / step) * step}
                    x2={Math.floor(opt.sellDayOfYear / step) * step}
                    fill="#10b981"
                    fillOpacity={0.05}
                    strokeOpacity={0}
                  />
                )}

                {/* Today vertical line */}
                {todayDay != null && (
                  <ReferenceLine
                    x={Math.floor((todayDay - 1) / step) * step + step}
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    label={{ value: "TODAY", position: "insideTopLeft", fontSize: 9, fill: "#f59e0b" }}
                  />
                )}

                {/* StdDev band */}
                <Area
                  type="monotone"
                  dataKey="bandHigh"
                  stroke="none"
                  fill="#64748b"
                  fillOpacity={0.12}
                  legendType="none"
                />
                <Area
                  type="monotone"
                  dataKey="bandLow"
                  stroke="none"
                  fill="#64748b"
                  fillOpacity={0.0}
                  legendType="none"
                />

                {/* Avg path */}
                <Line
                  type="monotone"
                  dataKey="avgReturn"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, fill: "#94a3b8" }}
                  name="Avg"
                />
                {/* Current year */}
                <Line
                  type="monotone"
                  dataKey="currentYear"
                  stroke="#22d3ee"
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls={false}
                  activeDot={{ r: 4, fill: "#22d3ee" }}
                  name="2026"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-4 px-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-400" /> {lookback}yr avg</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-cyan-400" /> 2026 YTD</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-slate-500/25" /> ±1σ band</span>
            {opt && <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-emerald-500/20" /> Seasonal window</span>}
          </div>
        </CardContent>
      </Card>

      {/* Frequency of positive returns chart */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" />
            Frequency of Positive Returns (% of years positive at each day)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[120px]">
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
                <Area
                  type="monotone"
                  dataKey="freqPositive"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  fill="#3b82f6"
                  fillOpacity={0.1}
                  dot={false}
                />
                {todayDay != null && (
                  <ReferenceLine x={Math.floor((todayDay - 1) / step) * step + step} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 px-2 text-[9px] text-muted-foreground">
            Blue = % of historical years that were net-positive at each calendar day from start of year. Above 70% = strong seasonal tailwind.
          </div>
        </CardContent>
      </Card>

      {/* Seasonal strength bar */}
      <SeasonalStrengthBar monthly={ticker.monthly} />

      {/* Presidential cycle */}
      <div className="rounded-lg border border-border/50 bg-card/30 px-3 py-2 text-xs space-y-1">
        <div className="font-semibold text-amber-400/80">Presidential Cycle — {cycleLabel}</div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
          {yearly.presidentialCycleAvg != null && (
            <span>
              Cycle Y{yearly.presidentialCycleYear} avg:{" "}
              <span className={`font-mono font-semibold ${yearly.presidentialCycleAvg >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {fmtPct(yearly.presidentialCycleAvg)}
              </span>
            </span>
          )}
          <span>
            All-years avg:{" "}
            <span className={`font-mono font-semibold ${yearly.fullYearAvg >= 0 ? "text-slate-300" : "text-rose-400"}`}>
              {fmtPct(yearly.fullYearAvg)}
            </span>
          </span>
          {yearly.currentDecadeAvg != null && (
            <span>
              2020s avg:{" "}
              <span className={`font-mono font-semibold ${yearly.currentDecadeAvg >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {fmtPct(yearly.currentDecadeAvg)}
              </span>
            </span>
          )}
        </div>
        {yearly.presidentialCycleYear === 2 && (
          <div className="text-muted-foreground/70 text-[10px] leading-relaxed">
            Four-year cyclical low historically occurs within ~3 months before the midterm election. Midterm election: Nov 3, 2026.
          </div>
        )}
      </div>

      {/* Analysis text (equityclock-style paragraph) */}
      <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2.5">
        <button
          className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground"
          onClick={() => setShowAnalysis((v) => !v)}
        >
          <span>Seasonal Analysis</span>
          {showAnalysis ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {showAnalysis && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {yearly.analysisText}
          </p>
        )}
      </div>

      {/* Data transparency */}
      <div className="rounded-lg border border-border/30 bg-card/10 px-3 py-2">
        <button
          className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground/60"
          onClick={() => setShowInfo((v) => !v)}
        >
          <Info className="h-3 w-3" /> Data source &amp; methodology
          {showInfo ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
        </button>
        {showInfo && (
          <div className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/60 space-y-0.5">
            <div>Source: Yahoo Finance daily closes · Lookback: {yearly.yearsCovered[0]}–{yearly.yearsCovered[yearly.yearsCovered.length - 1]} ({yearly.yearsCovered.length} years)</div>
            <div>Monthly returns: month-over-month % change, averaged across years</div>
            <div>Win rate: % of years that period was positive · Geometric avg: compounded</div>
            <div>Not dividend-adjusted · 70%+ win rate preferred for tradeable signals</div>
            <div className="text-muted-foreground/40">Seasonal analysis should be combined with technical + fundamental signals.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Monthly View ─────────────────────────────────────────────────────────────
function MonthlyView({ ticker }: { ticker: SeasonalityTicker }) {
  const now = new Date();
  const curMonth = now.getMonth();
  const curMonthData = ticker.monthly[curMonth];
  const currentYear = now.getFullYear();

  const chartData = ticker.monthly.map((m) => ({
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

  const strongest = ticker.strongestMonth;
  const weakest = ticker.weakestMonth;

  return (
    <div className="space-y-3">
      {/* Current month stats */}
      {curMonthData && (
        <div className="rounded-lg border border-border/60 bg-card/50 px-4 py-2.5 text-xs space-y-1">
          <div className="font-semibold text-foreground">
            {MONTH_LABELS[curMonth]} — {ticker.lookbackYears}yr Stats
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            <span>Avg: <span className={`font-mono font-semibold ${curMonthData.avgReturn >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(curMonthData.avgReturn)}</span></span>
            <span>Median: <span className="font-mono font-semibold text-slate-300">{fmtPct(curMonthData.medianReturn)}</span></span>
            <span>Win rate: <span className="font-mono font-semibold text-cyan-300">{winRatePct(curMonthData.winRate)} ({Math.round(curMonthData.winRate * curMonthData.sampleSize)}/{curMonthData.sampleSize} yrs)</span></span>
            <span>Best: <span className="font-mono font-semibold text-emerald-400">{fmtPct(curMonthData.best)}</span></span>
            <span>Worst: <span className="font-mono font-semibold text-rose-400">{fmtPct(curMonthData.worst)}</span></span>
          </div>
          {curMonthData.currentYearReturn != null && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{currentYear} through {MONTH_LABELS[curMonth]}:</span>
              <span className={`font-mono font-semibold ${curMonthData.currentYearReturn >= 0 ? "text-cyan-300" : "text-rose-400"}`}>
                {fmtPct(curMonthData.currentYearReturn)}
              </span>
              {curMonthData.currentYearReturn > curMonthData.avgReturn
                ? <TrendingUp className="h-3 w-3 text-emerald-400" />
                : <TrendingDown className="h-3 w-3 text-rose-400" />
              }
            </div>
          )}
        </div>
      )}

      {/* Monthly chart */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" /> Monthly Seasonality
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `${v.toFixed(1)}%`} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={48} />
                <Tooltip content={<BarTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                {/* Range band */}
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

      {/* Strongest / weakest */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-3 py-1 text-[11px]">
          <TrendingUp className="h-3 w-3 text-emerald-400" />
          <span className="text-muted-foreground">Strongest:</span>
          <span className="font-semibold text-emerald-400">{MONTH_LABELS[(strongest.month ?? 1) - 1]}</span>
          <span className="font-mono text-emerald-300">({fmtPctShort(strongest.avgReturn)}, {winRatePct(strongest.winRate)} WR)</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/5 px-3 py-1 text-[11px]">
          <TrendingDown className="h-3 w-3 text-rose-400" />
          <span className="text-muted-foreground">Weakest:</span>
          <span className="font-semibold text-rose-400">{MONTH_LABELS[(weakest.month ?? 1) - 1]}</span>
          <span className="font-mono text-rose-300">({fmtPctShort(weakest.avgReturn)}, {winRatePct(weakest.winRate)} WR)</span>
        </div>
      </div>

      <SeasonalStrengthBar monthly={ticker.monthly} />
    </div>
  );
}

// ─── Weekly View ──────────────────────────────────────────────────────────────
function WeeklyView({ ticker }: { ticker: SeasonalityTicker }) {
  const now = new Date();
  const currentYear = now.getFullYear();

  const chartData = ticker.weekly.map((w) => ({
    label: `W${w.week}`,
    week: w.week,
    avgReturn: parseFloat(w.avgReturn.toFixed(3)),
    medianReturn: parseFloat(w.medianReturn.toFixed(3)),
    bandHigh: parseFloat((w.avgReturn + w.stdDev).toFixed(3)),
    bandLow: parseFloat((w.avgReturn - w.stdDev).toFixed(3)),
    winRate: w.winRate,
    sampleSize: w.sampleSize,
    best: parseFloat(w.best.toFixed(3)),
    worst: parseFloat(w.worst.toFixed(3)),
    stdDev: parseFloat(w.stdDev.toFixed(3)),
    currentYearReturn: w.currentYearReturn,
  }));

  return (
    <div className="space-y-3">
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" /> Weekly Seasonality
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} interval={7} />
                <YAxis tickFormatter={(v) => `${v.toFixed(1)}%`} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={48} />
                <Tooltip content={<BarTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                <Area type="monotone" dataKey="bandHigh" stroke="none" fill="#64748b" fillOpacity={0.10} legendType="none" />
                <Area type="monotone" dataKey="bandLow" stroke="none" fill="#64748b" fillOpacity={0.0} legendType="none" />
                <Line type="monotone" dataKey="avgReturn" stroke="#64748b" strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} name="Avg" />
                <Line type="monotone" dataKey="currentYearReturn" stroke="#22d3ee" strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4, fill: "#22d3ee" }} name={`${currentYear}`} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex items-center gap-4 px-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-500" /> {ticker.lookbackYears}yr avg</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-cyan-400" /> {currentYear}</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-slate-500/20" /> ±1σ</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Stat chip helper ────────────────────────────────────────────────────────
function StatChip({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm font-semibold tabular-nums ${color}`}>{val}</div>
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────
export default function SeasonalityPanel() {
  const [activeTicker, setActiveTicker] = useState("SPY");
  const [lookback, setLookback] = useState<LookbackYears>(20);
  const [activeView, setActiveView] = useState<"yearly" | "monthly" | "weekly">("yearly");

  const { data, isLoading, isError } = useQuery<SeasonalityResponse>({
    queryKey: ["/api/seasonality", lookback],
    queryFn: async () => {
      const url = lookback !== 20 ? `/api/seasonality?lookback=${lookback}` : "/api/seasonality";
      return apiRequest("GET", url).then((r) => r.json());
    },
    staleTime: 23 * 60 * 60_000,
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

  return (
    <div className="space-y-3" data-testid="seasonality-panel">
      {/* Controls row: ticker selector + lookback + view toggle */}
      <div className="flex flex-wrap items-center gap-2" data-testid="seasonality-ticker-selector">
        {/* Ticker pills */}
        <div className="flex flex-wrap gap-1">
          {TICKER_LIST.map((t) => (
            <button
              key={t.symbol}
              data-testid={`seasonality-ticker-${t.symbol}`}
              onClick={() => setActiveTicker(t.symbol)}
              className={[
                "rounded-full border px-2.5 py-0.5 text-xs font-semibold transition",
                activeTicker === t.symbol
                  ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-300"
                  : "border-border/50 text-muted-foreground hover:border-cyan-500/30 hover:text-cyan-200",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Lookback selector */}
        <div className="ml-auto flex items-center gap-1" data-testid="seasonality-lookback-selector">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground mr-0.5">Lookback</span>
          {LOOKBACK_OPTIONS.map((yr) => (
            <button
              key={yr}
              data-testid={`seasonality-lookback-${yr}`}
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
      </div>

      {/* View toggle */}
      <div className="flex gap-1 rounded-lg border border-border/40 bg-muted/10 p-0.5 w-fit" data-testid="seasonality-view-toggle">
        {(["yearly", "monthly", "weekly"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setActiveView(v)}
            data-testid={`seasonality-view-${v}`}
            className={[
              "rounded-md px-3 py-1 text-xs font-semibold capitalize transition",
              activeView === v
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {v === "yearly" ? "Yearly ★" : v}
          </button>
        ))}
      </div>

      {/* View content */}
      {activeView === "yearly" && <YearlyView ticker={ticker} lookback={lookback} />}
      {activeView === "monthly" && <MonthlyView ticker={ticker} />}
      {activeView === "weekly" && <WeeklyView ticker={ticker} />}

      {/* Footer */}
      <div className="text-[9px] text-muted-foreground/50">
        Lookback: {ticker.yearsCovered[0]}–{ticker.yearsCovered[ticker.yearsCovered.length - 1]} ({ticker.lookbackYears} years) ·
        Source: Yahoo Finance daily closes · Not dividend-adjusted · Updated: {new Date(data.asOf).toLocaleDateString()}
      </div>
    </div>
  );
}
