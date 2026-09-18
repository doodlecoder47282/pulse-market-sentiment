// MISSION FIX — Truth panel: the three honesty reports in one place.
//   1. Grade calibration — do graded fires actually win at the rate the letter implies?
//   2. Walk-forward backtest — level stats without overlapping-window inflation, vs baselines.
//   3. Orthogonality — which whale-gate features carry independent information.
// Everything here self-reports sample size and says "insufficient" instead of faking precision.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface CalBucket { label: string; n: number; wins: number; winRate: number | null; wilsonLo: number | null; wilsonHi: number | null; fitted: number | null; prior: number }
interface CalReport { source: "fitted" | "prior"; totalGradedFires: number; buckets: CalBucket[]; rejectedCounterfactual: { n: number; winRate: number | null; note: string }; note: string }

interface WfRow { horizon: string; levelKind: string; pooledN: number; pooledTouchRate: number; wfN: number; wfTouchRate: number | null; wfHoldRate: number | null }
interface WfSummary { rows: WfRow[]; methodology: string; note: string }

interface OrthoBucket { bucket: string; n: number; winRate: number; lift: number; trusted: boolean }
interface OrthoFeature { feature: string; buckets: OrthoBucket[]; spread: number; verdict: string }
interface OrthoReport { usableRows: number; gradedTotal: number; ungradeable: { noHoldingPeriod: number; insufficientHistory: number }; baseWinRate: number | null; status: string; features: OrthoFeature[]; note: string }

const pctFmt = (x: number | null | undefined, dash = "—") =>
  x == null || !Number.isFinite(x) ? dash : `${(x * 100).toFixed(0)}%`;

function CalibrationCard() {
  const q = useQuery<CalReport>({ queryKey: ["/api/edge/calibration"], refetchInterval: 5 * 60_000 });
  const r = q.data;
  return (
    <Card data-testid="card-calibration">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold tracking-tight">grade calibration — asserted vs realized</CardTitle>
          {r && (
            <Badge variant="outline" className={r.source === "fitted" ? "text-emerald-500 border-emerald-500/30" : "text-amber-500 border-amber-500/30"} data-testid="badge-cal-source">
              {r.source === "fitted" ? "empirically fitted" : "prior (ledger filling)"}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          the sizer converts grade to win probability. until this table converges, that conversion is a hypothesis, not a fact — the source badge tells you which one you're trading on.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {q.isLoading && <p className="text-xs text-muted-foreground">loading…</p>}
        {r && (
          <>
            <div className="hscroll-contain">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1 pr-2 font-medium">grade</th>
                    <th className="text-right py-1 px-2 font-medium">n</th>
                    <th className="text-right py-1 px-2 font-medium">realized</th>
                    <th className="text-right py-1 px-2 font-medium">95% CI</th>
                    <th className="text-right py-1 px-2 font-medium">fitted</th>
                    <th className="text-right py-1 pl-2 font-medium">prior</th>
                  </tr>
                </thead>
                <tbody>
                  {r.buckets.map((b) => (
                    <tr key={b.label} className="border-b border-border/40" data-testid={`row-cal-${b.label}`}>
                      <td className="py-1 pr-2 font-mono">{b.label}</td>
                      <td className="text-right py-1 px-2 font-mono tabular-nums">{b.n}</td>
                      <td className="text-right py-1 px-2 font-mono tabular-nums">{pctFmt(b.winRate)}</td>
                      <td className="text-right py-1 px-2 font-mono tabular-nums text-muted-foreground">
                        {b.wilsonLo != null ? `${pctFmt(b.wilsonLo)}–${pctFmt(b.wilsonHi)}` : "—"}
                      </td>
                      <td className="text-right py-1 px-2 font-mono tabular-nums">{pctFmt(b.fitted)}</td>
                      <td className="text-right py-1 pl-2 font-mono tabular-nums text-muted-foreground">{pctFmt(b.prior)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground leading-snug" data-testid="text-cal-note">
              {r.totalGradedFires} graded fires. {r.note}
            </p>
            <p className="text-xs text-muted-foreground leading-snug">
              counterfactual — rejected setups graded anyway: n={r.rejectedCounterfactual.n}, win {pctFmt(r.rejectedCounterfactual.winRate)}. {r.rejectedCounterfactual.note}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WalkForwardCard() {
  const q = useQuery<WfSummary>({ queryKey: ["/api/edge/walkforward"], refetchInterval: 10 * 60_000 });
  const r = q.data;
  const horizons = ["daily", "weekly", "monthly", "quarterly"];
  const isBaseline = (k: string) => k.startsWith("baseline");
  return (
    <Card data-testid="card-walkforward">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">walk-forward backtest — honest sample sizes</CardTitle>
        <p className="text-xs text-muted-foreground leading-snug">
          pooled numbers score every day with overlapping forward windows — autocorrelated and flattering. wf columns stride the calendar so windows never overlap. a level only matters if it beats BOTH baseline rows at the same horizon.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {q.isLoading && <p className="text-xs text-muted-foreground">loading…</p>}
        {r && r.rows.length === 0 && (
          <p className="text-xs text-muted-foreground">no backtest observations yet — run the backtest rebuild first (baselines are added on the next rebuild).</p>
        )}
        {r && horizons.map((h) => {
          const rows = r.rows.filter((x) => x.horizon === h);
          if (rows.length === 0) return null;
          return (
            <div key={h}>
              <p className="text-xs font-semibold mb-1 uppercase tracking-wide text-muted-foreground">{h}</p>
              <div className="hscroll-contain">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left py-1 pr-2 font-medium">level</th>
                      <th className="text-right py-1 px-2 font-medium">pooled n</th>
                      <th className="text-right py-1 px-2 font-medium">pooled touch</th>
                      <th className="text-right py-1 px-2 font-medium">wf n</th>
                      <th className="text-right py-1 px-2 font-medium">wf touch</th>
                      <th className="text-right py-1 pl-2 font-medium">wf hold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr key={x.levelKind} className={`border-b border-border/40 ${isBaseline(x.levelKind) ? "bg-muted/40" : ""}`} data-testid={`row-wf-${h}-${x.levelKind}`}>
                        <td className="py-1 pr-2 font-mono">{x.levelKind}{isBaseline(x.levelKind) ? " (baseline)" : ""}</td>
                        <td className="text-right py-1 px-2 font-mono tabular-nums text-muted-foreground line-through decoration-border">{x.pooledN}</td>
                        <td className="text-right py-1 px-2 font-mono tabular-nums text-muted-foreground">{pctFmt(x.pooledTouchRate)}</td>
                        <td className="text-right py-1 px-2 font-mono tabular-nums">{x.wfN}</td>
                        <td className="text-right py-1 px-2 font-mono tabular-nums font-semibold">{pctFmt(x.wfTouchRate)}</td>
                        <td className="text-right py-1 pl-2 font-mono tabular-nums">{pctFmt(x.wfHoldRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
        {r && <p className="text-xs text-muted-foreground leading-snug">{r.note}</p>}
      </CardContent>
    </Card>
  );
}

function OrthogonalityCard() {
  const q = useQuery<OrthoReport>({ queryKey: ["/api/edge/orthogonality"], refetchInterval: 10 * 60_000 });
  const r = q.data;
  return (
    <Card data-testid="card-orthogonality">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold tracking-tight">signal orthogonality — what actually carries information</CardTitle>
          {r && (
            <Badge variant="outline" className={r.status === "ok" ? "text-emerald-500 border-emerald-500/30" : "text-amber-500 border-amber-500/30"} data-testid="badge-ortho-status">
              {r.status === "ok" ? `${r.usableRows} usable rows` : `insufficient (${r.usableRows} rows)`}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          the whale gate ANDs five conditions. this measures which ones separate winners from losers and which are dead weight. v1 marginal lift — flat spread means the feature is likely redundant.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {q.isLoading && <p className="text-xs text-muted-foreground">loading…</p>}
        {r && (
          <>
            <p className="text-xs text-muted-foreground">
              base win rate {pctFmt(r.baseWinRate)} over {r.usableRows} usable graded whales ({r.gradedTotal} graded total; {r.ungradeable.noHoldingPeriod} pending-regrade / no-holding-period, {r.ungradeable.insufficientHistory} insufficient history).
            </p>
            {r.features.map((f) => (
              <div key={f.feature} data-testid={`ortho-feature-${f.feature.replace(/\W+/g, "-")}`}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs font-semibold">{f.feature}</p>
                  <p className="text-xs text-muted-foreground">spread {pctFmt(f.spread)} — {f.verdict}</p>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {f.buckets.map((b) => (
                    <span
                      key={b.bucket}
                      className={`text-xs font-mono px-1.5 py-0.5 rounded border ${b.trusted ? "border-border" : "border-dashed border-border/60 text-muted-foreground"}`}
                      title={b.trusted ? undefined : "under 10 rows — untrusted"}
                    >
                      {b.bucket}: {pctFmt(b.winRate)} ({b.lift >= 0 ? "+" : ""}{(b.lift * 100).toFixed(0)}) n={b.n}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground leading-snug">{r.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function TruthPanel() {
  return (
    <div className="space-y-3" data-testid="truth-panel">
      <CalibrationCard />
      <WalkForwardCard />
      <OrthogonalityCard />
    </div>
  );
}
