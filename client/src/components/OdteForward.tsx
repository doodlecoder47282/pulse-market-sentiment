/**
 * OdteForward.tsx — 0DTE FORWARD SESSION MAP.
 *
 * Renders the model's projected shape for the rest of the session:
 *   - PROJECTED CANDLES (cyan) from now to 16:00 ET, routed along the median path
 *     with level attraction, wicks scaled by per-bucket sigma. Seeded per session
 *     so the shape is stable across refreshes.
 *   - SHADED ENVELOPE = 1-sigma cone around the route.
 *   - LEVEL MAP = every meaningful price for the day with a real P(touch) from the
 *     reflection principle, right-axis tagged (red above spot, green below).
 *
 * These project the model's expected SHAPE, not actual future bars.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface ProjCandle {
  minute: number; et: string;
  open: number; high: number; low: number; close: number;
  bandUp: number; bandDn: number;
}
interface MappedLevel {
  price: number; kind: string; label: string;
  side: "above" | "below" | "at";
  distance: number; distancePct: number;
  pTouch: number; touched: boolean; strength: number; note: string;
}
interface OdteResponse {
  symbol: string; asOf: string; spot: number; source: string;
  expiry: string; dte: number;
  session: { state: "preopen" | "intraday" | "closed"; minutesToClose: number; projMinutes: number };
  atmIV: number; atmIVSource?: "chain" | "straddle"; gexValid?: boolean;
  expectedMove: { sigma: number | null; straddle: number | null };
  netGex: number | null; netCharm: number | null;
  regime: "long_gamma" | "short_gamma" | "indeterminate";
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null; pin: number | null };
  bars: { priorClose: number | null; sessionHigh: number | null; sessionLow: number | null; orbHigh: number | null; orbLow: number | null; vwap: number | null };
  levelMap: MappedLevel[];
  candles: ProjCandle[];
  weightTotals: { oi: number; volume: number };
}

const CYAN = "#4fd1e8";
const AMBER = "#fbbf24";
const LIME = "#7cf04b";
const RED = "#ff4d52";
const PURPLE = "#a78bfa";

const KIND_COLOR: Record<string, string> = {
  call_wall: LIME, put_wall: RED, gamma_flip: PURPLE, pin: AMBER,
  gex_peak: "#7c8ea8", prior_close: "#94a3b8", session_high: "#94a3b8",
  session_low: "#94a3b8", orb_high: "#c084fc", orb_low: "#c084fc",
  vwap: "#38bdf8", sigma: "rgba(251,191,36,0.55)",
};

function fmtUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}

export default function OdteForward() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [wrapW, setWrapW] = useState(0);
  const [showMap, setShowMap] = useState(true);

  const { data, isLoading, isError } = useQuery<OdteResponse>({
    queryKey: ["/api/odte/forward"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/odte/forward?symbol=%24SPX");
      return r.json();
    },
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWrapW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((es) => setWrapW(es[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const H = 380;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data?.candles?.length || wrapW < 80) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrapW;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const padL = 6, padR = 62, padT = 12, padB = 24;
    const iw = W - padL - padR, ih = H - padT - padB;
    const cs = data.candles;
    const spot = data.spot;

    // y-range is driven by the CANDLES + 1σ envelope only. Far levels (2σ rails,
    // distant walls) must not stretch the scale or the candles collapse to a line.
    let lo = Infinity, hi = -Infinity;
    for (const c of cs) {
      lo = Math.min(lo, c.low, c.bandDn); hi = Math.max(hi, c.high, c.bandUp);
    }
    lo = Math.min(lo, spot); hi = Math.max(hi, spot);
    const pad = ((hi - lo) || 1) * 0.08;
    lo -= pad; hi += pad;
    // only draw levels that actually fall inside the projection window
    const visibleLevels = data.levelMap.filter((L) => L.price >= lo && L.price <= hi);

    const n = cs.length;
    const slotW = iw / n;
    const X = (i: number) => padL + slotW * (i + 0.5);
    const Y = (v: number) => padT + ih * (1 - (v - lo) / (hi - lo));

    // ── shaded projection zone (the box in your chart) ──
    ctx.fillStyle = "rgba(79,209,232,0.045)";
    ctx.fillRect(padL, padT, iw, ih);

    // ── grid + time labels ──
    ctx.font = "9px ui-monospace, monospace";
    ctx.strokeStyle = "rgba(148,163,184,0.08)";
    ctx.fillStyle = "rgba(148,163,184,0.5)";
    ctx.lineWidth = 1;
    const step = Math.max(1, Math.floor(n / 5));
    for (let i = 0; i < n; i += step) {
      const x = X(i);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(cs[i].et, x, H - 8);
    }

    // ── 1σ envelope ──
    ctx.beginPath();
    cs.forEach((c, i) => { const x = X(i), y = Y(c.bandUp); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), Y(cs[i].bandDn));
    ctx.closePath();
    ctx.fillStyle = "rgba(79,209,232,0.07)";
    ctx.fill();
    ctx.strokeStyle = "rgba(79,209,232,0.22)";
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath();
    cs.forEach((c, i) => { const x = X(i), y = Y(c.bandUp); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
    ctx.beginPath();
    cs.forEach((c, i) => { const x = X(i), y = Y(c.bandDn); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
    ctx.setLineDash([]);

    // ── horizontal level lines + right-axis tags ──
    const tagged: Array<{ y: number; price: number; color: string; p: number }> = [];
    for (const L of visibleLevels) {
      const y = Y(L.price);
      if (y < padT || y > padT + ih) continue;
      const color = KIND_COLOR[L.kind] || "#94a3b8";
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = L.touched ? 0.22 : 0.32 + L.strength * 0.3;
      ctx.lineWidth = L.strength > 0.8 ? 1.4 : 1;
      ctx.setLineDash(L.kind === "sigma" ? [2, 4] : L.strength > 0.8 ? [] : [5, 4]);
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      tagged.push({ y, price: L.price, color, p: L.pTouch });
    }
    // right-axis price tags, de-overlapped
    tagged.sort((a, b) => a.y - b.y);
    let lastY = -99;
    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "left";
    for (const t of tagged) {
      if (t.y - lastY < 10) continue;
      lastY = t.y;
      const label = `${t.price}`;
      const w = ctx.measureText(label).width + 6;
      ctx.fillStyle = t.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(padL + iw + 3, t.y - 5.5, w, 11);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#0a0a0a";
      ctx.fillText(label, padL + iw + 6, t.y + 2.5);
    }

    // ── projected candles ──
    const bw = Math.max(2, Math.min(9, slotW * 0.6));
    cs.forEach((c, i) => {
      const x = X(i);
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? CYAN : "rgba(79,209,232,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(c.high)); ctx.lineTo(x, Y(c.low)); ctx.stroke();
      const yo = Y(c.open), yc = Y(c.close);
      const top = Math.min(yo, yc), hgt = Math.max(1.5, Math.abs(yc - yo));
      if (up) {
        ctx.fillStyle = "rgba(79,209,232,0.28)";
        ctx.fillRect(x - bw / 2, top, bw, hgt);
        ctx.strokeRect(x - bw / 2, top, bw, hgt);
      } else {
        ctx.fillStyle = CYAN;
        ctx.fillRect(x - bw / 2, top, bw, hgt);
      }
    });

    // ── spot marker (left edge = now) ──
    const sy = Y(spot);
    ctx.strokeStyle = "rgba(251,191,36,0.85)";
    ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(padL, sy); ctx.lineTo(padL + iw, sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = AMBER;
    ctx.beginPath(); ctx.arc(padL + 2, sy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(spot.toFixed(0), padL + 8, sy - 6);

    // ── hover ──
    if (hover != null && hover >= 0 && hover < n) {
      const x = X(hover);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
    }
  }, [data, wrapW, hover]);

  const hoverCandle = useMemo(
    () => (hover != null && data?.candles ? data.candles[hover] ?? null : null),
    [hover, data],
  );

  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!data?.candles?.length || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const cx = "touches" in e ? e.touches[0]?.clientX : (e as React.MouseEvent).clientX;
    if (cx == null) return;
    const iw = rect.width - 6 - 62;
    const rel = cx - rect.left - 6;
    const idx = Math.floor((rel / iw) * data.candles.length);
    setHover(Math.max(0, Math.min(data.candles.length - 1, idx)));
  };

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
        0DTE FORWARD — chain unavailable (schwab auth or no 0dte expiry)
      </div>
    );
  }

  const { session, expectedMove, levels, regime, levelMap } = data;
  const sessionLabel = session.state === "intraday" ? `${session.minutesToClose}m to close` : session.state === "preopen" ? "pre-open · full session" : "closed · next session";
  const longG = regime === "long_gamma";
  const indet = regime === "indeterminate";
  const untouched = levelMap.filter((L) => !L.touched);
  const projClose = data.candles.length ? data.candles[data.candles.length - 1].close : null;

  return (
    <div className="rounded border border-border bg-card/40 p-3" data-testid="odte-forward-panel">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-cyan-300">0DTE Forward Map</span>
        <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">{data.symbol} · exp {data.expiry} · {sessionLabel}</span>
        <span className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${indet ? "border-border text-muted-foreground" : longG ? "border-lime-500/40 text-lime-400" : "border-red-500/40 text-red-400"}`} data-testid="odte-regime">
          {indet ? "greeks pending open" : longG ? "long gamma · pin" : "short gamma · amplify"}
        </span>
        <button
          onClick={() => setShowMap((v) => !v)}
          className="ml-auto text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-cyan-500/40"
          data-testid="button-toggle-levelmap"
        >
          {showMap ? "hide levels" : "show levels"}
        </button>
      </div>

      {/* chips */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mb-2">
        <div className="rounded border border-border bg-card/40 px-2 py-1.5">
          <div className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground">EM to close (1σ)</div>
          <div className="text-xs font-mono text-amber-400" data-testid="odte-em-sigma">{expectedMove.sigma != null ? `±${expectedMove.sigma}` : "—"}</div>
        </div>
        <div className="rounded border border-border bg-card/40 px-2 py-1.5">
          <div className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground">Proj. close</div>
          <div className="text-xs font-mono text-cyan-300" data-testid="odte-proj-close">{projClose ?? "—"}</div>
        </div>
        <div className="rounded border border-border bg-card/40 px-2 py-1.5">
          <div className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground">0DTE net GEX</div>
          <div className={`text-xs font-mono ${data.netGex == null ? "text-muted-foreground" : data.netGex >= 0 ? "text-lime-400" : "text-red-400"}`} data-testid="odte-net-gex">{data.netGex != null ? fmtUsd(data.netGex) : "—"}</div>
        </div>
        <div className="rounded border border-border bg-card/40 px-2 py-1.5">
          <div className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground">Pin</div>
          <div className="text-xs font-mono text-amber-400" data-testid="odte-pin">{levels.pin ?? "—"}</div>
        </div>
        <div className="rounded border border-border bg-card/40 px-2 py-1.5">
          <div className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground">Wall / Flip</div>
          <div className="text-xs font-mono text-foreground" data-testid="odte-walls">{levels.putWall ?? "—"}–{levels.callWall ?? "—"} <span className="text-purple-400">/{levels.gammaFlip ?? "—"}</span></div>
        </div>
      </div>

      {/* projection chart */}
      <div
        ref={wrapRef}
        className="relative select-none touch-pan-y"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onTouchMove={onMove}
        onTouchEnd={() => setHover(null)}
        data-testid="odte-cone"
      >
        <canvas ref={canvasRef} />
        {hoverCandle && (
          <div className="absolute top-1 left-1 rounded border border-border bg-background/92 px-2 py-1 text-[9px] font-mono pointer-events-none z-10">
            <div className="text-muted-foreground">{hoverCandle.et} ET · projected</div>
            <div className="text-cyan-300">O {hoverCandle.open} · C {hoverCandle.close}</div>
            <div className="text-foreground">H {hoverCandle.high} · L {hoverCandle.low}</div>
            <div className="text-muted-foreground">1σ {hoverCandle.bandDn} – {hoverCandle.bandUp}</div>
          </div>
        )}
      </div>

      {/* level map */}
      {showMap && (
        <div className="mt-2" data-testid="odte-level-map">
          <div className="text-[8px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
            Level map · P(touch) before close · {untouched.length} untouched
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
            {levelMap.slice(0, 14).map((L) => (
              <div
                key={`${L.kind}-${L.price}`}
                className="flex items-center gap-2 text-[9px] font-mono py-0.5 border-b border-border/40"
                title={L.note}
                data-testid={`level-${L.kind}-${L.price}`}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: KIND_COLOR[L.kind] || "#94a3b8" }} />
                <span className="w-14 shrink-0 tabular-nums text-foreground">{L.price}</span>
                <span className="w-24 shrink-0 truncate text-muted-foreground">{L.label}</span>
                <span className={`w-12 shrink-0 tabular-nums ${L.side === "above" ? "text-red-400" : L.side === "below" ? "text-lime-400" : "text-amber-400"}`}>
                  {L.distance > 0 ? "+" : ""}{L.distance.toFixed(0)}
                </span>
                {/* P(touch) bar */}
                <span className="flex-1 h-1.5 rounded-sm bg-muted/40 overflow-hidden min-w-[30px]">
                  <span
                    className="block h-full rounded-sm"
                    style={{
                      width: `${Math.round(L.pTouch * 100)}%`,
                      background: L.touched ? "rgba(148,163,184,0.4)" : KIND_COLOR[L.kind] || "#94a3b8",
                    }}
                  />
                </span>
                <span className={`w-9 shrink-0 text-right tabular-nums ${L.touched ? "text-muted-foreground" : "text-foreground"}`}>
                  {L.touched ? "hit" : `${Math.round(L.pTouch * 100)}%`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* method */}
      <div className="mt-1.5 text-[8px] font-mono text-muted-foreground leading-relaxed">
        projected shape, not a bar forecast · candles routed on median path (pin gravity + charm tilt + wall clamp), wicks scaled by bucket σ, seeded per session so it doesn't flicker · P(touch) = 2·Φ(−|L−S|/σ√t), reflection principle · ATM IV {data.atmIV}%{data.atmIVSource === "straddle" ? " straddle-derived" : ""} · prior close {data.bars.priorClose ?? "—"} · ORB {data.bars.orbLow ?? "—"}–{data.bars.orbHigh ?? "—"}
      </div>
    </div>
  );
}
