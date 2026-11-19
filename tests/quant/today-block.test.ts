// The Today block: one plain sentence, the levels that matter, and the projected path to the close, first on the opening tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readToday } from "../../shared/plainReads";
import { pathView, type PathBand } from "../../shared/odteProjection";

const base = { spot: 7324, sessionState: "intraday", dataState: "ok", atSpot: "short", straddle: 81.5, low: 7242, high: 7405, above: 7450, below: 7300, flip: 7531 };
const words = (t: string) => t.trim().split(/\s+/).length;

test("the answer says what the model reads and how big a move is priced", () => {
  const r = readToday(base);
  assert.equal(r.answer, "Model read: dealer hedging adds to moves today. Options price a move of about ±82 points by the close.");
  assert.ok(words(r.answer) <= 26);
  assert.equal(readToday({ ...base, atSpot: "long" }).answer, "Model read: dealer hedging damps moves today. Options price a move of about ±82 points by the close.");
});

test("a closed session is the next session's options as last read, from the last price: not a statement about tomorrow", () => {
  const r = readToday({ ...base, sessionState: "closed" });
  assert.equal(r.answer, "Model read: dealer hedging adds to moves on the next session's options, as last read. Options price a move of about ±82 points by that session's close, from the last price.");
  assert.ok(words(r.answer) <= 32);
});

test("nothing is guessed: an undetermined sign, a missing straddle and a chain with no gamma each say so", () => {
  assert.equal(readToday({ ...base, atSpot: "indeterminate", straddle: null }).answer, "The model could not read whether dealer hedging adds to moves or damps them.");
  assert.equal(readToday({ ...base, straddle: null }).answer, "Model read: dealer hedging adds to moves today.");
  const none = readToday({ ...base, dataState: "no_gex" });
  assert.equal(none.answer, "No dealer levels to read yet: the options chain carries no priced gamma.");
  assert.match(none.detail!, /nothing is shown in their place/);
});

test("the detail names each level for what it is: the sign, the 2% window, the expiry, and a pin that fills a slot", () => {
  const d = readToday(base).detail!;
  assert.match(d, /^That read is for the nearest expiry only\./);
  assert.match(d, /\(the gamma flip\) is 7,531, 207 points above the price\./);
  assert.match(d, /Above the price, the largest strike within 2% where the model has dealer hedging damping moves is 7,450\./);
  assert.match(d, /Below the price, the largest strike within 2% where the model has dealer hedging damping moves is 7,300\./);
  assert.doesNotMatch(d, /largest hedging level/, "a bigger negative-gamma strike can sit on the same side: these are the positive ones only");
  assert.match(d, /straddle prices a range of 7,242 to 7,405\./);
  assert.match(d, /They describe positioning; they do not forecast direction\.$/);
  const gaps = readToday({ ...base, above: null, below: null, flip: null, dataState: "stale" }).detail!;
  assert.match(gaps, /No level where hedging switches was found inside the range read\. No strike above the price within 2% has the model's dealer hedging damping moves\. No strike below the price within 2% has/);
  assert.match(gaps, /This is from the last chain read, not a live one\./);
  const pin = readToday({ ...base, above: 7325, aboveIsPin: true }).detail!;
  assert.match(pin, /No such strike stands out above the price, so the pin \(7,325\), the largest one near the price, is shown there\./, "the sentence agrees with the tile when the pin fills the slot");
  assert.doesNotMatch(`${readToday(base).answer} ${d}`, /\b(buy|sell|should|recommend|bullish|bearish|will (rise|fall|drop|rally)|expect a|likely to)\b/i);
});

const band = (minute: number, mid: number, w: number): PathBand => ({ minute, q: { p10: mid - 2 * w, p25: mid - w, p50: mid, p75: mid + w, p90: mid + 2 * w } });
const bands = [band(0, 7324, 0), band(195, 7324, 20), band(390, 7324, 30)];

test("path geometry: bands and lines share one frame, nothing clips, and the options line runs from the price to its end", () => {
  const v = pathView(bands, 7324, 7340, [{ minute: 0, median: 7324 }, { minute: 390, median: 7420 }])!;
  assert.ok(v.hi > 7420 && v.lo < 7264, "the range holds the dealer path even where it leaves the 80% band");
  assert.deepEqual([v.implied!.x1, v.implied!.x2], [0, 300]);
  assert.ok(v.implied!.y2 < v.implied!.y1, "a higher end is drawn higher (smaller y)");
  assert.ok(v.walk.startsWith("0.0,") && v.walk.includes("300.0,"));
  assert.ok(v.dealer!.startsWith("0.0,"));
  assert.doesNotMatch(`${v.outer} ${v.inner} ${v.walk} ${v.dealer}`, /NaN|Infinity/);
  const plain = pathView(bands, 7324, null, null)!;
  assert.equal(plain.implied, null);
  assert.equal(plain.dealer, null);
});

test("path geometry: nothing is drawn from degenerate or unread inputs", () => {
  assert.equal(pathView([band(0, 7324, 0)], 7324, null, null), null, "one band is not a path");
  assert.equal(pathView(bands, null, null, null), null, "no price, no chart");
  assert.equal(pathView([band(5, 7324, 1), band(5, 7324, 2)], 7324, null, null), null, "no time span");
  assert.equal(pathView([band(0, 7324, 1), { minute: 390, q: { p10: Number.NaN, p25: 1, p50: 1, p75: 1, p90: 1 } }], 7324, null, null), null, "an unread band value");
  assert.equal(pathView(bands, 7324, null, [{ minute: 0, median: Number.NaN }, { minute: 390, median: 7300 }])!.dealer, null, "an unread dealer point drops the dealer line, not the chart");
  assert.equal(pathView(bands, 7324, null, [{ minute: 390, median: 7300 }])!.dealer, null, "one point is not a line");
});

test("the card opens with the read, closes with the path, sits above the stock search, and polls only on its tab", () => {
  const card = readFileSync(new URL("../../client/src/components/TodayCard.tsx", import.meta.url), "utf8");
  assert.ok(card.indexOf('<PlainRead testId="today-plain"') < card.indexOf('data-testid="today-levels"'), "the sentence comes before the level tiles");
  assert.ok(card.indexOf('data-testid="today-levels"') < card.indexOf("<TodayPath"), "the path comes after the levels");
  assert.match(card, /\{symbol === "\$SPX" && <TodayPath onOpenMap=\{onOpenMap\} active=\{active\} \/>\}/, "the path is the index's: not shown for another symbol");
  assert.match(card, /above, below, aboveIsPin, belowIsPin, flip,/, "the sentence is built from the same values the tiles show");
  assert.match(card, /refetchInterval: active \? 60_000 : false/);
  assert.match(card, /<div className="hidden space-y-1 sm:block">/, "the position bar repeats the tiles and is left off phones");
  const dash = readFileSync(new URL("../../client/src/pages/dashboard.tsx", import.meta.url), "utf8");
  assert.ok(dash.indexOf('data-testid="today-block"') < dash.indexOf('data-testid="stock-research-workspace"'));
  assert.match(dash, /className="mb-4" data-testid="today-block"/, "a gap before the stock search");
  assert.match(dash, /<TodayCard active=\{activeTab === "signals"\}/);
  assert.equal(dash.split("<TodayCard").length - 1, 1, "rendered once");
});

test("the path draws only what the helpers allow, shares the map's request, keeps one height and names a stale read", () => {
  const p = readFileSync(new URL("../../client/src/components/TodayPath.tsx", import.meta.url), "utf8");
  assert.match(p, /queryKey: \["\/api\/odte\/forward"\]/, "the same query key as the Wiener map: no second request");
  assert.match(p, /refetchInterval: active \? 60_000 : false/);
  assert.match(p, /const drawImplied = proj\.implied\?\.draw \? proj\.implied\.end : null;/);
  assert.match(p, /pathView\(w\.bands, proj\.spot, drawImplied, proj\.dealer \? \(d\.path \?\? null\) : null\)/, "no dealer line without priced gamma");
  assert.match(p, /\{proj\.impliedWhy\}; no line is drawn/);
  assert.match(p, /\{proj\.dealerWhy\}; no line is drawn/);
  assert.match(p, /data-testid="today-path-unavailable"[\s\S]{0,260}Nothing is drawn in its place\./);
  assert.equal(p.split("${BOX}").length - 1, 3, "loading, unavailable and drawn share one minimum height");
  assert.match(p, /const from = d\.chainStale \? "the last read" :/, "a held chain is not 'now'");
  assert.match(p, /is the chain's forward against the last index print/);
  assert.match(p, /answer: "None of these lines is a forecast\."/);
  assert.match(p, /The dealer line is a rule of thumb about positioning, not the middle of a measured range\./);
  assert.match(p, /w!\.horizon === "next_session" \? "the next session's" : "today's"/);
  assert.match(p, /min-h-\[44px\]/);
});
