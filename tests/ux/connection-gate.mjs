// Local fixture QA only. Does not use, guess, or submit production credentials.
// Invoke runConnectionGateQA(browser, base, outputDir) from Playwright.
const { default: assert } = await import("node:assert/strict");
const { mkdirSync, writeFileSync } = await import("node:fs");

export async function runConnectionGateQA(browser, base, out) {
  mkdirSync(out, { recursive: true });
  const results = [];
  const errors = [];
  const fixtureKey = "local-browser-fixture-only";
  const make = async ({ blocked = false, saved = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    if (blocked) await ctx.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Fixture blocked", "SecurityError"); } });
    });
    if (saved) await ctx.addInitScript(key => localStorage.setItem("batcave.accessKey", key), fixtureKey);
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    const state = { health: "ok", auth: "reject", reads: [], deadlineResolve: null };
    await page.route("**/api/**", async route => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (pathname === "/api/health") {
        if (state.health === "offline") return route.abort("internetdisconnected");
        if (state.health === "malformed") return route.fulfill({ json: { ok: true } });
        if (state.health === "hang") return;
        return route.fulfill({ json: { ok: true, authRequired: true, locked: false } });
      }
      if (pathname === "/api/health/auth") {
        if (state.auth === "offline") return route.fulfill({ status: 503, json: { error: "fixture outage" } });
        return route.fulfill({ status: state.auth === "valid" && req.headers()["x-batcave-key"] === fixtureKey ? 200 : 401, json: { ok: state.auth === "valid" } });
      }
      state.reads.push({ path: pathname, authorized: req.headers()["x-batcave-key"] === fixtureKey });
      if (req.headers()["x-batcave-key"] !== fixtureKey) return route.fulfill({ status: 401, json: { error: "batcave_auth_required" } });
      return route.continue();
    });
    return { ctx, page, state };
  };
  const fresh = await make();
  try {
    const { page, state } = fresh;
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByTestId("gate-connect").waitFor({ state: "visible" });
    assert.equal(state.reads.length, 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /rejected|Couldn't refresh|batcave_auth_required/);
    assert.equal(await page.getByTestId("mobile-bottom-nav").count(), 0);
    results.push("fresh visit: no protected requests, dashboard, or false rejection");
    for (const [width, height, enlarged] of [[375, 667, false], [390, 844, false], [820, 1180, false], [1440, 900, false], [390, 400, true]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(enlarged => document.documentElement.style.fontSize = enlarged ? "200%" : "", enlarged);
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll('[data-testid="gate-connect"], [data-testid="gate-access-key"]')].map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
      }));
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.controls.every(r => r.width >= 44 && r.height >= 44));
      await page.getByTestId("gate-connect").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/gate-${width}-${height}${enlarged ? "-200" : ""}.png` });
    }
    results.push("gate: phone/tablet/desktop/short-height 200% text; 44px targets, no document overflow");
    await page.evaluate(() => document.documentElement.style.fontSize = "");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("gate-access-key").fill("intentionally-invalid-fixture");
    await page.getByTestId("gate-access-key").press("Enter");
    await page.getByTestId("gate-status").filter({ hasText: "Access key rejected." }).waitFor();
    assert.equal(state.reads.length, 0);
    results.push("wrong key: keyboard submission rejects without mounting dashboard");
    state.auth = "offline";
    await page.getByTestId("gate-connect").click();
    await page.getByTestId("gate-status").filter({ hasText: "your key has not been rejected" }).waitFor();
    results.push("server error: not mislabeled as bad credentials");
    state.auth = "valid";
    await page.getByTestId("gate-access-key").fill(fixtureKey);
    await page.getByTestId("gate-connect").click();
    await page.getByTestId("mobile-bottom-nav").waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(state.reads.length > 0 && state.reads.every(r => r.authorized));
    results.push("valid fixture access: dashboard mounts; subsequent API requests carry fixture key");
    await page.route("**/api/snapshot/refresh", route => route.fulfill({ status: 401, json: { error: "batcave_auth_required" } }));
    await page.getByTestId("button-refresh").click();
    await page.getByTestId("gate-status").filter({ hasText: "server rejected the access key" }).waitFor();
    assert.equal(await page.getByTestId("mobile-bottom-nav").count(), 0);
    results.push("authorization expiry during use: real refresh returns to gate and unmounts dashboard");
  } finally { await fresh.ctx.close(); }
  const blocked = await make({ blocked: true });
  try {
    blocked.state.auth = "valid";
    await blocked.page.goto(base, { waitUntil: "domcontentloaded" });
    await blocked.page.getByTestId("gate-access-key").fill(fixtureKey);
    await blocked.page.getByTestId("gate-connect").click();
    await blocked.page.getByTestId("mobile-bottom-nav").waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(blocked.state.reads.length > 0 && blocked.state.reads.every(r => r.authorized));
    results.push("blocked browser storage: authenticated session works without reload");
  } finally { await blocked.ctx.close(); }
  const stale = await make({ saved: true });
  try {
    await stale.page.goto(base, { waitUntil: "domcontentloaded" });
    await stale.page.getByTestId("gate-status").filter({ hasText: "saved access key was rejected" }).waitFor();
    assert.equal(stale.state.reads.length, 0);
    results.push("expired saved key: checked before any dashboard query");
  } finally { await stale.ctx.close(); }
  const unavailable = await make();
  try {
    unavailable.state.health = "malformed";
    await unavailable.page.goto(base, { waitUntil: "domcontentloaded" });
    await unavailable.page.getByTestId("gate-title").filter({ hasText: "not reachable" }).waitFor();
    assert.equal(unavailable.state.reads.length, 0);
    results.push("malformed health payload: stays closed");
    unavailable.state.health = "offline";
    await unavailable.page.getByTestId("gate-connect").click();
    await unavailable.page.getByTestId("gate-status").filter({ hasText: "not reachable" }).waitFor();
    unavailable.state.health = "ok";
    unavailable.state.auth = "valid";
    await unavailable.page.getByTestId("gate-access-key").fill(fixtureKey);
    await unavailable.page.getByTestId("gate-connect").click();
    await unavailable.page.getByTestId("mobile-bottom-nav").waitFor({ state: "visible", timeout: 30_000 });
    results.push("offline retry: recovers through visible controls");
  } finally { await unavailable.ctx.close(); }
  const timeout = await make();
  try {
    timeout.state.health = "hang";
    await timeout.page.goto(base, { waitUntil: "domcontentloaded" });
    await timeout.page.getByTestId("gate-title").filter({ hasText: "not reachable" }).waitFor({ timeout: 15_000 });
    assert.equal(timeout.state.reads.length, 0);
    results.push("hung health request: exits checking state after bounded deadline");
  } finally { await timeout.ctx.close(); }
  assert.deepEqual(errors, []);
  const report = { environment: "local sample-data app with browser-controlled auth fixtures, not Railway", results, errors };
  writeFileSync(`${out}/connection-gate.json`, JSON.stringify(report, null, 2));
  return report;
}
