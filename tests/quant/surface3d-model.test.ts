// Geometry of the WebGL exposure surface (client/src/lib/surface3dModel.ts):
// heights are exact dollars on one shared scale, missing cells are holes,
// DTE spacing is proportional, levels land on the right strike, and the
// per-side layers come from the same cells as the net surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSurfaceModel, expiryFractions, expiryTickIndices, hasSides, heightTicks, layerValue, sharedScaleMax, strikeTickIndices,
  WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH, type Data3D,
} from "../../client/src/lib/surface3dModel";
import { buildThermalHeatmap } from "../../server/thermalHeatmap";
import { demoChain } from "../../server/demoMarket";
import { etWallToEpochMs } from "../../server/exchangeCalendar";

const cell = (i: number, j: number, call: number, put: number) => ({
  expIdx: j, strikeIdx: i, expiry: `E${j}`, dte: [0, 1, 7][j], strike: [100, 105, 110][i],
  exposure: call + put, callExposure: call, putExposure: put, callOI: call ? 10 : 0, putOI: put ? 10 : 0,
});
const base = (): Data3D => ({
  spot: 104, greek: "gex", strikes: [100, 105, 110],
  expiries: [{ label: "E0", dte: 0 }, { label: "E1", dte: 1 }, { label: "E2", dte: 7 }],
  maxAbs: 0, levels: { callWall: 110, putWall: 100, gammaFlip: 102.5 },
  cells: [
    cell(0, 0, 10, -40), cell(1, 0, 30, -5), cell(2, 0, 80, 0),
    cell(0, 1, 5, -20), cell(1, 1, 20, -10), cell(2, 1, 40, -1),
    cell(0, 2, 1, -2), /* (1,2) missing */ cell(2, 2, 3, -1),
  ],
});

test("shared scale covers net, call and put so layer heights are comparable", () => {
  const d = base();
  assert.equal(sharedScaleMax(d), 80);
  const net = buildSurfaceModel(d, { layer: "net", spacing: "even", heightScale: "linear", scale: "shared" });
  const call = buildSurfaceModel(d, { layer: "call", spacing: "even", heightScale: "linear", scale: "shared" });
  assert.equal(net.scaleMax, call.scaleMax);
  // (2,0): call 80 = full height; net 80 also full height on the same scale.
  const k = 0 * 3 + 2;
  assert.ok(Math.abs(call.positions[k * 3 + 1] - WORLD_HEIGHT) < 1e-6);
  // (0,0): net -30 -> -30/80 of full height, linear.
  assert.ok(Math.abs(net.positions[1] - (-30 / 80) * WORLD_HEIGHT) < 1e-6);
  const put = buildSurfaceModel(d, { layer: "put", spacing: "even", heightScale: "linear", scale: "shared" });
  assert.ok(Math.abs(put.positions[1] - (-40 / 80) * WORLD_HEIGHT) < 1e-6);
});

test("missing cells are holes: no quad touches an unobserved corner and its value is never drawn as data", () => {
  const m = buildSurfaceModel(base(), { layer: "net", spacing: "even", heightScale: "linear" });
  const missing = 2 * 3 + 1;
  assert.equal(m.present[missing], 0);
  assert.equal(m.cellAtVertex(missing), null);
  for (const v of m.indices) assert.notEqual(v, missing);
  assert.equal(m.quadCount, 2); // row j=0..1 fully present -> 2 quads; j=1..2 both quads touch the hole
  assert.equal(m.holeCount, 2);
  assert.equal(m.indices.length, m.quadCount * 6);
});

test("expiry spacing: even by index, or proportional to DTE", () => {
  const e = base().expiries;
  assert.deepEqual(expiryFractions(e, "even"), [0, 0.5, 1]);
  assert.deepEqual(expiryFractions(e, "dte"), [0, 1 / 7, 1]);
  const m = buildSurfaceModel(base(), { layer: "net", spacing: "dte", heightScale: "linear" });
  assert.ok(Math.abs(m.zOfExpiry(0) - WORLD_DEPTH / 2) < 1e-9);
  assert.ok(Math.abs(m.zOfExpiry(2) + WORLD_DEPTH / 2) < 1e-9);
  assert.ok(Math.abs(m.zOfExpiry(1) - (WORLD_DEPTH / 2 - WORLD_DEPTH / 7)) < 1e-9);
  // Identical DTEs cannot divide by zero: fall back to even.
  assert.deepEqual(expiryFractions([{ dte: 3 }, { dte: 3 }], "dte"), [0, 1]);
});

test("price levels map to interpolated strike positions; outside the drawn strikes they are omitted", () => {
  const m = buildSurfaceModel(base(), { layer: "net", spacing: "even", heightScale: "linear" });
  assert.ok(Math.abs(m.xOfLevel(100)! + WORLD_WIDTH / 2) < 1e-9);
  assert.ok(Math.abs(m.xOfLevel(110)! - WORLD_WIDTH / 2) < 1e-9);
  assert.ok(Math.abs(m.xOfLevel(102.5)! - (-WORLD_WIDTH / 4)) < 1e-9);
  assert.equal(m.xOfLevel(99), null);
  assert.equal(m.xOfLevel(null), null);
});

test("compressed height keeps sign and order and is labelled by the caller", () => {
  const m = buildSurfaceModel(base(), { layer: "net", spacing: "even", heightScale: "compressed" });
  const y = (v: number) => m.yOfValue(v);
  assert.ok(y(10) > 0 && y(-10) < 0 && y(40) > y(10));
  assert.ok(Math.abs(y(80) - WORLD_HEIGHT) < 1e-9);
});

test("older servers without the split expose only the net layer", () => {
  const d = base();
  d.cells = d.cells.map(({ callExposure, putExposure, ...c }) => c);
  assert.equal(hasSides(d), false);
  assert.equal(layerValue(d.cells[0], "call"), null);
  const m = buildSurfaceModel(d, { layer: "call", spacing: "even", heightScale: "linear" });
  assert.equal(m.quadCount, 0);
  assert.equal(sharedScaleMax(d), 80);
});

test("ticks: strike ends always labelled, expiry ticks never crowd, height ticks symmetric", () => {
  const t = strikeTickIndices(120, 9);
  assert.equal(t[0], 0); assert.equal(t[t.length - 1], 119); assert.ok(t.length <= 9);
  assert.deepEqual(strikeTickIndices(3, 9), [0, 1, 2]);
  const fr = [0, 0.01, 0.02, 0.2, 0.5, 0.98, 1];
  const e = expiryTickIndices(fr, 0.07);
  for (let k = 1; k < e.length; k++) assert.ok(fr[e[k]] - fr[e[k - 1]] >= 0.07 - 1e-12);
  assert.equal(e[0], 0); assert.equal(e[e.length - 1], fr.length - 1);
  assert.deepEqual(heightTicks(80), [-80, -40, 0, 40, 80]);
  assert.deepEqual(heightTicks(0), [0]);
});

test("real heatmap payload (demo chain) builds a finite surface whose call+put layers reproduce the net", () => {
  const NOW = etWallToEpochMs("2026-10-12", 11 * 60);
  const ch = demoChain({ symbol: "$SPX", contractType: "ALL", strikeCount: 120, fromDate: "2026-10-12", toDate: "2026-10-23" }, NOW);
  const h = buildThermalHeatmap(ch, "$SPX", ch.underlying.last, "gex", { nowMs: NOW });
  const d = h as unknown as Data3D;
  assert.equal(hasSides(d), true);
  const opts = { spacing: "dte" as const, heightScale: "linear" as const };
  const net = buildSurfaceModel(d, { layer: "net", ...opts });
  const call = buildSurfaceModel(d, { layer: "call", ...opts });
  const put = buildSurfaceModel(d, { layer: "put", ...opts });
  assert.ok(net.quadCount > 0);
  for (const arr of [net.positions, net.colors]) for (const v of arr) assert.ok(Number.isFinite(v));
  for (let k = 0; k < net.values.length; k++) {
    if (!net.present[k]) continue;
    assert.ok(Math.abs(call.values[k] + put.values[k] - net.values[k]) <= 1e-6 * Math.max(1, Math.abs(net.values[k])));
  }
  assert.ok(Math.abs(net.scaleMax - h.maxAbs) <= 1e-9 * h.maxAbs, "fit-to-layer net scale equals the server max");
});

test("fit-to-layer scale fills the height for the chosen layer; shared keeps layers comparable", async () => {
  const { layerScaleMax } = await import("../../client/src/lib/surface3dModel");
  const d = base();
  assert.equal(layerScaleMax(d, "net"), 80);
  assert.equal(layerScaleMax(d, "put"), 40);
  const put = buildSurfaceModel(d, { layer: "put", spacing: "even", heightScale: "linear" });
  assert.equal(put.scaleMax, 40);
  assert.ok(Math.abs(put.positions[1] + WORLD_HEIGHT) < 1e-6); // -40 fills the full depth
  const putShared = buildSurfaceModel(d, { layer: "put", spacing: "even", heightScale: "linear", scale: "shared" });
  assert.equal(putShared.scaleMax, 80);
  assert.ok(Math.abs(putShared.positions[1] + WORLD_HEIGHT / 2) < 1e-6);
});
