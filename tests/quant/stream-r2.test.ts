// R2-H: Schwab Streamer (closest-to-tick data), stream store, Lee-Ready on
// LEVELONE trade blocks, and noise-robust realized variance.
//
// No live Schwab here: a fake Streamer runs in-process (a minimal RFC 6455
// server on node:http) and speaks the protocol shapes schwabStream.ts expects:
// LOGIN response, SUBS/ADD/UNSUBS acks, data frames, heartbeats, notices,
// disconnects. The client side is Node 22's global WebSocket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

import {
  parzen, tsrv, realizedVariance, realizedKernelFromReturns, estimateRealizedVol, previousTick, jitterEnds,
  PARZEN_C_STAR, type PricePoint,
} from "../../server/realizedVol";
import {
  StreamStore, TickRing, streamRecordUsable, fieldList, L1_EQUITY_FIELDS, L1_OPTION_FIELDS, CHART_EQUITY_FIELDS,
  streamEquityQuote, streamOptionQuote, streamOptionOverlay, syncStreamOptions, wantedOptionSymbols, _resetOptionWants,
  setActiveStreamStore,
} from "../../server/streamStore";
import {
  SchwabStreamer, parseStreamerInfo, backoffDelayMs, streamConfigFromEnv, DEFAULT_STREAM_CONFIG,
  type StreamerInfo, type WebSocketLike,
} from "../../server/schwabStream";
import { classifyL1Trades, signedVolumeBarsFromTrades, mergeSignedBars, type L1Update } from "../../server/signedVolume";

// 2026-10-07 (Wednesday): 11:00 ET = 15:00Z (session open); 19:00 ET closed.
const RTH = Date.parse("2026-10-07T15:00:00Z");
const CLOSED = Date.parse("2026-10-07T23:00:00Z");

// ---------------------------------------------------------------------------
// 1. Realized variance estimators: closed forms and seeded Monte Carlo
// ---------------------------------------------------------------------------

test("parzen kernel: closed-form weights; c* = 3.5134", () => {
  assert.equal(parzen(0), 1);
  assert.ok(Math.abs(parzen(0.25) - 0.71875) < 1e-12); // 1 - 6/16 + 6/64
  assert.ok(Math.abs(parzen(0.5) - 0.25) < 1e-12);
  assert.ok(Math.abs(parzen(0.75) - 0.03125) < 1e-12); // 2 * 0.25^3
  assert.equal(parzen(1), 0);
  assert.equal(parzen(1.5), 0);
  assert.ok(Math.abs(PARZEN_C_STAR - 3.5134) < 1e-4);
});

test("realized kernel: H = 0 is plain RV; hand-computed alternating series", () => {
  const x = [1, -1, 1, -1];
  assert.equal(realizedKernelFromReturns(x, 0), 4);
  // gamma0 = 4, gamma1 = -3, weight k(1/2) = 0.25: 4 + 2 * 0.25 * (-3) = 2.5
  assert.ok(Math.abs(realizedKernelFromReturns(x, 1) - 2.5) < 1e-12);
});

test("TSRV: hand-computed small series (K = 2), including a negative small-sample value", () => {
  const y = [0, 0.01, 0, 0.02, 0.01, 0.03];
  const r = tsrv(y, 2)!;
  // [Y,Y]^all = 1.1e-3; [Y,Y]^avg = (0 + 1e-4 + 1e-4 + 1e-4) / 2 = 1.5e-4
  // nbar = (5 - 2 + 1) / 2 = 2; adj = 1 - 2/5 = 0.6
  assert.ok(Math.abs(r.rvAll - 1.1e-3) < 1e-15);
  assert.ok(Math.abs(r.rvAvg - 1.5e-4) < 1e-15);
  assert.equal(r.nbar, 2);
  assert.ok(Math.abs(r.iv - (1.5e-4 - 0.4 * 1.1e-3) / 0.6) < 1e-15);
  assert.ok(r.iv < 0); // why the headline falls back to the (non-negative) kernel
  assert.ok(Math.abs(r.noiseVar - 1.1e-3 / 10) < 1e-15);
});

test("previous-tick sampling and m = 2 end jittering", () => {
  const pts: PricePoint[] = [{ t: 10, p: 1 }, { t: 20, p: 2 }, { t: 30, p: 3 }];
  assert.deepEqual(previousTick(pts, [5, 10, 25, 30, 99]), [null, 1, 2, 3, 3]);
  assert.deepEqual(jitterEnds([0, 2, 4, 6, 8]), [1, 4, 7]);
});

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

/** One RTH session at 1-second updates: log price = Brownian (20% annual) + iid N(0, omega^2) noise. Known IV. */
function simulateSession(seed: number, omega: number) {
  const r = mulberry32(seed);
  const n = 23_400;
  const sig2 = 0.04 / (252 * 23_400); // per second
  let x = Math.log(5800);
  const pts: PricePoint[] = [];
  for (let i = 0; i <= n; i++) {
    if (i > 0) x += Math.sqrt(sig2) * gauss(r);
    pts.push({ t: RTH + i * 1000, p: Math.exp(x + omega * gauss(r)) });
  }
  return { pts, iv: sig2 * n };
}

test("seeded MC: TSRV and the realized kernel recover known IV under noise; naive RV does not", () => {
  for (const omega of [1e-4, 3e-4]) {
    const relTs: number[] = [];
    const relRk: number[] = [];
    const relNaive: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const { pts, iv } = simulateSession(seed, omega);
      const e = estimateRealizedVol(pts);
      assert.equal(e.dataState, "ok");
      relTs.push(e.tsrv! / iv - 1);
      relRk.push(e.realizedKernel! / iv - 1);
      relNaive.push(e.rvNaive! / iv - 1);
      // Each single session within 30% (kernel) / 15% (TSRV) of the truth.
      assert.ok(Math.abs(e.realizedKernel! / iv - 1) < 0.30, `RK seed ${seed} omega ${omega}`);
      assert.ok(Math.abs(e.tsrv! / iv - 1) < 0.15, `TSRV seed ${seed} omega ${omega}`);
      // ZMA noise estimate RV_all / 2n recovers omega^2 (plus IV / 2n).
      assert.ok(Math.abs(e.noiseVar! / (omega * omega + iv / (2 * 23_400)) - 1) < 0.05);
      // Annualised over regular-session seconds: 20% truth.
      assert.ok(e.annualizedVol! > 0.17 && e.annualizedVol! < 0.23, `ann ${e.annualizedVol}`);
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(Math.abs(mean(relTs)) < 0.03, `TSRV mean bias ${mean(relTs)}`);
    assert.ok(Math.abs(mean(relRk)) < 0.06, `RK mean bias ${mean(relRk)}`);
    // Naive RV is biased by 2 n omega^2: about 3x IV at 1 bp, 27x at 3 bp.
    const expectedBias = (2 * 23_400 * omega * omega) / (0.04 / 252);
    assert.ok(Math.abs(mean(relNaive) - expectedBias) / expectedBias < 0.05, `naive bias ${mean(relNaive)} vs ${expectedBias}`);
  }
});

test("seeded MC without noise: all three estimators agree with IV", () => {
  const { pts, iv } = simulateSession(99, 0);
  const e = estimateRealizedVol(pts);
  assert.ok(Math.abs(e.rvNaive! / iv - 1) < 0.03);
  assert.ok(Math.abs(e.tsrv! / iv - 1) < 0.05);
  assert.ok(Math.abs(e.realizedKernel! / iv - 1) < 0.30);
  assert.equal(e.method, "tsrv");
});

test("realized vol: too few observations is insufficient (null), never 0", () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ t: RTH + i * 1000, p: 100 + i * 0.01 }));
  const e = estimateRealizedVol(pts);
  assert.equal(e.dataState, "insufficient");
  assert.equal(e.iv, null);
  assert.equal(e.annualizedVol, null);
  assert.match(String(e.reason), /only 10 observations/);
  // Bad prices are dropped, not treated as 0.
  const bad = estimateRealizedVol([{ t: RTH, p: 0 }, { t: RTH + 1, p: NaN }]);
  assert.equal(bad.n, 0);
});

// ---------------------------------------------------------------------------
// 2. Stream store: delta merge, session epochs, validity, ticks, bars
// ---------------------------------------------------------------------------

const eqItem = (key: string, f: Record<number, number>, extra: Record<string, unknown> = {}) => {
  const o: Record<string, unknown> = { key, delayed: false, ...extra };
  for (const [k, v] of Object.entries(f)) o[k] = v;
  return o;
};
const E = L1_EQUITY_FIELDS;

test("field lists: per-service numbering (BID is 1 on equities, 2 on options)", () => {
  assert.equal(L1_EQUITY_FIELDS.BID, 1);
  assert.equal(L1_OPTION_FIELDS.BID, 2);
  assert.equal(L1_OPTION_FIELDS.MARK, 37);
  assert.equal(CHART_EQUITY_FIELDS.CHART_TIME, 7);
  assert.equal(fieldList({ a: 3, b: 1, c: 3, d: 0 }), "0,1,3");
});

test("store: LEVELONE delta frames merge into the snapshot; observed zero stays zero", () => {
  const s = new StreamStore({ tickSymbols: ["SPY"] });
  s.beginSession(RTH);
  s.applyData({ service: "LEVELONE_EQUITIES", timestamp: RTH, content: [eqItem("SPY", { [E.BID]: 580.0, [E.ASK]: 580.02, [E.LAST]: 580.01, [E.TOTAL_VOLUME]: 1000, [E.CLOSE]: 575, [E.QUOTE_TIME]: RTH - 500, [E.TRADE_TIME]: RTH - 800, [E.NET_CHANGE]: 5.01 })] }, RTH);
  s.applyData({ service: "LEVELONE_EQUITIES", timestamp: RTH + 1000, content: [eqItem("SPY", { [E.BID]: 580.01, [E.QUOTE_TIME]: RTH + 900, [E.LAST_SIZE]: 0 })] }, RTH + 1000);
  const q = s.equities.get("SPY")!;
  assert.equal(q.bid, 580.01);
  assert.equal(q.ask, 580.02); // kept from snapshot
  assert.equal(q.last, 580.01);
  assert.equal(q.closePrice, 575);
  assert.equal(q.lastSize, 0); // observed 0, not missing
  assert.equal(q.quoteTimeMs, RTH + 900);
  assert.equal(q.updates, 2);
});

test("store validity: live session, silence, reconnect epoch, delayed flag, RTH age", () => {
  const s = new StreamStore({ tickSymbols: [] });
  const opts = { maxSilenceMs: 45_000, maxQuoteAgeMs: 120_000 };
  assert.deepEqual(streamRecordUsable(s, undefined, RTH, opts), { use: false, reason: "stream not connected" });
  s.beginSession(RTH);
  s.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("$SPX", { [E.LAST]: 5800, [E.QUOTE_TIME]: RTH - 1000 })] }, RTH);
  const rec = () => s.equities.get("$SPX");
  const u = streamRecordUsable(s, rec(), RTH + 1000, opts);
  assert.equal(u.use, true);
  if (u.use) assert.equal(u.ageMs, 2000);
  // Socket silent past the limit: not usable (REST fallback).
  const silent = streamRecordUsable(s, rec(), RTH + 46_000, opts);
  assert.equal(silent.use, false);
  // Heartbeat keeps the session valid; quote now 61 s old: still within 120 s.
  s.noteMessage(RTH + 60_000);
  assert.equal(streamRecordUsable(s, rec(), RTH + 60_000, opts).use, true);
  // RTH: quote time older than 120 s -> REST may be newer.
  s.noteMessage(RTH + 130_000);
  const old = streamRecordUsable(s, rec(), RTH + 130_000, opts);
  assert.equal(old.use, false);
  if (!old.use) assert.match(old.reason, /131 s old/);
  // Market closed: an old quote is normal and usable.
  const sc = new StreamStore({ tickSymbols: [] });
  sc.beginSession(CLOSED);
  sc.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("$SPX", { [E.LAST]: 5800, [E.QUOTE_TIME]: CLOSED - 3 * 3600_000 })] }, CLOSED);
  assert.equal(streamRecordUsable(sc, sc.equities.get("$SPX"), CLOSED + 1000, opts).use, true);
  // Reconnect: every record invalid until Schwab re-sends it.
  s.endSession(RTH + 131_000);
  assert.equal(streamRecordUsable(s, rec(), RTH + 131_000, opts).use, false);
  s.beginSession(RTH + 132_000);
  const r2 = streamRecordUsable(s, rec(), RTH + 132_000, opts);
  assert.equal(r2.use, false);
  if (!r2.use) assert.equal(r2.reason, "no snapshot since reconnect");
  // Delayed flag: never used as current.
  s.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("$SPX", { [E.LAST]: 5801, [E.QUOTE_TIME]: RTH + 131_500 }, { delayed: true })] }, RTH + 132_000);
  const d = streamRecordUsable(s, rec(), RTH + 132_000, opts);
  assert.equal(d.use, false);
  if (!d.use) assert.match(d.reason, /delayed/);
});

test("store consumer helpers: no active store -> null with reason; option overlay respects REST quote time", () => {
  setActiveStreamStore(null);
  const r = streamEquityQuote("SPY", RTH);
  assert.equal(r.quote, null);
  const s = new StreamStore({ tickSymbols: [] });
  setActiveStreamStore(s, { maxSilenceMs: 45_000, maxQuoteAgeMs: 120_000 });
  s.beginSession(RTH);
  const O = L1_OPTION_FIELDS;
  const sym = "SPXW  261007C05800000";
  s.applyData({ service: "LEVELONE_OPTIONS", content: [{ key: sym, delayed: false, [O.BID]: 4.1, [O.ASK]: 4.3, [O.LAST]: 4.2, [O.MARK]: 4.2, [O.TOTAL_VOLUME]: 1500, [O.QUOTE_TIME]: RTH - 2000, [O.DELTA]: 0.45 }] }, RTH);
  assert.equal(streamOptionQuote(sym, RTH).quote?.delta, 0.45);
  const ov = streamOptionOverlay(sym, RTH - 5000, RTH)!;
  assert.deepEqual([ov.bid, ov.ask, ov.last, ov.totalVolume, ov.quoteTimeMs], [4.1, 4.3, 4.2, 1500, RTH - 2000]);
  // REST chain quote newer than the streamed one: the stream is behind; keep REST.
  assert.equal(streamOptionOverlay(sym, RTH - 1000, RTH), null);
  assert.equal(streamOptionOverlay(null, null, RTH), null);
  setActiveStreamStore(null);
});

test("tick ring: fixed capacity keeps the newest, counts drops; since() filters by receive time", () => {
  const ring = new TickRing(16);
  for (let i = 0; i < 20; i++) ring.push({ t: i, rx: 100 + i, last: i, bid: null, ask: null, cumVolume: i * 10, lastSize: null, lastInFrame: true, trade: i > 0 });
  assert.equal(ring.length, 16);
  assert.equal(ring.dropped, 4);
  assert.equal(ring.firstT(), 4);
  const s = ring.since(115);
  assert.deepEqual(s.map((k) => k.t), [15, 16, 17, 18, 19]);
  assert.equal(s[0].bid, null); // missing stays null, not 0
  assert.equal(s[0].cumVolume, 150);
});

test("store ticks: trade flag from cumulative volume increase; Schwab trade time used", () => {
  const s = new StreamStore({ tickSymbols: ["SPY"], synthBarSymbols: [] });
  s.beginSession(RTH);
  s.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("SPY", { [E.BID]: 580, [E.ASK]: 580.02, [E.LAST]: 580.01, [E.TOTAL_VOLUME]: 1000, [E.TRADE_TIME]: RTH - 10, [E.QUOTE_TIME]: RTH - 5 })] }, RTH);
  s.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("SPY", { [E.LAST]: 580.02, [E.TOTAL_VOLUME]: 1100, [E.TRADE_TIME]: RTH + 400 })] }, RTH + 450);
  s.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("SPY", { [E.BID]: 580.01, [E.QUOTE_TIME]: RTH + 600 })] }, RTH + 650);
  const { ticks, continuousSinceMs } = s.sessionTicks("SPY");
  assert.equal(continuousSinceMs, RTH);
  assert.deepEqual(ticks.map((k) => k.trade), [false, true, false]); // first item is the snapshot
  assert.deepEqual(ticks.map((k) => k.t), [RTH - 10, RTH + 400, RTH + 600]);
  s.endSession(RTH + 1000);
  assert.equal(s.sessionTicks("SPY").ticks.length, 0); // no continuous series while down
});

test("bars: $SPX synthesized from LEVELONE last; partial first minute never final; chart bar wins", () => {
  const s = new StreamStore({ tickSymbols: [], synthBarSymbols: ["$SPX"], barGraceMs: 2000, chartFinalAfterMs: 120_000 });
  const m0 = RTH; // 15:00:00Z, minute start
  s.beginSession(m0 + 20_000); // connected mid-minute
  const px = (t: number, p: number) => s.applyData({ service: "LEVELONE_EQUITIES", content: [eqItem("$SPX", { [E.LAST]: p, [E.TRADE_TIME]: t, [E.QUOTE_TIME]: t })] }, t + 50);
  px(m0 + 21_000, 5800);
  px(m0 + 61_000, 5801); // minute 1 opens
  px(m0 + 75_000, 5803);
  px(m0 + 90_000, 5799.5);
  px(m0 + 119_000, 5802);
  px(m0 + 121_000, 5802.5); // minute 2 opens -> minute 1 final
  let fin = s.drainFinalBars(m0 + 121_100);
  assert.equal(fin.length, 1);
  assert.deepEqual(
    [fin[0].t, fin[0].open, fin[0].high, fin[0].low, fin[0].close, fin[0].volume, fin[0].source, fin[0].complete, fin[0].updates],
    [m0 + 60_000, 5801, 5803, 5799.5, 5802, null, "l1_synth", true, 4],
  );
  // Minute 0 (connected mid-minute) is held but never final.
  assert.equal(s.getBars("$SPX").find((b) => b.t === m0)?.complete, false);
  // Minute 2 closes on the timer after its end + grace.
  fin = s.drainFinalBars(m0 + 180_000 + 2_000);
  assert.deepEqual(fin.map((b) => [b.t, b.open, b.close]), [[m0 + 120_000, 5802.5, 5802.5]]);
  // A CHART_EQUITY bar for the same minute replaces the synthesized one.
  const C = CHART_EQUITY_FIELDS;
  s.applyData({ service: "CHART_EQUITY", content: [{ key: "$SPX", [C.SEQUENCE]: 61, [C.OPEN]: 5800.9, [C.HIGH]: 5803.1, [C.LOW]: 5799.4, [C.CLOSE]: 5802, [C.VOLUME]: 0, [C.CHART_TIME]: m0 + 60_000 }] }, m0 + 125_000);
  const b1 = s.getBars("$SPX").find((b) => b.t === m0 + 60_000)!;
  assert.equal(b1.source, "chart_equity");
  assert.equal(b1.volume, 0); // observed 0 from Schwab kept as 0
  fin = s.drainFinalBars(m0 + 60_000 + 120_000);
  assert.deepEqual(fin.map((b) => [b.t, b.source]), [[m0 + 60_000, "chart_equity"]]);
  // A gap ends the session: the open bar is dropped, not finalized.
  px(m0 + 185_000, 5804);
  s.endSession(m0 + 190_000);
  assert.equal(s.drainFinalBars(m0 + 400_000).length, 0);
});

test("option wants: union by owner priority, capped; over-cap listed", () => {
  _resetOptionWants();
  syncStreamOptions("whale", ["W1", "W2", "A"]);
  syncStreamOptions("odte", ["A", "B"]);
  assert.deepEqual(wantedOptionSymbols(10), { symbols: ["A", "B", "W1", "W2"], overCap: [] });
  assert.deepEqual(wantedOptionSymbols(3), { symbols: ["A", "B", "W1"], overCap: ["W2"] });
  _resetOptionWants();
});

// ---------------------------------------------------------------------------
// 3. Lee-Ready on LEVELONE trade blocks
// ---------------------------------------------------------------------------

test("Lee-Ready on L1: prior-quote midpoint rule, tick rule at the mid, zero tick, unsigned", () => {
  const u: L1Update[] = [
    { t: 1, bid: 100.0, ask: 100.02, last: 100.01, cumVolume: 1000 }, // snapshot
    { t: 2, bid: 100.0, ask: 100.02, last: 100.02, cumVolume: 1100 }, // 100.02 > mid 100.01 -> buy (quote)
    { t: 3, bid: 100.01, ask: 100.03, last: 100.02, cumVolume: 1100 }, // quote only
    { t: 4, bid: 100.01, ask: 100.03, last: 100.02, cumVolume: 1150 }, // at mid 100.02, no prior tick -> unsigned
    { t: 5, bid: 100.01, ask: 100.03, last: 100.0, cumVolume: 1200 }, // < mid -> sell (quote)
    { t: 6, bid: 99.99, ask: 100.01, last: 100.0, cumVolume: 1300 }, // prior mid 100.02 (not this frame's 100.00) -> sell
    { t: 7, bid: 99.99, ask: 100.01, last: 100.0, cumVolume: 1350 }, // at mid 100.00, zero tick keeps -1 -> sell (tick)
  ];
  const c = classifyL1Trades(u);
  assert.deepEqual(c.trades.map((k) => [k.t, k.size, k.sign, k.rule]), [
    [2, 100, 1, "quote"], [4, 50, 0, "none"], [5, 50, -1, "quote"], [6, 100, -1, "quote"], [7, 50, -1, "tick"],
  ]);
  assert.deepEqual([c.quoteRule, c.tickRule, c.unsigned], [3, 1, 1]);
  // Cumulative volume falling (new session) resets the baseline; no trade inferred.
  const r = classifyL1Trades([{ t: 1, bid: 1, ask: 1.02, last: 1.01, cumVolume: 500 }, { t: 2, bid: 1, ask: 1.02, last: 1.01, cumVolume: 10 }]);
  assert.equal(r.trades.length, 0);
  assert.equal(r.volumeResets, 1);
});

test("signed volume bars from trade blocks: complete minutes only; a minute with no blocks is missing, not 0", () => {
  const m = RTH;
  const trades = [
    { t: m - 5_000, price: 99.9, size: 10, sign: 1 as const, rule: "quote" as const }, // before coverage
    { t: m + 1_000, price: 100, size: 100, sign: 1 as const, rule: "quote" as const },
    { t: m + 30_000, price: 100.1, size: 40, sign: -1 as const, rule: "tick" as const },
    { t: m + 130_000, price: 100.2, size: 70, sign: -1 as const, rule: "quote" as const },
    { t: m + 185_000, price: 100.3, size: 999, sign: 1 as const, rule: "quote" as const }, // in-progress minute
  ];
  const bars = signedVolumeBarsFromTrades(trades, m - 20_000, m + 185_000);
  assert.deepEqual(bars.map((b) => [b.ts - m, b.volume, b.signedVolume, b.direction, b.cumulative, !!b.volumeMissing, b.close]), [
    [0, 140, 60, 1, 60, false, 100.1],
    [60_000, 0, 0, 0, 60, true, 100.1],
    [120_000, 70, -70, -1, -10, false, 100.2],
  ]);
  const merged = mergeSignedBars(
    [{ ts: m - 120_000, close: 99, volume: 5, direction: 1, signedVolume: 5, cumulative: 5 }, { ts: m - 60_000, close: 98, volume: 7, direction: -1, signedVolume: -7, cumulative: -2 }, { ts: m, close: 1, volume: 1, direction: 1, signedVolume: 1, cumulative: -1 }],
    bars, m,
  );
  assert.deepEqual(merged.map((b) => [b.ts - m, b.cumulative]), [[-120_000, 5], [-60_000, -2], [0, 58], [60_000, 58], [120_000, -12]]);
});

// ---------------------------------------------------------------------------
// 4. Connection manager against an in-process fake Streamer
// ---------------------------------------------------------------------------

function wsAccept(key: string): string {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function encodeFrame(text: string, opcode = 1): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/** Decode masked client frames from a buffer; returns [messages, rest]. */
function decodeFrames(buf: Buffer): { msgs: Array<{ opcode: number; text: string }>; rest: Buffer } {
  const msgs: Array<{ opcode: number; text: string }> = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 0x80) !== 0;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    msgs.push({ opcode: b0 & 0x0f, text: data.toString("utf8") });
    off = p + len;
  }
  return { msgs, rest: buf.subarray(off) };
}

interface FakeReq { service: string; command: string; requestid: string; parameters: Record<string, string> }

class FakeStreamer {
  server: Server;
  port = 0;
  sockets: Socket[] = [];
  requests: FakeReq[] = [];
  connections = 0;
  /** LOGIN response code by token; default 0. */
  loginCode: (token: string) => number = () => 0;
  /** Reply to SUBS/ADD/UNSUBS with code 0. */
  ackSubs = true;
  constructor() {
    this.server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    this.server.on("upgrade", (req, socket: Socket) => {
      const key = String(req.headers["sec-websocket-key"] ?? "");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
      );
      this.connections++;
      this.sockets.push(socket);
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const { msgs, rest } = decodeFrames(buf);
        buf = Buffer.from(rest);
        for (const m of msgs) {
          if (m.opcode === 8) { try { socket.write(encodeFrame("", 8)); } catch { /* */ } socket.end(); continue; }
          if (m.opcode !== 1) continue;
          const frame = JSON.parse(m.text);
          for (const r of frame.requests ?? []) this.onRequest(socket, r);
        }
      });
      socket.on("error", () => { /* client went away */ });
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((res) => this.server.listen(0, "127.0.0.1", () => res()));
    this.port = (this.server.address() as any).port;
  }
  get info(): StreamerInfo {
    return { socketUrl: `ws://127.0.0.1:${this.port}/ws`, customerId: "cust", correlId: "corr", channel: "N9", functionId: "APIAPP" };
  }
  private onRequest(socket: Socket, r: FakeReq) {
    this.requests.push(r);
    if (r.service === "ADMIN" && r.command === "LOGIN") {
      const code = this.loginCode(r.parameters.Authorization);
      this.send(socket, { response: [{ service: "ADMIN", command: "LOGIN", requestid: r.requestid, timestamp: Date.now(), content: { code, msg: code === 0 ? "server=fake;status=PN" : "Login denied" } }] });
      return;
    }
    if (this.ackSubs) this.send(socket, { response: [{ service: r.service, command: r.command, requestid: r.requestid, timestamp: Date.now(), content: { code: 0, msg: `${r.command} command succeeded` } }] });
  }
  send(socket: Socket | undefined, obj: unknown) {
    if (!socket || socket.destroyed) return;
    socket.write(encodeFrame(JSON.stringify(obj)));
  }
  get live(): Socket | undefined {
    return this.sockets.filter((s) => !s.destroyed).slice(-1)[0];
  }
  data(service: string, content: unknown[]) {
    this.send(this.live, { data: [{ service, timestamp: Date.now(), command: "SUBS", content }] });
  }
  heartbeat() {
    this.send(this.live, { notify: [{ heartbeat: String(Date.now()) }] });
  }
  drop() {
    this.live?.destroy();
  }
  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => this.server.close(() => res()));
  }
  logins() { return this.requests.filter((r) => r.command === "LOGIN"); }
  cmds(service: string) { return this.requests.filter((r) => r.service === service).map((r) => `${r.command}:${r.parameters.keys ?? ""}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

const fastCfg = {
  equities: ["$SPX", "SPY", "$VIX"],
  tickSymbols: ["$SPX", "SPY"],
  synthBarSymbols: ["$SPX"],
  chartSymbols: ["SPY", "QQQ"],
  chartOptionalSymbols: ["$SPX"],
  heartbeatTimeoutMs: 400,
  loginTimeoutMs: 1000,
  backoffBaseMs: 20,
  backoffMaxMs: 100,
  stableAfterMs: 10_000,
  deniedBackoffMs: 150,
  tickMs: 25,
  optionDebounceMs: 10,
};

function makeStreamer(fake: FakeStreamer, tokens: string[], extra: Partial<typeof fastCfg> & Record<string, unknown> = {}) {
  let i = 0;
  const calls = { token: 0, force: 0, info: 0, logs: [] as string[] };
  const st = new SchwabStreamer({
    getAccessToken: async () => { calls.token++; return tokens[Math.min(i++, tokens.length - 1)] ?? null; },
    forceTokenRefresh: async () => { calls.force++; return null; },
    getStreamerInfo: async () => { calls.info++; return fake.info; },
    createSocket: (url: string) => new (globalThis as any).WebSocket(url) as WebSocketLike,
    log: (m) => calls.logs.push(m),
    jitter: () => 1,
  }, { ...DEFAULT_STREAM_CONFIG, ...fastCfg, ...extra } as any);
  return { st, calls };
}

test("streamer: LOGIN with the access token, then SUBS equities, SUBS chart, ADD $SPX chart separately", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const { st, calls } = makeStreamer(fake, ["tok-1"]);
  try {
    st.start();
    await waitFor(() => fake.cmds("CHART_EQUITY").length >= 2, 3000, "subscriptions");
    const login = fake.logins()[0];
    assert.equal(login.parameters.Authorization, "tok-1");
    assert.equal(login.parameters.SchwabClientChannel, "N9");
    assert.equal(login.parameters.SchwabClientFunctionId, "APIAPP");
    assert.equal((fake.requests[0] as any).SchwabClientCustomerId, "cust");
    assert.deepEqual(fake.cmds("LEVELONE_EQUITIES"), ["SUBS:$SPX,SPY,$VIX"]);
    assert.deepEqual(fake.cmds("CHART_EQUITY"), ["SUBS:SPY,QQQ", "ADD:$SPX"]);
    const eqSubs = fake.requests.find((r) => r.service === "LEVELONE_EQUITIES")!;
    assert.equal(eqSubs.parameters.fields, fieldList(L1_EQUITY_FIELDS));
    assert.equal(st.state, "live");
    assert.equal(st.status().mode, "live");
    // The token never appears in status or logs.
    assert.ok(!JSON.stringify(st.status()).includes("tok-1"));
    assert.ok(!calls.logs.join("\n").includes("tok-1"));
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: data frames reach the store; consumer helper serves the stream quote; stale socket falls back", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const { st } = makeStreamer(fake, ["tok-1"], { heartbeatTimeoutMs: 10_000 });
  try {
    st.start();
    await waitFor(() => st.state === "live", 3000, "live");
    const now = Date.now();
    fake.data("LEVELONE_EQUITIES", [eqItem("SPY", { [E.LAST]: 581.25, [E.BID]: 581.24, [E.ASK]: 581.26, [E.QUOTE_TIME]: now - 100, [E.TRADE_TIME]: now - 150, [E.TOTAL_VOLUME]: 123456 })]);
    await waitFor(() => st.store.equities.has("SPY"), 2000, "SPY quote");
    const r = streamEquityQuote("SPY");
    assert.ok(r.quote);
    assert.equal(r.quote!.last, 581.25);
    assert.equal(r.quote!.quoteTimeMs, now - 100);
    // Frames before LOGIN success are ignored; an unknown symbol is not streamed.
    assert.equal(streamEquityQuote("NOPE").quote, null);
    // Silence beyond maxSilenceMs: the helper refuses -> getQuotes uses Schwab REST.
    st.store.lastMessageAtMs = Date.now() - 60_000;
    const stale = streamEquityQuote("SPY");
    assert.equal(stale.quote, null);
    if (!stale.quote) assert.match(stale.reason, /silent/);
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: disconnect -> backoff -> reconnect with a refreshed token -> resubscribe; old quotes invalid until resent", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const { st, calls } = makeStreamer(fake, ["tok-1", "tok-2"]);
  try {
    st.start();
    await waitFor(() => st.state === "live", 3000, "live 1");
    fake.data("LEVELONE_EQUITIES", [eqItem("$SPX", { [E.LAST]: 5800, [E.QUOTE_TIME]: Date.now() })]);
    await waitFor(() => streamEquityQuote("$SPX").quote != null, 2000, "spx quote");
    fake.drop();
    await waitFor(() => fake.logins().length >= 2, 3000, "second login");
    assert.equal(fake.logins()[1].parameters.Authorization, "tok-2"); // fresh token on re-login
    await waitFor(() => fake.cmds("LEVELONE_EQUITIES").length >= 2, 3000, "resubscribe");
    assert.deepEqual(fake.cmds("LEVELONE_EQUITIES"), ["SUBS:$SPX,SPY,$VIX", "SUBS:$SPX,SPY,$VIX"]);
    assert.equal(st.reconnects, 1);
    assert.equal(calls.token, 2);
    // New session: the old $SPX record is not served until Schwab re-sends it.
    const before = streamEquityQuote("$SPX");
    assert.equal(before.quote, null);
    fake.data("LEVELONE_EQUITIES", [eqItem("$SPX", { [E.LAST]: 5801, [E.QUOTE_TIME]: Date.now() })]);
    await waitFor(() => streamEquityQuote("$SPX").quote?.last === 5801, 2000, "resent quote");
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: heartbeats keep the session; silence past the timeout forces a reconnect", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const { st } = makeStreamer(fake, ["tok-1"], { heartbeatTimeoutMs: 300 });
  try {
    st.start();
    await waitFor(() => st.state === "live", 3000, "live");
    for (let i = 0; i < 5; i++) { fake.heartbeat(); await sleep(100); }
    assert.equal(fake.logins().length, 1); // 500 ms with heartbeats: no reconnect
    await waitFor(() => fake.logins().length >= 2, 3000, "watchdog reconnect");
    assert.match(String(st.lastError), /no frame for|heartbeat/);
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: LOGIN_DENIED (code 3) forces one token refresh check, retries, then waits longer", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  fake.loginCode = (t) => (t === "bad" ? 3 : 0);
  const { st, calls } = makeStreamer(fake, ["bad", "bad", "good"]);
  try {
    st.start();
    await waitFor(() => st.state === "live", 4000, "live after denial");
    assert.equal(calls.force, 1); // only after the first denial
    assert.deepEqual(fake.logins().map((r) => r.parameters.Authorization), ["bad", "bad", "good"]);
    // "live" is set on the LOGIN ack; the SUBS frame follows a moment later.
    await waitFor(() => fake.cmds("LEVELONE_EQUITIES").length >= 1, 2000, "SUBS after login");
    assert.equal(fake.cmds("LEVELONE_EQUITIES").length, 1); // no SUBS until a LOGIN succeeds
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: no token -> no socket, state no_token; status says why", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const { st } = makeStreamer(fake, []);
  try {
    st.start();
    await waitFor(() => st.state === "no_token", 2000, "no_token");
    assert.equal(fake.connections, 0);
    const s = st.status();
    assert.equal(s.mode, "down");
    assert.match(String(s.lastError), /not connected/);
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: server notice (non-zero code) ends the session and reconnects after the long backoff", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const { st } = makeStreamer(fake, ["tok-1"], { deniedBackoffMs: 200 });
  try {
    st.start();
    await waitFor(() => st.state === "live", 3000, "live");
    const t0 = Date.now();
    fake.send(fake.live, { notify: [{ service: "ADMIN", timestamp: Date.now(), content: { code: 12, msg: "close connection" } }] });
    await waitFor(() => fake.logins().length >= 2, 3000, "reconnect after notice");
    assert.ok(Date.now() - t0 >= 180, "waited the long backoff");
    assert.deepEqual(st.notices.map((n) => n.code), [12]);
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

test("streamer: dynamic option subscriptions (SUBS, ADD, UNSUBS), cap, and resubscribe after reconnect", async () => {
  _resetOptionWants();
  const fake = new FakeStreamer();
  await fake.listen();
  const { st } = makeStreamer(fake, ["tok-1", "tok-2"], { maxOptionSymbols: 2 } as any);
  const A = "SPXW  261007C05800000", B = "SPXW  261007P05750000", C = "AAPL  261016C00250000";
  try {
    st.start();
    await waitFor(() => st.state === "live", 3000, "live");
    syncStreamOptions("odte", [A]);
    await waitFor(() => fake.cmds("LEVELONE_OPTIONS").length >= 1, 2000, "options SUBS");
    syncStreamOptions("odte", [A, B]);
    await waitFor(() => fake.cmds("LEVELONE_OPTIONS").length >= 2, 2000, "options ADD");
    syncStreamOptions("whale", [C]); // over the cap of 2
    await sleep(60);
    assert.deepEqual(st.status().subscriptions.optionsOverCap, [C]);
    syncStreamOptions("odte", [B]); // A disarmed -> frees a slot for C
    await waitFor(() => fake.cmds("LEVELONE_OPTIONS").length >= 4, 2000, "options ADD C + UNSUBS A");
    assert.deepEqual(fake.cmds("LEVELONE_OPTIONS"), [`SUBS:${A}`, `ADD:${B}`, `ADD:${C}`, `UNSUBS:${A}`]);
    const sub = fake.requests.find((r) => r.service === "LEVELONE_OPTIONS")!;
    assert.equal(sub.parameters.fields, fieldList(L1_OPTION_FIELDS));
    // Option frames reach the store with Schwab's quote time.
    const O = L1_OPTION_FIELDS;
    const qt = Date.now() - 200;
    fake.data("LEVELONE_OPTIONS", [{ key: B, delayed: false, [O.BID]: 3.1, [O.ASK]: 3.3, [O.MARK]: 3.2, [O.QUOTE_TIME]: qt }]);
    await waitFor(() => streamOptionQuote(B).quote != null, 2000, "option quote");
    assert.equal(streamOptionOverlay(B, null)!.quoteTimeMs, qt);
    // Reconnect: the current set is re-sent with SUBS.
    fake.drop();
    await waitFor(() => fake.cmds("LEVELONE_OPTIONS").length >= 5, 3000, "options resubscribe");
    assert.equal(fake.cmds("LEVELONE_OPTIONS")[4], `SUBS:${B},${C}`);
  } finally {
    st.stop();
    setActiveStreamStore(null);
    _resetOptionWants();
    await fake.close();
  }
});

test("streamer: final bars go to the sink from the watchdog tick", async () => {
  const fake = new FakeStreamer();
  await fake.listen();
  const sunk: any[] = [];
  let i = 0;
  const st = new SchwabStreamer({
    getAccessToken: async () => "tok-1",
    getStreamerInfo: async () => fake.info,
    createSocket: (url: string) => new (globalThis as any).WebSocket(url) as WebSocketLike,
    onFinalBars: (bars) => { sunk.push(...bars); },
    log: () => {},
    jitter: () => 1,
  }, { ...DEFAULT_STREAM_CONFIG, ...fastCfg, heartbeatTimeoutMs: 10_000 } as any);
  void i;
  try {
    st.start();
    await waitFor(() => st.state === "live", 3000, "live");
    const C = CHART_EQUITY_FIELDS;
    const old = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000; // 5 min ago: past chartFinalAfterMs
    fake.data("CHART_EQUITY", [{ key: "SPY", [C.SEQUENCE]: 1, [C.OPEN]: 580, [C.HIGH]: 581, [C.LOW]: 579.5, [C.CLOSE]: 580.5, [C.VOLUME]: 250_000, [C.CHART_TIME]: old }]);
    await waitFor(() => sunk.length >= 1, 2000, "bar sink");
    assert.deepEqual([sunk[0].symbol, sunk[0].t, sunk[0].volume, sunk[0].source], ["SPY", old, 250_000, "chart_equity"]);
  } finally {
    st.stop();
    setActiveStreamStore(null);
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Small pure pieces
// ---------------------------------------------------------------------------

test("streamerInfo parsing from userPreference", () => {
  const prefs = { accounts: [], streamerInfo: [{ streamerSocketUrl: "wss://streamer-api.schwab.com/ws", schwabClientCustomerId: "c1", schwabClientCorrelId: "k1", schwabClientChannel: "N9", schwabClientFunctionId: "APIAPP" }] };
  assert.deepEqual(parseStreamerInfo(prefs), { socketUrl: "wss://streamer-api.schwab.com/ws", customerId: "c1", correlId: "k1", channel: "N9", functionId: "APIAPP" });
  assert.equal(parseStreamerInfo({}), null);
  assert.equal(parseStreamerInfo({ streamerInfo: [{ streamerSocketUrl: "https://x", schwabClientCustomerId: "c", schwabClientCorrelId: "k" }] }), null);
});

test("backoff: doubles from base, capped, jitter in [0.5, 1]", () => {
  assert.deepEqual([0, 1, 2, 3, 10].map((f) => backoffDelayMs(f, 1000, 60_000, 1)), [1000, 2000, 4000, 8000, 60_000]);
  assert.equal(backoffDelayMs(2, 1000, 60_000, 0.5), 2000);
  assert.equal(backoffDelayMs(2, 1000, 60_000, 0.1), 2000); // clamped to 0.5
});

test("config from env: lists and bounded option cap; default subscription set", () => {
  const c = streamConfigFromEnv({ BATCAVE_STREAM_EQUITIES: "SPY, $SPX", BATCAVE_STREAM_MAX_OPTIONS: "999" });
  assert.deepEqual(c.equities, ["SPY", "$SPX"]);
  assert.equal(c.maxOptionSymbols, DEFAULT_STREAM_CONFIG.maxOptionSymbols); // out of range -> default
  const d = streamConfigFromEnv({});
  for (const s of ["$SPX", "$VIX", "$VIX9D", "SPY", "QQQ", "IWM", "DIA", "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "TSLA"]) assert.ok(d.equities.includes(s), s);
  assert.ok(d.equities.length + d.chartSymbols.length + d.chartOptionalSymbols.length + d.maxOptionSymbols <= 500);
});

test("blank BATCAVE_STREAM_MAX_OPTIONS keeps the default, an explicit 0 is honoured", async () => {
  const { streamConfigFromEnv } = await import("../../server/schwabStream.ts");
  const d = streamConfigFromEnv({});
  assert.equal(streamConfigFromEnv({ BATCAVE_STREAM_MAX_OPTIONS: "" }).maxOptionSymbols, d.maxOptionSymbols);
  assert.equal(streamConfigFromEnv({ BATCAVE_STREAM_MAX_OPTIONS: "  " }).maxOptionSymbols, d.maxOptionSymbols);
  assert.equal(streamConfigFromEnv({ BATCAVE_STREAM_MAX_OPTIONS: "0" }).maxOptionSymbols, 0);
});
