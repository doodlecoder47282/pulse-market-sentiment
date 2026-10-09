// Round-3 workstream R3-2: flow (sector 4) and decision layer (sector 6).
// Every expected value is hand-computed next to the assertion.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pcrReadFromHistory, type PcrDay } from "../../server/pcrHistory";
import { hasPcrBands, pcrBandTone } from "../../shared/pcrBands";
import {
  MIN_SERIES_SAMPLES, LAST_SAMPLE_MAX_AGE_MS, aggressorStateOf, currentVolumes,
  isFreshChain, seriesFrom, shouldAppendSample,
} from "../../server/flowIntradayState";
import { volumeOverOiShare, fullyOpeningShare, fullyOpeningFromShare, openingText } from "../../server/flowIntent";
import { ofiApiPayload, ofiMethodLabel, type OfiTrendLike } from "../../server/ofiPayload";
import {
  leeReadySign, classifyL1Trades, OptionTradeSideBook, summarizeStreamSide, optionKey,
} from "../../server/signedVolume";

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

// ─── Item 1: P/C colour bands from the symbol's own history ─────────────────

// calls = 99.5 and puts = 100 r - 0.5 make (P + 0.5)/(C + 0.5) = r exactly.
const day = (date: string, r: number): PcrDay => ({ date, putVol: 100 * r - 0.5, callVol: 99.5 });

test("R3-2.1 bands are exp(mean -+ sd) of the history, not fixed 0.75 / 1.05", () => {
  // 20 sessions alternating r = 0.8 and 1.25: ln r = -+0.223144, mean 0,
  // sample sd = 0.223144 * sqrt(20/19) = 0.228940.
  // bullishBelow = exp(-0.228940) = 0.795376, bearishAbove = exp(0.228940) = 1.257267.
  const hist = Array.from({ length: 20 }, (_, i) => day(`2026-07-${String(i + 1).padStart(2, "0")}`, i % 2 ? 1.25 : 0.8));
  const r = pcrReadFromHistory({ putVol: 99.5, callVol: 99.5 }, hist, { today: "2026-08-01" });
  near(r.bullishBelow!, 0.795376, 1e-6, "bullishBelow");
  near(r.bearishAbove!, 1.257267, 1e-6, "bearishAbove");
  assert.ok(hasPcrBands(r));
  // 0.78 is call-heavy for THIS symbol (below 0.7954) although the old fixed
  // rule (< 0.75) called it neutral; 1.10 is normal here although the old
  // rule (> 1.05) called it bearish.
  assert.equal(pcrBandTone(0.78, r), "bullish");
  assert.equal(pcrBandTone(1.10, r), "neutral");
  assert.equal(pcrBandTone(1.26, r), "bearish");
  // Edges are inclusive, as z <= -1 / z >= +1.
  assert.equal(pcrBandTone(r.bullishBelow, r), "bullish");
  assert.equal(pcrBandTone(r.bearishAbove, r), "bearish");
});

test("R3-2.1 no history -> no bands, the value is not coloured as a zone", () => {
  const r = pcrReadFromHistory({ putVol: 100, callVol: 100 }, [day("2026-07-01", 1)], { today: "2026-08-01" });
  assert.equal(r.zone, "insufficient_history");
  assert.equal(hasPcrBands(r), false);
  assert.equal(pcrBandTone(0.5, r), "no_bands");
  assert.equal(pcrBandTone(2.0, r), "no_bands");
  assert.equal(pcrBandTone(null, { bullishBelow: 0.8, bearishAbove: 1.2 }), "no_bands");
  assert.equal(pcrBandTone(1, undefined), "no_bands");
  // Malformed band (inverted) is treated as no band.
  assert.equal(pcrBandTone(1, { bullishBelow: 1.2, bearishAbove: 0.8 }), "no_bands");
});

// ─── Item 2: observed-only intraday series ──────────────────────────────────

const fresh = { read: true, stale: false, callVol: 1000, putVol: 800 };
const stale = { read: true, stale: true, callVol: 1000, putVol: 800 };
const failed = { read: false, stale: false, callVol: 0, putVol: 0 };

test("R3-2.2 only fresh chains append samples", () => {
  assert.equal(isFreshChain(fresh), true);
  assert.equal(isFreshChain(stale), false);
  assert.equal(isFreshChain(failed), false);
  assert.equal(shouldAppendSample(fresh, null, 1000), true);
  assert.equal(shouldAppendSample(fresh, 1000, 1054), false); // < 55 s spacing
  assert.equal(shouldAppendSample(fresh, 1000, 1055), true);
  assert.equal(shouldAppendSample(stale, null, 1000), false);
  assert.equal(shouldAppendSample(failed, null, 1000), false);
  // An observed zero from a fresh chain is a sample (pre-open: 0 contracts traded).
  assert.equal(shouldAppendSample({ read: true, stale: false, callVol: 0, putVol: 0 }, null, 1000), true);
});

test("R3-2.2 fewer than MIN_SERIES_SAMPLES -> empty series, insufficient_samples (no synthesis)", () => {
  assert.equal(MIN_SERIES_SAMPLES, 2);
  const one = seriesFrom([{ t: 1 }]);
  assert.deepEqual(one.series, []);
  assert.equal(one.seriesState, "insufficient_samples");
  assert.match(one.seriesReason!, /1 of 2/);
  const two = seriesFrom([{ t: 1 }, { t: 2 }]);
  assert.equal(two.series.length, 2);
  assert.equal(two.seriesState, "ok");
  assert.equal(two.seriesReason, null);
});

test("R3-2.2 current volumes: live / last_sample within max age / unavailable as null", () => {
  const live = currentVolumes(fresh, null, 5000);
  assert.deepEqual(live, { callVol: 1000, putVol: 800, pcr: 0.8, volumeState: "live", volumeAsOf: 5000 });
  // Observed zero stays zero, with pcr null (undefined ratio), still live.
  const zero = currentVolumes({ read: true, stale: false, callVol: 0, putVol: 0 }, null, 5000);
  assert.equal(zero.callVol, 0);
  assert.equal(zero.volumeState, "live");
  assert.equal(zero.pcr, null);
  const last = { t: 5000, callVolume: 400, putVolume: 600 };
  const maxS = LAST_SAMPLE_MAX_AGE_MS / 1000; // 300 s
  const reuse = currentVolumes(stale, last, 5000 + maxS);
  assert.deepEqual(reuse, { callVol: 400, putVol: 600, pcr: 1.5, volumeState: "last_sample", volumeAsOf: 5000 });
  const tooOld = currentVolumes(failed, last, 5000 + maxS + 1);
  assert.deepEqual(tooOld, { callVol: null, putVol: null, pcr: null, volumeState: "unavailable", volumeAsOf: null });
  assert.equal(currentVolumes(failed, null, 5000).volumeState, "unavailable");
});

test("R3-2.2 side breakdown re-used only within the same max age", () => {
  assert.equal(aggressorStateOf(true, null, 100), "live");
  assert.equal(aggressorStateOf(false, 100, 400), "cached");
  assert.equal(aggressorStateOf(false, 100, 401), "unavailable");
  assert.equal(aggressorStateOf(false, null, 100), "unavailable");
});

// ─── Item 3: OFI payload carries the signing method ─────────────────────────

const ofiTrend = (method?: OfiTrendLike["method"], from: number | null = null, counts: OfiTrendLike["tradeLevelCounts"] = null): OfiTrendLike => ({
  bars: Array.from({ length: 20 }, (_, i) => ({ ts: 1_760_000_000_000 + i * 60_000, signedVolume: 10, cumulative: 10 * (i + 1) })),
  cumulativeNow: 200, slope15m: 150, slope5m: 50, trend: "BULLISH", acceleration: "FLAT", dataState: "ok",
  method, tradeLevelFromMs: from, tradeLevelCounts: counts,
});

test("R3-2.3 payload passes method, tradeLevelFromMs, tradeLevelCounts; label follows the method", () => {
  const bars = ofiApiPayload(ofiTrend("tick-rule-1m"), Date.now());
  assert.equal(bars.method, "tick-rule-1m");
  assert.match(bars.methodLabel, /tick volume/i);
  assert.doesNotMatch(bars.methodLabel, /Lee-Ready/);
  assert.equal(bars.tradeLevelCoveragePct, null);

  // 80 quote-rule, 15 tick-rule, 5 unsigned blocks: 80 %, 15 %, 5 %; signed share 95 %.
  const counts = { quoteRule: 80, tickRule: 15, unsigned: 5 };
  const lr = ofiApiPayload(ofiTrend("lee-ready-l1", 1_760_000_000_000, counts), Date.now());
  assert.equal(lr.method, "lee-ready-l1");
  assert.match(lr.methodLabel, /Lee-Ready on streamed trades/);
  assert.deepEqual(lr.tradeLevelCounts, counts);
  assert.equal(lr.tradeLevelFromMs, 1_760_000_000_000);
  assert.equal(lr.tradeLevelCoveragePct, 95);
  assert.match(lr.methodNote, /100 trade blocks.*80% quote rule, 15% tick rule.*5% unsigned/);

  // 2025-10-09 14:00 UTC = 10:00 ET (EDT, UTC-4).
  const from = Date.UTC(2025, 9, 9, 14, 0);
  const hy = ofiApiPayload(ofiTrend("hybrid-l1", from, counts), Date.now());
  assert.match(hy.methodLabel, /tick rule, Lee-Ready from 10:00 AM ET/);
  // Older trend objects without a method read as the bar tick rule.
  assert.equal(ofiApiPayload(ofiTrend(undefined), Date.now()).method, "tick-rule-1m");
  assert.equal(ofiMethodLabel("lee-ready-l1", null, null).tradeLevelCoveragePct, null);
});

// ─── Item 4: streamed option trade blocks signed by Lee-Ready ───────────────

test("R3-2.4 leeReadySign: quote rule vs prior mid, tick rule at the mid (Lee & Ready 1991)", () => {
  assert.deepEqual(leeReadySign(1.20, 1.00, 1.20, null, 0), { sign: 1, rule: "quote" });
  assert.deepEqual(leeReadySign(1.05, 1.00, 1.20, null, 0), { sign: -1, rule: "quote" });
  assert.deepEqual(leeReadySign(1.10, 1.00, 1.20, 1.05, 0), { sign: 1, rule: "tick" });   // uptick at the mid
  assert.deepEqual(leeReadySign(1.10, 1.00, 1.20, 1.10, -1), { sign: -1, rule: "tick" }); // zero tick keeps last sign
  assert.deepEqual(leeReadySign(1.10, null, null, null, 0), { sign: 0, rule: "none" });
  // Refactor regression: classifyL1Trades still signs the same way.
  const c = classifyL1Trades([
    { t: 1, last: 100, bid: 99.9, ask: 100.1, cumVolume: 1000 },
    { t: 2, last: 100.1, bid: 100.0, ask: 100.2, cumVolume: 1100 },
    { t: 3, last: 100.1, bid: 100.0, ask: 100.2, cumVolume: 1150 },
  ]);
  // Second block sits at the mid (100.1) with a zero tick and no earlier
  // non-zero tick: unsigned, never guessed.
  assert.deepEqual(c.trades.map((k) => [k.sign, k.rule, k.size]), [[1, "quote", 100], [0, "none", 50]]);
});

test("R3-2.4 option side book: hand-computed blocks, premium x100, reconnect and day resets", () => {
  const book = new OptionTradeSideBook();
  const T0 = Date.UTC(2026, 9, 9, 14, 0); // 10:00 ET
  const sym = "SPY   261009C00670000";
  book.update(sym, { t: T0, last: 1.15, bid: 1.00, ask: 1.20, cumVolume: 100 }, 1);          // baseline, no block
  book.update(sym, { t: T0 + 1000, last: 1.20, bid: 1.00, ask: 1.20, cumVolume: 110 }, 1);   // 1.20 > mid 1.10: buy 10, $1,200
  book.update(sym, { t: T0 + 2000, last: 1.20, bid: 1.10, ask: 1.30, cumVolume: 110 }, 1);   // quote only
  book.update(sym, { t: T0 + 3000, last: 1.10, bid: 1.10, ask: 1.30, cumVolume: 115 }, 1);   // 1.10 < mid 1.20: sell 5, $550
  book.update(sym, { t: T0 + 4000, last: 1.20, bid: 1.10, ask: 1.30, cumVolume: 117 }, 1);   // at mid, uptick: buy 2, $240
  let t = book.get(optionKey(sym), T0 + 5000)!;
  assert.equal(t.buyVol, 12); assert.equal(t.sellVol, 5); assert.equal(t.unsignedVol, 0);
  near(t.buyPrem, 1200 + 240, 1e-9, "buy premium"); near(t.sellPrem, 550, 1e-9, "sell premium");
  assert.equal(t.quoteRule, 2); assert.equal(t.tickRule, 1);
  assert.equal(t.firstMs, T0 + 1000); assert.equal(t.lastMs, T0 + 4000);
  // Reconnect (epoch 2): the first update re-baselines; volume across the gap is not classified.
  book.update(sym, { t: T0 + 60_000, last: 1.30, bid: 1.20, ask: 1.40, cumVolume: 300 }, 2);
  t = book.get(sym, T0 + 61_000)!;
  assert.equal(t.buyVol + t.sellVol + t.unsignedVol, 17);
  assert.equal(t.baselineResets, 1);
  // Padded streamer symbol and unpadded chain OCC key are the same contract.
  assert.ok(book.get("SPY261009C00670000", T0 + 61_000));
  // Next ET day: yesterday's totals are not returned.
  assert.equal(book.get(sym, T0 + 24 * 3600_000), null);
});

test("R3-2.4 stream side summary: coverage of the chain's day volume", () => {
  const book = new OptionTradeSideBook();
  const T0 = Date.UTC(2026, 9, 9, 14, 0);
  book.update("SPY261009P00660000", { t: T0, last: 2.0, bid: 1.9, ask: 2.1, cumVolume: 500 }, 1);
  book.update("SPY261009P00660000", { t: T0 + 1, last: 2.1, bid: 1.9, ask: 2.1, cumVolume: 540 }, 1); // buy 40 puts, $8,400
  const s = summarizeStreamSide([
    { occ: "SPY261009P00660000", side: "P", dayVolume: 540 },
    { occ: "SPY261009C00670000", side: "C", dayVolume: 1460 },
    { occ: "SPY261009C00680000", side: "C", dayVolume: null },
  ], (occ) => book.get(occ, T0 + 2));
  assert.equal(s.contracts, 1);
  assert.equal(s.boughtPutVol, 40);
  near(s.boughtPutPrem, 8400, 1e-9, "put premium");
  assert.equal(s.chainDayVol, 2000);
  near(s.coveragePct!, 2, 1e-12, "coverage 40 / 2000");
  assert.equal(s.quoteRulePct, 100);
  const none = summarizeStreamSide([{ occ: "X", side: "C", dayVolume: 10 }], () => null);
  assert.equal(none.contracts, 0);
  assert.equal(none.quoteRulePct, null);
});

// ─── Item 5: opening bounds, both stated ────────────────────────────────────

test("R3-2.5 opening-side bound V - OI and fully-opening bound V - 2 OI (hand-computed)", () => {
  // V = 1,500, OI_prev = 100. Close/close trades <= 100, so >= 1,400 trades
  // have an opening side (93.33 %). Closing sides <= 200 (100 longs + 100
  // shorts), so >= 1,300 trades are fully opening (86.67 %).
  near(volumeOverOiShare(1500, 100)!, 1400 / 1500, 1e-12, "opening side");
  near(fullyOpeningShare(1500, 100)!, 1300 / 1500, 1e-12, "fully opening");
  near(fullyOpeningFromShare(1400 / 1500)!, 1300 / 1500, 1e-12, "2s - 1");
  // V = 150, OI = 100: an opening side on >= 50 trades (33 %), but the
  // fully-opening bound is 150 - 200 < 0 -> 0 (nothing guaranteed fully opening).
  near(volumeOverOiShare(150, 100)!, 50 / 150, 1e-12, "small excess");
  assert.equal(fullyOpeningShare(150, 100), 0);
  assert.equal(fullyOpeningFromShare(50 / 150), 0);
  assert.equal(fullyOpeningShare(300, 0), 1);       // new strike: every trade fully opening
  assert.equal(fullyOpeningShare(0, 100), null);    // no volume
  assert.equal(fullyOpeningShare(100, NaN), null);  // OI unknown: missing, not 0
  const txt = openingText(1400 / 1500)!;
  assert.match(txt, /with an opening side >= 93% of vol; fully opening >= 87%/);
  assert.match(txt, /which side opened is unknown/);
  assert.equal(openingText(0), "volume within prior-day OI: may be closing");
});
