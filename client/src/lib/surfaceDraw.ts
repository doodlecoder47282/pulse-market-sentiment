// client/src/lib/surfaceDraw.ts
//
// Pure canvas drawing of the 3D exposure surface, separated from the React
// component so it can be rendered in a headless harness against a sample
// payload (tests/ux/surface-harness) and screenshotted at several widths.

import { makeProjector, surfaceQuads, thinLabels, rowOfLevel, heightFraction, COMPRESS_POWER, type SurfaceNode, type SurfaceView } from "@shared/surfaceProjection";

export type SurfaceCell = { expIdx: number; strikeIdx: number; expiry: string; dte: number; strike: number; exposure: number; callOI: number; putOI: number };
export interface SurfaceData {
  spot: number;
  greek: string;
  strikes: number[];
  expiries: Array<{ label: string; dte: number }>;
  cells: SurfaceCell[];
  maxAbs: number;
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null };
}

export function fmtCell(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fill(value: number, maxAbs: number, depthShade: number): string {
  const t = maxAbs > 0 ? Math.min(1, Math.abs(value) / maxAbs) : 0;
  const k = Math.pow(t, 0.55);
  const a = (0.22 + 0.7 * k) * depthShade;
  return value >= 0 ? `rgba(16,185,129,${a.toFixed(3)})` : `rgba(244,63,94,${a.toFixed(3)})`;
}

/**
 * Strike rows for the surface: the grid shows every row, the surface trims
 * rows whose largest |exposure| across expiries is under `minFrac` of the
 * surface max (flat far-OTM rows that would only stretch the footprint),
 * keeps a window around spot, and keeps the result contiguous so no row is
 * skipped inside the drawn range. Values are untouched.
 */
export function trimForSurface(data: SurfaceData, minFrac = 0.01): SurfaceData {
  const n = data.strikes.length;
  if (n < 4) return data;
  const rowMax = new Array<number>(n).fill(0);
  for (const c of data.cells) if (Math.abs(c.exposure) > rowMax[c.strikeIdx]) rowMax[c.strikeIdx] = Math.abs(c.exposure);
  const spotIdx = data.strikes.findIndex((s) => s >= data.spot);
  let lo = n, hi = -1;
  for (let i = 0; i < n; i++) {
    const keep = rowMax[i] >= minFrac * data.maxAbs || (spotIdx >= 0 && Math.abs(i - spotIdx) <= 2);
    if (keep) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
  }
  if (hi < 0 || (lo === 0 && hi === n - 1)) return data;
  return {
    ...data,
    strikes: data.strikes.slice(lo, hi + 1),
    cells: data.cells.filter((c) => c.strikeIdx >= lo && c.strikeIdx <= hi).map((c) => ({ ...c, strikeIdx: c.strikeIdx - lo })),
  };
}

/**
 * Lays out centred text labels so none overlaps: in x order, each label takes
 * the first line (0, 1, 2, ...) at which its box, dropped `lineHeightPx` per
 * line from its own anchor y, clears every box already placed (with `gapPx`
 * around it). Anchors can sit at different y (a slanted edge), so this is a
 * box test, not a per-line right-edge test.
 */
export interface LabelBox { l: number; r: number; t: number; b: number }

export function stackLabels(items: Array<{ x: number; y: number; width: number }>, gapPx = 6, lineHeightPx = 12, heightPx = 11, obstacles: LabelBox[] = []): number[] {
  const order = items.map((_, k) => k).sort((a, b) => items[a].x - items[b].x);
  const lines: number[] = new Array(items.length).fill(0);
  const placed: LabelBox[] = obstacles.slice();
  // gapPx keeps labels apart sideways; vertically the line pitch is the spacing, with a 1 px clearance.
  for (const k of order) {
    const it = items[k];
    const l = it.x - it.width / 2 - gapPx, r = it.x + it.width / 2 + gapPx;
    let line = 0;
    for (; line < 8; line++) {
      const t = it.y + line * lineHeightPx - 1, b = t + heightPx + 2;
      if (!placed.some((p) => l < p.r && r > p.l && t < p.b && b > p.t)) break;
    }
    const t = it.y + line * lineHeightPx;
    placed.push({ l: l, r: r, t, b: t + heightPx });
    lines[k] = line;
  }
  return lines;
}

export function nodesOf(data: SurfaceData): SurfaceNode[] {
  return data.cells.map((c) => ({ i: c.strikeIdx, j: c.expIdx, value: c.exposure }));
}

export function cellMap(data: SurfaceData): Map<string, SurfaceCell> {
  const m = new Map<string, SurfaceCell>();
  for (const c of data.cells) m.set(`${c.strikeIdx},${c.expIdx}`, c);
  return m;
}

/** Draws the whole surface into a context already scaled for device pixels (CSS-pixel coordinates). */
export function drawSurface(ctx: CanvasRenderingContext2D, data: SurfaceData, view: SurfaceView, greek: string, picked: SurfaceCell | null): void {
  const nodes = nodesOf(data);
  const cellAt = cellMap(data);
  const scale = view.heightScale;
    ctx.clearRect(0, 0, view.width, view.height);
    const { project } = makeProjector(view);
    const hf = (v: number) => heightFraction(v, view.maxAbs, view.heightScale);

    // Base plane outline (height 0) so the zero level is visible.
    const base = [project(0, 0, 0), project(view.nStrikes - 1, 0, 0), project(view.nStrikes - 1, view.nExpiries - 1, 0), project(0, view.nExpiries - 1, 0)];
    ctx.beginPath();
    base.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = "rgba(148,163,184,0.05)";
    ctx.fill();
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Surface, back to front.
    const quads = surfaceQuads(nodes, view);
    const depthMin = quads.length ? quads[quads.length - 1].depth : 0;
    const depthMax = quads.length ? quads[0].depth : 1;
    for (const q of quads) {
      const far = depthMax > depthMin ? (q.depth - depthMin) / (depthMax - depthMin) : 0; // 0 = nearest row, 1 = farthest
      const shade = 1 - 0.22 * far;
      ctx.beginPath();
      q.corners.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = fill(q.meanValue, view.maxAbs, shade);
      ctx.fill();
      ctx.strokeStyle = "rgba(2,6,23,0.55)";
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // Spot and flip: polylines across the surface at the interpolated strike row;
    // their labels are laid out together under the front edge so they never overlap.
    const levelLabels: Array<{ x: number; y: number; width: number; text: string; color: string }> = [];
    const drawLevel = (level: number | null, color: string, label: string) => {
      if (level == null) return;
      const row = rowOfLevel(data.strikes, level);
      if (row == null) return;
      const i0 = Math.floor(row), i1 = Math.min(view.nStrikes - 1, i0 + 1), f = row - i0;
      ctx.beginPath();
      for (let j = 0; j < view.nExpiries; j++) {
        const a = cellAt.get(`${i0},${j}`), b = cellAt.get(`${i1},${j}`);
        const val = a && b ? a.exposure * (1 - f) + b.exposure * f : a ? a.exposure : b ? b.exposure : 0;
        const p = project(row, j, hf(val));
        if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      const front = project(row, 0, hf(0));
      ctx.font = "bold 10px ui-monospace, monospace";
      levelLabels.push({ x: front.x, y: front.y, width: ctx.measureText(label).width, text: label, color });
    };
    drawLevel(data.spot, "rgba(250,204,21,0.95)", `spot ${data.spot.toFixed(0)}`);
    if (greek === "gex") drawLevel(data.levels.gammaFlip, "rgba(167,139,250,0.95)", data.levels.gammaFlip != null ? `flip ${data.levels.gammaFlip.toFixed(0)}` : "");

    // Walls: a marker above the strike's tallest node.
    const markWall = (strike: number | null, color: string, label: string) => {
      if (strike == null || greek !== "gex") return;
      const i = data.strikes.indexOf(strike);
      if (i < 0) return;
      let top: { x: number; y: number } | null = null;
      for (let j = 0; j < view.nExpiries; j++) {
        const c = cellAt.get(`${i},${j}`);
        if (!c) continue;
        const p = project(i, j, hf(c.exposure));
        if (!top || p.y < top.y) top = p;
      }
      if (!top) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(top.x, top.y - 6, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(label, top.x, top.y - 12);
    };
    markWall(data.levels.callWall, "rgba(110,231,183,0.95)", `call wall ${data.levels.callWall ?? ""}`);
    markWall(data.levels.putWall, "rgba(253,164,175,0.95)", `put wall ${data.levels.putWall ?? ""}`);
    // Axis labels: strikes along the front edge, expiries along the right edge; thinned so they never overlap.
    ctx.fillStyle = "rgba(203,213,225,0.85)";
    ctx.font = "10px ui-monospace, monospace";
    const f0 = project(0, 0, 0), f1 = project(view.nStrikes - 1, 0, 0);
    const strikePitch = Math.hypot(f1.x - f0.x, f1.y - f0.y) / Math.max(1, view.nStrikes - 1);
    ctx.textAlign = "center";
    const strikeBoxes: LabelBox[] = [];
    for (const i of thinLabels(view.nStrikes, strikePitch, 36)) {
      const p = project(i, 0, 0);
      const text = String(data.strikes[i]);
      ctx.fillText(text, p.x, p.y + 13);
      const w = ctx.measureText(text).width;
      strikeBoxes.push({ l: p.x - w / 2, r: p.x + w / 2, t: p.y + 3, b: p.y + 14 });
    }
    if (levelLabels.length) {
      // Under the front edge, each at its own front-edge y, dropping a line until clear of the strike labels and each other.
      const lines = stackLabels(levelLabels.map((l) => ({ x: l.x, y: l.y + 18, width: l.width })), 4, 12, 11, strikeBoxes);
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      levelLabels.forEach((l, k) => {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.y + 18 + lines[k] * 12);
      });
      ctx.textBaseline = "alphabetic";
      ctx.font = "10px ui-monospace, monospace";
    }
    const e0 = project(view.nStrikes - 1, 0, 0), e1 = project(view.nStrikes - 1, view.nExpiries - 1, 0);
    const expPitch = Math.hypot(e1.x - e0.x, e1.y - e0.y) / Math.max(1, view.nExpiries - 1);
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(148,163,184,0.85)";
    for (const j of thinLabels(view.nExpiries, expPitch, 16)) {
      const p = project(view.nStrikes - 1, j, 0);
      ctx.fillText(`${data.expiries[j].dte}d`, p.x + 6, p.y + 4);
    }

    // Picked node marker.
    if (picked) {
      const p = project(picked.strikeIdx, picked.expIdx, hf(picked.exposure));
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Title band: one line when it fits, two on narrow canvases.
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    const t1 = `${greek.toUpperCase()} surface · one scale, max ${fmtCell(view.maxAbs).replace(/^[+-]/, "")}`;
    const t2 = `height ${scale === "linear" ? "linear" : `|v/max|^${COMPRESS_POWER}`} · open interest only`;
    if (ctx.measureText(`${t1} · ${t2}`).width <= view.width - 16) ctx.fillText(`${t1} · ${t2}`, 8, 14);
    else { ctx.fillText(t1, 8, 14); ctx.fillText(t2, 8, 26); }
}
