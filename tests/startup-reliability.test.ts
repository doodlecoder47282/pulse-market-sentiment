import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withRequestDeadline } from "../client/src/lib/requestDeadline";

test("successful read keeps actual values and releases the timeout", async () => {
  const result = await withRequestDeadline(async () => ({ value: 0, missing: null }), undefined, 20);
  assert.deepEqual(result, { value: 0, missing: null });
});

test("a hanging connection times out and aborts", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(withRequestDeadline((s) => {
    signal = s;
    return new Promise(() => {});
  }, undefined, 10), /did not respond/);
  assert.equal(signal?.aborted, true);
});

test("a response body that stalls after headers is bounded too", async () => {
  await assert.rejects(withRequestDeadline(async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"value":')); },
    }));
    return response.json();
  }, undefined, 10), /did not respond/);
});

test("existing cancellation never starts the operation", async () => {
  const parent = new AbortController();
  parent.abort();
  let called = false;
  await assert.rejects(withRequestDeadline(async () => { called = true; }, parent.signal, 10), /cancelled/);
  assert.equal(called, false);
});

test("in-flight cancellation aborts the underlying request", async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const pending = withRequestDeadline((s) => {
    signal = s;
    return new Promise(() => {});
  }, parent.signal, 1000);
  parent.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(signal?.aborted, true);
});

test("operation errors are preserved, not converted into a timeout", async () => {
  await assert.rejects(withRequestDeadline(async () => {
    throw new Error("invalid JSON");
  }, undefined, 20), /invalid JSON/);
});

test("static boot recovery is present even on an already cache-busted URL", () => {
  const html = readFileSync("client/index.html", "utf8");
  assert.match(html, /id="batcave-boot"/);
  assert.match(html, /id="boot-reload"/);
  assert.match(html, /set\("wdbust"/);
  assert.ok(html.indexOf("link.media") < html.indexOf("fonts.googleapis.com"));
  assert.doesNotMatch(html, /__APP_BOOTED__ \|\| busted/);
  const main = readFileSync("client/src/main.tsx", "utf8");
  assert.doesNotMatch(main, /__APP_BOOTED__ = true/);
  assert.doesNotMatch(main, /e\.preventDefault/);
  assert.match(main, /BC-STYLE/);
});

test("animation and dashboard failures are isolated; retry is read-only", () => {
  const app = readFileSync("client/src/App.tsx", "utf8");
  assert.match(app, /StartupBoundary fallback=\{animationRecovery\}/);
  assert.match(app, /!showSplash && !showPremarket/);
  assert.doesNotMatch(app, /opacity-0 pointer-events-none/);
  const dashboard = readFileSync("client/src/pages/dashboard.tsx", "utf8");
  assert.match(dashboard, /onClick=\{\(\) => void refetch\(\)\}/);
});
