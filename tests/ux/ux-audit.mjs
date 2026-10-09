// UX audit: every tab at six viewports. Screenshots + layout/readability metrics.
// Run in CI against a production build on BASE_URL. Writes rep/ux/.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:5070";
const OUT = process.env.UX_OUT || "rep/ux";
const tabs = ["signals", "chart", "models", "heatseeker", "tradedesk", "regime", "cosmos", "news", "takefive", "edgelab", "crypto"];
const viewports = [
  { name: "phone-se", width: 375, height: 667, mobile: true },
  { name: "phone-15", width: 393, height: 852, mobile: true },
  { name: "tablet-portrait", width: 768, height: 1024, mobile: true },
  { name: "tablet-landscape", width: 1024, height: 768, mobile: true },
  { name: "laptop", width: 1440, height: 900, mobile: false },
  { name: "wide", width: 1920, height: 1080, mobile: false },
];

// Runs in the page: layout and readability metrics for the current view.
function measure(isMobile) {
  const vw = window.innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const label = (el) => {
    const t = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const tid = el.getAttribute("data-testid");
    return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${t}"`;
  };
  // Is the element inside a horizontally scrollable container (intended overflow)?
  const inXScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth) return true;
      if (ox === "hidden" && p.getBoundingClientRect().right <= vw + 1) return true; // clipped by an in-view parent
    }
    return false;
  };
  const all = Array.from(document.querySelectorAll("body *")).filter(visible);
  const docOverflowX = document.documentElement.scrollWidth - vw;
  const offscreen = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 && r.left < vw && !inXScroller(el)) offscreen.push(label(el));
  }
  // Text clipped without an ellipsis (content wider/taller than its box, overflow hidden).
  const clipped = [];
  for (const el of all) {
    if (!el.childNodes.length || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const hidesX = cs.overflowX === "hidden" || cs.overflow === "hidden";
    if (hidesX && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== "ellipsis") clipped.push(label(el));
  }
  // Tap targets (mobile): interactive elements under 44x44 CSS px (Apple HIG) / 24x24 (WCAG 2.2 minimum).
  const interactive = all.filter((el) => el.matches("button, a[href], [role=button], [role=tab], input, select, textarea, [role=switch], [role=checkbox]"));
  const smallTargets = [], tinyTargets = [];
  if (isMobile) {
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) tinyTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      else if (r.width < 44 || r.height < 44) smallTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  // Text size and contrast on elements that own text.
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let p = el; p; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (c && c.a > 0.5) return c; } return parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 }; };
  let textEls = 0, tinyText = 0, smallText = 0, lowContrast = 0;
  const lowContrastSamples = [], tinySamples = [];
  const fontSizes = {};
  for (const el of all) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ");
    if (!own) continue;
    textEls++;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    fontSizes[Math.round(fs)] = (fontSizes[Math.round(fs)] || 0) + 1;
    if (fs < 10) { tinyText++; if (tinySamples.length < 8) tinySamples.push(`${fs}px ${label(el)}`); }
    else if (fs < 12) smallText++;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const a = fg.a; const blend = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(blend), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = fs >= 18.66 || (fs >= 14 && parseInt(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) { lowContrast++; if (lowContrastSamples.length < 8) lowContrastSamples.push(`${ratio.toFixed(2)} ${fs}px ${label(el)}`); }
  }
  // Distinct accent colors in use (rough "does it pop" signal).
  const colors = new Set();
  for (const el of all) { const c = getComputedStyle(el).color; colors.add(c); }
  return {
    docOverflowX, scrollHeight: document.documentElement.scrollHeight,
    offscreenCount: offscreen.length, offscreen: offscreen.slice(0, 10),
    clippedCount: clipped.length, clipped: clipped.slice(0, 10),
    interactiveCount: interactive.length,
    smallTargetCount: smallTargets.length, smallTargets: smallTargets.slice(0, 10),
    tinyTargetCount: tinyTargets.length, tinyTargets: tinyTargets.slice(0, 10),
    textEls, tinyText, smallText, tinySamples,
    lowContrast, lowContrastSamples, fontSizes,
    distinctTextColors: colors.size,
  };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const report = [];
for (const vp of viewports) {
  mkdirSync(`${OUT}/${vp.name}`, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160)); });
  await p.addInitScript(() => {
    window.__cls = 0; window.__longTasks = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks += e.duration; }).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  const t0 = Date.now();
  await p.goto(`${BASE}/#/`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  const firstLoadMs = Date.now() - t0;
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/${vp.name}/00-first-screen.png` });
  // The pre-market checklist is opt-in (off by default); dismiss it if shown.
  const skip = p.locator('[data-testid="button-premarket-skip"]');
  if (await skip.count()) await skip.first().click({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const gateGone = (await p.locator('[data-testid="tab-signals"]').first().isVisible().catch(() => false))
    || (await p.locator('[data-testid="bottomnav-signals"]').first().isVisible().catch(() => false));
  console.log(vp.name, "tabs visible after gates:", gateGone);
  for (const [i, t] of tabs.entries()) {
    // Phones use the bottom nav; tablets and desktops use the tab row.
    const top = p.locator(`[data-testid="tab-${t}"]`);
    const bottom = p.locator(`[data-testid="bottomnav-${t}"]`);
    const btn = (await top.first().isVisible().catch(() => false)) || !(await bottom.count()) ? top : bottom;
    const entry = { viewport: vp.name, width: vp.width, tab: t };
    if (!(await btn.count())) { entry.missing = true; report.push(entry); continue; }
    entry.tabButtonVisible = await btn.first().isVisible();
    await p.evaluate(() => { window.__cls = 0; window.__longTasks = 0; window.scrollTo(0, 0); });
    const c0 = Date.now();
    if (!entry.tabButtonVisible) await btn.first().scrollIntoViewIfNeeded().catch(() => {});
    await btn.first().click({ timeout: 5000 }).catch((e) => { entry.clickError = e.message.split("\n")[0]; });
    await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    entry.switchMs = Date.now() - c0;
    await p.waitForTimeout(2500);
    entry.cls = await p.evaluate(() => Math.round(window.__cls * 1000) / 1000);
    entry.longTaskMs = await p.evaluate(() => Math.round(window.__longTasks));
    Object.assign(entry, await p.evaluate(measure, vp.mobile));
    await p.screenshot({ path: `${OUT}/${vp.name}/${String(i + 1).padStart(2, "0")}-${t}.png` });
    report.push(entry);
  }
  report.push({ viewport: vp.name, firstLoadMs, pageErrors: errors.slice(0, 20), pageErrorCount: errors.length });
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}/metrics.json`, JSON.stringify(report, null, 1));
console.log("ux audit done", report.length);
