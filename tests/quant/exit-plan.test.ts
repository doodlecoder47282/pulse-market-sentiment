import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRYPTO_RULES } from "../../shared/cryptoRules";
import { advancePlan, newPlanState, planLevels, planReturnPct, planSummary, planRecordByVersion, compareVersionsDesc, pricingOf, sizeFromBankroll, buildTradePrompt } from "../../shared/exitPlan";
import { schwabRedirectUri, schwabConfigProblem } from "../../server/schwabOAuth";
import { tokenKeyPolicy, wantsLocalKeyFile } from "../../server/tokenCrypto";
import { loadLocalKey, localKeyPath, resolveTokenKeyPolicy } from "../../server/tokenKeyFile";
import { DatabaseSync } from "node:sqlite";
import { EXIT_PLAN_TABLE_SQL, EXIT_PLAN_UPSERT_SQL } from "../../server/exitPlanSql";

const H = 3600_000;

test("plan levels come from the rule book; trims at or above the target fold into it", () => {
  const lv = planLevels(500_000);
  assert.deepEqual(lv.filter((l) => l.kind === "trim").map((l) => l.multiple), [2, 4]);
  const tgt = lv.find((l) => l.kind === "target")!;
  assert.equal(tgt.mcap, CRYPTO_RULES.universe.targetMcapUsd);
  assert.equal(tgt.sellShare, 0.25);
  const near = planLevels(1_500_000); // 4x = 6M is past the 5M target
  assert.deepEqual(near.filter((l) => l.kind === "trim").map((l) => l.multiple), [2]);
  assert.equal(near.find((l) => l.kind === "target")!.sellShare, 0.5);
  assert.equal(lv.find((l) => l.kind === "stop")!.multiple, 1 + CRYPTO_RULES.sizing.suggestedStopPct / 100);
});

test("path: trims fill at the level, stop moves to entry after the first trim, stop fills at the sample", () => {
  let s = newPlanState(100_000, 20_000, 0, "t")!;
  s = advancePlan(s, { at: 1, mcap: 150_000, liquidity: 25_000 });
  assert.equal(s.fills.length, 0);
  s = advancePlan(s, { at: 2, mcap: 230_000, liquidity: 30_000 });
  assert.equal(s.fills.length, 1);
  assert.equal(s.fills[0].multiple, 2);        // at the level, not the sample
  assert.equal(s.remaining, 0.5);
  assert.equal(s.stopMultiple, 1);
  s = advancePlan(s, { at: 3, mcap: 90_000, liquidity: 22_000 });
  assert.equal(s.closedAt, 3);
  assert.equal(s.fills[1].kind, "stop");
  assert.equal(s.fills[1].multiple, 0.9);      // gapped through: the sample
  assert.equal(s.fills[1].share, 0.5);
  const r = planReturnPct(s)!;
  assert.ok(r > 0 && r < 60, `net ${r}`);
});

test("path: several levels in one sample, liquidity stop, time stop, out-of-order samples ignored", () => {
  let s = newPlanState(100_000, 20_000, 0, "t")!;
  s = advancePlan(s, { at: 5, mcap: 6_000_000, liquidity: 200_000 });
  assert.deepEqual(s.fills.map((f) => [f.kind, f.multiple, f.share]), [["trim", 2, 0.5], ["trim", 4, 0.25], ["target", 50, 0.25]]);
  assert.equal(s.closedAt, 5);

  let l = newPlanState(100_000, 20_000, 0, "t")!;
  l = advancePlan(l, { at: 1, mcap: 120_000, liquidity: 13_000 });
  assert.equal(l.fills[0].kind, "liquidityStop");

  let t = newPlanState(100_000, 20_000, 0, "t")!;
  t = advancePlan(t, { at: 10, mcap: 110_000, liquidity: 20_000 });
  const before = t;
  t = advancePlan(t, { at: 5, mcap: 10, liquidity: 20_000 });
  assert.equal(t, before);
  t = advancePlan(t, { at: CRYPTO_RULES.sizing.holdHorizonHours * H, mcap: 120_000, liquidity: 20_000 });
  assert.equal(t.fills[0].kind, "timeStop");

  let m = newPlanState(100_000, 20_000, 0, "t")!;
  m = advancePlan(m, { at: 1, mcap: null, liquidity: null }); // missing is not a sample
  assert.equal(m.closedAt, null);
});

test("pulled pool returns -100; summary gate says INSUFFICIENT DATA under the sample", () => {
  let s = newPlanState(100_000, 20_000, 0, "t")!;
  s = advancePlan(s, { at: 1, mcap: 0, liquidity: 0 });
  assert.equal(planReturnPct(s), -100);
  const sum = planSummary([s]);
  assert.equal(sum.ready, false);
  assert.match(sum.label, /INSUFFICIENT DATA: 1 of 50/);
});

test("record by rule version: the current version is the headline, earlier versions are kept each on their own, nothing pooled", () => {
  const mk = (ver: string, at: number, closeMcap: number | null) => {
    let s = newPlanState(100_000, 20_000, at, ver)!;
    if (closeMcap != null) s = advancePlan(s, { at: at + 60_000, mcap: closeMcap, liquidity: 20_000 });
    return s;
  };
  const states = [
    mk("2026.11.06-1", 1_000, 0), mk("2026.11.06-1", 2_000, null),
    mk("2026.10.30-2", 3_000, 0), mk("2026.10.30-2", 4_000, 0), mk("2026.10.30-2", 5_000, null),
    mk("", 6_000, 0),
  ];
  const r = planRecordByVersion(states, "2026.11.06-1", 10_000);
  assert.equal(r.current.closed, 1); assert.equal(r.current.open, 1);
  assert.deepEqual(r.versions.map((v) => v.version), ["2026.10.30-2", "unversioned"], "dated versions newest first, unversioned last");
  assert.deepEqual(["2026.11.06-1", "unversioned", "2026.11.06-10", "2026.10.27-2", "2026.11.06-2"].sort(compareVersionsDesc),
    ["2026.11.06-10", "2026.11.06-2", "2026.11.06-1", "2026.10.27-2", "unversioned"], "numeric suffix, not lexical");
  const old = r.versions.find((v) => v.version === "2026.10.30-2")!;
  assert.equal(old.closed, 2); assert.equal(old.open, 1);
  assert.equal(r.versions.find((v) => v.version === "unversioned")!.closed, 1);
  assert.deepEqual(r.allVersions, { plans: 6, closed: 4, versions: 3 });
  // A rule bump no longer erases the record: the old version's plans are still there, summarised on their own.
  const bumped = planRecordByVersion(states, "2026.11.12-1", 10_000);
  assert.equal(bumped.current.closed, 0); assert.equal(bumped.current.open, 0);
  assert.equal(bumped.versions.find((v) => v.version === "2026.11.06-1")!.closed, 1);
  assert.equal(bumped.allVersions.versions, 3, "the empty current version is not counted");
});

test("an earlier version's return is priced with the fees and size it started under, not a later book", () => {
  const rules = CRYPTO_RULES;
  let s = newPlanState(100_000, 20_000, 0, "2026.10.30-2", rules)!;
  s = advancePlan(s, { at: 60_000, mcap: 250_000, liquidity: 20_000 }); // trims
  s = advancePlan(s, { at: 120_000, mcap: 60_000, liquidity: 20_000 });  // stop
  assert.ok(s.closedAt != null);
  assert.deepEqual(s.pricing, pricingOf(rules));
  const under = planReturnPct(s)!;
  const cheaper = { ...rules, cost: { ...rules.cost, platformFeePct: 0 }, grading: { ...rules.grading, sizeUsd: 1000 } };
  assert.equal(planReturnPct(s, undefined, cheaper), under, "a later book's fees and size do not restate the old plan");
  assert.equal(planRecordByVersion([s], "2026.11.12-1", 200_000, cheaper).versions[0].medianPct, under);
  // A plan from before pricing was recorded is priced with the book passed in, as the record says.
  const legacy = { ...s, pricing: undefined };
  assert.notEqual(planReturnPct(legacy, undefined, cheaper), under);
  // An explicit size still overrides.
  assert.notEqual(planReturnPct(s, 1000), under);
});

test("size: bankroll x risk / |stop|, capped by the pool maximum; no bankroll, no size", () => {
  assert.equal(sizeFromBankroll(null, 400).sizeUsd, null);
  const r = sizeFromBankroll(5_000, 400);
  assert.equal(r.sizeUsd, Math.floor(5_000 * 0.01 / 0.35));
  assert.equal(r.bound, "risk");
  const p = sizeFromBankroll(100_000, 400);
  assert.equal(p.sizeUsd, 400);
  assert.equal(p.bound, "pool");
  assert.equal(sizeFromBankroll(5_000, null).sizeUsd, null);
});

test("prompt carries the data, the plan and unread states, never a fake zero", () => {
  const txt = buildTradePrompt({
    symbol: "TST", name: "Test", chain: "solana", tokenAddress: "Mint111", pairAddress: "Pair111", dexId: "pumpswap",
    priceUsd: 0.0001, marketCap: 100_000, liquidityUsd: 20_000, vol5m: null, vol1h: 5000, vol24h: null,
    buys5m: 10, sells5m: null, chg5m: 1, chg1h: null, chg24h: null, ageMinutes: 30,
    mintAuthorityActive: false, freezeAuthorityActive: null, top10Pct: null, rcLpLockedPct: null, rcRisks: [], rugFlags: [],
    boosted: false, pumpfunGraduate: true, pumpLive: false, narrativeHits: [], verdict: "ENTER", score: 72, verdictReasons: ["ok"],
  }, "$142", CRYPTO_RULES, 0);
  assert.match(txt, /Mint111/);
  assert.match(txt, /sell 50% at 2x/);
  assert.match(txt, /freeze authority unread/);
  assert.match(txt, /top-10 holders unread/);
  assert.match(txt, /Size: \$142/);
  assert.doesNotMatch(txt, /top-10 holders 0/);
  assert.match(txt, /Data as of: pair read time unknown/);
});

test("prompt dates the market data from the pair read and flags data older than the freshness limit", () => {
  const base = {
    symbol: "TST", name: "Test", chain: "solana", tokenAddress: "Mint111", pairAddress: "Pair111", dexId: "pumpswap",
    priceUsd: 0.0001, marketCap: 100_000, liquidityUsd: 20_000, vol5m: null, vol1h: 5000, vol24h: null,
    buys5m: 10, sells5m: null, chg5m: 1, chg1h: null, chg24h: null, ageMinutes: 30,
    mintAuthorityActive: false, freezeAuthorityActive: null, top10Pct: null, rcLpLockedPct: null, rcRisks: [], rugFlags: [],
    boosted: false, pumpfunGraduate: true, pumpLive: false, narrativeHits: ["trump"], verdict: "WATCH", score: 72,
    verdictReasons: ["held at WATCH: pair data last refreshed 180.0 min ago (limit 10 min)", "a", "b", "c", "narrative confirm: trump"],
  };
  const now = Date.parse("2026-11-06T15:00:00Z");
  const stale = buildTradePrompt({ ...base, lastRefreshAt: now - 3 * 3600_000 }, "$1", CRYPTO_RULES, now);
  assert.match(stale, /Data as of: 2026-11-06T12:00:00\.000Z \(pair read 180\.0 min before this prompt was copied; OLDER than the desk's 10-min freshness limit, treat as stale\)/);
  assert.match(stale, /DESK READ [^\n]*WATCH[^\n]*held at WATCH: pair data last refreshed 180\.0 min ago/, "the hold reason survives the 4-reason cut");
  const fresh = buildTradePrompt({ ...base, lastRefreshAt: now - 2 * 60_000 }, "$1", CRYPTO_RULES, now);
  assert.match(fresh, /\(pair read 2\.0 min before this prompt was copied\)/);
  // 9.6 min: under the limit, no flag; 10.3 min: flagged, and never printed as "10 min".
  assert.match(buildTradePrompt({ ...base, lastRefreshAt: now - 576_000 }, "$1", CRYPTO_RULES, now), /\(pair read 9\.6 min before this prompt was copied\)/);
  assert.match(buildTradePrompt({ ...base, lastRefreshAt: now - 618_000 }, "$1", CRYPTO_RULES, now), /pair read 10\.3 min before this prompt was copied; OLDER than/);
});

test("Railway: callback defaults from the public domain; an explicit value wins", () => {
  assert.equal(schwabRedirectUri({ RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }), "https://x.up.railway.app/api/schwab/oauth/callback");
  assert.equal(schwabRedirectUri({ RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app", SCHWAB_REDIRECT_URI: "https://127.0.0.1" }), "https://127.0.0.1");
  assert.equal(schwabRedirectUri({}), "");
  assert.equal(schwabConfigProblem({ SCHWAB_CLIENT_ID: "a", SCHWAB_CLIENT_SECRET: "b", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }), null);
  assert.match(String(schwabConfigProblem({ SCHWAB_CLIENT_ID: "a", SCHWAB_CLIENT_SECRET: "b" })), /SCHWAB_REDIRECT_URI/);
});

test("Railway: with a volume and no BATCAVE_TOKEN_KEY the key is generated on the volume; without one, storage stays locked", () => {
  const vol = mkdtempSync(path.join(os.tmpdir(), "vol-"));
  try {
    const env = { BATCAVE_BIND_HOST: "0.0.0.0", HOST: "0.0.0.0", RAILWAY_VOLUME_MOUNT_PATH: vol };
    assert.equal(wantsLocalKeyFile(env), true);
    const p = localKeyPath(env);
    assert.equal(p, path.join(vol, ".batcave", "token.key"));
    // The deploy guide mounts the volume at /app/data, inside the app's own data/: allowed only as the volume.
    assert.equal(loadLocalKey(p, { create: true, cwd: path.dirname(vol) + "/" + "x", volume: null })?.ok, true);
    rmSync(path.join(vol, ".batcave"), { recursive: true, force: true });
    const inside = loadLocalKey(path.join(vol, ".batcave", "token.key"), { create: true, cwd: vol, volume: null });
    assert.equal(inside?.ok, false);
    const k = loadLocalKey(p, { create: true, cwd: vol, volume: vol });
    assert.ok(k?.ok);
    assert.equal(tokenKeyPolicy(env, k).mode, "encrypted");
    const bare = { BATCAVE_BIND_HOST: "0.0.0.0", HOST: "0.0.0.0" };
    assert.equal(wantsLocalKeyFile(bare), false);
    assert.equal(tokenKeyPolicy(bare, null).mode, "locked");
  } finally { rmSync(vol, { recursive: true, force: true }); }
});

test("plan rows round-trip with the TEXT signal ids crypto_signals uses", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(EXIT_PLAN_TABLE_SQL);
  const up = db.prepare(EXIT_PLAN_UPSERT_SQL);
  up.run({ id: "solana:Pair111:1793744274352", tok: "Mint", json: "{}", closed: 0, now: 1 });
  up.run({ id: "solana:Pair111:1793744274352", tok: "Mint", json: "{\"a\":1}", closed: 1, now: 2 });
  const row = db.prepare("SELECT state_json, closed FROM crypto_exit_plans").all() as any[];
  assert.equal(row.length, 1);
  assert.equal(row[0].closed, 1);
});

test("liquidity stop never credits more than the next unfilled level; stale open plans are no data", () => {
  let s = newPlanState(100_000, 20_000, 0, "t")!;
  s = advancePlan(s, { at: 1, mcap: 1_000_000, liquidity: 12_000 });
  assert.equal(s.fills[0].kind, "liquidityStop");
  assert.equal(s.fills[0].multiple, 2);
  let n = newPlanState(100_000, 20_000, 0, "t")!;
  n = advancePlan(n, { at: 1, mcap: 50_000, liquidity: null }); // cap without liquidity: not priced
  assert.equal(n.closedAt, null);
  const open = newPlanState(100_000, 20_000, 0, "t")!;
  const sum = planSummary([open], (CRYPTO_RULES.sizing.holdHorizonHours + 25) * H);
  assert.equal(sum.noData, 1);
  assert.equal(sum.open, 0);
});

test("resolved policy on a Railway volume inside the app dir is encrypted from the volume file", () => {
  const vol = mkdtempSync(path.join(os.tmpdir(), "appdata-"));
  const prev = process.cwd();
  try {
    process.chdir(path.dirname(vol));
    const env = { HOST: "0.0.0.0", RAILWAY_VOLUME_MOUNT_PATH: vol };
    const r = resolveTokenKeyPolicy(env);
    assert.equal(r.policy.mode, "encrypted");
    assert.equal(r.policy.keySource, "file");
  } finally { process.chdir(prev); rmSync(vol, { recursive: true, force: true }); }
});
