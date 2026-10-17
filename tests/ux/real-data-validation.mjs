const { default: assert } = await import("node:assert/strict");
const { mkdirSync, writeFileSync } = await import("node:fs");

export async function runRealDataValidationQA(browser, base, out, mode = "all") {
  mkdirSync(out, { recursive: true });
  const errors = [], checks = [];
  if (mode !== "fixture") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(`${base}?connect=schwab`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("schwab-settings-dialog").waitFor({ timeout: 45000 });
    assert.equal(await page.getByTestId("personal-server-address").inputValue(), "https://pulse-market-sentiment-production.up.railway.app");
    await page.getByTestId("schwab-selftest-btn").tap();
    await page.getByTestId("market-validation-summary").waitFor();
    assert.match(await page.getByTestId("market-validation-summary").innerText(), /incomplete/);
    assert.match(await page.getByTestId("schwab-selftest").innerText(), /blocked/i);
    assert.match(await page.getByTestId("schwab-selftest").innerText(), /Demo data cannot validate/);
    checks.push("real demo endpoint honestly blocks validation without provider calls; configured server handoff and Settings deep link render");
    for (const width of [1440, 375, 820, 390]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await page.getByTestId("market-validation-summary").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByTestId("schwab-settings-dialog").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      await page.screenshot({ path: `${out}/validation-${width}.png` });
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.getByTestId("market-validation-summary").scrollIntoViewIfNeeded();
    assert.equal(await page.getByTestId("schwab-settings-dialog").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    assert.equal(await page.getByTestId("schwab-selftest-btn").evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "enlarged button text must wrap within its own bounds");
    await page.screenshot({ path: `${out}/validation-200.png` });
    checks.push("result rows and controls wrap at desktop, tablet, phone and 200% text");
  } finally { await ctx.close(); }
  }

  if (mode !== "demo") {
  const fixtureCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await fixtureCtx.newPage();
  p.on("pageerror", e => errors.push(e.message));
  await p.route("**/api/**", r => r.fulfill({ status: 503, json: { dataState: "unavailable", reason: "Excluded from fixture" } }));
  await p.route("**/api/health", r => r.fulfill({ json: { ok: true, edition: "personal", authRequired: false, locked: false } }));
  await p.route("**/api/schwab/status", r => r.fulfill({ json: { connected: true, needsReauth: false, expiresIn: 1800, refreshExpiresIn: 604800 } }));
  await p.route("**/api/schwab/auth-url", r => r.fulfill({ json: { url: "https://example.com/?state=fixture", automatic: true } }));
  let calls = 0, fail = false;
  await p.route("**/api/schwab/selftest", r => {
    calls++;
    if (fail) return r.fulfill({ json: { items: [{ name: "Legacy HTTP-only result", ok: true }] } });
    return r.fulfill({ json: { version: 1, connected: true, realDataChecked: true, marketInputsValid: false,
      checkedAt: Date.now(), expiresAt: Date.now() + 30000, cached: false, scope: "Fixture input checks only.",
      items: [{ name: "SPY quote", verdict: "pass", ok: true, status: 200, detail: "Fixture timestamp checks passed.", source: "Schwab direct REST", observedAt: Date.now() - 1000 },
        { name: "SPY option sample", verdict: "fail", ok: false, status: 200, detail: "No usable contracts despite HTTP 200.", source: "Schwab direct REST", observedAt: null }] } });
  });
  try {
    // Install before React creates timers so expiry is controlled, not a mix
    // of real intervals and a subsequently installed fake clock.
    await p.clock.install();
    await p.goto(`${base}?connect=schwab`, { waitUntil: "domcontentloaded" });
    await p.getByTestId("schwab-selftest-btn").waitFor({ timeout: 30000 });
    assert.equal(await p.getByTestId("button-settings").count(), 1, "Settings survives a cold snapshot failure");
    await p.getByTestId("schwab-selftest-btn").tap();
    await p.getByTestId("market-validation-summary").waitFor();
    assert.match(await p.getByTestId("market-validation-summary").innerText(), /incomplete/);
    assert.match(await p.getByTestId("market-check-SPY-option-sample").innerText(), /fail/i);
    assert.equal(calls, 1);
    await p.clock.fastForward(31000);
    assert.match(await p.getByTestId("market-validation-summary").innerText(), /expired/i);
    fail = true;
    await p.getByTestId("schwab-selftest-btn").tap();
    await p.getByTestId("market-validation-error").waitFor();
    assert.equal(await p.getByTestId("market-validation-summary").count(), 0);
    assert.doesNotMatch(await p.getByTestId("schwab-selftest").innerText(), /Legacy HTTP-only/);
    checks.push("cold snapshot failure keeps Settings available; mixed results remain incomplete; observed times visible; stale report expires; legacy HTTP-only report rejected and prior pass withdrawn");
  } finally { await fixtureCtx.close(); }
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${out}/results-${mode}.json`, JSON.stringify({ checks, errors }, null, 2));
  return checks;
}
