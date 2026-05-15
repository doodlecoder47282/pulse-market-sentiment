// client/src/components/models/MLAccuracyCard.tsx
//
// Honest, peer-to-peer ML accuracy card for the Models tab.
// Answers: "is the ML agent actually getting better?"
//
// Pulls /api/ml/accuracy-history which grades every prediction in
// data/mm-predictions/predictions.jsonl against realized SPX closes.
//
// Shows:
//   - Headline hit rate + Brier with verdict pill (calibrated / mis-calibrated / coin flip)
//   - Per-call breakdown (bull / bear / pin)
//   - Rolling windows last7 / last14 / last30 — momentum check
//   - Sparkline of rolling hit-rate (newest right)
//   - Calibration table: pUpAvg vs actualUpRate per decile (the truth bucket)
//
// No localStorage. Object-form query. Array query key. Touch-friendly.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, AlertTriangle, TrendingUp, TrendingDown, Target } from "lucide-react";

type WindowStat = { hitRate: number | null; brier: number | null; n: number };
type CalibBucket = { bucket: number; pUpAvg: number; actualUpRate: number; n: number };
type TrailPoint = { ts: number; rollingHitRate: number; brier: number | null };

type AccuracyResp = {
  totalPredictions: number;
  gradedPredictions: number;
  abstained: number;
  directionalHitRate: number;
  directionalNCalls: number;
  bullHitRate: number | null;
  bullN: number;
  bearHitRate: number | null;
  bearN: number;
  pinHitRate: number | null;
  pinN: number;
  brierScore: number | null;
  brierN: number;
  calibration: CalibBucket[];
  windows: { last7: WindowStat; last14: WindowStat; last30: WindowStat };
  trail: TrailPoint[];
  oldestPrediction: string | null;
  newestPrediction: string | null;
  generatedAt: string;
};

function pct(x: number | null): string {
  if (x == null) return "—";
  return `${(x * 100).toFixed(0)}%`;
}

function brierBadge(b: number | null): { label: string; cls: string; desc: string } {
  if (b == null) return { label: "no data", cls: "border-slate-500/40 text-slate-400", desc: "" };
  // Brier reference points for binary classifier:
  //   0.10 = excellent (well-calibrated alpha)
  //   0.20 = good
  //   0.25 = coin flip
  //   0.35+ = miscalibrated
  if (b < 0.15) return { label: "calibrated", cls: "border-green-500/50 bg-green-500/10 text-green-300", desc: "Brier < 0.15 — sharp probabilities" };
  if (b < 0.22) return { label: "decent", cls: "border-emerald-500/40 bg-emerald-500/5 text-emerald-300", desc: "Brier < 0.22 — usable edge" };
  if (b < 0.27) return { label: "coin flip", cls: "border-amber-500/40 bg-amber-500/5 text-amber-300", desc: "Brier ~ 0.25 — no edge over random" };
  return { label: "mis-calibrated", cls: "border-red-500/50 bg-red-500/10 text-red-300", desc: "Brier > 0.27 — model fighting the tape" };
}

function trendDelta(trail: TrailPoint[]): { delta: number; arrow: "up" | "down" | "flat" } {
  if (trail.length < 8) return { delta: 0, arrow: "flat" };
  const recent = trail.slice(-7);
  const earlier = trail.slice(-14, -7);
  if (!earlier.length) return { delta: 0, arrow: "flat" };
  const recentAvg = recent.reduce((a, b) => a + b.rollingHitRate, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b.rollingHitRate, 0) / earlier.length;
  const delta = recentAvg - earlierAvg;
  if (delta > 0.05) return { delta, arrow: "up" };
  if (delta < -0.05) return { delta, arrow: "down" };
  return { delta, arrow: "flat" };
}

export default function MLAccuracyCard({ defaultSymbol = "^GSPC" }: { defaultSymbol?: string }) {
  const { data, isLoading, isError } = useQuery<AccuracyResp>({
    queryKey: ["/api/ml/accuracy-history", defaultSymbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/ml/accuracy-history?symbol=${encodeURIComponent(defaultSymbol)}`);
      return r.json();
    },
    refetchInterval: 30 * 60_000,
    staleTime: 25 * 60_000,
  });

  if (isLoading) {
    return (
      <Card className="border-cyan-500/20 bg-gradient-to-b from-cyan-950/5 to-card">
        <CardContent className="p-4">
          <Skeleton className="h-[260px] w-full bg-muted/20" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-[11px] text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            could not load ML accuracy history · check predictions log
          </div>
        </CardContent>
      </Card>
    );
  }

  const brier = brierBadge(data.brierScore);
  const trend = trendDelta(data.trail);

  // Sparkline geometry
  const SPARK_W = 220;
  const SPARK_H = 36;
  const trailPoints = data.trail.length
    ? data.trail
        .map((t, i) => {
          const x = (i / Math.max(1, data.trail.length - 1)) * SPARK_W;
          const y = SPARK_H - t.rollingHitRate * SPARK_H;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : "";

  return (
    <Card className="border-cyan-500/20 bg-gradient-to-b from-cyan-950/10 to-card">
      <CardContent className="p-4">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Brain className="h-4 w-4 text-cyan-400" />
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">
              ML Agent Scorecard
            </div>
            <div className="text-[10px] text-muted-foreground">
              grades every prediction vs realized closes · honest, no inflation
            </div>
          </div>
          <Badge variant="outline" className={`ml-auto px-2 py-0.5 text-[10px] ${brier.cls}`}>
            {brier.label}
          </Badge>
        </div>

        {/* Top stat row */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">directional hit rate</div>
            <div className="font-mono text-xl text-foreground">
              {pct(data.directionalHitRate)}
            </div>
            <div className="text-[9px] text-muted-foreground/70">
              over {data.directionalNCalls} called predictions
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">brier score</div>
            <div className="font-mono text-xl text-foreground">
              {data.brierScore != null ? data.brierScore.toFixed(3) : "—"}
            </div>
            <div className="text-[9px] text-muted-foreground/70">
              lower = better · 0.25 = coin flip
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">graded</div>
            <div className="font-mono text-xl text-foreground">
              {data.gradedPredictions}/{data.totalPredictions}
            </div>
            <div className="text-[9px] text-muted-foreground/70">
              {data.abstained} abstained (|bias|&lt;0.15)
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">window</div>
            <div className="font-mono text-[11px] text-foreground">
              {data.oldestPrediction ?? "—"}
              <br />
              {data.newestPrediction ?? "—"}
            </div>
          </div>
        </div>

        {/* Per-call breakdown */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded border border-green-500/20 bg-green-500/5 p-2">
            <div className="flex items-center gap-1 text-[9px] uppercase text-green-300">
              <TrendingUp className="h-3 w-3" />
              bull calls
            </div>
            <div className="font-mono text-base text-foreground">
              {pct(data.bullHitRate)} <span className="text-[10px] text-muted-foreground">({data.bullN})</span>
            </div>
          </div>
          <div className="rounded border border-red-500/20 bg-red-500/5 p-2">
            <div className="flex items-center gap-1 text-[9px] uppercase text-red-300">
              <TrendingDown className="h-3 w-3" />
              bear calls
            </div>
            <div className="font-mono text-base text-foreground">
              {pct(data.bearHitRate)} <span className="text-[10px] text-muted-foreground">({data.bearN})</span>
            </div>
          </div>
          <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2">
            <div className="flex items-center gap-1 text-[9px] uppercase text-cyan-300">
              <Target className="h-3 w-3" />
              pin calls
            </div>
            <div className="font-mono text-base text-foreground">
              {pct(data.pinHitRate)} <span className="text-[10px] text-muted-foreground">({data.pinN})</span>
            </div>
          </div>
        </div>

        {/* Rolling windows + sparkline */}
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-border/40 bg-black/30 p-2">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">rolling</div>
          {([
            ["7d", data.windows.last7],
            ["14d", data.windows.last14],
            ["30d", data.windows.last30],
          ] as const).map(([label, w]) => (
            <div key={label} className="text-[10px] font-mono">
              <span className="text-muted-foreground/80">{label}</span>{" "}
              <span className="text-foreground">{pct(w.hitRate)}</span>
              <span className="text-muted-foreground/60"> · b{w.brier != null ? w.brier.toFixed(2) : "—"}</span>
            </div>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {trend.arrow === "up" && (
              <Badge variant="outline" className="border-green-500/40 px-1.5 py-0 text-[9px] text-green-300">
                <TrendingUp className="mr-0.5 h-2.5 w-2.5" />
                improving +{(trend.delta * 100).toFixed(0)}pp
              </Badge>
            )}
            {trend.arrow === "down" && (
              <Badge variant="outline" className="border-red-500/40 px-1.5 py-0 text-[9px] text-red-300">
                <TrendingDown className="mr-0.5 h-2.5 w-2.5" />
                drifting {(trend.delta * 100).toFixed(0)}pp
              </Badge>
            )}
            {trend.arrow === "flat" && (
              <Badge variant="outline" className="border-slate-500/40 px-1.5 py-0 text-[9px] text-slate-400">
                flat
              </Badge>
            )}
            {trailPoints && (
              <svg width={SPARK_W} height={SPARK_H} className="rounded bg-black/40">
                <polyline
                  points={trailPoints}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={1.2}
                  strokeLinejoin="round"
                />
                {/* 50% baseline */}
                <line
                  x1={0}
                  y1={SPARK_H / 2}
                  x2={SPARK_W}
                  y2={SPARK_H / 2}
                  stroke="#475569"
                  strokeWidth={0.4}
                  strokeDasharray="2,3"
                />
              </svg>
            )}
          </div>
        </div>

        {/* Calibration table */}
        {data.calibration.length > 0 && (
          <div className="mt-3 rounded border border-border/40 bg-black/30 p-2">
            <div className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">
              calibration · model pUp vs realized up-rate per decile
            </div>
            <div className="flex flex-wrap gap-1">
              {data.calibration.map((c) => {
                const gap = c.actualUpRate - c.pUpAvg;
                const tone =
                  Math.abs(gap) < 10
                    ? "border-green-500/30 text-green-300"
                    : Math.abs(gap) < 25
                      ? "border-amber-500/40 text-amber-300"
                      : "border-red-500/40 text-red-300";
                return (
                  <div
                    key={c.bucket}
                    className={`rounded border ${tone} bg-black/40 px-1.5 py-1 font-mono text-[9px]`}
                    title={`bucket ${c.bucket * 10}-${(c.bucket + 1) * 10}% pUp · n=${c.n}`}
                  >
                    <div className="text-muted-foreground/80">{c.bucket * 10}-{(c.bucket + 1) * 10}%</div>
                    <div>said {c.pUpAvg.toFixed(0)}</div>
                    <div className="opacity-80">got {c.actualUpRate.toFixed(0)}</div>
                    <div className={`text-[8px] ${gap > 0 ? "text-green-400" : gap < 0 ? "text-red-400" : "text-slate-400"}`}>
                      {gap >= 0 ? "+" : ""}{gap.toFixed(0)}pp
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 text-[9px] text-muted-foreground/70">
              {brier.desc || "tight gap = sharp · big gap = mis-calibrated"}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
