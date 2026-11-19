// TodayPath — the projected path to the close, small, for the Today card.
// The same data as the 0DTE Wiener map (same react-query key, no second request), drawn as three lines:
// the random walk's centre (flat: no drift), the options chain's own median settle (live session only, and
// only when the chain stands behind it) and the dealer-rule path (a heuristic). The shaded bands are where
// half and four fifths of random-walk outcomes fall. Each line ends at the middle of a range, not a forecast.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { projectedClose } from "@shared/odteProjection";

type BandKey = "p10" | "p25" | "p50" | "p75" | "p90";
interface Fwd {
  spot: number;
  session: { state: "preopen" | "intraday" | "closed" };
  gexValid?: boolean; chainStale?: boolean;
  wiener?: { state: "ok" | "unavailable"; reason: string | null; horizon: "rest_of_today" | "next_session"; spot: number | null; minutesLeft: number; bands: Array<{ minute: number; q: Record<BandKey, number> }> };
  impliedClose?: { state: "ok" | "unavailable"; reason: string | null; median?: number | null; bucket?: number | null; diagnostics: { clipped: number; lowTail?: number; highTail?: number } };
  closeComparison?: { forwardMinusSpot: number } | null;
  path?: Array<{ minute: number; median: number }>;
}

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const gap = (g: number) => `${g >= 0 ? "+" : "−"}${Math.abs(g).toFixed(1)} pts`;

export default function TodayPath({ onOpenMap }: { onOpenMap?: () => void }) {
  const q = useQuery<Fwd>({
    queryKey: ["/api/odte/forward"],
    queryFn: async () => (await apiRequest("GET", "/api/odte/forward?symbol=%24SPX")).json(),
    refetchInterval: 60_000, staleTime: 30_000, retry: false,
  });
  const d = q.data;
  const w = d?.wiener;
  const ok = !!d && w?.state === "ok" && w.bands.length > 1;

  const view = useMemo(() => {
    if (!d || !w || !ok) return null;
    const last = w.bands[w.bands.length - 1];
    const proj = projectedClose({
      spot: w.spot, walkMedian: last.q.p50, sessionState: d.session.state, implied: d.impliedClose,
      forwardMinusSpot: d.closeComparison?.forwardMinusSpot ?? null,
      dealerEnd: d.path?.length ? d.path[d.path.length - 1].median : null, gexValid: d.gexValid,
    });
    if (!proj) return null;
    const drawImplied = proj.implied?.draw ? proj.implied.end : null;
    const ys = [last.q.p10, last.q.p90, proj.spot, ...(drawImplied != null ? [drawImplied] : []), ...(proj.dealer ? (d.path ?? []).map((p) => p.median) : [])];
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const span = w.bands[w.bands.length - 1].minute - w.bands[0].minute || 1;
    const X = (minute: number) => ((minute - w.bands[0].minute) / span) * 300;
    const Y = (px: number) => 100 - ((px - lo) / (hi - lo)) * 100;
    const poly = (up: BandKey, dn: BandKey) => [...w.bands.map((b) => `${X(b.minute).toFixed(1)},${Y(b.q[up]).toFixed(1)}`), ...[...w.bands].reverse().map((b) => `${X(b.minute).toFixed(1)},${Y(b.q[dn]).toFixed(1)}`)].join(" ");
    return {
      proj, drawImplied, last,
      outer: poly("p90", "p10"), inner: poly("p75", "p25"),
      walk: w.bands.map((b) => `${X(b.minute).toFixed(1)},${Y(b.q.p50).toFixed(1)}`).join(" "),
      implied: drawImplied != null ? { x1: 0, y1: Y(proj.spot), x2: 300, y2: Y(drawImplied) } : null,
      dealer: proj.dealer && d.path?.length ? d.path.map((p) => `${X(p.minute).toFixed(1)},${Y(p.median).toFixed(1)}`).join(" ") : null,
    };
  }, [d, w, ok]);

  if (q.isLoading) return <div className="min-h-[150px] rounded-md border border-border/40 p-2 text-[11px] text-muted-foreground" data-testid="today-path-loading">reading the path to the close…</div>;
  if (q.isError || !d || !ok || !view) {
    return (
      <div className="rounded-md border border-dashed border-border/50 p-2 text-[11px] text-muted-foreground" data-testid="today-path-unavailable">
        Projected path to the close: not available{w?.reason ? ` (${w.reason})` : q.isError ? " (the read failed)" : ""}. Nothing is drawn in its place.
      </div>
    );
  }
  const { proj } = view;
  const day = w!.horizon === "next_session" ? "the next session's" : "today's";
  const from = d.session.state === "intraday" ? "now" : "the last price";
  return (
    <div className="rounded-md border border-border/50 p-2" data-testid="today-path">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        <span>Projected path to {day} close · three reads of the centre</span>
        {d.chainStale && <span className="normal-case tracking-normal text-amber-300" data-testid="today-path-stale">from the last chain read</span>}
      </div>
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label={`Projected path to ${day} close: random walk centre ${n0(proj.walk)}${view.drawImplied != null ? `, options chain ${n0(view.drawImplied)}` : ""}${proj.dealer ? `, dealer rules ${n0(proj.dealer.end)}` : ""}`} data-testid="today-path-chart">
        <polygon points={view.outer} fill="rgba(79,209,232,0.10)" />
        <polygon points={view.inner} fill="rgba(79,209,232,0.18)" />
        <polyline points={view.walk} fill="none" stroke="rgb(79,209,232)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {view.implied && <line {...view.implied} stroke="rgb(251,191,36)" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" data-testid="today-path-implied" />}
        {view.dealer && <polyline points={view.dealer} fill="none" stroke="rgb(244,114,182)" strokeWidth="1.6" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" data-testid="today-path-dealer" />}
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground"><span>{from}</span><span>close</span></div>
      <ul className="mt-1 space-y-0.5 text-[11px] leading-snug">
        <li data-testid="today-path-walk"><span className="font-mono text-cyan-300">━ random walk</span> <span className="font-mono">{n0(proj.walk)}</span> <span className="text-muted-foreground">flat by construction (no drift); half of outcomes close between {n0(view.last.q.p25)} and {n0(view.last.q.p75)}</span></li>
        <li data-testid="today-path-options"><span className="font-mono text-amber-300">- - options chain</span> {proj.implied
          ? <><span className="font-mono">{n0(proj.implied.end)}</span> <span className="text-muted-foreground">{gap(proj.implied.gap)} vs {from}{proj.implied.withinGrid ? "; under half a strike, so no lean is readable" : ""}{proj.implied.draw ? "" : "; no line outside the live session"}</span></>
          : <span className="text-muted-foreground">{proj.impliedWhy}; no line is drawn</span>}</li>
        <li data-testid="today-path-dealer-row"><span className="font-mono text-pink-300">· · dealer rules</span> {proj.dealer
          ? <><span className="font-mono">{n0(proj.dealer.end)}</span> <span className="text-muted-foreground">{gap(proj.dealer.gap)} vs {from}; a rule of thumb, not graded</span></>
          : <span className="text-muted-foreground">{proj.dealerWhy}; no line is drawn</span>}</li>
      </ul>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        Each line ends at the middle of a range of outcomes, so half fall either side of it. The shading is where half (darker) and four fifths (lighter) of random-walk outcomes fall. None of this is a forecast.
        {onOpenMap && <> <button type="button" onClick={onOpenMap} className="inline-flex min-h-[44px] items-center text-amber-300 underline-offset-2 hover:underline lg:min-h-0" data-testid="today-path-open-map">full map on Heatseeker</button></>}
      </p>
    </div>
  );
}
