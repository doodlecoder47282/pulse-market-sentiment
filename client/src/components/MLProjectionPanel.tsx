// MLProjectionPanel.tsx — SPX Gamma-Aware Path Projector
//
// Live SPX 5-min tape vs dealer levels + Greek-aware forward projection.
// Replaces the prior candle/quantile fan panel.
//
// Honest disclosures (also documented in code comments + tooltip):
//   • The training set used SYNTHETIC distance-to-level features. The model
//     learned the SHAPE of the response (pinning under +gamma, acceleration
//     under -gamma) but absolute calibration is approximate until we
//     accumulate live Greek snapshots and retrain.
//   • Gamma-snap is a DETERMINISTIC POST-PROCESS — the LightGBM model returns
//     raw q50, then the client biases the path toward (or away from) the
//     nearest dealer wall based on net GEX sign.
//   • Extrapolation past 60min is LINEAR — the model is only trained to 60min,
//     the dashed extension is the 30→60 slope projected forward, capped ±1.2%.
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

interface ProjectionSpxResponse {
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
  features: Record<string, number>;
  asOf: string;
}

// ─── Constants & helpers ─────────────────────────────────────────────────────

const RTH_OPEN_MIN = 0;       // 9:30 ET = 0
const RTH_CLOSE_MIN = 390;    // 16:00 ET = 390 minutes after open
const COLOR_REALIZED = "#f59e0b";
const COLOR_PROJ = "#22d3ee";
const COLOR_EXT = "#22d3ee";
const COLOR_RIBBON = "#22d3ee";

/** Convert epoch seconds to "minutes from 9:30 ET today". */
function epochToMinuteOfDay(epochSec: number): number {
  const d = new Date(epochSec * 1000);
  // Get ET hour/minute via Intl
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

/** Current ET minute-of-day (since 9:30). Negative pre-market, >390 after-hours. */
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
  const h = Math.floor((min + 9 * 60 + 30) / 60);
  const m = (min + 30) % 60;
  const hh = ((h - 1) % 12) + 1;
  return `${hh}:${m.toString().padStart(2, "0")}`;
}

// ─── Status strip (preserved) ────────────────────────────────────────────────

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

// ─── Chart math ──────────────────────────────────────────────────────────────

interface LevelSpec {
  key: string;
  label: string;
  value: number;
  color: string;
  dash?: string;
  weight: number;
  emphasis?: boolean;
}

/**
 * Pick the nearest gamma level value to a given price, within a band.
 * Used by the gamma-snap heuristic. Returns null if nothing close enough.
 */
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
    if (d < bandPct && Math.abs(l.value - price) < Math.abs((best?.value ?? Infinity) - price)) {
      best = l;
      bestDist = d;
    }
  }
  // also need to consider all-level nearest if within bandPct
  for (const l of levels) {
    const d = Math.abs(l.value - price) / price;
    if (d < bandPct && d < bestDist) {
      best = l;
      bestDist = d;
    }
  }
  return best;
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export default function MLProjectionPanel() {
  // RTH detection — refresh 60s during RTH, 5min outside
  const isRth = useMemo(() => {
    const m = nowMinuteOfDay();
    return m >= 0 && m <= 390;
  }, []);

  const { data, isLoading, error, refetch, isRefetching } = useQuery<ProjectionSpxResponse>({
    queryKey: ["/api/ml/projection-spx"],
    queryFn: () =>
      apiRequest("GET", "/api/ml/projection-spx").then((r) => r.json()),
    refetchInterval: isRth ? 60_000 : 5 * 60_000,
    retry: false,
  });

  const candles = data?.candles ?? [];
  const levels = data?.levels ?? null;
  const projection = data?.projection ?? null;
  const features = data?.features ?? {};
  const spot =
    data?.spot ??
    candles[candles.length - 1]?.c ??
    null;

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
    push("callWall", "CALL WALL", levels.callWall?.value, "#22c55e", undefined, 2.5, true);
    push("zomma", "ZOMMA", levels.zomma?.value, "#22d3ee", "6 4", 1);
    push("flip", "0-Γ FLIP", levels.gammaFlip?.value, "#ef4444", "6 4", 2.5, true);
    push("maxPain", "MAX PAIN", levels.mopex?.value, "#facc15", "4 4", 1);
    push("putWall", "PUT WALL", levels.putWall?.value, "#ef4444", undefined, 2.5, true);
    push("dnVomma", "DN VOMMA", levels.vommaLower?.value, "#fb923c", "6 4", 1);
    // Top GEX strikes — thin grey
    for (let i = 0; i < (levels.topGexStrikes ?? []).slice(0, 3).length; i++) {
      const s = levels.topGexStrikes[i];
      push(`gex-${i}`, `GEX ${s.strike}`, s.strike, "#94a3b8", "2 4", 0.6);
    }
    // Weekly targets — thin cyan/red
    push("upside", "UPSIDE", levels.weeklyTargets?.upside?.value, "#67e8f9", "2 4", 0.6);
    push("downside", "DOWNSIDE", levels.weeklyTargets?.downside?.value, "#fca5a5", "2 4", 0.6);
    push("t2Up", "T2 UP", levels.weeklyTargets?.t2Up?.value, "#67e8f9", "2 4", 0.6);
    push("t2Down", "T2 DOWN", levels.weeklyTargets?.t2Down?.value, "#fca5a5", "2 4", 0.6);
    return specs;
  }, [levels]);

  // Realized path — minute-of-day → close
  const realizedRows = useMemo(
    () =>
      candles
        .map((c) => ({
          minute: epochToMinuteOfDay(c.t),
          realized: c.c,
          o: c.o,
          h: c.h,
          l: c.l,
          c: c.c,
          v: c.v,
          t: c.t,
        }))
        .filter((r) => r.minute >= -10 && r.minute <= 400),
    [candles],
  );

  const lastRealized = realizedRows[realizedRows.length - 1] ?? null;
  const anchorMinute = lastRealized?.minute ?? nowMinuteOfDay();
  const anchorPrice = lastRealized?.realized ?? spot ?? 0;

  // Forward projection rows (5/15/30/60min after anchor)
  const HORIZONS = [5, 15, 30, 60];
  const projRows = useMemo(() => {
    if (!projection?.bands || !anchorPrice || anchorPrice <= 0) return [];
    const allLevels = levelSpecs;
    const netGexSign = features.net_gex_sign ?? 0;
    const rows: Array<{
      minute: number;
      proj: number;
      projQ10: number;
      projQ90: number;
      ribbonLo: number;
      ribbonHi: number;
      snapApplied: boolean;
      nearest: string | null;
      pct: number;
      bandWidth: number;
    }> = [];
    // Anchor row (so projection line starts from realized close)
    rows.push({
      minute: anchorMinute,
      proj: anchorPrice,
      projQ10: anchorPrice,
      projQ90: anchorPrice,
      ribbonLo: anchorPrice,
      ribbonHi: 0,
      snapApplied: false,
      nearest: null,
      pct: 0,
      bandWidth: 0,
    });
    for (const h of HORIZONS) {
      const band = projection.bands[String(h)];
      if (!band) continue;
      const q50Pct = band.q50;
      const q10Pct = band.q10;
      const q90Pct = band.q90;
      let q50Price = anchorPrice * (1 + q50Pct);
      const q10Price = anchorPrice * (1 + q10Pct);
      const q90Price = anchorPrice * (1 + q90Pct);

      // Gamma-snap heuristic (deterministic post-process). Documented above.
      let snapApplied = false;
      let nearestKey: string | null = null;
      const distFromAnyWallPct =
        allLevels.length > 0
          ? Math.min(...allLevels.map((l) => Math.abs(l.value - q50Price) / q50Price))
          : 1;
      if (distFromAnyWallPct < 0.007) {
        // Within 0.7% of some wall — apply gravity rule
        const near = nearestLevel(q50Price, allLevels, 0.005);
        if (near) {
          nearestKey = near.label;
          if (netGexSign > 0 && (near.key === "callWall" || near.key === "putWall")) {
            // pin regime — pull 30% toward wall
            q50Price = q50Price + (near.value - q50Price) * 0.3;
            snapApplied = true;
          } else if (
            netGexSign < 0 &&
            (near.key === "callWall" || near.key === "putWall")
          ) {
            // vol regime — push 20% AWAY from wall
            q50Price = q50Price - (near.value - q50Price) * 0.2;
            snapApplied = true;
          }
        }
      }

      rows.push({
        minute: anchorMinute + h,
        proj: q50Price,
        projQ10: q10Price,
        projQ90: q90Price,
        ribbonLo: q10Price,
        ribbonHi: q90Price - q10Price,
        snapApplied,
        nearest: nearestKey,
        pct: q50Pct,
        bandWidth: q90Price - q10Price,
      });
    }
    return rows;
  }, [projection, levelSpecs, anchorPrice, anchorMinute, features.net_gex_sign]);

  // Linear extrapolation from 30→60 slope, capped ±1.2%
  const extRows = useMemo(() => {
    if (projRows.length < 3) return [];
    const last = projRows[projRows.length - 1]; // t+60
    const prev = projRows[projRows.length - 2]; // t+30
    if (!last || !prev) return [];
    const slopePerMin =
      (last.proj - prev.proj) / Math.max(1, last.minute - prev.minute);
    const startMin = last.minute;
    const startPx = last.proj;
    const cap = anchorPrice * 0.012;
    const out: Array<{ minute: number; ext: number }> = [
      { minute: startMin, ext: startPx },
    ];
    for (let m = startMin + 5; m <= RTH_CLOSE_MIN; m += 5) {
      const raw = startPx + slopePerMin * (m - startMin);
      const clamped =
        raw > anchorPrice + cap
          ? anchorPrice + cap
          : raw < anchorPrice - cap
            ? anchorPrice - cap
            : raw;
      out.push({ minute: m, ext: clamped });
    }
    return out;
  }, [projRows, anchorPrice]);

  // Combined chart data — keyed on minute
  const chartData = useMemo(() => {
    const byMin = new Map<number, any>();
    const ensure = (m: number) => {
      if (!byMin.has(m)) byMin.set(m, { minute: m });
      return byMin.get(m);
    };
    for (const r of realizedRows) {
      const row = ensure(r.minute);
      Object.assign(row, r);
    }
    for (const p of projRows) {
      const row = ensure(p.minute);
      row.proj = p.proj;
      row.projQ10 = p.projQ10;
      row.projQ90 = p.projQ90;
      row.ribbonLo = p.ribbonLo;
      row.ribbonHi = p.ribbonHi;
      row.snapApplied = p.snapApplied;
      row.nearest = p.nearest;
      row.bandWidth = p.bandWidth;
      row.pct = p.pct;
    }
    for (const e of extRows) {
      const row = ensure(e.minute);
      row.ext = e.ext;
    }
    return Array.from(byMin.values()).sort((a, b) => a.minute - b.minute);
  }, [realizedRows, projRows, extRows]);

  // Y-axis domain
  const yDomain = useMemo<[number, number]>(() => {
    const vals: number[] = [];
    for (const r of realizedRows) {
      if (r.h != null) vals.push(r.h);
      if (r.l != null) vals.push(r.l);
    }
    for (const p of projRows) {
      vals.push(p.projQ10);
      vals.push(p.projQ90);
      vals.push(p.proj);
    }
    for (const l of levelSpecs) vals.push(l.value);
    if (vals.length === 0) return [0, 1];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.05 || 5;
    return [lo - pad, hi + pad];
  }, [realizedRows, projRows, levelSpecs]);

  const nowMin = nowMinuteOfDay();
  const status = projection?.status ?? "UNAVAILABLE";

  // Banner detection
  const hasBands = !!projection?.bands;
  const hasLevels = !!levels;
  const hasCandles = candles.length > 0;
  const isBootstrap = status === "BOOTSTRAP" || status === "INSUFFICIENT_DATA";

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <Card data-testid="panel-ml-projection" className="border-border/60">
        <CardHeader>
          <CardTitle>SPX Gamma-Aware Path Projector</CardTitle>
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
          <CardTitle>SPX Gamma-Aware Path Projector</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <span className="text-muted-foreground">
              projection endpoint unreachable
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
  const netGexSign = features.net_gex_sign ?? 0;
  const regimeLabel =
    netGexSign > 0 ? "positive" : netGexSign < 0 ? "negative" : "neutral";

  const proj60 = projRows[projRows.length - 1] ?? null;
  const proj60Price = proj60?.proj ?? null;
  const proj60Pct = proj60 && spot ? (proj60.proj - spot) / spot : null;
  const proj60Band = proj60 ? proj60.projQ90 - proj60.projQ10 : 0;
  const snapCount = projRows.filter((p) => p.snapApplied).length;
  const confidence =
    proj60Band && spot
      ? proj60Band / spot < 0.004
        ? "narrow"
        : "wide"
      : "—";

  // Plain-English interpretation lines
  const interpretations: string[] = [];
  if (regimeLabel === "positive") {
    interpretations.push(
      "positive gamma regime — dealers buy dips, sell rips. expect chop between dealer levels.",
    );
  } else if (regimeLabel === "negative") {
    interpretations.push(
      "negative gamma regime — dealers chase. moves accelerate. wider range likely.",
    );
  } else {
    interpretations.push(
      "neutral regime — spot near gamma flip, no dominant dealer hedging bias.",
    );
  }
  if (callDistPct != null && Math.abs(callDistPct) < 0.005) {
    interpretations.push(
      `near call wall (${fmtPrice(levels?.callWall?.value)}) — pinning bias if positive gamma.`,
    );
  }
  if (putDistPct != null && Math.abs(putDistPct) < 0.005) {
    interpretations.push(
      `near put wall (${fmtPrice(levels?.putWall?.value)}) — bounce / pin candidate.`,
    );
  }
  if (flipDistPct != null && flipDistPct > 0 && spot && levels?.gammaFlip?.value) {
    interpretations.push(
      `below flip (${fmtPrice(levels.gammaFlip.value)}) — momentum down has tailwind.`,
    );
  } else if (flipDistPct != null && flipDistPct < 0) {
    interpretations.push(
      `above flip (${fmtPrice(levels?.gammaFlip?.value)}) — buy-the-dip hedging supports the floor.`,
    );
  }
  const topInterps = interpretations.slice(0, 3);

  return (
    <Card data-testid="panel-ml-projection" className="border-border/60">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-4 h-4" />
              SPX Gamma-Aware Path Projector
            </CardTitle>
            <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
              live SPX 5min tape vs dealer levels + Greek-aware forward
              projection. updates 60s RTH. paths shift as dealers re-hedge,
              IV moves, and Greeks roll. training used synthetic Greek
              distances — model learns the shape, calibration sharpens with
              live data.
            </p>
          </div>
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
        <MLStatusStrip />
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Banners */}
        {!hasCandles && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            SPX 5min tape unavailable — chart will populate when data returns.
          </div>
        )}
        {hasCandles && !hasLevels && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            gamma levels loading — chart shows realized tape only.
          </div>
        )}
        {hasCandles && !hasBands && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
            projection unavailable — realized tape and dealer levels still rendering.
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
          className="w-full"
          style={{ height: 480 }}
          data-testid="chart-spx-gamma-projection"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: 90, bottom: 30, left: 10 }}
            >
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
                tickFormatter={(v) => Number(v).toFixed(0)}
                stroke="#64748b"
                fontSize={11}
                width={70}
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
                  if (name === "realized") {
                    return [
                      `${fmtPrice(row?.c)}  (O ${fmtPrice(row?.o)} H ${fmtPrice(row?.h)} L ${fmtPrice(row?.l)})`,
                      "realized",
                    ];
                  }
                  if (name === "proj") {
                    const tag = row?.snapApplied
                      ? ` (gamma-snap → ${row?.nearest ?? "wall"})`
                      : "";
                    return [
                      `${fmtPrice(value)}  ${fmtPct(row?.pct)} band ±$${(row?.bandWidth ?? 0).toFixed(2)}${tag}`,
                      "projected",
                    ];
                  }
                  if (name === "ext") {
                    return [
                      `${fmtPrice(value)} (linear extrapolation past 60min — model trained to 60min only)`,
                      "extrapolated",
                    ];
                  }
                  return [fmtPrice(Number(value)), String(name)];
                }}
              />

              {/* q10/q90 ribbon (faint) */}
              <Area
                type="monotone"
                dataKey="ribbonLo"
                stackId="ribbon"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
              />
              <Area
                type="monotone"
                dataKey="ribbonHi"
                stackId="ribbon"
                stroke="none"
                fill={COLOR_RIBBON}
                fillOpacity={0.10}
                isAnimationActive={false}
                legendType="none"
              />

              {/* Horizontal level lines */}
              {levelSpecs.map((l) => (
                <ReferenceLine
                  key={l.key}
                  y={l.value}
                  stroke={l.color}
                  strokeWidth={l.weight}
                  strokeDasharray={l.dash}
                  label={{
                    value: `${l.label}  ${l.value.toFixed(0)}`,
                    position: "right",
                    fill: l.color,
                    fontSize: l.emphasis ? 11 : 10,
                    fontWeight: l.emphasis ? 600 : 400,
                  }}
                  ifOverflow="extendDomain"
                />
              ))}

              {/* Now line */}
              <ReferenceLine
                x={nowMin}
                stroke="#64748b"
                strokeDasharray="3 3"
                label={{ value: "now", position: "top", fill: "#94a3b8", fontSize: 10 }}
              />
              {/* Anchor (last close) horizontal */}
              {anchorPrice > 0 && (
                <ReferenceLine
                  y={anchorPrice}
                  stroke="#64748b"
                  strokeDasharray="1 5"
                  strokeOpacity={0.5}
                />
              )}

              {/* Realized intraday SPX (orange snake) */}
              <Line
                type="monotone"
                dataKey="realized"
                stroke={COLOR_REALIZED}
                strokeWidth={2.5}
                dot={{ r: 1.5, fill: COLOR_REALIZED }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
                connectNulls={false}
              />

              {/* Forward projected path (cyan, solid) */}
              <Line
                type="monotone"
                dataKey="proj"
                stroke={COLOR_PROJ}
                strokeWidth={2}
                dot={{ r: 3, fill: COLOR_PROJ, stroke: "#0f172a", strokeWidth: 1 }}
                isAnimationActive={false}
                connectNulls={false}
              />

              {/* Linear extrapolation (cyan, dashed) */}
              <Line
                type="monotone"
                dataKey="ext"
                stroke={COLOR_EXT}
                strokeWidth={1.5}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
                strokeOpacity={0.7}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Three-column info grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5"
            data-testid="box-ml-keylevels"
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              key levels
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">spot</span>
              <span className="font-mono">{fmtPrice(spot)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">to call wall</span>
              <span className="font-mono text-emerald-400">{fmtPct(callDistPct)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">to put wall</span>
              <span className="font-mono text-rose-400">{fmtPct(putDistPct)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">to flip</span>
              <span className="font-mono">{fmtPct(flipDistPct)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">net gex regime</span>
              <Badge
                variant={netGexSign > 0 ? "default" : netGexSign < 0 ? "destructive" : "secondary"}
                className="h-5 text-xs"
              >
                {regimeLabel}
              </Badge>
            </div>
          </div>

          <div
            className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5"
            data-testid="box-ml-projection-summary"
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              projection (60min)
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">target</span>
              <span className="font-mono">{fmtPrice(proj60Price)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">implied move</span>
              <span className="font-mono">{fmtPct(proj60Pct)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">band width</span>
              <span className="font-mono">${proj60Band.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">gamma-snap</span>
              <span className="font-mono">{snapCount} pts</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">confidence</span>
              <Badge variant="outline" className="h-5 text-xs">
                {confidence}
              </Badge>
            </div>
          </div>

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
