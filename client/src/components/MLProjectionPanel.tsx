// MLProjectionPanel.tsx — TOS-style SPY Forward Projection
//
// Live SPY 5min candles + dealer levels (rescaled SPX/10) + 3 forward path
// scenarios drawn into the future space (right of "now") in the style of a
// ThinkOrSwim chart: bull (q90) green dashed, base (q50) bold white, bear
// (q10) red dashed. All anchored at the last candle close, extended through
// the 60min ML horizon and linearly extrapolated to the 4:00 ET close,
// capped ±1.5%.
//
// When the Schwab tape is empty the server hands back a deterministic
// synthetic GBM walk anchored on /api/snapshot — those candles are greyed
// out with a "TAPE SYNTHETIC" watermark and a banner above the chart so the
// distinction is unambiguous.
//
// Honesty rules:
//   • Gamma-snap is applied to the BASE line only (it is a deterministic
//     post-process). Bull/bear are scenarios, not predictions, and stay
//     untouched.
//   • Linear extrapolation past 60min uses the 30→60 slope, capped ±1.5%,
//     and ends at 16:00 ET.
//
// No localStorage / sessionStorage / cookies. No emojis.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ComposedChart,
  Line,
  Area,
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
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  synthetic?: boolean;
}

interface GammaLevelEntry {
  value: number;
  source: "computed" | "user_targets";
}

interface GammaLevels {
  gammaFlip: GammaLevelEntry | null;
  callWall: GammaLevelEntry;
  putWall: GammaLevelEntry;
  topGexStrikes: Array<{ strike: number; gex: number }>;
  vanna: GammaLevelEntry | null;
  charm: GammaLevelEntry | null;
  vommaUpper: GammaLevelEntry | null;
  vommaLower: GammaLevelEntry | null;
  zomma: GammaLevelEntry | null;
  negGamma: GammaLevelEntry | null;
  mopex: GammaLevelEntry | null;
  weeklyTargets: {
    upside: GammaLevelEntry;
    downside: GammaLevelEntry;
    t2Up: GammaLevelEntry;
    t2Down: GammaLevelEntry;
  };
  spxNow: number;
  asOf: string;
}

interface MorningPayload {
  ready: boolean;
  anchorTimeEt: string | null;
  fingerprint: Record<string, number> | null;
  projection: {
    bands: Record<string, QuantileBand> | null;
    status: string;
    version: string;
  } | null;
}

interface BlendPayload {
  weight: number;
  activeModel: "v3" | "blend" | "morning";
  bands: Record<string, QuantileBand> | null;
}

interface ProjectionSpyResponse {
  ok: boolean;
  candles: OHLCCandle[];
  spot: number | null;
  prevClose: number | null;
  levels: GammaLevels | null;
  projection: {
    bands: Record<string, QuantileBand> | null;
    status: string;
    version: string;
  };
  morning?: MorningPayload;
  blend?: BlendPayload;
  features: Record<string, number>;
  synthetic?: boolean;
  syntheticReason?: string | null;
  asOf: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RTH_OPEN_MIN = 0;       // 9:30 ET
const RTH_CLOSE_MIN = 390;    // 16:00 ET (390 minutes after open)
const HORIZONS_V3 = [5, 15, 30, 60];
const HORIZONS_MORNING = [30, 60, 120, 180, 240];

const COLOR_BULL = "#10b981";   // green
const COLOR_BEAR = "#ef4444";   // red
const COLOR_BASE = "#ffffff";   // white bold
const COLOR_UP_BODY = "#10b981";
const COLOR_UP_BORDER = "#047857";
const COLOR_DN_BODY = "#ef4444";
const COLOR_DN_BORDER = "#b91c1c";
const COLOR_SYNTH_UP = "#6b7280";
const COLOR_SYNTH_DN = "#4b5563";
const COLOR_SYNTH_BORDER = "#374151";

// ─── Time helpers ────────────────────────────────────────────────────────────

function epochToMinuteOfDay(epochSec: number): number {
  const d = new Date(epochSec * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "9");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "30");
  return (h - 9) * 60 + m - 30;
}

function nowMinuteOfDay(): number {
  return epochToMinuteOfDay(Math.floor(Date.now() / 1000));
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

function fmtMinuteAxis(min: number): string {
  // min is minutes from 9:30 ET
  const totalMin = 9 * 60 + 30 + min;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

// ─── Status strip (preserved testids) ────────────────────────────────────────

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "TRAINED") return "default";
  if (s === "BOOTSTRAP") return "secondary";
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
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-2 text-xs"
          onClick={() => refetch()}
        >
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

// ─── Chart math helpers ──────────────────────────────────────────────────────

interface LevelSpec {
  key: string;
  label: string;
  value: number;
  color: string;
  dash?: string;
  weight: number;
  emphasis?: boolean;
}

function nearestLevel(
  price: number,
  levels: LevelSpec[],
  bandPct = 0.005,
): LevelSpec | null {
  if (!levels.length) return null;
  let best: LevelSpec | null = null;
  let bestDist = Infinity;
  for (const l of levels) {
    const d = Math.abs(l.value - price) / price;
    if (d < bandPct && d < bestDist) {
      best = l;
      bestDist = d;
    }
  }
  return best;
}

// ─── Custom candle layer (Customized component) ──────────────────────────────

function CandlesLayer(props: any) {
  const { xAxisMap, yAxisMap, candleData } = props;
  if (!candleData || candleData.length === 0) return null;
  const xAxis = xAxisMap?.[Object.keys(xAxisMap)[0]];
  const yAxis = yAxisMap?.[Object.keys(yAxisMap)[0]];
  if (!xAxis || !yAxis) return null;

  // Recharts axes provide a `scale` function (d3 scale) to map data → pixel.
  const xScale: (v: number) => number = xAxis.scale;
  const yScale: (v: number) => number = yAxis.scale;

  const bodyW = 4;
  return (
    <g>
      {candleData.map((c: any, i: number) => {
        const x = xScale(c.minute);
        if (!Number.isFinite(x)) return null;
        const yO = yScale(c.o);
        const yC = yScale(c.c);
        const yH = yScale(c.h);
        const yL = yScale(c.l);
        if (![yO, yC, yH, yL].every(Number.isFinite)) return null;
        const isUp = c.c >= c.o;
        const synth = !!c.synthetic;
        const fill = synth
          ? (isUp ? COLOR_SYNTH_UP : COLOR_SYNTH_DN)
          : (isUp ? COLOR_UP_BODY : COLOR_DN_BODY);
        const stroke = synth
          ? COLOR_SYNTH_BORDER
          : (isUp ? COLOR_UP_BORDER : COLOR_DN_BORDER);
        const opacity = synth ? 0.55 : 1;
        const top = Math.min(yO, yC);
        const h = Math.max(1, Math.abs(yC - yO));
        return (
          <g key={`cdl-${i}`} opacity={opacity}>
            <line
              x1={x}
              x2={x}
              y1={yH}
              y2={yL}
              stroke={stroke}
              strokeWidth={1}
              strokeDasharray={synth ? "2 2" : undefined}
            />
            <rect
              x={x - bodyW / 2}
              y={top}
              width={bodyW}
              height={h}
              fill={fill}
              stroke={stroke}
              strokeWidth={1}
            />
          </g>
        );
      })}
    </g>
  );
}

// Synthetic watermark
function SyntheticWatermark(props: any) {
  const { offset } = props;
  const { left = 60, top = 10, width = 600 } = offset || {};
  return (
    <text
      x={left + width - 10}
      y={top + 22}
      textAnchor="end"
      fontSize={11}
      fontWeight={700}
      fill="#f59e0b"
      opacity={0.85}
      style={{ letterSpacing: "0.12em" }}
    >
      SYNTHETIC
    </text>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

// Model status pill (which model is producing the projection now)
function ModelStatusPill({
  activeModel,
  weight,
  morningReady,
}: {
  activeModel: "v3" | "blend" | "morning";
  weight: number;
  morningReady: boolean;
}) {
  let label = "v3 (intraday)";
  let cls = "bg-slate-700/60 text-slate-200 border-slate-600";
  if (activeModel === "morning") {
    label = `morning anchor ${(weight * 100).toFixed(0)}%`;
    cls = "bg-cyan-500/15 text-cyan-200 border-cyan-500/40";
  } else if (activeModel === "blend") {
    label = `blend (morning ${(weight * 100).toFixed(0)}%)`;
    cls = "bg-violet-500/15 text-violet-200 border-violet-500/40";
  } else if (morningReady) {
    label = "v3 (morning warmup)";
    cls = "bg-amber-500/15 text-amber-200 border-amber-500/40";
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium font-mono ${cls}`}
      data-testid="badge-ml-active-model"
      title="Active model producing the forward projection"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      {label}
    </span>
  );
}

export default function MLProjectionPanel() {
  const isRth = useMemo(() => {
    const m = nowMinuteOfDay();
    return m >= 0 && m <= 390;
  }, []);

  const { data, isLoading, error, refetch, isRefetching } = useQuery<ProjectionSpyResponse>({
    queryKey: ["/api/ml/projection-spy"],
    queryFn: () =>
      apiRequest("GET", "/api/ml/projection-spy").then((r) => r.json()),
    // RTH: 5s chart re-render cadence per user spec. Off-hours: 5min.
    refetchInterval: isRth ? 5_000 : 5 * 60_000,
    retry: false,
  });

  const candles = data?.candles ?? [];
  const levels = data?.levels ?? null;
  const v3Projection = data?.projection ?? null;
  const morning = data?.morning ?? null;
  const blend = data?.blend ?? null;
  const features = data?.features ?? {};
  const synthetic = !!data?.synthetic;
  const syntheticReason = data?.syntheticReason ?? null;
  const spot = data?.spot ?? candles[candles.length - 1]?.c ?? null;

  // Choose effective bands: blended if available, else v3.
  const effectiveBands = blend?.bands && Object.keys(blend.bands).length > 0
    ? blend.bands
    : v3Projection?.bands ?? null;
  const activeModel = blend?.activeModel ?? "v3";
  const blendWeight = blend?.weight ?? 0;
  const projection = effectiveBands
    ? { bands: effectiveBands, status: v3Projection?.status ?? "UNAVAILABLE", version: v3Projection?.version ?? "" }
    : v3Projection;

  // Horizons available depend on which model produced the bands.
  const activeHorizons = useMemo(() => {
    if (!effectiveBands) return HORIZONS_V3;
    const hs = Object.keys(effectiveBands).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    return hs.length > 0 ? hs : HORIZONS_V3;
  }, [effectiveBands]);

  // Build LevelSpec list
  const levelSpecs = useMemo<LevelSpec[]>(() => {
    if (!levels) return [];
    const specs: LevelSpec[] = [];
    const push = (
      key: string,
      label: string,
      v: number | null | undefined,
      color: string,
      dash: string | undefined,
      weight: number,
      emphasis = false,
    ) => {
      if (v == null || !Number.isFinite(v) || v <= 0) return;
      specs.push({ key, label, value: v, color, dash, weight, emphasis });
    };
    push("upVomma", "UP VOMMA", levels.vommaUpper?.value, "#22c55e", "6 4", 1);
    push("callWall", "CALL WALL", levels.callWall?.value, "#22c55e", undefined, 2, true);
    push("zomma", "ZOMMA", levels.zomma?.value, "#22d3ee", "6 4", 1);
    push("flip", "0-Γ FLIP", levels.gammaFlip?.value, "#ef4444", "6 4", 2, true);
    push("maxPain", "MAX PAIN", levels.mopex?.value, "#facc15", "4 4", 1);
    push("putWall", "PUT WALL", levels.putWall?.value, "#ef4444", undefined, 2, true);
    push("dnVomma", "DN VOMMA", levels.vommaLower?.value, "#fb923c", "6 4", 1);
    for (let i = 0; i < (levels.topGexStrikes ?? []).slice(0, 3).length; i++) {
      const s = levels.topGexStrikes[i];
      push(`gex-${i}`, `GEX ${s.strike.toFixed(0)}`, s.strike, "#94a3b8", "2 4", 0.6);
    }
    push("upside", "UPSIDE", levels.weeklyTargets?.upside?.value, "#67e8f9", "2 4", 0.6);
    push("downside", "DOWNSIDE", levels.weeklyTargets?.downside?.value, "#fca5a5", "2 4", 0.6);
    return specs;
  }, [levels]);

  // Candle rows enriched with minute-of-day for chart x positioning.
  const candleRows = useMemo(
    () =>
      candles
        .map((c) => ({
          minute: epochToMinuteOfDay(c.t),
          o: c.o,
          h: c.h,
          l: c.l,
          c: c.c,
          v: c.v,
          synthetic: c.synthetic,
          t: c.t,
        }))
        .filter((r) => r.minute >= -10 && r.minute <= 400),
    [candles],
  );

  const lastCandle = candleRows[candleRows.length - 1] ?? null;
  const anchorMinute = lastCandle?.minute ?? nowMinuteOfDay();
  const anchorPrice = lastCandle?.c ?? spot ?? 0;

  // Forward projection rows for bull/base/bear at 5/15/30/60min + linear ext.
  const pathRows = useMemo(() => {
    if (!projection?.bands || !anchorPrice || anchorPrice <= 0) {
      return [] as Array<{
        minute: number;
        bull: number;
        base: number;
        bear: number;
        snapApplied: boolean;
        nearest: string | null;
      }>;
    }
    const netGexSign = features.net_gex_sign ?? 0;
    const out: Array<{
      minute: number;
      bull: number;
      base: number;
      bear: number;
      snapApplied: boolean;
      nearest: string | null;
    }> = [];

    // Anchor row so paths start exactly at last close.
    out.push({
      minute: anchorMinute,
      bull: anchorPrice,
      base: anchorPrice,
      bear: anchorPrice,
      snapApplied: false,
      nearest: null,
    });

    for (const h of activeHorizons) {
      const band = projection.bands[String(h)];
      if (!band) continue;
      const bullPx = anchorPrice * (1 + band.q90);
      const bearPx = anchorPrice * (1 + band.q10);
      let basePx = anchorPrice * (1 + band.q50);

      // Gamma-snap to BASE only.
      let snapApplied = false;
      let nearestKey: string | null = null;
      const near = nearestLevel(basePx, levelSpecs, 0.005);
      if (near) {
        nearestKey = near.label;
        if (netGexSign > 0) {
          basePx = basePx + (near.value - basePx) * 0.25;
          snapApplied = true;
        } else if (netGexSign < 0) {
          basePx = basePx - (near.value - basePx) * 0.15;
          snapApplied = true;
        }
      }

      out.push({
        minute: anchorMinute + h,
        bull: bullPx,
        base: basePx,
        bear: bearPx,
        snapApplied,
        nearest: nearestKey,
      });
    }
    return out;
  }, [projection, levelSpecs, anchorPrice, anchorMinute, features.net_gex_sign, activeHorizons]);

  // Linear extrapolation of each path's 30→60 slope to RTH close, capped ±1.5%.
  const extRows = useMemo(() => {
    if (pathRows.length < 3) return [] as Array<{
      minute: number;
      bullExt: number;
      baseExt: number;
      bearExt: number;
    }>;
    const last = pathRows[pathRows.length - 1];
    const prev = pathRows[pathRows.length - 2];
    if (!last || !prev || last.minute >= RTH_CLOSE_MIN) return [];
    const dm = Math.max(1, last.minute - prev.minute);
    const slopeBull = (last.bull - prev.bull) / dm;
    const slopeBase = (last.base - prev.base) / dm;
    const slopeBear = (last.bear - prev.bear) / dm;
    const cap = anchorPrice * 0.015;
    const cl = (raw: number) =>
      raw > anchorPrice + cap
        ? anchorPrice + cap
        : raw < anchorPrice - cap
          ? anchorPrice - cap
          : raw;
    const out: Array<{ minute: number; bullExt: number; baseExt: number; bearExt: number }> = [
      { minute: last.minute, bullExt: last.bull, baseExt: last.base, bearExt: last.bear },
    ];
    for (let m = last.minute + 5; m <= RTH_CLOSE_MIN; m += 5) {
      const dt = m - last.minute;
      out.push({
        minute: m,
        bullExt: cl(last.bull + slopeBull * dt),
        baseExt: cl(last.base + slopeBase * dt),
        bearExt: cl(last.bear + slopeBear * dt),
      });
    }
    return out;
  }, [pathRows, anchorPrice]);

  // Chart data — keyed on minute. Lines pull from this; candles render via custom layer.
  const chartData = useMemo(() => {
    const byMin = new Map<number, any>();
    const ensure = (m: number) => {
      if (!byMin.has(m)) byMin.set(m, { minute: m });
      return byMin.get(m);
    };
    // Seed full RTH range so x-axis is stable even with tiny data.
    for (let m = 0; m <= RTH_CLOSE_MIN; m += 5) ensure(m);
    for (const c of candleRows) {
      const row = ensure(c.minute);
      row.o = c.o;
      row.h = c.h;
      row.l = c.l;
      row.c = c.c;
      row.v = c.v;
      row.synthetic = c.synthetic;
    }
    for (const p of pathRows) {
      const row = ensure(p.minute);
      row.bull = p.bull;
      row.base = p.base;
      row.bear = p.bear;
      row.snapApplied = p.snapApplied;
      row.nearest = p.nearest;
      // Stacked area pair: bear as base, (bull - bear) as the band thickness.
      row.bandLo = p.bear;
      row.bandHi = p.bull;
    }
    for (const e of extRows) {
      const row = ensure(e.minute);
      row.bullExt = e.bullExt;
      row.baseExt = e.baseExt;
      row.bearExt = e.bearExt;
      row.bandLoExt = e.bearExt;
      row.bandHiExt = e.bullExt;
    }
    return Array.from(byMin.values()).sort((a, b) => a.minute - b.minute);
  }, [candleRows, pathRows, extRows]);

  // Y-axis SAFETY — never default to 0..N. Always tight around the action.
  const yDomain = useMemo<[number, number]>(() => {
    const candlePrices: number[] = [];
    for (const r of candleRows) {
      if (r.l != null && r.l > 0) candlePrices.push(r.l);
      if (r.h != null && r.h > 0) candlePrices.push(r.h);
    }
    const projPrices: number[] = [];
    for (const p of pathRows) {
      if (p.bull > 0) projPrices.push(p.bull);
      if (p.base > 0) projPrices.push(p.base);
      if (p.bear > 0) projPrices.push(p.bear);
    }
    for (const e of extRows) {
      if (e.bullExt > 0) projPrices.push(e.bullExt);
      if (e.baseExt > 0) projPrices.push(e.baseExt);
      if (e.bearExt > 0) projPrices.push(e.bearExt);
    }
    const levelPrices = levelSpecs
      .map((l) => l.value)
      .filter((v) => v != null && Number.isFinite(v) && v > 0);
    const all = [...candlePrices, ...projPrices, ...levelPrices].filter(
      (v) => Number.isFinite(v) && v > 0,
    );
    // If we only have spot, build a tight ±1.5% window so the chart shows real range.
    if (all.length === 0 && spot && spot > 0) {
      const half = spot * 0.015;
      return [spot - half, spot + half];
    }
    if (all.length === 0) {
      // Last-resort safe default — never 0..N
      return [400, 600];
    }
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    // Keep spot in view even if levels/projection drift
    if (spot && spot > 0) {
      lo = Math.min(lo, spot);
      hi = Math.max(hi, spot);
    }
    // Floor the window to at least ±0.5% around midpoint so a flat day still reads.
    const mid = (lo + hi) / 2;
    const minHalf = mid * 0.005;
    if ((hi - lo) / 2 < minHalf) {
      lo = mid - minHalf;
      hi = mid + minHalf;
    }
    const pad = Math.max((hi - lo) * 0.08, mid * 0.002);
    return [lo - pad, hi + pad];
  }, [candleRows, pathRows, extRows, levelSpecs, spot]);

  // Explicit y-axis ticks — recharts auto-ticks fail when domain is small
  const yTicks = useMemo<number[]>(() => {
    const [lo, hi] = yDomain;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
    const span = hi - lo;
    // Aim for 6 ticks. Pick a step that's a nice round number.
    const rawStep = span / 6;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let step: number;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3) step = 2 * mag;
    else if (norm < 7) step = 5 * mag;
    else step = 10 * mag;
    const start = Math.ceil(lo / step) * step;
    const ticks: number[] = [];
    for (let v = start; v <= hi + 1e-9; v += step) {
      ticks.push(Number(v.toFixed(6)));
      if (ticks.length > 12) break;
    }
    return ticks;
  }, [yDomain]);

  const nowMin = nowMinuteOfDay();
  const status = projection?.status ?? "UNAVAILABLE";

  // ── Render branches ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <Card data-testid="panel-ml-projection" className="border-border/60">
        <CardHeader>
          <CardTitle>SPY — Projected Path (60min ML + extrapolation to close)</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[480px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card data-testid="panel-ml-projection" className="border-border/60">
        <CardHeader>
          <CardTitle>SPY — Projected Path (60min ML + extrapolation to close)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <span className="text-muted-foreground">
              ML service unreachable
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              data-testid="button-refresh-ml-projection"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasCandles = candleRows.length > 0;
  const hasBands = !!projection?.bands;
  const isBootstrap = status === "BOOTSTRAP" || status === "INSUFFICIENT_DATA";

  // Distance + interpretation helpers
  const callDistPct =
    levels?.callWall?.value && spot
      ? (levels.callWall.value - spot) / spot
      : null;
  const putDistPct =
    levels?.putWall?.value && spot
      ? (levels.putWall.value - spot) / spot
      : null;
  const flipDistPct =
    levels?.gammaFlip?.value && spot
      ? (levels.gammaFlip.value - spot) / spot
      : null;
  const callDistDollar =
    levels?.callWall?.value && spot ? levels.callWall.value - spot : null;
  const putDistDollar =
    levels?.putWall?.value && spot ? levels.putWall.value - spot : null;
  const flipDistDollar =
    levels?.gammaFlip?.value && spot ? levels.gammaFlip.value - spot : null;

  const netGexSign = features.net_gex_sign ?? 0;
  const regimeLabel =
    netGexSign > 0 ? "positive gamma" : netGexSign < 0 ? "negative gamma" : "neutral";

  const proj60 = pathRows[pathRows.length - 1] ?? null;
  const bullPrice = proj60?.bull ?? null;
  const basePrice = proj60?.base ?? null;
  const bearPrice = proj60?.bear ?? null;
  const bandWidth = proj60 ? proj60.bull - proj60.bear : 0;
  const snapApplied = pathRows.some((p) => p.snapApplied);

  const pctVsAnchor = (px: number | null) =>
    px != null && anchorPrice ? (px - anchorPrice) / anchorPrice : null;

  // Plain-English interpretation
  const interpretations: string[] = [];
  if (synthetic) {
    interpretations.push(
      "tape simulated - read interpretation as rough regime context, not real intraday flow.",
    );
  }
  if (activeModel === "morning" || activeModel === "blend") {
    const fp = morning?.fingerprint;
    if (fp) {
      const orb = fp.morn_orb_range_atr;
      const drive = fp.morn_open_drive_atr;
      const volz = fp.morn_opening_vol_z;
      const driveDir = drive != null ? (drive > 0.3 ? "strong up drive" : drive < -0.3 ? "strong down drive" : "flat open") : "unknown drive";
      const volTag = volz != null && volz > 0.8 ? "hot opening volume" : volz != null && volz < -0.5 ? "cold opening volume" : "normal opening volume";
      const orbTag = orb != null ? `ORB ${orb.toFixed(2)} ATR` : "ORB n/a";
      interpretations.push(`morning anchor: ${driveDir}, ${volTag}, ${orbTag}.`);
    }
  }
  if (regimeLabel === "positive gamma") {
    interpretations.push("positive gamma — pin behavior. dealers buy dips, sell rips.");
  } else if (regimeLabel === "negative gamma") {
    interpretations.push("negative gamma — vol regime, moves accelerate.");
  } else {
    interpretations.push("neutral — near gamma flip, no dominant dealer hedging bias.");
  }
  if (callDistPct != null && Math.abs(callDistPct) < 0.005 && levels?.callWall?.value) {
    interpretations.push(
      `near call wall ($${fmtPrice(levels.callWall.value)}) — pin risk.`,
    );
  } else if (flipDistPct != null && flipDistPct > 0 && levels?.gammaFlip?.value) {
    interpretations.push(
      `below flip ($${fmtPrice(levels.gammaFlip.value)}) — momentum down has tailwind.`,
    );
  } else if (flipDistPct != null && flipDistPct < 0 && levels?.gammaFlip?.value) {
    interpretations.push(
      `above flip ($${fmtPrice(levels.gammaFlip.value)}) — buy-the-dip hedging supports floor.`,
    );
  } else if (callDistPct != null && putDistPct != null) {
    interpretations.push("between walls — directional flow drives the print.");
  }
  if (bandWidth > 0 && spot) {
    const widthPct = bandWidth / spot;
    if (widthPct < 0.004) {
      interpretations.push(`tight band ($${bandWidth.toFixed(2)} width) — high conviction.`);
    } else {
      interpretations.push(`wide band ($${bandWidth.toFixed(2)}) — low conviction, trade levels not direction.`);
    }
  }
  const topInterps = interpretations.slice(0, 3);

  return (
    <Card data-testid="panel-ml-projection" className="border-border/60">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-4 h-4" />
              SPY — Projected Path (60min ML + extrapolation to close)
            </CardTitle>
            <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
              live SPY 5min candles + dealer levels + 3 model forward scenarios. updates every 5s during RTH. morning anchor (Model D) blends in 9:45-16:00 ET when the opening fingerprint is ready.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ModelStatusPill activeModel={activeModel} weight={blendWeight} morningReady={!!morning?.ready} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isRefetching}
              data-testid="button-refresh-ml-projection"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isRefetching ? "animate-spin" : ""}`} />
              refresh
            </Button>
          </div>
        </div>
        <MLStatusStrip />
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Synthetic banner */}
        {synthetic && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 font-medium">
            TAPE SYNTHETIC — Schwab intraday unavailable. Candles simulated from current spot. Refresh when token resumes.
            {syntheticReason ? <span className="text-amber-300/70 font-normal ml-2">({syntheticReason})</span> : null}
          </div>
        )}

        {/* Empty-state banners */}
        {!hasCandles && spot == null && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
            tape and spot unavailable — diagnostic: check Schwab token + snapshot service.
          </div>
        )}
        {!hasCandles && spot != null && !synthetic && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            no intraday yet — pre-market. dealer levels still rendering.
          </div>
        )}
        {hasCandles && !hasBands && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
            forward projection unavailable — tape and dealer levels still rendering.
            <Button
              size="sm"
              variant="ghost"
              className="ml-2 h-6 px-2"
              onClick={() => refetch()}
            >
              retry
            </Button>
          </div>
        )}
        {isBootstrap && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            model retraining — projection may be unreliable until next training cycle completes.
          </div>
        )}

        {/* Chart */}
        <div
          className="w-full relative"
          style={{ height: 500 }}
          data-testid="chart-spy-projection"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 14, right: 110, bottom: 30, left: 10 }}
            >
              <defs>
                <linearGradient id="bandGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLOR_BULL} stopOpacity={0.18} />
                  <stop offset="50%" stopColor="#94a3b8" stopOpacity={0.06} />
                  <stop offset="100%" stopColor={COLOR_BEAR} stopOpacity={0.18} />
                </linearGradient>
                <linearGradient id="bandGradientExt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLOR_BULL} stopOpacity={0.10} />
                  <stop offset="50%" stopColor="#94a3b8" stopOpacity={0.04} />
                  <stop offset="100%" stopColor={COLOR_BEAR} stopOpacity={0.10} />
                </linearGradient>
                <filter id="baseGlow">
                  <feGaussianBlur stdDeviation="1.4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke="#334155" opacity={0.25} />
              <XAxis
                dataKey="minute"
                type="number"
                domain={[RTH_OPEN_MIN, RTH_CLOSE_MIN]}
                ticks={[0, 60, 120, 180, 240, 300, 390]}
                tickFormatter={fmtMinuteAxis}
                stroke="#64748b"
                fontSize={11}
              />
              <YAxis
                domain={yDomain}
                ticks={yTicks.length > 0 ? yTicks : undefined}
                tickFormatter={(v) => Number(v).toFixed(2)}
                stroke="#64748b"
                fontSize={11}
                width={70}
                allowDataOverflow={true}
                scale="linear"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={(min) => `${fmtMinuteAxis(Number(min))} ET`}
                formatter={(value: any, name: any, ctx: any) => {
                  if (value == null) return ["—", String(name)];
                  const row = ctx?.payload;
                  if (name === "bull") {
                    const p = pctVsAnchor(Number(value));
                    return [`$${fmtPrice(Number(value))}  ${fmtPct(p)}`, "bull (q90)"];
                  }
                  if (name === "base") {
                    const p = pctVsAnchor(Number(value));
                    const tag = row?.snapApplied ? ` (snap → ${row?.nearest ?? "wall"})` : "";
                    return [`$${fmtPrice(Number(value))}  ${fmtPct(p)}${tag}`, "base (q50)"];
                  }
                  if (name === "bear") {
                    const p = pctVsAnchor(Number(value));
                    return [`$${fmtPrice(Number(value))}  ${fmtPct(p)}`, "bear (q10)"];
                  }
                  if (name === "bullExt") {
                    return [`$${fmtPrice(Number(value))} (linear ext)`, "bull ext"];
                  }
                  if (name === "baseExt") {
                    return [`$${fmtPrice(Number(value))} (linear ext)`, "base ext"];
                  }
                  if (name === "bearExt") {
                    return [`$${fmtPrice(Number(value))} (linear ext)`, "bear ext"];
                  }
                  return [fmtPrice(Number(value)), String(name)];
                }}
              />

              {/* Layer 1 — Horizontal level lines */}
              {levelSpecs.map((l) => (
                <ReferenceLine
                  key={l.key}
                  y={l.value}
                  stroke={l.color}
                  strokeWidth={l.weight}
                  strokeDasharray={l.dash}
                  label={{
                    value: `${l.label}  ${l.value.toFixed(2)}`,
                    position: "right",
                    fill: l.color,
                    fontSize: l.emphasis ? 11 : 10,
                    fontWeight: l.emphasis ? 600 : 400,
                  }}
                  ifOverflow="extendDomain"
                />
              ))}

              {/* Anchor (last close) horizontal — pulsing cyan, current price reference */}
              {anchorPrice > 0 && (
                <ReferenceLine
                  y={anchorPrice}
                  stroke="#22d3ee"
                  strokeDasharray="4 3"
                  strokeWidth={1.25}
                  strokeOpacity={0.85}
                  ifOverflow="extendDomain"
                  className="animate-pulse"
                  label={{
                    value: `NOW $${anchorPrice.toFixed(2)}`,
                    position: "left",
                    fill: "#67e8f9",
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                />
              )}

              {/* Layer 2 — Real candles via Customized SVG layer */}
              <Customized
                component={(p: any) => (
                  <CandlesLayer {...p} candleData={candleRows} />
                )}
              />

              {/* Now line */}
              <ReferenceLine
                x={nowMin}
                stroke="#94a3b8"
                strokeDasharray="3 3"
                label={{ value: "NOW", position: "top", fill: "#cbd5e1", fontSize: 10, fontWeight: 600 }}
              />

              {/* Layer 3 — Gradient band fill (bear→bull envelope), 60-min path */}
              <Area
                type="monotone"
                dataKey="bandLo"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                connectNulls
                stackId="band"
                legendType="none"
              />
              <Area
                type="monotone"
                dataKey={(d: any) =>
                  d.bandLo != null && d.bandHi != null ? d.bandHi - d.bandLo : null
                }
                stroke="none"
                fill="url(#bandGradient)"
                isAnimationActive={false}
                connectNulls
                stackId="band"
                legendType="none"
              />
              {/* Extrapolated band fill, lighter */}
              <Area
                type="monotone"
                dataKey="bandLoExt"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                connectNulls
                stackId="bandExt"
                legendType="none"
              />
              <Area
                type="monotone"
                dataKey={(d: any) =>
                  d.bandLoExt != null && d.bandHiExt != null ? d.bandHiExt - d.bandLoExt : null
                }
                stroke="none"
                fill="url(#bandGradientExt)"
                isAnimationActive={false}
                connectNulls
                stackId="bandExt"
                legendType="none"
              />

              {/* Layer 4 — Forward projection paths (drawn right of "now") */}
              {/* Bull (green dashed) */}
              <Line
                type="monotone"
                dataKey="bull"
                stroke={COLOR_BULL}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{ r: 3, fill: COLOR_BULL, stroke: "#0f172a", strokeWidth: 1 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
                connectNulls
              />
              {/* Bear (red dashed) */}
              <Line
                type="monotone"
                dataKey="bear"
                stroke={COLOR_BEAR}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{ r: 3, fill: COLOR_BEAR, stroke: "#0f172a", strokeWidth: 1 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
                connectNulls
              />
              {/* Base (white bold, glow) */}
              <Line
                type="monotone"
                dataKey="base"
                stroke={COLOR_BASE}
                strokeWidth={3.25}
                strokeOpacity={1}
                filter="url(#baseGlow)"
                dot={{ r: 4, fill: COLOR_BASE, stroke: "#0f172a", strokeWidth: 1.25 }}
                activeDot={{ r: 6 }}
                isAnimationActive={false}
                connectNulls
              />

              {/* Linear extrapolations — same colors, thinner + dashed */}
              <Line
                type="monotone"
                dataKey="bullExt"
                stroke={COLOR_BULL}
                strokeWidth={1.5}
                strokeDasharray="2 4"
                strokeOpacity={0.7}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="bearExt"
                stroke={COLOR_BEAR}
                strokeWidth={1.5}
                strokeDasharray="2 4"
                strokeOpacity={0.7}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="baseExt"
                stroke={COLOR_BASE}
                strokeWidth={1.75}
                strokeDasharray="2 4"
                strokeOpacity={0.85}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />

              {/* Synthetic watermark */}
              {synthetic && (
                <Customized component={(p: any) => <SyntheticWatermark {...p} />} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Three-column info grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* KEY LEVELS */}
          <div
            className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5"
            data-testid="box-ml-keylevels"
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              key levels
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">spot</span>
              <span className="font-mono">
                ${fmtPrice(spot)}{" "}
                <span className={`text-xs ${synthetic ? "text-amber-400" : "text-emerald-400"}`}>
                  {synthetic ? "synthetic" : "live"}
                </span>
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">to call wall</span>
              <span className="font-mono text-emerald-400">
                {fmtPct(callDistPct)}
                {callDistDollar != null ? ` ($${callDistDollar.toFixed(2)})` : ""}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">to put wall</span>
              <span className="font-mono text-rose-400">
                {fmtPct(putDistPct)}
                {putDistDollar != null ? ` ($${putDistDollar.toFixed(2)})` : ""}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">to flip</span>
              <span className="font-mono">
                {fmtPct(flipDistPct)}
                {flipDistDollar != null ? ` ($${flipDistDollar.toFixed(2)})` : ""}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">regime</span>
              <Badge
                variant={netGexSign > 0 ? "default" : netGexSign < 0 ? "destructive" : "secondary"}
                className="h-5 text-xs"
              >
                {regimeLabel}
              </Badge>
            </div>
          </div>

          {/* SCENARIOS */}
          <div
            className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5"
            data-testid="box-ml-projection-summary"
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center justify-between">
              <span>scenarios ({activeHorizons[activeHorizons.length - 1] ?? 60}min)</span>
              {(activeModel === "morning" || activeModel === "blend") && morning?.anchorTimeEt && (
                <span className="font-mono normal-case text-[10px] text-cyan-300/80">anchor {morning.anchorTimeEt}</span>
              )}
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-emerald-400">bull (q90)</span>
              <span className="font-mono text-emerald-400">
                ${fmtPrice(bullPrice)} ({fmtPct(pctVsAnchor(bullPrice))})
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-foreground font-semibold">base (q50)</span>
              <span className="font-mono text-foreground font-semibold">
                ${fmtPrice(basePrice)} ({fmtPct(pctVsAnchor(basePrice))})
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-rose-400">bear (q10)</span>
              <span className="font-mono text-rose-400">
                ${fmtPrice(bearPrice)} ({fmtPct(pctVsAnchor(bearPrice))})
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">band width</span>
              <span className="font-mono">${bandWidth.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">gamma-snap</span>
              <Badge variant={snapApplied ? "default" : "outline"} className="h-5 text-xs">
                {snapApplied ? "applied" : "not applied"}
              </Badge>
            </div>
          </div>

          {/* INTERPRETATION */}
          <div
            className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5"
            data-testid="box-ml-interpretation"
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              interpretation
            </div>
            <ul className="space-y-1.5 text-sm leading-relaxed">
              {topInterps.length === 0 ? (
                <li className="text-muted-foreground">building reading…</li>
              ) : (
                topInterps.map((s, i) => (
                  <li key={i} className="text-foreground/90">
                    {s}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
