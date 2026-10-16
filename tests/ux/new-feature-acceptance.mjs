// Isolated local fixture QA. No real brokerage code, key or token.
const { default: assert } = await import("node:assert/strict");
const { mkdirSync, writeFileSync } = await import("node:fs");

export async function runSchwabHandoffQA(browser, base, out) {
  mkdirSync(out, { recursive: true });
  const checks = [], errors = [];
  for (const automatic of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/api/**", r => new URL(r.request().url()).pathname === "/api/health"
      ? r.fulfill({json:{ok:true,authRequired:false,locked:false,edition:"personal"}})
      : r.fulfill({status:503,json:{dataState:"unavailable",reason:"Unrelated API intentionally excluded from fixture"}}));
    const state = { connected: false, posts: 0, authReads: 0, fail: false, statusReads: 0 };
    await page.route("**/api/schwab/status", r => {
      state.statusReads++;
      return r.fulfill({ json: { connected: state.connected, needsReauth: !state.connected, expiresIn: 1800, refreshExpiresIn: 604800 } });
    });
    await page.route("**/api/schwab/auth-url", r => {
      state.authReads++;
      return r.fulfill({ json: { automatic, url: `https://example.com/oauth-fixture?state=fixture-${state.authReads}` } });
    });
    await page.route("https://example.com/oauth-fixture**", r => r.fulfill({ body: "<p>Isolated authorization fixture, not Schwab</p>", contentType: "text/html" }));
    await page.route("**/api/schwab/callback", async r => {
      state.posts++;
      assert.match(r.request().postDataJSON().state, /^fixture-/);
      // Hold the exchange to expose rapid-tap races.
      await new Promise(resolve => setTimeout(resolve, 650));
      if (!state.fail) state.connected = true;
      return r.fulfill({ status: state.fail ? 400 : 200, json: state.fail ? { message: "sensitive-provider-fixture" } : { ok: true } });
    });
    try {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByTestId("button-settings").click({ timeout: 30000 });
      await page.getByTestId("open-schwab-auth-btn").waitFor();
      const popupWait = page.waitForEvent("popup");
      await page.getByTestId("open-schwab-auth-btn").click();
      const popup = await popupWait;
      assert.match(popup.url(), /example\.com\/oauth-fixture/);
      await popup.close();
      checks.push(`${automatic ? "automatic" : "manual"}: real login-link click opens configured fixture destination`);
      if (automatic) {
        assert.equal(await page.getByTestId("schwab-callback-url-input").count(), 0);
        assert.equal(await page.getByTestId("schwab-automatic-return").count(), 1);
        state.connected = true;
        const response = page.waitForResponse(r => r.url().endsWith("/api/schwab/status"));
        await page.getByTestId("schwab-check-connection").click();
        await response;
        await page.getByTestId("schwab-automatic-return").waitFor({ state: "detached" });
        assert.equal(state.posts, 0);
        checks.push("automatic: no manual code prompt; check-connection refresh succeeds without code submission");
      } else {
        await page.getByTestId("schwab-callback-url-input").fill("https://127.0.0.1/?code=synthetic-only");
        // Elapsed-time test: former auto-submit timer was 250ms.
        await page.waitForTimeout(400);
        assert.equal(state.posts, 0);
        checks.push("manual: pasting alone never submits");
        state.fail = true;
        const response = page.waitForResponse(r => r.url().endsWith("/api/schwab/callback"));
        await page.getByTestId("complete-connection-btn").dblclick();
        await response;
        await page.getByTestId("schwab-connection-error").waitFor();
        assert.equal(state.posts, 1);
        assert.ok(!(await page.locator("body").innerText()).includes("sensitive-provider-fixture"));
        checks.push("manual: rapid double tap sends once; failed exchange has safe inline recovery");
        const fresh = page.waitForResponse(r => r.url().endsWith("/api/schwab/auth-url"));
        await page.getByTestId("schwab-fresh-login").click();
        await fresh;
        assert.equal(await page.getByTestId("schwab-callback-url-input").inputValue(), "");
        for (const [width, height] of [[375,667],[820,1180],[1440,900],[390,844]]) {
          await page.setViewportSize({ width, height });
          await page.getByTestId("complete-connection-btn").scrollIntoViewIfNeeded();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          const box = await page.getByTestId("complete-connection-btn").boundingBox();
          assert.ok(box.height >= 44);
          await page.screenshot({ path: `${out}/schwab-manual-${width}.png` });
        }
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await page.getByTestId("complete-connection-btn").scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.getByTestId("schwab-settings-dialog").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        await page.screenshot({ path: `${out}/schwab-manual-200.png` });
        await page.evaluate(() => document.documentElement.style.fontSize = "");
        state.fail = false;
        await page.getByTestId("schwab-callback-url-input").fill("fresh-synthetic-code");
        const success = page.waitForResponse(r => r.url().endsWith("/api/schwab/callback"));
        await page.getByTestId("complete-connection-btn").tap();
        await success;
        await page.getByTestId("schwab-callback-url-input").waitFor({ state: "detached" });
        assert.equal(state.posts, 2);
        checks.push("manual: fresh-link recovery, phone/tablet/desktop/200% text and successful authorization");
      }
    } finally { await ctx.close(); }
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${out}/schwab-results.json`, JSON.stringify({ checks, errors }, null, 2));
  return checks;
}

export async function runThermalQA(browser, base, out) {
  mkdirSync(out, { recursive: true });
  const checks = [], errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", r => new URL(r.request().url()).pathname === "/api/health"
    ? r.fulfill({json:{ok:true,authRequired:false,locked:false,edition:"personal"}})
    : r.fulfill({status:503,json:{dataState:"unavailable",reason:"Unrelated API intentionally excluded from fixture"}}));
  const state = { mode: "ok", reads: 0 };
  const strikes = [6900, 7000, 7100];
  const expiries = [{label:"2026-10-16",dte:0},{label:"2026-10-19",dte:3},{label:"2026-10-23",dte:7}];
  await page.route("**/api/layout/regime", r => r.fulfill({ json: { order: ["thermal-heatmap"], hidden: ["canary", "order-flow", "regime-panel"] } }));
  await page.route("**/api/heatmap/thermal?**", r => {
    state.reads++;
    const greek = new URL(r.request().url()).searchParams.get("greek");
    if (state.mode === "error") return r.fulfill({ status: 503, json: { reason: "fixture outage" } });
    const cells = expiries.flatMap((e,j) => strikes.map((strike,i) => ({
      ...e, expiry:e.label, expIdx:j,strikeIdx:i,strike,
      exposure: state.mode === "ok" ? (i-1)*1000000*(j+1) : 0,
      callOI:100,putOI:50,
    })));
    return r.fulfill({ json: {
      symbol:"$SPX",greek,spot:7000,asOf:Date.now(),weightMode:"oi",strikes,expiries,cells,maxAbs:3000000,
      levels:{callWall:greek==="gex"?7100:null,putWall:greek==="gex"?6900:null,gammaFlip:greek==="gex"?7000:null},
      dataState:state.mode,reason:state.mode==="ok"?null:"Fixture: no usable implied volatility",source:"fixture",
      method:{r:.05,q:.013,contractsUsed:state.mode==="ok"?9:0,contractsNoSigma:state.mode==="ok"?0:9},
    }});
  });
  try {
    await page.goto(base,{waitUntil:"domcontentloaded"});
    await page.getByTestId("tab-regime").click({timeout:30000});
    await page.getByTestId("thermal-heatmap-canvas").waitFor({timeout:30000});
    await page.getByTestId("thermal-scale-global").click();
    assert.equal(await page.getByTestId("thermal-scale-global").getAttribute("aria-pressed"),"true");
    await page.getByTestId("thermal-scale-per-date").click();
    await page.getByTestId("thermal-view-surface").click();
    assert.equal(await page.getByTestId("thermal-view-surface").getAttribute("aria-pressed"),"true");
    assert.equal(await page.getByTestId("thermal-scale-per-date").isDisabled(),true);
    await page.getByTestId("surface-yaw").focus();
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByTestId("surface-yaw").inputValue(),"1");
    await page.getByTestId("surface-yaw").press("End");
    await page.getByTestId("surface-pitch").press("Home");
    await page.getByTestId("surface-pitch").press("End");
    await page.getByTestId("surface-scale-compressed").click();
    assert.equal(await page.getByTestId("surface-scale-compressed").getAttribute("aria-pressed"),"true");
    await page.getByTestId("surface-scale-linear").click();
    checks.push("grid/3D and height scale round trips; keyboard rotation and tilt endpoints; literal pressed states");
    for (const greek of ["vanna","charm","vomma","zomma","gex"]) {
      await page.getByTestId(`thermal-greek-${greek}`).click();
      await page.getByTestId("thermal-surface-canvas").waitFor();
      assert.match(await page.getByTestId("thermal-surface-explanation").innerText(),new RegExp(greek.toUpperCase()));
      assert.match(await page.getByTestId("thermal-heatmap-legend").innerText(),new RegExp(`positive ${greek.toUpperCase()}`));
    }
    await page.getByTestId("thermal-data-table").locator("summary").click();
    await page.getByTestId("thermal-data-table").locator("tbody tr").first().waitFor();
    assert.equal(await page.getByTestId("thermal-data-table").locator("tbody tr").count(),9);
    assert.match(await page.getByTestId("thermal-data-table").innerText(), /-3,000,000/);
    await page.getByTestId("thermal-data-table").locator("summary").click();
    checks.push("all five Greeks correctly labeled; accessible exact-value table matches fixture");
    // Default viewing angles, using actual keyboard inputs.
    await page.getByTestId("surface-yaw").press("Home");
    for(let i=0;i<25;i++) await page.keyboard.press("ArrowRight");
    await page.getByTestId("surface-pitch").press("Home");
    for(let i=0;i<27;i++) await page.keyboard.press("ArrowRight");
    for(const width of [1440,375,820,390,1440]) {
      await page.setViewportSize({width,height:width<500?844:1000});
      await page.getByTestId("thermal-view-surface").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:`${out}/thermal-${width}.png`});
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByTestId("thermal-surface-canvas").scrollIntoViewIfNeeded();
    const box = await page.getByTestId("thermal-surface-canvas").boundingBox();
    let picked=false;
    for(let y=60;y<box.height-20&&!picked;y+=12) {
      for(let x=20;x<box.width-20&&!picked;x+=12) {
        await page.touchscreen.tap(box.x+x,box.y+y);
        picked=await page.getByTestId("thermal-surface-tooltip").count()>0;
      }
    }
    assert.ok(picked,"touch tap selects a real surface node");
    await page.screenshot({path:`${out}/thermal-touch.png`});
    checks.push("desktop/mobile/tablet live resize round trip, no document overflow, real touch point inspection");
    await page.evaluate(()=>document.documentElement.classList.remove("dark"));
    await page.getByTestId("thermal-view-surface").scrollIntoViewIfNeeded();
    await page.screenshot({path:`${out}/thermal-light.png`});
    await page.evaluate(()=>document.documentElement.style.fontSize="200%");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`${out}/thermal-200.png`});
    await page.evaluate(()=>{document.documentElement.style.fontSize="";document.documentElement.classList.add("dark")});
    for(const mode of ["no_iv","empty","error"]) {
      state.mode=mode;
      // New page clears old cached data, leaving no current-looking old plot.
      await page.reload({waitUntil:"domcontentloaded"});
      if(await page.getByTestId("tab-regime").isVisible()) await page.getByTestId("tab-regime").click({timeout:30000});
      else {
        await page.getByTestId("bottomnav-more").click();
        await page.getByTestId("moresheet-regime").click();
      }
      await page.getByTestId(mode==="error"?"thermal-heatmap-error":"thermal-heatmap-state").waitFor({timeout:30000});
      assert.equal(await page.getByTestId("thermal-heatmap-canvas").count(),0);
      await page.getByTestId("thermal-view-surface").click();
      assert.equal(await page.getByTestId("thermal-surface-canvas").count(),0);
    }
    checks.push("missing IV, empty data and provider error withhold both charts");
    assert.deepEqual(errors,[]);
    writeFileSync(`${out}/thermal-results.json`,JSON.stringify({checks,errors},null,2));
    return checks;
  } finally { await ctx.close(); }
}
