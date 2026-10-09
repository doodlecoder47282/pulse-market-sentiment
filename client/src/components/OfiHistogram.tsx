import EdgeInfo from "@/components/EdgeInfo";
// OfiHistogram.tsx
// 1-min signed tick volume bars + session-cumulative line. Tick rule on SPY
// 1-minute closes (whole bar volume signed by close-to-close change); not
// Lee-Ready and not order-book OFI. File/endpoint names are historical.
// Compact sub-panel for Chart + Trade Desk (SPX feed).
//
// Rules:
//  - emerald bar = buy-side (signedVolume > 0)
//  - rose bar    = sell-side (signedVolume < 0)
//  - cyan line   = session-cumulative signed tick volume (right axis)
//  - badges show 15m/5m slope + acceleration regime
// Data states (server/ofiPayload.ts): "unavailable" (bars could not be
// fetched, or every bar arrived without volume) and request failures render
// an explicit chip with the reason, never "no prints" or an empty chart.
// "partial" draws bars without volume as gaps (null), not zero-height bars,
// and the trend/acceleration badges are withheld while any bar in the 15-bar
// slope window is missing volume (the 15m sum would be incomplete).
// Fewer than 5 bars: a one-line "warming up" note, not silence.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { SIGNED_TICK_VOLUME_NOTE } from "@shared/flowLabels";
import {
  Bar, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";
import DataStateChip from "@/components/DataStateChip";
import { ageFromAsOf, effectiveDataState } from "@shared/dataState";
import type { ReactNode } from "react";

type OfiBar = {
  ts: number;
  /** null = the minute candle had no volume (a gap, not zero flow). */
  signedVolume: number | null;
  /** null from the first bar without volume onward (unknown, not zero). */
  cumulative: number | null;
  volumeMissing?: boolean;
};

type OfiResponse = {
  bars: OfiBar[];
  cumulativeNow: number | null;
  cumulativeNote?: string | null;
  slope15m: number;
  slope5m: number;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";
  dataState?: "ok" | "partial" | "unavailable";
  dataStateReason?: string | null;
  volumeMissingBars?: number;
  totalBars?: number;
  trendWindowMissingBars?: number;
  trendComplete?: boolean;
  asOfMs?: number | null;
  capturedAt: number;
  /** Signing method (server/ofiPayload.ts ofiMethodLabel); label follows it. */
  method?: "tick-rule-1m" | "lee-ready-l1" | "hybrid-l1";
  methodLabel?: string;
  methodNote?: string;
};

// Last minute bar older than 5 minutes = stale (server/ofiPayload.ts OFI_MAX_AGE_MS).
const OFI_MAX_AGE_MS = 5 * 60_000;
const MIN_BARS = 5;

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

const TITLE = "Signed tick volume · 1m (SPY proxy)";

function StatusLine({ chip, note }: { chip: ReactNode; note: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2.5" data-testid="ofi-histogram">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground" title={SIGNED_TICK_VOLUME_NOTE}>
          {TITLE}
        </span>
        {chip}
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">{note}</span>
      </div>
    </div>
  );
}

export default function OfiHistogram({ compact = false }: { compact?: boolean } = {}) {
  const { data, isLoading, isError, error } = useQuery<OfiResponse>({
    queryKey: ["/api/ofi"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/ofi");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  if (isLoading) return null;
  if (isError || !data) {
    const msg = (error as any)?.message ?? "no response";
    return <StatusLine chip={<DataStateChip state="failed" reason={msg} />} note="request failed; nothing shown in place of flow" />;
  }

  const state = data.dataState ?? "unavailable";
  if (state === "unavailable") {
    return (
      <StatusLine
        chip={<DataStateChip state="unavailable" reason={data.dataStateReason} asOf={data.asOfMs ?? null} source="Schwab" />}
        note={data.dataStateReason ?? "signed volume unavailable"}
      />
    );
  }
  if (data.bars.length < MIN_BARS) {
    return (
      <StatusLine
        chip={<DataStateChip state={state} reason={data.dataStateReason} asOf={data.asOfMs ?? null} maxAgeMs={OFI_MAX_AGE_MS} source="Schwab" />}
        note={`warming up: ${data.bars.length} of ${MIN_BARS} minute bars`}
      />
    );
  }

  // Observed zero: every bar has real volume and nets to zero signed flow.
  // That is a reading, not a dead feed, and is labelled as such.
  const observedZero = data.bars.every(b => !b.volumeMissing && b.signedVolume === 0) && data.cumulativeNow === 0;
  // A stale tape (last bar past the max age) never carries a trend badge.
  const tapeStale = effectiveDataState(state, ageFromAsOf(data.asOfMs ?? null, Date.now()), OFI_MAX_AGE_MS) === "stale";
  const trendComplete = data.trendComplete === true && !observedZero && !tapeStale;
  const missingInWindow = data.trendWindowMissingBars ?? 0;
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
        <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground" title={data.methodNote ?? SIGNED_TICK_VOLUME_NOTE} data-testid="ofi-method-label">
          {data.methodLabel ?? "Signed tick volume · 1m (SPY proxy)"}
        </span>
        <EdgeInfo id="order-flow" className="h-6 w-6" />
        <DataStateChip
          state={observedZero ? "observed_zero" : state}
          reason={data.dataStateReason}
          asOf={data.asOfMs ?? null}
          maxAgeMs={OFI_MAX_AGE_MS}
          source="Schwab"
        />
        {trendComplete ? (
          <>
            <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${trendColor}`}>
              <TrendIcon className="h-2.5 w-2.5" /> {data.trend}
            </span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${accelColor}`}>
              {data.acceleration}
            </span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">
              15m {fmtVol(data.slope15m)} · 5m {fmtVol(data.slope5m)}
            </span>
          </>
        ) : (
          <span className="ml-auto font-mono text-[9px] text-muted-foreground" data-testid="ofi-trend-withheld">
            {tapeStale
              ? "trend withheld: tape stale"
              : observedZero
              ? "no trend: signed volume nets to 0"
              : missingInWindow > 0
                ? `trend withheld: ${missingInWindow} of last 15 bars missing volume`
                : `trend after 15 bars (${data.bars.length} so far)`}
          </span>
        )}
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
              if (name === "signed") return value == null ? ["no volume (gap)", "signed tick vol"] : [fmtVol(value), "signed tick vol"];
              if (name === "cum") return value == null ? ["unknown (after a bar without volume)", "cumulative"] : [fmtVol(value), "cumulative"];
              return [value, name];
            }}
          />
          <Bar yAxisId="bar" dataKey="signed" isAnimationActive={false}>
            {chartData.map((d, i) => (
              <Cell key={i} fill={d.signed == null ? "transparent" : d.signed >= 0 ? "rgba(16,185,129,0.7)" : "rgba(244,63,94,0.7)"} />
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
      {data.cumulativeNote ? (
        <div className="mt-1 font-mono text-[9px] text-amber-300/80" data-testid="ofi-cumulative-note">
          cyan line stops at the first bar without volume: {data.cumulativeNote}
        </div>
      ) : null}
    </div>
  );
}
