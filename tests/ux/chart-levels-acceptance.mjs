// Chart levels acceptance (PR #47): run in CI against the exact build under
// test. Levels are drawn only on candles of their own underlying.
//
// The S&P 500 index request goes to the REAL server route (it answers before
// any market read, so no Schwab is needed). SPY and NVDA candles and levels
// are fixtures with fixed numbers, so the expected distances are exact; the
// SPY levels reply is delayed to expose a late answer landing after a switch.
// Writes screenshots, the observed level replies and a JSON report to OUT.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:5071";
const OUT = process.env.CHART_OUT || "rep/ux/chart-levels";
mkdirSync(OUT, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const bars = (close, n = 60) => Array.from({ length: n }, (_, i) => {
  const c = close + Math.sin(i / 5) * close * 0.002 - (n - 1 - i) * close * 0.00005;
  return { t: now - (n - i) * 300, o: c, h: c * 1.001, l: c * 0.999, c: i === n - 1 ? close : c, v: 1000 };
});
const ohlc = (symbol, close) => ({
  symbol, displayName: symbol, timeframe: "1D", interval: "5m", price: close, prevClose: close * 0.995,
  change: close * 0.005, changePct: 0.5, sessionHigh: close * 1.002, sessionLow: close * 0.997,
  candles: bars(close), asOf: now, dataAsOfMs: Date.now(), dataState: "ok", dataReason: null,
});
const levels = (callWall, putWall, flip) => ({
  callWall, callWallGex: 1e9, putWall, putWallGex: -1e9, zeroGamma: flip, flip, maxPain: flip, totalGex: 2e9, regime: "positive", profile: [],
});
const FIX = {
  SPY: { ohlc: ohlc("SPY", 685.2), gamma: { symbol: "SPY", supported: true, spot: 685.2, levels: levels(690, 680, 684.9), asOf: now }, gammaDelayMs: 1200 },
  NVDA: { ohlc: ohlc("NVDA", 186), gamma: { symbol: "NVDA", supported: true, spot: 186, levels: levels(190, 180, 185), asOf: new Date().toISOString() }, gammaDelayMs: 0 },
  "^GSPC": { ohlc: ohlc("^GSPC", 6834.4) }, // levels: real server route
};

const report = { base: BASE, startedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, checks: [], replies: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`); };

async function setup(browser, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/ohlc?**", (r) => {
    const sym = new URL(r.request().url()).searchParams.get("symbol");
    const f = FIX[sym];
    return f ? r.fulfill({ json: f.ohlc }) : r.continue();
  });
  await page.route("**/api/gamma-levels?**", async (r) => {
    const sym = new URL(r.request().url()).searchParams.get("symbol");
    const f = FIX[sym];
    if (!f || !f.gamma) return r.continue(); // the index: real server route
    if (f.gammaDelayMs) await new Promise((res) => setTimeout(res, f.gammaDelayMs));
    return r.fulfill({ json: f.gamma });
  });
  page.on("response", async (res) => {
    if (!res.url().includes("/api/gamma-levels")) return;
    try { report.replies.push({ viewport: viewport.width, url: res.url().replace(BASE, ""), status: res.status(), body: await res.json() }); } catch { /* not json */ }
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const tab = page.locator('[data-testid="tab-chart"]');
  if (await tab.isVisible().catch(() => false)) await tab.click();
  else { await page.locator('[data-testid="bottomnav-chart"]').scrollIntoViewIfNeeded(); await page.locator('[data-testid="bottomnav-chart"]').click(); }
  await page.locator('[data-testid="chart-panel"]').waitFor({ timeout: 30000 });
  return { ctx, page, errors };
}

const chartEl = (page, engine) => page.locator(`[data-chart-engine="${engine}"]`).first();
async function selectSymbol(page, sym) {
  const btn = page.locator(`[data-testid="watchlist-${sym}"]`);
  if (await btn.count()) await btn.first().click();
  else { await page.locator('[data-testid="input-add-ticker"]').fill(sym); await page.locator('[data-testid="button-add-ticker"]').click(); }
  await page.locator('[data-testid="text-chart-symbol"]').filter({ hasText: sym }).waitFor({ timeout: 10000 });
}
async function selectEngine(page, engine) {
  await page.locator(`[data-testid="engine-${engine === "svg" ? "svg" : "light"}"]`).click();
  await chartEl(page, engine).waitFor({ timeout: 15000 });
}

const browser = await chromium.launch();
for (const [vpName, viewport, mobile] of [["desktop", { width: 1280, height: 900 }, false], ["phone-402", { width: 402, height: 874 }, true]]) {
  const { ctx, page, errors } = await setup(browser, viewport, mobile);
  for (const engine of ["lightweight", "svg"]) {
    const tag = `${vpName}/${engine}`;
    await selectEngine(page, engine);

    // 1. SPY: SPY levels drawn; banner distances from SPY's own price.
    await selectSymbol(page, "SPY");
    await page.waitForFunction((e) => document.querySelector(`[data-chart-engine="${e}"]`)?.getAttribute("data-gamma-callwall") === "690", engine, { timeout: 15000 }).catch(() => {});
    const spyWall = await chartEl(page, engine).getAttribute("data-gamma-callwall");
    const spyClose = await chartEl(page, engine).getAttribute("data-last-close");
    const banner = (await page.locator('[data-testid="gamma-context-banner"]').innerText().catch(() => "")).replace(/\s+/g, " ");
    check(`${tag} SPY: SPY call wall drawn on SPY candles`, spyWall === "690" && spyClose === "685.2", `wall ${spyWall}, last close ${spyClose}`);
    check(`${tag} SPY: banner distance uses SPY price (+4.80 · +0.70%)`, /\+4\.80 · \+0\.70%/.test(banner), banner.slice(0, 160));
    await page.screenshot({ path: `${OUT}/${vpName}-${engine}-1-spy.png`, fullPage: false });

    // 2. The index: candles usable, no SPY levels, reason readable.
    await selectSymbol(page, "^GSPC");
    await page.locator('[data-testid="gamma-banner-unsupported-reason"]').waitFor({ timeout: 15000 }).catch(() => {});
    const idxWall = await chartEl(page, engine).getAttribute("data-gamma-callwall").catch(() => null);
    const idxClose = await chartEl(page, engine).getAttribute("data-last-close").catch(() => null);
    const reason = await page.locator('[data-testid="gamma-banner-unsupported-reason"]').innerText().catch(() => "");
    check(`${tag} index: candles present`, idxClose === "6834.4", `last close ${idxClose}`);
    check(`${tag} index: no levels drawn`, idxWall === "", `data-gamma-callwall="${idxWall}"`);
    check(`${tag} index: reason shown`, /SPY's price scale/.test(reason), reason.slice(0, 120));
    if (vpName === "phone-402") {
      const box = await page.locator('[data-testid="gamma-banner-unsupported-reason"]').boundingBox();
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${tag} 402px: no sideways page scroll`, overflowX <= 1, `overflow ${overflowX}px`);
      check(`${tag} 402px: reason inside the screen`, !!box && box.x >= 0 && box.x + box.width <= 402 + 1, box ? `x ${Math.round(box.x)} w ${Math.round(box.width)}` : "not found");
    }
    await page.screenshot({ path: `${OUT}/${vpName}-${engine}-2-index.png`, fullPage: false });

    // 3. Rapid SPY -> index -> NVDA with the SPY levels reply arriving late:
    //    sample every 40 ms; a level may only ever be on its own symbol.
    await page.evaluate(() => { window.__levelSamples = []; const t = setInterval(() => {
      const el = document.querySelector("[data-chart-engine]"); const sym = document.querySelector('[data-testid="text-chart-symbol"]')?.textContent?.trim();
      window.__levelSamples.push({ sym, wall: el?.getAttribute("data-gamma-callwall") ?? null }); }, 40); window.__stopSampling = () => clearInterval(t); });
    await page.locator('[data-testid="watchlist-SPY"]').click();
    await page.locator('[data-testid="watchlist-^GSPC"]').click();
    await page.locator('[data-testid="input-add-ticker"]').fill("NVDA");
    await page.locator('[data-testid="button-add-ticker"]').click();
    await page.waitForTimeout(2500); // past the delayed SPY reply
    const samples = await page.evaluate(() => { window.__stopSampling(); return window.__levelSamples; });
    const expected = { SPY: ["", "690"], "^GSPC": [""], NVDA: ["", "190"] };
    const wrong = samples.filter((s) => s.sym && expected[s.sym] && s.wall != null && !expected[s.sym].includes(s.wall));
    check(`${tag} rapid switch: no level ever shown on another symbol`, wrong.length === 0, `${samples.length} samples, ${wrong.length} wrong${wrong[0] ? ` e.g. ${JSON.stringify(wrong[0])}` : ""}`);
    const nvdaWall = await chartEl(page, engine).getAttribute("data-gamma-callwall");
    check(`${tag} rapid switch: settles on NVDA's own levels`, nvdaWall === "190", `wall ${nvdaWall}`);
    await page.screenshot({ path: `${OUT}/${vpName}-${engine}-3-after-switch.png`, fullPage: false });
  }
  check(`${vpName}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
await browser.close();

const idx = report.replies.find((r) => r.url.includes("symbol=%5EGSPC") || r.url.includes("symbol=^GSPC"));
check("server: index route answers unsupported with no levels and a reason", !!idx && idx.body?.supported === false && idx.body?.levels === null && /SPY's price scale/.test(idx.body?.reason ?? ""), idx ? JSON.stringify(idx.body).slice(0, 200) : "no index reply seen");
report.finishedAt = new Date().toISOString();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
const failed = report.checks.filter((c) => !c.ok);
console.log(failed.length ? `CHART LEVELS: ${failed.length} of ${report.checks.length} checks failed` : `CHART LEVELS: all ${report.checks.length} checks pass`);
process.exit(failed.length ? 1 : 0);
