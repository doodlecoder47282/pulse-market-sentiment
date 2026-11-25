import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainLevelName } from "../../shared/plainLevelName";
import { TODAY_LABELS } from "../../shared/todayPlan";

test("stored labels read with the names the top card uses", () => {
  assert.equal(plainLevelName("wall above"), TODAY_LABELS.above);
  assert.equal(plainLevelName("magnet below"), TODAY_LABELS.below);
  assert.equal(plainLevelName("gamma flip"), TODAY_LABELS.flip);
  assert.equal(plainLevelName("pivot S1 + pin + wall above"), "support from yesterday's pivot (S1) + pin level + ceiling above");
  assert.equal(plainLevelName("pivot"), "yesterday's pivot (average of high, low and close)");
  assert.equal(plainLevelName("prior-day high"), "prior-day high");
  assert.equal(plainLevelName("straddle high"), "top of the priced move");
  assert.equal(plainLevelName(null), "");
  assert.equal(plainLevelName("the pin level holds"), "the pin level holds");
  assert.equal(plainLevelName("fade at the call wall; +1 sigma to the close"), "fade at the ceiling; +one typical move to the close");
});

test("Outlook, the Desk board, its log and the level record print labels through it", () => {
  for (const f of ["Outlook.tsx", "DeskBoard.tsx", "DeskProtocols.tsx", "LevelRecordCard.tsx"]) {
    assert.match(readFileSync(new URL(`../../client/src/components/${f}`, import.meta.url), "utf8"), /plainLevelName\(/, f);
  }
});
