import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Flame, Activity, AlertTriangle } from "lucide-react";

type Cell = {
  expIdx: number; strikeIdx: number;
  expiry: string; dte: number; strike: number;
  exposure: number;
  gex: number; vanna: number; charm: number; vomma: number; zomma: number;
  callOI: number; putOI: number;
};
type ThermalResp = {
  symbol: string;
  asOf: number;
  spot: number;
  greek: "gex" | "vanna" | "charm" | "vomma" | "zomma";
  weightMode: string;
  strikes: number[];
  expiries: Array<{ label: string; dte: number }>;
  cells: Cell[];
  maxAbs: number;
  strikeTotals: Array<{ strike: number; total: number; totalAbs: number }>;
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null };
  source: string;
};

type Greek = "gex" | "vanna" | "charm" | "vomma" | "zomma";
const GREEKS: Array<{ key: Greek; label: string; desc: string }> = [
  { key: "gex", label: "GEX", desc: "Gamma exposure — dealer hedging flow" },
  { key: "vanna", label: "Vanna", desc: "Delta sensitivity to IV" },
  { key: "charm", label: "Charm", desc: "Delta decay over time" },
  { key: "vomma", label: "Vomma", desc: "Vega convexity" },
  { key: "zomma", label: "Zomma", desc: "Gamma sensitivity to IV" },
];

// Diverging color: positive = emerald (long gamma / support), negative = rose (short gamma / risk)
function colorFor(exposure: number, maxAbs: number): string {
  if (!maxAbs || Math.abs(exposure) < 1e-9) return "rgba(30,41,59,0.35)";
  const t = Math.min(1, Math.abs(exposure) / maxAbs);
  // log-scale intensity so mid values still show
  const intensity = Math.pow(t, 0.55);
  if (exposure >= 0) {
    // emerald hot
    return `rgba(16, 185, 129, ${0.15 + intensity * 0.85})`;
  } else {
    // rose hot
    return `rgba(244, 63, 94, ${0.15 + intensity * 0.85})`;
  }
}

function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(1);
}

export default function ThermalHeatmap() {
  const [greek, setGreek] = useState<Greek>("gex");
  const [symbol] = useState("$SPX");
  const [hover, setHover] = useState<Cell | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { data, isLoading, error } = useQuery<ThermalResp>({
    queryKey: ["/api/heatmap/thermal", symbol, greek],
    queryFn: async () => {
      // apiRequest, NOT raw fetch — raw fetch bypasses the deploy proxy and 404s on the hosted app
      const r = await apiRequest("GET", `/api/heatmap/thermal?symbol=${encodeURIComponent(symbol)}&greek=${greek}`);
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Layout constants
  const rowH = 14;
  const marginTop = 30;
  const marginLeft = 70;
  const marginRight = 90;
  const marginBottom = 26;

  const grid = useMemo(() => {
    if (!data) return null;
    const nStrikes = data.strikes.length;
    const nExps = data.expiries.length;
    if (!nStrikes || !nExps) return null;
    const height = marginTop + nStrikes * rowH + marginBottom;
    const cellW = 42;
    const width = marginLeft + nExps * cellW + marginRight;
    return { height, width, cellW, nStrikes, nExps };
  }, [data]);

  useEffect(() => {
    if (!data || !grid) return;
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

    // Cells
    for (const c of data.cells) {
      const x = marginLeft + c.expIdx * grid.cellW;
      // strikes are ascending low→high; flip so high strikes on top
      const yIdx = grid.nStrikes - 1 - c.strikeIdx;
      const y = marginTop + yIdx * rowH;
      ctx.fillStyle = colorFor(c.exposure, data.maxAbs);
      ctx.fillRect(x + 0.5, y + 0.5, grid.cellW - 1, rowH - 1);
    }

    // Spot line
    const spotIdx = data.strikes.findIndex(s => s >= data.spot);
    if (spotIdx >= 0) {
      const yIdx = grid.nStrikes - 1 - spotIdx;
      const y = marginTop + yIdx * rowH + rowH / 2;
      ctx.strokeStyle = "rgba(250, 204, 21, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(marginLeft + grid.nExps * grid.cellW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`spot ${data.spot.toFixed(0)}`, marginLeft + grid.nExps * grid.cellW + 4, y + 3);
    }

    // Gamma flip line (only for gex)
    if (greek === "gex" && data.levels.gammaFlip != null) {
      const flip = data.levels.gammaFlip;
      const flipIdx = data.strikes.findIndex(s => s >= flip);
      if (flipIdx >= 0) {
        const yIdx = grid.nStrikes - 1 - flipIdx;
        const y = marginTop + yIdx * rowH + rowH / 2;
        ctx.strokeStyle = "rgba(139, 92, 246, 0.8)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(marginLeft, y);
        ctx.lineTo(marginLeft + grid.nExps * grid.cellW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(139, 92, 246, 0.9)";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(`flip ${flip.toFixed(0)}`, marginLeft + grid.nExps * grid.cellW + 4, y + 3);
      }
    }

    // Strike labels (Y axis, every 4th)
    ctx.fillStyle = "rgba(148,163,184,0.75)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let i = 0; i < grid.nStrikes; i++) {
      if (i % 4 !== 0) continue;
      const strike = data.strikes[i];
      const yIdx = grid.nStrikes - 1 - i;
      const y = marginTop + yIdx * rowH + rowH / 2 + 3;
      ctx.fillText(String(strike), marginLeft - 6, y);
    }

    // Expiry labels (X axis, DTE)
    ctx.fillStyle = "rgba(148,163,184,0.75)";
    ctx.textAlign = "center";
    for (let j = 0; j < grid.nExps; j++) {
      const exp = data.expiries[j];
      const x = marginLeft + j * grid.cellW + grid.cellW / 2;
      ctx.fillText(`${exp.dte}d`, x, marginTop - 8);
    }

    // Title band
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${greek.toUpperCase()} · strike × expiry · weight ${data.weightMode}`, marginLeft, marginTop - 18);
  }, [data, grid, greek]);

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
    <div data-testid="thermal-heatmap" className="relative rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-amber-400" />
          <div className="text-slate-100 font-semibold text-sm tracking-wide">Thermal · dealer gamma map</div>
        </div>
        <div className="flex items-center gap-1" data-testid="thermal-greek-selector">
          {GREEKS.map(g => (
            <button
              key={g.key}
              data-testid={`thermal-greek-${g.key}`}
              onClick={() => setGreek(g.key)}
              className={`px-2 py-0.5 text-[10px] rounded font-mono uppercase tracking-wider transition ${
                greek === g.key
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-slate-400 hover:text-slate-200 border border-transparent"
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
      {data && grid && (
        <div className="relative overflow-x-auto">
          <canvas
            ref={canvasRef}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            data-testid="thermal-heatmap-canvas"
            className="cursor-crosshair"
          />
          {hover && (
            <div
              data-testid="thermal-heatmap-tooltip"
              className="absolute top-2 right-2 bg-slate-950/95 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-slate-200 pointer-events-none min-w-[180px]"
            >
              <div className="text-slate-400 text-[10px] mb-1">{hover.expiry} · {hover.dte}d</div>
              <div className="text-slate-100 font-semibold">strike {hover.strike}</div>
              <div className={`mt-1 ${hover.exposure >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {greek}: {fmtNum(hover.exposure)}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">OI c/{hover.callOI} p/{hover.putOI}</div>
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="mt-3 flex items-center justify-between text-[10px] font-mono text-slate-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-500/70" /> long gamma / support</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-rose-500/70" /> short gamma / risk</span>
            {greek === "gex" && data.levels.callWall && <span className="text-emerald-400">call wall {data.levels.callWall}</span>}
            {greek === "gex" && data.levels.putWall && <span className="text-rose-400">put wall {data.levels.putWall}</span>}
          </div>
          <div className="flex items-center gap-1">
            <Activity className="w-3 h-3" /> {new Date(data.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      )}
    </div>
  );
}
