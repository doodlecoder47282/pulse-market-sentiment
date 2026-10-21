// tests/quant/setup-rules-version.test.ts
//
// A changed threshold with an unchanged rule version would contaminate the
// graded history (grading is per version). This pins the rule book's content
// to its version string: change a rule, bump SETUP_RULES_VERSION, update the
// hash here in the same commit. The hash is of the canonical JSON, so key
// order and comments do not matter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DEFAULT_SETUP_RULES, SETUP_RULES_VERSION, describeRules } from "../../shared/setupRules";

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const PINNED: Record<string, string> = {
  "2026.10.20-2": "ea71830478b9737f0afc1f70e438cc8a9758291a4fc15a1cd16a84fb82f70450",
  // 2026.10.21-1: events.tier1QuietAfterMin added (60), after the first review of the merged log.
  "2026.10.21-1": "9e3c770489fcd14c8888fa7c3d48c61cfb1bd6610848e2e2196f90cace3d4ea8",
};

test("rule book content is pinned to its version: a threshold change needs a version bump and a new pin", () => {
  const { version, ...rules } = DEFAULT_SETUP_RULES;
  assert.equal(version, SETUP_RULES_VERSION);
  const hash = createHash("sha256").update(canonical(rules)).digest("hex");
  const pinned = PINNED[version];
  assert.ok(pinned, `no pin for rule version ${version}: add PINNED["${version}"] = "${hash}"`);
  assert.equal(hash, pinned, `rule book changed under version ${version}: bump SETUP_RULES_VERSION and pin the new hash ${hash}`);
  // Every rule in the book is described for the Method panel.
  const paths = new Set(describeRules().map((d) => d.path));
  const walk = (o: any, prefix: string): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? walk(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  for (const p of walk(rules, "")) assert.ok(paths.has(p), `rule ${p} has no Method-panel description`);
});
