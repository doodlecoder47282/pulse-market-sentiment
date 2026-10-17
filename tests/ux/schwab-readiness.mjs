const { default: assert } = await import("node:assert/strict");
const { mkdirSync, writeFileSync } = await import("node:fs");

export async function runReadinessQA(browser, base, out) {
  mkdirSync(out, { recursive: true });
  const checks = [], errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await ctx.route("https://owned.example/**", r => r.fulfill({ contentType: "text/html", body: "<p>Isolated personal-server fixture</p>" }));
  await page.route("**/api/**", r => r.fulfill({ status: 503, json: { dataState: "unavailable", reason: "Unrelated fixture API" } }));
  await page.route("**/api/health", r => r.fulfill({ json: { ok: true, edition: "demo", locked: false, authRequired: false } }));
  await page.route("**/api/schwab/status", r => r.fulfill({ json: { demo: true, connected: false, needsReauth: false } }));
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByTestId("button-settings").click({ timeout: 30000 });
    await page.getByTestId("personal-server-address").waitFor();
    await page.getByTestId("personal-server-address").fill("");
    assert.equal(await page.getByTestId("personal-server-open-disabled").isDisabled(), true);
    for (const value of ["http://owned.example", "https://owned.example/?code=secret", "https://user:secret@owned.example", "https://owned.example/callback"]) {
      await page.getByTestId("personal-server-address").fill(value);
      await page.getByTestId("personal-server-error").waitFor();
      assert.equal(await page.getByTestId("personal-server-open").count(), 0);
    }
    await page.getByTestId("personal-server-address").fill("https://owned.example");
    await page.getByTestId("personal-server-open").focus();
    const popupWait = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const popup = await popupWait;
    await popup.waitForLoadState("domcontentloaded");
    assert.equal(popup.url(), "https://owned.example/?connect=schwab");
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    await popup.close();
    checks.push("HTTPS handoff activated by keyboard; exact destination; no opener; callback/userinfo/path rejected");
    for (const width of [1440, 375, 820, 390, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await page.getByTestId("personal-server-open").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByTestId("schwab-settings-dialog").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      assert.ok((await page.getByTestId("personal-server-open").boundingBox()).height >= 44);
      await page.screenshot({ path: `${out}/settings-${width}.png` });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.getByTestId("personal-server-open").scrollIntoViewIfNeeded();
    assert.equal(await page.getByTestId("schwab-settings-dialog").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: `${out}/settings-enlarged.png` });
    checks.push("desktop/phone/tablet resize round trip and 200% text; 44px action; no document/dialog overflow");
  } finally { await ctx.close(); }

  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const slow = await ctx2.newPage();
  slow.on("pageerror", e => errors.push(e.message));
  let posts = 0;
  await slow.route("**/api/**", r => r.fulfill({ status: 503, json: { dataState: "unavailable", reason: "Unrelated fixture API" } }));
  await slow.route("**/api/health", r => r.fulfill({ json: { ok: true, edition: "personal", locked: false, authRequired: false } }));
  await slow.route("**/api/schwab/status", r => r.fulfill({ json: { connected: false, needsReauth: true } }));
  await slow.route("**/api/schwab/auth-url", r => r.fulfill({ json: { automatic: false, url: "https://owned.example/?state=test" } }));
  await slow.route("**/api/schwab/callback", () => { posts++; /* stalled fixture, never sent to Schwab */ });
  try {
    await slow.goto(base, { waitUntil: "domcontentloaded" });
    await slow.getByTestId("button-settings").click({ timeout: 30000 });
    await slow.getByTestId("schwab-callback-url-input").fill("synthetic-test-code");
    await slow.clock.install();
    const callback = slow.waitForRequest(r => r.url().endsWith("/api/schwab/callback"));
    await slow.getByTestId("complete-connection-btn").tap();
    await callback;
    await slow.clock.fastForward(26_000);
    await slow.getByTestId("schwab-connection-error").waitFor({ timeout: 30000 });
    assert.equal(posts, 1);
    assert.equal(await slow.getByTestId("complete-connection-btn").isEnabled(), true);
    checks.push("stalled callback reaches safe recovery; one POST only; button unlocks; no blind retry");
  } finally { await ctx2.close(); }
  assert.deepEqual(errors, []);
  writeFileSync(`${out}/readiness-results.json`, JSON.stringify({ checks, errors }, null, 2));
  return checks;
}
