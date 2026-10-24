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
  buildSurfaceModel, contourSegments, expiryFractions, expiryTickIndices, hasSides, layerValue, ribbonHeights, spikeRatio, strikeTickIndices,
  WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH,
  type Cell3D, type Data3D, type HeightScale, type Layer, type ScaleMode, type Spacing,
} from "@/lib/surface3dModel";
/** A side's exposure, or "unpriced" when it had open interest but no usable IV (unknown, not zero). */
const fmtSide = (v: number | null | undefined): string => (v == null ? "unpriced" : fmtCell(v));
/** Open interest per side; an unpriced side says so instead of reading as zero. */
const fmtOI = (c: Cell3D): string => {
  const side = (oi: number, un: number | undefined) => (oi === 0 && (un ?? 0) > 0 ? `${un} unpriced` : (un ?? 0) > 0 ? `${oi} +${un} unpriced` : String(oi));
  return `c/${side(c.callOI, c.callUnpricedOI)} p/${side(c.putOI, c.putUnpricedOI)}`;
};
/** True when some open interest in the cell could not be priced: its numbers cover the priced contracts only. */
const isPartial = (c: Cell3D): boolean => (c.callUnpricedOI ?? 0) + (c.putUnpricedOI ?? 0) > 0;

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

// ~35° elevation, slightly off-axis so ridges and troughs separate instead of foreshortening into one band.
const DEFAULT_CAM = new THREE.Vector3(3.5, 7.6, 10.4);
const VIEWS: Record<"reset" | "top" | "front" | "side", THREE.Vector3> = {
  reset: DEFAULT_CAM,
  top: new THREE.Vector3(0, 14, 0.01),
  // True side elevation: height reads straight against the axis ticks.
  front: new THREE.Vector3(0, 0.2, 13.5),
  side: new THREE.Vector3(13, 2.5, 0),
};
/**
 * Camera position along a preset direction so the drawn surface fits the
 * frame at this aspect: the surface's own vertices, the floor corners and
 * the sign labels' anchors are projected and the distance adjusted until
 * the farthest point sits inside 92% of the frame. Fitting a box or a
 * sphere left a side view a third of the frame on an ultrawide, because
 * the box's empty near-top corners sit close to the camera.
 */
function frameCamera(dir: THREE.Vector3, camera: THREE.PerspectiveCamera, pts: Float32Array, present: Uint8Array, yBox: { yMin: number; yMax: number }): { position: THREE.Vector3; target: THREE.Vector3 } {
  const hx = WORLD_WIDTH / 2, hz = WORLD_DEPTH / 2;
  const target = new THREE.Vector3(0, (Math.min(yBox.yMin, 0) + Math.max(yBox.yMax, 0)) / 2, 0);
  const anchors: THREE.Vector3[] = [];
  for (let k = 0; k < present.length; k++) if (present[k]) anchors.push(new THREE.Vector3(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]));
  for (const x of [-hx - 0.6, hx + 0.6]) for (const z of [-hz - 0.6, hz + 0.6]) anchors.push(new THREE.Vector3(x, 0, z));
  anchors.push(new THREE.Vector3(-hx - 0.55, Math.max(yBox.yMax, 0.6) + 0.4, -hz), new THREE.Vector3(-hx - 0.55, Math.min(yBox.yMin, -0.6) - 0.4, -hz));
  const probe = camera.clone();
  const d = dir.clone().normalize();
  let dist = Math.hypot(hx, WORLD_HEIGHT, hz) * 2;
  for (let it = 0; it < 5; it++) {
    probe.position.copy(target).add(d.clone().multiplyScalar(dist));
    probe.lookAt(target); probe.updateMatrixWorld(); probe.updateProjectionMatrix();
    let m = 0;
    for (const c of anchors) { const p = c.clone().project(probe); m = Math.max(m, Math.abs(p.x), Math.abs(p.y)); }
    if (!(m > 0)) break;
    dist *= m / 0.92;
  }
  return { position: target.clone().add(d.multiplyScalar(dist)), target };
}

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
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== "undefined" && !!(document.documentElement as any).requestFullscreen;
  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement && !!wrapRef.current?.contains(document.fullscreenElement);
      setFullscreen(on);
      // The host is sized by its ResizeObserver; in full screen it fills the box.
      const host = hostRef.current;
      if (host) host.style.height = on ? "calc(100vh - 56px)" : "";
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    const w = wrapRef.current; if (!w) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void (w as any).requestFullscreen?.().catch(() => {});
  };

  const sides = useMemo(() => hasSides(full), [full]);
  useEffect(() => { if (!sides && layer !== "net") setLayer("net"); }, [sides, layer]);
  const data = useMemo<Data3D>(() => (allStrikes ? full : (trimForSurface(full as any) as Data3D)), [full, allStrikes]);
  const trimmed = full.strikes.length - data.strikes.length;
  const model = useMemo(() => buildSurfaceModel(data, { layer, spacing, heightScale, scale: scaleMode }), [data, layer, spacing, heightScale, scaleMode]);
  useEffect(() => { setPicked(null); }, [full, greek, layer, allStrikes]);
  // Height range of the drawn surface, for framing the camera on the data rather than the full +-height.
  const yBox = useMemo(() => {
    let lo = 0, hi = 0;
    for (let k = 0; k < model.present.length; k++) if (model.present[k]) { const y = model.positions[k * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
    return { yMin: lo, yMax: hi };
  }, [model]);
  const yBoxRef = useRef(yBox); yBoxRef.current = yBox;
  const modelRef = useRef(model); modelRef.current = model;

  // Persistent renderer / camera / controls; scene content rebuilt per model.
  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer; labels: CSS2DRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
    controls: OrbitControls; content: THREE.Group; marker: THREE.Group; mesh: THREE.Mesh | null; render: (settle?: boolean) => void; fit: number;
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
    labels.domElement.style.top = "0"; labels.domElement.style.bottom = "0"; labels.domElement.style.left = "0";
    labels.domElement.style.pointerEvents = "none";
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x020617, 22, 48);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    camera.position.copy(DEFAULT_CAM);
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.35); key.position.set(5, 9, 4); scene.add(key);
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
      // Priority: level labels (spot, flip, walls), then axis names and the
      // sign labels, then the first and last tick of each axis (so an axis
      // always keeps its range), then the remaining ticks. A label is hidden
      // when it would come within GAP px of one already kept: touching
      // labels read as one word ("13d11d10d") even when their boxes do not
      // overlap, which is what a rotated expiry axis produced.
      const GAP = 6;
      const q = (sel: string): HTMLElement[] => Array.from((labels.domElement as HTMLElement).querySelectorAll<HTMLElement>(sel));
      const ticks = q(".s3d-tick");
      const ends = new Set<HTMLElement>();
      for (const cls of ["s3d-tick-x", "s3d-tick-z", "s3d-tick-y"]) {
        const grp = ticks.filter((t) => t.classList.contains(cls));
        if (grp.length) { ends.add(grp[0]); ends.add(grp[grp.length - 1]); }
      }
      // An axis seen nearly edge-on squeezes its ticks into a few pixels; only its ends then mean anything.
      const squeezed = new Set<HTMLElement>();
      for (const cls of ["s3d-tick-x", "s3d-tick-z"]) {
        const grp = ticks.filter((t) => t.classList.contains(cls) && t.style.display !== "none");
        if (grp.length < 3) continue;
        const cs = grp.map((t) => { const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
        const spread = Math.hypot(Math.max(...cs.map((c) => c[0])) - Math.min(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1])) - Math.min(...cs.map((c) => c[1])));
        if (spread < 18 * (grp.length - 1)) for (const t of grp) if (!ends.has(t)) squeezed.add(t);
      }
      const els = [...q(".s3d-level"), ...q(".s3d-axis"), ...ticks.filter((t) => ends.has(t)), ...ticks.filter((t) => !ends.has(t))];
      const boxes: DOMRect[] = [];
      for (const el of els) {
        el.style.visibility = "";
        if (el.style.display === "none") continue;
        if (squeezed.has(el)) { el.style.visibility = "hidden"; continue; }
        const r = el.getBoundingClientRect();
        if (boxes.some((b) => r.left < b.right + GAP && r.right > b.left - GAP && r.top < b.bottom + GAP && r.bottom > b.top - GAP)) el.style.visibility = "hidden";
        else boxes.push(r);
      }
    };
    // Declutter reads every label's box (a forced layout), so during an orbit
    // it runs at most ~12 times a second; the resting frame always gets one.
    let lastDeclutter = 0;
    const render = (settle = true) => {
      renderer.render(scene, camera); labels.render(scene, camera);
      const now = performance.now();
      if (settle || now - lastDeclutter > 80) { declutter(); lastDeclutter = now; }
    };
    const tick = () => {
      const moved = controls.update();
      const more = moved || interacting;
      render(!more);
      raf = more ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    controls.addEventListener("start", () => { interacting = true; kick(); });
    controls.addEventListener("end", () => { interacting = false; kick(); });
    controls.addEventListener("change", kick);

    let first = true;
    const resize = () => {
      // Ultrawide windows: cap the canvas width and centre it, so a flat
      // surface does not become a thin strip; full screen uses the whole box.
      const fs = !!document.fullscreenElement && wrapRef.current?.contains(document.fullscreenElement);
      const w = fs ? Math.max(240, host.clientWidth) : Math.max(240, Math.min(host.clientWidth, 1360));
      const h = fs ? Math.max(340, host.clientHeight) : Math.round(Math.min(720, Math.max(340, w * (w < 640 ? 0.98 : w < 1000 ? 0.6 : 0.52))));
      const ml = fs || host.clientWidth <= w ? 0 : Math.round((host.clientWidth - w) / 2);
      renderer.domElement.style.marginLeft = `${ml}px`;
      // The label layer must sit exactly over the canvas (labels are placed in canvas pixels).
      labels.domElement.style.left = `${ml}px`; labels.domElement.style.right = "auto"; labels.domElement.style.width = `${w}px`;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + "px";
      renderer.domElement.style.height = h + "px";
      labels.setSize(w, h);
      if (!fs) host.style.height = h + "px";
      camera.aspect = w / h;
      // Phones: pull back so the whole surface fits the narrower frustum.
      camera.fov = w < 640 ? 44 : 38;
      camera.updateProjectionMatrix();
      // Narrow, tall frames need more distance to fit the 10-unit-wide surface.
      const fit = w / h < 1.2 ? 1.28 : 1;
      if (ctxRef.current) ctxRef.current.fit = fit;
      if (first) { const m0 = modelRef.current; const f = frameCamera(DEFAULT_CAM, camera, m0.positions, m0.present, yBoxRef.current); camera.position.copy(f.position); controls.target.copy(f.target); controls.update(); first = false; }
      render();
    };
    // Setting the host's height inside its own ResizeObserver callback trips the
    // "loop completed with undelivered notifications" error; defer a frame.
    let resizeRaf = 0;
    const onResize = () => { if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; resize(); }); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    ro?.observe(host); if (!ro) window.addEventListener("resize", onResize);

    ctxRef.current = { renderer, labels, scene, camera, controls, content, marker, mesh: null, render, fit: 1 };
    resize();

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect(); if (!ro) window.removeEventListener("resize", onResize); if (resizeRaf) cancelAnimationFrame(resizeRaf);
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

    // $0 is a see-through divider, not a floor: drawn after the surface without
    // writing depth, so troughs below zero stay visible through it.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; floor.renderOrder = 2; content.add(floor);
    const zedge = new THREE.BufferGeometry(); zedge.setAttribute("position", new THREE.Float32BufferAttribute([-W / 2, 0, D / 2, W / 2, 0, D / 2, W / 2, 0, D / 2, W / 2, 0, -D / 2, W / 2, 0, -D / 2, -W / 2, 0, -D / 2, -W / 2, 0, -D / 2, -W / 2, 0, D / 2], 3));
    content.add(new THREE.LineSegments(zedge, new THREE.LineBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.55 })));
    // Back wall tinted by sign: green above zero, red below.
    for (const [y0, col] of [[H / 2, 0x10b981], [-H / 2, 0xf43f5e]] as const) {
      const band = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
      band.position.set(0, y0, -D / 2 - 0.002); content.add(band);
    }
    const grid: number[] = [];
    const sTicks = strikeTickIndices(nx, 9);
    const fr = expiryFractions(data.expiries, spacing);
    const eTicks = expiryTickIndices(fr);
    for (const i of sTicks) { const x = model.xOfIndex(i); grid.push(x, 0, D / 2, x, 0, -D / 2); }
    for (const j of eTicks) { const z = model.zOfExpiry(j); grid.push(-W / 2, 0, z, W / 2, 0, z); }
    // Back wall height grid.
    const hT = model.ticks;
    for (const v of hT) { const y = model.yOfValue(v); grid.push(-W / 2, y, -D / 2, W / 2, y, -D / 2); }
    grid.push(-W / 2, -H, -D / 2, -W / 2, H, -D / 2);
    const gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
    content.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.22 })));

    // Axis labels.
    for (const i of sTicks) { const l = label(String(data.strikes[i]), "s3d-tick s3d-tick-x"); l.position.set(model.xOfIndex(i), 0, D / 2 + 0.45); content.add(l); }
    for (const j of eTicks) {
      const e = data.expiries[j];
      const l = label(`${e.dte}d`, "s3d-tick s3d-tick-z"); l.position.set(W / 2 + 0.5, 0, model.zOfExpiry(j)); content.add(l);
    }
    for (const v of hT) { const l = label(v === 0 ? "$0" : fmtCell(v), "s3d-tick s3d-tick-y"); l.position.set(-W / 2 - 0.55, model.yOfValue(v), -D / 2); content.add(l); }
    const plusTxt = greek === "gex" ? "+ long gamma" : `+ positive ${greek}`;
    const minusTxt = greek === "gex" ? "\u2212 short gamma" : `\u2212 negative ${greek}`;
    const lp = label(plusTxt, "s3d-axis s3d-sign", "#34d399"); lp.position.set(-W / 2 - 0.55, H + 0.32, -D / 2); content.add(lp);
    const lm = label(minusTxt, "s3d-axis s3d-sign", "#fb7185"); lm.position.set(-W / 2 - 0.55, -H - 0.32, -D / 2); content.add(lm);
    // Contours at each non-zero height tick, drawn on the surface.
    for (const v of hT) {
      if (v === 0) continue;
      const seg = contourSegments(model, v);
      if (!seg.length) continue;
      const cg = new THREE.BufferGeometry(); cg.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
      content.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: v > 0 ? 0xa7f3d0 : 0xfecdd3, transparent: true, opacity: 0.75 })));
    }
    const ax = label("strikes, even spacing", "s3d-axis"); ax.position.set(0, 0, D / 2 + 1.05); content.add(ax);
    const az = label(spacing === "dte" ? "days to expiry (to scale)" : "expiry (even spacing)", "s3d-axis"); az.position.set(W / 2 + 0.6, 0, -D / 2 - 0.75); content.add(az);

    // Level markers: thin ribbons from the zero plane up (or down) to the
    // surface only, label at the top of the ribbon. Never full-height walls,
    // which read as exposure where there is none.
    const levels: Array<[keyof typeof LEVEL_STYLE, number | null]> = [
      ["spot", data.spot], ["flip", data.levels.gammaFlip], ["callWall", data.levels.callWall], ["putWall", data.levels.putWall],
    ];
    const used: number[] = [];
    for (const [k, lv] of levels) {
      const x = model.xOfLevel(lv);
      if (x == null || lv == null) continue;
      const st = LEVEL_STYLE[k];
      const hs = ribbonHeights(model, x);
      const tri: number[] = [], top: number[] = [], base: number[] = [];
      let peak = 0;
      for (let j = 0; j < hs.length - 1; j++) {
        const h0 = hs[j], h1 = hs[j + 1];
        if (h0 == null || h1 == null) continue;
        const z0 = model.zOfExpiry(j), z1 = model.zOfExpiry(j + 1);
        tri.push(x, 0, z0, x, h0, z0, x, 0, z1, x, h0, z0, x, h1, z1, x, 0, z1);
        top.push(x, h0, z0, x, h1, z1); base.push(x, 0.003, z0, x, 0.003, z1);
        peak = Math.max(peak, h0, h1);
      }
      if (tri.length) {
        const rg = new THREE.BufferGeometry(); rg.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
        const rib = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: st.color, transparent: true, opacity: k === "spot" ? 0.38 : 0.3, side: THREE.DoubleSide, depthWrite: false }));
        rib.renderOrder = 3; content.add(rib);
        const tg = new THREE.BufferGeometry(); tg.setAttribute("position", new THREE.Float32BufferAttribute(top, 3));
        content.add(new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: 0.95 })));
      }
      // Floor trace across the full depth so the strike is findable even where the surface is flat.
      const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute([x, 0.004, D / 2, x, 0.004, -D / 2], 3));
      const trace = new THREE.LineSegments(bg, new THREE.LineDashedMaterial({ color: st.color, transparent: true, opacity: 0.7, dashSize: 0.12, gapSize: 0.08 }));
      trace.computeLineDistances(); content.add(trace);
      const tier = used.filter((u) => Math.abs(u - x) < 2.6).length; used.push(x);
      const l = label(`${st.name} ${Math.abs(lv) >= 1000 ? lv.toFixed(0) : lv.toFixed(2)}`, "s3d-level", st.css);
      l.position.set(x, Math.max(0, peak) + 0.3 + tier * 0.42, D / 2); content.add(l);
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
    ctx.render(false);
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
      // Same cell as before: nothing to rebuild (the marker effect disposes and re-creates geometry).
      setPicked((prev) => (prev && cell && prev.cell === cell && prev.value === v ? prev : cell && v != null ? { cell, value: v } : null));
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
    const f = frameCamera(VIEWS[v], ctx.camera, model.positions, model.present, yBox);
    ctx.camera.position.copy(f.position); ctx.controls.target.copy(f.target); ctx.controls.update(); ctx.render();
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
    `min-h-[44px] min-w-[44px] rounded border px-2.5 py-1 font-mono text-xs uppercase tracking-wider text-foreground disabled:opacity-40 ${active ? "border-primary bg-primary/15" : "border-border"}`;
  const G = greek.toUpperCase();
  const pickMax = picked ? (model.split ? (picked.value >= 0 ? model.posMax : model.negMax) : model.scaleMax) : 0;
  const pct = picked && pickMax > 0 ? (100 * Math.abs(picked.value)) / pickMax : null;
  const scaleName = scaleMode === "shared" ? "shared" : scaleMode === "split" ? (picked && picked.value < 0 ? "below-zero" : "above-zero") : "layer";
  // One strike dominating the layer flattens everything else at linear height.
  const spike = useMemo(() => spikeRatio(model), [model]);
  const spiky = heightScale === "linear" && spike != null && spike > 12;

  return (
    <div ref={wrapRef} className={`relative ${fullscreen ? "overflow-auto bg-slate-950 p-2" : ""}`} data-testid="thermal-surface3d"
      tabIndex={0} aria-label="3D exposure surface: arrow keys rotate and zoom"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { rotate(-15); e.preventDefault(); }
        else if (e.key === "ArrowRight") { rotate(15); e.preventDefault(); }
        else if (e.key === "ArrowUp") { zoom(1 / 1.18); e.preventDefault(); }
        else if (e.key === "ArrowDown") { zoom(1.18); e.preventDefault(); }
        else if (e.key === "Escape" && fullscreen) { toggleFullscreen(); }
      }}>
      <style>{`
        .s3d-tick{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1;white-space:nowrap;text-shadow:0 1px 2px #020617}
        .s3d-tick-y{color:#94a3b8;transform:translateX(-50%)}
        .s3d-axis{font:11px ui-sans-serif,system-ui,sans-serif;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
        .s3d-axis.s3d-sign{font-weight:600;text-transform:none;letter-spacing:0}
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
          <button type="button" className={btn(scaleMode === "split")} aria-pressed={scaleMode === "split"} onClick={() => setScaleMode("split")} data-testid="surface3d-scale-split" title="Above and below zero each fit their own largest value, so one huge strike on one side does not flatten the other">split ±</button>
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
          {G} {layer} · {scaleMode === "shared" ? `shared scale ±${fmtCell(model.scaleMax).replace("+", "")}` : scaleMode === "split" ? `split scale ${fmtCell(model.posMax)} / ${fmtCell(-model.negMax)}` : `fit to layer ±${fmtCell(model.scaleMax).replace("+", "")}`} · {heightScale}
          <div className="mt-0.5" data-testid="surface3d-sign-key">
            <span className="text-emerald-400">▲ {greek === "gex" ? "+ long gamma" : "+ positive"}</span> above $0 · <span className="text-rose-400">▼ {greek === "gex" ? "\u2212 short gamma" : "\u2212 negative"}</span> below $0
          </div>
        </div>
        {picked && (
          <div className="pointer-events-none z-10 mt-0 hidden min-w-[190px] rounded border border-slate-700 bg-slate-950/95 px-3 py-2 font-mono text-xs text-slate-200 sm:absolute sm:right-2 sm:top-2 sm:block" data-testid="thermal-surface3d-readout">
            <div className="mb-1 text-[11px] text-slate-400">{picked.cell.expiry} · {picked.cell.dte}d</div>
            <div className="font-semibold text-slate-100">strike {picked.cell.strike}</div>
            <div className={`mt-1 ${picked.value >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{G} {layer}: {fmtCell(picked.value)}{isPartial(picked.cell) ? <span className="text-amber-300"> (partial: priced contracts only)</span> : null}</div>
            {sides && layer !== "net" && <div className="text-[11px] text-slate-400">net {fmtCell(picked.cell.exposure)}</div>}
            {sides && layer === "net" && <div className="text-[11px] text-slate-400">calls {fmtSide(picked.cell.callExposure)} · puts {fmtSide(picked.cell.putExposure)}</div>}
            <div className="text-[11px] text-slate-500">OI {fmtOI(picked.cell)}</div>
            {(picked.cell.callVolume != null || picked.cell.putVolume != null) && <div className="text-[11px] text-slate-500">traded today c/{picked.cell.callVolume ?? 0} p/{picked.cell.putVolume ?? 0}</div>}
            {pct != null && <div className="text-[11px] text-slate-500">{pct.toFixed(0)}% of the {scaleName} max</div>}
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
          {canFullscreen && (
            <button type="button" onClick={toggleFullscreen} data-testid="surface3d-fullscreen" aria-pressed={fullscreen}
              className="min-h-[44px] rounded border border-border px-2 font-mono text-[11px] uppercase text-foreground"
              title="Fill the screen; on a phone, turn it sideways for the widest view. Esc leaves.">{fullscreen ? "exit full screen" : "full screen"}</button>
          )}
        </div>
      </div>
      {spiky && (
        <p className="mt-2 text-[11px] text-amber-300/90" role="status" data-testid="surface3d-spike-hint">
          One strike is about {Math.round(spike!)}x the typical cell, so at linear height the rest of the surface is flat.{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => setHeightScale("compressed")}>Switch to compressed height</button> to see the shape (ticks still show the dollar values).
        </p>
      )}
      {picked && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 sm:hidden" data-testid="thermal-surface3d-readout-phone" role="status">
          <div className="text-[11px] text-slate-400">{picked.cell.expiry} · {picked.cell.dte}d · strike {picked.cell.strike}</div>
          <div className={picked.value >= 0 ? "text-emerald-300" : "text-rose-300"}>{G} {layer}: {fmtCell(picked.value)}{sides && layer === "net" ? ` (calls ${fmtSide(picked.cell.callExposure)} · puts ${fmtSide(picked.cell.putExposure)})` : ""}{isPartial(picked.cell) ? <span className="text-amber-300"> (partial: priced contracts only)</span> : null}</div>
          <div className="text-[11px] text-slate-500">OI {fmtOI(picked.cell)}{pct != null ? ` · ${pct.toFixed(0)}% of the ${scaleName} max` : ""}</div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground" data-testid="surface3d-legend">
        <span>{fmtCell(-model.negMax)}</span>
        <span aria-hidden className="h-2.5 w-40 rounded-sm" style={{ background: "linear-gradient(90deg,#f5405e,#33404f,#10d194)" }} />
        <span>{fmtCell(model.posMax)}</span>
        {unit && <span>· {unit}</span>}
        {Object.values(LEVEL_STYLE).map((s) => <span key={s.name} style={{ color: s.css }}>▍{s.name}</span>)}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="thermal-surface3d-explanation">
        Drag to rotate, pinch or scroll to zoom, two fingers or right-drag to pan; tap a point to read it. Height is signed {G} exposure, {scaleMode === "shared" ? "on one scale shared by the net, call and put layers" : scaleMode === "split" ? "with above-zero and below-zero heights on separate scales, so equal heights above and below are not equal dollars" : "scaled to this layer\u2019s largest value (choose shared to compare layers)"}.
        {greek === "gex" ? " Dealer long calls / short puts is an assumed convention, not observed inventory." : " The sign is not a long/short gamma classification."}
        {" "}Open interest is the prior close, not intraday positioning.
        {spacing === "dte" ? " Expiry depth is proportional to days to expiry." : " Expiries are evenly spaced, not proportional to time."}
        {model.holeCount > 0 ? ` ${model.holeCount} grid squares with an unobserved or unpriced corner are left open, not drawn as zero.` : ""}
        {trimmed > 0 ? ` ${trimmed} far strikes under 1% of the net maximum are hidden (the same strikes in every layer); choose "all" to show them.` : ""}
        {!sides ? " This server does not send the call/put split, so only the net layer is available." : ""}
      </p>
    </div>
  );
}
