// The strip above the tabs in plain words.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripRead, STRIP_LABELS } from "../../shared/stripRead";

// Live 2026-11-25 3:17 AM ET: "Volatility expansion — VIX backwardation (26.7/28.3/25.5) + dealers short gamma", NET GEX -16%.
const live = { vix9d: 26.7, vix: 28.3, vix3m: 25.5, vixChangePct: 7.47, termState: "backwardation", gexRegime: "short_gamma", gexShare: -0.16 };

test("the worked example reads without jargon and says which options it counts", () => {
  const r = stripRead("vol_expansion", live);
  assert.equal(r.label, "Stress rising");
  assert.equal(r.sentence, "Stress rising: the fear gauge (VIX) is 28.3, up 7.5% today, short-term fear is above longer-term (traders are paying up for protection now), and across SPX options out to 30 days the model has dealer hedging leaning with moves (bigger swings).");
  assert.deepEqual(r.facts, ["VIX: 9-day 26.7 · 30-day 28.3 · 3-month 25.5", "30-day options: 16% net leaning with moves"]);
  assert.match(r.rule, /^Fixed rule, not a forecast: /);
  assert.doesNotMatch(r.label + r.sentence + r.facts.join(" "), /gamma|GEX|backwardation|contango|RULE TIER|squeeze|expansion/i);
});

test("each state has a plain label; the calm side and a flat day read correctly", () => {
  assert.equal(Object.keys(STRIP_LABELS).length, 7);
  const calm = stripRead("pinning", { ...live, vixChangePct: 0.01, termState: "contango", gexRegime: "long_gamma", gexShare: 0.22 });
  assert.equal(calm.sentence, "Quiet, range-bound: the fear gauge (VIX) is 28.3, flat today, short-term fear is below longer-term (the usual, calmer shape), and across SPX options out to 30 days the model has dealer hedging leaning against moves (smaller swings).");
  assert.equal(calm.facts[1], "30-day options: 22% net leaning against moves");
  assert.match(stripRead("neutral", { ...live, vixChangePct: -2.1, termState: "flat" }).sentence, /^No clear setup: the fear gauge \(VIX\) is 28\.3, down 2\.1% today, short-term and longer-term fear are about equal, /);
});

test("missing inputs are named, never read as calm or stressed", () => {
  const r = stripRead("unavailable", { vix9d: null, vix: null, vix3m: null, vixChangePct: null, termState: "unknown", gexRegime: "unknown", gexShare: 0 });
  assert.equal(r.sentence, "Not read: VIX and the fear curve and 30-day dealer hedging did not come back from Schwab.");
  assert.deepEqual(r.facts, []);
  assert.equal(stripRead("neutral", { ...live, vixChangePct: null }).sentence.includes("the fear gauge (VIX) is 28.3,"), true);
});

test("the strip shows it", () => {
  const c = readFileSync("client/src/components/RegimeHeadline.tsx", "utf8");
  assert.match(c, /const read = stripRead\(data\.regime, data\.inputs\);/);
  assert.doesNotMatch(c, /NET GEX|rule tier|VOL EXPANSION|GAMMA SQUEEZE/);
  assert.match(c, /<AsOfNote asOf=\{data\.asOf\} \/>/);
  // Every "read at" note on every tab: Eastern time, no leading zero.
  assert.match(readFileSync("client/src/lib/asOf.ts", "utf8"), /return `read \$\{etTimeLabel\(t\)\} · \$\{ago\}`;/);
});
