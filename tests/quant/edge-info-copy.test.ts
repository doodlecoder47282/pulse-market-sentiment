// Field-manual copy (client/src/components/EdgeInfo.tsx) describes what a panel
// shows and what it does not. It must not promise an edge, a hit rate or a
// result the app has not measured, and must not read as an instruction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../client/src/components/EdgeInfo.tsx", import.meta.url), "utf8");

test("the third section is no longer headed as an edge", () => {
  assert.doesNotMatch(src, /label: "The edge"/);
  assert.match(src, /What it does and doesn't show/);
  assert.doesNotMatch(src, /human edge/);
});

test("no promissory or unmeasured-performance phrasing in the manual copy", () => {
  const banned = [
    /cheapest edge/i, /far more often/i, /most repeatable/i, /stops that/i, /worth more than the/i, /deserve your money/i,
    /beats memory/i, /instead of vibes/i, /the edge is/i, /\bthe edge that\b/i, /compounds/i, /enter closer/i, /stop tighter/i,
    /cheap insurance/i, /tighten stops/i, /skip marginal/i, /usually resolves/i, /\ba tell\b/i, /decides whether fading/i,
    /right trade/i, /rarely shows up/i, /\bsupport shelves\b/i, /\btrapdoors\b/i, /you know the default route/i,
  ];
  for (const re of banned) assert.doesNotMatch(src, re, String(re));
});

test("every entry that talks about dealer levels or flow also says where Batcave has not measured, or states a published source", () => {
  const entries = src.split(/\n  "?[\w-]+"?: \{\n    title:/).slice(1);
  assert.ok(entries.length >= 20, "found the entries");
  for (const e of entries) {
    const edge = /\n    edge: "(.*?)",\n/s.exec(e)?.[1] ?? "";
    assert.ok(edge.length > 0, "each entry has a does/doesn't-show line");
    // A claim of effect on trading outcomes needs an explicit disclaimer or citation in the same line.
    if (/\b(improve|pays|profit|outcome|predict|forecast)\b/i.test(edge)) {
      assert.match(edge, /not measured|has not measured|have not|does not|not a forecast|None claimed|claims no edge|not proof|not a guarantee|does not show/i, edge.slice(0, 60));
    }
  }
});
