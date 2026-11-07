/**
 * OdteForward.tsx — 0DTE WIENER MAP (today only).
 *
 * The baseline is a plain random walk (Wiener process, zero drift) from the
 * current price to today's close, with the market's own implied volatility
 * from the 0DTE chain (shared/odteWiener.ts, server/odteForward.ts):
 *   - today's path so far (solid), then shaded percentile bands to the close
 *     (2.5-97.5, 10-90, 25-75) and the median;
 *   - map levels with the model's touch and close odds;
 *   - the model's close distribution (wide screens: beside the chart);
 *   - the morning odds' running scorecard from the settle ledger.
 * The dealer-positioning path (pin pull, charm tilt) is an optional overlay,
 * labelled as a heuristic. Nothing here is a forecast or a direction.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

type BandKey = "p025" | "p10" | "p25" | "p50" | "p75" | "p90" | "p975";
interface WienerBand { minute: number; et: string; q: Record<BandKey, number> }
interface WienerLevel {
  price: number; kind: string; label: string; side: "above" | "below" | "at";
  distance: number; distanceSigma: number; pTouch: number; pCloseAbove: number; pCloseBelow: number; touchedToday: boolean;
}
interface WienerMapT {
  state: "ok" | "unavailable"; reason: string | null; model: string;
  horizon: "rest_of_today" | "next_session";
  spot: number | null; sigmaToClose: number | null; sigmaSource: "atm_iv" | "atm_straddle" | null; sigmaFromStraddle: number | null;
  minutesLeft: number; bands: WienerBand[]; levels: WienerLevel[];
  expected: { high: number; low: number; range: number } | null;
  closeDist: Array<{ lo: number | null; hi: number | null; p: number }>;
  caveats: string[];
}
interface OverlayPoint { minute: number; et: string; median: number }
interface OdteResponse {
  symbol: string; asOf: string; spot: number; expiry: string; dte: number;
  session: { state: "preopen" | "intraday" | "closed"; minutesToClose: number; projMinutes: number };
  atmIV: number; atmIVSource?: "chain" | "straddle"; gexValid?: boolean;
  netGex: number | null; regime: "long_gamma" | "short_gamma" | "indeterminate";
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null; pin: number | null };
  chainStale?: boolean; chainAgeMs?: number | null;
  wiener?: WienerMapT;
  /** The chain's own settle distribution (Breeden-Litzenberger on 0DTE mids), same bucket spacing. */
  impliedClose?: { state: "ok" | "unavailable"; reason: string | null; method: string; sigma: number | null; mean: number | null;
    buckets: Array<{ lo: number | null; hi: number | null; p: number }>; diagnostics: { strikes: number; clipped: number; renormalised: number; lowTail?: number; highTail?: number } };
  closeComparison?: { tvDistance: number; binWidth: number; sigmaDiff: number; medianShift: number; forwardMinusSpot: number; pAboveSpotImplied: number; text: string } | null;
  todayPath?: Array<{ min: number; close: number }>;
  path?: OverlayPoint[];
  pathBasis?: string;
}
interface Calib { lo: number; hi: number; n: number; stated: number | null; observed: number | null }
interface LedgerResp {
  wienerScorecard?: { days: number; minDays: number; tested: boolean; touch: { n: number; buckets: Calib[]; brier: number | null; brierBaseRate?: number | null }; close: { n: number; buckets: Calib[]; brier: number | null; brierBaseRate?: number | null } };
}

const KIND_COLOR: Record<string, string> = {
  call_wall: "#7cf04b", put_wall: "#ff4d52", gamma_flip: "#a78bfa", pin: "#fbbf24",
  gex_peak: "#7c8ea8", prior_close: "#94a3b8", session_high: "#94a3b8", session_low: "#94a3b8",
  orb_high: "#c084fc", orb_low: "#c084fc", vwap: "#38bdf8",
};
const pct = (p: number) => (p >= 0.995 ? ">99%" : p <= 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const OPEN = 9 * 60 + 30;

function fmtUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}

export default function OdteForward() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showLevels, setShowLevels] = useState(true);

  const { data, isLoading, isError } = useQuery<OdteResponse>({
    queryKey: ["/api/odte/forward"],
    queryFn: async () => (await apiRequest("GET", "/api/odte/forward?symbol=%24SPX")).json(),
    refetchInterval: 60_000,
  });
  const { data: ledger } = useQuery<LedgerResp>({
    queryKey: ["/api/odte/map/ledger", "$SPX"],
    queryFn: async () => (await apiRequest("GET", "/api/odte/map/ledger?symbol=%24SPX")).json(),
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWrapW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((es) => setWrapW(es[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const w = data?.wiener;
  const ok = w?.state === "ok";
  // Chart geometry in ET minutes: from the open (today's path) or the band start, to the close.
  const geo = useMemo(() => {
    if (!data || !w || !ok || !w.bands.length) return null;
    const startAbs = data.session.state === "intraday" ? Number(w.bands[0].et.slice(0, 2)) * 60 + Number(w.bands[0].et.slice(3)) : OPEN;
    const endAbs = startAbs + w.minutesLeft;
    const path = w.horizon === "rest_of_today" ? (data.todayPath ?? []) : [];
    const x0 = path.length ? Math.min(OPEN, path[0].min) : startAbs;
    return { startAbs, endAbs, x0, path };
  }, [data, w, ok]);

  const H = 360;
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data || !w || !ok || !geo || wrapW < 80) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrapW;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const wide = W >= 640;
    const histW = wide ? 70 : 0;
    const padL = 6, padR = 70 + histW, padT = 12, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    const last = w.bands[w.bands.length - 1].q;
    let lo = Math.min(last.p025, w.spot ?? Infinity), hi = Math.max(last.p975, w.spot ?? -Infinity);
    for (const p of geo.path) { lo = Math.min(lo, p.close); hi = Math.max(hi, p.close); }
    const pad = (hi - lo || 1) * 0.06;
    lo -= pad; hi += pad;
    const X = (abs: number) => padL + iw * ((abs - geo.x0) / Math.max(1, geo.endAbs - geo.x0));
    const Y = (v: number) => padT + ih * (1 - (v - lo) / (hi - lo));

    // time grid every hour
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "rgba(148,163,184,0.75)";
    ctx.strokeStyle = "rgba(148,163,184,0.10)";
    ctx.textAlign = "center";
    for (let m = Math.ceil(geo.x0 / 60) * 60; m <= geo.endAbs; m += 60) {
      const x = X(m);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.fillText(hhmm(m), x, H - 6);
    }

    // bands (outer to inner)
    const fillBand = (a: BandKey, b: BandKey, alpha: number) => {
      ctx.beginPath();
      w.bands.forEach((pt, i) => { const x = X(geo.startAbs + pt.minute), y = Y(pt.q[b]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      for (let i = w.bands.length - 1; i >= 0; i--) ctx.lineTo(X(geo.startAbs + w.bands[i].minute), Y(w.bands[i].q[a]));
      ctx.closePath();
      ctx.fillStyle = `rgba(79,209,232,${alpha})`;
      ctx.fill();
    };
    fillBand("p025", "p975", 0.07);
    fillBand("p10", "p90", 0.10);
    fillBand("p25", "p75", 0.14);
    ctx.strokeStyle = "rgba(79,209,232,0.8)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath();
    w.bands.forEach((pt, i) => { const x = X(geo.startAbs + pt.minute), y = Y(pt.q.p50); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);

    // dealer overlay (heuristic), only when asked
    if (showOverlay && data.path?.length) {
      ctx.strokeStyle = "rgba(251,191,36,0.85)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1.2;
      ctx.beginPath();
      data.path.forEach((pt, i) => { const x = X(geo.startAbs + pt.minute), y = Y(pt.median); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }

    // today's path so far
    if (geo.path.length > 1) {
      ctx.strokeStyle = "rgba(226,232,240,0.9)"; ctx.lineWidth = 1.4;
      ctx.beginPath();
      // A 5-minute bar's close is plotted at the bar's end.
      geo.path.forEach((p, i) => { const x = X(p.min + 5), y = Y(p.close); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }

    // levels inside the window, tags on the right with touch odds (stacked without overlap, kept inside the plot)
    const tags: Array<{ y: number; text: string; color: string }> = [];
    for (const L of w.levels) {
      if (L.price < lo || L.price > hi) continue;
      const y = Y(L.price), color = KIND_COLOR[L.kind] ?? "#94a3b8";
      ctx.strokeStyle = color; ctx.globalAlpha = L.touchedToday ? 0.25 : 0.5; ctx.setLineDash(L.touchedToday ? [2, 4] : [6, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      tags.push({ y, color, text: `${Math.round(L.price)} ${L.side === "at" ? "at" : pct(L.pTouch)}` });
    }
    tags.sort((a, b) => a.y - b.y);
    const TAG_H = 13;
    for (let i = 1; i < tags.length; i++) if (tags[i].y < tags[i - 1].y + TAG_H) tags[i].y = tags[i - 1].y + TAG_H;
    // Second pass upward so a stack pushed past the bottom does not pile on itself.
    for (let i = tags.length - 1; i >= 0; i--) {
      const cap = i === tags.length - 1 ? padT + ih : tags[i + 1].y - TAG_H;
      if (tags[i].y > cap) tags[i].y = cap;
    }
    ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "left";
    for (const t of tags) {
      const y = t.y;
      ctx.fillStyle = t.color; ctx.globalAlpha = 0.9; ctx.fillRect(padL + iw + histW + 3, y - 6, 64, 12); ctx.globalAlpha = 1;
      ctx.fillStyle = "#0a0a0a"; ctx.fillText(t.text, padL + iw + histW + 5, y + 3.5);
    }

    // close distributions beside the plot (wide screens): the random walk's
    // (cyan, filled) and the chain's own (amber outline), one scale for both so
    // the shapes are comparable by eye.
    if (wide) {
      const inner = w.closeDist.filter((b) => b.lo != null && b.hi != null);
      const impliedInner = data.impliedClose?.state === "ok" ? data.impliedClose.buckets.filter((b) => b.lo != null && b.hi != null) : [];
      const maxP = Math.max(...inner.map((b) => b.p), ...impliedInner.map((b) => b.p), 1e-9);
      ctx.fillStyle = "rgba(79,209,232,0.55)";
      for (const b of inner) {
        const y1 = Y(b.hi!), y2 = Y(b.lo!);
        if (y2 < padT || y1 > padT + ih) continue;
        ctx.fillRect(padL + iw + 2, y1 + 0.5, (histW - 6) * (b.p / maxP), Math.max(1, y2 - y1 - 1));
      }
      ctx.strokeStyle = "rgba(251,191,36,0.9)"; ctx.lineWidth = 1;
      for (const b of impliedInner) {
        const y1 = Y(b.hi!), y2 = Y(b.lo!);
        if (y2 < padT || y1 > padT + ih) continue;
        ctx.strokeRect(padL + iw + 2.5, y1 + 1, Math.max(0.5, (histW - 6) * (b.p / maxP)), Math.max(1, y2 - y1 - 2));
      }
    }

    // now / spot
    if (w.spot != null) {
      const x = X(geo.startAbs), y = Y(w.spot);
      ctx.fillStyle = "#fbbf24"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    if (hoverMin != null) {
      const x = X(hoverMin);
      ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
    }
  }, [data, w, ok, geo, wrapW, hoverMin, showOverlay]);

  const onMove = (clientX: number | undefined) => {
    if (clientX == null || !geo || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const histW = rect.width >= 640 ? 70 : 0;
    const iw = rect.width - 6 - 70 - histW;
    const abs = geo.x0 + ((clientX - rect.left - 6) / iw) * (geo.endAbs - geo.x0);
    setHoverMin(Math.max(geo.x0, Math.min(geo.endAbs, abs)));
  };
  const readout = useMemo(() => {
    if (hoverMin == null || !w || !geo) return null;
    if (hoverMin < geo.startAbs) {
      const p = [...geo.path].reverse().find((x) => x.min + 5 <= hoverMin);
      return p ? { kind: "path" as const, et: hhmm(p.min + 5), close: p.close } : null;
    }
    const t = hoverMin - geo.startAbs;
    const b = w.bands.reduce((best, x) => (Math.abs(x.minute - t) < Math.abs(best.minute - t) ? x : best), w.bands[0]);
    return { kind: "band" as const, et: b.et, q: b.q };
  }, [hoverMin, w, geo]);

  if (isLoading) {
    return (
      <div className="rounded border border-border bg-card/40 p-4 animate-pulse" data-testid="odte-forward-loading">
        <div className="h-4 w-56 bg-muted rounded mb-3" />
        <div className="h-[300px] bg-muted/40 rounded" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded border border-border bg-card/40 p-4 text-xs font-mono text-muted-foreground" data-testid="odte-forward-error">
        0DTE Wiener map unavailable: the 0DTE forward request failed (Schwab sign-in, no 0DTE expiry, or a server error)
      </div>
    );
  }

  const { session, levels, regime } = data;
  const sessionLabel = session.state === "intraday" ? `${session.minutesToClose}m to close` : session.state === "preopen" ? "pre-open, full session" : "closed, next session from the last price";
  const sc = ledger?.wienerScorecard;

  return (
    <div className="rounded border border-border bg-card/40 p-3" data-testid="odte-forward-panel">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-cyan-300">0DTE Wiener map · {w?.horizon === "next_session" ? "next session" : "today"}</span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{data.symbol} · exp {data.expiry} · {sessionLabel}{data.chainStale ? " · chain stale" : ""}</span>
        <span className={`rounded border px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-wider ${regime === "indeterminate" ? "border-border text-muted-foreground" : regime === "long_gamma" ? "border-lime-500/40 text-lime-400" : "border-red-500/40 text-red-400"}`} data-testid="odte-regime">
          {regime === "indeterminate" ? "gamma sign not determined" : regime === "long_gamma" ? "long gamma at spot" : "short gamma at spot"}
        </span>
      </div>

      {!ok ? (
        <div className="rounded border border-border/60 p-3 text-xs text-muted-foreground" data-testid="odte-wiener-unavailable">
          Wiener map unavailable: {w?.reason ?? "the forward did not include it"}
        </div>
      ) : (
        <>
          <div className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
            <Chip label="1σ to the close" testId="odte-em-sigma" value={`±${w!.sigmaToClose}`} sub={w!.sigmaSource === "atm_iv" ? `ATM IV ${data.atmIV}%${w!.sigmaFromStraddle != null ? `; straddle implies ±${w!.sigmaFromStraddle}` : ""}` : "from the ATM straddle (no IV)"} />
            <Chip label="Expected high left" testId="odte-exp-high" value={`${w!.expected!.high}`} sub="mean of the remaining high" />
            <Chip label="Expected low left" testId="odte-exp-low" value={`${w!.expected!.low}`} sub="mean of the remaining low" />
            <Chip label="Expected range left" testId="odte-exp-range" value={`${w!.expected!.range} pts`} sub="mean high minus low" />
            <Chip label="Pin · walls · flip" testId="odte-walls" value={`${levels.pin ?? "n/a"} · ${levels.putWall ?? "n/a"}–${levels.callWall ?? "n/a"} · ${levels.gammaFlip ?? "n/a"}`} sub={data.netGex != null ? `0DTE net GEX ${fmtUsd(data.netGex)}` : "gamma not priced"} />
          </div>

          <div
            ref={wrapRef}
            className="relative touch-pan-y select-none"
            onMouseMove={(e) => onMove(e.clientX)}
            onMouseLeave={() => setHoverMin(null)}
            onTouchStart={(e) => onMove(e.touches[0]?.clientX)}
            onTouchMove={(e) => onMove(e.touches[0]?.clientX)}
            onTouchEnd={() => setHoverMin(null)}
            data-testid="odte-cone"
            role="group"
            aria-label="Today's path so far and the Wiener model's percentile bands to the close"
          >
            <canvas ref={canvasRef} role="img" aria-label="0DTE Wiener map chart" />
            {readout && (
              <div className="pointer-events-none absolute left-1 top-1 z-10 rounded border border-border bg-background/95 px-2 py-1 text-[11px] font-mono" data-testid="odte-readout">
                {readout.kind === "path" ? (
                  <div>{readout.et} ET · 5-minute close {readout.close}</div>
                ) : (
                  <>
                    <div className="text-muted-foreground">{readout.et} ET · model percentiles</div>
                    <div>median {readout.q.p50} · 25–75%: {readout.q.p25}–{readout.q.p75}</div>
                    <div>10–90%: {readout.q.p10}–{readout.q.p90} · 2.5–97.5%: {readout.q.p025}–{readout.q.p975}</div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="mt-1 flex flex-wrap gap-2">
            <button type="button" onClick={() => setShowLevels((v) => !v)} aria-expanded={showLevels} data-testid="button-toggle-levelmap"
              className="min-h-[44px] rounded border border-border px-3 text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">
              {showLevels ? "Hide level odds" : "Show level odds"}
            </button>
            <button type="button" onClick={() => setShowOverlay((v) => !v)} aria-pressed={showOverlay} data-testid="button-toggle-overlay"
              className="min-h-[44px] rounded border border-border px-3 text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">
              {showOverlay ? "Hide dealer overlay" : "Dealer overlay (heuristic)"}
            </button>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground" data-testid="odte-close-range">
            Model close: 50% between {w!.bands[w!.bands.length - 1].q.p25} and {w!.bands[w!.bands.length - 1].q.p75}; 80% between {w!.bands[w!.bands.length - 1].q.p10} and {w!.bands[w!.bands.length - 1].q.p90}; 95% between {w!.bands[w!.bands.length - 1].q.p025} and {w!.bands[w!.bands.length - 1].q.p975}.
          </div>
          {showOverlay && (
            <div className="mt-1 text-[11px] text-amber-300/90" data-testid="odte-overlay-note">
              Amber dotted line: {data.pathBasis ?? "dealer-positioning rules of thumb"}. Not part of the Wiener baseline and not graded.
            </div>
          )}

          {showLevels && (
            <div className="mt-2 overflow-x-auto" data-testid="odte-level-map">
              <table className="w-full text-[11px] font-mono">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-2 font-normal">Level</th>
                    <th className="py-1 pr-2 font-normal">Price</th>
                    <th className="py-1 pr-2 font-normal">Away</th>
                    <th className="py-1 pr-2 font-normal">Touch by close</th>
                    <th className="py-1 font-normal">Close above</th>
                  </tr>
                </thead>
                <tbody>
                  {w!.levels.map((L) => (
                    <tr key={`${L.kind}-${L.price}`} className="border-t border-border/40" data-testid={`level-${L.kind}-${L.price}`}>
                      <td className="py-1 pr-2"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: KIND_COLOR[L.kind] ?? "#94a3b8" }} />{L.label}</td>
                      <td className="py-1 pr-2 tabular-nums">{Math.round(L.price)}</td>
                      <td className="py-1 pr-2 tabular-nums">{L.side === "at" ? "at price" : `${L.distance > 0 ? "+" : ""}${Math.round(L.distance)} (${L.distanceSigma}σ)`}</td>
                      <td className="py-1 pr-2 tabular-nums">{L.side === "at" ? "at price" : pct(L.pTouch)}{L.touchedToday ? " · traded earlier today" : ""}</td>
                      <td className="py-1 tabular-nums">{pct(L.pCloseAbove)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-2 rounded border border-border/60 p-2 text-[11px]" data-testid="odte-wiener-scorecard">
            <div className="font-mono uppercase tracking-wider text-muted-foreground">Morning odds scorecard</div>
            {!sc ? (
              <div className="text-muted-foreground">Scorecard unavailable: the settle ledger did not answer.</div>
            ) : sc.days === 0 ? (
              <div className="text-muted-foreground">No scored days yet. Each session's morning map (the first map after the open) has its odds scored after the close; the odds stay untested until {sc.minDays} days are scored.</div>
            ) : (
              <>
                <div className={sc.tested ? "text-foreground" : "text-amber-300/90"}>
                  {sc.days} scored day{sc.days === 1 ? "" : "s"}{sc.tested ? "" : ` of ${sc.minDays} needed: untested`} · touch Brier {sc.touch.brier ?? "n/a"} vs {sc.touch.brierBaseRate ?? "n/a"} for always stating the base rate (lower is better)
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                  {sc.touch.buckets.filter((b) => b.n > 0).map((b) => (
                    <span key={b.lo}>{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%: said {pct(b.stated ?? 0)}, happened {pct(b.observed ?? 0)} (n {b.n})</span>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground" data-testid="odte-wiener-method">
            {w!.model}. Bands are percentiles of the price at each time, not paths. Touch = trading at the level at least once before the close (exact for this model). {w!.caveats.join("; ")}.
          </div>
          <div className="mt-1.5 rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1.5 text-[11px] leading-relaxed" data-testid="odte-implied-close">
            <span className="font-semibold uppercase tracking-[0.14em] text-amber-300/90">Chain's own settle distribution</span>
            {data.impliedClose?.state === "ok" && data.closeComparison ? (
              <>
                <span className="text-foreground/85"> (amber outline beside the plot on wide screens): {data.closeComparison.text}</span>
                <span className="text-muted-foreground"> Read from {data.impliedClose.diagnostics.strikes} strikes with two-sided mids{data.impliedClose.diagnostics.clipped ? `, ${data.impliedClose.diagnostics.clipped} butterflies clipped at zero` : ""}{((data.impliedClose.diagnostics.lowTail ?? 0) + (data.impliedClose.diagnostics.highTail ?? 0)) > 0.1 ? `; ${Math.round(((data.impliedClose.diagnostics.lowTail ?? 0) + (data.impliedClose.diagnostics.highTail ?? 0)) * 100)}% of the mass lies beyond the readable strikes and is placed just past them` : ""}; {data.impliedClose.method}.</span>
              </>
            ) : (
              <span className="text-muted-foreground"> not readable: {data.impliedClose?.reason ?? "no chain mids"}. Nothing is drawn in its place.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="rounded border border-border bg-card/40 px-2 py-1.5">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-xs font-mono text-foreground" data-testid={testId}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
