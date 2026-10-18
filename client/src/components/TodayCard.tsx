/**
 * TodayCard.tsx: the answer-first card at the top of Signals.
 *
 * What a reader opens the app for, above the fold on a phone: spot, the
 * three dealer levels the 0DTE map names (wall above / gamma flip / magnet
 * below), where spot sits between them, and the straddle range. Everything
 * comes from the map the Trade Desk already fetches (same react-query key,
 * no second request). States are kept apart: loading keeps the height,
 * unavailable says why, a map without gamma says so instead of showing
 * walls that do not exist. Descriptive only.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import UnavailablePanel from "@/components/UnavailablePanel";
import { Map as MapIcon } from "lucide-react";
import type { OdteMap } from "@shared/odteMap";

type MapResp = OdteMap & { forwardAsOf: string; source: string };

const lvl = (n: number | null | undefined) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const pct = (a: number | null | undefined, spot: number) => (a == null ? "" : `${a >= spot ? "+" : ""}${(((a - spot) / spot) * 100).toFixed(2)}%`);

export default function TodayCard({ symbol = "$SPX", onOpenDesk }: { symbol?: string; onOpenDesk?: () => void }) {
  const q = useQuery<MapResp>({
    queryKey: ["/api/odte/map", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/odte/map?symbol=${encodeURIComponent(symbol)}`)).json(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const m = q.data;
  const sym = symbol.replace(/^\$/, "");

  if (q.isLoading) {
    return (
      <Card data-testid="today-card-loading">
        <CardContent className="min-h-[224px] p-4 text-[11px] text-muted-foreground">composing today's levels from the chain…</CardContent>
      </Card>
    );
  }
  if (q.isError || !m) {
    return (
      <Card data-testid="today-card-unavailable">
        <CardContent className="min-h-[224px] p-4">
          <div className="mb-2 flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold">Today · {sym}</span>
          </div>
          <UnavailablePanel title="today's levels" error={q.error} testId="today-card-unavailable-panel" compact />
        </CardContent>
      </Card>
    );
  }

  const spot = m.spot;
  const above = m.landmarks.wallAbove ?? (m.landmarks.pin != null && m.landmarks.pin > spot ? m.landmarks.pin : null);
  const below = m.landmarks.magnetBelow ?? (m.landmarks.pin != null && m.landmarks.pin < spot ? m.landmarks.pin : null);
  const flip = m.landmarks.flip;
  const priced = m.dataState !== "no_gex";
  const state = m.dataState === "no_gex" ? "no_data" : m.dataState === "stale_session" ? "stale" : "ok";
  const aboveOi = m.strikes.find((s) => s.strike === above);
  const belowOi = m.strikes.find((s) => s.strike === below);
  const share = (s?: { share: number }) => (s ? `${(s.share * 100).toFixed(0)}% of map` : "");

  // Position of the three levels and spot on one line, as fractions of [lo, hi].
  const lo = Math.min(...[below, flip, spot, m.range.low ?? spot].filter((x): x is number => x != null)) - 5;
  const hi = Math.max(...[above, flip, spot, m.range.high ?? spot].filter((x): x is number => x != null)) + 5;
  const pos = (x: number | null) => (x == null ? null : `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100)).toFixed(1)}%`);
  const gammaLine = m.band.atSpot === "long"
    ? `Long gamma at spot: dealers fade moves${above != null && below != null ? ` between ${lvl(below)} and ${lvl(above)}` : ""}.`
    : m.band.atSpot === "short"
      ? "Short gamma at spot: dealers chase moves; ranges stretch."
      : "Gamma sign at spot not determined.";

  return (
    <Card data-testid="today-card">
      <CardContent className="min-h-[224px] space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-2xl leading-none tracking-wide sm:text-3xl" style={{ fontFamily: "'Bebas Neue', sans-serif" }} data-testid="today-spot">{sym} {lvl(spot)}</span>
            {m.gap.pct != null && <span className={`font-mono text-xs ${m.gap.pct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>gap {m.gap.pct >= 0 ? "+" : ""}{m.gap.pct.toFixed(2)}%</span>}
            <span className="font-mono text-[11px] text-muted-foreground">{m.session.state} · {m.expiry} chain</span>
          </div>
          <DataStateChip state={state} reason={m.reason} asOf={m.asOf} source="Schwab" testId="today-state" />
        </div>

        {!priced ? (
          <div className="min-h-[96px] rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300" data-testid="today-no-gex">
            {m.reason ?? "the chain carries no priced gamma yet: no walls to show"}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2" data-testid="today-levels">
              <div className="rounded-md border border-border/60 bg-muted/10 p-2.5">
                <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">wall above</div>
                <div className="font-mono text-xl font-semibold tabular-nums text-rose-300" data-testid="today-wall-above">{lvl(above)}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{above != null ? `${pct(above, spot)} · ${share(aboveOi)}` : "none in band"}</div>
              </div>
              <div className="rounded-md border border-amber-500/50 bg-muted/10 p-2.5">
                <div className="font-mono text-[9px] uppercase tracking-widest text-amber-300">gamma flip</div>
                <div className="font-mono text-xl font-semibold tabular-nums text-amber-200" data-testid="today-flip">{lvl(flip)}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{flip != null ? `spot ${spot >= flip ? "above" : "below"} · ${m.band.atSpot} γ` : "no crossing in band"}</div>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/10 p-2.5">
                <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">magnet below</div>
                <div className="font-mono text-xl font-semibold tabular-nums text-emerald-300" data-testid="today-magnet-below">{lvl(below)}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{below != null ? `${pct(below, spot)} · ${share(belowOi)}` : "none in band"}</div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="relative h-2.5 rounded-full bg-gradient-to-r from-emerald-500/30 via-muted/40 to-rose-500/30">
                {pos(flip) && <div className="absolute -top-0.5 h-3.5 w-0.5 bg-amber-400" style={{ left: pos(flip)! }} title={`flip ${lvl(flip)}`} />}
                {pos(spot) && <div className="absolute -top-0.5 h-3.5 w-0.5 bg-foreground" style={{ left: pos(spot)! }} title={`spot ${lvl(spot)}`} />}
              </div>
              <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
                <span title="bar extent: the lower of the magnet, flip and straddle low">{lvl(lo + 5)}</span>
                <span className="text-amber-300">flip {lvl(flip)}</span>
                <span className="text-foreground">spot {lvl(spot)}</span>
                <span title="bar extent: the higher of the wall, flip and straddle high">{lvl(hi - 5)}</span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {gammaLine}{m.range.straddle != null ? ` Straddle prices ±${Math.round(m.range.straddle)} (${lvl(m.range.low)}–${lvl(m.range.high)}).` : ""}
              {onOpenDesk && <> <button type="button" onClick={onOpenDesk} className="text-amber-300 underline-offset-2 hover:underline" data-testid="today-open-desk">full ladder on the Trade Desk</button></>}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
