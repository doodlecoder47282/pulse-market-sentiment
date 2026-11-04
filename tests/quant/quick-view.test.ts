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
  assert.match(src("client/src/components/CryptoPanel.tsx"), /data-answer-tab="crypto" data-ready=\{feed \|\| feedError \? "1" : "0"\}/);
  const audit = src("tests/ux/ux-audit.mjs");
  assert.match(audit, /entry\.answerMs = /);
  const budget = JSON.parse(src("tests/ux/budget.json"));
  assert.equal(typeof budget.perTab.answerMs, "number");
  assert.deepEqual(budget.answerExempt, ["edgelab"], "exemptions are named, so a second missing answer cannot hide behind a count");
  assert.match(audit, /entry\.switchMs = Date\.now\(\) - c0;\n    entry\.answerMs = await answerP;/, "switchMs is taken from the network settling, not after the answer wait");
  assert.match(audit, /quick-details-toggle-/, "collapsed sections are opened and measured too");
});

test("headline answer lines: dealer levels from what was read; missing inputs are named", async () => {
  const { levelsLine } = await import("../../shared/headlineLines");
  const m = { spot: 6834.4, dataState: "ok", chainStale: false, band: { atSpot: "long" }, landmarks: { wallAbove: 6850, magnetBelow: 6810, flip: 6800 } };
  assert.equal(levelsLine(m), "SPX 6,834 · wall above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot");
  assert.equal(levelsLine({ ...m, band: { atSpot: "indeterminate" }, landmarks: { wallAbove: null, magnetBelow: null, flip: null } }), "SPX 6,834 · no wall above in band · no flip in band · no magnet below in band · gamma sign not determined");
  assert.equal(levelsLine({ ...m, landmarks: { wallAbove: null, magnetBelow: 6810, flip: 6800, pin: 6850 } }), "SPX 6,834 · pin above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot", "the pin fills a missing wall, labelled as the pin, as on the Today card");
  assert.equal(levelsLine({ ...m, landmarks: { wallAbove: 6850, magnetBelow: null, flip: null, pin: 6820 } }), "SPX 6,834 · wall above 6,850 · no flip in band · pin below 6,820 · long gamma at spot");
  assert.equal(levelsLine({ ...m, dataState: "no_gex", reason: "not priced (closed market or no implied vols)" }), "SPX 6,834 · dealer levels not formed (not priced (closed market or no implied vols))");
  assert.match(String(levelsLine({ ...m, chainStale: true })), /chain stale$/);
  assert.match(String(levelsLine({ ...m, dataState: "stale_session" })), /session closed, last map of the day$/, "a closed session is not a stale chain");
  for (const bad of [null, undefined, { ...m, spot: 0 }, { ...m, spot: NaN }]) assert.equal(levelsLine(bad as any), null);
  // The market tabs lead with the answer, not a description of the tab.
  const h = src("server/headline.ts");
  assert.doesNotMatch(h, /topLine: "0DTE SPX live Greek scanner/);
  assert.doesNotMatch(h, /topLine: "Whale flow —/);
  assert.match(h, /topLine: levels \?\? levelsMissing/);
  assert.match(h, /mapWhy/, "the missing-levels line carries the map's own reason");
  assert.doesNotMatch(h, /topLine: headlineRegime \|\| \(known \? `\$\{cap\(regimeWord\(currentRegime\)\)\} regime; the 20-minute/, "Trade Desk does not lead with forecast wording");
  assert.match(h, /the predictor did not answer/);
});
