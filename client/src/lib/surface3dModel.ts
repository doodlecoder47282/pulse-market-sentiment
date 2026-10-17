// client/src/lib/surface3dModel.ts
//
// Pure geometry for the WebGL exposure surface (ThermalSurface3D.tsx). No
// three.js import, so every dollar-to-position mapping is unit-tested on plain
// Node (tests/quant/surface3d-model.test.ts).
//
// World frame: X across strikes (low strike left), Z across expiries (nearest
// expiry at the front, +Z toward the default camera), Y up = signed exposure.
// Missing cells are holes: a quad is drawn only when all four corners were
// observed, so an unpriced contract is never shown as a zero-height point.

import { heightFraction, rowOfLevel } from "@shared/surfaceProjection";
import type { SurfaceCell, SurfaceData } from "@/lib/surfaceDraw";

export type Layer = "net" | "call" | "put";
export type Spacing = "even" | "dte";
export type HeightScale = "linear" | "compressed";

export type Cell3D = SurfaceCell & { callExposure?: number | null; putExposure?: number | null; callUnpricedOI?: number; putUnpricedOI?: number; callVolume?: number; putVolume?: number };
export type Data3D = Omit<SurfaceData, "cells"> & { cells: Cell3D[] };

export const WORLD_WIDTH = 10;
export const WORLD_DEPTH = 6;
export const WORLD_HEIGHT = 2.6;

/** True when the server sent the per-side split (older servers send net only). A side is
 *  null where it had open interest but no usable IV: unknown, drawn as a hole in that layer. */
export function hasSides(data: Data3D): boolean {
  return data.cells.length > 0 && data.cells.every((c) => c.callExposure !== undefined && c.putExposure !== undefined
    && (c.callExposure === null || Number.isFinite(c.callExposure)) && (c.putExposure === null || Number.isFinite(c.putExposure)));
}

export function layerValue(c: Cell3D, layer: Layer): number | null {
  if (layer === "net") return Number.isFinite(c.exposure) ? c.exposure : null;
  const v = layer === "call" ? c.callExposure : c.putExposure;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One height scale shared by the net, call and put layers so switching layers
 * keeps heights comparable: the largest |value| over every layer available.
 */
export function sharedScaleMax(data: Data3D): number {
  const sides = hasSides(data);
  let m = 0;
  for (const c of data.cells) {
    m = Math.max(m, Math.abs(c.exposure || 0));
    if (sides) m = Math.max(m, Math.abs(c.callExposure ?? 0), Math.abs(c.putExposure ?? 0));
  }
  return m;
}

/** Largest |value| in one layer only (fills the height for that layer). */
export function layerScaleMax(data: Data3D, layer: Layer): number {
  let m = 0;
  for (const c of data.cells) { const v = layerValue(c, layer); if (v != null) m = Math.max(m, Math.abs(v)); }
  return m;
}

/** layer: fit this layer; shared: one scale over net/call/put; split: above and below zero each fit their own largest value. */
export type ScaleMode = "layer" | "shared" | "split";

/** Largest positive and largest |negative| value in one layer. */
export function sideMaxima(data: Data3D, layer: Layer): { pos: number; neg: number } {
  let pos = 0, neg = 0;
  for (const c of data.cells) { const v = layerValue(c, layer); if (v == null) continue; if (v > 0) pos = Math.max(pos, v); else neg = Math.max(neg, -v); }
  return { pos, neg };
}

export interface SurfaceModel {
  nx: number; // strikes
  nz: number; // expiries
  scaleMax: number;
  /** Dollar value at full height above / below zero (equal to scaleMax unless split). */
  posMax: number;
  negMax: number;
  split: boolean;
  /** Height-axis tick values in dollars, low to high. */
  ticks: number[];
  /** xyz per vertex, vertex k = j * nx + i (j expiry, i strike). */
  positions: Float32Array;
  /** rgb per vertex in 0..1. */
  colors: Float32Array;
  present: Uint8Array;
  /** Triangle indices over quads whose four corners are present. */
  indices: Uint32Array;
  values: Float64Array;
  quadCount: number;
  holeCount: number;
  xOfIndex: (i: number) => number;
  zOfExpiry: (j: number) => number;
  yOfValue: (v: number) => number;
  /** X of a price level (spot, flip, wall) or null when outside the strikes drawn. */
  xOfLevel: (level: number | null | undefined) => number | null;
  cellAtVertex: (k: number) => Cell3D | null;
}

export function expiryFractions(expiries: Array<{ dte: number }>, spacing: Spacing): number[] {
  const n = expiries.length;
  if (n <= 1) return expiries.map(() => 0);
  const even = expiries.map((_, j) => j / (n - 1));
  if (spacing === "even") return even;
  const d = expiries.map((e) => e.dte);
  const lo = Math.min(...d), hi = Math.max(...d);
  if (!(hi > lo) || d.some((x) => !Number.isFinite(x))) return even;
  return d.map((x) => (x - lo) / (hi - lo));
}

/** Diverging colour: positive teal-green, negative rose, near zero slate. Intensity follows |t|^0.55 for visibility only; height stays exact. */
export function divergingColor(value: number, scaleMax: number): [number, number, number] {
  const base: [number, number, number] = [0.13, 0.16, 0.22];
  if (!(scaleMax > 0) || !Number.isFinite(value) || value === 0) return base;
  const k = Math.pow(Math.min(1, Math.abs(value) / scaleMax), 0.55);
  const tgt: [number, number, number] = value > 0 ? [0.06, 0.82, 0.58] : [0.96, 0.25, 0.37];
  return [base[0] + (tgt[0] - base[0]) * k, base[1] + (tgt[1] - base[1]) * k, base[2] + (tgt[2] - base[2]) * k];
}

export function buildSurfaceModel(data: Data3D, opts: { layer: Layer; spacing: Spacing; heightScale: HeightScale; scale?: ScaleMode }): SurfaceModel {
  const nx = data.strikes.length, nz = data.expiries.length;
  // Shared: one scale over net, call and put so layers compare. Layer (default): fit this layer.
  const mode = opts.scale ?? "layer";
  const scaleMax = mode === "shared" ? sharedScaleMax(data) : layerScaleMax(data, opts.layer);
  const split = mode === "split";
  const sm = split ? sideMaxima(data, opts.layer) : { pos: scaleMax, neg: scaleMax };
  const posMax = sm.pos, negMax = sm.neg;
  const sideMax = (v: number) => (v >= 0 ? posMax : negMax);
  const fr = expiryFractions(data.expiries, opts.spacing);
  const xOfIndex = (i: number) => (nx <= 1 ? 0 : -WORLD_WIDTH / 2 + (i / (nx - 1)) * WORLD_WIDTH);
  const zOfExpiry = (j: number) => WORLD_DEPTH / 2 - (fr[j] ?? 0) * WORLD_DEPTH;
  const yOfValue = (v: number) => { const m = sideMax(v); return m > 0 ? heightFraction(v, m, opts.heightScale) * WORLD_HEIGHT : 0; };

  const count = nx * nz;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const present = new Uint8Array(count);
  const values = new Float64Array(count);
  const cellByK: Array<Cell3D | null> = new Array(count).fill(null);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    positions[k * 3] = xOfIndex(i); positions[k * 3 + 1] = 0; positions[k * 3 + 2] = zOfExpiry(j);
    const [r, g, b] = divergingColor(0, scaleMax);
    colors[k * 3] = r; colors[k * 3 + 1] = g; colors[k * 3 + 2] = b;
  }
  for (const c of data.cells) {
    if (c.strikeIdx < 0 || c.strikeIdx >= nx || c.expIdx < 0 || c.expIdx >= nz) continue;
    const v = layerValue(c, opts.layer);
    if (v == null) continue;
    const k = c.expIdx * nx + c.strikeIdx;
    present[k] = 1; values[k] = v; cellByK[k] = c;
    positions[k * 3 + 1] = yOfValue(v);
    const [r, g, b] = divergingColor(v, sideMax(v));
    colors[k * 3] = r; colors[k * 3 + 1] = g; colors[k * 3 + 2] = b;
  }
  const idx: number[] = [];
  let quadCount = 0, holeCount = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    if (present[a] && present[b] && present[c] && present[d]) { idx.push(a, c, b, b, c, d); quadCount++; } else holeCount++;
  }
  return {
    nx, nz, scaleMax, posMax, negMax, split,
    ticks: split ? splitTicks(posMax, negMax) : heightTicks(scaleMax),
    positions, colors, present, values,
    indices: Uint32Array.from(idx), quadCount, holeCount,
    xOfIndex, zOfExpiry, yOfValue,
    xOfLevel: (level) => {
      if (level == null) return null;
      const row = rowOfLevel(data.strikes, level);
      return row == null ? null : xOfIndex(row);
    },
    cellAtVertex: (k) => (k >= 0 && k < count ? cellByK[k] : null),
  };
}

/** Evenly spaced strike tick indices, always including both ends, at most `max`. */
export function strikeTickIndices(n: number, max = 8): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let t = 0; t < max; t++) out.add(Math.round((t * (n - 1)) / (max - 1)));
  return Array.from(out).sort((a, b) => a - b);
}

/** Expiry tick indices whose positions are at least `minGap` (fraction of depth) apart, nearest kept first. */
export function expiryTickIndices(fractions: number[], minGap = 0.07): number[] {
  const out: number[] = [];
  let last = -Infinity;
  fractions.forEach((f, j) => { if (j === 0 || j === fractions.length - 1 || f - last >= minGap) { out.push(j); last = f; } });
  // The last tick wins over a crowded neighbour.
  if (out.length > 2 && fractions[out[out.length - 1]] - fractions[out[out.length - 2]] < minGap) out.splice(out.length - 2, 1);
  return out;
}

/** Height-axis tick values in dollars: 0, ±half and ±full scale. */
export function heightTicks(scaleMax: number): number[] {
  if (!(scaleMax > 0)) return [0];
  return [-scaleMax, -scaleMax / 2, 0, scaleMax / 2, scaleMax];
}

/** Ticks for split scaling: each side gets its own half and full marks. */
export function splitTicks(posMax: number, negMax: number): number[] {
  const out: number[] = [];
  if (negMax > 0) out.push(-negMax, -negMax / 2);
  out.push(0);
  if (posMax > 0) out.push(posMax / 2, posMax);
  return out;
}

/**
 * Contour line at one dollar level, as flat xyz segment pairs lifted to the
 * level's height. Marching squares over quads with all four corners present,
 * so a contour never crosses a hole.
 */
export function contourSegments(model: SurfaceModel, level: number): number[] {
  const { nx, nz, present, positions: P } = model;
  const y = model.yOfValue(level);
  const out: number[] = [];
  // Interpolate on the vertices' world height, not on dollars: the mesh edge
  // is linear in height, and value -> height is not linear in compressed or
  // split mode, so a dollar-space crossing would float off the surface.
  const cross = (a: number, b: number): [number, number] | null => {
    const ya = P[a * 3 + 1], yb = P[b * 3 + 1];
    if ((ya - y) * (yb - y) > 0 || ya === yb) return null;
    const t = (y - ya) / (yb - ya);
    return [P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t];
  };
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    if (!(present[a] && present[b] && present[c] && present[d])) continue;
    const pts = [cross(a, b), cross(b, d), cross(d, c), cross(c, a)].filter((p): p is [number, number] => p != null);
    for (let k = 0; k + 1 < pts.length; k += 2) out.push(pts[k][0], y + 0.006, pts[k][1], pts[k + 1][0], y + 0.006, pts[k + 1][1]);
  }
  return out;
}

/**
 * Surface height under a vertical level line at world x, one value per expiry
 * (null where the strikes either side are unobserved). Markers are drawn from
 * the zero plane to this height only, never as full-height walls.
 */
export function ribbonHeights(model: SurfaceModel, x: number): Array<number | null> {
  const { nx, nz, present, positions: P } = model;
  const f = nx <= 1 ? 0 : ((x + WORLD_WIDTH / 2) / WORLD_WIDTH) * (nx - 1);
  const i0 = Math.max(0, Math.min(nx - 1, Math.floor(f))), i1 = Math.min(nx - 1, i0 + 1), t = f - i0;
  const out: Array<number | null> = [];
  for (let j = 0; j < nz; j++) {
    const a = j * nx + i0, b = j * nx + i1;
    if (present[a] && present[b]) out.push(P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t);
    else if (present[a] && t < 0.5) out.push(P[a * 3 + 1]);
    else if (present[b] && t >= 0.5) out.push(P[b * 3 + 1]);
    else out.push(null);
  }
  return out;
}
