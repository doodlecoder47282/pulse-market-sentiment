/**
 * TodayCard.tsx: the answer-first card at the top of Signals.
 *
 * What a reader opens the app for, above the fold on a phone: spot, the
 * three dealer levels the 0DTE map names (wall above / gamma flip / magnet
 * below), where spot sits between them, and the straddle range. Everything
 * comes from the map the Trade Desk already fetches (same react-query key,
 * no second request). States are kept apart: loading keeps the height,
 * unavailable says why, a map without gamma says so instead of showing
 * walls that do not exist. Descriptive only. It opens with one plain
 * sentence (shared/plainReads.ts readToday) and closes with the projected
 * path to the close (TodayPath), so the top of the app answers "what is
 * today" before anything else.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import DataStateChip from "@/components/DataStateChip";
import UnavailablePanel from "@/components/UnavailablePanel";
import { Map as MapIcon } from "lucide-react";
import type { OdteMap } from "@shared/odteMap";
import PlainRead from "@/components/PlainRead";
import LevelScopeNote from "@/components/LevelScopeNote";
import TodayPath from "@/components/TodayPath";
import { readToday } from "@shared/plainReads";

type MapResp = OdteMap & { forwardAsOf: string; source: string };

// One level tile. Phone: a row (label + note left, number right) so the three
// tiles stack in price order. From 640 px: a column of label / number / note.
const LEVEL_TILE = "flex items-center justify-between gap-3 rounded-md border bg-muted/10 px-3 py-2 sm:block sm:p-2.5";

const lvl = (n: number | null | undefined) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const pct = (a: number | null | undefined, spot: number) => (a == null ? "" : `${a >= spot ? "+" : ""}${(((a - spot) / spot) * 100).toFixed(2)}%`);

export default function TodayCard({ symbol = "$SPX", onOpenDesk, onOpenMap, active = true }: { symbol?: string; onOpenDesk?: () => void; onOpenMap?: () => void; active?: boolean }) {
  const q = useQuery<MapResp>({
    queryKey: ["/api/odte/map", symbol],
    queryFn: async () => (await apiRequest("GET", `/api/odte/map?symbol=${encodeURIComponent(symbol)}`)).json(),
    // Polls only while the opening tab is showing (the card stays mounted above the tabs).
    // `enabled` is what refetches on return: re-enabled with data older than staleTime, it fetches at once.
    enabled: active,
    refetchInterval: active ? 60_000 : false,
    staleTime: 30_000,
    retry: false,
  });
  const m = q.data;
  const sym = symbol.replace(/^\$/, "");

  if (q.isLoading) {
    return (
      <Card data-testid="today-card-loading">
        <CardContent className="min-h-[224px] p-3 text-[11px] text-muted-foreground sm:p-4">composing today's levels from the chain…</CardContent>
      </Card>
    );
  }
  if (q.isError || !m) {
    return (
      <Card data-testid="today-card-unavailable">
        <CardContent className="min-h-[224px] p-3 sm:p-4">
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
  // When the wall/magnet is missing and the pin fills the slot, label it as the pin.
  const aboveIsPin = m.landmarks.wallAbove == null && above != null;
  const belowIsPin = m.landmarks.magnetBelow == null && below != null;
  const flip = m.landmarks.flip;
  const priced = m.dataState !== "no_gex";
  const state = m.dataState === "no_gex" ? "no_data" : m.dataState === "stale_session" || m.dataState === "stale" ? "stale" : "ok";
  const aboveOi = m.strikes.find((s) => s.strike === above);
  const belowOi = m.strikes.find((s) => s.strike === below);
  const share = (s?: { share: number }) => (s ? `${(s.share * 100).toFixed(0)}% of map` : "");

  // Position of the three levels and spot on one line, as fractions of [lo, hi].
  const lo = Math.min(...[below, flip, spot, m.range.low ?? spot].filter((x): x is number => x != null)) - 5;
  const hi = Math.max(...[above, flip, spot, m.range.high ?? spot].filter((x): x is number => x != null)) + 5;
  const pos = (x: number | null) => (x == null ? null : `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100)).toFixed(1)}%`);
  const gammaLine = m.band.atSpot === "long"
    ? `Long gamma at spot: dealer hedging dampens moves${m.band.low != null || m.band.high != null ? ` between ${m.band.low == null ? "<-5%" : lvl(m.band.low)} and ${m.band.high == null ? ">+5%" : lvl(m.band.high)}` : ""}.`
    : m.band.atSpot === "short"
      ? "Short gamma at spot: dealer hedging adds to moves."
      : "Gamma sign at spot not determined.";

  return (
    <Card data-testid="today-card">
      <CardContent className="min-h-[224px] space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl leading-none tracking-wide tabular-nums sm:text-4xl" style={{ fontFamily: "'Bebas Neue', sans-serif" }} data-testid="today-spot">{sym} {lvl(spot)}</span>
            {m.gap.pct != null && <span className={`font-mono text-xs ${m.gap.pct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>gap {m.gap.pct >= 0 ? "+" : ""}{m.gap.pct.toFixed(2)}%</span>}
            <span className="font-mono text-[11px] text-muted-foreground">{m.session.state} · {m.expiry} chain</span>
          </div>
          <DataStateChip state={state} reason={m.reason} asOf={m.chainAsOfMs ?? m.asOf} stale={m.chainStale} lastSession={(m as any).chainLastSession ?? null} source="Schwab" testId="today-state" />
        </div>

        {/* the answer first, in ordinary words (shared/plainReads.ts) */}
        <PlainRead testId="today-plain" read={readToday({
          spot, sessionState: m.session.state, dataState: m.dataState, atSpot: m.band.atSpot,
          straddle: m.range.straddle, low: m.range.low, high: m.range.high,
          above, below, aboveIsPin, belowIsPin, flip,
        })} />

        {!priced ? (
          <div className="min-h-[96px] rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300" data-testid="today-no-gex">
            {m.reason ?? "the chain carries no priced gamma yet: no walls to show"}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="today-levels">
              <div className={LEVEL_TILE + " border-border/60"}>
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{aboveIsPin ? "pin (above)" : "wall above"}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground sm:hidden">{above != null ? `${pct(above, spot)} · ${share(aboveOi)}` : "none in band"}</div>
                </div>
                <div className="font-mono text-xl font-semibold tabular-nums text-rose-300 sm:text-2xl" data-testid="today-wall-above">{lvl(above)}</div>
                <div className="hidden font-mono text-[10px] text-muted-foreground sm:block">{above != null ? `${pct(above, spot)} · ${share(aboveOi)}` : "none in band"}</div>
              </div>
              <div className={LEVEL_TILE + " border-amber-500/50"}>
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-amber-300">gamma flip</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground sm:hidden">{flip != null ? `spot ${spot >= flip ? "above" : "below"} · ${m.band.atSpot} γ` : "no crossing in band"}</div>
                </div>
                <div className="font-mono text-xl font-semibold tabular-nums text-amber-200 sm:text-2xl" data-testid="today-flip">{lvl(flip)}</div>
                <div className="hidden font-mono text-[10px] text-muted-foreground sm:block">{flip != null ? `spot ${spot >= flip ? "above" : "below"} · ${m.band.atSpot} γ` : "no crossing in band"}</div>
              </div>
              <div className={LEVEL_TILE + " border-border/60"}>
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{belowIsPin ? "pin (below)" : "magnet below"}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground sm:hidden">{below != null ? `${pct(below, spot)} · ${share(belowOi)}` : "none in band"}</div>
                </div>
                <div className="font-mono text-xl font-semibold tabular-nums text-emerald-300 sm:text-2xl" data-testid="today-magnet-below">{lvl(below)}</div>
                <div className="hidden font-mono text-[10px] text-muted-foreground sm:block">{below != null ? `${pct(below, spot)} · ${share(belowOi)}` : "none in band"}</div>
              </div>
            </div>

            {/* the position bar repeats the tiles: from 640 px only, so the phone gets to the path sooner */}
            <div className="hidden space-y-1 sm:block">
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
              {/* the sign and the straddle are in the plain read above; only the long-gamma band adds something here */}
              {m.band.atSpot === "long" && (m.band.low != null || m.band.high != null) ? gammaLine : ""}
              {onOpenDesk && <> <button type="button" onClick={onOpenDesk} className="inline-flex min-h-[44px] items-center text-amber-300 underline-offset-2 hover:underline sm:min-h-0" data-testid="today-open-desk">full ladder on the Trade Desk</button></>}
            </p>
          </>
        )}

        {priced && <LevelScopeNote panel="today" />}

        {/* the projected path to the close: the Wiener map's three centres, small (index only) */}
        {symbol === "$SPX" && <TodayPath onOpenMap={onOpenMap} active={active} />}
      </CardContent>
    </Card>
  );
}
