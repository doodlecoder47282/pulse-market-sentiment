// Outside the session the option map is held while the option data is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { holdWhileUnchanged, dataFingerprint, _clearHeldMaps, MAX_SLOTS } from "../../server/odteMapHold";

const fwd = (extra: object = {}) => ({
  expiry: "2026-11-25", spot: 7201, session: { state: "closed" }, expectedMove: { straddle: 81 },
  strikes: [{ strike: 7150, callOI: 100, putOI: 900 }, { strike: 7300, callOI: 1200, putOI: 50 }], ...extra,
});
const T = Date.parse("2026-11-24T23:09:00Z"); // 6:09 PM ET

const map = (flip: number, side: string, extra: object = {}) => ({
  landmarks: { wallAbove: flip + 70, flip }, band: { atSpot: side }, strikes: [{ strike: flip, gex: 1 }],
  dataState: "stale_session", session: { state: "closed" }, asOf: 1,
  ladders: { above: [{ label: "prior close", price: 7237 }], below: [] }, range: { straddle: 81 }, ...extra,
});

test("the same data after the close gives the same levels, whatever the clock says", () => {
  _clearHeldMaps();
  const a = holdWhileUnchanged("$SPX|nearest", fwd(), map(7224, "short"), T);
  assert.equal(a.heldSinceMs, null, "the first map on this data is the one kept");
  // 9:19 PM and 3:16 AM: the model, re-priced with less time left, would now say something else.
  const later = holdWhileUnchanged("$SPX|nearest", fwd(), map(7238, "short"), T + 3 * 3600_000);
  assert.equal((later.body as any).landmarks.flip, 7224);
  assert.equal(later.heldSinceMs, T);
  const preopen = holdWhileUnchanged("$SPX|nearest", fwd({ session: { state: "preopen" } }), map(7208, "long", { dataState: "ok", session: { state: "preopen" }, asOf: 9 }), T + 9 * 3600_000);
  assert.equal((preopen.body as any).landmarks.flip, 7224);
  assert.equal((preopen.body as any).band.atSpot, "short", "the read does not flip overnight on unchanged data");
});

test("only the model's levels are held: session labels, state and the session's own numbers are current", () => {
  _clearHeldMaps();
  holdWhileUnchanged("s", fwd(), map(7224, "short"), T);
  const fresh = map(7208, "long", { dataState: "ok", session: { state: "preopen" }, asOf: 2, ladders: { above: [{ label: "prior close", price: 7201 }], below: [] } });
  const r = holdWhileUnchanged("s", fwd({ session: { state: "preopen" } }), fresh, T + 9 * 3600_000).body as any;
  assert.equal(r.landmarks.flip, 7224);
  assert.deepEqual(r.session, { state: "preopen" }, "after midnight the card says 'today'");
  assert.equal(r.dataState, "ok");
  assert.equal(r.asOf, 2);
  assert.equal(r.ladders.above[0].price, 7201, "yesterday's prior close is not carried into today");
});

test("an unpriced or stale map is never kept, and held levels are never laid over one", () => {
  _clearHeldMaps();
  const empty = map(0, "indeterminate", { dataState: "no_gex", landmarks: { wallAbove: null, flip: null } });
  assert.equal(holdWhileUnchanged("w", fwd(), empty, T).body, empty);
  const good = map(7278, "short");
  const r = holdWhileUnchanged("w", fwd(), good, T + 60_000);
  assert.equal(r.body, good, "the empty map was not stored, so the first priced one is served and kept");
  const stale = map(7300, "short", { dataState: "stale" });
  assert.equal(holdWhileUnchanged("w", fwd(), stale, T + 120_000).body, stale, "a stale read shows its own levels and state");
  assert.equal((holdWhileUnchanged("w", fwd(), map(7290, "short"), T + 180_000).body as any).landmarks.flip, 7278);
});

test("new data replaces the held levels: price, priced move, open interest or expiry", () => {
  for (const change of [{ spot: 7215 }, { expectedMove: { straddle: 86 } }, { expiry: "2026-11-27" }, { strikes: [{ strike: 7150, callOI: 100, putOI: 950 }, { strike: 7300, callOI: 1200, putOI: 50 }] }]) {
    _clearHeldMaps();
    holdWhileUnchanged("s", fwd(), map(7224, "short"), T);
    const r = holdWhileUnchanged("s", fwd(change), map(7240, "short"), T + 60_000);
    assert.equal((r.body as any).landmarks.flip, 7240, JSON.stringify(change));
    assert.equal(r.heldSinceMs, null);
  }
  assert.notEqual(dataFingerprint(fwd()), dataFingerprint(fwd({ spot: 7201.5 })));
});

test("nothing is held during the session, the open clears what was held, views do not share a slot, slots are capped", () => {
  _clearHeldMaps();
  holdWhileUnchanged("$SPX|nearest", fwd(), map(7224, "short"), T);
  const open = map(7230, "short", { session: { state: "intraday" }, dataState: "ok" });
  assert.equal(holdWhileUnchanged("$SPX|nearest", fwd({ session: { state: "intraday" } }), open, T + 15 * 3600_000).body, open);
  const afterClose = map(7260, "long");
  assert.equal(holdWhileUnchanged("$SPX|nearest", fwd(), afterClose, T + 24 * 3600_000).body, afterClose, "last night's levels are not brought back");
  const week = map(7278, "short");
  assert.equal(holdWhileUnchanged("$SPX|week", fwd(), week, T).body, week);
  _clearHeldMaps();
  for (let i = 0; i < MAX_SLOTS + 5; i++) holdWhileUnchanged(`SYM${i}|nearest`, fwd(), map(7000 + i, "short"), T + i);
  assert.equal((holdWhileUnchanged("SYM0|nearest", fwd(), map(1, "short"), T + 999).body as any).landmarks.flip, 1, "the oldest slot was dropped");
  assert.equal((holdWhileUnchanged(`SYM${MAX_SLOTS + 4}|nearest`, fwd(), map(2, "short"), T + 999).body as any).landmarks.flip, 7000 + MAX_SLOTS + 4);
});

test("both views of the map route use it", () => {
  const r = readFileSync("server/routes.ts", "utf8");
  assert.match(r, /holdWhileUnchanged\(`\$\{symbol\}\|week`/);
  assert.match(r, /holdWhileUnchanged\(`\$\{symbol\}\|nearest`/);
});
