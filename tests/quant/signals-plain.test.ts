import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(p, "utf8");

test("the unreadable-chain reason is said in plain words with the same two numbers", () => {
  const s = src("shared/impliedClose.ts");
  assert.match(s, /the option prices do not fit together as one set of odds for the close: read strike by strike they add up to \$\{Math\.round\(raw \* 100\)\}% instead of 100%, and this read accepts at most \$\{Math\.round\(MAX_RENORMALISED \* 100\)\}% either way/);
  assert.match(s, /if \(Math\.abs\(1 - raw\) > MAX_RENORMALISED\) \{/, "the rule itself is unchanged");
  assert.doesNotMatch(s, /masses sum to/);
});

test("a long tracked group opens to its first rows, says how many there are, and drops none", () => {
  const ui = src("client/src/components/WhaleFlowPanel.tsx");
  assert.match(ui, /const TRACKED_ROWS_SHOWN = 8;/);
  assert.match(ui, /\(showAll \? positions : positions\.slice\(0, TRACKED_ROWS_SHOWN\)\)\.map/);
  assert.match(ui, /`showing \$\{TRACKED_ROWS_SHOWN\} of \$\{positions\.length\}: show all`/);
  assert.match(ui, /positions\.length > TRACKED_ROWS_SHOWN && \(/);
  // The group's header counts and its average still use every position.
  assert.match(ui, /\{positions\.length\} \{positions\.length === 1 \? "pos" : "posns"\}/);
});
