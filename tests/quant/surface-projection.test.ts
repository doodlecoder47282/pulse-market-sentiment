// tests/quant/surface-projection.test.ts
//
// Geometry of the 3D exposure surface (shared/surfaceProjection.ts): height
// scaling is faithful to the dollars, the projection keeps the grid inside the
// canvas at every yaw / pitch / size, painter's order is back to front, holes
// stay holes, labels never overlap, picking returns the nearest front node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { heightFraction, makeProjector, surfaceQuads, thinLabels, pickNode, rowOfLevel, COMPRESS_POWER, type SurfaceNode, type SurfaceView } from "../../shared/surfaceProjection";

const view = (over: Partial<SurfaceView> = {}): SurfaceView => ({
  width: 800, height: 480, yawDeg: 30, pitchDeg: 40, nStrikes: 25, nExpiries: 8, maxAbs: 1e9,
  heightScale: "linear", heightPx: 120, padding: 16, ...over,
});

function gridNodes(nS: number, nE: number, f: (i: number, j: number) => number): SurfaceNode[] {
  const out: SurfaceNode[] = [];
  for (let j = 0; j < nE; j++) for (let i = 0; i < nS; i++) out.push({ i, j, value: f(i, j) });
  return out;
}

test("height: linear is proportional and signed, compressed is sign·|t|^0.55 and labelled by the constant, both clamp at the max", () => {
  assert.equal(heightFraction(5e8, 1e9, "linear"), 0.5);
  assert.equal(heightFraction(-5e8, 1e9, "linear"), -0.5);
  assert.equal(heightFraction(3e9, 1e9, "linear"), 1);
  assert.equal(heightFraction(0, 1e9, "linear"), 0);
  assert.equal(heightFraction(5e8, 0, "linear"), 0);
  assert.equal(heightFraction(Number.NaN, 1e9, "linear"), 0);
  const c = heightFraction(-2.5e8, 1e9, "compressed");
  assert.ok(Math.abs(c + Math.pow(0.25, COMPRESS_POWER)) < 1e-12);
  assert.ok(Math.abs(heightFraction(2.5e8, 1e9, "compressed")) > 0.25, "compression lifts mid values");
  assert.equal(heightFraction(1e9, 1e9, "compressed"), 1);
});

test("projection: every grid corner, at full positive and negative height, lands inside the canvas for a sweep of yaw, pitch and sizes", () => {
  for (const [w, h] of [[343, 260], [800, 480], [1300, 520]]) {
    for (const yaw of [0, 15, 30, 45, 60, 89]) {
      for (const pitch of [20, 35, 50, 70]) {
        const v = view({ width: w, height: h, yawDeg: yaw, pitchDeg: pitch });
        const { project } = makeProjector(v);
        for (const i of [0, v.nStrikes - 1]) for (const j of [0, v.nExpiries - 1]) for (const hf of [-1, 0, 1]) {
          const p = project(i, j, hf);
          assert.ok(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h, `out of canvas: ${w}x${h} yaw ${yaw} pitch ${pitch} i${i} j${j} h${hf}: ${p.x},${p.y}`);
        }
      }
    }
  }
});

test("projection: yaw 0 puts strikes left to right in order, expiries farther = higher on screen, positive height lifts the point", () => {
  const v = view({ yawDeg: 0 });
  const { project } = makeProjector(v);
  const a = project(0, 0, 0), b = project(10, 0, 0), far = project(0, 5, 0), up = project(0, 0, 1), down = project(0, 0, -1);
  assert.ok(b.x > a.x);
  assert.ok(Math.abs(b.y - a.y) < 1e-9, "same row, same screen y at yaw 0");
  assert.ok(far.y < a.y && far.depth > a.depth);
  assert.ok(up.y < a.y && down.y > a.y);
  assert.ok(Math.abs((a.y - up.y) - 120 * Math.cos((40 * Math.PI) / 180)) < 1e-9, "height in px = heightPx·cos(pitch)");
});

test("quads: back to front, one per complete cell, holes where a node is missing, mean value carried", () => {
  const nodes = gridNodes(5, 4, (i, j) => (i - 2) * 1e8 + j * 1e7).filter((n) => !(n.i === 2 && n.j === 1));
  const v = view({ nStrikes: 5, nExpiries: 4, maxAbs: 3e8 });
  const q = surfaceQuads(nodes, v);
  // 4 x 3 cells minus the four that touch the missing node (2,1).
  assert.equal(q.length, 12 - 4);
  for (let k = 1; k < q.length; k++) assert.ok(q[k].depth <= q[k - 1].depth, "painter's order: farther first");
  const first = q.find((x) => x.i === 0 && x.j === 0)!;
  assert.ok(Math.abs(first.meanValue - ((-2e8) + (-1e8) + (-1e8 + 1e7) + (-2e8 + 1e7)) / 4) < 1e-6);
  assert.equal(surfaceQuads([], v).length, 0);
});

test("labels: every k-th index at a pitch that never puts two labels closer than the minimum; first and last kept apart", () => {
  assert.deepEqual(thinLabels(10, 50, 40), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const t = thinLabels(25, 12, 34);         // k = 3
  for (let k = 1; k < t.length; k++) assert.ok((t[k] - t[k - 1]) * 12 >= 34, `${t}`);
  assert.equal(t[0], 0);
  assert.equal(t[t.length - 1], 24);
  const u = thinLabels(26, 12, 34);         // last index 25 is 1 step after 24: replaced, not added
  assert.equal(u[u.length - 1], 25);
  for (let k = 1; k < u.length; k++) assert.ok((u[k] - u[k - 1]) * 12 >= 34, `${u}`);
  assert.deepEqual(thinLabels(1, 5, 40), [0]);
  assert.deepEqual(thinLabels(0, 5, 40), []);
});

test("pick: nearest node within the radius, front node wins a tie, nothing outside the radius", () => {
  const v = view({ yawDeg: 0, nStrikes: 5, nExpiries: 3, maxAbs: 1 });
  const nodes = gridNodes(5, 3, () => 0);
  const { project } = makeProjector(v);
  const p = project(2, 0, 0);
  const got = pickNode(nodes, v, p.x + 3, p.y - 2);
  assert.deepEqual({ i: got!.i, j: got!.j }, { i: 2, j: 0 });
  assert.equal(pickNode(nodes, v, -100, -100), null);
  // Two nodes projecting to the same point (a tall far node over a near one): the near one is picked.
  const stacked: SurfaceNode[] = [{ i: 1, j: 0, value: 0 }, { i: 1, j: 1, value: 0 }];
  const vv = view({ yawDeg: 0, pitchDeg: 90, nStrikes: 3, nExpiries: 2, maxAbs: 1 });
  const near = project(1, 0, 0);
  const got2 = pickNode(stacked, vv, makeProjector(vv).project(1, 0, 0).x, makeProjector(vv).project(1, 0, 0).y);
  assert.equal(got2!.j, 0, `near node wins: ${JSON.stringify(got2)} (${near.x},${near.y})`);
});

test("rowOfLevel: fractional row between strikes; outside the grid is null", () => {
  const ks = [100, 105, 110, 120];
  assert.equal(rowOfLevel(ks, 100), 0);
  assert.equal(rowOfLevel(ks, 107.5), 1.5);
  assert.equal(rowOfLevel(ks, 115), 2.5);
  assert.equal(rowOfLevel(ks, 120), 3);
  assert.equal(rowOfLevel(ks, 99), null);
  assert.equal(rowOfLevel(ks, 121), null);
  assert.equal(rowOfLevel([], 100), null);
});

// ── Drawing helpers (client/src/lib/surfaceDraw.ts, no React) ────────────────
import { trimForSurface, stackLabels, drawSurface, type SurfaceData } from "@/lib/surfaceDraw";

function sampleData(rowMaxFrac: number[], spotRow: number): SurfaceData {
  const strikes = rowMaxFrac.map((_, i) => 6000 + i * 5);
  const cells: SurfaceData["cells"] = [];
  rowMaxFrac.forEach((f, i) => {
    for (let j = 0; j < 3; j++) cells.push({ expIdx: j, strikeIdx: i, expiry: `e${j}`, dte: j, strike: strikes[i], exposure: f * 1e9 * (j === 1 ? 1 : 0.5), callOI: 1, putOI: 1 });
  });
  return { spot: strikes[spotRow] - 1, greek: "gex", strikes, expiries: [{ label: "a", dte: 0 }, { label: "b", dte: 1 }, { label: "c", dte: 2 }], cells, maxAbs: 1e9, levels: { callWall: null, putWall: null, gammaFlip: null } };
}

test("trimForSurface: flat far rows under 1% of the max are cut from both ends, the window round spot is kept, the kept range is contiguous and values untouched", () => {
  const d = sampleData([0.001, 0.002, 0.5, 0.003, 0.9, 0.004, 0.001, 0.0005], 4);
  const t = trimForSurface(d);
  // rows 2..6 kept: 2 and 4 have signal, 3/5/6 are within 2 of the spot row (4); 0, 1, 7 trimmed.
  assert.deepEqual(t.strikes, d.strikes.slice(2, 7));
  assert.equal(t.cells.length, 5 * 3);
  assert.ok(t.cells.every((c) => c.strikeIdx >= 0 && c.strikeIdx < 5));
  const orig = d.cells.find((c) => c.strikeIdx === 4 && c.expIdx === 1)!;
  const kept = t.cells.find((c) => c.strike === orig.strike && c.expIdx === 1)!;
  assert.equal(kept.exposure, orig.exposure);
  // Nothing to trim: the same object comes back.
  const full = sampleData([0.5, 0.5, 0.5, 0.5], 1);
  assert.equal(trimForSurface(full), full);
  // An interior flat row between two signal rows is kept (contiguity).
  const gap = sampleData([0.5, 0.001, 0.001, 0.001, 0.001, 0.5, 0.0001, 0.0001], 0);
  assert.equal(trimForSurface(gap).strikes.length, 6);
});

test("stackLabels: boxes that would overlap drop a line; obstacles count; slanted anchors are handled by box, not by line", () => {
  // Two labels 20 px apart, each 50 px wide: the second drops to line 1.
  const a = stackLabels([{ x: 100, y: 50, width: 50 }, { x: 120, y: 50, width: 50 }], 4, 12, 11);
  assert.deepEqual(a, [0, 1]);
  // Far apart: same line.
  assert.deepEqual(stackLabels([{ x: 100, y: 50, width: 50 }, { x: 300, y: 50, width: 50 }], 4, 12, 11), [0, 0]);
  // Slanted anchors: the second label's anchor is one line above the first, so line 0 already clears it (box test, not line test);
  // one line lower it would land level with the first and overlap, so a 6 px higher anchor needs line 2.
  const s = stackLabels([{ x: 100, y: 62, width: 50 }, { x: 120, y: 50, width: 50 }], 4, 12, 11);
  assert.equal(s[1], 0);
  const s2 = stackLabels([{ x: 100, y: 56, width: 50 }, { x: 120, y: 50, width: 50 }], 4, 12, 11);
  assert.equal(s2[1], 2);
  // An obstacle box over the anchor pushes the label down.
  const o = stackLabels([{ x: 100, y: 50, width: 50 }], 4, 12, 11, [{ l: 80, r: 130, t: 48, b: 60 }]);
  assert.equal(o[0], 1);
  assert.deepEqual(stackLabels([], 4, 12, 11), []);
});

test("drawn wall labels stay inside phone canvas and below the title band", () => {
  const data = sampleData([-1, 0, 1], 1);
  data.levels = { callWall: data.strikes[2], putWall: data.strikes[0], gammaFlip: null };
  for (const width of [280, 317, 800]) for (const yawDeg of [0,25,85]) for (const pitchDeg of [15,42,75]) {
    const labels: Array<{text:string,x:number,y:number}> = [];
    const ctx = new Proxy({ measureText: (text:string) => ({width:text.length * 6}), fillText:(text:string,x:number,y:number) => labels.push({text,x,y}) }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : () => {}; },
      set() { return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawSurface(ctx, data, view({width,height:280,nStrikes:3,nExpiries:3,yawDeg,pitchDeg,heightPx:56,padding:28}), "gex", null);
    const walls = labels.filter(l => /^(call|put) wall/.test(l.text));
    assert.equal(walls.length,2);
    for(const l of walls) {
      assert.ok(l.x-l.text.length*3 >= 0 && l.x+l.text.length*3 <= width);
      assert.ok(l.y>=48 && l.y<=268);
    }
  }
});
