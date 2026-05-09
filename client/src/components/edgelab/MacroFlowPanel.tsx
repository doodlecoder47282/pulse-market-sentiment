import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface FredObservation {
  seriesId: string;
  label: string;
  latest: number | null;
  latestDate: string | null;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  weekChange: number | null;
  monthChange: number | null;
}

interface CotSnapshotRow {
  market: string;
  reportDate: string;
  commercialNet: number;
  nonCommercialNet: number;
  oi: number;
  nonCommercialPctile: number | null;
  weekChangeNonComm: number | null;
  bias: "spec-extreme-long" | "spec-extreme-short" | "neutral" | "tilting-long" | "tilting-short";
}

const fmtNum = (n: number | null | undefined, dp = 2) =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(dp);
const fmtSigned = (n: number | null | undefined, dp = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(dp)}`;

const biasColor = (b: string) => {
  if (b === "spec-extreme-long") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  if (b === "spec-extreme-short") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (b === "tilting-long") return "bg-orange-500/15 text-orange-500 border-orange-500/30";
  if (b === "tilting-short") return "bg-cyan-500/15 text-cyan-500 border-cyan-500/30";
  return "bg-muted text-muted-foreground border-border";
};

export default function MacroFlowPanel() {
  const fredQ = useQuery<{ series: FredObservation[] }>({
    queryKey: ["/api/fred"],
    refetchInterval: 60000 * 60,
  });
  const cotQ = useQuery<{ markets: CotSnapshotRow[] }>({
    queryKey: ["/api/cot"],
    refetchInterval: 60000 * 60,
  });

  const refreshFred = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/fred/refresh", {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/fred"] }),
  });
  const refreshCot = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/cot/refresh", {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/cot"] }),
  });

  return (
    <div className="space-y-3" data-testid="macro-flow-panel">
      {/* FRED */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">macro (FRED)</div>
          <Button size="sm" variant="outline" data-testid="button-fred-refresh" onClick={() => refreshFred.mutate()} disabled={refreshFred.isPending}>
            refresh
          </Button>
        </div>
        {fredQ.isLoading && <div className="text-xs text-muted-foreground">loading macro series…</div>}
        {fredQ.data && fredQ.data.series.length === 0 && (
          <div className="text-xs text-muted-foreground">no FRED data yet — hit refresh</div>
        )}
        {fredQ.data && fredQ.data.series.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {fredQ.data.series.map(s => (
              <div key={s.seriesId} className="rounded border border-border/60 bg-muted/20 p-2" data-testid={`tile-fred-${s.seriesId}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">{s.seriesId}</span>
                  <span className="text-[10px] text-muted-foreground">{s.latestDate ?? "—"}</span>
                </div>
                <div className="text-[10px] text-muted-foreground leading-tight mb-1">{s.label}</div>
                <div className="text-sm font-semibold tabular-nums">{fmtNum(s.latest, 2)}</div>
                <div className="flex gap-2 text-[10px] mt-1">
                  <span className={(s.change ?? 0) >= 0 ? "text-emerald-500" : "text-rose-500"}>
                    Δ {fmtSigned(s.change, 3)}
                  </span>
                  <span className={(s.weekChange ?? 0) >= 0 ? "text-emerald-500" : "text-rose-500"}>
                    1w {fmtSigned(s.weekChange, 3)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* COT */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">commitments of traders (CFTC)</div>
          <Button size="sm" variant="outline" data-testid="button-cot-refresh" onClick={() => refreshCot.mutate()} disabled={refreshCot.isPending}>
            refresh
          </Button>
        </div>
        {cotQ.isLoading && <div className="text-xs text-muted-foreground">loading COT…</div>}
        {cotQ.data && cotQ.data.markets.length === 0 && (
          <div className="text-xs text-muted-foreground">no COT data yet — hit refresh</div>
        )}
        {cotQ.data && cotQ.data.markets.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1 pr-2">market</th>
                  <th className="text-left py-1 pr-2">report</th>
                  <th className="text-right py-1 pr-2">non-comm net</th>
                  <th className="text-right py-1 pr-2">comm net</th>
                  <th className="text-right py-1 pr-2">OI</th>
                  <th className="text-right py-1 pr-2">pctile (3y)</th>
                  <th className="text-right py-1 pr-2">1w Δ</th>
                  <th className="text-left py-1 pl-2">bias</th>
                </tr>
              </thead>
              <tbody>
                {cotQ.data.markets.map(r => (
                  <tr key={r.market} className="border-b border-border/40" data-testid={`row-cot-${r.market}`}>
                    <td className="py-1 pr-2 font-mono font-semibold">{r.market}</td>
                    <td className="py-1 pr-2 text-muted-foreground font-mono">{r.reportDate}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${r.nonCommercialNet >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {r.nonCommercialNet.toLocaleString()}
                    </td>
                    <td className={`py-1 pr-2 text-right font-mono ${r.commercialNet >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {r.commercialNet.toLocaleString()}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono text-muted-foreground">{r.oi.toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right font-mono">{r.nonCommercialPctile == null ? "—" : `${r.nonCommercialPctile.toFixed(0)}%`}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${(r.weekChangeNonComm ?? 0) >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {r.weekChangeNonComm == null ? "—" : r.weekChangeNonComm.toLocaleString()}
                    </td>
                    <td className="py-1 pl-2">
                      <Badge variant="outline" className={`text-[10px] py-0 px-1 h-4 ${biasColor(r.bias)}`}>
                        {r.bias.replace(/-/g, " ")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground leading-snug">
        FRED = official macro plumbing (rates, fed balance sheet, credit spreads, inflation). COT non-commercial pctile flags positioning extremes — &gt;90% = crowded long, &lt;10% = crowded short. extremes mean-revert at turning points.
      </p>
    </div>
  );
}
