/**
 * Backtest Accuracy Overlay
 *
 * Renders historical hit-rates for our key dealer-level proxies.
 * Two render modes:
 *   - <BacktestBadge horizon="daily" kind="putWall" />   → inline chip (used in rail rows)
 *   - <BacktestPanel defaultHorizon="daily" />           → full collapsible panel
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, ChevronRight, RefreshCw, History, Info } from "lucide-react";

export type BacktestHorizon = "daily" | "weekly" | "monthly" | "quarterly";
export type BacktestLevelKind =
  | "callWall" | "putWall" | "zeroGamma" | "dominantMag"
  | "upsidePivot" | "downsidePivot" | "mopexMaxPain"
  | "extremeVac" | "vommaPocket";

interface BacktestRow {
  horizon: BacktestHorizon;
  levelKind: BacktestLevelKind;
  sampleSize: number;
  touchRate: number;
  holdRate: number;
  avgAbsDistBps: number;
  medianAbsDistBps: number;
  breachBeyondPct: number;
}

interface BacktestSummary {
  methodology: string;
  computedAt: number | null;
  byLevel: Record<string, BacktestRow>;
}

// Map Models panel level kinds → backtest kinds
// (not all live levels have backtest equivalents; unmapped returns null)
const KIND_MAP: Record<string, BacktestLevelKind | null> = {
  callWall: "callWall",
  putWall: "putWall",
  zeroGamma: "zeroGamma",
  dominantMag: "dominantMag",
  upsidePivot: "upsidePivot",
  downsidePivot: "downsidePivot",
  mopexMaxPain: "mopexMaxPain",
  extremeVac: "extremeVac",
  // others (charmTarget, vannaFlip, zommaBridge, upperVomma, lowerVomma, negGammaEntry) not backtested in v1
};

const LABELS: Record<BacktestLevelKind, string> = {
  callWall: "Call Wall",
  putWall: "Put Wall",
  zeroGamma: "Gamma Zero",
  dominantMag: "Dom Magnet",
  upsidePivot: "Upside Pivot",
  downsidePivot: "Downside Pivot",
  mopexMaxPain: "Max Pain",
  extremeVac: "Ext Vacuum",
  vommaPocket: "Vomma Pocket",
};

function useBacktest() {
  return useQuery<BacktestSummary>({
    queryKey: ["/api/backtest/levels"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/backtest/levels");
      return r.json();
    },
    refetchInterval: 30 * 60_000,   // refresh every 30min (engine is snapshot-based)
    staleTime: 15 * 60_000,
  });
}

function rateColor(rate: number, kind: "touch" | "hold"): string {
  // Touch rates of 40%+ are strong; hold rates are rarer, 20%+ is meaningful
  const t = kind === "touch" ? rate : rate * 2;
  if (t >= 0.6) return "text-emerald-400";
  if (t >= 0.4) return "text-green-400";
  if (t >= 0.25) return "text-amber-400";
  return "text-rose-400";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

// ─── Inline badge (for rail rows) ────────────────────────────────────────────

export function BacktestBadge({
  horizon,
  kind,
}: {
  horizon: BacktestHorizon;
  kind: string;
}) {
  const { data } = useBacktest();
  const mapped = KIND_MAP[kind];
  if (!mapped || !data) return null;
  const row = data.byLevel[`${horizon}|${mapped}`];
  if (!row || row.sampleSize < 20) return null;

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`ml-1 cursor-help font-mono text-[8px] font-bold ${rateColor(row.touchRate, "touch")}`}
            data-testid={`backtest-badge-${horizon}-${kind}`}
          >
            {pct(row.touchRate)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs bg-black/95 font-mono text-[10px]">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-amber-400">
            {LABELS[mapped]} · {horizon.toUpperCase()}
          </div>
          <div className="space-y-0.5 text-muted-foreground">
            <div>Touched: <span className={rateColor(row.touchRate, "touch")}>{pct(row.touchRate)}</span> of <span className="text-white">{row.sampleSize}</span> obs</div>
            <div>Held (reversed ≥50%): <span className={rateColor(row.holdRate, "hold")}>{pct(row.holdRate)}</span></div>
            <div>Avg miss at close: <span className="text-white">{row.avgAbsDistBps.toFixed(0)}bps</span></div>
            <div>Breached &gt;1%: <span className="text-rose-400">{pct(row.breachBeyondPct)}</span></div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─── Full collapsible panel ──────────────────────────────────────────────────

export function BacktestPanel({ defaultHorizon = "daily" as BacktestHorizon }: { defaultHorizon?: BacktestHorizon }) {
  const { data, isLoading, refetch, isFetching } = useBacktest();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const [horizon, setHorizon] = useState<BacktestHorizon>(defaultHorizon);

  const rebuild = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/backtest/rebuild?years=5");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/levels"] });
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const out: BacktestRow[] = [];
    for (const k of Object.keys(data.byLevel)) {
      const r = data.byLevel[k];
      if (r.horizon === horizon) out.push(r);
    }
    // sort by touch rate descending, so strongest levels float up
    return out.sort((a, b) => b.touchRate - a.touchRate);
  }, [data, horizon]);

  const computedStr = data?.computedAt
    ? new Date(data.computedAt * 1000).toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric",
      })
    : "—";

  const empty = !isLoading && (!data || rows.length === 0);

  return (
    <div
      className="rounded-lg border border-violet-500/20 bg-black/30"
      data-testid="backtest-section"
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 border-b border-violet-500/20 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-violet-300/80 hover:bg-violet-500/5"
        data-testid="btn-backtest-toggle"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <History className="h-3 w-3" />
        Backtest Accuracy · 5Y
        <Badge variant="outline" className="ml-2 border-amber-500/40 font-mono text-[8px] text-amber-300/90">
          PROXY MODE
        </Badge>
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3 w-3 text-muted-foreground/60" />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-sm bg-black/95 font-mono text-[10px] leading-relaxed">
              Proxy mode: historical option chains aren't available from free feeds,
              so levels are reconstructed using standard analytic proxies
              (ATR × VIX for walls, 20D EMA for zero-gamma, σ-bands for pivots,
              round-number clusters for max-pain). Matches our live engine when
              OI is sparse. Upgrade path: Polygon.io flat files or ORATS for
              true dealer-level reconstruction.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="ml-auto text-muted-foreground/50">computed {computedStr}</span>
      </button>

      {open && (
        <div className="p-3 space-y-2">
          {/* Horizon selector + rebuild */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded border border-border/60 bg-black/30 p-0.5">
              {(["daily", "weekly", "monthly", "quarterly"] as BacktestHorizon[]).map(h => (
                <Button
                  key={h}
                  variant={horizon === h ? "default" : "ghost"}
                  size="sm"
                  className="h-6 px-2.5 text-[10px] uppercase tracking-wider"
                  onClick={() => setHorizon(h)}
                  data-testid={`btn-bt-horizon-${h}`}
                >
                  {h === "quarterly" ? "3M" : h}
                </Button>
              ))}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => rebuild.mutate()}
              disabled={rebuild.isPending || isFetching}
              className="h-6 gap-1 font-mono text-[10px]"
              data-testid="btn-backtest-rebuild"
            >
              <RefreshCw className={`h-3 w-3 ${rebuild.isPending || isFetching ? "animate-spin" : ""}`} />
              {rebuild.isPending ? "Rebuilding…" : "Rebuild"}
            </Button>

            <span className="font-mono text-[9px] text-muted-foreground/60">
              Free feeds → analytic proxies. See tooltip for methodology.
            </span>
          </div>

          {isLoading && (
            <div className="h-32 animate-pulse rounded bg-muted/10" />
          )}

          {empty && !rebuild.isPending && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-center font-mono text-[10px] text-amber-300">
              No backtest data yet. The initial 5-year backfill runs ~8s after server boot;
              click Rebuild if it hasn't populated.
            </div>
          )}

          {!empty && !isLoading && (
            <>
              <div className="overflow-x-auto rounded border border-border/40">
                <table className="w-full border-collapse font-mono text-[10px]">
                  <thead className="bg-black/50 text-muted-foreground/70">
                    <tr className="border-b border-border/40">
                      <th className="px-2 py-1.5 text-left text-[9px] uppercase tracking-wider">Level</th>
                      <th className="px-2 py-1.5 text-right text-[9px] uppercase tracking-wider">Touch %</th>
                      <th className="px-2 py-1.5 text-right text-[9px] uppercase tracking-wider">Hold %</th>
                      <th className="px-2 py-1.5 text-right text-[9px] uppercase tracking-wider">Avg Miss</th>
                      <th className="px-2 py-1.5 text-right text-[9px] uppercase tracking-wider">Median Miss</th>
                      <th className="px-2 py-1.5 text-right text-[9px] uppercase tracking-wider">Breach &gt;1%</th>
                      <th className="px-2 py-1.5 text-right text-[9px] uppercase tracking-wider">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.levelKind} className="border-b border-border/20 hover:bg-violet-500/5" data-testid={`bt-row-${r.levelKind}`}>
                        <td className="px-2 py-1.5 text-white">{LABELS[r.levelKind]}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${rateColor(r.touchRate, "touch")}`}>{pct(r.touchRate)}</td>
                        <td className={`px-2 py-1.5 text-right ${rateColor(r.holdRate, "hold")}`}>{pct(r.holdRate)}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{r.avgAbsDistBps.toFixed(0)} bps</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{r.medianAbsDistBps.toFixed(0)} bps</td>
                        <td className="px-2 py-1.5 text-right text-rose-400/80">{pct(r.breachBeyondPct)}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground/70">{r.sampleSize}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-0.5 pt-1 font-mono text-[9px] leading-tight text-muted-foreground/60">
                <div>
                  <span className="text-amber-400">Touch %:</span> price came within tolerance of level during horizon window.
                </div>
                <div>
                  <span className="text-amber-400">Hold %:</span> touched AND reversed ≥50% back toward spot (stickiness).
                </div>
                <div>
                  <span className="text-amber-400">Avg/Median Miss:</span> distance between predicted level and realized close at horizon end.
                </div>
                <div>
                  <span className="text-amber-400">Breach &gt;1%:</span> price went more than 1% past the level (level failed).
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
