import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { centeredScrollLeft, focusScrollDelta, shellGeometry } from "../client/src/hooks/use-shell-layout";

const dashboard = readFileSync("client/src/pages/dashboard.tsx", "utf8");
const css = readFileSync("client/src/index.css", "utf8");
const hook = readFileSync("client/src/hooks/use-shell-layout.ts", "utf8");
const scroller = readFileSync("client/src/components/ShellNavScroller.tsx", "utf8");
const alerts = readFileSync("client/src/components/FlowAlertsPanel.tsx", "utf8");
const base = { header: 72, banner: 36, desktopDock: 0, mobileDock: 66, mobileBottom: 8, dockGap: 8, viewport: 812 };

test("shell offsets follow measured header, banner, mobile height and safe area", () => {
  assert.deepEqual(shellGeometry(base), { flow: false, top: 108, scrollTop: 108, bottom: 74 });
  assert.deepEqual(shellGeometry({ ...base, header: 210, banner: 70, mobileDock: 94, mobileBottom: 42 }),
    { flow: true, top: 0, scrollTop: 0, bottom: 136 });
});

test("desktop offsets include its measured dock without mobile reserve", () => {
  assert.deepEqual(shellGeometry({ ...base, mobileDock: 0, desktopDock: 64, viewport: 900 }),
    { flow: false, top: 108, scrollTop: 180, bottom: 0 });
});

test("short and text-enlarged viewports unpin header, never discard dock clearance", () => {
  assert.deepEqual(shellGeometry({ ...base, header: 210, banner: 80, mobileDock: 94, viewport: 400 }),
    { flow: true, top: 0, scrollTop: 0, bottom: 102 });
  assert.deepEqual(shellGeometry({ ...base, header: 220, mobileDock: 0, desktopDock: 84, viewport: 400 }),
    { flow: true, top: 0, scrollTop: 92, bottom: 0 });
});

test("horizontal centering accounts for padded/positioned parents and clamps both ends", () => {
  assert.equal(centeredScrollLeft(90, 140, 70, 250, 500, 1200), 465);
  assert.equal(centeredScrollLeft(70, 80, 70, 250, 0, 1200), 0);
  assert.equal(centeredScrollLeft(1000, 140, 70, 250, 500, 1200), 950);
  assert.equal(centeredScrollLeft(70, 80, 70, 250, 0, 100), 0);
});

test("keyboard focus only scrolls when shell would obscure its control", () => {
  assert.equal(focusScrollDelta(180, 224, 120, 700), 0);
  assert.equal(focusScrollDelta(100, 144, 120, 700), -20);
  assert.equal(focusScrollDelta(680, 724, 120, 700), 24);
  assert.equal(focusScrollDelta(140, 900, 120, 700), 20);
});

test("all eleven workspace buttons retain native semantics and full accessible names", () => {
  const keys = ["signals", "chart", "models", "heatseeker", "tradedesk", "regime", "cosmos", "news", "takefive", "edgelab", "crypto"];
  for (const key of keys) {
    assert.match(dashboard, new RegExp(`data-testid="tab-${key}"`));
    assert.match(dashboard, new RegExp(`key: "${key}", label:`));
  }
  assert.match(dashboard, /aria-current=\{activeTab === tab\.key \? "page" : undefined\}/);
  assert.match(dashboard, /aria-label=\{tab\.name\}/);
  for (const key of ["Home", "End", "ArrowRight", "ArrowLeft"]) assert.ok(dashboard.includes(`event.key === "${key}"`));
  assert.match(dashboard, /buttons\[next\]\.focus\(\{ preventScroll: true \}\);\s+buttons\[next\]\.click\(\)/);
});

test("scroll affordances are keyboard accessible and honor reduced motion", () => {
  assert.match(scroller, /aria-label="Scroll to earlier workspaces"/);
  assert.match(scroller, /aria-label="Scroll to later workspaces"/);
  assert.match(scroller, /aria-disabled=\{edges\.start\}/);
  assert.match(scroller, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.batcave-nav-scroll-button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  assert.match(css, /\.batcave-nav-strip\s*\{[^}]*scrollbar-width: thin;/);
});

test("shell measures every overlay, responds to visual viewport and cleans listeners", () => {
  assert.match(hook, /for \(const element of \[header, banner, desktop, mobile\]\) observer\?\.observe/);
  assert.match(hook, /getComputedStyle\(mobile\)\.bottom/);
  assert.match(hook, /visualViewport\?\.addEventListener\("resize", schedule\)/);
  assert.match(hook, /visualViewport\?\.removeEventListener\("resize", schedule\)/);
  assert.match(hook, /removeEventListener\("focusin", revealFocus\)/);
  assert.match(hook, /removeProperty\("--batcave-scroll-bottom"\)/);
});

test("header uses reflow and safe focus instead of clipping or a floating launcher", () => {
  assert.match(css, /\.batcave-header-actions\s*\{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.batcave-header-actions button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  assert.match(css, /\.batcave-header \.take5-fab\s*\{[^}]*position: static;/);
  assert.match(dashboard, /data-testid="skip-dashboard-content"/);
  assert.match(dashboard, /<main id="dashboard-main" tabIndex=\{-1\}/);
  const baseStyles = css.slice(css.indexOf("@layer base"), css.indexOf("@layer utilities"));
  assert.doesNotMatch(baseStyles, /overflow-x:\s*(hidden|clip)/);
  const mobileDock = css.match(/\.batcave-mobile-dock\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(mobileDock, /overflow:\s*hidden/);
});

test("short-viewport fallback leaves persistent workspace navigation available", () => {
  const flowRule = css.match(/\.batcave-shell\[data-shell-flow="true"\][^{]+\{[^}]+\}/)?.[0] ?? "";
  assert.ok(flowRule.includes(".batcave-header"));
  assert.ok(flowRule.includes(".batcave-banner"));
  assert.doesNotMatch(flowRule, /batcave-tabs-dock|batcave-mobile-dock/);
  assert.match(css, /padding-bottom: calc\(var\(--batcave-bottom-offset\) \+ 1rem\)/);
});

test("live P/C aggregate reflows its number, zone badge and index/Mag7 details without masking", () => {
  const aggregate = '.batcave-main [data-testid="flow-panel"] > :nth-child(2) > .grid > :first-child';
  const row = css.slice(css.indexOf(aggregate), css.indexOf(".batcave-mobile-dock {"));
  assert.ok(css.includes('.batcave-main [data-testid="flow-panel"] > :first-child > div,'));
  assert.ok(row.includes("flex-wrap: wrap;"));
  assert.ok(row.includes("min-width: 0;"));
  assert.ok(row.includes("max-width: 100%;"));
  assert.ok(row.includes("white-space: normal;"));
  assert.ok(row.includes("overflow-wrap: anywhere;"));
  assert.doesNotMatch(row, /overflow(?:-x)?:\s*(hidden|clip)|font-size/);
});

test("regime banner keeps semantic colors legible on light surfaces without changing dark tints", () => {
  for (const [tone, color] of [["emerald", "#047857"], ["rose", "#be123c"], ["amber", "#92400e"], ["slate", "#334155"]]) {
    assert.ok(css.includes(`:root:not(.dark) .batcave-banner .text-${tone}-400 { color: ${color}; }`));
  }
  assert.match(css, /:root:not\(\.dark\) \.batcave-banner \.text-slate-200/);
});

test("loaded Flow Alerts header separates actions, wraps counts/status and keeps clear-all reachable", () => {
  const selector = '.batcave-main .batcave-flow-alerts-header';
  const rules = css.slice(css.indexOf(selector), css.indexOf(".batcave-mobile-dock {"));
  assert.ok(rules.includes(".batcave-flow-alerts-summary"));
  assert.ok(rules.includes(".batcave-flow-alerts-counts"));
  assert.ok(rules.includes("flex-wrap: wrap;"));
  assert.ok(rules.includes("max-width: 100%;"));
  assert.ok(rules.includes("min-width: 44px;"));
  assert.ok(rules.includes("min-height: 44px;"));
  assert.ok(rules.includes('[data-testid="dismiss-all-alerts"]:focus-visible'));
  assert.doesNotMatch(rules, /overflow(?:-x)?:\s*(hidden|clip)|font-size|display:\s*none/);
  const header = alerts.slice(alerts.indexOf("{/* Header */}"), alerts.indexOf("<CollapsibleContent>"));
  assert.ok(header.indexOf("</CollapsibleTrigger>") < header.indexOf('data-testid="dismiss-all-alerts"'),
    "dismiss button is outside the collapse trigger, not a nested interactive control");
  assert.equal((header.match(/<button type="button"/g) ?? []).length, 2);
  assert.match(header, /aria-label="Clear all flow alerts"/);
  assert.match(header, /onClick=\{dismissAll\}/);
});
