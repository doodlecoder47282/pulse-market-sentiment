// tests/quant/crypto-community.test.ts
//
// The pure half of the community watch (server/cryptoCommunityCore.ts):
// DexScreener pool choice, GeckoTerminal candle parsing, data states kept
// apart, derived structure fields, and the demo sample's shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHistory, applyOnChain, applyOnChainFailure, applyPool, blankEntry, deriveEntry, parseOhlcv, pickPool, sampleBars } from "../../server/cryptoCommunityCore";
import { rangeStats } from "../../shared/memeStructure";

const MINT = "So11111111111111111111111111111111111111112";
const T = Date.UTC(2026, 9, 14, 12);

const pair = (over: Record<string, any> = {}) => ({
  chainId: "solana", dexId: "raydium", pairAddress: "pool-A", baseToken: { address: MINT, symbol: "ABC", name: "Abc Coin" },
  priceUsd: "0.0123", marketCap: 12_000_000, fdv: 12_500_000, liquidity: { usd: 850_000, base: 1, quote: 1 },
  volume: { h24: 3_200_000 }, priceChange: { h24: -4.2 }, txns: { h24: { buys: 1200, sells: 1100 } },
  pairCreatedAt: T - 200 * 86_400_000, ...over,
});

test("pickPool: deepest Solana pool whose base token is the mint; other chains and quote-side listings ignored", () => {
  const pairs = [
    pair({ pairAddress: "shallow", liquidity: { usd: 10_000 } }),
    pair({ pairAddress: "deep", liquidity: { usd: 900_000 } }),
    pair({ pairAddress: "eth", chainId: "ethereum", liquidity: { usd: 5_000_000 } }),
    pair({ pairAddress: "quote-side", baseToken: { address: "other", symbol: "X", name: "X" }, liquidity: { usd: 9_000_000 } }),
    pair({ pairAddress: "no-liq", liquidity: undefined }),
  ];
  assert.equal(pickPool(pairs, MINT)?.pairAddress, "deep");
  assert.equal(pickPool([], MINT), null);
  assert.equal(pickPool([pair({ chainId: "base" })], MINT), null);
});

test("applyPool: fields map from DexScreener; a missing pool is not_found, never a zero quote", () => {
  const e = blankEntry(MINT, "abc", T);
  applyPool(e, pair(), T);
  assert.equal(e.quoteState, "ok");
  assert.equal(e.symbol, "ABC");
  assert.equal(e.priceUsd, 0.0123);
  assert.equal(e.liquidityUsd, 850_000);
  assert.equal(e.buys24h, 1200);
  assert.ok(Math.abs(e.ageDays! - 200) < 1e-9);
  assert.equal(e.line.phase, "settled");
  assert.equal(e.cost1k?.dataState, "ok");
  assert.ok(e.cost1k!.roundTripPct! > 2.5 && e.cost1k!.roundTripPct! < 3.5, `${e.cost1k!.roundTripPct}`);
  assert.equal(e.maxSizeAt1Pct, Math.floor(425_000 * (0.01 / 0.99)));
  // Classifier: aged and deep, but holder share and mint authority are not read -> community, tentative, missing listed.
  assert.equal(e.structure?.category, "community");
  assert.equal(e.structure?.confidence, "tentative");
  assert.ok(e.structure!.missing.includes("top10Pct") && e.structure!.missing.includes("mintAuthority"));

  const g = blankEntry("GoneGoneGoneGoneGoneGoneGoneGoneGoneGone1111", null, T);
  applyPool(g, null, T);
  assert.equal(g.quoteState, "not_found");
  assert.equal(g.liquidityUsd, null);
  assert.equal(g.cost1k?.dataState, "unavailable");
  assert.equal(g.structure?.category, "unclassified");
});

test("parseOhlcv: GeckoTerminal rows (seconds, newest first) become ascending ms bars; bad rows dropped", () => {
  const payload = { data: { attributes: { ohlcv_list: [
    [1_760_400_000, 1.1, 1.2, 1.0, 1.15, 5000],
    [1_760_313_600, "1.0", "1.1", "0.9", "1.05", "4000"],
    [1_760_227_200, 0.9, 1.0, 0.8, null, 3000],   // no close: dropped
    "junk",
  ] } } };
  const bars = parseOhlcv(payload);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].t, 1_760_313_600_000);
  assert.equal(bars[0].c, 1.05);
  assert.equal(bars[1].v, 5000);
  assert.deepEqual(parseOhlcv(null), []);
  assert.deepEqual(parseOhlcv({ data: {} }), []);
});

test("applyHistory: range state follows the bar count; a reclaimed deep dip makes the community read firm when nothing else is missing", () => {
  const e = blankEntry(MINT, null, T);
  applyPool(e, pair(), T);
  const bars = sampleBars("ABC", 120, 0.01, T - 86_400_000);
  applyHistory(e, bars, T);
  assert.equal(e.historyState, "ok");
  assert.equal(e.range?.bars, 90);
  assert.ok(e.range!.deepDipsReclaimed >= 1, "the sample series is built with one reclaimed 70% dip");
  // Still tentative: holder share and mint authority were not read.
  assert.equal(e.structure?.confidence, "tentative");
  const short = blankEntry(MINT, null, T);
  applyPool(short, pair(), T);
  applyHistory(short, bars.slice(-12), T);
  assert.equal(short.historyState, "partial");
  applyHistory(short, bars.slice(-3), T);
  assert.equal(short.historyState, "no_data");
  assert.equal(short.range?.rangePosition, null);
});

test("applyOnChain: facts feed the classifier; a skipped concentration keeps the last value, a failed one clears it, a failed mint read is unavailable, never fine", () => {
  const e = blankEntry(MINT, null, T);
  applyPool(e, pair(), T);
  applyHistory(e, sampleBars("ABC", 120, 0.01, T - 86_400_000), T);
  assert.equal(e.onChainState, "pending");
  assert.equal(e.mintAuthorityActive, null);
  assert.ok(e.structure!.missing.includes("top10Pct") && e.structure!.missing.includes("mintAuthority"));

  applyOnChain(e, { mintAuthorityActive: false, freezeAuthorityActive: false, top10Pct: 22.5, top10Method: "owners", concentration: "ok", concentrationError: null }, T + 1);
  assert.equal(e.onChainState, "ok");
  assert.equal(e.top10Pct, 22.5);
  assert.equal(e.mintAuthorityActive, false);
  assert.ok(!e.structure!.missing.includes("top10Pct") && !e.structure!.missing.includes("mintAuthority"), "both inputs now read");
  assert.equal(e.structure?.confidence, "firm", "nothing missing: the community read is no longer tentative");

  // Indexed RPC cooling down: authorities refreshed, concentration kept from the last read.
  applyOnChain(e, { mintAuthorityActive: false, freezeAuthorityActive: false, top10Pct: null, top10Method: null, concentration: "skipped", concentrationError: null }, T + 2);
  assert.equal(e.top10Pct, 22.5);
  // Indexed read failed: the value is cleared with the reason, not left stale.
  applyOnChain(e, { mintAuthorityActive: false, freezeAuthorityActive: false, top10Pct: null, top10Method: null, concentration: "unavailable", concentrationError: "rpc 429 @ api.mainnet-beta.solana.com" }, T + 3);
  assert.equal(e.top10Pct, null);
  assert.match(e.top10Method!, /^unavailable: rpc 429/);
  assert.ok(e.structure!.missing.includes("top10Pct"));

  // Mint authority active is a named reason in the structural read.
  applyOnChain(e, { mintAuthorityActive: true, freezeAuthorityActive: true, top10Pct: 61, top10Method: "owners", concentration: "ok", concentrationError: null }, T + 4);
  assert.equal(e.mintAuthorityActive, true);
  assert.ok(e.structure!.reasons.some((r) => /mint authority active/.test(r)));

  const f = blankEntry(MINT, null, T);
  applyPool(f, pair(), T);
  applyOnChainFailure(f, "solana rpc: all solana rpcs failed", T + 5);
  assert.equal(f.onChainState, "unavailable");
  assert.equal(f.mintAuthorityActive, null, "a failed read leaves the authority unread, not revoked");
  assert.equal(f.onChainError, "solana rpc: all solana rpcs failed");
});

test("deriveEntry never turns a missing liquidity into a zero cost", () => {
  const e = blankEntry(MINT, null, T);
  deriveEntry(e, T);
  assert.equal(e.cost1k?.dataState, "unavailable");
  assert.equal(e.cost1k?.roundTripPct, null);
  assert.equal(e.maxSizeAt1Pct, null);
  assert.equal(e.line.phase, "unknown");
});

test("sampleBars: deterministic, ascending, positive, with the deep dip and reclaim it promises", () => {
  const a = sampleBars("Q", 100, 1, T);
  const b = sampleBars("Q", 100, 1, T);
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].t > a[i - 1].t && a[i].c > 0 && a[i].h >= a[i].c && a[i].l <= a[i].c);
  const r = rangeStats(a, 90);
  assert.ok(r.deepDipsReclaimed >= 1 && r.maxDrawdownPct! >= 70, `${r.deepDipsReclaimed} ${r.maxDrawdownPct}`);
});
