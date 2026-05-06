// Exit Brain panel — real-time exit scoring for tracked 0DTE positions
// API endpoint: /api/exit-brain/snapshot

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, TrendingDown, Target } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExitCategories {
  hardStop: number;
  stackCollapse: number;
  reversion: number;
  targetsHit: number;
  vixSpike: number;
  gammaFlip: number;
}

interface ExitBrainEval {
  positionId: string;
  contractKey: string;
  side: "call" | "put";
  mark: number;
  entry: number;
  drawdownPct: number;
  peakReturnPct: number;
  action: "HOLD" | "TRIM" | "EXIT" | "TRAIL";
  exitScore: number;
  categories: ExitCategories;
  reasons: string[];
  asOf: string;
}

interface ExitBrainConfig {
  hardStopPct: number;
  trimScore: number;
  exitScore: number;
  trailScore: number;
}

interface ExitBrainDiagnostics {
  lastTickMs: number;
  ticks: number;
  errors: number;
  lastError?: string;
}

interface ExitBrainSnapshot {
  asOf: string;
  running: boolean;
  intervalMs: number;
  evals: ExitBrainEval[];
  config: ExitBrainConfig;
  diagnostics: ExitBrainDiagnostics;
}

// ── Formatters / helpers ──────────────────────────────────────────────────────

function fmtSecondsAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

function actionBadgeClass(action: string): string {
  if (action === "HOLD") return "border-muted-foreground/40 bg-muted/20 text-muted-foreground";
  if (action === "TRIM") return "border-amber-500/50 bg-amber-500/10 text-amber-400";
  if (action === "EXIT") return "border-red-500/50 bg-red-500/15 text-red-400";
  if (action === "TRAIL") return "border-emerald-500/50 bg-emerald-500/10 text-emerald-400";
  return "border-muted-foreground/40 bg-muted/20 text-muted-foreground";
}

function drawdownColor(d: number): string {
  if (d <= -20) return "text-red-500";
  if (d <= -10) return "text-orange-400";
  if (d < 0) return "text-amber-400";
  return "text-muted-foreground";
}

function scoreBarColor(score: number): string {
  if (score >= 70) return "bg-red-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-emerald-500/60";
}

// ── Mini category bar ─────────────────────────────────────────────────────────

function MiniBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={`mini-bar-${label.replace(/\s/g, "-").toLowerCase()}`}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/60">{label}</div>
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-amber-500/60 transition-all"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    </div>
  );
}

// ── Eval row ─────────────────────────────────────────────────────────────────

function EvalRow({ ev }: { ev: ExitBrainEval }) {
  const topReasons = ev.reasons.slice(0, 3);

  return (
    <div
      className="rounded-md border border-border/30 bg-card/40 px-3 py-3 space-y-2"
      data-testid={`eval-row-${ev.positionId}`}
    >
      {/* Row 1: contract info + action badge + score */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold text-foreground text-xs" data-testid={`eval-key-${ev.positionId}`}>
          {ev.contractKey}
        </span>
        <Badge
          variant="outline"
          className={`text-[9px] ${ev.side === "call" ? "border-emerald-500/40 text-emerald-400" : "border-red-500/40 text-red-400"}`}
          data-testid={`eval-side-${ev.positionId}`}
        >
          {ev.side.toUpperCase()}
        </Badge>
        <Badge
          variant="outline"
          className={`text-[9px] font-semibold ${actionBadgeClass(ev.action)}`}
          data-testid={`eval-action-${ev.positionId}`}
        >
          {ev.action}
        </Badge>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">entry</span>
          <span className="font-mono" data-testid={`eval-entry-${ev.positionId}`}>${ev.entry.toFixed(2)}</span>
          <span className="text-muted-foreground">mark</span>
          <span className="font-mono" data-testid={`eval-mark-${ev.positionId}`}>${ev.mark.toFixed(2)}</span>
          <span className={`font-mono font-semibold ${drawdownColor(ev.drawdownPct)}`} data-testid={`eval-drawdown-${ev.positionId}`}>
            {ev.drawdownPct >= 0 ? "+" : ""}{ev.drawdownPct.toFixed(1)}%
          </span>
          <span className="text-emerald-400/70 font-mono" data-testid={`eval-peak-${ev.positionId}`}>
            peak +{ev.peakReturnPct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Row 2: exit score progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground uppercase tracking-wider">exit score</span>
          <span className="font-mono font-semibold" data-testid={`eval-score-${ev.positionId}`}>{ev.exitScore}/100</span>
        </div>
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden" data-testid={`eval-score-bar-${ev.positionId}`}>
          <div
            className={`h-full transition-all ${scoreBarColor(ev.exitScore)}`}
            style={{ width: `${ev.exitScore}%` }}
          />
        </div>
      </div>

      {/* Row 3: top reasons */}
      {topReasons.length > 0 && (
        <div className="space-y-0.5" data-testid={`eval-reasons-${ev.positionId}`}>
          {topReasons.map((r, i) => (
            <div key={i} className="text-[11px] text-muted-foreground leading-snug">
              · {r}
            </div>
          ))}
        </div>
      )}

      {/* Row 4: category mini-bars */}
      <div className="grid grid-cols-5 gap-2 pt-1" data-testid={`eval-categories-${ev.positionId}`}>
        <MiniBar label="stack" value={ev.categories.stackCollapse} />
        <MiniBar label="revert" value={ev.categories.reversion} />
        <MiniBar label="targets" value={ev.categories.targetsHit} />
        <MiniBar label="vix" value={ev.categories.vixSpike} />
        <MiniBar label="gamma" value={ev.categories.gammaFlip} />
      </div>
    </div>
  );
}

// ── Empty skeleton ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="space-y-3" data-testid="exit-brain-empty">
      <div className="rounded-md border border-dashed border-border/30 py-6 text-center text-xs text-muted-foreground">
        no active 0DTE positions tracked
      </div>
      <Skeleton className="h-8 w-full opacity-40" />
      <Skeleton className="h-8 w-3/4 opacity-30" />
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function ExitBrainPanel() {
  const { data, isLoading } = useQuery<ExitBrainSnapshot>({
    queryKey: ["/api/exit-brain/snapshot"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/exit-brain/snapshot");
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const secondsAgo = data?.diagnostics?.lastTickMs != null
    ? fmtSecondsAgo(Date.now() - data.diagnostics.lastTickMs)
    : null;

  const evalCount = data?.evals?.length ?? 0;

  return (
    <Card className="border-rose-500/20 bg-gradient-to-br from-card to-rose-950/5" data-testid="card-exit-brain">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-rose-400" data-testid="header-exit-brain">
            <ShieldAlert className="h-4 w-4" />
            EXIT BRAIN
          </CardTitle>
          {isLoading ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            <>
              {data?.running ? (
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-[9px]" data-testid="exit-brain-running">
                  running
                </Badge>
              ) : (
                <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground text-[9px]" data-testid="exit-brain-stopped">
                  stopped
                </Badge>
              )}
              {secondsAgo && (
                <span className="text-xs text-muted-foreground" data-testid="exit-brain-tick">
                  last tick {secondsAgo} ago
                </span>
              )}
              <span className="text-xs text-muted-foreground" data-testid="exit-brain-eval-count">
                {evalCount} evals
              </span>
              {data?.diagnostics?.errors != null && data.diagnostics.errors > 0 && (
                <span className="text-xs text-red-400/70 ml-1" data-testid="exit-brain-errors">
                  {data.diagnostics.errors} errors
                </span>
              )}
            </>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !data || evalCount === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3" data-testid="exit-brain-evals">
            {data.evals.map((ev) => (
              <EvalRow key={ev.positionId} ev={ev} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
