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

test("headline answer lines: dealer levels and whale counts from what was read; missing inputs are named", async () => {
  const { levelsLine, whaleLine } = await import("../../shared/headlineLines");
  const m = { spot: 6834.4, dataState: "ok", chainStale: false, band: { atSpot: "long" }, landmarks: { wallAbove: 6850, magnetBelow: 6810, flip: 6800 } };
  assert.equal(levelsLine(m), "SPX 6,834 · wall above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot");
  assert.equal(levelsLine({ ...m, band: { atSpot: "indeterminate" }, landmarks: { wallAbove: null, magnetBelow: null, flip: null } }), "SPX 6,834 · no wall above in band · no flip in band · no magnet below in band · gamma sign not determined");
  assert.equal(levelsLine({ ...m, landmarks: { wallAbove: null, magnetBelow: 6810, flip: 6800, pin: 6850 } }), "SPX 6,834 · pin above 6,850 · flip 6,800 · magnet below 6,810 · long gamma at spot", "the pin fills a missing wall, labelled as the pin, as on the Today card");
  assert.equal(levelsLine({ ...m, landmarks: { wallAbove: 6850, magnetBelow: null, flip: null, pin: 6820 } }), "SPX 6,834 · wall above 6,850 · no flip in band · pin below 6,820 · long gamma at spot");
  assert.equal(levelsLine({ ...m, dataState: "no_gex", reason: "not priced (closed market or no implied vols)" }), "SPX 6,834 · dealer levels not formed (not priced (closed market or no implied vols))");
  assert.match(String(levelsLine({ ...m, chainStale: true })), /chain stale$/);
  assert.match(String(levelsLine({ ...m, dataState: "stale_session" })), /session closed, last map of the day$/, "a closed session is not a stale chain");
  for (const bad of [null, undefined, { ...m, spot: 0 }, { ...m, spot: NaN }]) assert.equal(levelsLine(bad as any), null);
  const now = 10_000_000;
  const w = (type: string, ago: number) => ({ type, detectedAt: now - ago });
  assert.equal(whaleLine([], now, "fresh"), "No whale flow this hour");
  assert.equal(whaleLine([w("C", 1), w("C", 2), w("P", 3)], now, "fresh"), "3 whales this hour, calls leading 2-1");
  assert.equal(whaleLine([w("P", 1), w("P", 2)], now, "fresh"), "2 whales this hour, puts leading 2-0");
  assert.equal(whaleLine([w("C", 1), w("P", 2)], now, "fresh"), "2 whales this hour, mixed (1 calls / 1 puts)");
  assert.equal(whaleLine([w("C", 61 * 60_000)], now, "fresh"), "No whale flow this hour", "older than an hour is not counted");
  // A stopped or stale scanner is never a quiet tape.
  assert.equal(whaleLine([], now, "not_running"), "Whale scan not running: no flow read this hour");
  assert.equal(whaleLine([], now, "stale"), "Whale scan stale: no fresh flow read this hour");
  assert.equal(whaleLine([], now, "unknown"), "Whale scan state unknown: no flow read this hour");
  assert.equal(whaleLine([w("C", 1)], now, "stale"), "1 whale this hour, calls leading 1-0 (whale scan stale)");
  const { scanState } = await import("../../shared/headlineLines");
  assert.equal(scanState(null, now), "unknown");
  assert.equal(scanState({ running: false, lastEvalAt: now }, now), "not_running");
  assert.equal(scanState({ running: true, lastEvalAt: now - 4 * 60_000 }, now), "stale");
  assert.equal(scanState({ running: true, lastEvalAt: null }, now), "stale");
  assert.equal(scanState({ running: true, lastEvalAt: now - 30_000 }, now), "fresh");
  // The market tabs lead with the answer, not a description of the tab.
  const h = src("server/headline.ts");
  assert.doesNotMatch(h, /topLine: "0DTE SPX live Greek scanner/);
  assert.doesNotMatch(h, /topLine: "Whale flow —/);
  assert.match(h, /topLine: levels \?\? levelsMissing/);
  assert.match(h, /mapWhy/, "the missing-levels line carries the map's own reason");
  assert.doesNotMatch(h, /topLine: headlineRegime \|\| \(known \? `\$\{cap\(regimeWord\(currentRegime\)\)\} regime; the 20-minute/, "Trade Desk does not lead with forecast wording");
  assert.match(h, /the predictor did not answer/);
});
