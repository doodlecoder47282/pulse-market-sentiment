// The Wiener map draws three projected lines to the close, each the centre of a distribution, with its source named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../client/src/components/OdteForward.tsx", import.meta.url), "utf8");

test("three projected lines are drawn: the walk's centre, the chain's median settle, the dealer-rule path", () => {
  assert.match(src, /Projected line 1: the random walk's centre/);
  assert.match(src, /ctx\.moveTo\(X\(geo\.startAbs\), Y\(proj\.spot\)\); ctx\.lineTo\(X\(geo\.endAbs\), Y\(proj\.implied\)\)/, "the chain line runs from now to its median at the close");
  assert.match(src, /Projected line 3: the dealer-rule path/);
  assert.match(src, /useState\(true\);\n\n  const \{ data, isLoading|const \[showOverlay, setShowOverlay\] = useState\(true\)/, "the dealer line is on unless switched off");
  for (const label of ["`walk ${Math.round(proj.walk)}`", "`options ${Math.round(proj.implied)}`", "`dealer ${Math.round(proj.dealer)}`"]) assert.ok(src.includes(label), label);
});

test("the chain line is not drawn from an unreadable or holed distribution, and the reason is shown", () => {
  assert.match(src, /ic\?\.state === "ok" && holes === 0 && ic\.median != null && Number\.isFinite\(ic\.median\)/);
  assert.match(src, /median not read: \$\{holes\} strike/);
  assert.match(src, /\{proj\.impliedWhy\}; no line is drawn/);
  assert.match(src, /not available on this read; no line is drawn/);
});

test("the end points stay on the chart and the copy says what each line is, without a direction claim", () => {
  assert.match(src, /for \(const v of \[proj\?\.implied, showOverlay \? proj\?\.dealer : null\]\) if \(v != null\) \{ lo = Math\.min\(lo, v\); hi = Math\.max\(hi, v\); \}/);
  const block = src.slice(src.indexOf('data-testid="odte-projected-close"'), src.indexOf("ref={wrapRef}"));
  assert.match(block, /no drift, so the centre is the current price by construction/);
  assert.match(block, /a heuristic, not graded/);
  assert.match(block, /None of them is a forecast, and the scorecard below grades only the random walk's odds\./);
  assert.doesNotMatch(block, /will (close|reach|hit)|target price|expected to|likely to (close|rise|fall)/i);
});
