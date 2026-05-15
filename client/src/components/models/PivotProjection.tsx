// client/src/components/models/PivotProjection.tsx
//
// Pivot Point Projection — replaces the forward "cone" with a stacked magnet
// map. Shows the next 1-2 month directional outlook anchored to:
//   • Monthly Classic Pivots (M-PP, M-R/S 1-3)
//   • Quarterly Fibonacci Pivots (Q-PP, Q-R/S 1-3)
//   • Gamma walls (callWall, putWall, gammaFlip)
//   • SMA stack (20/50/200)
//   • Volume nodes (top 3 high-volume price levels)
// Confluence ≥ 3 = "magnet" (thick gold line)
// Confluence = 2  = "key"    (medium amber line)
// Confluence = 1  = "minor"  (thin blue line)
//
// Also surfaces detected setup patterns: Pivot Reclaim, Pivot Rejection,
// Magnet Drift, Stack Break.
//
// Touch/UI-friendly: tap any level to see what's stacked there + how many
// historical reactions it has triggered in the last 90 days.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Target, AlertTriangle, RefreshCw } from "lucide-react";

type Level = {
  label: string;
  source:
    | "monthlyClassic"
    | "quarterlyFib"
    | "gammaWall"
    | "sma"
    | "volumeNode"
    | "rsiExtreme";
  price: number;
  confluence: number;
  stackedWith: string[];
  distPct: number;
  side: "above" | "below" | "at";
  tier: "magnet" | "key" | "minor";
};

type Pattern = {
  setup: "pivot-reclaim" | "pivot-rejection" | "magnet-drift" | "stack-break";
  message: string;
  confidence: number;
};

type Bar = { t: number; o?: number; h?: number; l?: number; c: number };

type Resp = {
  symbol: string;
  spot: number;
  asOf: string;
  levels: Level[];
  historicalReactions: Record<string, number>;
  patterns: Pattern[];
  chartBars: Bar[];
};

function sourceLabel(s: Level["source"]): string {
  return (
    {
      monthlyClassic: "monthly classic",
      quarterlyFib: "quarterly fib",
      gammaWall: "gamma wall",
      sma: "SMA",
      volumeNode: "volume node",
      rsiExtreme: "RSI",
    } as const
  )[s];
}

function tierColor(tier: Level["tier"]): string {
  if (tier === "magnet") return "#f59e0b"; // amber-500
  if (tier === "key") return "#fbbf24"; // amber-400
  return "#60a5fa"; // blue-400
}

function tierStrokeWidth(tier: Level["tier"]): number {
  if (tier === "magnet") return 2.5;
  if (tier === "key") return 1.5;
  return 0.8;
}

function tierDash(tier: Level["tier"]): string {
  if (tier === "magnet") return "0";
  if (tier === "key") return "4,3";
  return "2,4";
}

function patternColor(s: Pattern["setup"]): string {
  if (s === "pivot-reclaim") return "border-green-500/50 bg-green-500/10 text-green-300";
  if (s === "pivot-rejection") return "border-red-500/50 bg-red-500/10 text-red-300";
  if (s === "magnet-drift") return "border-amber-500/50 bg-amber-500/10 text-amber-300";
  return "border-cyan-500/50 bg-cyan-500/10 text-cyan-300";
}

function patternLabel(s: Pattern["setup"]): string {
  return (
    {
      "pivot-reclaim": "pivot reclaim",
      "pivot-rejection": "pivot rejection",
      "magnet-drift": "magnet drift",
      "stack-break": "stack break",
    } as const
  )[s];
}

// ─── Chart geometry ──────────────────────────────────────────────────────────
const CHART_W = 720;
const CHART_H = 360;
const PAD_L = 50;
const PAD_R = 110;
const PAD_T = 12;
const PAD_B = 28;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

export default function PivotProjection({
  defaultSymbol = "SPY",
}: {
  defaultSymbol?: "SPY" | "^GSPC";
}) {
  const [symbol, setSymbol] = useState<string>(defaultSymbol);
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<Resp>({
    queryKey: ["/api/pivot-projection", symbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/pivot-projection?symbol=${encodeURIComponent(symbol)}`);
      return r.json();
    },
    refetchInterval: 30 * 60_000,
    staleTime: 25 * 60_000,
    // Transparent retry on 503 (Schwab throttle race when Models tab loads).
    // 3 retries with exponential backoff. Keeps previous data visible meanwhile.
    retry: (failureCount, error: any) => {
      const msg = String(error?.message ?? "");
      const isThrottle = msg.includes("503") || msg.toLowerCase().includes("schwab");
      return isThrottle && failureCount < 3;
    },
    retryDelay: (attemptIndex) => Math.min(1500 * 2 ** attemptIndex, 10_000),
    placeholderData: (prev) => prev, // stale-while-error — keep last good chart
  });

  const { yMin, yMax, barPath, candles, projectionX, lineY } = useMemo(() => {
    if (!data) {
      return { yMin: 0, yMax: 0, barPath: "", candles: [], projectionX: PAD_L, lineY: (_: number) => 0 };
    }
    const bars = data.chartBars ?? [];
    // Find vertical bounds — include all levels too
    const allPrices = [
      ...bars.flatMap((b) => [b.h ?? b.c, b.l ?? b.c, b.c]),
      ...data.levels.map((l) => l.price),
      data.spot,
    ];
    const lo = Math.min(...allPrices);
    const hi = Math.max(...allPrices);
    const pad = (hi - lo) * 0.04;
    const yMin = lo - pad;
    const yMax = hi + pad;
    // Project ~25 forward sessions of empty space on the right
    const totalSessions = bars.length + 25;
    const xOf = (i: number) => PAD_L + (i / Math.max(1, totalSessions - 1)) * PLOT_W;
    const yOf = (p: number) => PAD_T + (1 - (p - yMin) / (yMax - yMin)) * PLOT_H;
    const projectionX = xOf(bars.length - 1);
    // Build candle rects
    const candles = bars.map((b, i) => {
      const x = xOf(i);
      const o = b.o ?? b.c;
      const c = b.c;
      const h = b.h ?? Math.max(o, c);
      const l = b.l ?? Math.min(o, c);
      const up = c >= o;
      const yH = yOf(h);
      const yL = yOf(l);
      const yO = yOf(o);
      const yC = yOf(c);
      const bodyTop = Math.min(yO, yC);
      const bodyH = Math.max(0.5, Math.abs(yC - yO));
      const w = Math.max(1, PLOT_W / totalSessions - 1);
      return { x, yH, yL, bodyTop, bodyH, w, up, c };
    });
    // Build a price-line fallback (close)
    const pts = bars.map((b, i) => `${xOf(i).toFixed(1)},${yOf(b.c).toFixed(1)}`);
    const barPath = pts.length ? `M ${pts.join(" L ")}` : "";
    return { yMin, yMax, barPath, candles, projectionX, lineY: yOf };
  }, [data]);

  return (
    <Card className="border-amber-500/20 bg-gradient-to-b from-amber-950/5 to-card">
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Activity className="h-4 w-4 text-amber-400" />
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-300/80">
              Pivot Point Projection
            </div>
            <div className="text-[10px] text-muted-foreground">
              1-2 month directional outlook · monthly classic + quarterly fib +
              gamma walls + SMAs + volume nodes
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1 rounded border border-border/60 bg-black/30 p-0.5">
            {(["SPY", "^GSPC", "QQQ", "IWM"] as const).map((s) => (
              <Button
                key={s}
                variant={symbol === s ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setSymbol(s)}
                data-testid={`btn-pivot-${s}`}
              >
                {s === "^GSPC" ? "SPX" : s}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="btn-pivot-refresh"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {isLoading && <Skeleton className="h-[360px] w-full bg-muted/20" />}

        {isError && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            could not build pivot projection · check Schwab status
          </div>
        )}

        {data && (
          <>
            {/* Pattern badges */}
            {data.patterns.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {data.patterns.map((p, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className={`px-2 py-1 text-[10px] ${patternColor(p.setup)}`}
                    data-testid={`badge-pattern-${p.setup}`}
                  >
                    <span className="font-bold uppercase tracking-wider">{patternLabel(p.setup)}</span>
                    <span className="ml-2 text-muted-foreground/80">{p.message}</span>
                    <span className="ml-2 font-mono text-[9px] opacity-70">
                      {(p.confidence * 100).toFixed(0)}%
                    </span>
                  </Badge>
                ))}
              </div>
            )}

            {/* Chart */}
            <div className="overflow-x-auto rounded border border-border/40 bg-black/40">
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                className="block w-full"
                style={{ maxWidth: "100%", height: "auto", minHeight: 360 }}
              >
                {/* Plot background */}
                <rect
                  x={PAD_L}
                  y={PAD_T}
                  width={PLOT_W}
                  height={PLOT_H}
                  fill="#020617"
                  stroke="#1f2937"
                  strokeWidth={0.5}
                />

                {/* Projection zone shade */}
                <rect
                  x={projectionX}
                  y={PAD_T}
                  width={PAD_L + PLOT_W - projectionX}
                  height={PLOT_H}
                  fill="#1e293b"
                  opacity={0.3}
                />

                {/* Y-axis labels (4 ticks) */}
                {[0, 0.33, 0.66, 1].map((t) => {
                  const price = yMin + (yMax - yMin) * (1 - t);
                  const y = PAD_T + t * PLOT_H;
                  return (
                    <g key={t}>
                      <line
                        x1={PAD_L}
                        y1={y}
                        x2={PAD_L + PLOT_W}
                        y2={y}
                        stroke="#1f2937"
                        strokeWidth={0.3}
                      />
                      <text
                        x={PAD_L - 6}
                        y={y + 3}
                        textAnchor="end"
                        fontSize={9}
                        fill="#64748b"
                        fontFamily="monospace"
                      >
                        {price.toFixed(price > 100 ? 0 : 2)}
                      </text>
                    </g>
                  );
                })}

                {/* Candles */}
                {candles.map((cd, i) => (
                  <g key={i}>
                    <line
                      x1={cd.x + cd.w / 2}
                      y1={cd.yH}
                      x2={cd.x + cd.w / 2}
                      y2={cd.yL}
                      stroke={cd.up ? "#10b981" : "#ef4444"}
                      strokeWidth={0.5}
                    />
                    <rect
                      x={cd.x}
                      y={cd.bodyTop}
                      width={cd.w}
                      height={cd.bodyH}
                      fill={cd.up ? "#10b981" : "#ef4444"}
                      opacity={0.85}
                    />
                  </g>
                ))}

                {/* Pivot levels — horizontal lines + right-edge labels */}
                {data.levels.map((lv, i) => {
                  const y = lineY(lv.price);
                  const isSelected = selectedLevel === lv.label;
                  return (
                    <g
                      key={lv.label + i}
                      onClick={() => setSelectedLevel(isSelected ? null : lv.label)}
                      style={{ cursor: "pointer" }}
                      data-testid={`pivot-level-${lv.label}`}
                    >
                      <line
                        x1={PAD_L}
                        y1={y}
                        x2={PAD_L + PLOT_W}
                        y2={y}
                        stroke={tierColor(lv.tier)}
                        strokeWidth={tierStrokeWidth(lv.tier) * (isSelected ? 1.8 : 1)}
                        strokeDasharray={tierDash(lv.tier)}
                        opacity={lv.tier === "minor" ? 0.5 : 0.85}
                      />
                      <rect
                        x={PAD_L + PLOT_W + 2}
                        y={y - 6}
                        width={PAD_R - 6}
                        height={12}
                        fill={isSelected ? tierColor(lv.tier) : "#000"}
                        opacity={isSelected ? 0.9 : 0.55}
                      />
                      <text
                        x={PAD_L + PLOT_W + 6}
                        y={y + 3}
                        fontSize={9}
                        fill={isSelected ? "#000" : tierColor(lv.tier)}
                        fontFamily="monospace"
                        fontWeight={lv.tier === "magnet" ? 700 : 400}
                      >
                        {lv.label} · {lv.price.toFixed(2)}
                        {lv.confluence > 1 ? ` ×${lv.confluence}` : ""}
                      </text>
                    </g>
                  );
                })}

                {/* Current spot — bright cyan line */}
                <line
                  x1={PAD_L}
                  y1={lineY(data.spot)}
                  x2={PAD_L + PLOT_W}
                  y2={lineY(data.spot)}
                  stroke="#22d3ee"
                  strokeWidth={1.5}
                  strokeDasharray="6,3"
                  opacity={0.7}
                />
                <text
                  x={PAD_L + 4}
                  y={lineY(data.spot) - 4}
                  fontSize={9}
                  fill="#22d3ee"
                  fontFamily="monospace"
                >
                  spot {data.spot.toFixed(2)}
                </text>

                {/* X-axis: today separator */}
                <line
                  x1={projectionX}
                  y1={PAD_T}
                  x2={projectionX}
                  y2={PAD_T + PLOT_H}
                  stroke="#475569"
                  strokeWidth={0.6}
                  strokeDasharray="2,2"
                />
                <text
                  x={projectionX + 3}
                  y={PAD_T + 9}
                  fontSize={8}
                  fill="#94a3b8"
                  fontFamily="monospace"
                >
                  today
                </text>
                <text
                  x={projectionX + 3}
                  y={PAD_T + PLOT_H - 4}
                  fontSize={8}
                  fill="#94a3b8"
                  fontFamily="monospace"
                >
                  forward 1-2mo projection zone
                </text>
              </svg>
            </div>

            {/* Selected-level detail strip */}
            {selectedLevel && (() => {
              const lv = data.levels.find((l) => l.label === selectedLevel);
              if (!lv) return null;
              const reactions = data.historicalReactions[lv.label] ?? 0;
              return (
                <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-3 font-mono text-[10px]">
                  <div className="flex items-center gap-2">
                    <Target className="h-3 w-3 text-amber-400" />
                    <span className="font-bold text-amber-300">{lv.label}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-foreground">{lv.price.toFixed(2)}</span>
                    <span className="text-muted-foreground">·</span>
                    <Badge variant="outline" className="px-1 py-0 text-[8px]">
                      {sourceLabel(lv.source)}
                    </Badge>
                    <Badge variant="outline" className="px-1 py-0 text-[8px]">
                      confluence ×{lv.confluence}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`px-1 py-0 text-[8px] ${
                        lv.tier === "magnet"
                          ? "border-amber-400 text-amber-300"
                          : lv.tier === "key"
                          ? "border-amber-500/50 text-amber-300/80"
                          : "border-blue-400/50 text-blue-300"
                      }`}
                    >
                      {lv.tier}
                    </Badge>
                    <span className="ml-auto text-muted-foreground">
                      {lv.side} · {lv.distPct >= 0 ? "+" : ""}
                      {lv.distPct.toFixed(2)}%
                    </span>
                  </div>
                  {lv.stackedWith.length > 0 && (
                    <div className="mt-1.5 text-muted-foreground">
                      stacked with:{" "}
                      <span className="text-foreground">{lv.stackedWith.join(", ")}</span>
                    </div>
                  )}
                  <div className="mt-1 text-muted-foreground">
                    historical reactions (90d):{" "}
                    <span
                      className={
                        reactions >= 3
                          ? "text-green-400 font-bold"
                          : reactions >= 1
                          ? "text-amber-300"
                          : "text-muted-foreground"
                      }
                    >
                      {reactions}
                    </span>{" "}
                    <span className="text-[9px] opacity-60">
                      (touches within 0.3% that reversed 0.5%+ in 5 sessions)
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-6 bg-amber-500" />
                magnet (≥3 confluence)
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-0.5 w-6"
                  style={{ background: "#fbbf24", backgroundImage: "repeating-linear-gradient(90deg,#fbbf24 0 4px,transparent 4px 7px)" }}
                />
                key (2 confluence)
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-0.5 w-6"
                  style={{ background: "#60a5fa", backgroundImage: "repeating-linear-gradient(90deg,#60a5fa 0 2px,transparent 2px 6px)" }}
                />
                minor (1 source)
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-0.5 w-6 bg-cyan-400" />
                spot
              </span>
              <span className="ml-auto text-muted-foreground/60">tap any line for detail</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
