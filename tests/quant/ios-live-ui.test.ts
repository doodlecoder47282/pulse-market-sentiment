// The native shell loads the UI live from the owner's server (capacitor.config
// server.url): the page's origin is the API, so no setup screen; CI's simulator
// check must not reach that server and the zip must carry the url.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("capacitor config points the shell at the server over https; CI strips it for the simulator and restores it for the zip", () => {
  const cfg = JSON.parse(src("capacitor.config.json"));
  assert.match(cfg.server?.url ?? "", /^https:\/\/[a-z0-9.-]+\.up\.railway\.app$/);
  assert.equal(cfg.server.cleartext, false);
  assert.equal(cfg.webDir, "dist/public", "offline fallback bundle kept");
  const wf = src(".github/workflows/ios-build.yml");
  assert.ok(wf.indexOf("delete c.server") < wf.indexOf("npx cap sync ios"), "server removed before the simulator sync");
  assert.match(wf, /git checkout -- ios\/App\/App\/Info\.plist capacitor\.config\.json/);
  assert.match(wf, /server\.url missing from the packaged config/);
});

test("api base: a native shell served from an https origin uses that origin before any baked or stored value falls back", () => {
  const qc = src("client/src/lib/queryClient.ts");
  assert.match(qc, /readConnectionSetting\(API_BASE_STORAGE_KEY\) \|\| liveOriginBase\(\) \|\| BUILD_API_BASE \|\| PREVIEW_API_BASE/);
  assert.match(qc, /protocol === "https:" \|\| protocol === "http:" \? origin : ""/);
  assert.match(qc, /!isNativeApp\(\)\) return "";/);
});
