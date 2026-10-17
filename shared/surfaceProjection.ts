// shared/surfaceProjection.ts
//
// Geometry for the 3D surface view of the dealer-exposure grid (strike x
// expiry x $ exposure). Pure: an orthographic projection of a height field
// with a yaw (rotation about the vertical axis) and a pitch (camera tilt),
// painter's ordering of the surface quads, height scaling that is either
// linear or a labelled signed-power compression, and label thinning so axis
// text never overlaps at any canvas width. The canvas component
// (client/src/components/ThermalSurface.tsx) only draws what this returns,
// so the mapping from dollars to pixels is unit-tested on plain Node.

export interface SurfaceNode {
  /** Column (expiry) index, 0 = nearest expiry. */
  j: number;
  /** Row (strike) index, 0 = lowest strike. */
  i: number;
  /** Signed exposure in dollars. */
  value: number;
}

export interface SurfaceView {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Rotation about the vertical axis, degrees. 0 = strikes left to right, expiries straight back. */
  yawDeg: number;
  /** Camera tilt above the horizon, degrees (90 = straight down, 0 = edge on). */
  pitchDeg: number;
  nStrikes: number;
  nExpiries: number;
  maxAbs: number;
  /** linear: height proportional to value; compressed: sign(v)·|v/max|^0.55, labelled on the card. */
  heightScale: "linear" | "compressed";
  /** Pixels of height for |value| = maxAbs. */
  heightPx: number;
  /** Inset from the canvas edge, px. */
  padding: number;
  /** Depth extent of the expiry axis as a fraction of the strike axis extent (default 0.45), so a 120 x 12 grid is not a ribbon. */
  depthRatio?: number;
}

export const DEFAULT_DEPTH_RATIO = 0.45;

export interface Projected {
  x: number;
  y: number;
  /** View depth: larger is farther from the viewer. */
  depth: number;
}

export const COMPRESS_POWER = 0.55;

/** Dollars to a [-1, 1] height fraction under the chosen scale. */
export function heightFraction(value: number, maxAbs: number, scale: SurfaceView["heightScale"]): number {
  if (!(maxAbs > 0) || !Number.isFinite(value)) return 0;
  const t = Math.max(-1, Math.min(1, value / maxAbs));
  if (scale === "linear") return t;
  return Math.sign(t) * Math.pow(Math.abs(t), COMPRESS_POWER);
}

/**
 * World frame: X along strikes (0..nStrikes-1), Y along expiries (0..nExpiries-1,
 * away from the viewer), Z up (height fraction). The grid is centred, scaled
 * to fit the canvas after rotation, then projected orthographically.
 */
export function makeProjector(v: SurfaceView): {
  project: (i: number, j: number, hFrac: number) => Projected;
  /** Scale in px per world unit along the grid plane. */
  unit: number;
  centre: { x: number; y: number };
} {
  const yaw = (v.yawDeg * Math.PI) / 180;
  const pitch = (v.pitchDeg * Math.PI) / 180;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const sinP = Math.sin(pitch), cosP = Math.cos(pitch);
  const cx = (v.nStrikes - 1) / 2;
  const cy = (v.nExpiries - 1) / 2;
  // World unit along the expiry axis, in strike units: the depth extent is a
  // fixed fraction of the strike extent whatever the grid's counts.
  const ratio = v.depthRatio ?? DEFAULT_DEPTH_RATIO;
  const yUnit = v.nExpiries > 1 ? (ratio * Math.max(1, v.nStrikes - 1)) / (v.nExpiries - 1) : 1;
  // Extent of the rotated footprint, to fit the canvas.
  const corners = [[-cx, -cy * yUnit], [cx, -cy * yUnit], [-cx, cy * yUnit], [cx, cy * yUnit]];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [X, Y] of corners) {
    const xr = X * cosY - Y * sinY;
    const yr = X * sinY + Y * cosY;
    minX = Math.min(minX, xr); maxX = Math.max(maxX, xr);
    minY = Math.min(minY, yr * sinP); maxY = Math.max(maxY, yr * sinP);
  }
  const availW = Math.max(1, v.width - 2 * v.padding);
  const availH = Math.max(1, v.height - 2 * v.padding - v.heightPx * cosP * 2); // room for the height above and below
  const unit = Math.max(0.5, Math.min(availW / Math.max(1e-6, maxX - minX), availH / Math.max(1e-6, maxY - minY)));
  const centre = { x: v.width / 2, y: v.height / 2 };
  const project = (i: number, j: number, hFrac: number): Projected => {
    const X = i - cx, Y = (j - cy) * yUnit;
    const xr = X * cosY - Y * sinY;
    const yr = X * sinY + Y * cosY;
    return {
      x: centre.x + xr * unit,
      // screen y grows downward; farther rows (larger yr) sit higher on screen; height lifts the point.
      y: centre.y - yr * sinP * unit - hFrac * v.heightPx * cosP,
      depth: yr,
    };
  };
  return { project, unit, centre };
}

export interface Quad {
  i: number;
  j: number;
  /** Corner nodes in draw order: (i,j) (i+1,j) (i+1,j+1) (i,j+1). */
  corners: [Projected, Projected, Projected, Projected];
  /** Mean of the four corner values, dollars. */
  meanValue: number;
  /** Painter's key: larger draws first. */
  depth: number;
}

/**
 * Surface quads between adjacent grid nodes, sorted back to front. A grid
 * with a missing node (no contract priced there) yields no quad at that
 * position, so holes stay holes rather than being interpolated.
 */
export function surfaceQuads(nodes: SurfaceNode[], v: SurfaceView): Quad[] {
  const { project } = makeProjector(v);
  const byKey = new Map<string, SurfaceNode>();
  for (const n of nodes) byKey.set(`${n.i},${n.j}`, n);
  const get = (i: number, j: number) => byKey.get(`${i},${j}`);
  const quads: Quad[] = [];
  for (let j = 0; j < v.nExpiries - 1; j++) {
    for (let i = 0; i < v.nStrikes - 1; i++) {
      const a = get(i, j), b = get(i + 1, j), c = get(i + 1, j + 1), d = get(i, j + 1);
      if (!a || !b || !c || !d) continue;
      const P = (n: SurfaceNode) => project(n.i, n.j, heightFraction(n.value, v.maxAbs, v.heightScale));
      const corners: Quad["corners"] = [P(a), P(b), P(c), P(d)];
      const depth = (corners[0].depth + corners[1].depth + corners[2].depth + corners[3].depth) / 4;
      quads.push({ i, j, corners, meanValue: (a.value + b.value + c.value + d.value) / 4, depth });
    }
  }
  quads.sort((p, q) => q.depth - p.depth);
  return quads;
}

/**
 * Indices to label along an axis so that neighbouring labels are at least
 * `minPitchPx` apart on screen: every k-th index, k the smallest integer that
 * satisfies the pitch, always including the first and last index.
 */
export function thinLabels(count: number, pitchPx: number, minPitchPx: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const k = Math.max(1, Math.ceil(minPitchPx / Math.max(1e-6, pitchPx)));
  const out: number[] = [];
  for (let i = 0; i < count; i += k) out.push(i);
  if (out[out.length - 1] !== count - 1) {
    // Keep the last label only if it does not crowd the previous one.
    if ((count - 1 - out[out.length - 1]) * pitchPx >= minPitchPx) out.push(count - 1);
    else out[out.length - 1] = count - 1;
  }
  return out;
}

/**
 * Nearest node to a screen point within `radiusPx`, for tap / hover selection.
 * Nodes closer to the viewer win ties, so a front node is picked over one it hides.
 */
export function pickNode(nodes: SurfaceNode[], v: SurfaceView, x: number, y: number, radiusPx = 14): SurfaceNode | null {
  const { project } = makeProjector(v);
  let best: SurfaceNode | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    const p = project(n.i, n.j, heightFraction(n.value, v.maxAbs, v.heightScale));
    const d = Math.hypot(p.x - x, p.y - y);
    if (d > radiusPx) continue;
    const score = d + p.depth * 0.01;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}

/** Fractional row position of a price level between strike rows (null outside the grid). */
export function rowOfLevel(strikes: number[], level: number): number | null {
  if (!strikes.length || !Number.isFinite(level)) return null;
  if (level < strikes[0] || level > strikes[strikes.length - 1]) return null;
  let i = 0;
  while (i < strikes.length - 1 && strikes[i + 1] < level) i++;
  const lo = strikes[i], hi = strikes[Math.min(i + 1, strikes.length - 1)];
  return hi > lo ? i + (level - lo) / (hi - lo) : i;
}
