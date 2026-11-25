// Outside the session the option map is held while the option data is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { holdWhileUnchanged, dataFingerprint, _clearHeldMaps } from "../../server/odteMapHold";

const fwd = (extra: object = {}) => ({
  expiry: "2026-11-25", spot: 7201, session: { state: "closed" }, expectedMove: { straddle: 81 },
  strikes: [{ strike: 7150, callOI: 100, putOI: 900 }, { strike: 7300, callOI: 1200, putOI: 50 }], ...extra,
});
const T = Date.parse("2026-11-24T23:09:00Z"); // 6:09 PM ET

test("the same data after the close gives the same levels, whatever the clock says", () => {
  _clearHeldMaps();
  const evening = { ceiling: 7300, turningPoint: 7224, side: "bigger" };
  const a = holdWhileUnchanged("$SPX|nearest", fwd(), evening, T);
  assert.equal(a.body, evening);
  assert.equal(a.heldSinceMs, null, "the first map on this data is the one kept");
  // 9:19 PM and 3:16 AM: the model, re-priced with less time left, would now say something else.
  const later = holdWhileUnchanged("$SPX|nearest", fwd(), { ceiling: 7310, turningPoint: 7238, side: "bigger" }, T + 3 * 3600_000);
  assert.deepEqual(later.body, evening);
  assert.equal(later.heldSinceMs, T);
  const preopen = holdWhileUnchanged("$SPX|nearest", fwd({ session: { state: "preopen" } }), { ceiling: 7250, turningPoint: 7208, side: "calmer" }, T + 9 * 3600_000);
  assert.deepEqual(preopen.body, evening, "the read does not flip overnight on unchanged data");
});

test("a held map keeps its levels but takes the session and data state from now", () => {
  _clearHeldMaps();
  holdWhileUnchanged("s", fwd(), { landmarks: { flip: 7224 }, session: { state: "closed" }, dataState: "stale_session", asOf: 1 }, T);
  const r = holdWhileUnchanged("s", fwd({ session: { state: "preopen" } }), { landmarks: { flip: 7208 }, session: { state: "preopen" }, dataState: "ok", asOf: 2 }, T + 9 * 3600_000);
  assert.deepEqual(r.body, { landmarks: { flip: 7224 }, session: { state: "preopen" }, dataState: "ok", asOf: 2 }, "after midnight the card says 'today', with last night's levels");
});

test("new data replaces the held map: price, priced move, open interest or expiry", () => {
  _clearHeldMaps();
  const first = { n: 1 };
  holdWhileUnchanged("s", fwd(), first, T);
  for (const change of [{ spot: 7215 }, { expectedMove: { straddle: 86 } }, { expiry: "2026-11-27" }, { strikes: [{ strike: 7150, callOI: 100, putOI: 950 }, { strike: 7300, callOI: 1200, putOI: 50 }] }]) {
    _clearHeldMaps();
    holdWhileUnchanged("s", fwd(), first, T);
    const next = { n: 2 };
    const r = holdWhileUnchanged("s", fwd(change), next, T + 60_000);
    assert.equal(r.body, next, JSON.stringify(change));
    assert.equal(r.heldSinceMs, null);
  }
  assert.notEqual(dataFingerprint(fwd()), dataFingerprint(fwd({ spot: 7201.5 })));
});

test("nothing is held during the session, and the open clears what was held; views do not share a slot", () => {
  _clearHeldMaps();
  const night = { n: 1 };
  holdWhileUnchanged("$SPX|nearest", fwd(), night, T);
  const open = { n: 2 };
  assert.equal(holdWhileUnchanged("$SPX|nearest", fwd({ session: { state: "intraday" } }), open, T + 15 * 3600_000).body, open);
  const next = { n: 3 };
  assert.equal(holdWhileUnchanged("$SPX|nearest", fwd({ session: { state: "intraday" } }), next, T + 15 * 3600_000 + 60_000).body, next);
  const afterClose = { n: 4 };
  assert.equal(holdWhileUnchanged("$SPX|nearest", fwd(), afterClose, T + 24 * 3600_000).body, afterClose, "last night's map is not brought back");
  const week = { n: 5 };
  assert.equal(holdWhileUnchanged("$SPX|week", fwd(), week, T).body, week);
});

test("both views of the map route use it", () => {
  const r = readFileSync("server/routes.ts", "utf8");
  assert.match(r, /holdWhileUnchanged\(`\$\{symbol\}\|week`/);
  assert.match(r, /holdWhileUnchanged\(`\$\{symbol\}\|nearest`/);
});
