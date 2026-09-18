// MISSION FIX #6 — participation breadth card (GET /api/breadth).
// Sampled internals from the Schwab daily-bars cache: % above 20/50dma,
// advancers, RSP/SPY equal-weight ratio trend, and a thin-tape divergence flag.
// Honest about being a 36-stock sample, not full NYSE internals.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Layers } from "lucide-react";

interface BreadthSnapshot {
  asOf: number;
  sampleSize: number;
  pctAbove20dma: number | null;
  pctAbove50dma: number | null;
  advancersPct: number | null;
  rspSpyZ: number | null;
  divergence: boolean;
  history: { date: string; pctAbove20: number }[];
  read: string;
  note: string;
}

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);

function MiniBars({ history }: { history: { date: string; pctAbove20: number }[] }) {
  if (!history || history.length < 5) return null;
  const recent = history.slice(-40);
  return (
    <div className="flex items-end gap-px h-8" aria-label="pct above 20dma, last 40 sessions">
      {recent.map((h, i) => (
        <div
          key={h.date + i}
          className={`flex-1 rounded-sm ${h.pctAbove20 >= 0.55 ? "bg-emerald-500/60" : h.pctAbove20 >= 0.45 ? "bg-amber-500/50" : "bg-rose-500/60"}`}
          style={{ height: `${Math.max(8, h.pctAbove20 * 100)}%` }}
          title={`${h.date}: ${(h.pctAbove20 * 100).toFixed(0)}%`}
        />
      ))}
    </div>
  );
}

export default function BreadthCard() {
  const q = useQuery<BreadthSnapshot>({ queryKey: ["/api/breadth"], refetchInterval: 10 * 60_000 });
  const b = q.data;
  return (
    <Card data-testid="card-breadth">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Layers className="w-4 h-4" /> participation breadth
          </CardTitle>
          {b?.divergence && (
            <Badge variant="outline" className="text-rose-500 border-rose-500/30" data-testid="badge-breadth-divergence">
              thin tape — index up, troops not following
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          is the index move confirmed underneath? sampled internals ({b?.sampleSize ?? "…"} large caps) from cached daily bars — zero extra api calls.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {q.isLoading && <p className="text-xs text-muted-foreground">loading…</p>}
        {b && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">above 20dma</div>
                <div className="text-lg font-semibold font-mono tabular-nums" data-testid="text-pct-above-20">{pct(b.pctAbove20dma)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">above 50dma</div>
                <div className="text-lg font-semibold font-mono tabular-nums" data-testid="text-pct-above-50">{pct(b.pctAbove50dma)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">advancers today</div>
                <div className="text-lg font-semibold font-mono tabular-nums" data-testid="text-advancers">{pct(b.advancersPct)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">RSP/SPY 20d z</div>
                <div className="text-lg font-semibold font-mono tabular-nums" data-testid="text-rsp-z">
                  {b.rspSpyZ == null ? "—" : b.rspSpyZ.toFixed(2)}
                </div>
              </div>
            </div>
            <MiniBars history={b.history} />
            <p className="text-xs leading-snug" data-testid="text-breadth-read">{b.read}</p>
            <p className="text-xs text-muted-foreground leading-snug">{b.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
