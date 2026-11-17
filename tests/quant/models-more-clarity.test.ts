// Owner report 2026-11-17: "+N more" on the Models tab could not be opened; the Wiener map needed a plain read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hitProbability } from "../../shared/odteWiener";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("Models catalysts: '+N more' is a button that opens the day's full list", () => {
  const m = read("client/src/components/ModelsPanel.tsx");
  assert.doesNotMatch(m, /<span className="font-mono text-\[11px\] text-muted-foreground">\+\{events\.length - 4\} more<\/span>/);
  assert.match(m, /\(openDays\.has\(label\) \? events : events\.slice\(0, 4\)\)\.map/);
  assert.match(m, /onClick=\{\(\) => toggleDay\(label\)\}\s*aria-expanded=\{openDays\.has\(label\)\}/);
  assert.match(m, /className="min-h-\[28px\]/, "a tap target of at least 24px");
});

test("Wiener map: a plain-language read comes first, with a guide; its statements match the model", () => {
  const o = read("client/src/components/OdteForward.tsx");
  const i = o.indexOf('data-testid="odte-plain-read"'), j = o.indexOf('label="Clock"');
  assert.ok(i > 0 && i < j, "the plain read is above the chips");
  assert.match(o, /no view on direction/);
  assert.match(o, /not a forecast/);
  assert.match(o, /data-testid="odte-wiener-guide"/);
  assert.doesNotMatch(o.slice(i, j), /\b(buy|sell|should|edge|likely to)\b/i);
  // "A level 1 sigma away is touched about one time in three" (2(1 - Phi(1)) = 0.317).
  const p = hitProbability(10, 0, 10, 1);
  assert.ok(Math.abs(p - 0.3173) < 0.001, String(p));
  // The guide's band description matches the drawing order: the inner 25-75 band is the darkest.
  assert.match(o, /fillBand\("p025", "p975", 0\.07\);\s*fillBand\("p10", "p90", 0\.10\);\s*fillBand\("p25", "p75", 0\.14\);/);
});
