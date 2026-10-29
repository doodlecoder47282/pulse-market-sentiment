// Contract autopsy (shared/cryptoAutopsy.ts): address parsing, every gate at its
// boundary against the rule book's own values, unread-is-never-pass, the
// holder-dump stress maths in closed form, and a source guard that the runner
// never stores, tracks or grades anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseMintInput, autopsyGates, summarizeGates, holderDumpStress, STRESS_FRACTIONS,
  type AutopsyFacts, type Gate,
} from "../../shared/cryptoAutopsy";
import { CRYPTO_RULES as R } from "../../shared/cryptoRules";

const MINT = "So11111111111111111111111111111111111111112";
const PUMP = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";

const clean = (over: Partial<AutopsyFacts> = {}): AutopsyFacts => ({
  liquidityUsd: 60_000, marketCap: 400_000, fdv: 400_000, priceUsd: 0.0004, buys1h: 80, sells1h: 60, chg1h: 12, vol24h: 90_000, ageMinutes: 300,
  mintAuthorityActive: false, freezeAuthorityActive: false, top10Pct: 22, top10Method: "top-10 holders excluding pool vault", rcLpLockedPct: 95,
  jupState: "agree", jupGapPct: 1.2, volAccel: 2.4, netBuyRatio5m: 0.66, score: 78, ...over,
});
const by = (g: Gate[]) => Object.fromEntries(g.map((x) => [x.id, x]));
const st = (f: AutopsyFacts, id: string) => by(autopsyGates(f))[id].state;

test("address parsing: exactly one base58 string of 32-44 chars; ambiguity and junk are rejected, never guessed", () => {
  assert.deepEqual(parseMintInput(MINT), { ok: true, mint: MINT });
  assert.deepEqual(parseMintInput(`  ${PUMP}\n`), { ok: true, mint: PUMP });
  assert.deepEqual(parseMintInput(`CA: ${PUMP} !`), { ok: true, mint: PUMP }, "one address inside text is accepted");
  assert.deepEqual(parseMintInput(`${PUMP} ${PUMP}`), { ok: true, mint: PUMP }, "the same address twice is still one address");
  for (const bad of [
    `${MINT} ${PUMP}`, "", "   ", "abc", "0".repeat(40), "O".repeat(40), "l".repeat(40), "I".repeat(40), "x".repeat(301), null, undefined, 42, {},
  ]) assert.equal(parseMintInput(bad as any).ok, false, String(bad));
  assert.match((parseMintInput(`${MINT} ${PUMP}`) as any).reason, /more than one/);
});

test("a fully clean read passes every gate except sustained flow, which one snapshot can never decide", () => {
  const g = autopsyGates(clean());
  const s = summarizeGates(g);
  assert.equal(s.fail, 0);
  assert.equal(s.killed, false);
  assert.equal(by(g).flow_sustained.state, "unread");
  assert.equal(s.unread, 1);
  assert.equal(s.pass, g.length - 1);
  assert.match(by(g).flow_sustained.rule, new RegExp(`${R.enter.sustainedPolls.need} of the last ${R.enter.sustainedPolls.window}`));
});

test("kill gates sit exactly on the rule book thresholds", () => {
  const floor = R.universe.liquidityFloorUsd;
  assert.equal(st(clean({ liquidityUsd: floor, marketCap: floor * 10 }), "liquidity"), "pass", "exactly at the floor passes (engine: < floor kills)");
  assert.equal(st(clean({ liquidityUsd: floor - 1, marketCap: 1e6 }), "liquidity"), "fail");
  assert.equal(st(clean({ liquidityUsd: 0 }), "liquidity"), "fail");
  const nul = by(autopsyGates(clean({ liquidityUsd: null })));
  assert.equal(nul.liquidity.state, "fail", "missing liquidity is a kill, as the engine treats it");
  assert.match(nul.liquidity.value, /not reported/);
  assert.equal(nul.exit_door.state, "unread");

  const door = R.hardKills.exitDoorMinLiqToMcap;
  assert.equal(st(clean({ liquidityUsd: 100_000, marketCap: 100_000 / door }), "exit_door"), "pass", "exactly at the door passes (engine: < door kills)");
  assert.equal(st(clean({ liquidityUsd: 100_000, marketCap: 100_000 / door + 1 }), "exit_door"), "fail");
  assert.equal(st(clean({ marketCap: null, fdv: null }), "exit_door"), "unread");
  assert.equal(st(clean({ marketCap: null, fdv: 400_000 }), "exit_door"), "pass", "the engine's market-cap basis falls back to FDV");

  const hp = R.hardKills.honeypotMinBuys1h;
  assert.equal(st(clean({ buys1h: hp, sells1h: 0 }), "honeypot"), "fail");
  assert.equal(st(clean({ buys1h: hp - 1, sells1h: 0 }), "honeypot"), "pass");
  assert.equal(st(clean({ buys1h: 500, sells1h: 1 }), "honeypot"), "pass");
  assert.equal(st(clean({ buys1h: 500, sells1h: null }), "honeypot"), "unread", "a missing sell count is unread, never zero sells");

  const rug = R.hardKills.midRugChg1hPct;
  assert.equal(st(clean({ chg1h: rug }), "mid_rug"), "fail", "engine: <= threshold kills");
  assert.equal(st(clean({ chg1h: rug + 0.1 }), "mid_rug"), "pass");
  assert.equal(st(clean({ chg1h: null }), "mid_rug"), "unread");

  for (const [field, id] of [["mintAuthorityActive", "mint_authority"], ["freezeAuthorityActive", "freeze_authority"]] as const) {
    assert.equal(st(clean({ [field]: true }), id), "fail");
    assert.equal(st(clean({ [field]: false }), id), "pass");
    assert.equal(st(clean({ [field]: null }), id), "unread", "an unread authority is never a pass");
  }
});

test("flag gates sit exactly on the rule book thresholds and unread is never pass", () => {
  assert.equal(st(clean({ ageMinutes: R.flags.sniperZoneMinutes - 0.1 }), "sniper_zone"), "fail");
  assert.equal(st(clean({ ageMinutes: R.flags.sniperZoneMinutes }), "sniper_zone"), "pass");
  assert.equal(st(clean({ ageMinutes: null }), "sniper_zone"), "unread");

  assert.equal(st(clean({ vol24h: R.flags.deadPoolMinVolume24hUsd - 1, ageMinutes: R.flags.deadPoolMinAgeMinutes + 1 }), "dead_pool"), "fail");
  assert.equal(st(clean({ vol24h: R.flags.deadPoolMinVolume24hUsd - 1, ageMinutes: R.flags.deadPoolMinAgeMinutes }), "dead_pool"), "pass", "engine: age must exceed the minimum");
  assert.equal(st(clean({ vol24h: null }), "dead_pool"), "unread");

  assert.equal(st(clean({ top10Pct: R.flags.top10MaxPct }), "top10"), "pass");
  assert.equal(st(clean({ top10Pct: R.flags.top10MaxPct + 0.1 }), "top10"), "fail");
  const t10 = by(autopsyGates(clean({ top10Pct: null, top10Method: "unavailable: rpc 429" }))).top10;
  assert.equal(t10.state, "unread");
  assert.match(String(t10.detail), /429/);

  assert.equal(st(clean({ rcLpLockedPct: R.flags.lpLockMinPct }), "lp_lock"), "pass");
  assert.equal(st(clean({ rcLpLockedPct: R.flags.lpLockMinPct - 0.1 }), "lp_lock"), "fail");
  assert.equal(st(clean({ rcLpLockedPct: null }), "lp_lock"), "unread");

  const m = R.flags.liqOverMcapMultiple;
  assert.equal(st(clean({ liquidityUsd: 400_000 * m, marketCap: 400_000 }), "liq_over_mcap"), "pass");
  assert.equal(st(clean({ liquidityUsd: 400_000 * m + 1, marketCap: 400_000 }), "liq_over_mcap"), "fail");

  for (const j of ["agree", "watch"]) assert.equal(st(clean({ jupState: j }), "jupiter"), "pass");
  assert.equal(st(clean({ jupState: "diverge", jupGapPct: 30 }), "jupiter"), "fail");
  for (const j of ["failed", "unchecked", "no-reliable-price"]) assert.equal(st(clean({ jupState: j }), "jupiter"), "unread", j);
});

test("entry gates: ceiling, flow floors and score use the book's values; missing flow is unread", () => {
  const ceil = R.universe.enterMcapMaxUsd;
  assert.equal(st(clean({ marketCap: ceil, liquidityUsd: ceil }), "mcap_ceiling"), "pass");
  assert.equal(st(clean({ marketCap: ceil + 1, liquidityUsd: ceil }), "mcap_ceiling"), "fail");
  assert.equal(st(clean({ marketCap: null, fdv: null }), "mcap_ceiling"), "unread");
  assert.equal(st(clean({ volAccel: R.enter.minVolAccel }), "flow_accel"), "pass");
  assert.equal(st(clean({ volAccel: R.enter.minVolAccel - 0.01 }), "flow_accel"), "fail");
  assert.equal(st(clean({ volAccel: null }), "flow_accel"), "unread");
  assert.equal(st(clean({ netBuyRatio5m: R.enter.minNetBuyRatio5m }), "flow_buys"), "pass");
  assert.equal(st(clean({ netBuyRatio5m: R.enter.minNetBuyRatio5m - 0.01 }), "flow_buys"), "fail");
  assert.equal(st(clean({ netBuyRatio5m: null }), "flow_buys"), "unread", "no trades in the window is unread, not a 0% buy share");
  assert.equal(st(clean({ score: R.enter.minScore }), "score"), "pass");
  assert.equal(st(clean({ score: R.enter.minScore - 1 }), "score"), "fail");
  assert.equal(st(clean({ score: null }), "score"), "unread");
});

test("all-null facts: nothing passes by default, and the only kill is the missing liquidity the desk also treats as a kill", () => {
  const nul: AutopsyFacts = {
    liquidityUsd: null, marketCap: null, fdv: null, priceUsd: null, buys1h: null, sells1h: null, chg1h: null, vol24h: null, ageMinutes: null,
    mintAuthorityActive: null, freezeAuthorityActive: null, top10Pct: null, top10Method: null, rcLpLockedPct: null, jupState: "unchecked", jupGapPct: null,
    volAccel: null, netBuyRatio5m: null, score: null,
  };
  const g = autopsyGates(nul);
  const s = summarizeGates(g);
  assert.equal(s.pass, 0, JSON.stringify(g.filter((x) => x.state === "pass").map((x) => x.id)));
  assert.equal(s.killFails, 1);
  assert.equal(by(g).liquidity.state, "fail");
  assert.equal(s.killed, true);
  assert.equal(s.unread, g.length - 1);
});

test("gate ids are unique, severities are grouped, and every rule text names a number from the book", () => {
  const g = autopsyGates(clean());
  assert.equal(new Set(g.map((x) => x.id)).size, g.length);
  assert.deepEqual(Array.from(new Set(g.map((x) => x.severity))), ["kill", "flag", "entry"]);
  const text = g.map((x) => x.rule).join(" | ");
  for (const n of [R.hardKills.midRugChg1hPct, R.flags.top10MaxPct, R.flags.lpLockMinPct, R.hardKills.honeypotMinBuys1h, R.flags.sniperZoneMinutes, R.enter.minVolAccel, R.enter.minScore]) {
    assert.ok(text.includes(String(n)), `rule text carries ${n}`);
  }
});

test("holder-dump stress: closed-form constant-product maths", () => {
  const s = holderDumpStress({ top10Pct: 30, fdv: 1_000_000, marketCap: 900_000, liquidityUsd: 100_000 });
  assert.equal(s.dataState, "ok");
  assert.equal(s.basis, "fdv");
  assert.equal(s.top10ValueUsd, 300_000);
  assert.equal(s.quoteReserveUsd, 50_000);
  assert.deepEqual(s.scenarios.map((x) => x.soldFraction), [...STRESS_FRACTIONS]);
  const [a, b, c] = s.scenarios;
  // 25%: v = 75k, ratio 1.5, drop 1 - 1/2.5^2 = 84%, proceeds 50k*75k/125k = 30k
  assert.equal(a.soldValueUsd, 75_000);
  assert.equal(a.soldVsQuoteReserve, 1.5);
  assert.equal(a.priceImpactPct, 84);
  assert.equal(a.proceedsUsd, 30_000);
  assert.equal(a.proceedsPctOfValue, 40);
  // 50%: v = 150k, ratio 3, drop 1 - 1/16 = 93.75%, proceeds 50k*150k/200k = 37.5k
  assert.equal(b.priceImpactPct, 93.75);
  assert.equal(b.proceedsUsd, 37_500);
  // 100%: v = 300k, ratio 6, drop 1 - 1/49, proceeds 50k*300k/350k
  assert.equal(c.priceImpactPct, Math.round((1 - 1 / 49) * 10000) / 100);
  assert.equal(c.proceedsUsd, Math.round((50_000 * 300_000 / 350_000) * 100) / 100);
  // invariants: impact grows with the sold amount, proceeds never exceed the value or the quote side
  assert.ok(a.priceImpactPct < b.priceImpactPct && b.priceImpactPct < c.priceImpactPct);
  for (const x of s.scenarios) { assert.ok(x.proceedsUsd < x.soldValueUsd); assert.ok(x.proceedsUsd < s.quoteReserveUsd!); assert.ok(x.priceImpactPct >= 0 && x.priceImpactPct < 100); }
});

test("holder-dump stress: unavailable states are explicit, market-cap fallback and pool-included caveat are labelled, zero holding is zero impact", () => {
  for (const [over, why] of [
    [{ top10Pct: null }, /not read/],
    [{ top10Pct: -1 }, /out of range/],
    [{ top10Pct: 120 }, /out of range/],
    [{ liquidityUsd: null }, /not reported/],
    [{ liquidityUsd: 0 }, /\$0/],
    [{ fdv: null, marketCap: null }, /neither FDV nor market cap/],
  ] as const) {
    const s = holderDumpStress({ top10Pct: 30, fdv: 1e6, marketCap: 9e5, liquidityUsd: 1e5, ...over });
    assert.equal(s.dataState, "unavailable");
    assert.deepEqual(s.scenarios, []);
    assert.match(String(s.reason), why);
  }
  const mc = holderDumpStress({ top10Pct: 30, fdv: null, marketCap: 900_000, liquidityUsd: 100_000 });
  assert.equal(mc.basis, "marketCap");
  assert.equal(mc.top10ValueUsd, 270_000);
  assert.ok(mc.caveats.some((c) => /understates/.test(c)));
  const incl = holderDumpStress({ top10Pct: 60, top10Method: "top-10 holders INCLUDING pool (vault not identified)", fdv: 1e6, marketCap: 1e6, liquidityUsd: 1e5 });
  assert.ok(incl.caveats.some((c) => /overstate/.test(c)));
  const zero = holderDumpStress({ top10Pct: 0, fdv: 1e6, marketCap: 1e6, liquidityUsd: 1e5 });
  assert.equal(zero.scenarios[0].priceImpactPct, 0);
  assert.equal(zero.scenarios[0].proceedsPctOfValue, 100);
});

test("the runner reads and scores a transient candidate: it never stores, tracks, persists or grades", () => {
  const src = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  const start = src.indexOf("export async function runCryptoAutopsy");
  const end = src.indexOf("function safeParse", start);
  assert.ok(start > 0 && end > start, "found the runner");
  const body = src.slice(start, end);
  for (const forbidden of [/persistSignal\(/, /tracked\.set\(/, /tracked\.delete\(/, /sqlite\./, /INSERT/i, /UPDATE\s/i, /recordPeakSample\(/, /hist\.push\(/]) {
    assert.doesNotMatch(body, forbidden, String(forbidden));
  }
  assert.match(body, /scoreCandidate\(c\)/, "the desk's own scorer is used, not a copy");
  assert.match(body, /applyDexPair\(c, best\)/, "the same pair mapping as the live refresh");
  // The route exists and returns the payload as is.
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /app\.get\("\/api\/crypto\/autopsy"/);
});
