import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renormalisedReason } from "../../shared/impliedClose";

const src = (p: string) => readFileSync(p, "utf8");

test("the refused-chain reason states the size of the correction, not a total the prices never had", () => {
  assert.equal(renormalisedReason(1.465),
    "the option prices are out of line with each other: making them into one distribution for the settle took a correction of 47% of the total (readings below zero set to zero, or an end of the range cut to its bounds), and this read accepts at most 5%");
  assert.match(renormalisedReason(0.9), /a correction of 10% of the total/, "below one too: a cut tail");
  assert.match(renormalisedReason(1.052), /a correction of 5\.2% of the total .* accepts at most 5%$/, "near the limit the decimal shows why it is refused");
  for (const raw of [1.465, 0.9, 2.01]) {
    const t = renormalisedReason(raw);
    assert.doesNotMatch(t, /add up to|instead of 100%|odds/, "no claim about what the prices sum to, and no unqualified odds");
  }
});

test("why the old wording was false: unclipped, the strike-by-strike masses of any chain sum to exactly one", () => {
  // Call prices on an even grid, deliberately ragged. Inner mass at K_i is the butterfly (C[i-1] - 2C[i] + C[i+1]) / h;
  // the tails are 1 + lowSlope and -highSlope with the slopes at the two ends.
  const h = 5;
  const C = [100, 97.2, 91.9, 88.4, 82.0, 79.9, 73.1, 70.6, 65.2];
  let inner = 0;
  for (let i = 1; i < C.length - 1; i++) inner += (C[i - 1] - 2 * C[i] + C[i + 1]) / h;
  const lowSlope = (C[1] - C[0]) / h, highSlope = (C[C.length - 1] - C[C.length - 2]) / h;
  assert.ok(Math.abs((1 + lowSlope) + (-highSlope) + inner - 1) < 1e-12);
  // So any distance from one comes from clipping: here the negative butterflies alone.
  let negatives = 0;
  for (let i = 1; i < C.length - 1; i++) negatives += Math.min(0, (C[i - 1] - 2 * C[i] + C[i + 1]) / h);
  assert.ok(negatives < 0, "the ragged chain has negative readings");
  const src1 = src("shared/impliedClose.ts");
  assert.match(src1, /if \(Math\.abs\(1 - raw\) > MAX_RENORMALISED\) \{\s+return \{ \.\.\.base, state: "unavailable", reason: renormalisedReason\(raw\)/, "the rule is unchanged");
});

test("a long tracked group opens to its first rows, says how many there are and how many sold rows are below, and drops none", () => {
  const ui = src("client/src/components/WhaleFlowPanel.tsx");
  assert.match(ui, /const TRACKED_ROWS_SHOWN = 8;/);
  assert.match(ui, /\(showAll \? positions : positions\.slice\(0, TRACKED_ROWS_SHOWN\)\)\.map/);
  assert.match(ui, /const hiddenSold = positions\.slice\(TRACKED_ROWS_SHOWN\)\.filter\(\(p\) => freshnessTier\(p\) === "SOLD"\)\.length;/);
  assert.match(ui, /showing \$\{TRACKED_ROWS_SHOWN\} of \$\{positions\.length\}\$\{hiddenSold > 0 \? ` \(\$\{hiddenSold\} sold row/);
  assert.match(ui, /\{positions\.length\} \{positions\.length === 1 \? "pos" : "posns"\}/, "the header count uses every position");
});
