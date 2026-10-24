import EdgeInfo from "@/components/EdgeInfo";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Flame, Activity, AlertTriangle } from "lucide-react";

import DataStateChip from "@/components/DataStateChip";
import ThermalSurface from "@/components/ThermalSurface";
// three.js is fetched only when the 3D view opens.
const ThermalSurface3D = lazy(() => import("@/components/ThermalSurface3D"));
function canWebGL(): boolean {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

type Cell = {
  expIdx: number; strikeIdx: number;
  expiry: string; dte: number; strike: number;
  exposure: number;
  gex: number; vanna: number; charm: number; vomma: number; zomma: number;
  callOI: number; putOI: number;
  callVolume?: number; putVolume?: number;
  /** Per-side split of the selected greek (newer servers). exposure = callExposure + putExposure
   *  when both priced; null = that side had open interest but no usable IV (unknown, not zero). */
  callExposure?: number | null; putExposure?: number | null; callUnpricedOI?: number; putUnpricedOI?: number;
};
type ThermalResp = {
  symbol: string;
  asOf: number;
  spot: number;
  greek: "gex" | "vanna" | "charm" | "vomma" | "zomma";
  weightMode: string;
  strikes: number[];
  expiries: Array<{ label: string; dte: number; maxAbs?: number }>;
  cells: Cell[];
  maxAbs: number;
  strikeTotals: Array<{ strike: number; total: number; totalAbs: number }>;
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null };
  /** Method and assumptions (server/thermalHeatmap.ts). Older servers omit it. */
  method?: {
    position: string;
    positionAsOf: string;
    dealerSignNote: string;
    r: number;
    q: number;
    units: Record<string, string>;
    contractsUsed: number;
    contractsWithoutOI: number;
    contractsSettled: number;
    contractsNoSigma: number;
  };
  dataState?: "ok" | "no_iv" | "empty";
  reason?: string | null;
  chain?: { asOfMs: number | null; ageMs: number | null; servedFromCache: boolean; stale: boolean; staleReason: string | null };
  source: string;
};

type Greek = "gex" | "vanna" | "charm" | "vomma" | "zomma";
const GREEKS: Array<{ key: Greek; label: string; desc: string; unit: string }> = [
  { key: "gex", label: "GEX", desc: "Dealer gamma: $ of delta hedge per 1% move", unit: "$ delta hedge per 1% spot move" },
  { key: "vanna", label: "Vanna", desc: "Dealer delta change per +1 vol point", unit: "$ delta hedge per +1 vol point" },
  { key: "charm", label: "Charm", desc: "Dealer delta change over one day", unit: "$ delta hedge over 1 day" },
  { key: "vomma", label: "Vomma", desc: "Dealer vega change per +1 vol point", unit: "$ vega per +1 vol point" },
  { key: "zomma", label: "Zomma", desc: "GEX change per +1 vol point", unit: "$ GEX per +1 vol point" },
];

// Diverging color: positive = emerald (long gamma / support), negative = rose (short gamma / risk)
function colorFor(exposure: number, maxAbs: number): string {
  if (!maxAbs || Math.abs(exposure) < 1e-9) return "rgba(30,41,59,0.35)";
  const t = Math.min(1, Math.abs(exposure) / maxAbs);
  // log-scale intensity so mid values still show
  const intensity = Math.pow(t, 0.55);
  if (exposure >= 0) {
    // emerald hot — saturated floor so the field reads at a glance (IMG_0905 ref)
    return `rgba(16, 185, 129, ${0.28 + intensity * 0.72})`;
  } else {
    // rose hot
    return `rgba(244, 63, 94, ${0.28 + intensity * 0.72})`;
  }
}

// Compact in-cell dollar label: +$15.1M / -$530.9K / -$1.2B
function fmtCell(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtNum(n: number): string {
  // Dollar-prefixed like the cells (fmtCell) so the tooltip reads in the same unit.
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(1)}`;
}

export default function ThermalHeatmap() {
  const [greek, setGreek] = useState<Greek>("gex");
  const [symbol] = useState("$SPX");
  // per-date: each expiry column normalizes to its own max, so every date lights
  // up green at its hottest strike and shades out from there. global: one scale
  // across the whole grid (near-dated OI dominates and far dates look dead).
  const [scaleMode, setScaleMode] = useState<"per-date" | "global">("per-date");
  // grid: the strike x expiry table with the dollar in every cell; surface: the
  // same numbers as a 3D height field on one scale (ThermalSurface.tsx).
  const [viewMode, setViewMode] = useState<"grid" | "3d" | "surface">("grid");
  const webgl = useMemo(() => canWebGL(), []);
  const [hover, setHover] = useState<Cell | null>(null);
  const [showTable, setShowTable] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { data: raw, isLoading, error } = useQuery<ThermalResp>({
    queryKey: ["/api/heatmap/thermal", symbol, greek],
    queryFn: async () => {
      // apiRequest, NOT raw fetch — raw fetch bypasses the deploy proxy and 404s on the hosted app
      const r = await apiRequest("GET", `/api/heatmap/thermal?symbol=${encodeURIComponent(symbol)}&greek=${greek}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Layout constants — cells sized to carry their dollar value (hover-free
  // reading on mobile; the reference grid puts the number in the cell)
  // 10 px in-cell text is the floor the UX audit holds every screen to.
  const rowH = 20;
  const marginTop = 44;
  const marginLeft = 56;
  const marginRight = 90;
  const marginBottom = 26;

  // Drop strikes where every expiry is dead (far-OTM zero rows were 60% of
  // the grid — all signal lives near spot). Keep a small context window
  // around spot regardless so the yellow line always has a home.
  const view = useMemo(() => {
    if (!raw) return null;
    const rowHasSignal = new Array<boolean>(raw.strikes.length).fill(false);
    for (const c of raw.cells) {
      if (Math.abs(c.exposure) > 1e-9) rowHasSignal[c.strikeIdx] = true;
    }
    const spotIdx = raw.strikes.findIndex((s) => s >= raw.spot);
    const keep: number[] = [];
    for (let i = 0; i < raw.strikes.length; i++) {
      const nearSpot = spotIdx >= 0 && Math.abs(i - spotIdx) <= 2;
      if (rowHasSignal[i] || nearSpot) keep.push(i);
    }
    if (keep.length === 0 || keep.length === raw.strikes.length) return raw;
    const remap = new Map<number, number>();
    keep.forEach((oldIdx, newIdx) => remap.set(oldIdx, newIdx));
    return {
      ...raw,
      strikes: keep.map((i) => raw.strikes[i]),
      cells: raw.cells
        .filter((c) => remap.has(c.strikeIdx))
        .map((c) => ({ ...c, strikeIdx: remap.get(c.strikeIdx)! })),
    };
  }, [raw]);
  const data = view;
  const canPlot = !!data && !error && data.dataState === "ok" && data.cells.length > 0;
  useEffect(() => { setHover(null); }, [raw, greek]);

  // Max |exposure| per expiry column — drives per-date shading
  const colMax = useMemo(() => {
    if (!data) return [] as number[];
    const m = new Array<number>(data.expiries.length).fill(0);
    for (const c of data.cells) {
      const a = Math.abs(c.exposure);
      if (a > m[c.expIdx]) m[c.expIdx] = a;
    }
    return m;
  }, [data]);

  const grid = useMemo(() => {
    if (!data) return null;
    const nStrikes = data.strikes.length;
    const nExps = data.expiries.length;
    if (!nStrikes || !nExps) return null;
    const height = marginTop + nStrikes * rowH + marginBottom;
    const cellW = 72;
    const width = marginLeft + nExps * cellW + marginRight;
    return { height, width, cellW, nStrikes, nExps };
  }, [data]);

  useEffect(() => {
    if (!data || !grid || viewMode !== "grid") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = grid.width * dpr;
    canvas.height = grid.height * dpr;
    canvas.style.width = grid.width + "px";
    canvas.style.height = grid.height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, grid.width, grid.height);

    // Background rows (subtle alternating for strike readability)
    for (let i = 0; i < grid.nStrikes; i++) {
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(148,163,184,0.03)";
        ctx.fillRect(marginLeft, marginTop + i * rowH, grid.nExps * grid.cellW, rowH);
      }
    }

    // Global extreme cell — gets the standout treatment (ref: blue cell in IMG_0905)
    let extreme: Cell | null = null;
    for (const c of data.cells) {
      if (!extreme || Math.abs(c.exposure) > Math.abs(extreme.exposure)) extreme = c;
    }

    // Cells: saturated fill + in-cell dollar value
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of data.cells) {
      const x = marginLeft + c.expIdx * grid.cellW;
      // strikes are ascending low→high; flip so high strikes on top
      const yIdx = grid.nStrikes - 1 - c.strikeIdx;
      const y = marginTop + yIdx * rowH;
      const norm = scaleMode === "per-date" ? (colMax[c.expIdx] || data.maxAbs) : data.maxAbs;
      const isExtreme = extreme != null && c === extreme && Math.abs(c.exposure) > 0;
      ctx.fillStyle = isExtreme ? "rgba(14, 165, 233, 0.95)" : colorFor(c.exposure, norm);
      ctx.fillRect(x + 0.5, y + 0.5, grid.cellW - 1, rowH - 1);

      // In-cell value — the number IS the map on touch devices (no hover)
      if (Math.abs(c.exposure) >= 1e-9) {
        const t = Math.min(1, Math.abs(c.exposure) / (norm || 1));
        const hot = Math.pow(t, 0.55) > 0.45;
        ctx.font = isExtreme ? "bold 11px ui-monospace, monospace" : "11px ui-monospace, monospace";
        ctx.fillStyle = isExtreme
          ? "rgba(255,255,255,0.98)"
          : hot
            ? "rgba(255,255,255,0.92)"
            : c.exposure >= 0 ? "rgba(167, 243, 208, 0.85)" : "rgba(253, 164, 175, 0.85)";
        ctx.fillText(fmtCell(c.exposure), x + grid.cellW / 2, y + rowH / 2 + 0.5);
      }
    }
    ctx.textBaseline = "alphabetic";

    // Rows run high strike (top) to low strike (bottom); a level between two
    // strikes is drawn between their rows, not snapped to the next strike.
    const yOfLevel = (level: number): number | null => {
      const ks = data.strikes;
      if (!ks.length || level < ks[0] || level > ks[ks.length - 1]) return null;
      let i = 0;
      while (i < ks.length - 1 && ks[i + 1] < level) i++;
      const lo = ks[i], hi = ks[Math.min(i + 1, ks.length - 1)];
      const f = hi > lo ? (level - lo) / (hi - lo) : 0;
      const rowCenter = (idx: number) => marginTop + (grid.nStrikes - 1 - idx) * rowH + rowH / 2;
      return rowCenter(i) + f * (rowCenter(Math.min(i + 1, ks.length - 1)) - rowCenter(i));
    };
    // Spot line
    const spotY = yOfLevel(data.spot);
    if (spotY != null) {
      const y = spotY;
      ctx.strokeStyle = "rgba(250, 204, 21, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(marginLeft + grid.nExps * grid.cellW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`spot ${data.spot.toFixed(0)}`, marginLeft + grid.nExps * grid.cellW + 4, y + 3);
    }

    // Gamma flip line (only for gex)
    if (greek === "gex" && data.levels.gammaFlip != null) {
      const flip = data.levels.gammaFlip;
      const flipY = yOfLevel(flip);
      if (flipY != null) {
        const y = flipY;
        ctx.strokeStyle = "rgba(139, 92, 246, 0.8)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(marginLeft, y);
        ctx.lineTo(marginLeft + grid.nExps * grid.cellW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(139, 92, 246, 0.9)";
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText(`flip ${flip.toFixed(0)}`, marginLeft + grid.nExps * grid.cellW + 4, y + 3);
      }
    }

    // Strike labels (Y axis — every row at 18px pitch; every 2nd beyond 40 strikes)
    const strikeStep = grid.nStrikes > 40 ? 2 : 1;
    ctx.fillStyle = "rgba(203,213,225,0.85)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let i = 0; i < grid.nStrikes; i++) {
      if (i % strikeStep !== 0) continue;
      const strike = data.strikes[i];
      const yIdx = grid.nStrikes - 1 - i;
      const y = marginTop + yIdx * rowH + rowH / 2 + 3;
      ctx.fillText(String(strike), marginLeft - 6, y);
    }

    // Expiry labels (X axis): DTE, and under it the column's own max when each
    // date is shaded to its own scale (so a dim far date is not read as heavy).
    ctx.fillStyle = "rgba(148,163,184,0.75)";
    ctx.textAlign = "center";
    ctx.font = "11px ui-monospace, monospace";
    for (let j = 0; j < grid.nExps; j++) {
      const exp = data.expiries[j];
      const x = marginLeft + j * grid.cellW + grid.cellW / 2;
      ctx.fillText(`${exp.dte}d`, x, marginTop - 20);
      const cm = colMax[j];
      if (scaleMode === "per-date" && cm > 0) {
        ctx.fillStyle = "rgba(148,163,184,0.6)";
        ctx.fillText(`max ${fmtCell(cm).replace(/^[+-]/, "")}`, x, marginTop - 8);
        ctx.fillStyle = "rgba(148,163,184,0.75)";
      }
    }

    // Title band
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${greek.toUpperCase()} · strike × expiry · ${scaleMode === "per-date" ? "each date to its own max" : "one scale"} · open interest only`, marginLeft, marginTop - 32);
  }, [data, grid, greek, scaleMode, colMax, viewMode]);

  // Hover handler
  function onMove(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (!data || !grid) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (x < marginLeft || x > marginLeft + grid.nExps * grid.cellW || y < marginTop || y > marginTop + grid.nStrikes * rowH) {
      setHover(null); return;
    }
    const ei = Math.floor((x - marginLeft) / grid.cellW);
    const yIdx = Math.floor((y - marginTop) / rowH);
    const si = grid.nStrikes - 1 - yIdx;
    const cell = data.cells.find(c => c.expIdx === ei && c.strikeIdx === si);
    setHover(cell || null);
  }

  return (
    <div data-testid="thermal-heatmap" className="relative rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-amber-400" />
          <div className="text-foreground font-semibold text-sm tracking-wide">Thermal · dealer exposure map</div>
          <EdgeInfo id="thermal-heatmap" />
        </div>
        <div className="flex flex-wrap items-center gap-1" data-testid="thermal-greek-selector">
          {(["grid", "3d", "surface"] as const).map(m => (
            <button
              key={m}
              data-testid={`thermal-view-${m}`}
              aria-pressed={viewMode === m}
              onClick={() => setViewMode(m)}
              className={`min-h-[44px] px-2 py-0.5 text-xs rounded font-mono uppercase tracking-wider transition text-foreground ${
                viewMode === m
                  ? "bg-primary/15 border border-primary"
                  : "border border-border"
              }`}
              disabled={m === "3d" && !webgl}
              title={m === "grid" ? "Strike x expiry table with the dollar value in every cell" : m === "3d" ? (webgl ? "Interactive 3D: drag to rotate, pinch to zoom, call/put/net layers" : "WebGL is not available on this device; use 2.5D") : "Projected surface with rotate/tilt sliders (works without WebGL)"}
            >
              {m === "grid" ? "grid" : m === "3d" ? "3D" : "2.5D"}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-slate-700" />
          {(["per-date", "global"] as const).map(m => (
            <button
              key={m}
              data-testid={`thermal-scale-${m}`}
              aria-pressed={scaleMode === m}
              disabled={viewMode !== "grid"}
              onClick={() => setScaleMode(m)}
              className={`min-h-[44px] px-2 py-0.5 text-xs rounded font-mono uppercase tracking-wider transition text-foreground disabled:opacity-50 ${
                scaleMode === m
                  ? "bg-primary/15 border border-primary"
                  : "border border-border"
              }`}
              title={m === "per-date" ? "Each expiry date normalizes to its own max — hottest strike lights up green, shading out within that date" : "One scale across the whole grid"}
            >
              {m}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-slate-700" />
          {GREEKS.map(g => (
            <button
              key={g.key}
              data-testid={`thermal-greek-${g.key}`}
              aria-pressed={greek === g.key}
              onClick={() => setGreek(g.key)}
              className={`min-h-[44px] px-2 py-0.5 text-xs rounded font-mono uppercase tracking-wider transition text-foreground ${
                greek === g.key
                  ? "bg-primary/15 border border-primary"
                  : "border border-border"
              }`}
              title={g.desc}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div data-testid="thermal-heatmap-loading" className="text-slate-400 text-xs py-8 text-center">loading chain…</div>
      )}
      {error && (
        <div data-testid="thermal-heatmap-error" className="text-rose-300 text-xs py-4 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> heatmap unavailable — {String((error as Error).message)}
        </div>
      )}
      {data?.method && data.method.contractsNoSigma > 0 && canPlot && (
        <p role="status" className="mb-3 text-sm text-foreground" data-testid="thermal-partial-coverage">
          Partial exposure: {data.method.contractsNoSigma} contracts have no usable implied volatility and are excluded.
          Missing-only cells are omitted, not priced at zero. Totals cover priced contracts only.
        </p>
      )}
      {canPlot && data && grid && viewMode === "surface" && (
        <ThermalSurface data={data} greek={greek} />
      )}
      {canPlot && data && grid && viewMode === "3d" && (
        <Suspense fallback={<div className="py-8 text-center text-xs text-slate-400" data-testid="thermal-surface3d-loading">loading 3D view…</div>}>
          <ThermalSurface3D data={data} greek={greek} unit={GREEKS.find(g => g.key === greek)?.unit} />
        </Suspense>
      )}
      {canPlot && data && grid && viewMode === "grid" && (
        <div className="relative hscroll-contain rounded-md bg-slate-950">
          <canvas
            ref={canvasRef}
            onMouseMove={onMove}
            onClick={onMove}
            onMouseLeave={() => setHover(null)}
            data-testid="thermal-heatmap-canvas"
            role="img"
            aria-label={`${greek.toUpperCase()} exposure grid. Exact values are available in the data table below.`}
            className="cursor-crosshair"
          />
          {hover && (
            <div
              data-testid="thermal-heatmap-tooltip"
              className="absolute top-2 right-2 bg-slate-950/95 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-slate-200 pointer-events-none min-w-[180px]"
            >
              <div className="text-slate-400 text-[11px] mb-1">{hover.expiry} · {hover.dte}d</div>
              <div className="text-slate-100 font-semibold">strike {hover.strike}</div>
              <div className={`mt-1 ${hover.exposure >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {greek}: {fmtNum(hover.exposure)}
              </div>
              {colMax[hover.expIdx] > 0 && (
                <div className="text-[11px] text-slate-400">
                  {((Math.abs(hover.exposure) / colMax[hover.expIdx]) * 100).toFixed(0)}% of this date's max
                </div>
              )}
              <div className="text-[11px] text-slate-500 mt-1">OI c/{hover.callOI} p/{hover.putOI}</div>
              {(hover.callVolume != null || hover.putVolume != null) && (
                <div className="text-[11px] text-slate-500">traded today c/{hover.callVolume ?? 0} p/{hover.putVolume ?? 0} (not in exposure)</div>
              )}
            </div>
          )}
        </div>
      )}

      {data && data.dataState && data.dataState !== "ok" && (
        <div role="status" className="mt-2 flex items-center gap-2 text-sm text-foreground" data-testid="thermal-heatmap-state">
          <AlertTriangle className="w-3.5 h-3.5" />
          {data.dataState === "no_iv" ? "Exposure cannot be priced: " : "Nothing to show: "}{data.reason ?? data.dataState}
        </div>
      )}

      {canPlot && data && (
        <details className="mt-3 text-xs text-foreground" onToggle={e => setShowTable(e.currentTarget.open)} data-testid="thermal-data-table">
          <summary className="cursor-pointer min-h-[44px] py-3">Read exact {greek.toUpperCase()} values</summary>
          {showTable && <div className="max-h-80 overflow-auto">
            <table className="w-full text-left tabular-nums">
              <caption className="text-left pb-2">{GREEKS.find(g => g.key === greek)?.unit}. Signed model exposure, not observed dealer inventory.</caption>
              <thead><tr><th scope="col">Expiry</th><th scope="col">Strike</th><th scope="col">Exposure ($)</th><th scope="col">Call OI</th><th scope="col">Put OI</th></tr></thead>
              <tbody>{data.cells.map(c => <tr key={`${c.expIdx}-${c.strikeIdx}`} className="border-t border-border">
                <td className="py-2 pr-2">{c.expiry}</td><td className="pr-2">{c.strike}</td>
                <td className="pr-2">{c.exposure.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td className="pr-2">{c.callOI}</td><td>{c.putOI}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </details>
      )}

      {data && (
        <div className="mt-3 space-y-1.5 text-xs leading-relaxed font-mono text-muted-foreground" data-testid="thermal-heatmap-legend">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-500/70" /> positive {greek.toUpperCase()} exposure (model)</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-rose-500/70" /> negative {greek.toUpperCase()} exposure (model)</span>
              {greek === "gex" && data.levels.callWall && <span className="text-emerald-400">call wall {data.levels.callWall}</span>}
              {greek === "gex" && data.levels.putWall && <span className="text-rose-400">put wall {data.levels.putWall}</span>}
              {greek === "gex" && data.levels.gammaFlip != null && <span className="text-violet-300">flip {data.levels.gammaFlip.toFixed(0)}</span>}
            </div>
            <div className="flex items-center gap-2">
              {data.chain && data.chain.asOfMs != null ? (
                <DataStateChip state={data.chain.stale ? "stale" : "ok"} reason={data.chain.staleReason} asOf={data.chain.asOfMs} source="Schwab" showAge testId="thermal-chain-age" />
              ) : (
                <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> {new Date(data.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              )}
            </div>
          </div>
          <div data-testid="thermal-heatmap-method">
            {GREEKS.find((g) => g.key === greek)?.unit} · reported open interest, not intraday inventory, marked with the supplied spot and volatility
            {data.method ? ` · assumed r ${(data.method.r * 100).toFixed(1)}% q ${(data.method.q * 100).toFixed(1)}% · ${data.method.contractsUsed} contracts priced` : ""}
            {data.method && data.method.contractsNoSigma > 0 ? `, ${data.method.contractsNoSigma} without an implied vol` : ""}
          </div>
          <div>
            Dealer side is assumed (long every call, short every put), not observed. A heuristic read of positioning, not a forecast or advice.
          </div>
        </div>
      )}
    </div>
  );
}
