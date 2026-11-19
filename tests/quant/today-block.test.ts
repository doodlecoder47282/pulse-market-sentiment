// The Today block: one plain sentence, the levels that matter, and the projected path to the close, first on the opening tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readToday } from "../../shared/plainReads";

const base = { spot: 7324, sessionState: "intraday", dataState: "ok", atSpot: "short", straddle: 81.5, low: 7242, high: 7405, wallAbove: 7450, magnetBelow: 7300, flip: 7531 };
const words = (t: string) => t.trim().split(/\s+/).length;

test("the answer says what the model reads and how big a move is priced, in one short sentence pair", () => {
  const r = readToday(base);
  assert.equal(r.answer, "Model read: dealer hedging adds to moves today. Options price a move of about ±82 points by the close.");
  assert.ok(words(r.answer) <= 26);
  assert.equal(readToday({ ...base, atSpot: "long" }).answer, "Model read: dealer hedging damps moves today. Options price a move of about ±82 points by the close.");
  assert.equal(readToday({ ...base, sessionState: "closed" }).answer, "Model read: dealer hedging adds to moves in the next session. Options price a move of about ±82 points by the close.");
});

test("nothing is guessed: an undetermined sign, a missing straddle and a chain with no gamma each say so", () => {
  assert.equal(readToday({ ...base, atSpot: "indeterminate", straddle: null }).answer, "The model could not read whether dealer hedging adds to moves or damps them.");
  assert.equal(readToday({ ...base, straddle: null }).answer, "Model read: dealer hedging adds to moves today.");
  const none = readToday({ ...base, dataState: "no_gex" });
  assert.equal(none.answer, "No dealer levels to read yet: the options chain carries no priced gamma.");
  assert.match(none.detail!, /nothing is shown in their place/);
});

test("the detail places each level against the price, names a missing one, flags a stale read, and claims no direction", () => {
  const d = readToday(base).detail!;
  assert.match(d, /\(the gamma flip\) is 7,531, 207 points above the price\./);
  assert.match(d, /The largest hedging level above the price is 7,450\. The largest one below is 7,300\./);
  assert.match(d, /straddle prices a range of 7,242 to 7,405\./);
  assert.match(d, /They describe positioning; they do not forecast direction\.$/);
  const gaps = readToday({ ...base, wallAbove: null, magnetBelow: null, flip: null, dataState: "stale" }).detail!;
  assert.match(gaps, /No level where hedging switches was found inside the range read\. No large hedging level was found above the price\. None was found below\./);
  assert.match(gaps, /This is from the last chain read, not a live one\./);
  assert.doesNotMatch(`${readToday(base).answer} ${d}`, /\b(buy|sell|should|recommend|bullish|bearish|will (rise|fall|drop|rally)|expect a|likely to)\b/i);
});

test("the card opens with the read, closes with the path, and sits above the stock search on the opening tab", () => {
  const card = readFileSync(new URL("../../client/src/components/TodayCard.tsx", import.meta.url), "utf8");
  assert.ok(card.indexOf('<PlainRead testId="today-plain"') < card.indexOf('data-testid="today-levels"'), "the sentence comes before the level tiles");
  assert.ok(card.indexOf('data-testid="today-levels"') < card.indexOf("<TodayPath"), "the path comes after the levels");
  assert.match(card, /\{symbol === "\$SPX" && <TodayPath onOpenMap=\{onOpenMap\} \/>\}/, "the path is the index's: not shown for another symbol");
  const dash = readFileSync(new URL("../../client/src/pages/dashboard.tsx", import.meta.url), "utf8");
  assert.ok(dash.indexOf('data-testid="today-block"') < dash.indexOf('data-testid="stock-research-workspace"'));
  assert.equal(dash.split("<TodayCard").length - 1, 1, "rendered once");
});

test("the path draws only what the projection helper allows, shares the map's request, and keeps unavailable distinct", () => {
  const p = readFileSync(new URL("../../client/src/components/TodayPath.tsx", import.meta.url), "utf8");
  assert.match(p, /queryKey: \["\/api\/odte\/forward"\]/, "the same query key as the Wiener map: no second request");
  assert.match(p, /const drawImplied = proj\.implied\?\.draw \? proj\.implied\.end : null;/);
  assert.match(p, /dealer: proj\.dealer && d\.path\?\.length \?/, "no dealer line without priced gamma");
  assert.match(p, /\{proj\.impliedWhy\}; no line is drawn/);
  assert.match(p, /\{proj\.dealerWhy\}; no line is drawn/);
  assert.match(p, /data-testid="today-path-unavailable"[\s\S]{0,260}Nothing is drawn in its place\./);
  assert.match(p, /None of this is a forecast\./);
  assert.match(p, /w!\.horizon === "next_session" \? "the next session's" : "today's"/);
  assert.match(p, /min-h-\[44px\]/);
});
