// The Wiener map draws up to three lines to the close, each the centre of a distribution with its source named.
// A read its source does not stand behind is not drawn (shared/odteProjection.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectedClose, type ProjectionInputs } from "../../shared/odteProjection";

const okImplied = (over: Partial<NonNullable<ProjectionInputs["implied"]>> = {}) => ({
  state: "ok" as const, reason: null, median: 7012.4, bucket: 5, diagnostics: { clipped: 0, lowTail: 0.01, highTail: 0.02 }, ...over,
});
const base: ProjectionInputs = { spot: 7000, walkMedian: 7000, sessionState: "intraday", implied: okImplied(), forwardMinusSpot: 0.1, dealerEnd: 7006.26, gexValid: true };

test("a clean intraday read gives three ends, each with its distance from the current price", () => {
  const p = projectedClose(base)!;
  assert.equal(p.walk, 7000);
  assert.deepEqual(p.implied, { end: 7012.4, gap: 12.4, forwardGap: null, withinGrid: false, draw: true });
  assert.deepEqual(p.dealer, { end: 7006.3, gap: 6.3 });
  assert.equal(p.impliedWhy, null);
  assert.equal(p.dealerWhy, null);
});

test("no spot or no walk median: nothing is projected", () => {
  assert.equal(projectedClose({ ...base, spot: null }), null);
  assert.equal(projectedClose({ ...base, walkMedian: null }), null);
});

test("the chain's median is not used when the chain itself does not stand behind it", () => {
  const cases: Array<[Partial<ProjectionInputs>, RegExp]> = [
    [{ implied: { state: "unavailable", reason: "too few strikes", diagnostics: { clipped: 0 } } }, /^not readable: too few strikes$/],
    [{ implied: undefined }, /^not readable: no chain mids$/],
    // Any clipped strike, not only one inside the body: the rule compareCloseDistributions uses.
    [{ implied: okImplied({ diagnostics: { clipped: 1, lowTail: 0, highTail: 0 } }) }, /^median not read: 1 strike priced out of line \(clipped to zero\)$/],
    [{ implied: okImplied({ diagnostics: { clipped: 0, lowTail: 0.5, highTail: 0 } }) }, /half the distribution lies beyond the readable strikes/],
    [{ implied: okImplied({ median: null }) }, /^median not reported$/],
  ];
  for (const [over, why] of cases) {
    const p = projectedClose({ ...base, ...over })!;
    assert.equal(p.implied, null, JSON.stringify(over));
    assert.match(p.impliedWhy ?? "", why);
  }
});

test("the forward-versus-print part of the gap is named, a sub-grid gap is not a lean, and no line is drawn outside the live session", () => {
  // Pre-open: the index print is the prior close while the chain's forward has moved 30 points.
  const pre = projectedClose({ ...base, sessionState: "preopen", implied: okImplied({ median: 7030 }), forwardMinusSpot: 30 })!;
  assert.deepEqual(pre.implied, { end: 7030, gap: 30, forwardGap: 30, withinGrid: false, draw: false });
  assert.equal(projectedClose({ ...base, sessionState: "closed" })!.implied!.draw, false);
  assert.equal(projectedClose({ ...base, forwardMinusSpot: 0.24 })!.implied!.forwardGap, null, "under the shared 0.25 pt floor it is not mentioned");
  assert.equal(projectedClose({ ...base, forwardMinusSpot: -0.4 })!.implied!.forwardGap, -0.4);
  assert.equal(projectedClose({ ...base, implied: okImplied({ median: 7002.4 }) })!.implied!.withinGrid, true);
  assert.equal(projectedClose({ ...base, implied: okImplied({ median: 7002.5 }) })!.implied!.withinGrid, false);
  assert.equal(projectedClose({ ...base, implied: okImplied({ median: 7001, bucket: null }) })!.implied!.withinGrid, false, "no grid reported: nothing claimed about it");
});

test("the dealer path is not used when gamma was not priced or the path is missing", () => {
  const a = projectedClose({ ...base, gexValid: false })!;
  assert.equal(a.dealer, null);
  assert.match(a.dealerWhy ?? "", /gamma not priced/);
  const b = projectedClose({ ...base, dealerEnd: null })!;
  assert.equal(b.dealer, null);
  assert.equal(b.dealerWhy, "not available on this read");
  assert.ok(projectedClose({ ...base, gexValid: undefined })!.dealer, "an older payload without the flag keeps the path");
});

test("the chart draws only what the helper allows, resets its line state, and words the block for the session it describes", () => {
  const src = readFileSync(new URL("../../client/src/components/OdteForward.tsx", import.meta.url), "utf8");
  assert.match(src, /const drawImplied = proj\?\.implied\?\.draw \? proj\.implied\.end : null;/);
  assert.match(src, /const drawDealer = showOverlay && proj\?\.dealer \? proj\.dealer\.end : null;/);
  assert.match(src, /const \[showOverlay, setShowOverlay\] = useState\(true\);/, "the dealer line is on unless switched off");
  assert.match(src, /for \(const v of \[drawImplied, drawDealer\]\) if \(v != null\) \{ lo = Math\.min\(lo, v\); hi = Math\.max\(hi, v\); \}/, "drawn ends stay on the chart");
  assert.match(src, /ctx\.setLineDash\(\[9, 5\]\);\n\s*ctx\.beginPath\(\); ctx\.moveTo\(X\(geo\.startAbs\), Y\(proj\.spot\)\); ctx\.lineTo\(X\(geo\.endAbs\), Y\(drawImplied\)\)/, "the chain line is dashed: only its end is data");
  assert.match(src, /ctx\.stroke\(\); ctx\.setLineDash\(\[\]\); ctx\.lineWidth = 1;\n    \}\n\n    \/\/ today's path so far/, "the dealer stroke does not leave a wider line for what follows");
  const block = src.slice(src.indexOf('data-testid="odte-projected-close"'), src.indexOf("ref={wrapRef}"));
  assert.match(block, /Centre of the close · three reads/);
  assert.match(src, /const day = next \? "the next session's" : "today's";/);
  assert.match(src, /const from = session\.state === "intraday" \? "now" : "the last price";/);
  assert.match(block, /\{proj\.impliedWhy\}; no line is drawn/);
  assert.match(block, /\{proj\.dealerWhy\}; no line is drawn/);
  assert.match(block, /a heuristic, not graded/);
  assert.match(block, /None of them is a forecast, and the scorecard below grades only the random walk's odds\./);
  assert.doesNotMatch(block, /lean away|will (close|reach|hit)|target price|expected to|likely to (close|rise|fall)|Projected close/i);
});
