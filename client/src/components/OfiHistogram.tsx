// OfiHistogram.tsx
// 1-min Lee-Ready signed-volume bars + session-cumulative line.
// Compact sub-panel for Chart + Trade Desk (SPX feed).
//
// Rules:
//  - emerald bar = buy-side (signedVolume > 0)
//  - rose bar    = sell-side (signedVolume < 0)
//  - cyan line   = session-cumulative OFI (right axis)
//  - badges show 15m/5m slope + acceleration regime
// Shows ONLY when /api/ofi returns >= 5 bars; otherwise renders nothing.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Bar, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";

type OfiBar = {
  ts: number;
  signedVolume: number;
  cumulative: number;
};

type OfiResponse = {
  bars: OfiBar[];
  cumulativeNow: number;
  slope15m: number;
  slope5m: number;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";
  capturedAt: number;
};

function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return v.toFixed(0);
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
}

export default function OfiHistogram({ compact = false }: { compact?: boolean } = {}) {
  const { data, isLoading } = useQuery<OfiResponse>({
    queryKey: ["/api/ofi"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/ofi");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  if (isLoading || !data || data.bars.length < 5) return null;

  const trendColor =
    data.trend === "BULLISH" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
    : data.trend === "BEARISH" ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
    : "border-border/40 text-muted-foreground";

  const accelColor =
    data.acceleration === "ACCELERATING" ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
    : data.acceleration === "DECELERATING" ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
    : "border-border/40 text-muted-foreground";

  const TrendIcon = data.trend === "BULLISH" ? TrendingUp
    : data.trend === "BEARISH" ? TrendingDown
    : Activity;

  // Recharts data
  const chartData = data.bars.map(b => ({
    time: fmtTime(b.ts),
    signed: b.signedVolume,
    cum: b.cumulative,
  }));

  const height = compact ? 100 : 140;

  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2.5" data-testid="ofi-histogram">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Order Flow · 1m signed volume (SPX)
        </span>
        <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${trendColor}`}>
          <TrendIcon className="h-2.5 w-2.5" /> {data.trend}
        </span>
        <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${accelColor}`}>
          {data.acceleration}
        </span>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          15m {fmtVol(data.slope15m)} · 5m {fmtVol(data.slope5m)}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <XAxis dataKey="time" hide />
          <YAxis yAxisId="bar" tick={{ fontSize: 9 }} tickFormatter={fmtVol} width={42} />
          <YAxis yAxisId="line" orientation="right" tick={{ fontSize: 9 }} tickFormatter={fmtVol} width={42} />
          <ReferenceLine yAxisId="bar" y={0} stroke="rgba(255,255,255,0.2)" />
          <Tooltip
            contentStyle={{ background: "rgba(15,15,20,0.95)", border: "1px solid #333", fontSize: 10 }}
            formatter={(value: any, name: string) => {
              if (name === "signed") return [fmtVol(value), "signed vol"];
              if (name === "cum") return [fmtVol(value), "cumulative"];
              return [value, name];
            }}
          />
          <Bar yAxisId="bar" dataKey="signed" isAnimationActive={false}>
            {chartData.map((d, i) => (
              <Cell key={i} fill={d.signed >= 0 ? "rgba(16,185,129,0.7)" : "rgba(244,63,94,0.7)"} />
            ))}
          </Bar>
          <Line
            yAxisId="line"
            type="monotone"
            dataKey="cum"
            stroke="rgba(34,211,238,0.85)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
