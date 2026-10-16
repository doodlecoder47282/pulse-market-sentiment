// client/src/components/ThermalSurface3D.tsx
//
// True 3D (WebGL) view of the thermal exposure payload: drag to orbit,
// pinch/scroll to zoom, two-finger/right-drag to pan, perspective camera with
// lighting. Strikes across, expiries into depth (evenly or by DTE), signed
// dollar exposure as height on one scale shared by the net, call and put
// layers. Spot, gamma flip and call/put walls are vertical planes through the
// surface. Missing cells are holes, never zero. All geometry comes from the
// pure, tested module client/src/lib/surface3dModel.ts; this file only draws.
//
// Loaded lazily: three.js is fetched only when the 3D view is opened. When
// WebGL is unavailable the parent falls back to the projected canvas view.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { fmtCell, trimForSurface } from "@/lib/surfaceDraw";
import {
  buildSurfaceModel, expiryFractions, expiryTickIndices, hasSides, heightTicks, layerValue, strikeTickIndices,
  WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH,
  type Cell3D, type Data3D, type HeightScale, type Layer, type ScaleMode, type Spacing,
} from "@/lib/surface3dModel";

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

const LEVEL_STYLE = {
  spot: { color: 0xfacc15, css: "#facc15", name: "spot" },
  flip: { color: 0xa78bfa, css: "#a78bfa", name: "flip" },
  callWall: { color: 0x34d399, css: "#34d399", name: "call wall" },
  putWall: { color: 0xfb7185, css: "#fb7185", name: "put wall" },
} as const;

const DEFAULT_CAM = new THREE.Vector3(0, 6.2, 11.5);
const VIEWS: Record<"reset" | "top" | "front" | "side", THREE.Vector3> = {
  reset: DEFAULT_CAM,
  top: new THREE.Vector3(0, 14, 0.01),
  front: new THREE.Vector3(0, 1.2, 13),
  side: new THREE.Vector3(13, 2.5, 0),
};

function label(text: string, cls: string, color?: string): CSS2DObject {
  const el = document.createElement("div");
  el.textContent = text;
  el.className = cls;
  if (color) el.style.color = color;
  const o = new CSS2DObject(el);
  return o;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    if (o instanceof CSS2DObject) o.element.remove();
  });
  root.clear();
}

type Picked = { cell: Cell3D; value: number };

export default function ThermalSurface3D({ data: full, greek, unit }: { data: Data3D; greek: string; unit?: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<Layer>("net");
  const [spacing, setSpacing] = useState<Spacing>("even");
  const [heightScale, setHeightScale] = useState<HeightScale>("linear");
  const [allStrikes, setAllStrikes] = useState(false);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("layer");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const sides = useMemo(() => hasSides(full), [full]);
  useEffect(() => { if (!sides && layer !== "net") setLayer("net"); }, [sides, layer]);
  const data = useMemo<Data3D>(() => (allStrikes ? full : (trimForSurface(full as any) as Data3D)), [full, allStrikes]);
  const trimmed = full.strikes.length - data.strikes.length;
  const model = useMemo(() => buildSurfaceModel(data, { layer, spacing, heightScale, scale: scaleMode }), [data, layer, spacing, heightScale, scaleMode]);
  useEffect(() => { setPicked(null); }, [full, greek, layer, allStrikes]);

  // Persistent renderer / camera / controls; scene content rebuilt per model.
  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer; labels: CSS2DRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
    controls: OrbitControls; content: THREE.Group; marker: THREE.Group; mesh: THREE.Mesh | null; render: () => void; fit: number;
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch (e) {
      setFailed("WebGL could not start on this device.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x020617, 1);
    renderer.domElement.setAttribute("data-testid", "thermal-surface3d-canvas");
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const labels = new CSS2DRenderer();
    labels.domElement.style.position = "absolute";
    labels.domElement.style.inset = "0";
    labels.domElement.style.pointerEvents = "none";
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x020617, 22, 48);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    camera.position.copy(DEFAULT_CAM);
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.0); key.position.set(6, 10, 7); scene.add(key);
    const rim = new THREE.DirectionalLight(0x93c5fd, 0.45); rim.position.set(-8, 4, -6); scene.add(rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.2, 0);
    controls.enableDamping = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    controls.dampingFactor = 0.09;
    controls.minDistance = 4;
    controls.maxDistance = 32;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.screenSpacePanning = true;

    const content = new THREE.Group(); scene.add(content);
    const marker = new THREE.Group(); scene.add(marker);

    let raf = 0, interacting = false;
    // Hide tick labels that collide on screen (edge-on views foreshorten an axis).
    const declutter = () => {
      // Level labels first so a wall/spot label wins over a tick label.
      const els = [...Array.from(labels.domElement.querySelectorAll<HTMLElement>(".s3d-level")), ...Array.from(labels.domElement.querySelectorAll<HTMLElement>(".s3d-tick, .s3d-axis"))];
      const boxes: DOMRect[] = [];
      for (const el of els) {
        el.style.visibility = "";
        if (el.style.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (boxes.some((b) => r.left < b.right + 2 && r.right > b.left - 2 && r.top < b.bottom && r.bottom > b.top)) el.style.visibility = "hidden";
        else boxes.push(r);
      }
    };
    const render = () => { renderer.render(scene, camera); labels.render(scene, camera); declutter(); };
    const tick = () => {
      const moved = controls.update();
      render();
      raf = moved || interacting ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    controls.addEventListener("start", () => { interacting = true; kick(); });
    controls.addEventListener("end", () => { interacting = false; kick(); });
    controls.addEventListener("change", kick);

    let first = true;
    const resize = () => {
      const w = Math.max(240, host.clientWidth);
      const h = Math.round(Math.min(620, Math.max(340, w * (w < 640 ? 0.98 : 0.52))));
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + "px";
      renderer.domElement.style.height = h + "px";
      labels.setSize(w, h);
      host.style.height = h + "px";
      camera.aspect = w / h;
      // Phones: pull back so the whole surface fits the narrower frustum.
      camera.fov = w < 640 ? 44 : 38;
      camera.updateProjectionMatrix();
      // Narrow, tall frames need more distance to fit the 10-unit-wide surface.
      const fit = w / h < 1.2 ? 1.28 : 1;
      if (ctxRef.current) ctxRef.current.fit = fit;
      if (first) { camera.position.copy(DEFAULT_CAM).multiplyScalar(fit); controls.update(); first = false; }
      render();
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(host); if (!ro) window.addEventListener("resize", resize);

    ctxRef.current = { renderer, labels, scene, camera, controls, content, marker, mesh: null, render, fit: 1 };
    resize();

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect(); if (!ro) window.removeEventListener("resize", resize);
      controls.dispose();
      disposeTree(content); disposeTree(marker);
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
      labels.domElement.remove();
      ctxRef.current = null;
    };
  }, []);

  // Build the surface, grid, axes and level planes for the current model.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { content, render } = ctx;
    disposeTree(content);
    disposeTree(ctx.marker);
    const W = WORLD_WIDTH, D = WORLD_DEPTH, H = WORLD_HEIGHT;

    // Surface.
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(model.colors, 3));
    geom.setIndex(new THREE.BufferAttribute(model.indices, 1));
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
    mesh.name = "surface";
    content.add(mesh);
    ctx.mesh = mesh;

    // Wire mesh over observed edges: every expiry line, strike lines thinned.
    const wire: number[] = [];
    const P = model.positions, nx = model.nx, nz = model.nz, pr = model.present;
    const seg = (a: number, b: number) => { if (pr[a] && pr[b]) wire.push(P[a * 3], P[a * 3 + 1] + 0.004, P[a * 3 + 2], P[b * 3], P[b * 3 + 1] + 0.004, P[b * 3 + 2]); };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx - 1; i++) seg(j * nx + i, j * nx + i + 1);
    const strideI = Math.max(1, Math.round(nx / 28));
    for (let i = 0; i < nx; i += strideI) for (let j = 0; j < nz - 1; j++) seg(j * nx + i, (j + 1) * nx + i);
    const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.Float32BufferAttribute(wire, 3));
    content.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.07 })));

    // Zero plane with floor grid.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; content.add(floor);
    const grid: number[] = [];
    const sTicks = strikeTickIndices(nx, 9);
    const fr = expiryFractions(data.expiries, spacing);
    const eTicks = expiryTickIndices(fr);
    for (const i of sTicks) { const x = model.xOfIndex(i); grid.push(x, 0, D / 2, x, 0, -D / 2); }
    for (const j of eTicks) { const z = model.zOfExpiry(j); grid.push(-W / 2, 0, z, W / 2, 0, z); }
    // Back wall height grid.
    const hT = heightTicks(model.scaleMax);
    for (const v of hT) { const y = model.yOfValue(v); grid.push(-W / 2, y, -D / 2, W / 2, y, -D / 2); }
    grid.push(-W / 2, -H, -D / 2, -W / 2, H, -D / 2);
    const gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
    content.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.22 })));

    // Axis labels.
    for (const i of sTicks) { const l = label(String(data.strikes[i]), "s3d-tick"); l.position.set(model.xOfIndex(i), 0, D / 2 + 0.45); content.add(l); }
    for (const j of eTicks) {
      const e = data.expiries[j];
      const l = label(`${e.dte}d`, "s3d-tick"); l.position.set(W / 2 + 0.5, 0, model.zOfExpiry(j)); content.add(l);
    }
    for (const v of hT) { const l = label(v === 0 ? "$0" : fmtCell(v), "s3d-tick s3d-tick-y"); l.position.set(-W / 2 - 0.55, model.yOfValue(v), -D / 2); content.add(l); }
    const ax = label("strike", "s3d-axis"); ax.position.set(0, 0, D / 2 + 1.05); content.add(ax);
    const az = label(spacing === "dte" ? "days to expiry (to scale)" : "expiry (even spacing)", "s3d-axis"); az.position.set(W / 2 + 0.6, 0, -D / 2 - 0.75); content.add(az);

    // Level planes.
    const levels: Array<[keyof typeof LEVEL_STYLE, number | null]> = [
      ["spot", data.spot], ["flip", data.levels.gammaFlip], ["callWall", data.levels.callWall], ["putWall", data.levels.putWall],
    ];
    const used: number[] = [];
    for (const [k, lv] of levels) {
      const x = model.xOfLevel(lv);
      if (x == null || lv == null) continue;
      const st = LEVEL_STYLE[k];
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(D, 2 * H), new THREE.MeshBasicMaterial({ color: st.color, transparent: true, opacity: k === "spot" ? 0.13 : 0.09, side: THREE.DoubleSide, depthWrite: false }));
      plane.rotation.y = Math.PI / 2; plane.position.set(x, 0, 0); content.add(plane);
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.Float32BufferAttribute([x, H, D / 2, x, H, -D / 2, x, 0, D / 2, x, 0, -D / 2, x, -H, D / 2, x, H, D / 2], 3));
      content.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: 0.75 })));
      // Stagger labels whose planes sit close together.
      const tier = used.filter((u) => Math.abs(u - x) < 2.6).length; used.push(x);
      const l = label(`${st.name} ${Math.abs(lv) >= 1000 ? lv.toFixed(0) : lv.toFixed(2)}`, "s3d-level", st.css); l.position.set(x, H + 0.25 + tier * 0.45, D / 2); content.add(l);
    }
    ctx.renderer.domElement.setAttribute("aria-label", `${greek.toUpperCase()} ${layer} exposure, 3D surface by strike and expiry. Exact values are in the data table below.`);
    render();
  }, [model, data, spacing, greek, layer]);

  // Selection marker.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    disposeTree(ctx.marker);
    if (picked) {
      const i = picked.cell.strikeIdx, j = picked.cell.expIdx;
      const x = model.xOfIndex(i), z = model.zOfExpiry(j), y = model.yOfValue(picked.value);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.085, 18, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.position.set(x, y, z); ctx.marker.add(dot);
      const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute([x, 0, z, x, y, z, x, 0, WORLD_DEPTH / 2, x, 0, -WORLD_DEPTH / 2, -WORLD_WIDTH / 2, 0, z, WORLD_WIDTH / 2, 0, z], 3));
      ctx.marker.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })));
    }
    ctx.render();
  }, [picked, model]);

  // Picking: hover on desktop, tap (not drag) on touch.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const el = ctx.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    let hoverRaf = 0;
    const pickAt = (cx: number, cy: number) => {
      const c = ctxRef.current;
      if (!c?.mesh) return;
      const r = el.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, c.camera);
      const hit = ray.intersectObject(c.mesh, false)[0];
      if (!hit?.face) { setPicked(null); return; }
      const pos = c.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      let best = -1, bestD = Infinity;
      for (const k of [hit.face.a, hit.face.b, hit.face.c]) {
        const d = hit.point.distanceToSquared(new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k)));
        if (d < bestD) { bestD = d; best = k; }
      }
      const cell = model.cellAtVertex(best);
      const v = cell ? layerValue(cell, layer) : null;
      setPicked(cell && v != null ? { cell, value: v } : null);
    };
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) pickAt(e.clientX, e.clientY);
      down = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons) return;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; pickAt(e.clientX, e.clientY); });
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    return () => {
      cancelAnimationFrame(hoverRaf);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
    };
  }, [model, layer]);

  const goView = (v: keyof typeof VIEWS) => {
    const ctx = ctxRef.current; if (!ctx) return;
    ctx.camera.position.copy(VIEWS[v]).multiplyScalar(ctx.fit); ctx.controls.target.set(0, 0.2, 0); ctx.controls.update(); ctx.render();
  };
  const zoom = (f: number) => {
    const ctx = ctxRef.current; if (!ctx) return;
    const { camera, controls } = ctx;
    const off = camera.position.clone().sub(controls.target);
    const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * f));
    camera.position.copy(controls.target).add(off.setLength(len)); controls.update(); ctx.render();
  };
  const rotate = (deg: number) => {
    const ctx = ctxRef.current; if (!ctx) return;
    const { camera, controls } = ctx;
    const off = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    camera.position.copy(controls.target).add(off); controls.update(); ctx.render();
  };

  if (failed) {
    return <p role="status" className="text-sm text-foreground" data-testid="thermal-surface3d-failed">{failed} Use the 2.5D view instead.</p>;
  }

  const btn = (active: boolean) =>
    `min-h-[44px] rounded border px-2.5 py-1 font-mono text-xs uppercase tracking-wider text-foreground disabled:opacity-40 ${active ? "border-primary bg-primary/15" : "border-border"}`;
  const G = greek.toUpperCase();
  const pct = picked && model.scaleMax > 0 ? (100 * Math.abs(picked.value)) / model.scaleMax : null;

  return (
    <div ref={wrapRef} className="relative" data-testid="thermal-surface3d">
      <style>{`
        .s3d-tick{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1;white-space:nowrap;text-shadow:0 1px 2px #020617}
        .s3d-tick-y{color:#94a3b8;transform:translateX(-50%)}
        .s3d-axis{font:11px ui-sans-serif,system-ui,sans-serif;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
        .s3d-level{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;padding:1px 4px;border-radius:3px;background:rgba(2,6,23,.75)}
      `}</style>

      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="layer">
          <span className="mr-1">layer</span>
          {(["net", "call", "put"] as const).map((l) => (
            <button key={l} type="button" className={btn(layer === l)} aria-pressed={layer === l} disabled={l !== "net" && !sides}
              onClick={() => setLayer(l)} data-testid={`surface3d-layer-${l}`}
              title={l === "net" ? "Calls plus puts" : !sides ? "This server does not send the call/put split" : l === "call" ? "Call contracts only (dealer sign +)" : "Put contracts only (dealer sign -)"}>
              {l === "net" ? "net" : l === "call" ? "calls" : "puts"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="expiry spacing">
          <span className="mr-1">expiry</span>
          {(["even", "dte"] as const).map((s) => (
            <button key={s} type="button" className={btn(spacing === s)} aria-pressed={spacing === s} onClick={() => setSpacing(s)} data-testid={`surface3d-spacing-${s}`}
              title={s === "even" ? "Equal spacing per expiry" : "Depth proportional to days to expiry"}>
              {s === "even" ? "even" : "by DTE"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="height scale">
          <span className="mr-1">height</span>
          {(["linear", "compressed"] as const).map((h) => (
            <button key={h} type="button" className={btn(heightScale === h)} aria-pressed={heightScale === h} onClick={() => setHeightScale(h)} data-testid={`surface3d-height-${h}`}>{h}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="scale">
          <span className="mr-1">scale</span>
          <button type="button" className={btn(scaleMode === "layer")} aria-pressed={scaleMode === "layer"} onClick={() => setScaleMode("layer")} data-testid="surface3d-scale-layer" title="Fit the height to this layer's largest value">fit layer</button>
          <button type="button" className={btn(scaleMode === "shared")} aria-pressed={scaleMode === "shared"} onClick={() => setScaleMode("shared")} disabled={!sides} data-testid="surface3d-scale-shared" title="One scale across net, calls and puts so heights compare between layers">shared</button>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="strikes">
          <span className="mr-1">strikes</span>
          <button type="button" className={btn(!allStrikes)} aria-pressed={!allStrikes} onClick={() => setAllStrikes(false)} data-testid="surface3d-strikes-focus">focused</button>
          <button type="button" className={btn(allStrikes)} aria-pressed={allStrikes} onClick={() => setAllStrikes(true)} data-testid="surface3d-strikes-all">all {full.strikes.length}</button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-md border border-border bg-slate-950">
        <div ref={hostRef} className="relative w-full touch-none select-none" data-testid="thermal-surface3d-host" />
        <div className="pointer-events-none absolute left-2 top-2 font-mono text-[11px] text-slate-400" data-testid="surface3d-caption">
          {G} {layer} · {scaleMode === "shared" ? "shared scale" : "fit to layer"} ±{fmtCell(model.scaleMax).replace("+", "")} · {heightScale}
        </div>
        {picked && (
          <div className="pointer-events-none z-10 mt-0 hidden min-w-[190px] rounded border border-slate-700 bg-slate-950/95 px-3 py-2 font-mono text-xs text-slate-200 sm:absolute sm:right-2 sm:top-2 sm:block" data-testid="thermal-surface3d-readout">
            <div className="mb-1 text-[11px] text-slate-400">{picked.cell.expiry} · {picked.cell.dte}d</div>
            <div className="font-semibold text-slate-100">strike {picked.cell.strike}</div>
            <div className={`mt-1 ${picked.value >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{G} {layer}: {fmtCell(picked.value)}</div>
            {sides && layer !== "net" && <div className="text-[11px] text-slate-400">net {fmtCell(picked.cell.exposure)}</div>}
            {sides && layer === "net" && <div className="text-[11px] text-slate-400">calls {fmtCell(picked.cell.callExposure!)} · puts {fmtCell(picked.cell.putExposure!)}</div>}
            <div className="text-[11px] text-slate-500">OI c/{picked.cell.callOI} p/{picked.cell.putOI}</div>
            {(picked.cell.callVolume != null || picked.cell.putVolume != null) && <div className="text-[11px] text-slate-500">traded today c/{picked.cell.callVolume ?? 0} p/{picked.cell.putVolume ?? 0}</div>}
            {pct != null && <div className="text-[11px] text-slate-500">{pct.toFixed(0)}% of the {scaleMode === "shared" ? "shared" : "layer"} max</div>}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="camera">
          {([["reset", "reset"], ["top", "top"], ["front", "front"], ["side", "side"]] as const).map(([k, t]) => (
            <button key={k} type="button" onClick={() => goView(k)} data-testid={`surface3d-view-${k}`}
              className="min-h-[44px] min-w-[44px] rounded border border-border px-2 font-mono text-[11px] uppercase text-foreground">{t}</button>
          ))}
        </div>
        <div className="flex gap-1" role="group" aria-label="rotate and zoom">
          {([["rotate left", "⟲", () => rotate(-15)], ["rotate right", "⟳", () => rotate(15)], ["zoom out", "−", () => zoom(1.18)], ["zoom in", "+", () => zoom(1 / 1.18)]] as const).map(([a, t, fn]) => (
            <button key={a} type="button" aria-label={a} onClick={fn} data-testid={`surface3d-${a.replace(" ", "-")}`}
              className="min-h-[44px] min-w-[44px] rounded border border-border font-mono text-base text-foreground">{t}</button>
          ))}
        </div>
      </div>
      {picked && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 sm:hidden" data-testid="thermal-surface3d-readout-phone" role="status">
          <div className="text-[11px] text-slate-400">{picked.cell.expiry} · {picked.cell.dte}d · strike {picked.cell.strike}</div>
          <div className={picked.value >= 0 ? "text-emerald-300" : "text-rose-300"}>{G} {layer}: {fmtCell(picked.value)}{sides && layer === "net" ? ` (calls ${fmtCell(picked.cell.callExposure!)} · puts ${fmtCell(picked.cell.putExposure!)})` : ""}</div>
          <div className="text-[11px] text-slate-500">OI c/{picked.cell.callOI} p/{picked.cell.putOI}{pct != null ? ` · ${pct.toFixed(0)}% of the ${scaleMode === "shared" ? "shared" : "layer"} max` : ""}</div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground" data-testid="surface3d-legend">
        <span>{fmtCell(-model.scaleMax)}</span>
        <span aria-hidden className="h-2.5 w-40 rounded-sm" style={{ background: "linear-gradient(90deg,#f5405e,#33404f,#10d194)" }} />
        <span>{fmtCell(model.scaleMax)}</span>
        {unit && <span>· {unit}</span>}
        {Object.values(LEVEL_STYLE).map((s) => <span key={s.name} style={{ color: s.css }}>▍{s.name}</span>)}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="thermal-surface3d-explanation">
        Drag to rotate, pinch or scroll to zoom, two fingers or right-drag to pan; tap a point to read it. Height is signed {G} exposure, {scaleMode === "shared" ? "on one scale shared by the net, call and put layers" : "scaled to this layer\u2019s largest value (choose shared to compare layers)"}.
        {greek === "gex" ? " Dealer long calls / short puts is an assumed convention, not observed inventory." : " The sign is not a long/short gamma classification."}
        {" "}Open interest is the prior close, not intraday positioning.
        {spacing === "dte" ? " Expiry depth is proportional to days to expiry." : " Expiries are evenly spaced, not proportional to time."}
        {model.holeCount > 0 ? ` ${model.holeCount} grid squares with an unobserved or unpriced corner are left open, not drawn as zero.` : ""}
        {trimmed > 0 ? ` ${trimmed} far strikes under 1% of the maximum are hidden; choose "all" to show them.` : ""}
        {!sides ? " This server does not send the call/put split, so only the net layer is available." : ""}
      </p>
    </div>
  );
}
