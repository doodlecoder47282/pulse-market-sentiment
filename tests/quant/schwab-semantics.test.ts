// Schwab payload semantics on the Trade Desk and Signals paths (review
// 2026-10-23): -999 sentinels, missing fields, index symbol routing, chain
// provenance on the 0DTE map, settled contracts in totals, the IV unit on
// the unusual-flow screen, and the setup engine's spot. Each test fails on
// the code as reviewed. Server modules here need the full dependency set,
// so this file runs in CI (the dev workspace has no node_modules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOdteForward } from "../../server/odteForward";
import { demoChain, demoPriceHistory } from "../../server/demoMarket";
import { etWallToEpochMs, etDate, addDays } from "../../server/exchangeCalendar";
import { composeOdteMap, type ForwardLike } from "../../shared/odteMap";
import { buildSchwabFlow } from "../../server/schwabFlow";
import { buildPerTickerGamma } from "../../server/tickerAlpha";
import { gexByStrikeFromChain } from "../../server/gammaProfile";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const T = etWallToEpochMs("2026-10-12", 11 * 60);
function chainAt(nowMs: number, dte = 1) {
  const from = etDate(nowMs);
  return demoChain({ symbol: "$SPX", contractType: "ALL", strikeCount: 120, includeUnderlyingQuote: "true", fromDate: from, toDate: addDays(from, dte) }, nowMs);
}
const depsWith = (chain: any) => ({
  getOptionChain: async () => chain,
  getPriceHistory: async (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number) =>
    demoPriceHistory({ symbol, periodType, period, frequencyType, frequency, endDate: T }, T),
});
const firstKey = (ch: any) => Object.keys(ch.callExpDateMap).sort()[0];

test("0DTE forward carries the chain's provenance; a stale chain makes the map stale and the ledger does not keep it", async () => {
  const ch = { ...chainAt(T), source: "demo", asOfMs: T - 150_000, ageMs: 150_000, servedFromCache: true, stale: true, staleReason: "refresh failed" };
  const fwd = await buildOdteForward("$SPX", T, depsWith(ch));
  assert.equal(fwd.status, 200);
  assert.equal(fwd.body.chainAsOfMs, T - 150_000);
  assert.equal(fwd.body.chainAgeMs, 150_000);
  assert.equal(fwd.body.chainStale, true);
  assert.equal(fwd.body.servedFromCache, true);
  const map = composeOdteMap(fwd.body as ForwardLike, { edition: "personal" });
  assert.equal(map.dataState, "stale");
  assert.equal(map.chainAsOfMs, T - 150_000);
  assert.match(map.reason ?? "", /re-served after a failed refresh/);
  const fresh = await buildOdteForward("$SPX", T, depsWith({ ...chainAt(T), asOfMs: T, stale: false }));
  assert.equal(composeOdteMap(fresh.body as ForwardLike, { edition: "personal" }).dataState, "ok");
});

test("0DTE forward: -999 open interest is not weight, settled contracts are not in the totals, pin is positive, straddle needs both legs", async () => {
  const ch = { ...chainAt(T), asOfMs: T, stale: false };
  const key = firstKey(ch);
  const strikes = Object.keys(ch.callExpDateMap[key]);
  // Plant a -999 OI on one call and an already-settled AM contract (SPX root, same expiry key) with a large OI.
  const k0 = strikes[0];
  ch.callExpDateMap[key][k0][0].openInterest = -999;
  const am = { ...ch.callExpDateMap[key][strikes[1]][0], optionRoot: "SPX", settlementType: "A", openInterest: 5_000_000, totalVolume: 0 };
  ch.callExpDateMap[key][strikes[1]] = [am, ch.callExpDateMap[key][strikes[1]][0]];
  const fwd = await buildOdteForward("$SPX", T, depsWith(ch));
  assert.equal(fwd.status, 200);
  const b = fwd.body;
  // The totals exclude the sentinel and the settled contract.
  let expectedOi = 0;
  for (const side of ["callExpDateMap", "putExpDateMap"] as const) {
    for (const sk of Object.keys(ch[side][key])) for (const c of ch[side][key][sk]) {
      const settledAm = c.optionRoot === "SPX" && c.settlementType === "A";
      if (settledAm) continue; // 11:00 ET is after the 09:30 SOQ
      const oi = typeof c.openInterest === "number" && c.openInterest > -900 ? Math.max(0, c.openInterest) : 0;
      expectedOi += oi;
    }
  }
  assert.equal(b.weightTotals.oi, expectedOi);
  assert.ok(b.weightTotals.oi >= 0);
  // Pin is the largest POSITIVE exposure within 1.5%, the map's definition.
  if (b.gexValid && b.levels.pin != null) {
    const near = b.strikes.filter((s: any) => Math.abs(s.strike - b.spot) / b.spot <= 0.015 && s.gex > 0);
    const want = near.reduce((a: any, s: any) => (s.gex > a.gex ? s : a)).strike;
    assert.equal(b.levels.pin, want);
    const map = composeOdteMap(b as ForwardLike, { edition: "personal" });
    if (map.dataState === "ok") assert.equal(map.landmarks.pin, b.levels.pin);
  }
  // Straddle: knock out the ATM put's quote and the straddle must be null, not half.
  const atm = b.strikes.reduce((a: any, s: any) => (Math.abs(s.strike - b.spot) < Math.abs(a.strike - b.spot) ? s : a)).strike;
  const ch2 = { ...chainAt(T), asOfMs: T, stale: false };
  for (const c of ch2.putExpDateMap[key][String(atm)] ?? ch2.putExpDateMap[key][Number(atm).toFixed(1)] ?? []) { c.bid = null; c.ask = null; c.last = null; c.mark = null; }
  const fwd2 = await buildOdteForward("$SPX", T, depsWith(ch2));
  if (fwd2.status === 200 && fwd2.body.expectedMove.straddle != null) {
    assert.ok(fwd2.body.expectedMove.straddle > 0.5 * (b.expectedMove.straddle ?? 0), "a one-legged straddle must not be served as the straddle");
  }
});

test("unusual flow: a contract without volume or OI is skipped and counted, never a new strike; IV stays in percent", async () => {
  const ch = { ...chainAt(T, 7), asOfMs: T, stale: false };
  const key = firstKey(ch);
  const sk = Object.keys(ch.callExpDateMap[key])[3];
  const c = ch.callExpDateMap[key][sk][0];
  delete c.openInterest;
  c.totalVolume = 50_000;
  c.volatility = 23.4;
  const r = await buildSchwabFlow("$SPX", { minVolOi: 2, minVolume: 100, maxDte: 7, limit: 500, chain: ch });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.ok(r.skippedMissingFields >= 1);
  assert.ok(!r.contracts.some((x) => x.strike === Number(sk) && x.type === "C" && x.isNewStrike && x.volume === 50_000), "missing OI must not become a new strike");
  for (const x of r.contracts) {
    assert.ok(x.iv >= 0 && x.iv < 500, `iv must be percent, got ${x.iv}`);
    assert.ok(x.openInterest >= 0 && x.volume >= 0);
  }
  const panel = src("client/src/components/UnusualFlowPanel.tsx");
  assert.doesNotMatch(panel, /c\.iv \* 100/);
  assert.match(panel, /c\.iv\.toFixed\(0\)\}%/);
});

test("per-ticker gamma: vendor -999 gamma never prices a contract; walls and flip equal the shared re-priced basis", () => {
  const ch = { ...chainAt(T, 30), symbol: "$SPX" };
  const key = firstKey(ch);
  const sk = Object.keys(ch.callExpDateMap[key])[2];
  ch.callExpDateMap[key][sk][0].gamma = -999;
  ch.callExpDateMap[key][sk][0].openInterest = 1_000;
  const g = buildPerTickerGamma(ch, "$SPX", T);
  assert.ok(g, "gamma build");
  const ref = gexByStrikeFromChain(ch, T);
  assert.equal(g!.callWall, ref.callWall);
  assert.equal(g!.putWall, ref.putWall);
  assert.equal(g!.zeroGamma, ref.zeroGamma);
  const row = g!.profile.find((p) => p.strike === Number(sk));
  const refRow = ref.profile.find((p) => p.strike === Number(sk));
  if (row && refRow) assert.ok(Math.abs(row.gex - refRow.netGex) <= 1e-6 * Math.max(1, Math.abs(refRow.netGex)));
  assert.ok(Math.abs(g!.totalGex) < 1e13, "a -999 gamma would put the total in the 1e10+ range");
  // No calls at all -> ratios null, never 0.
  const noCalls = { ...ch, callExpDateMap: {} };
  const g2 = buildPerTickerGamma(noCalls, "$SPX", T);
  if (g2) { assert.equal(g2.pcrOi, null); assert.equal(g2.pcrVol, null); }
});

test("index symbols reach Schwab with their $ prefix from the positioning path; the setup engine's spot is this tick's quote", () => {
  const ta = src("server/tickerAlpha.ts");
  assert.match(ta, /const wire = INDEX_WIRE_SYMBOLS\.has\(t\) \? `\$\$\{t\}` : t;/);
  assert.match(ta, /getQuotes\(\[wire\]\)/);
  assert.match(ta, /getOptionChain\(wire, 45\)/);
  assert.doesNotMatch(ta, /Number\(c\.gamma\)/);
  const se = src("server/setupEngine.ts");
  assert.match(se, /const spot = lasts\.get\(sym\.replace\(\/\^\\\$\/, ""\)\) \?\? null;/);
  assert.match(se, /q\.stale !== true\) lasts\.set\(key, q\.last\)/);
  assert.match(se, /\{ spot, callWall: pos\.callWall/);
  const routes = src("server/routes.ts");
  assert.match(routes, /dataState: schwab\.stale \? "stale" : "ok"/);
  const sources = src("server/sources.ts");
  assert.match(sources, /let maxPain: number \| null = null;/);
});
