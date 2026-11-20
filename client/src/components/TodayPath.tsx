// TodayPath — the projected path to the close, small, for the Today card.
// The same data as the 0DTE Wiener map (same react-query key, no second request), drawn as three lines:
// the random walk's centre (flat: no drift), the options chain's own median settle (live session only, and
// only when the chain stands behind it) and the dealer-rule path (a heuristic). The shaded bands are where
// half and four fifths of random-walk outcomes fall. Each line ends at the middle of a range, not a forecast.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { pathView, projectedClose } from "@shared/odteProjection";
import { forwardFreshness } from "@shared/odteFreshness";
import PlainRead from "@/components/PlainRead";

type BandKey = "p10" | "p25" | "p50" | "p75" | "p90";
interface Fwd {
  spot: number; asOf?: string; expiry?: string;
  session: { state: "preopen" | "intraday" | "closed" };
  gexValid?: boolean; chainStale?: boolean;
  wiener?: { state: "ok" | "unavailable"; reason: string | null; horizon: "rest_of_today" | "next_session"; spot: number | null; minutesLeft: number; bands: Array<{ minute: number; q: Record<BandKey, number> }> };
  impliedClose?: { state: "ok" | "unavailable"; reason: string | null; median?: number | null; bucket?: number | null; diagnostics: { clipped: number; lowTail?: number; highTail?: number } };
  closeComparison?: { forwardMinusSpot: number } | null;
  path?: Array<{ minute: number; median: number }>;
}

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const gap = (g: number) => `${g >= 0 ? "+" : "−"}${Math.abs(g).toFixed(1)} pts`;

export default function TodayPath({ onOpenMap, active = true }: { onOpenMap?: () => void; active?: boolean }) {
  const q = useQuery<Fwd>({
    queryKey: ["/api/odte/forward"],
    queryFn: async () => (await apiRequest("GET", "/api/odte/forward?symbol=%24SPX")).json(),
    // Polls only while the opening tab is showing; the data stays for the other tabs without a timer.
    // `enabled` matters as much as the interval: turning it back on with data older than staleTime fetches
    // at once, so returning to the tab never shows an old read labelled "now".
    enabled: active, refetchInterval: active ? 60_000 : false, staleTime: 30_000, retry: false, refetchOnWindowFocus: true,
  });
  const d = q.data;
  const w = d?.wiener;
  // A read that stopped refreshing (a tab left in the background, a device that slept) is not drawn as now.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    // Coming back to the tab checks the clock at once, so an old path is not drawn while the new read is on its way.
    const onShow = () => { if (document.visibilityState === "visible") setNowMs(Date.now()); };
    document.addEventListener("visibilitychange", onShow);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onShow); };
  }, []);
  const fresh = useMemo(() => forwardFreshness(d ? { asOf: d.asOf, receivedAtMs: q.dataUpdatedAt, expiry: d.expiry, horizon: w?.horizon ?? null } : null, nowMs), [d, w, q.dataUpdatedAt, nowMs]);
  const outOfDate = !!d && fresh.state !== "current";
  const ok = !!d && !outOfDate && w?.state === "ok" && w.bands.length > 1;

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
    const geo = pathView(w.bands, proj.spot, drawImplied, proj.dealer ? (d.path ?? null) : null);
    return geo ? { proj, drawImplied, last, geo } : null;
  }, [d, w, ok]);

  // One height for loading, unavailable and drawn, so nothing below jumps on the opening tab.
  const BOX = "min-h-[236px] rounded-md border p-2";
  if (q.isLoading) return <div className={`${BOX} border-border/40 text-[11px] text-muted-foreground`} data-testid="today-path-loading">reading the path to the close…</div>;
  if (q.isError || !d || !ok || !view) {
    return (
      <div className={`${BOX} border-dashed border-border/50 text-[11px] text-muted-foreground`} data-testid="today-path-unavailable">
        Projected path to the close: not available{outOfDate && fresh.state !== "current" ? ` (${fresh.reason})` : w?.reason ? ` (${w.reason})` : q.isError ? " (the read failed)" : ""}. Nothing is drawn in its place.
      </div>
    );
  }
  const { proj, geo } = view;
  const day = w!.horizon === "next_session" ? "the next session's" : "today's";
  // A held chain is not "now", and neither is a closed or pre-open session.
  const from = d.chainStale ? "the last read" : d.session.state === "intraday" ? "now" : "the last price";
  const fwd = proj.implied?.forwardGap != null ? `, of which ${gap(proj.implied.forwardGap)} is the chain's forward against the last index print` : "";
  return (
    <div className={`${BOX} border-border/50`} data-testid="today-path">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        <span>Projected path to {day} close · three reads of the centre</span>
        {d.chainStale && <span className="normal-case tracking-normal text-amber-300" data-testid="today-path-stale">from the last chain read</span>}
      </div>
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="h-20 w-full sm:h-24" role="img" aria-label={`Projected path to ${day} close: random walk centre ${n0(proj.walk)}${view.drawImplied != null ? `, options chain ${n0(view.drawImplied)}` : ""}${proj.dealer ? `, dealer rules ${n0(proj.dealer.end)}` : ""}`} data-testid="today-path-chart">
        <polygon points={geo.outer} fill="rgba(79,209,232,0.10)" />
        <polygon points={geo.inner} fill="rgba(79,209,232,0.18)" />
        <polyline points={geo.walk} fill="none" stroke="rgb(79,209,232)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {geo.implied && <line {...geo.implied} stroke="rgb(251,191,36)" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" data-testid="today-path-implied" />}
        {geo.dealer && <polyline points={geo.dealer} fill="none" stroke="rgb(244,114,182)" strokeWidth="1.6" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" data-testid="today-path-dealer" />}
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground"><span>{from}</span><span>close</span></div>
      <ul className="mt-1 space-y-0.5 text-[11px] leading-snug">
        <li data-testid="today-path-walk"><span className="font-mono text-cyan-300">━ random walk</span> <span className="font-mono">{n0(proj.walk)}</span> <span className="text-muted-foreground">flat by construction; half of outcomes between {n0(view.last.q.p25)} and {n0(view.last.q.p75)}</span></li>
        <li data-testid="today-path-options"><span className="font-mono text-amber-300">- - options chain</span> {proj.implied
          ? <><span className="font-mono">{n0(proj.implied.end)}</span> <span className="text-muted-foreground">{gap(proj.implied.gap)} vs {from}{fwd}{proj.implied.withinGrid ? "; under half a strike, so no lean is readable" : ""}{proj.implied.draw ? "" : "; no line outside the live session"}</span></>
          : <span className="text-muted-foreground">{proj.impliedWhy}; no line is drawn</span>}</li>
        <li data-testid="today-path-dealer-row"><span className="font-mono text-pink-300">· · dealer rules</span> {proj.dealer
          ? <><span className="font-mono">{n0(proj.dealer.end)}</span> <span className="text-muted-foreground">{gap(proj.dealer.gap)} vs {from}; a rule of thumb, not graded</span></>
          : <span className="text-muted-foreground">{proj.dealerWhy}; no line is drawn</span>}</li>
      </ul>
      <PlainRead testId="today-path-how" className="mt-1.5" read={{
        answer: "None of these lines is a forecast.",
        detail: "The random walk and options lines each end at the middle of a range of outcomes, so half fall either side. The options line is drawn straight to its end point; only the end is read from the chain. The dealer line is a rule of thumb about positioning, not the middle of a measured range. The shading is where half (darker) and four fifths (lighter) of random-walk outcomes fall.",
      }} />
      {onOpenMap && <button type="button" onClick={onOpenMap} className="inline-flex min-h-[44px] items-center text-[11px] text-amber-300 underline-offset-2 hover:underline lg:min-h-0" data-testid="today-path-open-map">full map on Heatseeker</button>}
    </div>
  );
}
