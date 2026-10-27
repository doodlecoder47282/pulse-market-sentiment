// Live verification: every cross-check passes on consistent inputs, fails on
// a planted inconsistency, and reports stale / unavailable / skipped states
// honestly rather than as passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  close, quoteCheck, spotAgreement, spreadCheck, forwardLevelsChecks, mapLandmarkChecks,
  flowContractChecks, pcrChecks, termChecks, relativeVolumeCheck, chainSanityChecks, summarize,
} from "../../shared/liveVerify";
import { composeOdteMap, type ForwardLike } from "../../shared/odteMap";
import { relativeVolume } from "../../shared/volumeRead";

const byId = (checks: { id: string; state: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.state]));

test("close: relative and absolute tolerance, nulls only equal each other", () => {
  assert.equal(close(100, 100.00001, 1e-6), true);
  assert.equal(close(100, 100.01, 1e-6), false);
  assert.equal(close(0, 0), true);
  assert.equal(close(null, null), true);
  assert.equal(close(null, 1), false);
  assert.equal(close(1.004, 1, 0, 0.005), true);
});

test("quote: fresh passes, old in session is stale, missing is unavailable, closed session never stale", () => {
  assert.equal(quoteCheck("Signals", "SPY", { symbol: "SPY", last: 500, ageMs: 2000, stale: false, feed: "stream" }, true).state, "pass");
  assert.equal(quoteCheck("Signals", "SPY", { symbol: "SPY", last: 500, ageMs: 400_000, stale: true, feed: "rest" }, true).state, "stale");
  assert.equal(quoteCheck("Signals", "SPY", { symbol: "SPY", last: 500, ageMs: 400_000, stale: true, feed: "rest" }, false).state, "pass");
  assert.equal(quoteCheck("Signals", "SPY", null, true).state, "unavailable");
  assert.equal(quoteCheck("Signals", "SPY", { symbol: "SPY", last: null }, true).state, "unavailable");
});

test("spot agreement and spread arithmetic", () => {
  assert.equal(spotAgreement("x", "p", "n", 6700, 6705).state, "pass");
  assert.equal(spotAgreement("x", "p", "n", 6700, 6800).state, "fail");
  assert.equal(spotAgreement("x", "p", "n", null, 6800).state, "unavailable");
  assert.equal(spotAgreement("x", "p", "n", 6700, null).state, "skipped");
  const bid = 99.9, ask = 100.1;
  assert.equal(spreadCheck("p", "AAPL", { bid, ask, spreadPct: (ask - bid) / 100 }).state, "pass");
  assert.equal(spreadCheck("p", "AAPL", { bid, ask, spreadPct: 0.01 }).state, "fail");
  assert.equal(spreadCheck("p", "AAPL", { bid: null, ask, spreadPct: null }).state, "skipped");
});

const forward = (over: Partial<ForwardLike> = {}): ForwardLike => ({
  symbol: "$SPX", asOf: "2026-10-23T14:30:00.000Z", spot: 6700, expiry: "2026-10-23", dte: 0, gexValid: true, regime: "long_gamma",
  netGex: 0, levels: { callWall: 6725, putWall: 6650, gammaFlip: 6680, pin: 6725 }, expectedMove: { sigma: 20, straddle: 25 },
  session: { state: "intraday", minutesToClose: 200, projMinutes: 200 }, bars: { priorClose: 6690, sessionHigh: 6710, sessionLow: 6680, orbHigh: null, orbLow: null, vwap: null },
  strikes: [
    { strike: 6650, gex: -900_000 }, { strike: 6675, gex: 400_000 }, { strike: 6700, gex: 1_500_000 },
    { strike: 6725, gex: 2_000_000 }, { strike: 6750, gex: -300_000 },
  ] as any,
  gammaCrossings: [6680], ...over,
});

test("forward levels: walls, pin and net exposure re-derived from the served strikes", () => {
  const f = forward(); f.netGex = f.strikes.reduce((a, s) => a + (s as any).gex, 0);
  const ok = byId(forwardLevelsChecks("Trade Desk", f as any));
  assert.deepEqual(ok, { "forward.callWall": "pass", "forward.putWall": "pass", "forward.pin": "pass", "forward.netGex": "pass" });
  const wrong = forward({ levels: { callWall: 6750, putWall: 6650, gammaFlip: 6680, pin: 6725 } }); wrong.netGex = 1;
  const bad = byId(forwardLevelsChecks("Trade Desk", wrong as any));
  assert.equal(bad["forward.callWall"], "fail");
  assert.equal(bad["forward.netGex"], "fail");
  assert.equal(forwardLevelsChecks("Trade Desk", forward({ gexValid: false }) as any)[0].state, "skipped");
  assert.equal(forwardLevelsChecks("Trade Desk", null)[0].state, "unavailable");
});

test("map landmarks: the real composer's output passes; a planted landmark fails", () => {
  const map = composeOdteMap(forward(), { edition: "personal" });
  assert.equal(map.dataState, "ok");
  const states = byId(mapLandmarkChecks("Signals", map));
  assert.deepEqual(states, { "map.wallAbove": "pass", "map.magnetBelow": "pass", "map.pocketAbove": "pass", "map.pocketBelow": "pass", "map.perPoint": "pass", "map.shares": "pass" });
  const tampered = { ...map, landmarks: { ...map.landmarks, wallAbove: 6750 } };
  assert.equal(byId(mapLandmarkChecks("Signals", tampered))["map.wallAbove"], "fail");
  const badPt = { ...map, strikes: map.strikes.map((s, i) => (i === 0 ? { ...s, gexPt: s.gexPt * 2 } : s)) };
  assert.equal(byId(mapLandmarkChecks("Signals", badPt))["map.perPoint"], "fail");
  assert.equal(mapLandmarkChecks("Signals", { ...map, dataState: "no_gex" })[0].state, "skipped");
});

test("flow contracts: premium, volume/OI and mid inside the quote", () => {
  const good = [
    { volume: 1000, openInterest: 50, volOiRatio: 20, isNewStrike: false, bid: 1.0, ask: 1.2, mid: 1.1, notional: 1000 * 1.1 * 100 },
    { volume: 500, openInterest: 0, volOiRatio: 999, isNewStrike: true, bid: 2.0, ask: 2.1, mid: 2.05, notional: 500 * 2.05 * 100 },
  ];
  assert.deepEqual(byId(flowContractChecks("Signals", good)), { "flow.notional": "pass", "flow.volOi": "pass", "flow.mid": "pass" });
  const bad = [{ ...good[0], notional: 1, volOiRatio: 3, mid: 5 }];
  assert.deepEqual(byId(flowContractChecks("Signals", bad)), { "flow.notional": "fail", "flow.volOi": "fail", "flow.mid": "fail" });
  assert.equal(flowContractChecks("Signals", [])[0].state, "skipped");
  assert.equal(flowContractChecks("Signals", null)[0].state, "unavailable");
});

test("put/call: per ticker and the index aggregate without VIX", () => {
  const t = [
    { symbol: "SPY", putVol: 300, callVol: 200, putOI: 30, callOI: 10, pcrVolume: 1.5, pcrOI: 3, dataState: "ok" as const },
    { symbol: "QQQ", putVol: 100, callVol: 200, putOI: 10, callOI: 10, pcrVolume: 0.5, pcrOI: 1, dataState: "ok" as const },
    { symbol: "^VIX", putVol: 1000, callVol: 1, putOI: 1, callOI: 1, pcrVolume: 1000, pcrOI: 1, dataState: "ok" as const },
    { symbol: "IWM", putVol: 0, callVol: 0, putOI: 0, callOI: 0, pcrVolume: null, pcrOI: null, dataState: "unavailable" as const },
  ];
  assert.deepEqual(byId(pcrChecks("Flow", t, 400 / 400)), { "pcr.tickers": "pass", "pcr.index": "pass" });
  assert.equal(byId(pcrChecks("Flow", t, 1.3))["pcr.index"], "fail");
  assert.equal(byId(pcrChecks("Flow", [{ ...t[0], pcrOI: 2 }], 1.5))["pcr.tickers"], "fail");
  assert.equal(pcrChecks("Flow", [t[3]], null)[0].state, "unavailable");
});

test("term: ratios from the snapshot's inputs, inputs against quotes within tolerance", () => {
  const term = { vix9d: 18, vix: 20, vix3m: 22, ratio9dOver30d: 0.9, ratio30dOver3m: 20 / 22 };
  const s = byId(termChecks("Regime", term, { vix9d: 18.1, vix: 20.2, vix3m: 22 }));
  assert.deepEqual(s, { "term.ratios": "pass", "term.VIX9D": "pass", "term.VIX": "pass", "term.VIX3M": "pass" });
  assert.equal(byId(termChecks("Regime", { ...term, ratio9dOver30d: 1.1 }, { vix9d: 18, vix: 20, vix3m: 22 }))["term.ratios"], "fail");
  assert.equal(byId(termChecks("Regime", term, { vix9d: 18, vix: 25, vix3m: 22 }))["term.VIX"], "fail");
  assert.equal(byId(termChecks("Regime", term, { vix9d: null, vix: 20, vix3m: 22 }))["term.VIX9D"], "skipped");
  assert.equal(byId(termChecks("Regime", { ...term, vix3m: null }, { vix9d: 18, vix: 20, vix3m: 22 }))["term.VIX3M"], "unavailable");
});

test("relative volume: the real function's output passes against the same bars", () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, t: i, close: 100, volume: 1_000_000 + i * 10_000 }));
  bars.push({ date: "2026-10-23", t: 99, close: 100, volume: 800_000 });
  const rv = relativeVolume(900_000, bars, "2026-10-23", 0.5);
  assert.equal(relativeVolumeCheck("Signals", "AAPL", rv, bars, "2026-10-23").state, "pass");
  assert.equal(relativeVolumeCheck("Signals", "AAPL", { ...rv, rel: 9 }, bars, "2026-10-23").state, "fail");
  assert.equal(relativeVolumeCheck("Signals", "SPX", relativeVolume(null, bars, "2026-10-23", 0.5), bars, "2026-10-23").state, "skipped");
  assert.equal(relativeVolumeCheck("Signals", "AAPL", null, bars, "2026-10-23").state, "unavailable");
});

test("chain sanity: priced rows with plausible IV pass; empty fails; old is stale", () => {
  const now = 1_700_000_000_000;
  const rows = Array.from({ length: 40 }, (_, i) => ({ bid: 1, ask: 1.1, iv: 0.2 + i / 1000, openInterest: 100, volume: 10 }));
  assert.equal(chainSanityChecks("Trade Desk", "$SPX", rows, { asOfMs: now - 30_000, stale: false }, now)[0].state, "pass");
  assert.equal(chainSanityChecks("Trade Desk", "$SPX", rows, { asOfMs: now - 30_000, stale: true }, now)[0].state, "stale");
  assert.equal(chainSanityChecks("Trade Desk", "$SPX", rows, { asOfMs: now - 10 * 60_000, stale: false }, now)[0].state, "stale");
  assert.equal(chainSanityChecks("Trade Desk", "$SPX", [], { asOfMs: now, stale: false }, now)[0].state, "fail");
  assert.equal(chainSanityChecks("Trade Desk", "$SPX", rows.map((r) => ({ ...r, iv: 50 })), { asOfMs: now, stale: false }, now)[0].state, "fail");
  assert.equal(chainSanityChecks("Trade Desk", "$SPX", null, null, now)[0].state, "unavailable");
});

test("summary: not connected, issues, all pass", () => {
  const p = { id: "a", panel: "p", name: "n", state: "pass" as const, observed: "", expected: null, detail: null };
  assert.equal(summarize([p], false).verdict, "not_connected");
  assert.equal(summarize([p, { ...p, state: "stale" }], true).verdict, "issues");
  assert.equal(summarize([p, { ...p, state: "skipped" }], true).verdict, "all_pass");
  assert.equal(summarize([], true).verdict, "nothing_checked");
});

import { classifyReach } from "../../shared/liveVerify";
test("reach: HTTP status and dataState are read as the UI reads them", () => {
  assert.equal(classifyReach(200, { dataState: "ok" }).state, "pass");
  assert.equal(classifyReach(200, { spot: 1 }).state, "pass");
  assert.equal(classifyReach(200, { dataState: "stale", reason: "old" }).state, "stale");
  assert.equal(classifyReach(200, { dataState: "partial" }).state, "stale");
  assert.equal(classifyReach(200, { dataState: "no_data" }).state, "skipped");
  assert.equal(classifyReach(200, { dataState: "unavailable" }).state, "unavailable");
  assert.equal(classifyReach(503, { dataState: "unavailable", reason: "Schwab down" }).detail, "Schwab down");
  assert.equal(classifyReach(503, null).state, "unavailable");
  assert.equal(classifyReach(429, null).state, "skipped");
  assert.equal(classifyReach(401, null).state, "fail");
  assert.equal(classifyReach(500, { message: "boom" }).state, "fail");
});
