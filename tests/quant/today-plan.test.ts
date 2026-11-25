// The top of Signals in plain words: what is happening, the levels, and the if-then path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todayPlan, TODAY_LABELS } from "../../shared/todayPlan";

// The live card on 2026-11-24 after the close: SPX 7,201, flip 7,224 above, wall 7,300, nothing below, move 81.
const live = { symbol: "$SPX", spot: 7201, sessionState: "closed", dataState: "stale_session", atSpot: "short", straddle: 81, low: 7120, high: 7282, above: 7300, below: null, flip: 7224 };

test("the worked example reads as a setup, a priced move and an A-to-B-because-C path", () => {
  const p = todayPlan(live);
  assert.equal(p.headline, "Bigger swings are the setup for the next session: at this price, the hedging of big option dealers tends to push SPX further in whichever direction it is already going. Options are priced for a move of about 81 points either way by the next close: roughly 7,120 to 7,282. This is from the last read before the close, not a live one.");
  assert.deepEqual(p.path, [
    "If SPX gets back above 7,224, swings should calm down, because above that level dealer hedging works against the move instead of with it.",
    "Above 7,224, the next level is 7,300: the heaviest option positions overhead, where rallies tend to slow.",
    "While it stays below 7,224, expect larger moves both ways. No option level stands out underneath within 2%; the low end of the priced move is 7,120.",
  ]);
  assert.deepEqual(p.labels, TODAY_LABELS);
  assert.equal(p.notes.above, "1.37% above the price");
  assert.equal(p.notes.flip, "0.32% above the price: price is on the bigger-swing side");
  assert.equal(p.notes.below, "none within 2%");
});

test("price above the turning point: the calm side, and the step down is named", () => {
  const p = todayPlan({ ...live, sessionState: "intraday", dataState: "ok", atSpot: "long", spot: 7260, flip: 7224, above: 7300, below: 7200 });
  assert.match(p.headline, /^Smaller swings are the setup today: /);
  assert.match(p.headline, /by today's close/);
  assert.doesNotMatch(p.headline, /not a live one/);
  assert.deepEqual(p.path, [
    "If SPX falls below 7,224, swings should get bigger, because below that level dealer hedging works with the move instead of against it.",
    "While it holds above 7,224, the next level up is 7,300: the heaviest option positions overhead, where rallies tend to slow.",
    "Below 7,224, the next level down is 7,200.",
  ]);
});

test("nothing is invented: no map, no turning point, no priced move each say so", () => {
  const none = todayPlan({ ...live, dataState: "no_gex" });
  assert.match(none.headline, /^No option levels to read yet/);
  assert.deepEqual(none.path, []);
  const noFlip = todayPlan({ ...live, flip: null, above: null, below: null, straddle: null, atSpot: "indeterminate" });
  assert.equal(noFlip.headline, "The option map does not say for the next session whether dealer hedging will add to moves or calm them. This is from the last read before the close, not a live one.");
  assert.deepEqual(noFlip.path, ["No option level stands out within 2% of the price on either side."]);
  assert.equal(noFlip.notes.flip, "none found in the range read");
});

test("no jargon and no promise in any line", () => {
  for (const p of [todayPlan(live), todayPlan({ ...live, atSpot: "long", spot: 7260 })]) {
    const all = [p.headline, ...p.path, ...Object.values(p.notes), ...Object.values(p.labels)].join(" ");
    assert.doesNotMatch(all, /gamma|γ|GEX|delta|vanna|charm|0DTE|straddle|magnet|wall\b/i);
    assert.doesNotMatch(all, /\bwill\b(?! add)|guarantee|certain|profit/i);
  }
});

test("the card shows the plan: headline first, plain tile labels, the path as a list", () => {
  const card = readFileSync("client/src/components/TodayCard.tsx", "utf8");
  assert.match(card, /const plan = todayPlan\(\{/);
  assert.match(card, /data-testid="today-path-steps"/);
  assert.doesNotMatch(card, /"wall above"|"magnet below"|>gamma flip</);
});
