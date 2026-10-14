// Flow attribution from Schwab chain snapshots (server/flowAttribution.ts):
// volume increments are attributed to the side of a print only when a print
// actually landed in the interval; premium is priced at the prices seen;
// volume before the first scan is reported apart; bursts are windowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FlowLedgerStore, askSideRead, etDayKey, midOf, newLedger, observe, sideOfPrint, summarize, QUOTE_STALE_MS, MIN_COVERAGE_FOR_SIDE,
  type FlowObservation,
} from "../../server/flowAttribution";

const T0 = Date.UTC(2026, 9, 13, 14, 0, 0); // 2026-10-13 10:00 ET
const obs = (o: Partial<FlowObservation> & { atMs: number; volume: number }): FlowObservation => ({
  last: null, bid: null, ask: null, mark: null, tradeTimeMs: null, quoteTimeMs: null, ...o,
});

test("print side: last against the same snapshot's bid/ask, one-cent tolerance", () => {
  assert.equal(sideOfPrint(1.50, 1.40, 1.50), "ask");
  assert.equal(sideOfPrint(1.495, 1.40, 1.50), "ask");
  assert.equal(sideOfPrint(1.60, 1.40, 1.50), "ask");       // above the ask is still the ask side
  assert.equal(sideOfPrint(1.40, 1.40, 1.50), "bid");
  assert.equal(sideOfPrint(1.30, 1.40, 1.50), "bid");
  assert.equal(sideOfPrint(1.45, 1.40, 1.50), "mid");
  assert.equal(sideOfPrint(1.45, null, 1.50), "unknown");
  assert.equal(sideOfPrint(1.45, 1.60, 1.50), "unknown");   // crossed quote
  assert.equal(midOf({ bid: 1.4, ask: 1.5, mark: 1.47, last: 2 }), 1.47);
  assert.equal(midOf({ bid: 1.4, ask: 1.5, mark: 9, last: 2 }), 1.45);   // mark outside the spread is ignored
  assert.equal(midOf({ bid: null, ask: null, mark: null, last: 2 }), 2);
});

test("first scan: volume already traded is pre-scan, priced at the first mid, with no side", () => {
  const L = newLedger("SPXW_C", "2026-10-13", obs({ atMs: T0, volume: 1200, last: 1.5, bid: 1.4, ask: 1.5, mark: 1.45, tradeTimeMs: T0 - 60_000, quoteTimeMs: T0 }));
  assert.equal(L.preScanVolume, 1200);
  assert.equal(L.preScanPremiumAtMid, 1200 * 1.45 * 100);
  const s = summarize(L, T0);
  assert.equal(s.sinceFirstScan, 0);
  assert.equal(s.askShare, null);
  assert.equal(s.attributedCoverage, null);
  assert.equal(s.sideBasis, "last-print-only");
  assert.equal(s.lastPrintSide, "ask");
  assert.equal(s.lastPrintAgeMs, 60_000);
  assert.equal(askSideRead(s).basis, "last-print-only");
});

test("an increment with a print inside the interval is attributed to that print's side at its price", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 100, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0 - 5_000, quoteTimeMs: T0 }));
  // 400 more contracts; the last print at the ask, 10 s into the interval.
  L = observe(L, obs({ atMs: T0 + 30_000, volume: 500, last: 1.10, bid: 1.0, ask: 1.10, tradeTimeMs: T0 + 10_000, quoteTimeMs: T0 + 29_000 }));
  assert.equal(L.askVolume, 400);
  assert.equal(L.unknownVolume, 0);
  assert.equal(L.premiumTraded, 400 * 1.10 * 100);
  // 200 more at the bid.
  L = observe(L, obs({ atMs: T0 + 60_000, volume: 700, last: 1.0, bid: 1.0, ask: 1.10, tradeTimeMs: T0 + 50_000, quoteTimeMs: T0 + 59_000 }));
  assert.equal(L.bidVolume, 200);
  const s = summarize(L, T0 + 60_000);
  assert.equal(s.sinceFirstScan, 600);
  assert.equal(s.attributedCoverage, 1);
  assert.ok(Math.abs(s.askShare! - 400 / 600) < 1e-12);
  assert.equal(s.premiumSinceFirstScan, 400 * 1.10 * 100 + 200 * 1.0 * 100);
  assert.equal(s.sideBasis, "attributed-prints");
  assert.equal(askSideRead(s).askSide, true);     // 67% >= 55%
  assert.equal(askSideRead(s, 0.7).askSide, false);
});

test("an increment with no new print time is unattributed at the mid (volume moved, no print seen)", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 100, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0 - 5_000, quoteTimeMs: T0 }));
  // Volume up, but the trade time did not advance: the feed moved volume without a print we can place.
  L = observe(L, obs({ atMs: T0 + 30_000, volume: 300, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0 - 5_000, quoteTimeMs: T0 + 30_000 }));
  assert.equal(L.unknownVolume, 200);
  assert.equal(L.askVolume, 0);
  // Priced at the mid in schwabFlow.calcMid's order: the last print when it sits inside the spread.
  assert.equal(L.premiumUnattributed, 200 * 1.0 * 100);
  // No times at all: still unattributed.
  L = observe(L, obs({ atMs: T0 + 60_000, volume: 350, last: 1.0, bid: 0.9, ask: 1.0 }));
  assert.equal(L.unknownVolume, 250);
  const s = summarize(L, T0 + 60_000);
  assert.equal(s.attributedCoverage, 0);
  assert.equal(s.sideBasis, "last-print-only");   // coverage below the minimum: falls back, and says so
  assert.equal(askSideRead(s).basis, "last-print-only");
});

test("a print exactly at the previous scan time, or older than the previous print, does not label the increment", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 100, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0, quoteTimeMs: T0 }));
  L = observe(L, obs({ atMs: T0 + 30_000, volume: 150, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0, quoteTimeMs: T0 + 30_000 }));
  assert.equal(L.unknownVolume, 50);
  assert.equal(L.askVolume, 0);
});

test("a reading below the day's first reading restarts the ledger (prior-session figure replaced); counters carry", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 500, last: 1, bid: 0.9, ask: 1 }));
  L = observe(L, obs({ atMs: T0 + 30_000, volume: 300, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T0 + 10_000 }));
  assert.equal(L.resets, 1);
  assert.equal(L.volumeDrops, 1);
  assert.equal(L.preScanVolume, 300);
  assert.equal(L.askVolume + L.bidVolume + L.midVolume + L.unknownVolume, 0);
  assert.equal(L.premiumTraded + L.premiumUnattributed, 0);
  // From the restart, volume counts from the new first reading.
  L = observe(L, obs({ atMs: T0 + 60_000, volume: 350, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T0 + 50_000 }));
  assert.equal(L.askVolume, 50);
});

test("a lower reading at or above the first reading is a drop under the high-water rule, never a restart or negative flow", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 500, last: 1, bid: 0.9, ask: 1 }));
  L = observe(L, obs({ atMs: T0 + 30_000, volume: 800, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T0 + 10_000 }));
  assert.equal(L.askVolume, 300);
  L = observe(L, obs({ atMs: T0 + 60_000, volume: 600, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T0 + 50_000 }));
  assert.equal(L.resets, 0);
  assert.equal(L.volumeDrops, 1);
  assert.equal(L.askVolume, 300);
  // Partial recovery under the 800 already seen adds nothing; only the rise above it counts.
  L = observe(L, obs({ atMs: T0 + 90_000, volume: 700, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T0 + 80_000 }));
  assert.equal(L.askVolume, 300);
  assert.equal(L.volumeDrops, 2);
  L = observe(L, obs({ atMs: T0 + 120_000, volume: 900, last: 1, bid: 0.9, ask: 1, tradeTimeMs: T0 + 110_000 }));
  assert.equal(L.askVolume, 400);
  assert.equal(L.highWater, 900);
});

test("conservation: attributed + unattributed volume equals volume since the first scan; premium sums match", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 10, last: 2, bid: 1.9, ask: 2.0, tradeTimeMs: T0 - 1 }));
  let expectedVol = 0, expectedPrem = 0;
  let v = 10;
  for (let k = 1; k <= 40; k++) {
    const dV = (k * 7) % 11;
    v += dV;
    const printed = k % 3 !== 0;
    const last = 1.5 + (k % 5) * 0.1;
    const bid = last - 0.05, ask = last + 0.05;
    const side = k % 2 === 0 ? ask : bid;
    const o = obs({ atMs: T0 + k * 30_000, volume: v, last: printed ? side : last, bid, ask, mark: last, tradeTimeMs: printed ? T0 + k * 30_000 - 1_000 : T0 - 1, quoteTimeMs: T0 + k * 30_000 });
    L = observe(L, o);
    expectedVol += dV;
    expectedPrem += dV * (printed ? side : last) * 100; // unattributed priced at mark (= mid here)
  }
  const s = summarize(L, T0 + 41 * 30_000);
  assert.equal(s.sinceFirstScan, expectedVol);
  assert.equal(s.askVolume + s.bidVolume + s.midVolume + s.unknownVolume, expectedVol);
  assert.ok(Math.abs(s.premiumSinceFirstScan - expectedPrem) < 1e-6);
});

test("burst: the largest 5-minute window of traded premium, with its side", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 0, last: 1, bid: 0.9, ask: 1 }));
  // Quiet drip for 10 minutes, then a 3-minute burst at the ask.
  let v = 0;
  for (let k = 1; k <= 20; k++) {
    v += 5;
    L = observe(L, obs({ atMs: T0 + k * 30_000, volume: v, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0 + k * 30_000 - 1_000 }));
  }
  for (let k = 21; k <= 26; k++) {
    v += 300;
    L = observe(L, obs({ atMs: T0 + k * 30_000, volume: v, last: 2.0, bid: 1.9, ask: 2.0, tradeTimeMs: T0 + k * 30_000 - 1_000 }));
  }
  const s = summarize(L, T0 + 27 * 30_000);
  assert.equal(s.burstSide, "ask");
  // The best 5-minute window (inclusive at the boundary) holds the 6 burst increments
  // (1800 contracts at 2.00) plus up to 5 drip increments of 5 contracts at 1.00.
  assert.ok(s.burstContracts >= 1800 && s.burstContracts <= 1800 + 5 * 5, `burst contracts ${s.burstContracts}`);
  assert.ok(s.burstPremium >= 1800 * 2 * 100 && s.burstPremium <= 1800 * 2 * 100 + 25 * 1 * 100);
  assert.equal(s.burstEndAtMs, T0 + 26 * 30_000);
});

test("stale quote after the print is flagged on the increment", () => {
  let L = newLedger("X", "d", obs({ atMs: T0, volume: 0, last: 1, bid: 0.9, ask: 1 }));
  L = observe(L, obs({ atMs: T0 + 30_000, volume: 10, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0 + 1_000, quoteTimeMs: T0 + 1_000 + QUOTE_STALE_MS + 1 }));
  assert.equal(L.recent[0].staleQuote, true);
  L = observe(L, obs({ atMs: T0 + 60_000, volume: 20, last: 1.0, bid: 0.9, ask: 1.0, tradeTimeMs: T0 + 40_000, quoteTimeMs: T0 + 41_000 }));
  assert.equal(L.recent[1].staleQuote, false);
});

test("store: ledgers restart on a new ET day and prune the oldest over the cap", () => {
  const st = new FlowLedgerStore(3);
  const day1 = Date.UTC(2026, 9, 13, 15, 0, 0);
  st.record("A", obs({ atMs: day1, volume: 10 }));
  const a2 = st.record("A", obs({ atMs: day1 + 30_000, volume: 40, last: 1, bid: 0.9, ask: 1, tradeTimeMs: day1 + 10_000 }));
  assert.equal(a2.askVolume, 30);
  assert.equal(etDayKey(day1), "2026-10-13");
  const day2 = Date.UTC(2026, 9, 14, 15, 0, 0);
  const a3 = st.record("A", obs({ atMs: day2, volume: 5 }));
  assert.equal(a3.preScanVolume, 5, "a new day starts a new ledger (volume reset is not a drop)");
  assert.equal(a3.askVolume, 0);
  st.record("B", obs({ atMs: day2 + 1, volume: 1 }));
  st.record("C", obs({ atMs: day2 + 2, volume: 1 }));
  st.record("D", obs({ atMs: day2 + 3, volume: 1 }));
  assert.equal(st.size(), 3);
  assert.equal(st.get("A"), undefined, "least recently observed ledger pruned");
  assert.ok(MIN_COVERAGE_FOR_SIDE > 0 && MIN_COVERAGE_FOR_SIDE < 1);
});
