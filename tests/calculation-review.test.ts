import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { cryptoAuditStats } from "../server/cryptoAuditStats";
import { normalizeScenarioWeights } from "../server/scenarioWeights";
import { bsPrice, delta, gamma, impliedVol } from "../server/greeks";
import { etEpochMs } from "../server/etTime";

test("crypto statistics count all rows, not only the latest 100", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE crypto_signals (outcome TEXT)");
  const insert = db.prepare("INSERT INTO crypto_signals VALUES (?)");
  for (let i = 0; i < 140; i++) insert.run("OPEN");
  assert.deepEqual(cryptoAuditStats(db), { total: 140, open: 140, hit5m: 0, doubled: 0, rugged: 0, dead: 0, unobservable: 0, graded: 0, sampleThresholdMet: false, calibrated: false });
  for (let i = 0; i < 55; i++) insert.run("DEAD");
  const stats = cryptoAuditStats(db);
  assert.equal(stats.graded, 55);
  assert.equal(stats.sampleThresholdMet, true);
  assert.equal(stats.calibrated, false);
  db.close();
});

test("scenario weights remain finite, nonnegative, and sum to 100", () => {
  assert.deepEqual(normalizeScenarioWeights(80, 80), { bull: 50, bear: 50, base: 0 });
  for (const bull of [NaN, -20, 0, 20, 90, 100, Infinity]) {
    for (const bear of [NaN, -10, 0, 50, 100, Infinity]) {
      const result = normalizeScenarioWeights(bull, bear);
      assert.equal(result.bull + result.bear + result.base, 100);
      assert.ok(Object.values(result).every(x => Number.isFinite(x) && x >= 0));
    }
  }
});

test("Black-Scholes parity, delta/gamma derivatives and IV round trip", () => {
  for (const S of [90, 100, 110]) {
    const K = 100, sigma = 0.25, T = 0.3, r = 0.04, q = 0.01;
    const C = bsPrice(S, K, sigma, T, r, q, "C");
    const P = bsPrice(S, K, sigma, T, r, q, "P");
    assert.ok(Math.abs(C - P - (S * Math.exp(-q*T) - K*Math.exp(-r*T))) < 1e-8);
    const h = 0.01;
    const up = bsPrice(S+h,K,sigma,T,r,q,"C"), down = bsPrice(S-h,K,sigma,T,r,q,"C");
    // The approximate CDF introduces small derivative error near ATM.
    assert.ok(Math.abs((up-down)/(2*h) - delta(S,K,sigma,T,r,q,"C")) < 5e-5);
    assert.ok(Math.abs((up-2*C+down)/(h*h) - gamma(S,K,sigma,T,r,q)) < 5e-5);
    const iv = impliedVol(C, S, K, T, r, q, "C");
    assert.ok(iv != null && Math.abs(iv-sigma)<1e-4);
  }
});

test("social failures remain unknown, partial coverage does not reweight FOMO, and stale data expires", async () => {
  const contents = readFileSync("server/cryptoEngine.ts", "utf8") +
    "\nexport {tracked, upsertFromGtPool, socialTick, scoreCandidate};";
  const bundled = await build({
    stdin: {contents, resolveDir: process.cwd()+"/server", loader:"ts"},
    bundle:true, platform:"node", format:"esm", write:false,
    plugins:[{name:"crypto-fixtures", setup(b) {
      b.onResolve({filter:/^(\.\/storage|child_process)$/}, args=>({path:args.path,namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"}, args=>({
        loader:"js", contents:args.path==="child_process"
          ? "export function execFile(_file,_args,_options,callback){const fixture=globalThis.__pumpFixture;if(!fixture) callback(new Error('blocked'),'');else callback(null,JSON.stringify(fixture));}"
          : "export const sqlite={exec(){},prepare(){return {run(){},all(){return []},get(){return {c:0}}}}};",
      }));
    }}],
  });
  const engine = await import("data:text/javascript;base64,"+Buffer.from(bundled.outputFiles[0].text).toString("base64"));
  const originalFetch=globalThis.fetch;
  const globals=globalThis as any;
  try {
    engine.upsertFromGtPool({attributes:{address:"fixturepair",name:"TEST / SOL",market_cap_usd:100000},relationships:{base_token:{data:{id:"solana_tokenpump"}}}}, "new_pools");
    const c=engine.tracked.values().next().value;
    Object.assign(c,{lastRefreshAt:Date.now(), liquidityUsd:20000,priceUsd:1,vol5m:1000,vol1h:6000,buys5m:6,sells5m:4,bskyMentions1h:99});
    globalThis.fetch=async()=>new Response("blocked",{status:403});
    globals.__pumpFixture=null;
    await assert.rejects(engine.socialTick());
    assert.equal(c.socialScore,null);
    assert.equal(c.bskyMentions1h,null);
    assert.equal(c.socialCheckedAt,null);
    assert.equal(c.socialCoverage,"unavailable");
    globalThis.fetch=async()=>new Response(JSON.stringify({posts:[]}),{status:200});
    c.socialAttemptAt=0;
    await engine.socialTick();
    assert.equal(c.socialCoverage,"partial");
    assert.equal(c.bskyMentions1h,0);
    assert.ok(Math.abs(c.fomoScore-30)<1e-9); // no penalty for a missing source
    globals.__pumpFixture={mint:"tokenpump",reply_count:0,is_currently_live:false};
    c.socialAttemptAt=0;
    await engine.socialTick();
    assert.equal(c.socialCoverage,"ok");
    assert.equal(c.socialScore,0);
    c.socialCheckedAt=Date.now()-11*60_000;
    engine.scoreCandidate(c);
    assert.equal(c.socialCoverage,"stale");
    assert.equal(c.socialScore,null);
  } finally {
    globalThis.fetch=originalFetch;
    delete globals.__pumpFixture;
  }
});

test("ET market-open conversion changes across winter and summer", () => {
  assert.equal(new Date(etEpochMs("2026-01-12",9,30)).toISOString(), "2026-01-12T14:30:00.000Z");
  assert.equal(new Date(etEpochMs("2026-09-28",9,30)).toISOString(), "2026-09-28T13:30:00.000Z");
});

test("sizer rejects invalid/below-floor targets and cannot exceed cash", async () => {
  // Isolate the sizer with deterministic calibration fixtures; no production DB/import side effects.
  const output = await build({
    entryPoints: ["server/positionSizer.ts"], bundle: true, platform: "node",
    format: "esm", write: false,
    plugins: [{ name: "sizing-fixtures", setup(b) {
      b.onResolve({filter: /^\.\/(odteAlertEngine|gradeCalibration)$/}, args => ({path: args.path, namespace: "fixture"}));
      b.onLoad({filter: /.*/, namespace: "fixture"}, args => ({
        contents: args.path.endsWith("odteAlertEngine")
          ? "export const FIRE_GATE=72; export const BANGER_MIN_PCT=30;"
          : "export function getWinProb(){return {p:0.78,source:'prior'}}",
        loader: "js",
      }));
    }}],
  });
  const { sizePosition } = await import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].text).toString("base64"));
  const base = { accountSize: 1000, entryPrice: 1, stopPrice: 0.999, gradeScore: 100, targetPct: 50 };
  assert.equal(sizePosition({...base,targetPct:10}).rejected, true);
  assert.equal(sizePosition({...base,gradeScore:NaN}).rejected, true);
  assert.equal(sizePosition({...base,stopPrice:-1}).rejected, true);
  const capped = sizePosition(base);
  assert.equal(capped.bindingConstraint, "cash-cap");
  assert.equal(capped.contracts, 10);
  assert.ok(capped.notionalDollars <= base.accountSize);
  for (const accountSize of [100, 1000, 10000]) for (const stopPrice of [0, 0.5, 0.999]) {
    const r = sizePosition({...base, accountSize, stopPrice});
    assert.ok(Number.isFinite(r.contracts) && r.contracts >= 0);
    assert.ok(r.notionalDollars <= accountSize);
  }
});
