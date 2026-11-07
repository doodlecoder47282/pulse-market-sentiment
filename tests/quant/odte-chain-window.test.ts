// The 0DTE map's chain window reaches the next session's expiry: on a weekend
// or holiday "1 DTE" returned no expiries and the map read unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { chainDteWindow } from "../../server/odteForward";

test("chain DTE window: 1 on a trading day, the gap to the next session when closed", () => {
  assert.equal(chainDteWindow(Date.UTC(2026, 10, 4, 16, 0)), 1, "Wed -> Thu");
  assert.equal(chainDteWindow(Date.UTC(2026, 10, 6, 16, 0)), 3, "Fri -> Mon");
  assert.equal(chainDteWindow(Date.UTC(2026, 10, 7, 17, 0)), 2, "Sat -> Mon");
  assert.equal(chainDteWindow(Date.UTC(2026, 10, 8, 17, 0)), 1, "Sun -> Mon");
  // Thanksgiving week: Wed Nov 25 -> Fri Nov 27 (Thu closed).
  assert.equal(chainDteWindow(Date.UTC(2026, 10, 25, 16, 0)), 2);
});
