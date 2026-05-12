import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingDown, AlertTriangle, Target, RefreshCw } from "lucide-react";

type Mode = "bounce" | "all";

type Row = {
  symbol: string;
  sectorId: string;
  sectorName: string;
  last: number;
  dayPct: number;
  zScoreDay: number;
  sma5: number;
  sma20: number;
  sma50: number;
  distSma5Pct: number;
  distSma20Pct: number;
  distSma50Pct: number;
  rsi2: number | null;
  advUsd: number;
  bounceRR: number | null;
  setup: "pullback-in-uptrend" | "stretched-below" | "falling-knife";
};

type Resp = {
  asOf: string;
  rows: Row[];
  notes: string;
};

function setupColor(s: Row["setup"]) {
  if (s === "pullback-in-uptrend") return "border-green-500/40 text-green-300 bg-green-500/10";
  if (s === "stretched-below") return "border-amber-500/40 text-amber-300 bg-amber-500/10";
  return "border-red-500/40 text-red-300 bg-red-500/10";
}

function setupLabel(s: Row["setup"]) {
  if (s === "pullback-in-uptrend") return "pullback / uptrend";
  if (s === "stretched-below") return "stretched";
  return "falling knife";
}

function rrColor(rr: number | null) {
  if (rr == null) return "text-muted-foreground";
  if (rr >= 2) return "text-green-400";
  if (rr >= 1) return "text-amber-300";
  return "text-red-300";
}

export default function UnderperformerWatcher() {
  const [mode, setMode] = useState<Mode>("bounce");

  const { data, isLoading, isError, refetch, isFetching } = useQuery<Resp>({
    queryKey: ["/api/underperformers", mode],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/underperformers?mode=${mode}&limit=20`);
      return r.json();
    },
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
  });

  return (
    <Card className="border-red-500/20 bg-gradient-to-b from-red-950/10 to-card">
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <TrendingDown className="h-4 w-4 text-red-400" />
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-red-300/80">
              Prime Underperformer Watcher
            </div>
            <div className="text-[10px] text-muted-foreground">
              today's biggest pullbacks · {data?.notes ?? "loading..."}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1 rounded border border-border/60 bg-black/30 p-0.5">
            {(["bounce", "all"] as Mode[]).map((m) => (
              <Button
                key={m}
                variant={mode === m ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2.5 text-[10px] uppercase tracking-wider"
                onClick={() => setMode(m)}
                data-testid={`btn-underperf-${m}`}
              >
                {m === "bounce" ? "bounce setups" : "all dumps"}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="btn-underperf-refresh"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {isLoading && <Skeleton className="h-48 w-full bg-muted/20" />}

        {isError && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            could not load underperformers
          </div>
        )}

        {data && data.rows.length === 0 && (
          <div className="rounded border border-border/40 bg-black/20 p-4 text-center text-[11px] text-muted-foreground">
            no qualifying bounce candidates · all leaders holding up
          </div>
        )}

        {data && data.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[10px]">
              <thead className="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                <tr className="border-b border-border/40">
                  <th className="px-2 py-1.5 text-left">ticker</th>
                  <th className="px-2 py-1.5 text-left">sector</th>
                  <th className="px-2 py-1.5 text-right">last</th>
                  <th className="px-2 py-1.5 text-right">day%</th>
                  <th className="px-2 py-1.5 text-right">z(60d)</th>
                  <th className="px-2 py-1.5 text-right" title="distance below short-term mean">vs 5d</th>
                  <th className="px-2 py-1.5 text-right" title="distance vs medium-term mean">vs 20d</th>
                  <th className="px-2 py-1.5 text-right" title="trend filter">vs 50d</th>
                  <th className="px-2 py-1.5 text-right" title="Wilder RSI 2-period">RSI(2)</th>
                  <th className="px-2 py-1.5 text-right" title="reclaim 5d / break 20d">R:R</th>
                  <th className="px-2 py-1.5 text-left">setup</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.symbol}
                    className="border-b border-border/20 transition-colors hover:bg-white/5"
                    data-testid={`row-underperf-${r.symbol}`}
                  >
                    <td className="px-2 py-1.5 font-bold text-foreground">{r.symbol}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.sectorName}</td>
                    <td className="px-2 py-1.5 text-right">{r.last.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right text-red-400">
                      {r.dayPct.toFixed(2)}%
                    </td>
                    <td className="px-2 py-1.5 text-right text-amber-300">
                      {r.zScoreDay.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {r.distSma5Pct.toFixed(1)}%
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {r.distSma20Pct.toFixed(1)}%
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right ${
                        r.distSma50Pct >= 0 ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {r.distSma50Pct.toFixed(1)}%
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {r.rsi2 != null ? (
                        <span
                          className={
                            r.rsi2 <= 10
                              ? "text-green-400"
                              : r.rsi2 <= 20
                              ? "text-amber-300"
                              : "text-muted-foreground"
                          }
                        >
                          {r.rsi2.toFixed(0)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`px-2 py-1.5 text-right ${rrColor(r.bounceRR)}`}>
                      {r.bounceRR != null && isFinite(r.bounceRR) ? (
                        <span className="inline-flex items-center gap-0.5">
                          <Target className="h-2.5 w-2.5" />
                          {r.bounceRR.toFixed(1)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge
                        variant="outline"
                        className={`px-1 py-0 text-[8px] uppercase ${setupColor(r.setup)}`}
                      >
                        {setupLabel(r.setup)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-[9px] text-muted-foreground/60">
              setups: <span className="text-green-300">pullback / uptrend</span> = price &gt; 50d SMA but below 5d (best mean-reversion candidates) ·{" "}
              <span className="text-amber-300">stretched</span> = down &gt;1.5σ below mean ·{" "}
              <span className="text-red-300">falling knife</span> = below 20d AND 50d (skip in bounce mode). R:R = reclaim 5d / break 20d.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
