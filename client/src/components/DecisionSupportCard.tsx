// client/src/components/DecisionSupportCard.tsx
//
// Trade Desk panel addition (MASTER_SYNTHESIS Tier 1 + 2). Shows the same
// Kelly / base-rate / vol-drag / P5-P95 / watchdog / hit-rate-CI numbers
// the Discord daily card now prints, but inline in the dashboard UI.
//
// Read-only — every value comes from the new server endpoints which are
// pure observers of existing data. Never modifies any calc.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Activity, Shield, Target, AlertTriangle } from "lucide-react";

type DecisionSupport = {
  block: string;
  lines: string[];
  inputs: {
    spot: number;
    probBull: number;
    probBase: number;
    probBear: number;
    oneDayEM: number;
    realizedSigma20d?: number;
  };
  note?: string;
};

type Watchdog = {
  ok: boolean;
  status: "HEALTHY" | "DRIFTING" | "BROKEN" | "INSUFFICIENT_DATA";
  n: number;
  cValue: number;
  baseline: number;
  thresholds: { warn: number; alarm: number };
  reason: string;
};

type Resolution = {
  n: number;
  bull: { score: number; grade: { letter: string; label: string } };
  base: { score: number; grade: { letter: string; label: string } };
  bear: { score: number; grade: { letter: string; label: string } };
};

const BASE_RATES = { daily: 55, weekly: 59, monthly: 63, yearly: 73 };

function kellyFraction(probWin: number, fraction = 0.5): number {
  if (probWin <= 0.5) return 0;
  return Math.max(0, Math.min(1, fraction * (2 * probWin - 1)));
}

function statusBadgeClass(s: Watchdog["status"]): string {
  switch (s) {
    case "HEALTHY":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
    case "DRIFTING":
      return "border-amber-500/30 bg-amber-500/10 text-amber-400";
    case "BROKEN":
      return "border-rose-500/30 bg-rose-500/10 text-rose-400";
    default:
      return "border-border bg-card text-muted-foreground";
  }
}

function statusLabel(s: Watchdog["status"]): string {
  return s === "INSUFFICIENT_DATA" ? "WARMING UP" : s;
}

export function DecisionSupportCard() {
  const decision = useQuery<DecisionSupport>({
    queryKey: ["/api/decision-support"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/decision-support");
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const watchdog = useQuery<Watchdog>({
    queryKey: ["/api/calibration/watchdog"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/calibration/watchdog");
      return r.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const resolution = useQuery<Resolution>({
    queryKey: ["/api/calibration/resolution"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/calibration/resolution");
      return r.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const ds = decision.data;
  const wd = watchdog.data;
  const rs = resolution.data;

  // Derive Kelly from inputs (already gated by 0.5 threshold server-side)
  const directional = ds
    ? Math.max(ds.inputs.probBull, ds.inputs.probBear)
    : 0;
  const kellySide = ds
    ? ds.inputs.probBull >= ds.inputs.probBear
      ? "long"
      : "short"
    : "long";
  const kellyHasEdge = ds
    ? directional > ds.inputs.probBase && directional > 0.5
    : false;
  const kellyPct = ds && kellyHasEdge ? kellyFraction(directional) * 100 : 0;

  // P5/P95 close band
  const p5p95 = (() => {
    if (!ds) return null;
    const sigma = ds.inputs.oneDayEM;
    const lo = ds.inputs.spot - 1.645 * sigma;
    const hi = ds.inputs.spot + 1.645 * sigma;
    return { lo: Math.round(lo), hi: Math.round(hi) };
  })();

  // Vol drag (only show when sigma > 25%)
  const volDragPct = (() => {
    if (!ds || ds.inputs.realizedSigma20d == null) return null;
    const s = ds.inputs.realizedSigma20d;
    if (!isFinite(s) || s <= 0.25) return null;
    return ((s * s) / 2) * 100;
  })();

  return (
    <Card className="border-amber-500/20" data-testid="card-decision-support">
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Brain className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500">
              Decision Support
            </span>
          </div>
          {wd && (
            <Badge
              variant="outline"
              className={`font-mono text-[10px] uppercase ${statusBadgeClass(wd.status)}`}
              data-testid="badge-watchdog-status"
              title={`${wd.reason} · c=${wd.cValue.toFixed(3)}`}
            >
              <Activity className="mr-1 h-3 w-3" />
              {statusLabel(wd.status)}
            </Badge>
          )}
        </div>

        {/* Top row: Kelly + base rates */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div
            className="rounded-sm border border-border/60 bg-card/30 p-3"
            data-testid="tile-kelly"
          >
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Target className="h-3 w-3" />
              Kelly ½ ({kellySide})
            </div>
            <div className="font-mono text-2xl font-semibold text-foreground">
              {kellyHasEdge ? `${kellyPct.toFixed(1)}%` : "0.0%"}
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {kellyHasEdge
                ? `dominant prob ${(directional * 100).toFixed(0)}% — half-Kelly sizing`
                : "no directional edge — base scenario dominates"}
            </div>
          </div>

          <div
            className="rounded-sm border border-border/60 bg-card/30 p-3"
            data-testid="tile-base-rates"
          >
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              SPX base rate up
            </div>
            <div className="grid grid-cols-4 gap-1 font-mono text-sm">
              <div className="text-center">
                <div className="text-foreground">{BASE_RATES.daily}%</div>
                <div className="text-[9px] uppercase text-muted-foreground">d</div>
              </div>
              <div className="text-center">
                <div className="text-foreground">{BASE_RATES.weekly}%</div>
                <div className="text-[9px] uppercase text-muted-foreground">w</div>
              </div>
              <div className="text-center">
                <div className="text-foreground">{BASE_RATES.monthly}%</div>
                <div className="text-[9px] uppercase text-muted-foreground">m</div>
              </div>
              <div className="text-center">
                <div className="text-foreground">{BASE_RATES.yearly}%</div>
                <div className="text-[9px] uppercase text-muted-foreground">y</div>
              </div>
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              historical SPX positive-return frequency · anti-recency anchor
            </div>
          </div>
        </div>

        {/* Bottom row: P5/P95 band + vol-drag (when active) */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div
            className="rounded-sm border border-border/60 bg-card/30 p-3"
            data-testid="tile-close-band"
          >
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              P5 / P95 close band
            </div>
            <div className="font-mono text-base text-foreground">
              {p5p95
                ? `${p5p95.lo} — ${p5p95.hi}`
                : <span className="text-muted-foreground">—</span>}
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              90% close interval from one-day expected move
            </div>
          </div>

          <div
            className="rounded-sm border border-border/60 bg-card/30 p-3"
            data-testid="tile-vol-drag"
          >
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {volDragPct != null && <AlertTriangle className="h-3 w-3 text-amber-500" />}
              Vol drag
            </div>
            <div className="font-mono text-base text-foreground">
              {volDragPct != null
                ? `−${volDragPct.toFixed(1)}%/yr`
                : <span className="text-muted-foreground">— (σ ≤ 25%)</span>}
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {volDragPct != null
                ? `realized 20d σ = ${((ds!.inputs.realizedSigma20d ?? 0) * 100).toFixed(0)}% — geometric vs arithmetic gap`
                : "displayed only when 20d σ exceeds 25%"}
            </div>
          </div>
        </div>

        {/* Resolution row */}
        {rs && rs.n > 0 && (
          <div className="mt-3 rounded-sm border border-border/60 bg-card/30 p-3" data-testid="tile-resolution">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Shield className="h-3 w-3" />
              Resolution (last {rs.n} days · higher = sharper discrimination)
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
              <ResolutionPill label="bull" g={rs.bull.grade} score={rs.bull.score} />
              <ResolutionPill label="base" g={rs.base.grade} score={rs.base.score} />
              <ResolutionPill label="bear" g={rs.bear.grade} score={rs.bear.score} />
            </div>
          </div>
        )}

        <div className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
          Tier-1/2 observers · Mauboussin probabilities & payoffs · all read-only · never alters scenario calc.
        </div>
      </CardContent>
    </Card>
  );
}

function ResolutionPill({
  label, g, score,
}: {
  label: string;
  g: { letter: string; label: string };
  score: number;
}) {
  return (
    <div className="flex items-center justify-between rounded-sm border border-border/40 bg-card/20 px-2 py-1.5">
      <span className="text-[10px] uppercase text-muted-foreground">{label}</span>
      <span className="text-foreground">
        {score.toFixed(3)} <span className="text-muted-foreground">({g.letter})</span>
      </span>
    </div>
  );
}
