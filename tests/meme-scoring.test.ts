import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { evaluateMemeScore, MEME_SCORE_VERSION, type MemeScoreInput } from "../shared/memeScoring";

const now = 1_790_783_000_000;
const baseline: MemeScoreInput = {
  vol5m: 4000, vol1h: 12000, buys5m: 80, sells5m: 20, lastRefreshAt: now,
  socialScore: 60, socialCheckedAt: now, socialCoverage: "ok", hardKill: false, riskFlagCount: 0,
};

test("versioned decomposition counts flow once and keeps social independent", () => {
  const result = evaluateMemeScore(baseline, now);
  assert.equal(result.version, MEME_SCORE_VERSION);
  assert.equal(result.flowScore, 70);
  assert.deepEqual(result.contributions, { flow: 24.5, structure: 25, social: 6 });
  assert.equal(result.score, 56);
  const noSocial = evaluateMemeScore({ ...baseline, socialScore: 0 }, now);
  assert.equal(noSocial.flowScore, result.flowScore);
  assert.equal(noSocial.contributions.flow, result.contributions.flow);
  assert.equal(noSocial.contributions.social, 0);
});

test("missing/partial/stale social remains null without redistributing weights", () => {
  for (const patch of [
    { socialScore: null }, { socialCoverage: "partial" }, { socialCoverage: "unavailable" },
    { socialCheckedAt: now - 600001 }, { socialCheckedAt: now + 1 },
    { socialScore: NaN }, { socialScore: Infinity }, { socialScore: 101 },
  ]) {
    const result = evaluateMemeScore({ ...baseline, ...patch }, now);
    assert.equal(result.contributions.social, null);
    assert.equal(result.contributions.flow, 24.5);
    assert.equal(result.score, 50);
  }
});

test("missing, zero-baseline and inconsistent flow never become invented acceleration", () => {
  for (const patch of [
    { vol5m: null }, { vol1h: 0 }, { vol1h: null }, { vol5m: -1 }, { vol5m: Infinity },
    { vol1h: 100 }, { buys5m: null }, { sells5m: null }, { buys5m: 0, sells5m: 0 },
    { buys5m: 2.5 }, { buys5m: NaN },
  ]) {
    const result = evaluateMemeScore({ ...baseline, ...patch }, now);
    assert.equal(result.score, null, JSON.stringify(patch));
    assert.equal(result.inputStatus.flow, "missing");
  }
  const zeroVolume = evaluateMemeScore({ ...baseline, vol5m: 0 }, now);
  assert.equal(zeroVolume.volAccel, 0);
});

test("stale and future market evidence cannot yield a ranking; bounds and determinism hold", () => {
  for (const lastRefreshAt of [null, now - 300001, now + 1, NaN]) {
    assert.equal(evaluateMemeScore({ ...baseline, lastRefreshAt }, now).score, null);
  }
  for (const buys5m of [0, 5, 50, 100]) for (const riskFlagCount of [0, 1, 5, 100]) {
    const input = { ...baseline, buys5m, riskFlagCount };
    const result = evaluateMemeScore(input, now);
    assert.deepEqual(result, evaluateMemeScore(input, now));
    assert.ok(result.score != null && result.score >= 0 && result.score <= result.budget);
  }
  assert.equal(evaluateMemeScore({ ...baseline, hardKill: true }, now).contributions.structure, 0);
});

test("engine integration: promotion/name/trending cannot lift rank; hard gates and missing data win", async () => {
  const contents = readFileSync("server/cryptoEngine.ts", "utf8") +
    "\nexport {tracked,upsertFromGtPool,scoreCandidate,persistSignal};";
  const output = await build({ stdin: { contents, resolveDir: process.cwd() + "/server", loader: "ts" },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "meme-db-fixture", setup(b) {
      b.onResolve({ filter: /^\.\/storage$/ }, args => ({ path: args.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents:
        "export const sqlite={exec(){},prepare(){return {all(){return []},get(){return {}},run(...args){globalThis.__memeAuditArgs=args}}}};" }));
    } }],
  });
  const engine = await import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].text).toString("base64"));
  engine.upsertFromGtPool({ attributes: { address: "meme-fixture", name: "TEST / SOL", market_cap_usd: 100000 },
    relationships: { base_token: { data: { id: "solana_mint-fixture" } } } }, "new_pools");
  const c = engine.tracked.values().next().value;
  const current = Date.now();
  Object.assign(c, baseline, { lastRefreshAt: current, socialCheckedAt: current, marketCap: 100000,
    priceUsd: 0.01, liquidityUsd: 20000, buys1h: 100, sells1h: 30, vol24h: 100000,
    liquidityEvidence: { provider: "DexScreener", fetchedAt: current, pairAddress: c.pairAddress },
    securityEvidence: { state: "CHECKED" },
    pairCreatedAt: current - 3600_000, mintAuthorityActive: false, freezeAuthorityActive: false,
    securityCheckedAt: current, rcRisks: [], top10Pct: null });
  engine.scoreCandidate(c);
  const originalScore = c.score;
  assert.equal(c.verdict, "WATCH");
  c.name = "Baby Pepe Cat Moon"; c.symbol = "PEPE"; c.discoveredVia = "trending";
  engine.scoreCandidate(c);
  assert.equal(c.score, originalScore);
  c.boosted = true; engine.scoreCandidate(c);
  assert.ok(c.score <= originalScore);
  assert.equal(c.fomoScore, 70);
  c.boosted = false;
  c.socialScore = 100; c.buys5m = 100; c.sells5m = 0;
  engine.scoreCandidate(c);
  assert.equal(c.verdict, "WATCH"); // no inherited ENTER threshold on a changed formula
  engine.persistSignal(c);
  const args = (globalThis as any).__memeAuditArgs;
  const features = JSON.parse(args[12]);
  assert.equal(features.scoreVersion, MEME_SCORE_VERSION);
  assert.equal(evaluateMemeScore(features.scoreInputs, features.scoreBreakdown.evaluatedAt).score, c.score);
  for (const [field, bad] of [["mintAuthorityActive", true], ["freezeAuthorityActive", true],
    ["liquidityUsd", 0], ["priceUsd", 0], ["vol1h", null], ["lastRefreshAt", current - 600000]] as const) {
    const original = c[field]; c[field] = bad;
    engine.scoreCandidate(c);
    assert.equal(c.verdict, "PASS", field);
    assert.equal(c.risk, null, field);
    c[field] = original;
  }
  c.sells1h = null; c.mintAuthorityActive = null; c.freezeAuthorityActive = null; c.securityEvidence = null;
  engine.scoreCandidate(c);
  assert.equal(c.hardKill, false); // missing sells is not observed zero sells
  assert.equal(c.verdict, "PASS");
  assert.ok(c.verdictReasons.some((r: string) => r.includes("incomplete")));
  c.socialCheckedAt = Date.now() - 660000;
  const result = engine.getCryptoFeed();
  assert.equal(result.scoreVersion, MEME_SCORE_VERSION);
  assert.equal(c.socialCoverage, "stale");
  assert.equal(c.scoreBreakdown.contributions.social, null);
  delete (globalThis as any).__memeAuditArgs;
});
