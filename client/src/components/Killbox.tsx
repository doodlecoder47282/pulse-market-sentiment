/**
 * Killbox.tsx — VS3D-style time-series greek-gradient heatmap.
 *
 * Reads /api/killbox/gradient (rolling snapshot table written every chain-audit
 * run). Renders a Canvas2D grid: X = time (oldest left → newest right),
 * Y = strike (low bottom → high top), color = signed greek exposure on a
 * divergent electric blue → black → electric pink scale, normalized to abs max.
 *
 * When the Schwab feed is down the snapshot table is empty, so this shows an
 * honest empty state rather than a blank canvas.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import LivenessBadge from "@/components/LivenessBadge";

type Greek = "charm" | "vanna" | "vomma" | "zomma";

interface GradientPoint {
  ts: number;
  spot: number;
  strike: number;
  exposure: number;
}

interface GradientResponse {
  symbol: string;
  greek: string;
  hours: number;
  points: GradientPoint[];
  stats: { count: number; oldestTs: number | null; newestTs: number | null };
}

const GREEKS: { key: Greek; label: string }[] = [
  { key: "charm", label: "CHARM" },
  { key: "vanna", label: "VANNA" },
  { key: "vomma", label: "VOMMA" },
  { key: "zomma", label: "ZOMMA" },
];

const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: "1H" },
  { hours: 2, label: "2H" },
  { hours: 6, label: "6H" },
];

const MIN_CELL_PX = 6;
const SPOT_LINE = "#facc15"; // yellow-400

// Divergent scale: electric blue (+) → black (0) → electric pink (−).
// t in [-1, 1]. We interpolate in HSL through near-black at the midpoint.
function colorFor(t: number): string {
  if (!Number.isFinite(t)) return "hsl(0,0%,5%)";
  const a = Math.min(Math.abs(t), 1);
  if (t >= 0) {
    // black → electric blue
    const l = 5 + a * 45; // 5% → 50%
    const s = a * 100;
    return `hsl(200,${s.toFixed(0)}%,${l.toFixed(0)}%)`;
  }
  // black → electric pink
  const l = 5 + a * 50; // 5% → 55%
  const s = a * 100;
  return `hsl(330,${s.toFixed(0)}%,${l.toFixed(0)}%)`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function Killbox({ symbol = "SPY" }: { symbol?: string }) {
  const [greek, setGreek] = useState<Greek>("charm");
  const [hours, setHours] = useState(2);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(640);

  const q = useQuery<GradientResponse>({
    queryKey: ["/api/killbox/gradient", symbol, greek, hours],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/killbox/gradient?symbol=${encodeURIComponent(symbol)}&greek=${greek}&hours=${hours}`,
      );
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const data = q.data;
  const points = data?.points ?? [];

  // Track wrapper width for a responsive canvas (mobile = full width).
  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWrapW(Math.max(280, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build the grid model: unique sorted timestamps (→ columns) and strikes (→ rows).
  const grid = useMemo(() => {
    if (points.length === 0) return null;
    const tsSet = new Set<number>();
    const strikeSet = new Set<number>();
    let absMax = 0;
    let lastSpot = points[points.length - 1].spot;
    for (const p of points) {
      tsSet.add(p.ts);
      strikeSet.add(p.strike);
      const a = Math.abs(p.exposure);
      if (Number.isFinite(a) && a > absMax) absMax = a;
    }
    const times = [...tsSet].sort((a, b) => a - b);
    const strikes = [...strikeSet].sort((a, b) => a - b);
    const tIdx = new Map(times.map((t, i) => [t, i]));
    const sIdx = new Map(strikes.map((s, i) => [s, i]));
    // value[strikeRow][timeCol]
    const value: (number | null)[][] = strikes.map(() => times.map(() => null));
    for (const p of points) {
      const r = sIdx.get(p.strike);
      const c = tIdx.get(p.ts);
      if (r != null && c != null) value[r][c] = p.exposure;
    }
    return { times, strikes, value, absMax: absMax || 1, lastSpot };
  }, [points]);

  // Render the heatmap to canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrapW;
    const cssH = 360;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padL = 44; // strike axis labels
    const padB = 22; // time axis labels
    const padT = 6;
    const padR = 6;
    const plotW = Math.max(1, cssW - padL - padR);
    const plotH = Math.max(1, cssH - padT - padB);

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "hsl(0,0%,5%)";
    ctx.fillRect(padL, padT, plotW, plotH);

    const { times, strikes, value, absMax, lastSpot } = grid;

    // Bin time into ~ (plotW / MIN_CELL_PX) columns; map each source ts to a bin.
    const maxCols = Math.max(1, Math.floor(plotW / MIN_CELL_PX));
    const nCols = Math.min(times.length, maxCols);
    const colW = plotW / nCols;
    const rowH = plotH / strikes.length;

    // For each rendered column, pick the source time-index it represents.
    const colToTimeIdx = (col: number) =>
      Math.min(times.length - 1, Math.floor((col / nCols) * times.length));

    for (let col = 0; col < nCols; col++) {
      const ti = colToTimeIdx(col);
      for (let r = 0; r < strikes.length; r++) {
        const v = value[r][ti];
        if (v == null) continue;
        ctx.fillStyle = colorFor(v / absMax);
        // strike low at bottom → invert row for y
        const y = padT + (strikes.length - 1 - r) * rowH;
        ctx.fillRect(padL + col * colW, y, Math.ceil(colW) + 0.5, Math.ceil(rowH) + 0.5);
      }
    }

    // Spot line (thin yellow horizontal). Interpolate spot position across strikes.
    if (Number.isFinite(lastSpot) && strikes.length > 1) {
      const lo = strikes[0];
      const hi = strikes[strikes.length - 1];
      if (lastSpot >= lo && lastSpot <= hi) {
        const frac = (lastSpot - lo) / (hi - lo); // 0 at lo, 1 at hi
        const y = padT + (1 - frac) * plotH;
        ctx.strokeStyle = SPOT_LINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
      }
    }

    // Strike axis labels (every 5th strike).
    ctx.fillStyle = "rgba(161,161,170,0.9)"; // zinc-400
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let r = 0; r < strikes.length; r++) {
      if (r % 5 !== 0) continue;
      const y = padT + (strikes.length - 1 - r) * rowH + rowH / 2;
      ctx.fillText(String(Math.round(strikes[r])), padL - 4, y);
    }

    // Time axis labels at minute marks (a few evenly spaced).
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelCols = Math.min(6, nCols);
    for (let i = 0; i < labelCols; i++) {
      const col = Math.floor((i / Math.max(1, labelCols - 1)) * (nCols - 1));
      const ti = colToTimeIdx(col);
      const x = padL + col * colW + colW / 2;
      ctx.fillText(fmtTime(times[ti]), Math.min(Math.max(x, padL + 14), padL + plotW - 14), padT + plotH + 4);
    }
  }, [grid, wrapW]);

  const stats = data?.stats;
  const lastSpot = grid?.lastSpot ?? (points.length ? points[points.length - 1].spot : null);

  return (
    <div className="space-y-3" data-testid="killbox-panel">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {GREEKS.map(g => (
            <button
              key={g.key}
              data-testid={`killbox-greek-${g.key}`}
              onClick={() => setGreek(g.key)}
              className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                greek === g.key
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {WINDOWS.map(w => (
            <button
              key={w.hours}
              data-testid={`killbox-window-${w.label}`}
              onClick={() => setHours(w.hours)}
              className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                hours === w.hours
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <LivenessBadge feedName="options-cboe" value={stats?.count} requiresSchwab={true} />
        </div>
      </div>

      {/* Main: canvas + right rail */}
      <div className="flex flex-col lg:flex-row gap-3">
        <div ref={wrapRef} className="flex-1 min-w-0 rounded border border-border bg-[hsl(0,0%,5%)] p-1">
          {q.isLoading ? (
            <div className="h-[360px] flex items-center justify-center text-xs text-muted-foreground">
              loading {symbol} {greek}…
            </div>
          ) : points.length === 0 ? (
            <div className="h-[360px] flex flex-col items-center justify-center gap-1.5 text-center px-6">
              <div className="text-sm font-semibold text-foreground">No snapshots yet</div>
              <div className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                Killbox collects when the Schwab feed is live. It comes online once the option
                surface is reauthed — then this fills in left-to-right as snapshots land.
              </div>
            </div>
          ) : (
            <canvas ref={canvasRef} data-testid="killbox-canvas" className="block w-full" />
          )}
        </div>

        {/* Right rail (desktop) / bottom strip (mobile) */}
        <div className="lg:w-48 shrink-0 grid grid-cols-2 lg:grid-cols-1 gap-2">
          <div className="rounded border border-border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">legend</div>
            <div className="h-2 w-full rounded-sm mb-1"
              style={{ background: "linear-gradient(90deg, hsl(330,100%,55%), hsl(0,0%,5%), hsl(200,100%,50%))" }}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span className="text-pink-400">− short</span>
              <span>0</span>
              <span className="text-sky-400">+ long</span>
            </div>
          </div>

          <div className="rounded border border-border p-2.5 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">current spot</div>
            <div className="text-sm font-semibold tabular-nums">
              {lastSpot != null && Number.isFinite(lastSpot) && lastSpot !== 0
                ? `$${lastSpot.toFixed(2)}`
                : "—"}
            </div>
          </div>

          <div className="rounded border border-border p-2.5 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">snapshots</div>
            <div className="text-sm font-semibold tabular-nums">{stats?.count ?? 0}</div>
          </div>

          <div className="rounded border border-border p-2.5 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">window</div>
            <div className="text-xs tabular-nums">
              {stats?.oldestTs ? fmtTime(stats.oldestTs) : "—"}
              {" → "}
              {stats?.newestTs ? fmtTime(stats.newestTs) : "—"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
