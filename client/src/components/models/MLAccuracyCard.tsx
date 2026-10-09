import EdgeInfo from "@/components/EdgeInfo";
// client/src/components/models/MLAccuracyCard.tsx
//
// Honest, peer-to-peer accuracy card for the Models tab.
// Answers: "is the MM matrix getting better?" The graded probabilities are the
// MM matrix's hand-set priors, not a trained ML model.
//
// Pulls /api/ml/accuracy-history which grades every prediction in
// data/mm-predictions/predictions.jsonl against realized SPX closes.
//
// Shows:
//   - Headline hit rate + Brier + Brier skill vs the climatology base rate
//   - Header pill says "calibrated" ONLY when the server's stated reliability
//     test passes (stats.reliabilityCurve); a Brier threshold never earns it,
//     because Brier mixes calibration with sharpness
//   - Per-call breakdown (bull / bear / pin)
//   - Rolling windows last7 / last14 / last30 — momentum check
//   - Sparkline of rolling hit-rate (newest right)
//   - Reliability curve: predicted vs observed per bin, counts, Wilson 95%
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
type RelBin = {
  lo: number; hi: number; n: number;
  meanPred: number | null; observed: number | null;
  wilsonLo: number | null; wilsonHi: number | null;
  tested: boolean; inInterval: boolean | null;
};
type Reliability = {
  n: number;
  bins: RelBin[];
  brier: number | null;
  climatologyBrier: number | null;
  bss: number | null;
  spiegelhalterZ: number | null;
  spiegelhalterP: number | null;
  verdict: "calibrated" | "not calibrated" | "insufficient data";
  test: { name: string; passed: boolean; reasons: string[] };
};

// Brier, skill vs climatology and its Diebold-Mariano significance, all on
// the independent sample (one daily call per session) the reliability curve uses.
type SkillTest = {
  n: number;
  brier: number | null;
  climatologyBrier: number | null;
  bss: number | null;
  dm: number | null;
  dmP: number | null;
  verdict: "skill" | "no demonstrated skill" | "worse than climatology";
};

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
  reliability?: Reliability;
  skill?: SkillTest;
  modelKind?: string;
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

// Skill label. Never says "calibrated" (that word belongs to the reliability
// test). Compared with the ONE trivial forecaster the server uses everywhere
// (climatology = the realized base rate), with Diebold-Mariano significance,
// on one call per session; not a fixed Brier cut-off.
function skillBadge(skill: SkillTest | undefined): { label: string; cls: string } {
  if (!skill || skill.n === 0) return { label: "skill untested", cls: "border-slate-500/40 text-slate-400" };
  if (skill.verdict === "worse than climatology") return { label: "worse than base rate", cls: "border-red-500/50 bg-red-500/10 text-red-300" };
  if (skill.verdict === "skill") return { label: "skill vs base rate", cls: "border-green-500/50 bg-green-500/10 text-green-300" };
  return { label: "no demonstrated skill", cls: "border-amber-500/40 bg-amber-500/5 text-amber-300" };
}

function dmText(skill: SkillTest): string {
  if (skill.dm != null) return `DM ${skill.dm.toFixed(2)}, n=${skill.n} sessions`;
  return skill.verdict === "no demonstrated skill" ? `n=${skill.n} sessions, too few to test` : `n=${skill.n} sessions, zero-variance difference`;
}

function calibrationPill(rel: Reliability | undefined): { label: string; cls: string; title: string } {
  if (!rel) return { label: "calibration untested", cls: "border-slate-500/40 text-slate-400", title: "no reliability test in this response" };
  const title = `${rel.test.name}${rel.test.reasons.length ? ` | ${rel.test.reasons.join("; ")}` : " | passed"}`;
  if (rel.verdict === "calibrated") return { label: "calibrated", cls: "border-green-500/50 bg-green-500/10 text-green-300", title };
  if (rel.verdict === "not calibrated") return { label: "not calibrated", cls: "border-red-500/50 bg-red-500/10 text-red-300", title };
  return { label: `calibration untested · n=${rel.n}`, cls: "border-slate-500/40 text-slate-400", title };
}

// Reliability diagram: predicted (x) vs observed (y) per bin, Wilson 95% bars,
// dot area ~ count. Dashed diagonal = perfect calibration.
function ReliabilityDiagram({ rel }: { rel: Reliability }) {
  const W = 180, H = 120, P = 14;
  const sx = (v: number) => P + v * (W - 2 * P);
  const sy = (v: number) => H - P - v * (H - 2 * P);
  const filled = rel.bins.filter((b) => b.n > 0 && b.meanPred != null && b.observed != null);
  const maxN = Math.max(1, ...filled.map((b) => b.n));
  return (
    <svg width={W} height={H} className="shrink-0 rounded bg-black/40" role="img" aria-label="reliability curve">
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="#475569" strokeWidth={0.6} strokeDasharray="2,3" />
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(0)} stroke="#334155" strokeWidth={0.6} />
      <line x1={sx(0)} y1={sy(0)} x2={sx(0)} y2={sy(1)} stroke="#334155" strokeWidth={0.6} />
      {filled.map((b) => (
        <g key={b.lo}>
          {b.wilsonLo != null && b.wilsonHi != null && (
            <line x1={sx(b.meanPred!)} x2={sx(b.meanPred!)} y1={sy(b.wilsonLo)} y2={sy(b.wilsonHi)} stroke="#64748b" strokeWidth={1} />
          )}
          <circle
            cx={sx(b.meanPred!)}
            cy={sy(b.observed!)}
            r={1.5 + 3.5 * Math.sqrt(b.n / maxN)}
            fill={b.inInterval === false ? "#f87171" : b.tested ? "#22d3ee" : "#94a3b8"}
          >
            <title>{`said ${(b.meanPred! * 100).toFixed(0)}% · got ${(b.observed! * 100).toFixed(0)}% · n=${b.n} · Wilson ${((b.wilsonLo ?? 0) * 100).toFixed(0)}-${((b.wilsonHi ?? 1) * 100).toFixed(0)}%`}</title>
          </circle>
        </g>
      ))}
      <text x={sx(0.5)} y={H - 2} textAnchor="middle" fontSize={7} fill="#64748b">predicted</text>
      <text x={3} y={sy(0.5)} fontSize={7} fill="#64748b" transform={`rotate(-90 6 ${sy(0.5)})`}>observed</text>
    </svg>
  );
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
    // Transparent retry on 503 (Schwab throttle race during Models tab load).
    retry: (failureCount, error: any) => {
      const msg = String(error?.message ?? "");
      const isThrottle = msg.includes("503") || msg.toLowerCase().includes("schwab");
      return isThrottle && failureCount < 3;
    },
    retryDelay: (attemptIndex) => Math.min(1500 * 2 ** attemptIndex, 10_000),
    placeholderData: (prev) => prev, // keep last good scorecard on transient fail
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

  // Honest zero-graded state — the log has predictions but none could be graded
  // (realized closes unavailable). Say that plainly instead of a "no data" badge.
  if (data.gradedPredictions === 0) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-[11px] text-amber-300" data-testid="text-ml-grading-paused">
            <AlertTriangle className="h-3 w-3" />
            grading paused — {data.totalPredictions} predictions logged but no realized closes to grade against yet.
            backfills automatically once daily bars update.
          </div>
        </CardContent>
      </Card>
    );
  }

  const skill = data.skill;
  const brier = skillBadge(skill);
  const calib = calibrationPill(data.reliability);
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

  // Honesty banners, from the skill test on one call per session:
  //   red   — Brier skill vs the base rate is significantly NEGATIVE (DM >= +2);
  //   amber — no demonstrated skill (not significantly better than the base rate).
  const isMisCalibrated = skill?.verdict === "worse than climatology";
  const isWeak = skill != null && skill.n > 0 && skill.verdict === "no demonstrated skill";

  return (
    <Card className="border-cyan-500/20 bg-gradient-to-b from-cyan-950/10 to-card">
      <CardContent className="p-4">
        {/* Honesty banner — only renders when skill vs the base rate is significantly negative.
            It reports the test; nothing makes the matrix abstain, so it does not say so. */}
        {isMisCalibrated && (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border border-rose-500/50 bg-rose-500/10 p-3"
            data-testid="banner-ml-miscalibrated"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-rose-200">
                significantly worse than the base rate
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-rose-100/90">
                Brier {skill!.brier?.toFixed(3)} vs base rate {skill!.climatologyBrier?.toFixed(3)} (skill {skill!.bss != null ? `${(skill!.bss * 100).toFixed(0)}%` : "n/a"}; {dmText(skill!)}).
                On the graded sessions the matrix odds scored worse than always forecasting the base rate, and the gap is
                statistically significant. The matrix keeps publishing; this is a test result, not a trade instruction.
              </div>
            </div>
          </div>
        )}
        {isWeak && (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
            data-testid="banner-ml-weak"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <div className="text-[11px] leading-snug text-amber-100/90">
              <strong>no demonstrated skill.</strong> Not significantly better than always forecasting the base rate ({dmText(skill!)}).
              The graded record does not support reading these odds as an edge.
            </div>
          </div>
        )}

        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Brain className="h-4 w-4 text-cyan-400" />
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">
              MM Matrix Scorecard
              <EdgeInfo id="ml-accuracy" className="h-6 w-6" />
            </div>
            <div className="text-[11px] text-muted-foreground">
              {data.modelKind ?? "MM matrix hand-set priors (not a trained ML model)"} · graded vs realized closes
            </div>
          </div>
          <Badge
            variant="outline"
            className={`ml-auto px-2 py-0.5 text-[11px] ${calib.cls}`}
            title={calib.title}
            data-testid="badge-ml-calibration"
          >
            {calib.label}
          </Badge>
        </div>

        {/* Top stat row */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">directional hit rate</div>
            <div className="font-mono text-xl text-foreground">
              {pct(data.directionalHitRate)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              over {data.directionalNCalls} called predictions
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">brier score</div>
            <div className="font-mono text-xl text-foreground">
              {data.brierScore != null ? data.brierScore.toFixed(3) : "—"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              all graded rows, n={data.brierN} · lower = better
              {skill && skill.n > 0 && skill.brier != null && (
                <>
                  <br />
                  one call/session, n={skill.n}: Brier {skill.brier.toFixed(3)}
                  {skill.bss != null && <> · skill vs base rate {skill.bss >= 0 ? "+" : ""}{(skill.bss * 100).toFixed(0)}%</>}
                  {" "}· {brier.label}{skill.dm != null ? ` (DM ${skill.dm.toFixed(2)})` : ""}
                </>
              )}
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">graded</div>
            <div className="font-mono text-xl text-foreground">
              {data.gradedPredictions}/{data.totalPredictions}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {data.abstained} abstained (|bias|&lt;0.15)
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">window</div>
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
            <div className="flex items-center gap-1 text-[11px] uppercase text-green-300">
              <TrendingUp className="h-3 w-3" />
              bull calls
            </div>
            <div className="font-mono text-base text-foreground">
              {pct(data.bullHitRate)} <span className="text-[11px] text-muted-foreground">({data.bullN})</span>
            </div>
          </div>
          <div className="rounded border border-red-500/20 bg-red-500/5 p-2">
            <div className="flex items-center gap-1 text-[11px] uppercase text-red-300">
              <TrendingDown className="h-3 w-3" />
              bear calls
            </div>
            <div className="font-mono text-base text-foreground">
              {pct(data.bearHitRate)} <span className="text-[11px] text-muted-foreground">({data.bearN})</span>
            </div>
          </div>
          <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2">
            <div className="flex items-center gap-1 text-[11px] uppercase text-cyan-300">
              <Target className="h-3 w-3" />
              pin calls
            </div>
            <div className="font-mono text-base text-foreground">
              {pct(data.pinHitRate)} <span className="text-[11px] text-muted-foreground">({data.pinN})</span>
            </div>
          </div>
        </div>

        {/* Rolling windows + sparkline */}
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-border/40 bg-black/30 p-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">rolling</div>
          {([
            ["7d", data.windows.last7],
            ["14d", data.windows.last14],
            ["30d", data.windows.last30],
          ] as const).map(([label, w]) => (
            <div key={label} className="text-[11px] font-mono">
              <span className="text-muted-foreground/80">{label}</span>{" "}
              <span className="text-foreground">{pct(w.hitRate)}</span>
              <span className="text-muted-foreground"> · b{w.brier != null ? w.brier.toFixed(2) : "—"}</span>
            </div>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {trend.arrow === "up" && (
              <Badge variant="outline" className="border-green-500/40 px-1.5 py-0 text-[11px] text-green-300">
                <TrendingUp className="mr-0.5 h-2.5 w-2.5" />
                improving +{(trend.delta * 100).toFixed(0)}pp
              </Badge>
            )}
            {trend.arrow === "down" && (
              <Badge variant="outline" className="border-red-500/40 px-1.5 py-0 text-[11px] text-red-300">
                <TrendingDown className="mr-0.5 h-2.5 w-2.5" />
                drifting {(trend.delta * 100).toFixed(0)}pp
              </Badge>
            )}
            {trend.arrow === "flat" && (
              <Badge variant="outline" className="border-slate-500/40 px-1.5 py-0 text-[11px] text-slate-400">
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

        {/* Reliability curve: the evidence behind (and shown before) any "calibrated" label */}
        {data.reliability && data.reliability.n > 0 ? (
          <div className="mt-3 rounded border border-border/40 bg-black/30 p-2" data-testid="ml-reliability-curve">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              reliability · predicted P(up &gt; 0.05%) vs realized per bin · Wilson 95% · one daily call per session (n={data.reliability.n})
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <ReliabilityDiagram rel={data.reliability} />
              <div className="flex flex-1 flex-wrap gap-1">
                {data.reliability.bins.filter((b) => b.n > 0).map((b) => (
                  <div
                    key={b.lo}
                    className={`rounded border ${b.inInterval === false ? "border-red-500/40 text-red-300" : b.tested ? "border-green-500/30 text-green-300" : "border-slate-500/30 text-slate-400"} bg-black/40 px-1.5 py-1 font-mono text-[11px]`}
                    title={b.tested ? "tested bin" : "too few forecasts to test"}
                  >
                    <div className="text-muted-foreground/80">{Math.round(b.lo * 100)}-{Math.round(b.hi * 100)}%</div>
                    <div>said {((b.meanPred ?? 0) * 100).toFixed(0)}</div>
                    <div className="opacity-80">got {((b.observed ?? 0) * 100).toFixed(0)}</div>
                    <div className="text-[11px] opacity-70">
                      {((b.wilsonLo ?? 0) * 100).toFixed(0)}-{((b.wilsonHi ?? 1) * 100).toFixed(0)} · n={b.n}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground" data-testid="text-ml-calibration-test">
              test: {data.reliability.test.name}.{" "}
              {data.reliability.spiegelhalterZ != null && (
                <>Spiegelhalter Z {data.reliability.spiegelhalterZ.toFixed(2)} (p {data.reliability.spiegelhalterP?.toFixed(3)}). </>
              )}
              {data.reliability.test.passed ? "passed." : data.reliability.test.reasons.join("; ") + "."}
            </div>
          </div>
        ) : data.calibration.length > 0 ? (
          <div className="mt-3 rounded border border-border/40 bg-black/30 p-2">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              model pUp vs realized up-rate per decile · calibration untested
            </div>
            <div className="flex flex-wrap gap-1">
              {data.calibration.map((c) => (
                <div
                  key={c.bucket}
                  className="rounded border border-slate-500/30 bg-black/40 px-1.5 py-1 font-mono text-[11px] text-slate-300"
                  title={`bucket ${c.bucket * 10}-${(c.bucket + 1) * 10}% pUp · n=${c.n}`}
                >
                  <div className="text-muted-foreground/80">{c.bucket * 10}-{(c.bucket + 1) * 10}%</div>
                  <div>said {c.pUpAvg.toFixed(0)}</div>
                  <div className="opacity-80">got {c.actualUpRate.toFixed(0)}</div>
                  <div className="text-[11px] opacity-70">n={c.n}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
