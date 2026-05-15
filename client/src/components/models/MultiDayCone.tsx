// client/src/components/models/MultiDayCone.tsx
//
// Multi-day forward vol cone for SPX/SPY. NOT a trained ML model — it's a
// realized-vol cone with regime adjustment. Labeled honestly.
//
// Shows 10 forward sessions with q10/q25/q50/q75/q90 bands, anchored to spot,
// drifted by 10d median (dampened 0.5x), σ scaled by √t and adjusted by
// VIX/realized blowup factor.
//
// Companion to MLProjectionPanel (intraday). Same Models tab.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, AlertTriangle } from "lucide-react";

type Band = {
  day: number;
  date: string;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
};

type Resp = {
  symbol: string;
  spot: number;
  asOfTs: number;
  sigmaDaily: number;
  sigmaAnnualizedPct: number;
  driftDaily: number;
  volBlowupFactor: number;
  bands: Band[];
  source: string;
  honestyNote: string;
  computedAt: string;
};

const CHART_W = 720;
const CHART_H = 280;
const PAD_L = 50;
const PAD_R = 60;
const PAD_T = 20;
const PAD_B = 30;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

export default function MultiDayCone({ defaultSymbol = "^GSPC" }: { defaultSymbol?: string }) {
  const { data, isLoading, isError } = useQuery<Resp>({
    queryKey: ["/api/projection/multiday", defaultSymbol],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/projection/multiday?symbol=${encodeURIComponent(defaultSymbol)}`);
      return r.json();
    },
    refetchInterval: 15 * 60_000,
    staleTime: 10 * 60_000,
  });

  const geom = useMemo(() => {
    if (!data) return null;
    const allPrices = [
      data.spot,
      ...data.bands.flatMap((b) => [b.q10, b.q25, b.q50, b.q75, b.q90]),
    ];
    const lo = Math.min(...allPrices);
    const hi = Math.max(...allPrices);
    const pad = (hi - lo) * 0.08;
    const yMin = lo - pad;
    const yMax = hi + pad;

    // x range: day 0 (spot) to day 10
    const xOf = (day: number) => PAD_L + (day / 10) * PLOT_W;
    const yOf = (p: number) => PAD_T + (1 - (p - yMin) / Math.max(0.001, yMax - yMin)) * PLOT_H;

    // Build polygon paths for q10-q90 (outer cone) and q25-q75 (inner)
    const upperOuter = data.bands.map((b) => `${xOf(b.day).toFixed(1)},${yOf(b.q90).toFixed(1)}`);
    const lowerOuter = [...data.bands].reverse().map((b) => `${xOf(b.day).toFixed(1)},${yOf(b.q10).toFixed(1)}`);
    const outerPoly = [`${xOf(0).toFixed(1)},${yOf(data.spot).toFixed(1)}`, ...upperOuter, ...lowerOuter].join(" ");

    const upperInner = data.bands.map((b) => `${xOf(b.day).toFixed(1)},${yOf(b.q75).toFixed(1)}`);
    const lowerInner = [...data.bands].reverse().map((b) => `${xOf(b.day).toFixed(1)},${yOf(b.q25).toFixed(1)}`);
    const innerPoly = [`${xOf(0).toFixed(1)},${yOf(data.spot).toFixed(1)}`, ...upperInner, ...lowerInner].join(" ");

    // q50 drift line including spot anchor
    const midLine = [
      `${xOf(0).toFixed(1)},${yOf(data.spot).toFixed(1)}`,
      ...data.bands.map((b) => `${xOf(b.day).toFixed(1)},${yOf(b.q50).toFixed(1)}`),
    ].join(" ");

    return { yMin, yMax, xOf, yOf, outerPoly, innerPoly, midLine };
  }, [data]);

  if (isLoading) {
    return (
      <Card className="border-indigo-500/20 bg-gradient-to-b from-indigo-950/5 to-card">
        <CardContent className="p-4">
          <Skeleton className="h-[280px] w-full bg-muted/20" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data || !geom) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-[11px] text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            could not build multi-day cone · check Schwab status
          </div>
        </CardContent>
      </Card>
    );
  }

  const lastBand = data.bands[data.bands.length - 1];
  const upsidePct = ((lastBand.q90 - data.spot) / data.spot) * 100;
  const downsidePct = ((lastBand.q10 - data.spot) / data.spot) * 100;
  const midPct = ((lastBand.q50 - data.spot) / data.spot) * 100;

  return (
    <Card className="border-indigo-500/20 bg-gradient-to-b from-indigo-950/10 to-card">
      <CardContent className="p-4">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-400" />
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-indigo-300/80">
              Multi-Day Forward Cone · 10 sessions
            </div>
            <div className="text-[10px] text-muted-foreground">
              realized vol cone · q10/q25/q50/q75/q90 · honest, not a trained model
            </div>
          </div>
          <Badge variant="outline" className="ml-auto border-amber-500/40 bg-amber-500/5 px-2 py-0.5 text-[9px] text-amber-300">
            vol cone · not ML
          </Badge>
        </div>

        {/* Stats strip */}
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase text-muted-foreground">spot</div>
            <div className="font-mono text-sm text-foreground">{data.spot.toFixed(2)}</div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase text-muted-foreground">σ daily / annual</div>
            <div className="font-mono text-sm text-foreground">
              {(data.sigmaDaily * 100).toFixed(2)}% / {data.sigmaAnnualizedPct.toFixed(1)}%
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase text-muted-foreground">drift / day</div>
            <div className={`font-mono text-sm ${data.driftDaily > 0 ? "text-green-400" : data.driftDaily < 0 ? "text-red-400" : "text-foreground"}`}>
              {data.driftDaily >= 0 ? "+" : ""}
              {(data.driftDaily * 100).toFixed(3)}%
            </div>
          </div>
          <div className="rounded border border-border/40 bg-black/30 p-2">
            <div className="text-[9px] uppercase text-muted-foreground">vol blowup factor</div>
            <div className="font-mono text-sm text-foreground">{data.volBlowupFactor.toFixed(2)}x</div>
          </div>
        </div>

        {/* Chart */}
        <div className="overflow-x-auto rounded border border-border/40 bg-black/40">
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            className="block w-full"
            style={{ maxWidth: "100%", height: "auto", minHeight: 280 }}
          >
            <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} fill="#020617" stroke="#1f2937" strokeWidth={0.5} />

            {/* Y ticks */}
            {[0, 0.33, 0.66, 1].map((t) => {
              const price = geom.yMin + (geom.yMax - geom.yMin) * (1 - t);
              const y = PAD_T + t * PLOT_H;
              return (
                <g key={t}>
                  <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} stroke="#1f2937" strokeWidth={0.3} />
                  <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#64748b" fontFamily="monospace">
                    {price.toFixed(price > 100 ? 0 : 2)}
                  </text>
                </g>
              );
            })}

            {/* X ticks (days) */}
            {Array.from({ length: 11 }, (_, i) => i).map((d) => {
              const x = geom.xOf(d);
              return (
                <g key={d}>
                  <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + PLOT_H} stroke="#1f2937" strokeWidth={0.2} />
                  <text x={x} y={PAD_T + PLOT_H + 14} textAnchor="middle" fontSize={9} fill="#64748b" fontFamily="monospace">
                    {d === 0 ? "now" : `+${d}d`}
                  </text>
                </g>
              );
            })}

            {/* Outer cone (q10-q90) */}
            <polygon points={geom.outerPoly} fill="#6366f1" opacity={0.15} />
            {/* Inner cone (q25-q75) */}
            <polygon points={geom.innerPoly} fill="#6366f1" opacity={0.25} />
            {/* q50 drift line */}
            <polyline points={geom.midLine} fill="none" stroke="#a5b4fc" strokeWidth={2} strokeDasharray="0" />
            {/* Edges */}
            <polyline
              points={data.bands.map((b) => `${geom.xOf(b.day).toFixed(1)},${geom.yOf(b.q90).toFixed(1)}`).join(" ")}
              fill="none"
              stroke="#86efac"
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.7}
            />
            <polyline
              points={data.bands.map((b) => `${geom.xOf(b.day).toFixed(1)},${geom.yOf(b.q10).toFixed(1)}`).join(" ")}
              fill="none"
              stroke="#fca5a5"
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.7}
            />

            {/* Spot anchor dot */}
            <circle cx={geom.xOf(0)} cy={geom.yOf(data.spot)} r={3} fill="#22d3ee" />
            <text x={geom.xOf(0) + 6} y={geom.yOf(data.spot) - 6} fontSize={9} fill="#22d3ee" fontFamily="monospace">
              spot {data.spot.toFixed(2)}
            </text>

            {/* End labels */}
            <text
              x={geom.xOf(10) + 4}
              y={geom.yOf(lastBand.q90) + 3}
              fontSize={9}
              fill="#86efac"
              fontFamily="monospace"
            >
              q90 {lastBand.q90.toFixed(0)} ({upsidePct >= 0 ? "+" : ""}{upsidePct.toFixed(1)}%)
            </text>
            <text
              x={geom.xOf(10) + 4}
              y={geom.yOf(lastBand.q50) + 3}
              fontSize={9}
              fill="#a5b4fc"
              fontFamily="monospace"
            >
              q50 {lastBand.q50.toFixed(0)} ({midPct >= 0 ? "+" : ""}{midPct.toFixed(1)}%)
            </text>
            <text
              x={geom.xOf(10) + 4}
              y={geom.yOf(lastBand.q10) + 3}
              fontSize={9}
              fill="#fca5a5"
              fontFamily="monospace"
            >
              q10 {lastBand.q10.toFixed(0)} ({downsidePct.toFixed(1)}%)
            </text>
          </svg>
        </div>

        {/* Day-by-day table strip (compact) */}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full font-mono text-[9px]">
            <thead className="text-muted-foreground/60">
              <tr>
                <th className="text-left py-1 px-1">day</th>
                <th className="text-right py-1 px-1">q10</th>
                <th className="text-right py-1 px-1">q25</th>
                <th className="text-right py-1 px-1">q50</th>
                <th className="text-right py-1 px-1">q75</th>
                <th className="text-right py-1 px-1">q90</th>
                <th className="text-right py-1 px-1 text-muted-foreground/80">width</th>
              </tr>
            </thead>
            <tbody>
              {data.bands.map((b) => {
                const width = ((b.q90 - b.q10) / data.spot) * 100;
                return (
                  <tr key={b.day} className="border-t border-border/30">
                    <td className="py-0.5 px-1 text-muted-foreground">+{b.day}d</td>
                    <td className="py-0.5 px-1 text-right text-red-300/80">{b.q10.toFixed(2)}</td>
                    <td className="py-0.5 px-1 text-right text-red-300/60">{b.q25.toFixed(2)}</td>
                    <td className="py-0.5 px-1 text-right text-indigo-200">{b.q50.toFixed(2)}</td>
                    <td className="py-0.5 px-1 text-right text-green-300/60">{b.q75.toFixed(2)}</td>
                    <td className="py-0.5 px-1 text-right text-green-300/80">{b.q90.toFixed(2)}</td>
                    <td className="py-0.5 px-1 text-right text-muted-foreground/70">±{(width / 2).toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Honesty footer */}
        <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[9px] text-amber-300/80">
          <span className="font-bold uppercase tracking-wider">methodology:</span> {data.honestyNote}
        </div>
      </CardContent>
    </Card>
  );
}
