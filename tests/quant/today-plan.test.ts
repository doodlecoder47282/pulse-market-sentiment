// The top of Signals in plain words: what is happening, the levels, and the if-then path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todayPlan, TODAY_LABELS } from "../../shared/todayPlan";

// The live card on 2026-11-24 after the close: SPX 7,201, flip 7,224 above, wall 7,300, nothing below, move 81.
const live = { symbol: "$SPX", spot: 7201, sessionState: "closed", dataState: "stale_session", atSpot: "short", straddle: 81, low: 7120, high: 7282, above: 7300, below: null, flip: 7224 };

test("the worked example reads as a setup, a priced move and an if-then path", () => {
  const p = todayPlan({ ...live, readAtMs: Date.parse("2026-11-24T21:54:10Z") });
  assert.equal(p.headline, "Bigger swings are the setup for the next session: at this price, the option map has the hedging of big option dealers leaning with moves, which tends to push SPX further in whichever direction it is already going. Options are priced for a move of about 81 points either way by the next close: roughly 7,120 to 7,282. Market closed: these are levels for the next session, from option data read Nov 24, 4:54 PM ET.");
  assert.deepEqual(p.path, [
    "If SPX gets above 7,224, the option map switches to the calmer side: there the model has dealer hedging leaning against moves (smaller swings in this model).",
    "While it stays below 7,224, it is on the bigger-swing side.",
    "The largest level overhead on the option map is 7,300, where the model has hedging leaning against rallies.",
    "No level stands out underneath within 2%; the low end of the priced move is 7,120.",
  ]);
  assert.deepEqual(p.labels, TODAY_LABELS);
  assert.equal(p.notes.above, "1.37% above the price");
  assert.equal(p.notes.flip, "0.32% above the price: price is on the bigger-swing side");
  assert.equal(p.notes.below, "none within 2%");
});

test("the side comes from the read at the price, not from where the turning point sits", () => {
  // Turning point above the price, yet the map reads the calm side at the price.
  const a = todayPlan({ ...live, sessionState: "intraday", dataState: "ok", spot: 6834, flip: 6850, atSpot: "long", above: 6875, below: 6810 });
  assert.match(a.headline, /^Smaller swings are the setup today: /);
  assert.equal(a.path[0], "If SPX gets above 6,850, the option map switches to the bigger-swing side: there the model has dealer hedging leaning with moves (bigger swings in this model).");
  assert.equal(a.path[1], "While it stays below 6,850, it is on the calmer side.");
  assert.match(a.notes.flip, /price is on the calmer side$/);
  // Turning point below the price, yet the map reads the bigger-swing side at the price.
  const b = todayPlan({ ...live, sessionState: "intraday", dataState: "ok", spot: 6834, flip: 6800, atSpot: "short" });
  assert.equal(b.path[0], "If SPX falls below 6,800, the option map switches to the calmer side: there the model has dealer hedging leaning against moves (smaller swings in this model).");
  assert.equal(b.path[1], "While it stays above 6,800, it is on the bigger-swing side.");
  assert.doesNotMatch(a.headline + b.headline, /Market closed/);
});

test("nothing is invented: no map, no turning point, no priced move, an unread side each say so", () => {
  const none = todayPlan({ ...live, dataState: "no_gex" });
  assert.match(none.headline, /^No option levels to read yet/);
  assert.deepEqual(none.path, []);
  const bare = todayPlan({ ...live, flip: null, above: null, below: null, straddle: null, low: null, high: null, atSpot: "indeterminate" });
  assert.equal(bare.headline, "The option map does not say for the next session whether dealer hedging leans with moves or against them. Market closed: these are levels for the next session.");
  assert.deepEqual(bare.path, ["No level stands out overhead within 2%.", "No level stands out underneath within 2%."]);
  assert.equal(bare.notes.flip, "none found in the range read");
  const unread = todayPlan({ ...live, atSpot: "indeterminate" });
  assert.equal(unread.path[0], "7,224 is where the model's hedging read changes sides; which side the price is on now could not be read.");
  assert.equal(unread.notes.flip, "0.32% above the price");
});

test("no jargon and no promise in any line", () => {
  for (const p of [todayPlan(live), todayPlan({ ...live, atSpot: "long", spot: 7260 })]) {
    const all = [p.headline, ...p.path, ...Object.values(p.notes), ...Object.values(p.labels)].join(" ");
    assert.doesNotMatch(all, /gamma|γ|GEX|delta|vanna|charm|0DTE|straddle|magnet|wall\b|heaviest/i);
    assert.doesNotMatch(all, /\bwill\b|\bshould\b|\bexpect|guarantee|certain|profit/i);
  }
});

test("the card shows the plan: headline first, plain tile labels, the path as a list", () => {
  const card = readFileSync("client/src/components/TodayCard.tsx", "utf8");
  assert.match(card, /const plan = todayPlan\(\{/);
  assert.match(card, /data-testid="today-path-steps"/);
  assert.doesNotMatch(card, /"wall above"|"magnet below"|>gamma flip</);
});

test("before the open the line says the levels are for today and when the data was read", () => {
  const p = todayPlan({ ...live, sessionState: "preopen", dataState: "ok", atSpot: "long", readAtMs: Date.parse("2026-11-24T21:54:10Z") });
  assert.match(p.headline, /^Smaller swings are the setup today: /);
  assert.match(p.headline, /by today's close/);
  assert.match(p.headline, / Market not open yet: these are levels for today, from option data read Nov 24, 4:54 PM ET\.$/);
});

test("a ceiling under the turning point, or a floor over it, gets a plain line", () => {
  // The week block on 2026-11-24: ceiling 7,250 below turning point 7,278.
  const up = todayPlan({ ...live, flip: 7278, above: 7250, below: 7160 });
  assert.ok(up.path.includes("The ceiling (7,250) is below the turning point (7,278): a rally meets the ceiling first, and the map only switches sides above 7,278."));
  const down = todayPlan({ ...live, spot: 7300, flip: 7250, above: 7350, below: 7270, atSpot: "long" });
  assert.ok(down.path.includes("The floor (7,270) is above the turning point (7,250): a drop meets the floor first, and the map only switches sides below 7,250."));
  assert.equal(todayPlan(live).path.some((l) => /is below the turning point|is above the turning point/.test(l)), false, "not said when the order is the usual one");
});
