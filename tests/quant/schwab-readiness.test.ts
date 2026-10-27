import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withRequestDeadline } from "../../shared/requestDeadline";
import { retrainEnabled, singleFlight } from "../../server/mlRetrainCron";
import { personalServerHref, serverUrlProblem } from "../../client/src/lib/serverUrl";
import { prepareRuntimeDirectory } from "../../script/runtime-directory.mjs";

test("deadline bounds a stalled body, aborts transport, and never retries", async () => {
  let calls = 0, signal: AbortSignal | undefined;
  await assert.rejects(withRequestDeadline(async s => {
    calls++; signal = s;
    await Promise.resolve(); // headers arrived, body stalls
    return await new Promise(() => {});
  }, 15), /timed out/);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});
test("deadline preserves success, errors, and caller cancellation", async () => {
  assert.equal(await withRequestDeadline(async () => 7, 100), 7);
  await assert.rejects(withRequestDeadline(async () => { throw new Error("fixture"); }), /fixture/);
  const parent = new AbortController();
  parent.abort(new Error("cancelled fixture"));
  let ran = false;
  await assert.rejects(withRequestDeadline(async () => { ran = true; }, 100, parent.signal), /cancelled fixture/);
  assert.equal(ran, false);
});
test("cancelling an active read propagates and removes pending work", async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const result = withRequestDeadline(async s => {
    signal = s;
    return await new Promise(() => {});
  }, 500, parent.signal);
  parent.abort(new Error("changed connection"));
  await assert.rejects(result, /changed connection/);
  assert.equal(signal?.aborted, true);
});
test("retraining is explicit opt-in and impossible in demo", () => {
  assert.equal(retrainEnabled({}), false);
  assert.equal(retrainEnabled({ PULSE_ML_RETRAIN_ENABLED: "0" }), false);
  assert.equal(retrainEnabled({ BATCAVE_EDITION: "personal", PULSE_ML_RETRAIN_ENABLED: "1" }), true);
  assert.equal(retrainEnabled({ BATCAVE_EDITION: "demo", PULSE_ML_RETRAIN_ENABLED: "1" }), false);
});
test("boot and weekly requests cannot overlap; completion and failure release the flight", async () => {
  let calls = 0, release: () => void = () => {};
  const run = singleFlight(async () => { calls++; await new Promise<void>(r => { release = r; }); });
  const one = run(), two = run();
  assert.equal(one, two);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(); await one;
  const three = run(); await Promise.resolve();
  assert.equal(calls, 2);
  release(); await three;
  let failures = 0;
  const fail = singleFlight(async () => { failures++; throw new Error("fixture"); });
  await assert.rejects(fail(), /fixture/);
  await assert.rejects(fail(), /fixture/);
  assert.equal(failures, 2);
});
test("personal-server link never forwards callback secrets or unsafe URLs", () => {
  assert.equal(personalServerHref("https://owned.example"), "https://owned.example/");
  for (const url of ["http://owned.example", "javascript:alert(1)", "https://x.example/?code=secret", "https://user:secret@x.example", "https://x.example/#secret", "https://x.example/api/callback", "https://x.example\\@evil.example/"]) {
    assert.equal(personalServerHref(url), null, url);
  }
  assert.equal(serverUrlProblem("http://127.0.0.1:5000"), null);
});
test("isolated runtime rejects mixed editions and unmarked legacy data without deleting it", () => {
  const base = mkdtempSync(path.join(tmpdir(), "batcave-runtime-test-"));
  try {
    const root = path.join(base, "source"); mkdirSync(root);
    const demo = path.join(base, "demo");
    assert.equal(prepareRuntimeDirectory(demo, "demo", root), demo);
    writeFileSync(path.join(demo, "data.db"), "sample-fixture");
    assert.equal(prepareRuntimeDirectory(demo, "demo", root), demo);
    assert.throws(() => prepareRuntimeDirectory(demo, "personal", root), /edition mismatch/);
    assert.equal(readFileSync(path.join(demo, "data.db"), "utf8"), "sample-fixture");
    const legacy = path.join(base, "legacy"); mkdirSync(legacy);
    writeFileSync(path.join(legacy, "data.db"), "unknown-fixture");
    assert.throws(() => prepareRuntimeDirectory(legacy, "personal", root), /not empty/);
    assert.equal(readFileSync(path.join(legacy, "data.db"), "utf8"), "unknown-fixture");
    assert.throws(() => prepareRuntimeDirectory(path.join(root, "runtime"), "demo", root), /outside/);
    assert.throws(() => prepareRuntimeDirectory("relative", "demo", root), /absolute/);
    writeFileSync(path.join(demo, ".env.local"), "fixture-only");
    assert.throws(() => prepareRuntimeDirectory(demo, "demo", root), /env files/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test("runtime marker rejects symlink substitution", () => {
  const base = mkdtempSync(path.join(tmpdir(), "batcave-marker-test-"));
  try {
    const root = path.join(base, "source"), runtime = path.join(base, "runtime");
    mkdirSync(root); mkdirSync(runtime);
    const marker = path.join(base, "external.json");
    writeFileSync(marker, JSON.stringify({ version: 1, edition: "demo" }));
    symlinkSync(marker, path.join(runtime, ".batcave-runtime.json"));
    assert.throws(() => prepareRuntimeDirectory(runtime, "demo", root), /Invalid runtime marker/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test("every calibration write entry point excludes demo before reading or writing", () => {
  const code = readFileSync(new URL("../../server/mlDataLog.ts", import.meta.url), "utf8");
  for (const name of ["persistSpxMinuteBars", "persistStreamSpxBars", "logTickRealizedVol", "logMlSnapshot", "scorePendingForecasts", "computeDailyCoverage", "checkLiveDemotion"]) {
    const start = code.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    const body = code.slice(start, start + 430);
    assert.match(body, /if \(editionFromEnv\(\) === "demo"\) return/);
  }
  assert.match(code, /if \(running \|\| editionFromEnv\(\) === "demo"\) return/);
  assert.match(code, /finally \{\s+running = false/);
});
test("auth link checks storage before issuing state; Settings uses bounded JSON and no token-as-live claim", () => {
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  const handler = routes.slice(routes.indexOf('app.get("/api/schwab/auth-url"'), routes.indexOf('app.post("/api/schwab/callback"'));
  assert.ok(handler.indexOf('tokenStoreStatus().mode === "locked"') < handler.indexOf("const url = getAuthUrl(returnTo)"));
  const settings = readFileSync(new URL("../../client/src/components/SchwabSettings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /apiRequest\(/);
  assert.doesNotMatch(settings, /isConnected \? "SCHWAB LIVE"/);
  assert.match(settings, /lastMessageAgeMs <= 60_000/);
  assert.match(settings, /return \{ source: "unverified"/);
});
test("alternate hazard backfill cannot label demo candles as Schwab calibration data", () => {
  const hazard = readFileSync(new URL("../../server/hazardEngine.ts", import.meta.url), "utf8");
  for (const name of ["storeCandles", "backfillSpxMinuteBars", "loadRthRows"]) {
    const body = hazard.slice(hazard.indexOf(`function ${name}(`), hazard.indexOf(`function ${name}(`) + 310);
    assert.match(body, /if \(editionFromEnv\(\) === "demo"\) return/);
  }
  assert.match(hazard, /if \(refresherStarted \|\| editionFromEnv\(\) === "demo"\) return/);
});
