// MLProjectionPanel.tsx — TOS-style SPY Forward Projection
//
// Live SPY 5min candles + dealer levels ($SPX chain x live SPY/SPX ratio) + 3 forward path
// scenarios drawn into the future space (right of "now") in the style of a
// ThinkOrSwim chart: bull (q90) green dashed, base (q50) bold white, bear
// (q10) red dashed. All anchored at the last candle close, extended through
// the 60min ML horizon and linearly extrapolated to the 4:00 ET close,
// capped ±1.5%.
//
// When the Schwab tape is empty the server returns no candles and
// dataState "no_data" with a reason; the panel shows NO INTRADAY DATA and
// never draws invented candles (the old server filled the gap with a
// simulated walk). The synthetic flag below is kept for older payloads.
//
// Honesty rules (R2-F items 3, 4, 5, 8):
//   • The drawn band is the server's `served` band: a quantile model only if
//     it was trained on real data AND passed the walk-forward promotion gate
//     against a baseline volatility cone; otherwise the baseline cone itself.
//     The label lists every component (`served.label`); the morning-anchor
//     model is blended in only under the same gate.
//   • The base line is the band's q50, unadjusted (the old gamma-snap moved it
//     toward dealer levels with an untested rule, so the drawn line was not
//     the scored median).
//   • Past the last model horizon the paths are a linear extension of the
//     30->60 slope, capped ±1.5%, to 16:00 ET: drawn lighter, labeled, and
//     NOT scored.
//   • The verdict strip is neutral grey unless a promoted real-data model
//     contributes to the band (a baseline cone has zero drift by design).
//   • Live coverage of the drawn 10-90% band (/api/ml/coverage, same
//     model + version keys) is shown per horizon: Wilson 95% interval,
//     Kupiec and Christoffersen tests.
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
import EdgeInfo from "./EdgeInfo";

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
  /** Quantile models: a version passed the promotion gate and is served. */
  promoted?: boolean;
  served_version?: number | null;
  latest_version?: number | null;
  latest_status?: string | null;
  latest_training_data?: string | null;
  /** Optional; absent = treat as simulated. Set to "real" only by a real-data retrain. */
  /** ml_service meta value, e.g. "synthetic_gbm" or "real". Anything other than
   *  "real" (including absent/null) is treated as simulated training. */
  training_data?: string | null;
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
  callWall: GammaLevelEntry | null;
  putWall: GammaLevelEntry | null;
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
  /** Server (R2-F): levels come from the Schwab $SPX chain; "unavailable" with a reason otherwise. */
  dataState?: "ok" | "unavailable";
  reason?: string | null;
  display?: string;
  scale?: number | null;
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

interface ServedComponent {
  name: "quantile_overlay" | "morning_anchor" | "baseline_cone";
  version: string;
  trainingData: string | null;
  promoted: boolean;
  weight: number;
  horizons: number[];
  note: string;
}

interface ServedBandPayload {
  source: "quantile_overlay" | "baseline_cone" | "unavailable";
  bands: Record<string, QuantileBand> | null;
  components: ServedComponent[];
  learned: boolean;
  label: string;
  reason: string | null;
  coverageModel: string;
  coverageVersion: string;
  trainingData: string | null;
}

interface CoverageRow {
  horizonMin: number;
  n: number;
  covered: number;
  rate: number | null;
  wilsonLo: number | null;
  wilsonHi: number | null;
  kupiecP: number | null;
  independenceP: number | null;
}

interface CoverageReportPayload {
  nominal: number;
  model: string | null;
  version: string | null;
  pooled: Array<CoverageRow & { windowDays: number }>;
  daily: Array<CoverageRow & { day: string }>;
  pending: number;
  noPrice: number;
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
  /** null = feature missing (input unavailable), never 0. */
  features: Record<string, number | null>;
  /** The band actually drawn and scored, with every component named. */
  served?: ServedBandPayload;
  synthetic?: boolean;
  syntheticReason?: string | null;
  /** "ok" = real bars; "no_data" = empty tape (dataStateReason says why). */
  dataState?: "ok" | "no_data";
  dataStateReason?: string | null;
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

const BASELINE_LABEL = "baseline volatility cone";

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
        <Badge variant="outline" className="text-xs h-5 text-muted-foreground" title="Retired: no consumer; pooled whale and regime labels; 80-row gate.">
          {score_calibrator?.status === "RETIRED" ? "RETIRED" : (score_calibrator?.status ?? "—")}
        </Badge>
      </div>
      <Separator orientation="vertical" className="h-4 self-center" />
      <div className="flex items-center gap-1.5" data-testid="text-ml-status-quantile_overlay">
        <span className="text-muted-foreground font-medium">quantile_overlay</span>
        {quantile_overlay?.promoted ? (
          <Badge variant="default" className="text-xs h-5 text-green-500" title="Real-data model that passed the walk-forward promotion gate against the baseline cone.">
            PROMOTED v{quantile_overlay.served_version ?? quantile_overlay.version}
          </Badge>
        ) : (
          <Badge
            variant="secondary"
            className="text-xs h-5 text-amber-500"
            title="No quantile model has passed the promotion gate; the panel draws the baseline volatility cone."
            data-testid="badge-ml-sim-trained"
          >
            NOT SERVED
          </Badge>
        )}
        {!quantile_overlay?.promoted && quantile_overlay?.latest_version != null && (
          <span className="text-muted-foreground">
            latest v{quantile_overlay.latest_version}
            {quantile_overlay.latest_training_data && quantile_overlay.latest_training_data !== "real" ? " (simulated training)" : quantile_overlay.latest_status ? ` (${quantile_overlay.latest_status.toLowerCase()})` : ""}
          </span>
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

// Status pill: every component of the drawn band, with its weight.
function ModelStatusPill({ served }: { served: ServedBandPayload | null }) {
  let label = "no band";
  let cls = "bg-slate-700/60 text-slate-200 border-slate-600";
  if (served && served.components.length > 0) {
    label = served.components
      .map((c) => c.name === "baseline_cone" ? "baseline cone"
        : c.name === "quantile_overlay" ? `model v${c.version}${c.weight < 1 ? ` ${(c.weight * 100).toFixed(0)}%` : ""}`
        : `morning v${c.version} ${(c.weight * 100).toFixed(0)}%`)
      .join(" + ");
    cls = served.learned ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/40" : "bg-amber-500/15 text-amber-200 border-amber-500/40";
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium font-mono ${cls}`}
      data-testid="badge-ml-active-model"
      title={served?.label ?? "No band is drawn"}
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
  // Same query key as MLStatusStrip, so react-query shares one request.
  const { data: health } = useQuery<HealthResponse>({
    queryKey: ["/api/ml/health"],
    queryFn: () => apiRequest("GET", "/api/ml/health").then((r) => r.json()),
    refetchInterval: 60_000,
    retry: false,
  });
  void health;
  const served = data?.served ?? null;
  // Learned = a promoted real-data model contributes to the drawn band.
  const learned = served?.learned === true;
  const bandLabel = served?.label ?? BASELINE_LABEL;

  const candles = data?.candles ?? [];
  const levels = data?.levels ?? null;
  const v3Projection = data?.projection ?? null;
  const morning = data?.morning ?? null;
  const blend = data?.blend ?? null;
  const features = data?.features ?? {};
  const synthetic = !!data?.synthetic;
  const syntheticReason = data?.syntheticReason ?? null;
  const noData = data != null && (data.dataState === "no_data" || (data.candles ?? []).length === 0);
  const noDataReason = data?.dataStateReason ?? null;
  const spot = data?.spot ?? candles[candles.length - 1]?.c ?? null;

  // Drawn bands = the server's served band (also what coverage scores).
  // Older payloads without `served` fall back to blend / raw projection.
  const effectiveBands = served
    ? served.bands
    : blend?.bands && Object.keys(blend.bands).length > 0
      ? blend.bands
      : v3Projection?.bands ?? null;
  const activeModel = blend?.activeModel ?? "v3";
  const projection = effectiveBands
    ? { bands: effectiveBands, status: learned ? "PROMOTED" : "BASELINE", version: served?.coverageVersion ?? v3Projection?.version ?? "" }
    : v3Projection;

  // Live coverage of THIS band (same model + version keys as the logger).
  const covKey = served && served.coverageModel !== "none" ? `model=${encodeURIComponent(served.coverageModel)}&version=${encodeURIComponent(served.coverageVersion)}` : null;
  const { data: coverage } = useQuery<CoverageReportPayload>({
    queryKey: ["/api/ml/coverage", covKey],
    queryFn: () => apiRequest("GET", `/api/ml/coverage?days=30&${covKey}`).then((r) => r.json()),
    enabled: !!covKey,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

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
      // Base = the band's median, unadjusted (what coverage and the label describe).
      const basePx = anchorPrice * (1 + band.q50);
      const snapApplied = false;
      const near = nearestLevel(basePx, levelSpecs, 0.005);
      const nearestKey: string | null = near ? near.label : null;

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
  }, [projection, levelSpecs, anchorPrice, anchorMinute, activeHorizons]);

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
          <CardTitle>SPY — Projected Path</CardTitle>
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
          <CardTitle>SPY — Projected Path</CardTitle>
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

  // null = dealer gamma unavailable (chain missing): never shown as neutral.
  const netGexSign = typeof features.net_gex_sign === "number" && Number.isFinite(features.net_gex_sign) ? features.net_gex_sign : null;
  const regimeLabel =
    netGexSign == null ? "unavailable" : netGexSign > 0 ? "positive gamma" : netGexSign < 0 ? "negative gamma" : "zero net gamma";

  const proj60 = pathRows[pathRows.length - 1] ?? null;
  const bullPrice = proj60?.bull ?? null;
  const basePrice = proj60?.base ?? null;
  const bearPrice = proj60?.bear ?? null;
  const bandWidth = proj60 ? proj60.bull - proj60.bear : 0;

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
  } else if (regimeLabel === "unavailable") {
    interpretations.push("dealer gamma unavailable (Schwab SPX chain missing or stale) — no regime read.");
  } else {
    interpretations.push("net dealer gamma about zero — no dominant hedging bias.");
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
      interpretations.push(`narrow cone ($${bandWidth.toFixed(2)} width) — width is not confidence; check live coverage below.`);
    } else {
      interpretations.push(`wide cone ($${bandWidth.toFixed(2)}) — trade levels, not direction.`);
    }
  }
  const topInterps = interpretations.slice(0, 3);

  // One-glance verdict — the single sentence a normal person needs.
  const leanPct = basePrice != null && spot ? (basePrice - spot) / spot : null;
  const lean: "UP" | "DOWN" | "FLAT" =
    leanPct == null ? "FLAT" : leanPct > 0.0008 ? "UP" : leanPct < -0.0008 ? "DOWN" : "FLAT";
  const convictionTight = bandWidth > 0 && spot ? bandWidth / spot < 0.004 : false;
  const verdictText =
    basePrice == null || spot == null
      ? (served?.source === "unavailable" ? `no band — ${served.reason ?? "inputs unavailable"}.` : "projection warming up — cone appears when there is enough tape.")
      : !learned
        ? `baseline volatility cone, zero drift: upper $${fmtPrice(bullPrice)}, lower $${fmtPrice(bearPrice)} at ${activeHorizons[activeHorizons.length - 1] ?? 60} min. not a directional forecast${served?.reason ? ` (${served.reason})` : ""}.`
        : lean === "FLAT"
          ? `model median flat — base path near $${fmtPrice(basePrice)}. ${convictionTight ? "narrow cone" : "wide cone: trade the levels, not a direction"}.`
          : `model median drifts ${lean === "UP" ? "higher" : "lower"} — base path $${fmtPrice(basePrice)} (${fmtPct(leanPct)}), upper $${fmtPrice(bullPrice)}, lower $${fmtPrice(bearPrice)}.`;
  // Colour only when a promoted real-data model is drawn (item 8); neutral otherwise.
  const verdictStyle =
    learned && lean === "UP" ? "border-emerald-800 bg-emerald-950/40 text-emerald-200"
    : learned && lean === "DOWN" ? "border-rose-800 bg-rose-950/40 text-rose-200"
    : "border-slate-700 bg-slate-900/60 text-slate-200";
  const verdictTag = !learned ? "BASELINE" : lean === "UP" ? "LEAN UP" : lean === "DOWN" ? "LEAN DOWN" : "FLAT";

  return (
    <Card data-testid="panel-ml-projection" className="border-border/60">
      <CardHeader className="space-y-2">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-4 h-4 shrink-0" />
              SPY — Projected Path
              <Badge
                variant="outline"
                className={`text-[10px] font-mono ${learned ? "border-emerald-500/50 text-emerald-400" : "border-amber-500/50 text-amber-400"}`}
                data-testid="badge-ml-cone-label"
                title={bandLabel}
              >
                {learned ? "promoted quantile model" : BASELINE_LABEL}
              </Badge>
              <EdgeInfo id="ml-forecast" />
            </CardTitle>
            <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed" data-testid="text-ml-band-label">
              drawn band: {bandLabel}. paths past the last horizon are a linear extension (lighter, not a forecast, not scored).
              live 10-90% coverage of this band is below. updates every 5s during market hours.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ModelStatusPill served={served} />
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

        {/* Empty-state banner: no intraday bars, nothing invented */}
        {noData && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground" data-testid="ml-no-data">
            NO INTRADAY DATA{noDataReason ? ` — ${noDataReason}` : ""}{spot == null ? " · spot offline (check Schwab token + snapshot service)" : ""}
          </div>
        )}
        {hasCandles && !hasBands && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
            no band drawn — {served?.reason ?? "waiting for the projection service"}
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

        {/* Verdict strip — one-glance read */}
        <div
          className={`flex items-center gap-3 rounded-md border px-3 py-2 ${verdictStyle}`}
          data-testid="ml-verdict-strip"
        >
          <span className="shrink-0 rounded bg-black/30 px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest">
            {verdictTag}
          </span>
          <span className="text-xs leading-snug">{verdictText}</span>
        </div>

        {/* Chart */}
        <div
          className="w-full relative"
          style={{ height: 500 }}
          data-testid="chart-spy-projection"
        >
          {!hasCandles && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center font-mono text-xs uppercase tracking-widest text-muted-foreground/70">
              no intraday data
            </div>
          )}
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
                    const tag = row?.nearest ? ` (near ${row.nearest})` : "";
                    return [`$${fmtPrice(Number(value))}  ${fmtPct(p)}${tag}`, "base (q50)"];
                  }
                  if (name === "bear") {
                    const p = pctVsAnchor(Number(value));
                    return [`$${fmtPrice(Number(value))}  ${fmtPct(p)}`, "bear (q10)"];
                  }
                  if (name === "bullExt") {
                    return [`$${fmtPrice(Number(value))} (linear extension, not scored)`, "bull ext"];
                  }
                  if (name === "baseExt") {
                    return [`$${fmtPrice(Number(value))} (linear extension, not scored)`, "base ext"];
                  }
                  if (name === "bearExt") {
                    return [`$${fmtPrice(Number(value))} (linear extension, not scored)`, "bear ext"];
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
            <p className="text-[10px] leading-snug text-muted-foreground/70">
              how far price sits from the walls and the flip — small distances mean the level is in play right now.
            </p>
            {levels?.dataState === "unavailable" && (
              <p className="text-[10px] leading-snug text-amber-400" data-testid="text-ml-levels-unavailable">
                dealer levels unavailable ({levels.reason ?? "unknown"}), not zero.
              </p>
            )}
            {levels?.dataState === "ok" && (
              <p className="text-[10px] leading-snug text-muted-foreground/70">
                from the Schwab $SPX option chain{levels.display === "SPY" && levels.scale ? `, x ${levels.scale.toFixed(5)} (live SPY/SPX quotes)` : ""}.
              </p>
            )}
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
                variant={netGexSign == null ? "outline" : netGexSign > 0 ? "default" : netGexSign < 0 ? "destructive" : "secondary"}
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
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground/70">
              {learned
                ? "base is the promoted model's median (q50); bull and bear are its 90th and 10th percentiles."
                : "baseline cone: base is its zero-drift median; bull and bear are its 90th and 10th percentiles. not a learned forecast."}
            </p>
            {(activeModel === "morning" || activeModel === "blend") && morning?.anchorTimeEt && (
              <div className="font-mono text-[10px] text-cyan-300/80">anchor {morning.anchorTimeEt}</div>
            )}
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
              <span className="text-muted-foreground">base line</span>
              <span className="font-mono text-xs">q50, unadjusted</span>
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
            <p className="text-[10px] leading-snug text-muted-foreground/70">
              what the numbers mean in plain language — read this first, then check the levels.
            </p>
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

        <CoverageTable report={coverage ?? null} servedLabel={bandLabel} />
      </CardContent>
    </Card>
  );
}

// ─── Live coverage of the drawn band (R2-F item 4) ───────────────────────────

function fmtP(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function CoverageCells({ r }: { r: CoverageRow | undefined }) {
  if (!r || r.n === 0) {
    return <td className="px-2 py-1 text-muted-foreground" colSpan={3}>no scored forecasts yet</td>;
  }
  const off = r.wilsonLo != null && r.wilsonHi != null && (0.8 < r.wilsonLo || 0.8 > r.wilsonHi);
  return (
    <>
      <td className="px-2 py-1 font-mono text-right">{r.n}</td>
      <td className={`px-2 py-1 font-mono text-right ${off ? "text-amber-400" : ""}`}>
        {r.rate != null ? `${(r.rate * 100).toFixed(0)}%` : "—"}
      </td>
      <td className="px-2 py-1 font-mono text-right text-muted-foreground">
        {r.wilsonLo != null && r.wilsonHi != null ? `${(r.wilsonLo * 100).toFixed(0)}-${(r.wilsonHi * 100).toFixed(0)}%` : "—"}
      </td>
    </>
  );
}

function CoverageTable({ report, servedLabel }: { report: CoverageReportPayload | null; servedLabel: string }) {
  const latestDay = report?.daily?.[0]?.day ?? null;
  const horizons = (report?.pooled ?? []).map((p) => p.horizonMin);
  return (
    <div className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-2" data-testid="box-ml-coverage">
      <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
        live coverage of the drawn 10-90% band (nominal 80%)
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground/70">
        scored on realized SPX returns, one non-overlapping forecast per horizon window, for this exact band ({servedLabel}).
        95% Wilson interval; Kupiec p &lt; 0.05 rejects 80% coverage; Christoffersen p &lt; 0.05 means misses cluster.
        a different band (another model version, or the baseline) starts its own record.
      </p>
      {!report ? (
        <div className="text-xs text-muted-foreground">coverage unavailable (not logged yet or the server could not read it).</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="px-2 py-1 text-left font-medium">horizon</th>
                <th className="px-2 py-1 text-right font-medium" colSpan={3}>{latestDay ? `latest day ${latestDay}: n / covered / 95% CI` : "latest day"}</th>
                <th className="px-2 py-1 text-right font-medium" colSpan={3}>30 days: n / covered / 95% CI</th>
                <th className="px-2 py-1 text-right font-medium">Kupiec p</th>
                <th className="px-2 py-1 text-right font-medium">Christoffersen p</th>
              </tr>
            </thead>
            <tbody>
              {horizons.map((h) => {
                const pooled = report.pooled.find((p) => p.horizonMin === h);
                const day = latestDay ? report.daily.find((d) => d.day === latestDay && d.horizonMin === h) : undefined;
                return (
                  <tr key={h} className="border-t border-border/40" data-testid={`row-ml-coverage-${h}`}>
                    <td className="px-2 py-1 font-mono">{h} min</td>
                    <CoverageCells r={day} />
                    <CoverageCells r={pooled} />
                    <td className="px-2 py-1 font-mono text-right">{pooled && pooled.n > 0 ? fmtP(pooled.kupiecP) : "—"}</td>
                    <td className="px-2 py-1 font-mono text-right">{pooled && pooled.n > 0 ? fmtP(pooled.independenceP) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-1 text-[10px] text-muted-foreground/70">
            pending (horizon not yet passed): {report.pending} · no price for the window: {report.noPrice}
          </div>
        </div>
      )}
    </div>
  );
}
