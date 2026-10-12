// UX audit: every tab at eight viewports (two phones, iPad portrait and
// landscape, a 13-inch iPad landscape, laptop, wide). Screenshots +
// layout/readability metrics. Touch viewports emulate a coarse pointer
// through CDP so the CSS touch rules apply exactly as on a real iPhone/iPad.
// Run in CI against a production build on BASE_URL. Writes rep/ux/.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:5070";
const OUT = process.env.UX_OUT || "rep/ux";
const tabs = ["signals", "chart", "models", "heatseeker", "tradedesk", "regime", "cosmos", "news", "takefive", "edgelab", "crypto"];
const viewports = [
  { name: "phone-se", width: 375, height: 667, mobile: true },
  { name: "phone-15", width: 393, height: 852, mobile: true },
  { name: "tablet-portrait", width: 820, height: 1180, mobile: true },    // iPad Air / Pro 11
  { name: "tablet-landscape", width: 1180, height: 820, mobile: true },
  { name: "tablet-13-landscape", width: 1376, height: 1032, mobile: true }, // iPad Pro 13
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
  // Overlapping text: two text-bearing elements whose VISIBLE boxes intersect
  // while neither contains the other (labels drawn over each other, cards
  // colliding). Boxes are clipped to overflow-hidden/scroll ancestors (a
  // marquee's off-screen text is not an overlap), elements inside fixed or
  // absolute layers (bottom bar, pills, tooltips) are skipped, SVG text is
  // counted separately (chart tick labels).
  const clipBox = (el) => {
    let r = el.getBoundingClientRect();
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.position === "fixed" || cs.position === "absolute") return null;
      const ox = cs.overflowX, oy = cs.overflowY;
      if (ox !== "visible" || oy !== "visible") {
        const pr = p.getBoundingClientRect();
        if (ox !== "visible") { box.left = Math.max(box.left, pr.left); box.right = Math.min(box.right, pr.right); }
        if (oy !== "visible") { box.top = Math.max(box.top, pr.top); box.bottom = Math.min(box.bottom, pr.bottom); }
      }
    }
    return box.right - box.left > 4 && box.bottom - box.top > 4 ? box : null;
  };
  const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
  const textLeaves = [], svgLeaves = [];
  for (const el of all) {
    if (!ownText(el) || !(el.innerText || el.textContent || "").trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "absolute") continue;
    const box = clipBox(el);
    if (!box) continue;
    (el.ownerSVGElement ? svgLeaves : textLeaves).push({ el, r: box });
  }
  const findOverlaps = (items, cap) => {
    items.sort((a, b) => a.r.top - b.r.top);
    const out = [];
    for (let i = 0; i < items.length && out.length < cap; i++) {
      const A = items[i];
      for (let j = i + 1; j < items.length; j++) {
        const B = items[j];
        if (B.r.top >= A.r.bottom - 4) break;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const ix = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
        const iy = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
        if (ix > 4 && iy > 4) { out.push(`${label(A.el)} x ${label(B.el)}`); if (out.length >= cap) break; }
      }
    }
    return out;
  };
  const overlaps = findOverlaps(textLeaves, 40);
  const svgOverlaps = findOverlaps(svgLeaves, 40);
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
    overlapCount: overlaps.length, overlaps: overlaps.slice(0, 10),
    svgOverlapCount: svgOverlaps.length, svgOverlaps: svgOverlaps.slice(0, 6),
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
  if (vp.mobile) {
    // Real iPhones and iPads report (pointer: coarse) and (hover: none); the
    // CSS touch rules key on them, so force them whatever Playwright's version does.
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }, { name: "any-pointer", value: "coarse" }] });
  }
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160)); });
  await p.addInitScript(() => {
    window.__cls = 0; window.__longTasks = 0; window.__shifts = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__cls += e.value;
          // Which elements moved (largest shifts first in the report).
          for (const s of e.sources || []) {
            const n = s.node;
            if (!n || n.nodeType !== 1) continue;
            const tid = n.getAttribute("data-testid");
            const txt = (n.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
            window.__shifts.push({ v: Math.round(e.value * 1000) / 1000, el: `${n.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${txt}"`, dy: Math.round((s.currentRect?.y ?? 0) - (s.previousRect?.y ?? 0)) });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
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
    await p.evaluate(() => { window.__cls = 0; window.__longTasks = 0; window.__shifts = []; window.scrollTo(0, 0); });
    const c0 = Date.now();
    if (!entry.tabButtonVisible && btn === bottom && (await p.locator('[data-testid="bottomnav-more"]').count())) {
      // Phone: secondary tabs live in the "More" sheet.
      entry.viaMore = true;
      await p.locator('[data-testid="bottomnav-more"]').click({ timeout: 5000 }).catch(() => {});
      await p.locator(`[data-testid="moresheet-${t}"]`).click({ timeout: 5000 }).catch((e) => { entry.clickError = e.message.split("\n")[0]; });
    } else {
      if (!entry.tabButtonVisible) await btn.first().scrollIntoViewIfNeeded().catch(() => {});
      await btn.first().click({ timeout: 5000 }).catch((e) => { entry.clickError = e.message.split("\n")[0]; });
    }
    await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    entry.switchMs = Date.now() - c0;
    // Layout shift in two windows: while the tab loads (skeleton -> content,
    // expected in a data app, kept under a loose ceiling) and after its data
    // has arrived (shifts while the user is reading: the strict budget).
    entry.clsLoad = await p.evaluate(() => Math.round(window.__cls * 1000) / 1000);
    if (entry.clsLoad > 0.05) entry.shiftsLoad = await p.evaluate(() => window.__shifts.sort((a, b) => b.v - a.v).slice(0, 6));
    await p.evaluate(() => { window.__cls = 0; window.__shifts = []; });
    await p.waitForTimeout(2500);
    entry.cls = await p.evaluate(() => Math.round(window.__cls * 1000) / 1000);
    if (entry.cls > 0.05) entry.shifts = await p.evaluate(() => window.__shifts.sort((a, b) => b.v - a.v).slice(0, 6));
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

// ── Scorecard: the user's questions as pass/fail checks ────────────────────
// "Does it fit my device?" (overflow, clipped text, off-screen), "does it
// react to my touch?" (tap targets, switch time, layout shift), "can I read
// it?" (tiny text, contrast), "does it work?" (page errors). Ceilings live in
// tests/ux/budget.json; this run fails when any is exceeded.
{
  const { readFileSync } = await import("node:fs");
  const budget = JSON.parse(readFileSync(new URL("./budget.json", import.meta.url), "utf8"));
  const pick = (m, vp) => (typeof m === "number" ? m : (m[vp] ?? m.default));
  const failures = [];
  const scorecard = {};
  for (const vp of viewports.map((v) => v.name)) {
    const tabsHere = report.filter((e) => e.viewport === vp && e.tab && !e.missing);
    const meta = report.find((e) => e.viewport === vp && !e.tab) ?? {};
    const sum = (k) => tabsHere.reduce((a, e) => a + (e[k] ?? 0), 0);
    const s = {
      docOverflowX: Math.max(0, ...tabsHere.map((e) => e.docOverflowX ?? 0)),
      clippedText: sum("clippedCount"),
      offscreen: sum("offscreenCount"),
      overlappingText: sum("overlapCount"),
      overlappingSvgText: sum("svgOverlapCount"),
      tapTargetsUnder24: sum("tinyTargetCount"),
      pageErrorsExcluding503: (meta.pageErrors ?? []).filter((x) => !/\b503\b/.test(x)).length,
      worstTab: {
        textUnder10px: Math.max(0, ...tabsHere.map((e) => e.tinyText ?? 0)),
        contrastFailures: Math.max(0, ...tabsHere.map((e) => e.lowContrast ?? 0)),
        cls: Math.max(0, ...tabsHere.map((e) => e.cls ?? 0)),
        clsLoad: Math.max(0, ...tabsHere.map((e) => e.clsLoad ?? 0)),
        tabSwitchMs: Math.max(0, ...tabsHere.map((e) => e.switchMs ?? 0)),
      },
      tabsMeasured: tabsHere.length,
    };
    scorecard[vp] = s;
    const pv = budget.perViewport;
    for (const k of ["docOverflowX", "clippedText", "pageErrorsExcluding503"]) if (s[k] > pv[k]) failures.push(`${vp}: ${k} ${s[k]} > ${pv[k]}`);
    for (const k of ["offscreen", "tapTargetsUnder24", "overlappingText"]) if (pv[k] != null && s[k] > pick(pv[k], vp)) failures.push(`${vp}: ${k} ${s[k]} > ${pick(pv[k], vp)}`);
    for (const [k, lim] of Object.entries(budget.perTab)) if (s.worstTab[k] > lim) failures.push(`${vp}: worst tab ${k} ${s.worstTab[k]} > ${lim}`);
    if (s.tabsMeasured < tabs.length) failures.push(`${vp}: only ${s.tabsMeasured} of ${tabs.length} tabs measured`);
  }
  writeFileSync(`${OUT}/scorecard.json`, JSON.stringify({ scorecard, failures }, null, 1));
  console.log("UX scorecard:", JSON.stringify(scorecard));
  if (failures.length) {
    console.log("UX budget exceeded:\n  " + failures.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("UX budget: all checks pass");
  }
}
