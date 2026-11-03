// Quick view: every tab answers first; supporting panels sit behind one tap on
// phones; the CI audit times the answer. Source guards (the quant suite does not
// render React); the rendered behaviour is checked by tests/ux/ux-audit.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("QuickDetails starts closed under 1024 px, remembers the reader's choice, and does not mount closed content", () => {
  const q = src("client/src/components/QuickDetails.tsx");
  assert.match(q, /window\.innerWidth >= 1024/);
  assert.match(q, /\{open && children\}/, "closed sections do not mount, so their requests do not run");
  assert.match(q, /try \{ window\.localStorage\.setItem/);
  assert.match(q, /min-h-\[44px\]/, "the toggle is a full tap target");
});

test("the answer stays outside the collapsed detail on Signals, Models and Crypto", () => {
  const d = src("client/src/pages/dashboard.tsx");
  const sig = d.slice(d.indexOf('<TabsContent value="signals"'), d.indexOf("</TabsContent>", d.indexOf('<TabsContent value="signals"')));
  const cut = sig.indexOf('<QuickDetails id="signals-detail"');
  assert.ok(cut > 0);
  for (const keep of ['<TabHeadline tab="signals"', "<TodayCard", "<TickerScanCard", "<WidgetStack tab=\"signals\""]) {
    const at = sig.indexOf(keep);
    assert.ok(at > 0 && at < cut, `${keep} stays above the fold`);
  }
  const models = d.slice(d.indexOf('<TabsContent value="models"'), d.indexOf("</TabsContent>", d.indexOf('<TabsContent value="models"')));
  assert.ok(models.indexOf("<ModelsPanel") < models.indexOf('<QuickDetails id="models-detail"'));
  const c = src("client/src/components/CryptoPanel.tsx");
  assert.ok(c.indexOf("<DeskBrief") < c.indexOf('<QuickDetails id="crypto-context"'));
  assert.ok(c.indexOf("<AutopsyCard") < c.indexOf('<QuickDetails id="crypto-context"'));
});

test("answer lines carry the marker the audit times", () => {
  assert.match(src("client/src/components/TabHeadline.tsx"), /data-answer-tab=\{tab\} data-ready="1"/);
  assert.match(src("client/src/components/CryptoPanel.tsx"), /data-answer-tab="crypto" data-ready=\{feed \? "1" : "0"\}/);
  const audit = src("tests/ux/ux-audit.mjs");
  assert.match(audit, /entry\.answerMs = /);
  const budget = JSON.parse(src("tests/ux/budget.json"));
  assert.equal(typeof budget.perTab.answerMs, "number");
  assert.equal(typeof budget.tabsWithoutAnswer, "number");
});

test("headline answer lines: dealer levels and whale counts from what was read; missing inputs are named", async () => {
  const { levelsLine, whaleLine } = await import("../../shared/headlineLines");
  const m = { spot: 6834.4, dataState: "ok", chainStale: false, band: { atSpot: "long" }, landmarks: { wallAbove: 6850, magnetBelow: 6810, flip: 6800 } };
  assert.equal(levelsLine(m), "SPX 6,834 · wall above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot");
  assert.equal(levelsLine({ ...m, band: { atSpot: "indeterminate" }, landmarks: { wallAbove: null, magnetBelow: null, flip: null } }), "SPX 6,834 · no dealer level inside the band · gamma sign not determined");
  assert.equal(levelsLine({ ...m, dataState: "no_gex" }), "SPX 6,834 · dealer levels not formed (no gamma in the chain)");
  assert.match(String(levelsLine({ ...m, chainStale: true })), /chain stale$/);
  for (const bad of [null, undefined, { ...m, spot: 0 }, { ...m, spot: NaN }]) assert.equal(levelsLine(bad as any), null);
  const now = 10_000_000;
  const w = (type: string, ago: number) => ({ type, detectedAt: now - ago });
  assert.equal(whaleLine([], now), "No whale flow this hour");
  assert.equal(whaleLine([w("C", 1), w("C", 2), w("P", 3)], now), "3 whales this hour, calls leading 2-1");
  assert.equal(whaleLine([w("P", 1), w("P", 2)], now), "2 whales this hour, puts leading 2-0");
  assert.equal(whaleLine([w("C", 1), w("P", 2)], now), "2 whales this hour, mixed (1 calls / 1 puts)");
  assert.equal(whaleLine([w("C", 61 * 60_000)], now), "No whale flow this hour", "older than an hour is not counted");
  // The market tabs lead with the answer, not a description of the tab.
  const h = src("server/headline.ts");
  assert.doesNotMatch(h, /topLine: "0DTE SPX live Greek scanner/);
  assert.doesNotMatch(h, /topLine: "Whale flow —/);
  assert.match(h, /topLine: levels \?\? "Dealer levels unavailable/);
});
