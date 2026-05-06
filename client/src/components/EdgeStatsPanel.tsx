// Closed-loop edge stats — rolling hit-rates by symbol/type/premium/vol-oi/delta,
// regime calibration, threshold suggestions. Data: GET /api/edge/stats.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TrendingUp, Target, Zap, AlertTriangle, RefreshCw, CheckCircle2 } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface BySymbol { symbol: string; n: number; hit30Rate: number; avgPctReturn: number; }
interface ByType { type: "CALL" | "PUT"; n: number; hit30Rate: number; avgPctReturn: number; }
interface ByTier { tier: string; n: number; hit30Rate: number; avgPctReturn: number; }
interface WhaleEdge {
  total: number; graded: number; pending: number;
  hit30Rate: number; hit50Rate: number; hit100Rate: number;
  avgPctReturn: number;
  bySymbol: BySymbol[]; byType: ByType[];
  byPremiumTier: ByTier[]; byVolOiTier: ByTier[]; byDeltaTier: ByTier[];
}
interface ConfBucket { bucket: string; n: number; hitRate: number; }
interface ByRegime { regime: string; n: number; hitRate: number; }
interface CalibPoint { predictedProb: number; actualHitRate: number; n: number; }
interface RegimeEdge {
  total: number; graded: number; pending: number;
  overallHitRate: number;
  byConfidenceBucket: ConfBucket[];
  byRegime: ByRegime[];
  calibration: CalibPoint[];
}
interface Suggestion {
  field: "premiumFloor" | "volOiRatio" | "deltaMin" | string;
  currentNote: string;
  suggested: number;
  rationale: string;
  liftHit30: number;
  alertReductionPct: number;
}
interface EdgeStats {
  asOf: number;
  windowDays: number;
  whaleAlerts: WhaleEdge;
  regimeCalls: RegimeEdge;
  suggestions: Suggestion[];
}

// ── Formatters ────────────────────────────────────────────────────────────────

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const pctSigned = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

function rateColor(r: number): string {
  if (r >= 0.5) return "text-emerald-400";
  if (r >= 0.3) return "text-amber-400";
  if (r >= 0.15) return "text-orange-400";
  return "text-red-400";
}

function returnColor(r: number): string {
  if (r >= 0.3) return "text-emerald-400";
  if (r > 0) return "text-emerald-400/80";
  if (r > -0.1) return "text-amber-400";
  return "text-red-400";
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function HeadlineCards({ w, r }: { w: WhaleEdge; r: RegimeEdge }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="edge-headline-cards">
      <div className="rounded-md border border-border/50 bg-card/40 p-3">
        <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Whale Hit-30</div>
        <div className={`text-2xl font-semibold ${rateColor(w.hit30Rate)}`} data-testid="text-whale-hit30">
          {w.graded ? pct(w.hit30Rate) : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground">{w.graded} graded · {w.pending} pending</div>
      </div>
      <div className="rounded-md border border-border/50 bg-card/40 p-3">
        <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Whale Hit-50</div>
        <div className={`text-2xl font-semibold ${rateColor(w.hit50Rate)}`} data-testid="text-whale-hit50">
          {w.graded ? pct(w.hit50Rate) : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground">target zone</div>
      </div>
      <div className="rounded-md border border-border/50 bg-card/40 p-3">
        <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Whale Hit-100</div>
        <div className={`text-2xl font-semibold ${rateColor(w.hit100Rate)}`} data-testid="text-whale-hit100">
          {w.graded ? pct(w.hit100Rate) : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground">banger zone</div>
      </div>
      <div className="rounded-md border border-border/50 bg-card/40 p-3">
        <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Regime Hit</div>
        <div className={`text-2xl font-semibold ${rateColor(r.overallHitRate)}`} data-testid="text-regime-hit">
          {r.graded ? pct(r.overallHitRate) : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground">{r.graded} graded · {r.pending} pending</div>
      </div>
    </div>
  );
}

function MatrixRow({ label, n, rate, ret }: { label: string; n: number; rate: number; ret: number }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-2 py-1.5 hover-elevate rounded-sm">
      <div className="text-sm font-medium tabular-nums">{label}</div>
      <div className="text-xs text-muted-foreground tabular-nums">n={n}</div>
      <div className={`text-sm font-semibold tabular-nums ${rateColor(rate)}`}>{pct(rate)}</div>
      <div className={`text-xs tabular-nums ${returnColor(ret)}`}>{pctSigned(ret)}</div>
    </div>
  );
}

function HitMatrix({ w }: { w: WhaleEdge }) {
  const sections: { title: string; rows: { label: string; n: number; rate: number; ret: number }[] }[] = [
    { title: "By Symbol", rows: w.bySymbol.map(s => ({ label: s.symbol, n: s.n, rate: s.hit30Rate, ret: s.avgPctReturn })) },
    { title: "By Type", rows: w.byType.map(s => ({ label: s.type, n: s.n, rate: s.hit30Rate, ret: s.avgPctReturn })) },
    { title: "By Premium", rows: w.byPremiumTier.map(s => ({ label: s.tier, n: s.n, rate: s.hit30Rate, ret: s.avgPctReturn })) },
    { title: "By Vol/OI", rows: w.byVolOiTier.map(s => ({ label: s.tier, n: s.n, rate: s.hit30Rate, ret: s.avgPctReturn })) },
    { title: "By Delta", rows: w.byDeltaTier.map(s => ({ label: s.tier, n: s.n, rate: s.hit30Rate, ret: s.avgPctReturn })) },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {sections.map(section => (
        <div key={section.title} className="rounded-md border border-border/50 bg-card/40 p-2.5">
          <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-1.5 px-2">{section.title}</div>
          {section.rows.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">no data</div>
          ) : (
            <div className="space-y-0.5">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 text-[10px] text-muted-foreground">
                <div>tier</div><div>n</div><div>hit-30</div><div>avg ret</div>
              </div>
              {section.rows.map((r, i) => (
                <MatrixRow key={i} label={r.label} n={r.n} rate={r.rate} ret={r.ret} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CalibrationPlot({ r }: { r: RegimeEdge }) {
  // Simple inline-SVG calibration: predicted vs actual (45° line is perfect calibration)
  const size = 240;
  const pad = 28;
  const inner = size - pad * 2;
  return (
    <div className="rounded-md border border-border/50 bg-card/40 p-3">
      <div className="text-[11px] uppercase text-muted-foreground tracking-wider mb-2">Regime Calibration</div>
      <div className="flex flex-col md:flex-row gap-4 items-start">
        <svg width={size} height={size} className="shrink-0" data-testid="svg-calibration">
          {/* axes */}
          <line x1={pad} y1={size - pad} x2={size - pad} y2={size - pad} stroke="currentColor" strokeOpacity="0.2" />
          <line x1={pad} y1={pad} x2={pad} y2={size - pad} stroke="currentColor" strokeOpacity="0.2" />
          {/* perfect calibration line */}
          <line x1={pad} y1={size - pad} x2={size - pad} y2={pad} stroke="currentColor" strokeOpacity="0.15" strokeDasharray="3,3" />
          {/* points */}
          {r.calibration.map((p, i) => {
            if (p.n === 0) return null;
            const cx = pad + p.predictedProb * inner;
            const cy = size - pad - p.actualHitRate * inner;
            const radius = Math.min(10, 3 + Math.sqrt(p.n));
            const wellCalibrated = Math.abs(p.predictedProb - p.actualHitRate) < 0.1;
            return (
              <g key={i}>
                <circle cx={cx} cy={cy} r={radius} className={wellCalibrated ? "fill-emerald-400/70" : "fill-amber-400/70"} />
                <text x={cx} y={cy - radius - 3} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.6">n={p.n}</text>
              </g>
            );
          })}
          {/* axis labels */}
          <text x={size / 2} y={size - 4} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.5">predicted</text>
          <text x={8} y={size / 2} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.5" transform={`rotate(-90 8 ${size / 2})`}>actual</text>
        </svg>
        <div className="flex-1 space-y-1.5 text-sm">
          <div className="text-[11px] uppercase text-muted-foreground tracking-wider">By Confidence</div>
          {r.byConfidenceBucket.map((b, i) => (
            <div key={i} className="flex justify-between items-baseline">
              <span className="text-xs text-muted-foreground">{b.bucket}</span>
              <span className="tabular-nums">
                <span className="text-[10px] text-muted-foreground mr-2">n={b.n}</span>
                <span className={`font-semibold ${b.n > 0 ? rateColor(b.hitRate) : "text-muted-foreground"}`}>
                  {b.n > 0 ? pct(b.hitRate) : "—"}
                </span>
              </span>
            </div>
          ))}
          <div className="text-[11px] uppercase text-muted-foreground tracking-wider pt-2">By Regime</div>
          {r.byRegime.length === 0 ? (
            <div className="text-xs text-muted-foreground">no data</div>
          ) : (
            r.byRegime.map((rg, i) => (
              <div key={i} className="flex justify-between items-baseline">
                <span className="text-xs text-muted-foreground">{rg.regime}</span>
                <span className="tabular-nums">
                  <span className="text-[10px] text-muted-foreground mr-2">n={rg.n}</span>
                  <span className={`font-semibold ${rateColor(rg.hitRate)}`}>{pct(rg.hitRate)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SuggestionsPanel({ suggestions }: { suggestions: Suggestion[] }) {
  const [appliedField, setAppliedField] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);

  const applyMutation = useMutation({
    mutationFn: async (s: Suggestion) => {
      // PATCH /api/flow/config with the suggested field. Server is the source of truth.
      const body: Record<string, number> = {};
      body[s.field] = s.suggested;
      return apiRequest("PATCH", "/api/flow/config", body);
    },
    onSuccess: (_data, s) => {
      setAppliedField(s.field);
      setErrorField(null);
      queryClient.invalidateQueries({ queryKey: ["/api/edge/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/flow/config"] });
    },
    onError: (_err, s) => {
      setErrorField(s.field);
    },
  });

  if (suggestions.length === 0) {
    return (
      <div className="rounded-md border border-border/50 bg-card/40 p-3 text-sm text-muted-foreground" data-testid="text-no-suggestions">
        no threshold tweaks suggested. current gates look reasonable based on the rolling window.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase text-muted-foreground tracking-wider">Threshold Suggestions</div>
      {suggestions.map((s, i) => (
        <div key={i} className="rounded-md border border-border/50 bg-card/40 p-3" data-testid={`card-suggestion-${s.field}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400 text-[10px]">
                  {s.field}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {s.currentNote} → <span className="font-semibold text-foreground">{s.suggested}</span>
                </span>
              </div>
              <p className="text-sm mt-1.5">{s.rationale}</p>
              <div className="flex items-center gap-3 mt-1.5 text-xs">
                <span className="text-emerald-400 tabular-nums">+{pct(s.liftHit30)} lift</span>
                <span className="text-muted-foreground tabular-nums">−{pct(s.alertReductionPct, 0)} alerts</span>
              </div>
            </div>
            <div className="shrink-0">
              {appliedField === s.field ? (
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 gap-1">
                  <CheckCircle2 className="h-3 w-3" /> applied
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => applyMutation.mutate(s)}
                  disabled={applyMutation.isPending}
                  data-testid={`button-apply-${s.field}`}
                >
                  {applyMutation.isPending ? "applying..." : "apply"}
                </Button>
              )}
              {errorField === s.field && (
                <div className="text-[10px] text-red-400 mt-1">apply failed</div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function EdgeStatsPanel() {
  const [windowDays, setWindowDays] = useState<number>(30);

  const { data, isLoading, refetch, isFetching } = useQuery<EdgeStats>({
    queryKey: ["/api/edge/stats", windowDays],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/edge/stats?windowDays=${windowDays}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const gradeNowMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/edge/grade-now");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/edge/stats"] });
    },
  });

  if (isLoading || !data) {
    return (
      <Card data-testid="card-edge-stats-loading">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-4 w-4" />
            Edge Loop
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-edge-stats">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-amber-400" />
            Edge Loop
            <Badge variant="outline" className="ml-2 text-[10px] border-border/50 bg-card/30">
              {data.windowDays}d window
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {[14, 30, 60, 90].map(d => (
              <Button
                key={d}
                size="sm"
                variant={windowDays === d ? "default" : "ghost"}
                className="h-6 px-2 text-[11px]"
                onClick={() => setWindowDays(d)}
                data-testid={`button-window-${d}`}
              >
                {d}d
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => { gradeNowMutation.mutate(); refetch(); }}
              disabled={gradeNowMutation.isPending || isFetching}
              data-testid="button-refresh-edge"
              title="grade now + refresh"
            >
              <RefreshCw className={`h-3 w-3 ${(gradeNowMutation.isPending || isFetching) ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <HeadlineCards w={data.whaleAlerts} r={data.regimeCalls} />

        <Tabs defaultValue="matrix" className="w-full">
          <TabsList className="grid grid-cols-3 h-8">
            <TabsTrigger value="matrix" className="text-xs gap-1.5" data-testid="tab-matrix">
              <Zap className="h-3 w-3" /> hit matrix
            </TabsTrigger>
            <TabsTrigger value="calibration" className="text-xs gap-1.5" data-testid="tab-calibration">
              <TrendingUp className="h-3 w-3" /> calibration
            </TabsTrigger>
            <TabsTrigger value="suggestions" className="text-xs gap-1.5" data-testid="tab-suggestions">
              <AlertTriangle className="h-3 w-3" /> suggestions
              {data.suggestions.length > 0 && (
                <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] border-amber-500/40 bg-amber-500/10 text-amber-400">
                  {data.suggestions.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matrix" className="mt-3">
            {data.whaleAlerts.graded === 0 ? (
              <div className="rounded-md border border-border/50 bg-card/40 p-6 text-sm text-muted-foreground text-center">
                no graded whale alerts in this window yet. predictions populate as alerts fire and grading dates pass.
              </div>
            ) : (
              <HitMatrix w={data.whaleAlerts} />
            )}
          </TabsContent>
          <TabsContent value="calibration" className="mt-3">
            {data.regimeCalls.graded === 0 ? (
              <div className="rounded-md border border-border/50 bg-card/40 p-6 text-sm text-muted-foreground text-center">
                no graded regime calls yet.
              </div>
            ) : (
              <CalibrationPlot r={data.regimeCalls} />
            )}
          </TabsContent>
          <TabsContent value="suggestions" className="mt-3">
            <SuggestionsPanel suggestions={data.suggestions} />
          </TabsContent>
        </Tabs>

        <div className="text-[10px] text-muted-foreground text-center pt-1">
          last grade: {new Date(data.asOf).toLocaleTimeString()} · auto-refreshes every 60s
        </div>
      </CardContent>
    </Card>
  );
}
