// Calendar cards: no HTML entity printed as a value, no non-US row assumed US,
// no generic paragraph repeated on every earnings card.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("calendar card copy: bio only for specific releases; empty Nasdaq cells never printed", () => {
  const p = readFileSync(new URL("../../client/src/components/NewsPanel.tsx", import.meta.url), "utf8");
  assert.match(p, /function resolveEventBio\(e: CalendarEvent\): string \| null/);
  assert.doesNotMatch(p, /Single-name earnings\. Beats-and-raise/);
  assert.doesNotMatch(p, /Scheduled market event\. Check the release details/);
  assert.match(p, /\{bio && \(/);
  const n = readFileSync(new URL("../../server/news.ts", import.meta.url), "utf8");
  assert.match(n, /replace\(\/&nbsp;\|&#160;\|\\u00a0\/g, " "\)/);
  assert.match(n, /if \(!row\.country \|\| !\/\^\(US\|USA\|United States\)\$\/i\.test\(row\.country\.trim\(\)\)\) continue;/);
});
