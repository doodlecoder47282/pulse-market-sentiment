// Bounded wait on a shared promise (shared/waitFor.ts): the snapshot route
// uses it so a hung rebuild cannot hold every client on the loading state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitFor, WaitTimeoutError } from "../../shared/waitFor";

const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

test("waitFor: a promise that settles in time passes its value or rejection through", async () => {
  assert.equal(await waitFor(later(5, "ok"), 200, "build"), "ok");
  await assert.rejects(waitFor(Promise.reject(new Error("boom")), 200), /boom/);
});

test("waitFor: an overdue promise rejects with WaitTimeoutError naming the wait; the promise keeps running", async () => {
  let settled = false;
  const slow = later(80, "late").then((v) => { settled = true; return v; });
  const t0 = Date.now();
  await assert.rejects(waitFor(slow, 20, "snapshot build"), (e: any) => {
    assert.equal(e.name, "WaitTimeoutError");
    assert.ok(e instanceof WaitTimeoutError);
    assert.match(e.message, /^snapshot build still running after 0 s$/);
    assert.equal(e.waitedMs, 20);
    return true;
  });
  assert.ok(Date.now() - t0 < 70, "gave up at the wait, not at the promise");
  assert.equal(settled, false, "the shared promise is not cancelled");
  // a later waiter still gets the result once it lands
  assert.equal(await slow, "late");
  assert.equal(settled, true);
});

test("waitFor: no wait (0, negative, non-finite) returns the promise itself", async () => {
  const p = later(1, 1);
  assert.equal(waitFor(p, 0), p);
  assert.equal(waitFor(p, -5), p);
  assert.equal(waitFor(p, Number.NaN), p);
  assert.equal(await p, 1);
});
