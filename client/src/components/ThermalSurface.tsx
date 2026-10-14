// client/src/components/ThermalSurface.tsx
//
// 3D surface view of the same thermal payload the grid draws: strikes along
// one axis, expiries into the depth, signed dollar exposure as height. One
// global scale (a surface with per-date scaling would misstate relative
// size), linear height by default with a labelled compressed option, yaw and
// pitch controls, tap or hover to read a node, spot and flip drawn as lines
// across the surface, walls marked at their strike. Canvas 2D with an
// orthographic projection (shared/surfaceProjection.ts); no WebGL, so it
// renders on every device the grid does and resizes with its container.

import { useEffect, useMemo, useRef, useState } from "react";
import { pickNode, makeProjector, rowOfLevel, COMPRESS_POWER, type SurfaceNode, type SurfaceView } from "@shared/surfaceProjection";
import { drawSurface, fmtCell, nodesOf, cellMap, trimForSurface, type SurfaceCell, type SurfaceData } from "@/lib/surfaceDraw";
export type { SurfaceCell, SurfaceData } from "@/lib/surfaceDraw";

export default function ThermalSurface({ data: full, greek }: { data: SurfaceData; greek: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const [yaw, setYaw] = useState(25);
  const [pitch, setPitch] = useState(42);
  const data = useMemo(() => trimForSurface(full), [full]);
  const [scale, setScale] = useState<"linear" | "compressed">("linear");
  const [picked, setPicked] = useState<SurfaceCell | null>(null);
  const scrolledRef = useRef(false);

  // Width follows the container; height keeps a readable aspect on phones.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    apply();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", apply); return () => window.removeEventListener("resize", apply); }
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = useMemo<SurfaceNode[]>(() => nodesOf(data), [data]);
  const cellAt = useMemo(() => cellMap(data), [data]);

  const view = useMemo<SurfaceView | null>(() => {
    if (!width || !data.strikes.length || !data.expiries.length) return null;
    // At least 5 px per strike: on a phone the canvas is wider than the
    // container and scrolls sideways, like the grid, instead of shrinking
    // 120 strikes into 300 px.
    const canvasWidth = Math.max(width, Math.round(data.strikes.length * 5 + 56));
    const height = Math.round(Math.min(640, Math.max(280, canvasWidth * 0.56)));
    return {
      width: canvasWidth, height, yawDeg: yaw, pitchDeg: pitch,
      nStrikes: data.strikes.length, nExpiries: data.expiries.length,
      maxAbs: data.maxAbs, heightScale: scale, heightPx: Math.round(Math.min(150, Math.max(40, height * 0.2))), padding: 28,
    };
  }, [width, yaw, pitch, scale, data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = view.width * dpr;
    canvas.height = view.height * dpr;
    canvas.style.width = view.width + "px";
    canvas.style.height = view.height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSurface(ctx, data, view, greek, picked);
    // On a narrow screen the canvas is wider than its scroller: start with spot in view.
    const scroller = canvas.parentElement;
    if (scroller && view.width > scroller.clientWidth + 8 && !scrolledRef.current) {
      const row = rowOfLevel(data.strikes, data.spot);
      if (row != null) {
        const p = makeProjector(view).project(row, 0, 0);
        scroller.scrollLeft = Math.max(0, Math.round(p.x - scroller.clientWidth / 2));
        scrolledRef.current = true;
      }
    }
  }, [view, data, greek, picked]);

  function onPointer(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (!view) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const n = pickNode(nodes, view, ev.clientX - rect.left, ev.clientY - rect.top, 16);
    setPicked(n ? cellAt.get(`${n.i},${n.j}`) ?? null : null);
  }

  return (
    <div ref={wrapRef} className="relative" data-testid="thermal-surface">
      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-[11px] text-slate-400">rotate <span className="font-mono text-slate-200">{yaw}°</span>
          <input type="range" min={0} max={85} step={1} value={yaw} onChange={(e) => setYaw(Number(e.target.value))} className="mt-0.5 h-11 w-full lg:h-6" aria-label="rotate the surface" data-testid="surface-yaw" />
        </label>
        <label className="text-[11px] text-slate-400">tilt <span className="font-mono text-slate-200">{pitch}°</span>
          <input type="range" min={15} max={75} step={1} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} className="mt-0.5 h-11 w-full lg:h-6" aria-label="tilt the camera" data-testid="surface-pitch" />
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
          height
          {(["linear", "compressed"] as const).map((m) => (
            <button key={m} onClick={() => setScale(m)} data-testid={`surface-scale-${m}`}
              className={`rounded border px-2 py-0.5 font-mono uppercase tracking-wider ${scale === m ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-300" : "border-transparent text-slate-400 hover:text-slate-200"}`}
              title={m === "linear" ? "height proportional to dollars" : `height = sign · |value / max|^${COMPRESS_POWER}: mid values visible, labelled as compressed`}>
              {m}
            </button>
          ))}
        </div>
      </div>
      {view && (
        <div className="relative hscroll-contain">
          <canvas ref={canvasRef} onMouseMove={onPointer} onClick={onPointer} onMouseLeave={() => setPicked(null)} className="cursor-crosshair" data-testid="thermal-surface-canvas" />
        </div>
      )}
      {picked && (
        <div className="absolute right-2 top-16 min-w-[170px] rounded border border-slate-700 bg-slate-950/95 px-3 py-2 font-mono text-xs text-slate-200 pointer-events-none" data-testid="thermal-surface-tooltip">
          <div className="mb-1 text-[11px] text-slate-400">{picked.expiry} · {picked.dte}d</div>
          <div className="font-semibold text-slate-100">strike {picked.strike}</div>
          <div className={`mt-1 ${picked.exposure >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{greek}: {fmtCell(picked.exposure)}</div>
          <div className="text-[11px] text-slate-500">OI c/{picked.callOI} p/{picked.putOI}</div>
          <div className="text-[11px] text-slate-500">{(100 * Math.abs(picked.exposure) / Math.max(1, data.maxAbs)).toFixed(0)}% of the surface max</div>
        </div>
      )}
      <p className="mt-1 text-[11px] text-slate-500">Tap a point to read it. Green up = dealers long gamma at that strike and date; red down = short. Same numbers as the grid on one scale across every date{data.strikes.length < full.strikes.length ? `; ${full.strikes.length - data.strikes.length} flat far strikes (under 1% of the max) trimmed from the footprint` : ""}.</p>
    </div>
  );
}
