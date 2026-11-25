// Item 3: the same three words must not carry two sets of odds, and a level that differs across tabs says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rangeOdds, TWO_ODDS_NOTE, HOLDS_PRICE_TAG, type PathLike } from "../../shared/scenarioRegions";
import { levelScopeText, MODEL_DTE_MAX } from "../../shared/levelScope";

// Read live 2026-11-18: spot 7,324; path targets bull 7,582, base 7,572, bear 7,196; splits at 7,577 and 7,384.
const implied: PathLike[] = [
  { kind: "bull", probability: 0.004, probabilitySource: "risk-neutral-implied", region: { lo: 7577, hi: null }, target: 7582 },
  { kind: "base", probability: 0.27, probabilitySource: "risk-neutral-implied", region: { lo: 7384, hi: 7577 }, target: 7572 },
  { kind: "bear", probability: 0.726, probabilitySource: "risk-neutral-implied", region: { lo: null, hi: 7384 }, target: 7196 },
];

test("a range is named by where it is, and the one holding the price is flagged: an unchanged close is not a 'bear' outcome", () => {
  const bear = rangeOdds(implied, "bear", 7324, 28);
  assert.deepEqual([bear.position, bear.pct, bear.holdsPrice, bear.label, bear.rangeText], ["lower", 73, true, "LOWER range 73%", "below 7,384"]);
  assert.doesNotMatch(bear.label, /BEAR/);
  const base = rangeOdds(implied, "base", 7324, 42);
  assert.deepEqual([base.position, base.pct, base.holdsPrice, base.label, base.rangeText], ["middle", 27, false, "MIDDLE range 27%", "7,384-7,577"]);
  const bull = rangeOdds(implied, "bull", 7324, 30);
  assert.deepEqual([bull.position, bull.pct, bull.holdsPrice, bull.label, bull.rangeText], ["upper", 0, false, "UPPER range 0%", "above 7,577"]);
});

test("exactly one range holds the price, a boundary belongs to the range above it, and an unread price flags none", () => {
  for (const spot of [7000, 7383.99, 7384, 7500, 7577, 9000]) {
    const held = (["bull", "base", "bear"] as const).filter((k) => rangeOdds(implied, k, spot, 0).holdsPrice);
    assert.equal(held.length, 1, `spot ${spot}: ${held}`);
  }
  assert.equal(rangeOdds(implied, "base", 7384, 0).holdsPrice, true);
  assert.equal(rangeOdds(implied, "bear", 7384, 0).holdsPrice, false);
  assert.equal(rangeOdds(implied, "bull", 7577, 0).holdsPrice, false, "the server counts a close exactly on the upper split in the middle range");
  assert.equal(rangeOdds(implied, "base", 7577, 0).holdsPrice, true);
  assert.equal(rangeOdds(implied, "bear", null, 0).holdsPrice, false);
});

test("without implied odds or a region, the number is the hand-set split and keeps the path name", () => {
  const heur: PathLike[] = implied.map((p) => ({ ...p, probabilitySource: "hand-set-heuristic", region: null }));
  const r = rangeOdds(heur, "bear", 7324, 28);
  assert.deepEqual([r.position, r.pct, r.holdsPrice, r.label, r.rangeText], [null, 28, false, "BEAR 28%", "near 7,196"]);
  const noRegion = rangeOdds([{ ...implied[2], region: null }], "bear", 7324, 28);
  assert.equal(noRegion.label, "BEAR 73%", "implied odds with no region sent still show the implied number");
  assert.equal(rangeOdds([], "bull", 7324, 30).label, "BULL 30%");
});

test("the note tells the two sets apart without calling either a forecast", () => {
  assert.match(TWO_ODDS_NOTE, /at least one expected move above the current price, in between, or at least one below/);
  assert.match(TWO_ODDS_NOTE, /halfway between the base path target and the bull and bear path targets; when the base target is outside those two, the current price is used in its place\. The range that holds the current price is marked\./);
  assert.match(TWO_ODDS_NOTE, /An unchanged close counts toward whichever range holds the price\./);
  assert.equal(HOLDS_PRICE_TAG, "price is in this range");
});

test("each panel states which expiries its levels add up, and the Models limits match the server", () => {
  assert.equal(levelScopeText("models", "daily"), "These levels add up every expiry within 2 days, so they differ from other tabs. The Today card on Signals uses the nearest expiry only.");
  assert.match(levelScopeText("models", "quarterly"), /within 100 days/);
  assert.match(levelScopeText("models", "unknown"), /inside this view's limit/);
  assert.equal(levelScopeText("today"), levelScopeText("odteMap"));
  assert.match(levelScopeText("today"), /nearest expiry only\. The daily and weekly SPX models on the Models tab use the same ceiling, floor and turning point[\s\S]*The monthly model and the chain audit add up more expiries/);
  assert.match(levelScopeText("chainAudit"), /Each column adds up its own group of expiries/);
  assert.match(levelScopeText("pivotProjection"), /main gamma snapshot \(the SPY chain, expiries within 45 days\), not the nearest-expiry map/);
  const models = readFileSync(new URL("../../server/models.ts", import.meta.url), "utf8");
  for (const [h, d] of Object.entries(MODEL_DTE_MAX)) assert.match(models, new RegExp(`\\b${h}: ${d},`), `server DTE_MAX.${h} is ${d}`);
});

test("the Models tab no longer prints 'BULL region' / 'BEAR region' for range odds, and every panel carries its scope line", () => {
  const read = (f: string) => readFileSync(new URL(`../../client/src/components/${f}`, import.meta.url), "utf8");
  const m = read("ModelsPanel.tsx");
  assert.doesNotMatch(m, /BULL region|BEAR region|BASE region \{|MIDDLE region \{/);
  assert.match(m, /<RailRow label=\{ro\.bear\.label\} value=\{ro\.bear\.rangeText\}/);
  assert.match(m, /BEAR path · \{lg\.bear\.label\}\{lg\.bear\.holdsPrice \? ` \(\$\{HOLDS_PRICE_TAG\}\)` : ""\}/);
  assert.match(m, /data-testid="models-two-odds-note">\{TWO_ODDS_NOTE\}/);
  assert.match(m, /data-testid="models-headline-odds"/);
  assert.match(m, /data-testid="close-chip-odds-bear">\{chipOdds\("bear", a\.closeTargets\.bear\.prob\)\}/);
  assert.match(m, /<LevelScopeNote panel="models" horizon=\{horizon\.horizon\}/);
  assert.match(read("TodayCard.tsx"), /\{priced && <LevelScopeNote panel="today" \/>\}/, "no scope line when there are no levels to scope");
  assert.match(read("ChainAudit.tsx"), /<LevelScopeNote panel="chainAudit" \/>/);
  assert.match(read("OdteMapCard.tsx"), /<LevelScopeNote panel="odteMap" \/>/);
  assert.match(read("models/PivotProjection.tsx"), /symbol === "SPY" \|\| symbol === "\^GSPC"\) && <LevelScopeNote panel="pivotProjection"/);
});
