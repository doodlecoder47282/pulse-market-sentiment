import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";

interface AnomalyResult {
  date: string;
  features: { name: string; value: number; z: number }[];
  nearestNeighborDistance: number;
  meanDistance: number;
  pctileVsHistory: number;
  isAnomaly: boolean;
  closestDates: { date: string; distance: number }[];
  notes: string;
}

interface DriftResult {
  recent30: { count: number; meanAbsPctReturn: number | null; meanHit50: number | null };
  prior90: { count: number; meanAbsPctReturn: number | null; meanHit50: number | null };
  driftPctMae: number | null;
  driftPctHit: number | null;
  status: "stable" | "drifting" | "n/a";
  note: string;
}

const driftColor = (s: string) => {
  if (s === "stable") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (s === "drifting") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  return "bg-muted text-muted-foreground border-border";
};

export default function AnomalyPanel() {
  const q = useQuery<{ anomaly: AnomalyResult | { error: string }; drift: DriftResult }>({
    queryKey: ["/api/anomaly"],
    refetchInterval: 60000 * 5,
  });

  const a = q.data?.anomaly;
  const d = q.data?.drift;
  const anomalyError = a && "error" in a;
  const anomaly = !anomalyError ? (a as AnomalyResult | undefined) : undefined;

  const pctile = anomaly?.pctileVsHistory ?? 0;
  const isHot = anomaly?.isAnomaly;

  return (
    <div className="space-y-3" data-testid="anomaly-panel">

      {q.isLoading && <div className="text-xs text-muted-foreground">scoring today…</div>}
      {q.isError && <div className="text-xs text-rose-500">error: {(q.error as any)?.message}</div>}

      {/* Anomaly */}
      {anomalyError && <div className="rounded border border-border p-3 text-xs text-muted-foreground">anomaly: {(a as any).error}</div>}
      {anomaly && (
        <>
          <div className="rounded border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">today's anomaly score</div>
              <Badge
                variant="outline"
                className={`text-xs ${isHot ? "bg-rose-500/15 text-rose-500 border-rose-500/30" : "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"}`}
                data-testid="badge-anomaly-status"
              >
                {isHot ? "anomaly" : "normal"}
              </Badge>
            </div>

            {/* Gauge bar */}
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0%</span>
                <span className="font-mono font-semibold text-foreground">{pctile.toFixed(1)}% percentile</span>
                <span>100%</span>
              </div>
              <div className="h-2 rounded-full bg-muted/40 overflow-hidden relative">
                <div
                  className={`h-full ${isHot ? "bg-rose-500" : pctile > 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${Math.max(2, Math.min(100, pctile))}%` }}
                />
                <div className="absolute top-0 bottom-0 border-l border-rose-500/50" style={{ left: "95%" }} />
              </div>
              <div className="text-[10px] text-muted-foreground">red line = 95% threshold</div>
            </div>

            <p className="text-xs mt-2 leading-relaxed">{anomaly.notes}</p>
          </div>

          {/* Features */}
          <div className="rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">today's feature z-scores</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {anomaly.features.map(f => (
                <div key={f.name} className="rounded border border-border/60 bg-muted/20 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.name}</div>
                  <div className="text-sm font-semibold tabular-nums">{f.value.toFixed(2)}</div>
                  <div className={`text-[10px] font-mono ${Math.abs(f.z) >= 2 ? "text-rose-500 font-semibold" : "text-muted-foreground"}`}>
                    z = {f.z >= 0 ? "+" : ""}{f.z.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Closest dates */}
          {anomaly.closestDates.length > 0 && (
            <div className="rounded border border-border p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">closest historical analogs</div>
              <div className="space-y-1">
                {anomaly.closestDates.map((c, i) => (
                  <div key={c.date} className="flex justify-between text-xs">
                    <span className="font-mono">#{i + 1} {c.date}</span>
                    <span className="font-mono text-muted-foreground">distance {c.distance.toFixed(3)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Drift */}
      {d && (
        <div className="rounded border border-border p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">model drift monitor</div>
            <Badge variant="outline" className={`text-xs ${driftColor(d.status)}`} data-testid="badge-drift-status">
              {d.status}
            </Badge>
          </div>
          {d.status === "n/a" ? (
            <p className="text-xs text-muted-foreground">{d.note}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Tile label="recent 30" value={`MAE ${d.recent30.meanAbsPctReturn?.toFixed(2) ?? "—"}%`} hint={`hit ${d.recent30.meanHit50?.toFixed(0) ?? "—"}%`} />
                <Tile label="prior 90" value={`MAE ${d.prior90.meanAbsPctReturn?.toFixed(2) ?? "—"}%`} hint={`hit ${d.prior90.meanHit50?.toFixed(0) ?? "—"}%`} />
                <Tile label="MAE drift" value={d.driftPctMae == null ? "—" : `${d.driftPctMae >= 0 ? "+" : ""}${d.driftPctMae.toFixed(1)}%`} positive={-(d.driftPctMae ?? 0)} />
                <Tile label="hit drift" value={d.driftPctHit == null ? "—" : `${d.driftPctHit >= 0 ? "+" : ""}${d.driftPctHit.toFixed(1)}%`} positive={d.driftPctHit} />
              </div>
              <p className="text-[11px] text-muted-foreground mt-2 leading-snug">{d.note}</p>
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground leading-snug">
        anomaly score = how far today's market vector (composite, VIX, GEX, P/C, 5d return) sits from history. ≥95th percentile = unusual day, look back at the closest analogs for what played out. drift = is the model getting worse over time?
      </p>
    </div>
  );
}

function Tile({ label, value, hint, positive }: { label: string; value: string; hint?: string; positive?: number | null }) {
  const color = positive == null ? "" : positive > 0 ? "text-emerald-500" : positive < 0 ? "text-rose-500" : "";
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
