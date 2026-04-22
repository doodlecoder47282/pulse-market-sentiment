// JPMCollarPanel.tsx
// JPMorgan Hedged Equity Fund (JHEQX) quarterly collar visualization.
// Shows 90-day SPX price chart with horizontal reference lines at collar strikes.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Calendar, Shield, AlertTriangle } from "lucide-react";

interface CollarQuarter {
  quarter: string;
  rollDate: string;
  longPut: number;
  shortPut: number;
  shortCall: number;
}

interface JPMCollarData {
  current: CollarQuarter & {
    spxNow: number;
    distToLongPut: number;
    distToShortPut: number;
    distToShortCall: number;
    pctToLongPut: number;
    pctToShortPut: number;
    pctToShortCall: number;
    daysToRoll: number;
  };
  history: CollarQuarter[];
  spxCloses: Array<{ t: number; c: number }>;
  asOf: string;
}

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtPct(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover p-2 text-xs shadow-lg">
      <div className="text-muted-foreground mb-1">{label}</div>
      <div className="font-mono font-semibold text-foreground">
        {payload[0]?.value?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
    </div>
  );
}

export default function JPMCollarPanel() {
  const { data, isLoading, isError } = useQuery<JPMCollarData>({
    queryKey: ["/api/jpm-collar"],
    queryFn: async () => apiRequest("GET", "/api/jpm-collar").then((r) => r.json()),
    refetchInterval: 60 * 60_000, // 1hr
    staleTime: 55 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        JPM collar data unavailable.
      </div>
    );
  }

  const { current, history, spxCloses } = data;

  // Build chart data — SPX closes with date labels
  const chartData = spxCloses.map((bar) => ({
    date: fmtDate(bar.t),
    price: bar.c,
  }));

  // Determine Y domain with 5% buffer around collar range + price
  const allValues = [
    current.longPut,
    current.shortPut,
    current.shortCall,
    ...spxCloses.map((b) => b.c),
  ].filter((v) => v > 0);
  const yMin = Math.min(...allValues) * 0.98;
  const yMax = Math.max(...allValues) * 1.02;

  const distToCallPct = current.pctToShortCall;
  const distToPutPct = -current.pctToLongPut;

  return (
    <div className="space-y-4" data-testid="jpm-collar-panel">
      {/* Current quarter summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-border/60 bg-card/50 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Quarter</div>
          <div className="mt-0.5 text-sm font-semibold">{current.quarter}</div>
        </div>
        <div className="rounded-lg border border-border/60 bg-card/50 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Calendar className="h-3 w-3" /> Roll Date
          </div>
          <div className="mt-0.5 text-sm font-semibold">{current.rollDate}</div>
          <div className="text-[10px] text-muted-foreground">{current.daysToRoll}d away</div>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-emerald-400/80">Long Put (Floor)</div>
          <div className="mt-0.5 text-sm font-semibold text-emerald-300">{current.longPut.toLocaleString()}</div>
          <div className="text-[10px] text-muted-foreground">{fmtPct(-distToPutPct)} below spot</div>
        </div>
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-rose-400/80">Short Call (Cap)</div>
          <div className="mt-0.5 text-sm font-semibold text-rose-300">{current.shortCall.toLocaleString()}</div>
          <div className="text-[10px] text-muted-foreground">{fmtPct(distToCallPct)} above spot</div>
        </div>
      </div>

      {/* SPX Chart with collar lines */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            SPX 90-Day w/ Collar Strikes
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="spxGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                  interval={14}
                />
                <YAxis
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                  width={52}
                />
                <Tooltip content={<CustomTooltip />} />

                {/* Shaded zone between shortPut and shortCall */}
                <ReferenceArea
                  y1={current.shortPut}
                  y2={current.shortCall}
                  fill="#22d3ee"
                  fillOpacity={0.04}
                />

                {/* Long Put — green dashed (floor) */}
                <ReferenceLine
                  y={current.longPut}
                  stroke="#22c55e"
                  strokeDasharray="5 3"
                  strokeWidth={1.5}
                  label={{ value: `Long Put ${current.longPut.toLocaleString()}`, position: "insideTopLeft", fill: "#22c55e", fontSize: 9 }}
                />

                {/* Short Put — amber dotted */}
                <ReferenceLine
                  y={current.shortPut}
                  stroke="#f59e0b"
                  strokeDasharray="2 4"
                  strokeWidth={1.5}
                  label={{ value: `Short Put ${current.shortPut.toLocaleString()}`, position: "insideBottomLeft", fill: "#f59e0b", fontSize: 9 }}
                />

                {/* Short Call — red dashed (ceiling) */}
                <ReferenceLine
                  y={current.shortCall}
                  stroke="#ef4444"
                  strokeDasharray="5 3"
                  strokeWidth={1.5}
                  label={{ value: `Short Call ${current.shortCall.toLocaleString()}`, position: "insideTopRight", fill: "#ef4444", fontSize: 9 }}
                />

                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="#22d3ee"
                  strokeWidth={1.5}
                  fill="url(#spxGrad)"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* History table */}
      <Card className="border-border/60 bg-card/40">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Collar History
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <table className="w-full text-xs" data-testid="jpm-collar-history">
            <thead>
              <tr className="border-b border-border/40">
                <th className="pb-1.5 text-left text-[10px] uppercase tracking-wider text-muted-foreground">Quarter</th>
                <th className="pb-1.5 text-right text-[10px] uppercase tracking-wider text-emerald-400/70">Long Put</th>
                <th className="pb-1.5 text-right text-[10px] uppercase tracking-wider text-amber-400/70">Short Put</th>
                <th className="pb-1.5 text-right text-[10px] uppercase tracking-wider text-rose-400/70">Short Call</th>
              </tr>
            </thead>
            <tbody>
              {[current, ...history].map((q, i) => (
                <tr key={q.quarter} className={`border-b border-border/20 ${i === 0 ? "bg-cyan-500/5" : ""}`}>
                  <td className="py-1.5 font-semibold">
                    {q.quarter}
                    {i === 0 && <Badge variant="outline" className="ml-1.5 text-[9px] border-cyan-500/50 text-cyan-400">Current</Badge>}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-emerald-400">{q.longPut.toLocaleString()}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-amber-400">{q.shortPut.toLocaleString()}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-rose-400">{q.shortCall.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] text-muted-foreground/60 italic">
            * Strikes approximate — verify with latest JHEQX 13F filing. Dealer hedging of these positions creates price gravity near strikes.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
