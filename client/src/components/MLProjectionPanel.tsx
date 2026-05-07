// MLProjectionPanel.tsx — SPX candles (today RTH) + ML forward projected price path
// Batcave ML Lab — replaces abstract quantile fan with a real price chart

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Customized,
} from "recharts";
import { AlertTriangle, RefreshCw, Activity } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QuantileBand {
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
}

interface ProjectionResponse {
  ok: boolean;
  bands: Record<string, QuantileBand>;
  status: string;
  version: string;
  error?: string;
}

interface MLModelHealth {
  status: string;
  version: number;
  trained_at: string | null;
  n_train: number;
  auc: number | null;
}

interface HealthResponse {
  ok: boolean;
  status: string;
  models: {
    score_calibrator: MLModelHealth;
    quantile_overlay: MLModelHealth;
    whale_follow: MLModelHealth;
  };
}

interface OHLCCandle {
  t: number;  // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

interface OHLCResponse {
  symbol: string;
  displayName: string;
  timeframe: string;
  interval: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  candles: OHLCCandle[];
  asOf: number;
}

interface SnapshotPublic {
  spy: { price: number; prevClose: number; changePct: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the ET feature object the projection model wants. */
function getEtFeatures() {
  const now = new Date();
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = etFmt.formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "10", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  const hour_of_day = h + m / 60;
  const minute_of_hour = m;
  const day_of_week = weekdayMap[wd] ?? 1;
  const minutesFromOpen = (h - 9) * 60 + m - 30;
  const is_first_30min = minutesFromOpen >= 0 && minutesFromOpen < 30 ? 1 : 0;
  const is_post_lunch = h >= 13 ? 1 : 0;
  const minutesToClose = (16 - h) * 60 - m;
  const is_last_30min = minutesToClose >= 0 && minutesToClose <= 30 ? 1 : 0;

  return {
    hour_of_day,
    minute_of_hour,
    day_of_week,
    is_first_30min,
    is_post_lunch,
    is_last_30min,
  };
}

function isRTH(): boolean {
  const now = new Date();
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = etFmt.formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sat";
  // Mon-Fri 9:30 - 16:00 ET
  if (wd === "Sat" || wd === "Sun") return false;
  const totalMin = h * 60 + m;
  return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
}

/**
 * Compute today's 9:30 ET market open as epoch SECONDS.
 * Uses an offset trick: ET wall clock - UTC wall clock = ET offset.
 */
function todaysOpenEpochSec(): number {
  const now = new Date();
  // Get ET y/m/d
  const etDateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = etDateFmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";

  // Build "YYYY-MM-DDT09:30:00" in ET, then convert to UTC by computing offset
  // Trick: format the same instant in both UTC and ET, diff to get offset
  const candidate = new Date(`${y}-${mo}-${d}T09:30:00Z`); // pretend UTC
  // What's that instant in ET?
  const etHourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", minute: "numeric", hour12: false,
  });
  const etParts = etHourFmt.formatToParts(candidate);
  const etH = parseInt(etParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const etM = parseInt(etParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  // diff from 9:30 ET — shift candidate by that many minutes
  const diffMin = (9 * 60 + 30) - (etH * 60 + etM);
  const opened = new Date(candidate.getTime() + diffMin * 60_000);
  return Math.floor(opened.getTime() / 1000);
}

const RTH_MINUTES = 390; // 9:30 → 16:00

/** Format epoch seconds as "HH:MM" ET. */
function fmtEt(tSec: number): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(new Date(tSec * 1000));
}

const HORIZONS = [5, 15, 30, 60];

// ─── Status strip (preserved verbatim from original) ────────────────────────

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "TRAINED") return "default";
  if (s === "BOOTSTRAP") return "secondary";
  if (s === "INSUFFICIENT_DATA") return "outline";
  return "outline";
}

function statusColor(s: string): string {
  if (s === "TRAINED") return "text-green-500";
  if (s === "BOOTSTRAP") return "text-amber-500";
  return "text-muted-foreground";
}

function MLStatusStrip() {
  const { data, isLoading, refetch } = useQuery<HealthResponse>({
    queryKey: ["/api/ml/health"],
    queryFn: () => apiRequest("GET", "/api/ml/health").then((r) => r.json()),
    refetchInterval: 60_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex gap-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  if (!data?.ok || !data.models) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="w-3 h-3" />
        <span>ML health unreachable</span>
        <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={() => refetch()}>
          retry
        </Button>
      </div>
    );
  }

  const { score_calibrator, quantile_overlay, whale_follow } = data.models;

  return (
    <div className="flex flex-wrap gap-3 text-xs">
      <div className="flex items-center gap-1.5" data-testid="text-ml-status-score_calibrator">
        <span className="text-muted-foreground font-medium">score_calibrator</span>
        <Badge variant={statusVariant(score_calibrator?.status ?? "")} className={`text-xs h-5 ${statusColor(score_calibrator?.status ?? "")}`}>
          {score_calibrator?.status ?? "—"}
        </Badge>
      </div>

      <Separator orientation="vertical" className="h-4 self-center" />

      <div className="flex items-center gap-1.5" data-testid="text-ml-status-quantile_overlay">
        <span className="text-muted-foreground font-medium">quantile_overlay</span>
        <Badge variant={statusVariant(quantile_overlay?.status ?? "")} className={`text-xs h-5 ${statusColor(quantile_overlay?.status ?? "")}`}>
          {quantile_overlay?.status ?? "—"}
        </Badge>
        {quantile_overlay?.version != null && (
          <span className="text-muted-foreground">v{quantile_overlay.version}</span>
        )}
        {quantile_overlay?.n_train != null && (
          <span className="text-muted-foreground">n={quantile_overlay.n_train}</span>
        )}
      </div>

      <Separator orientation="vertical" className="h-4 self-center" />

      <div className="flex items-center gap-1.5" data-testid="text-ml-status-whale_follow">
        <span className="text-muted-foreground font-medium">whale_follow</span>
        <Badge variant={statusVariant(whale_follow?.status ?? "")} className={`text-xs h-5 ${statusColor(whale_follow?.status ?? "")}`}>
          {whale_follow?.status ?? "—"}
        </Badge>
      </div>
    </div>
  );
}

// ─── Custom candle layer (rendered via Recharts <Customized>) ───────────────

type ChartRow = {
  // x is minutes from market open (0..390)
  minute: number;
  // candle fields (only present on candle rows)
  o?: number; h?: number; l?: number; c?: number; v?: number | null; t?: number;
  // projection fields (present on projection rows)
  proj?: number;       // q50 path price
  projQ10?: number;    // q10 price
  projQ90?: number;    // q90 price
  ribbonLo?: number;   // for stacked area fill (= projQ10)
  ribbonHi?: number;   // for stacked area fill (= projQ90 - projQ10)
  // dashed extrapolation past 60min
  ext?: number;
  kind: "candle" | "anchor" | "proj" | "ext";
};

function CandleLayer(props: any) {
  const { xAxisMap, yAxisMap, formattedGraphicalItems, data } = props;
  if (!xAxisMap || !yAxisMap || !data) return null;
  const xAxis = (Object.values(xAxisMap)[0] as any);
  const yAxis = (Object.values(yAxisMap)[0] as any);
  if (!xAxis?.scale || !yAxis?.scale) return null;
  const xScale = xAxis.scale;
  const yScale = yAxis.scale;

  const candles = (data as ChartRow[]).filter((r) => r.kind === "candle" && r.o != null);
  if (!candles.length) return null;

  // bar width: scale 5 minutes
  const minuteUnit = Math.abs(xScale(5) - xScale(0));
  const bodyW = Math.max(2, minuteUnit * 0.7);
  const wickW = 1;

  return (
    <g>
      {candles.map((r, i) => {
        const x = xScale(r.minute);
        const o = yScale(r.o!);
        const h = yScale(r.h!);
        const l = yScale(r.l!);
        const c = yScale(r.c!);
        const up = (r.c ?? 0) >= (r.o ?? 0);
        const color = up ? "#22c55e" : "#ef4444";
        const bodyTop = Math.min(o, c);
        const bodyH = Math.max(1, Math.abs(c - o));
        return (
          <g key={i}>
            {/* wick */}
            <rect
              x={x - wickW / 2}
              y={h}
              width={wickW}
              height={Math.max(1, l - h)}
              fill={color}
              opacity={0.85}
            />
            {/* body */}
            <rect
              x={x - bodyW / 2}
              y={bodyTop}
              width={bodyW}
              height={bodyH}
              fill={color}
              opacity={0.9}
            />
          </g>
        );
      })}
    </g>
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d: ChartRow = payload[0]?.payload;
  if (!d) return null;

  if (d.kind === "candle" && d.o != null) {
    const t = d.t ? fmtEt(d.t) : "—";
    return (
      <div className="bg-background border border-border rounded-md p-2 text-xs shadow-md min-w-[180px]">
        <div className="font-semibold mb-1 text-foreground">{t} ET</div>
        <div className="space-y-0.5">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">open</span><span className="tabular-nums">{d.o?.toFixed(2)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">high</span><span className="tabular-nums">{d.h?.toFixed(2)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">low</span><span className="tabular-nums">{d.l?.toFixed(2)}</span></div>
          <div className="flex justify-between gap-4 font-semibold"><span>close</span><span className="tabular-nums">{d.c?.toFixed(2)}</span></div>
          {d.v != null && (
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">vol</span><span className="tabular-nums">{d.v.toLocaleString()}</span></div>
          )}
        </div>
      </div>
    );
  }

  if (d.kind === "proj" || d.kind === "anchor") {
    const t = d.t ? fmtEt(d.t) : "—";
    const lo = d.projQ10;
    const hi = d.projQ90;
    const range = lo != null && hi != null ? (hi - lo).toFixed(2) : "—";
    return (
      <div className="bg-background border border-border rounded-md p-2 text-xs shadow-md min-w-[200px]">
        <div className="font-semibold mb-1 text-foreground">{t} ET — projection</div>
        <div className="space-y-0.5">
          {d.proj != null && (
            <div className="flex justify-between gap-4 font-semibold text-sky-500"><span>q50 price</span><span className="tabular-nums">${d.proj.toFixed(2)}</span></div>
          )}
          {lo != null && hi != null && (
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">q10–q90</span><span className="tabular-nums">${lo.toFixed(2)}–${hi.toFixed(2)}</span></div>
          )}
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">band width</span><span className="tabular-nums">${range}</span></div>
        </div>
      </div>
    );
  }

  if (d.kind === "ext") {
    const t = d.t ? fmtEt(d.t) : "—";
    return (
      <div className="bg-background border border-border rounded-md p-2 text-xs shadow-md min-w-[200px]">
        <div className="font-semibold mb-1 text-foreground">{t} ET — extrapolated</div>
        <div className="text-muted-foreground">model trained to 60min — past that is linear extrapolation</div>
        {d.ext != null && (
          <div className="flex justify-between gap-4 mt-1 font-semibold"><span>est. price</span><span className="tabular-nums">${d.ext.toFixed(2)}</span></div>
        )}
      </div>
    );
  }

  return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MLProjectionPanel() {
  const features = getEtFeatures();
  const refetchInterval = isRTH() ? 60_000 : 5 * 60_000;

  // SPX 5min candles (today RTH)
  const {
    data: ohlc,
    isLoading: ohlcLoading,
    isError: ohlcError,
    refetch: refetchOhlc,
  } = useQuery<OHLCResponse>({
    queryKey: ["/api/ohlc", "^SPX", "1D", "5m"],
    queryFn: () =>
      apiRequest("GET", "/api/ohlc?symbol=^SPX&tf=1D&interval=5m").then((r) => r.json()),
    refetchInterval,
    retry: false,
    staleTime: 30_000,
  });

  // Snapshot fallback (SPY → 10x as crude SPX proxy if SPX missing)
  const { data: snap } = useQuery<SnapshotPublic>({
    queryKey: ["/api/snapshot"],
    queryFn: () => apiRequest("GET", "/api/snapshot").then((r) => r.json()),
    refetchInterval,
    retry: false,
    staleTime: 30_000,
  });

  // SPX spot — last candle close, or fallback
  const spxFromOhlc = ohlc?.price ?? null;
  const spxFallback = snap?.spy?.price ? snap.spy.price * 10 : null; // crude proxy
  const currentSpot = spxFromOhlc ?? spxFallback;
  const usingFallback = spxFromOhlc == null && spxFallback != null;

  // ML projection (anchored to currentSpot)
  const {
    data: proj,
    isLoading: projLoading,
    isError: projError,
    refetch: refetchProj,
    error: projErr,
  } = useQuery<ProjectionResponse>({
    queryKey: ["/api/ml/projection", currentSpot],
    queryFn: () =>
      apiRequest("POST", "/api/ml/projection", {
        features,
        horizons: HORIZONS,
      }).then((r) => r.json()),
    refetchInterval,
    retry: false,
    staleTime: 30_000,
    enabled: currentSpot != null,
  });

  const isLoading = ohlcLoading || projLoading;

  // ── compute chart rows ──────────────────────────────────────────────────────
  const { rows, lastCandleClose, lastCandleT, openMin, projTarget60, q60Lo, q60Hi, q60q50Pct } = useMemo(() => {
    const openSec = todaysOpenEpochSec();
    const candles = ohlc?.candles ?? [];

    // candle rows — minutes from open
    const candleRows: ChartRow[] = candles.map((c) => ({
      minute: Math.max(0, Math.round((c.t - openSec) / 60)),
      o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, t: c.t,
      kind: "candle",
    })).filter((r) => r.minute >= 0 && r.minute <= RTH_MINUTES);

    const lastCandle = candleRows.length ? candleRows[candleRows.length - 1] : null;
    const anchorPrice = lastCandle?.c ?? currentSpot ?? null;
    const anchorMin = lastCandle?.minute ?? 0;
    const anchorT = lastCandle?.t ?? Math.floor(Date.now() / 1000);

    if (anchorPrice == null) {
      return { rows: [], lastCandleClose: null, lastCandleT: null, openMin: 0, projTarget60: null, q60Lo: null, q60Hi: null, q60q50Pct: null };
    }

    // projection rows
    const bands = proj?.bands ?? {};
    const projRows: ChartRow[] = [];

    // anchor point at "now" (last candle close) so the line connects cleanly
    projRows.push({
      minute: anchorMin,
      proj: anchorPrice,
      projQ10: anchorPrice,
      projQ90: anchorPrice,
      ribbonLo: anchorPrice,
      ribbonHi: 0,
      kind: "anchor",
      t: anchorT,
    });

    let q50_60: number | null = null;
    let q50_30: number | null = null;
    let q10_60: number | null = null;
    let q90_60: number | null = null;

    for (const h of HORIZONS) {
      const b = bands[String(h)] ?? bands[`${h}min`];
      if (!b) continue;
      const p50 = anchorPrice * (1 + (b.q50 ?? 0));
      const p10 = anchorPrice * (1 + (b.q10 ?? 0));
      const p90 = anchorPrice * (1 + (b.q90 ?? 0));
      const m = Math.min(RTH_MINUTES, anchorMin + h);
      projRows.push({
        minute: m,
        proj: p50,
        projQ10: p10,
        projQ90: p90,
        ribbonLo: p10,
        ribbonHi: Math.max(0, p90 - p10),
        kind: "proj",
        t: anchorT + h * 60,
      });
      if (h === 60) { q50_60 = p50; q10_60 = p10; q90_60 = p90; }
      if (h === 30) { q50_30 = p50; }
    }

    // dashed extrapolation past 60min using 30→60 slope, capped ±1%
    const extRows: ChartRow[] = [];
    if (q50_60 != null && q50_30 != null) {
      const slopePerMin = (q50_60 - q50_30) / 30; // price per minute
      // start where projection ends
      const endMin = Math.min(RTH_MINUTES, anchorMin + 60);
      // anchor extrapolation at the q50 60min point
      extRows.push({
        minute: endMin,
        ext: q50_60,
        kind: "ext",
        t: anchorT + 60 * 60,
      });
      // step every 5 minutes to 4:00 ET
      const cap = anchorPrice * 0.01; // ±1%
      let stepMin = endMin + 5;
      let extPrice = q50_60;
      while (stepMin <= RTH_MINUTES) {
        extPrice = q50_60 + slopePerMin * (stepMin - endMin);
        // cap drift relative to anchorPrice
        const drift = extPrice - anchorPrice;
        const clamped = anchorPrice + Math.max(-cap, Math.min(cap, drift));
        extRows.push({
          minute: stepMin,
          ext: clamped,
          kind: "ext",
          t: anchorT + (stepMin - anchorMin) * 60,
        });
        stepMin += 5;
      }
    }

    const all: ChartRow[] = [...candleRows, ...projRows, ...extRows].sort((a, b) => a.minute - b.minute);
    return {
      rows: all,
      lastCandleClose: anchorPrice,
      lastCandleT: anchorT,
      openMin: 0,
      projTarget60: q50_60,
      q60Lo: q10_60,
      q60Hi: q90_60,
      q60q50Pct: bands["60"]?.q50 ?? bands["60min"]?.q50 ?? null,
    };
  }, [ohlc, proj, currentSpot]);

  // y-domain: from candles + projection band, with 0.3% padding
  const yDomain = useMemo<[number, number]>(() => {
    const vals: number[] = [];
    rows.forEach((r) => {
      if (r.kind === "candle") {
        if (r.l != null) vals.push(r.l);
        if (r.h != null) vals.push(r.h);
      } else {
        if (r.projQ10 != null) vals.push(r.projQ10);
        if (r.projQ90 != null) vals.push(r.projQ90);
        if (r.proj != null) vals.push(r.proj);
        if (r.ext != null) vals.push(r.ext);
      }
    });
    if (!vals.length && lastCandleClose != null) {
      return [lastCandleClose * 0.997, lastCandleClose * 1.003];
    }
    if (!vals.length) return [0, 1];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.15 || (lastCandleClose ?? hi) * 0.003;
    return [lo - pad, hi + pad];
  }, [rows, lastCandleClose]);

  const projStatus = proj?.status;
  const isUntrained =
    projStatus === "BOOTSTRAP" ||
    projStatus === "INSUFFICIENT_DATA" ||
    projStatus === "NOT_TRAINED";

  // current "now" minute marker — last candle, or current ET minute clamped
  const nowMin = useMemo(() => {
    if (rows.length) {
      const lastCandle = [...rows].reverse().find((r) => r.kind === "candle");
      if (lastCandle) return lastCandle.minute;
    }
    const openSec = todaysOpenEpochSec();
    return Math.max(0, Math.min(RTH_MINUTES, Math.floor((Date.now() / 1000 - openSec) / 60)));
  }, [rows]);

  // x ticks every 30min
  const xTicks = useMemo(() => {
    const arr: number[] = [];
    for (let m = 0; m <= RTH_MINUTES; m += 30) arr.push(m);
    return arr;
  }, []);

  const fmtTickMin = (m: number) => {
    // 0 = 9:30 ET
    const total = 9 * 60 + 30 + m;
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${mm.toString().padStart(2, "0")}`;
  };

  // ── interpretation text ──────────────────────────────────────────────────
  const q50Pct = q60q50Pct != null ? q60q50Pct * 100 : null;
  const bandWidthDollars = q60Lo != null && q60Hi != null ? q60Hi - q60Lo : null;
  const bandWidthPct = bandWidthDollars != null && lastCandleClose ? (bandWidthDollars / lastCandleClose) * 100 : null;

  const direction = useMemo(() => {
    if (q50Pct == null) return null;
    if (q50Pct > 0.1) return { tone: "bullish", text: `model leans bullish: +${q50Pct.toFixed(2)}% over 60min` };
    if (q50Pct < -0.1) return { tone: "bearish", text: `model leans bearish: ${q50Pct.toFixed(2)}% over 60min` };
    return { tone: "flat", text: "no directional edge — flat projection. trade range, not direction." };
  }, [q50Pct]);

  const conviction = useMemo(() => {
    if (bandWidthPct == null) return null;
    if (bandWidthPct > 1.0) return "low conviction — wide range";
    if (bandWidthPct < 0.4) return "tight range — high conviction";
    return "moderate conviction";
  }, [bandWidthPct]);

  // ── render ────────────────────────────────────────────────────────────────

  const onRefreshAll = () => {
    refetchOhlc();
    refetchProj();
  };

  return (
    <Card data-testid="panel-ml-projection" className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              SPX — projected path (next 60min)
            </CardTitle>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              live $SPX 5min bars + ML forward projection. extrapolated dashed past 60min to EOD.
            </div>
          </div>
          {currentSpot != null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              spot ${currentSpot.toFixed(2)}{usingFallback && " (fallback)"}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onRefreshAll}
            data-testid="button-refresh-ml-projection"
            title="refresh"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            refresh
          </Button>
        </div>

        <div className="mt-2">
          <MLStatusStrip />
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* training banner — show but don't hide chart */}
        {!isLoading && proj?.ok && isUntrained && (
          <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
            model retraining — projection may be unreliable
          </div>
        )}

        {/* ML 503 — show banner but try to render candles still */}
        {projError && !isLoading && (
          <div className="flex items-center justify-between gap-2 text-xs bg-destructive/10 border border-destructive/20 rounded px-2 py-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3 h-3 text-destructive" />
              <span className="text-muted-foreground">ML service unreachable — showing candles only</span>
            </div>
            <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={() => refetchProj()}>
              <RefreshCw className="w-3 h-3 mr-1" /> retry
            </Button>
          </div>
        )}

        {/* OHLC empty / off-hours hint */}
        {!isLoading && ohlc && ohlc.candles.length === 0 && (
          <div className="text-xs text-muted-foreground bg-muted/30 border border-border rounded px-2 py-1">
            market closed — last session shown. projection anchored on current spot.
          </div>
        )}

        {/* loading skeleton */}
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-[360px] w-full" />
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </div>
        )}

        {/* both errored — full empty state */}
        {!isLoading && ohlcError && projError && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertTriangle className="w-8 h-8 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              {(projErr as Error)?.message ?? "ML + OHLC services unreachable"}
            </div>
            <Button variant="outline" size="sm" onClick={onRefreshAll}>
              <RefreshCw className="w-3 h-3 mr-2" />
              retry
            </Button>
          </div>
        )}

        {/* main chart */}
        {!isLoading && !(ohlcError && projError) && (
          <>
            <div
              data-testid="chart-spx-projection"
              className="w-full"
              style={{ height: 360 }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={rows}
                  margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    opacity={0.35}
                  />
                  <XAxis
                    type="number"
                    dataKey="minute"
                    domain={[0, RTH_MINUTES]}
                    ticks={xTicks}
                    tickFormatter={fmtTickMin}
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={yDomain}
                    tickFormatter={(v) => v.toFixed(0)}
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    allowDecimals={false}
                  />
                  <Tooltip content={<ChartTooltip />} />

                  {/* lastClose reference */}
                  {lastCandleClose != null && (
                    <ReferenceLine
                      y={lastCandleClose}
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="3 3"
                      opacity={0.4}
                      label={{
                        value: rows.find((r) => r.kind === "candle" && r.minute === 0)
                          ? "open"
                          : "last close",
                        position: "right",
                        fill: "hsl(var(--muted-foreground))",
                        fontSize: 10,
                      }}
                    />
                  )}

                  {/* "now" vertical line */}
                  <ReferenceLine
                    x={nowMin}
                    stroke="hsl(var(--primary))"
                    strokeDasharray="2 4"
                    opacity={0.6}
                    label={{ value: "now", position: "top", fill: "hsl(var(--primary))", fontSize: 10 }}
                  />

                  {/* q10/q90 ribbon — stacked area trick: ribbonLo (transparent) + ribbonHi (filled) */}
                  <Area
                    type="monotone"
                    dataKey="ribbonLo"
                    stroke="none"
                    fill="transparent"
                    stackId="ribbon"
                    isAnimationActive={false}
                    legendType="none"
                    connectNulls
                  />
                  <Area
                    type="monotone"
                    dataKey="ribbonHi"
                    stroke="none"
                    fill="#0ea5e9"
                    fillOpacity={0.12}
                    stackId="ribbon"
                    isAnimationActive={false}
                    legendType="none"
                    connectNulls
                  />

                  {/* candles via custom layer */}
                  <Customized component={CandleLayer} />

                  {/* q50 projection line — bold cyan */}
                  <Line
                    type="monotone"
                    dataKey="proj"
                    stroke="#0ea5e9"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "#0ea5e9", strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                    connectNulls
                    legendType="none"
                  />

                  {/* dashed extrapolation past 60min */}
                  <Line
                    type="monotone"
                    dataKey="ext"
                    stroke="#0ea5e9"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                    legendType="none"
                    opacity={0.7}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* below-chart pair: key levels + interpretation */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div
                data-testid="box-ml-keylevels"
                className="border border-border/60 rounded-md p-3 bg-muted/20 text-xs space-y-1.5"
              >
                <div className="font-semibold text-foreground mb-1">key levels</div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">current SPX</span>
                  <span className="tabular-nums">{currentSpot != null ? `$${currentSpot.toFixed(2)}` : "—"}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">60min target (q50)</span>
                  <span className="tabular-nums font-semibold text-sky-500">{projTarget60 != null ? `$${projTarget60.toFixed(2)}` : "—"}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">implied 60min move</span>
                  <span className="tabular-nums">{q50Pct != null ? `${q50Pct >= 0 ? "+" : ""}${q50Pct.toFixed(2)}%` : "—"}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">band width (q90−q10)</span>
                  <span className="tabular-nums">{bandWidthDollars != null ? `$${bandWidthDollars.toFixed(2)}` : "—"}</span>
                </div>
              </div>

              <div
                data-testid="box-ml-interpretation"
                className="border border-border/60 rounded-md p-3 bg-muted/20 text-xs space-y-1.5"
              >
                <div className="font-semibold text-foreground mb-1">interpretation</div>
                {direction ? (
                  <div className={
                    direction.tone === "bullish" ? "text-green-500" :
                    direction.tone === "bearish" ? "text-red-500" :
                    "text-muted-foreground"
                  }>
                    {direction.text}
                  </div>
                ) : (
                  <div className="text-muted-foreground">awaiting projection…</div>
                )}
                {conviction && (
                  <div className="text-muted-foreground">{conviction}</div>
                )}
                {usingFallback && (
                  <div className="text-amber-500 text-[11px]">note: SPX feed unavailable — using SPY×10 proxy</div>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
