// One source for ceiling, floor and turning point (framework section 7, master list X1 / M1).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { levelSourceOf, sharedLevels, wallBucket } from "../../server/sharedLevels";
import { _clearHeldMaps } from "../../server/odteMapHold";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("a wall sits on the shared strike when there is one, else on the model's own pick", () => {
  const band = [{ strike: 7100, callGex: 5 }, { strike: 7150, callGex: 9 }, { strike: 7200, callGex: 2 }];
  assert.equal(wallBucket(band, band[1], null), band[1]);
  assert.equal(wallBucket(band, band[1], 7200), band[2]);
  assert.deepEqual(wallBucket(band, band[1], 7190), { strike: 7190, callGex: 2 }, "not in the band: the nearest bucket's exposures at the shared strike");
  assert.equal(wallBucket([], undefined, 7200), undefined);
});

test("the level source says which levels are shared and which are the model's own", () => {
  assert.deepEqual(levelSourceOf({ view: "today", expiry: "2026-11-25", ceiling: 7100, floor: null, turningPoint: 7045 }),
    { view: "today", expiry: "2026-11-25", shared: ["ceiling", "turning point"], own: ["floor"] });
});

test("no map, or a map with no dealer-gamma levels, gives null: the caller keeps its own", async () => {
  _clearHeldMaps();
  assert.equal(await sharedLevels("$SPX", "today", Date.now(), { forward: async () => ({ status: 503, body: null }) }), null);
  assert.equal(await sharedLevels("$SPX", "week", Date.now(), { forward: async () => { throw new Error("down"); } }), null);
});

test("the view picks the expiry the top card uses", async () => {
  const picks: string[] = [];
  await sharedLevels("$SPX", "today", Date.now(), { forward: async (_s, _n, p) => { picks.push(p); return { status: 503, body: null }; } });
  await sharedLevels("$SPX", "week", Date.now(), { forward: async (_s, _n, p) => { picks.push(p); return { status: 503, body: null }; } });
  assert.deepEqual(picks, ["nearest", "week"]);
});

test("Models: daily reads Today, weekly reads This week, monthly keeps its own; the screen says which", () => {
  const m = read("server/models.ts");
  assert.match(m, /horizon === "daily" \? "today" : horizon === "weekly" \? "week" : null/);
  assert.match(m, /if \(shared\?\.turningPoint != null\) scaledProfile\.zeroGammaSpot = shared\.turningPoint/);
  assert.match(m, /wallBucket\(band, band[\s\S]{0,120}shared\?\.ceiling\)/);
  assert.match(read("client/src/components/ModelsPanel.tsx"), /data-testid="models-level-source"/);
  // The hold slots are the route's, so a held map is the one the top card shows.
  const r = read("server/routes.ts");
  assert.match(r, /holdWhileUnchanged\(`\$\{symbol\}\|week`/);
  assert.match(r, /holdWhileUnchanged\(`\$\{symbol\}\|nearest`/);
  assert.match(read("server/sharedLevels.ts"), /holdWhileUnchanged\(`\$\{symbol\}\|\$\{pick\}`/);
});
