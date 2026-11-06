// The /api/models failure fallback must read the disk key the live build wrote.
// The live path defaults to experimental (only ?experimental=0 disables it);
// the fallback used to default to non-experimental, so requests without the
// parameter (Models panel, Discord, edge briefing) looked up a key that
// experimental builds never write and the saved-session copy was never served.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("models fallback: same experimental default and same disk key as the live build", () => {
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const start = r.indexOf('app.get("/api/models"');
  const handler = r.slice(start, r.indexOf("MM-matrix prediction logger", start));
  const parses = handler.match(/const experimental = [^;]+;/g) ?? [];
  assert.equal(parses.length, 2, "live path and fallback each parse the flag");
  assert.equal(parses[0], parses[1], "both parse it the same way");
  assert.equal(parses[0], 'const experimental = String(req.query.experimental ?? "1") !== "0";');
  const key = /`models-\$\{symbol\}\$\{experimental \? "-exp" : ""\}-\$\{rthSessionKey\(\)\}`/;
  assert.match(r.slice(r.indexOf("async function buildModelsForKey(")), key, "the build writes this key");
  assert.match(handler, key, "the fallback reads the same key");
});
