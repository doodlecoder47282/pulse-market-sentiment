// MLProjectionPanel.tsx — ML Lab quantile fan chart + model status strip
// Batcave — Wire 20 frontend

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

interface SnapshotPublic {
  spy: { price: number; prevClose: number; changePct: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns fractional ET hour (e.g. 10:30 → 10.5) */
function getEtFeatures() {
  const now = new Date();
  // Get ET time components using Intl
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
  const minutesFromOpen = (h - 9) * 60 + m - 30; // minutes since 9:30 ET
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
    hour12: false,
  });
  const parts = etFmt.formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const totalMin = h * 60 + m;
  return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
}

const HORIZONS = [5, 15, 30, 60];
const HORIZON_LABELS: Record<number, string> = {
  5: "+5m",
  15: "+15m",
  30: "+30m",
  60: "+60m",
};

// ─── Status strip ─────────────────────────────────────────────────────────────

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
      {/* score_calibrator */}
      <div className="flex items-center gap-1.5" data-testid="text-ml-status-score_calibrator">
        <span className="text-muted-foreground font-medium">score_calibrator</span>
        <Badge variant={statusVariant(score_calibrator?.status ?? "")} className={`text-xs h-5 ${statusColor(score_calibrator?.status ?? "")}`}>
          {score_calibrator?.status ?? "—"}
        </Badge>
      </div>

      <Separator orientation="vertical" className="h-4 self-center" />

      {/* quantile_overlay */}
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

      {/* whale_follow */}
      <div className="flex items-center gap-1.5" data-testid="text-ml-status-whale_follow">
        <span className="text-muted-foreground font-medium">whale_follow</span>
        <Badge variant={statusVariant(whale_follow?.status ?? "")} className={`text-xs h-5 ${statusColor(whale_follow?.status ?? "")}`}>
          {whale_follow?.status ?? "—"}
        </Badge>
      </div>
    </div>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function FanTooltip({ active, payload, label, currentSpot }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const q50 = d.q50 ?? 0;
  const impliedPrice = currentSpot ? currentSpot * (1 + q50 / 100) : null;

  return (
    <div className="bg-background border border-border rounded-md p-2 text-xs shadow-md min-w-[160px]">
      <div className="font-semibold mb-1 text-foreground">{label}</div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">q10</span>
          <span>{d.q10?.toFixed(3)}%</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">q25</span>
          <span>{d.q25?.toFixed(3)}%</span>
        </div>
        <div className="flex justify-between gap-4 font-semibold text-primary">
          <span>q50</span>
          <span>{q50?.toFixed(3)}%</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">q75</span>
          <span>{d.q75?.toFixed(3)}%</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">q90</span>
          <span>{d.q90?.toFixed(3)}%</span>
        </div>
        {impliedPrice != null && (
          <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-border font-semibold">
            <span className="text-muted-foreground">implied@q50</span>
            <span className="text-foreground">${impliedPrice.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MLProjectionPanel() {
  const features = getEtFeatures();
  const refetchInterval = isRTH() ? 60_000 : 5 * 60_000;

  // Get current SPY spot from snapshot
  const { data: snap } = useQuery<SnapshotPublic>({
    queryKey: ["/api/snapshot"],
    queryFn: () => apiRequest("GET", "/api/snapshot").then((r) => r.json()),
    refetchInterval,
    retry: false,
    staleTime: 30_000,
  });

  const currentSpot = snap?.spy?.price ?? null;

  const {
    data,
    isLoading,
    isError,
    refetch,
    error,
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
  });

  // ── build chart data ─────────────────────────────────────────────────────
  const chartData = (() => {
    const base = [{ label: "now", q10: 0, q25: 0, q50: 0, q75: 0, q90: 0 }];
    if (!data?.bands) return base;
    const rows = HORIZONS.map((h) => {
      const b = data.bands[String(h)] ?? data.bands[`${h}min`] ?? null;
      if (!b) return { label: HORIZON_LABELS[h], q10: 0, q25: 0, q50: 0, q75: 0, q90: 0 };
      // convert decimals (0.0042) → percent (+0.42%)
      const toP = (v: number) => parseFloat((v * 100).toFixed(4));
      return {
        label: HORIZON_LABELS[h],
        q10: toP(b.q10),
        q25: toP(b.q25),
        q50: toP(b.q50),
        q75: toP(b.q75),
        q90: toP(b.q90),
      };
    });
    return [...base, ...rows];
  })();

  // ── table data ─────────────────────────────────────────────────────────
  const tableRows = HORIZONS.map((h) => {
    const b = data?.bands?.[String(h)] ?? data?.bands?.[`${h}min`] ?? null;
    const toP = (v: number) => (v * 100).toFixed(3) + "%";
    const q50Raw = b ? b.q50 : 0;
    const impliedPrice = currentSpot ? currentSpot * (1 + q50Raw) : null;
    return {
      horizon: h,
      label: HORIZON_LABELS[h],
      q10: b ? toP(b.q10) : "—",
      q25: b ? toP(b.q25) : "—",
      q50: b ? toP(b.q50) : "—",
      q75: b ? toP(b.q75) : "—",
      q90: b ? toP(b.q90) : "—",
      implied: impliedPrice ? `$${impliedPrice.toFixed(2)}` : "—",
    };
  });

  // check quantile_overlay training status from health (if accessible)
  // We'll show the empty state from projection status field
  const projStatus = data?.status;
  const isUntrained =
    projStatus === "BOOTSTRAP" ||
    projStatus === "INSUFFICIENT_DATA" ||
    projStatus === "NOT_TRAINED";

  // y-axis domain — adaptive
  const allVals = chartData.flatMap((d) => [d.q10, d.q90]).filter((v) => v !== 0);
  const minY = allVals.length ? Math.min(-0.2, Math.min(...allVals) * 1.1) : -0.5;
  const maxY = allVals.length ? Math.max(0.2, Math.max(...allVals) * 1.1) : 0.5;

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Card data-testid="panel-ml-projection" className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            quantile fan — 5/15/30/60m
          </CardTitle>
          {currentSpot && (
            <span className="text-xs text-muted-foreground">
              spot ${currentSpot.toFixed(2)}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => refetch()}
            title="refresh projection"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            refresh
          </Button>
        </div>

        {/* ML status strip */}
        <div className="mt-2">
          <MLStatusStrip />
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {/* ── loading ── */}
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {/* ── 503 error ── */}
        {isError && !isLoading && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertTriangle className="w-8 h-8 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">ML service unreachable</div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="w-3 h-3 mr-2" />
              retry
            </Button>
          </div>
        )}

        {/* ── data but model untrained ── */}
        {!isLoading && !isError && data?.ok === false && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertTriangle className="w-8 h-8 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              {data.error ?? "ML service unreachable"}
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="w-3 h-3 mr-2" />
              retry
            </Button>
          </div>
        )}

        {/* ── untrained state ── */}
        {!isLoading && !isError && data?.ok && isUntrained && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            quantile model still training — check back when n_train ≥ 500
          </div>
        )}

        {/* ── main chart ── */}
        {!isLoading && !isError && data?.ok && !isUntrained && (
          <>
            {/* Fan chart */}
            <div
              data-testid="chart-ml-quantile-fan"
              className="w-full"
              style={{ height: 220 }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 12, bottom: 4, left: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    opacity={0.4}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[minY, maxY]}
                    tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`}
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip
                    content={<FanTooltip currentSpot={currentSpot} />}
                  />
                  <ReferenceLine
                    y={0}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 2"
                    opacity={0.5}
                  />

                  {/* q10–q90 outer band — lightest */}
                  <Area
                    type="monotone"
                    dataKey="q90"
                    stroke="none"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.08}
                    legendType="none"
                    isAnimationActive={false}
                    name="q90"
                    stackId="outer"
                  />
                  <Area
                    type="monotone"
                    dataKey="q10"
                    stroke="none"
                    fill="hsl(var(--background))"
                    fillOpacity={1}
                    legendType="none"
                    isAnimationActive={false}
                    name="q10"
                    stackId="outer"
                  />

                  {/* q25–q75 inner band — medium */}
                  <Area
                    type="monotone"
                    dataKey="q75"
                    stroke="none"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.18}
                    legendType="none"
                    isAnimationActive={false}
                    name="q75"
                    stackId="inner"
                  />
                  <Area
                    type="monotone"
                    dataKey="q25"
                    stroke="none"
                    fill="hsl(var(--background))"
                    fillOpacity={1}
                    legendType="none"
                    isAnimationActive={false}
                    name="q25"
                    stackId="inner"
                  />

                  {/* q50 median line */}
                  <Line
                    type="monotone"
                    dataKey="q50"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "hsl(var(--primary))", strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                    name="q50 (median)"
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Mini table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1 pr-3 font-medium">horizon</th>
                    <th className="text-right py-1 pr-2 font-medium">q10</th>
                    <th className="text-right py-1 pr-2 font-medium">q25</th>
                    <th className="text-right py-1 pr-2 font-medium text-primary">q50</th>
                    <th className="text-right py-1 pr-2 font-medium">q75</th>
                    <th className="text-right py-1 pr-2 font-medium">q90</th>
                    <th className="text-right py-1 font-medium">implied@q50</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row) => (
                    <tr
                      key={row.horizon}
                      data-testid={`row-projection-h${row.horizon}`}
                      className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                    >
                      <td className="py-1.5 pr-3 text-muted-foreground font-medium">
                        {row.label}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.q10}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.q25}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums font-semibold text-primary">
                        {row.q50}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.q75}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.q90}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {row.implied}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
