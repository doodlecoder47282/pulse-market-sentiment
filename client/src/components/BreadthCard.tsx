// MISSION FIX #6 — participation breadth card (GET /api/breadth).
// Sampled internals from the Schwab daily-bars cache: % above 20/50dma,
// advancers, RSP/SPY equal-weight ratio trend, and a thin-tape divergence flag.
// Honest about being a 36-stock hand-picked large-cap sample, not full NYSE
// internals and not the median stock; sector-ETF participation sits beside it.

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
  sectorBreadth?: { pctAbove20dma: number | null; pctAbove50dma: number | null; sectors: number };
  lastBarDate?: string | null;
  expectedBarDate?: string | null;
  dataState?: "ok" | "stale" | "insufficient" | "unavailable";
  internals?: {
    state: "ok" | "partial" | "stale" | "unavailable"; reason: string | null;
    advancers: number | null; decliners: number | null; advanceShare: number | null;
    upVolumeShare: number | null; asOf: number | null;
  };
  primary?: "nyse_internals" | "large_cap_sample";
}

// Server emits PERCENT form (44.4), not fractions (0.444) — do not multiply.
const pct = (x: number | null) => (x == null ? "—" : `${x.toFixed(0)}%`);

function MiniBars({ history }: { history: { date: string; pctAbove20: number }[] }) {
  if (!history || history.length < 5) return null;
  const recent = history.slice(-40);
  return (
    <div className="flex h-8 items-end gap-px overflow-hidden" aria-label="pct above 20dma, last 40 sessions">
      {recent.map((h, i) => (
        // pctAbove20 arrives as 0-100 percent. The old fraction assumption
        // rendered 3,900%-tall bars that bled across the whole Signals panel
        // (IMG_0906) and painted every bar green (48 >= 0.55). Clamp regardless.
        <div
          key={h.date + i}
          className={`flex-1 rounded-sm ${h.pctAbove20 >= 55 ? "bg-emerald-500/60" : h.pctAbove20 >= 45 ? "bg-amber-500/50" : "bg-rose-500/60"}`}
          style={{ height: `${Math.min(100, Math.max(8, h.pctAbove20))}%` }}
          title={`${h.date}: ${h.pctAbove20.toFixed(0)}%`}
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
          {b?.dataState && b.dataState !== "ok" && (
            <Badge variant="outline" className="text-amber-500 border-amber-500/30" data-testid="badge-breadth-state">
              {b.dataState === "stale" ? `stale: last bar ${b.lastBarDate}` : b.dataState}
            </Badge>
          )}
          {b?.divergence && (
            <Badge variant="outline" className="text-rose-500 border-rose-500/30" data-testid="badge-breadth-divergence">
              thin tape — index up, troops not following
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          is the index move confirmed underneath? {b?.sampleSize ?? "…"} hand-picked large caps (large-cap participation, not the median stock), the 11 sector ETFs and RSP/SPY, from cached Schwab daily bars.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {q.isLoading && <p className="text-xs text-muted-foreground">loading…</p>}
        {b && (
          <>
            <div className="text-xs leading-snug" data-testid="text-breadth-internals">
              {b.internals && (b.internals.state === "ok" || b.internals.state === "partial") ? (
                <>
                  <span className="font-semibold">NYSE internals (Schwab):</span>{" "}
                  {b.internals.advancers != null && b.internals.decliners != null
                    ? `${b.internals.advancers} advancing / ${b.internals.decliners} declining (${Math.round((b.internals.advanceShare ?? 0) * 100)}%)`
                    : "advance/decline unavailable"}
                  {b.internals.upVolumeShare != null ? ` · up volume ${Math.round(b.internals.upVolumeShare * 100)}%` : ""}
                  {b.internals.asOf ? ` · as of ${new Date(b.internals.asOf).toLocaleTimeString()}` : ""}
                  {b.internals.state === "partial" && b.internals.reason ? ` · partial: ${b.internals.reason}` : ""}
                </>
              ) : (
                <span className="text-muted-foreground">
                  NYSE internals unavailable{b.internals?.reason ? `: ${b.internals.reason}` : ""}. Showing the large-cap sample below.
                </span>
              )}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">large-cap sample (secondary)</div>
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
                <div className="text-xs text-muted-foreground">advancers (last session{b.lastBarDate ? ` ${b.lastBarDate}` : ""})</div>
                <div className="text-lg font-semibold font-mono tabular-nums" data-testid="text-advancers">{pct(b.advancersPct)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">RSP/SPY 20d z</div>
                <div className="text-lg font-semibold font-mono tabular-nums" data-testid="text-rsp-z">
                  {b.rspSpyZ == null ? "—" : b.rspSpyZ.toFixed(2)}
                </div>
              </div>
            </div>
            {b.sectorBreadth && (
              <div className="text-xs text-muted-foreground" data-testid="text-sector-breadth">
                sectors above 20dma {pct(b.sectorBreadth.pctAbove20dma)} · above 50dma {pct(b.sectorBreadth.pctAbove50dma)}
                {" "}({b.sectorBreadth.sectors} of 11 SPDR sectors with history, each counted once)
              </div>
            )}
            <MiniBars history={b.history} />
            <p className="text-xs leading-snug" data-testid="text-breadth-read">{b.read}</p>
            <p className="text-xs text-muted-foreground leading-snug">{b.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
