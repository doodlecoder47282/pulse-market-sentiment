// Every line the Models chart can draw has a full-word tag and a sentence saying what it means.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODEL_LEVEL_WORDS, modelLevelTag } from "../../shared/modelLevelWords";

const panel = readFileSync(new URL("../../client/src/components/ModelsPanel.tsx", import.meta.url), "utf8");

test("no abbreviation is drawn on the chart: tags are whole words", () => {
  for (const [kind, w] of Object.entries(MODEL_LEVEL_WORDS)) {
    assert.doesNotMatch(w.tag, /\b(PT|TGT|DN|CW|PW|DM|VOL|2ND)\b|Γ/, `${kind}: ${w.tag}`);
    assert.ok(w.means.length > 25 && /\.$/.test(w.means), `${kind} has a sentence`);
  }
  assert.equal(modelLevelTag("zeroGamma"), "TURNING POINT");
  assert.equal(modelLevelTag("callWall"), "CEILING");
  assert.equal(modelLevelTag("putWall"), "FLOOR");
});

test("the chart, the ladder and the legend read the one table", () => {
  assert.match(panel, /return modelLevelTag\(kind\);/);
  assert.match(panel, /push\("zeroGamma", modelLevelTag\("zeroGamma"\)/);
  assert.match(panel, /data-testid="models-level-legend"/);
  assert.doesNotMatch(panel, /"TURN PT"|"UP TGT"|"DN TGT"|`CW \$|`PW \$|`DM \$|`0Γ \$|NEG \\u0393 ·|POS \\u0393 ·/);
  // Every kind the ladder pushes has words.
  for (const m of panel.matchAll(/push\("(\w+)", modelLevelTag/g)) assert.ok(MODEL_LEVEL_WORDS[m[1]], m[1]);
});
