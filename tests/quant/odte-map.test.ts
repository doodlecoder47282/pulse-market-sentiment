// tests/quant/odte-map.test.ts
//
// The 0DTE map composer (shared/odteMap.ts) on (a) the real forward
// computation run against the deterministic demo chain with injected data
// sources, and (b) hand-built forward payloads where every label and zone is
// known. The comparison helper is checked against a published-style fixture:
// it reports agreement and never changes the map.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOdteForward } from "../../server/odteForward";
import { demoChain, demoPriceHistory } from "../../server/demoMarket";
import { etWallToEpochMs, etDate, addDays } from "../../server/exchangeCalendar";
import { composeOdteMap, renderOdteMapText, compareMaps, strikeSpacing, etDateOf, type ForwardLike } from "../../shared/odteMap";

const T = etWallToEpochMs("2026-10-12", 11 * 60);
const deps = {
  getOptionChain: async (symbol: string, dte: number) => {
    const from = etDate(T);
    const ch = demoChain({ symbol, contractType: "ALL", strikeCount: 120, includeUnderlyingQuote: "true", fromDate: from, toDate: addDays(from, Math.max(dte, 1)) }, T);
    return { ...ch, source: "demo", asOfMs: T, ageMs: 0, servedFromCache: false, stale: false };
  },
  getPriceHistory: async (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number) =>
    demoPriceHistory({ symbol, periodType, period, frequencyType, frequency, endDate: T }, T),
};

const INSTRUCTION = /\b(buy (the )?(dip|dips|calls|puts)|sell (the )?(rip|rips|calls|puts|premium|wings)|size (up|down|half)|go long|go short|take (the )?profits?|enter (long|short|now)|fade (the|into|rallies|extremes)|load up|scale (in|out)|stand aside|you should (buy|sell|enter))\b/i;

test("demo forward -> map: landmarks agree with the forward's levels, units convert, band reads off the crossings, editions differ only in zones", async () => {
  const fwd = await buildOdteForward("$SPX", T, deps);
  assert.equal(fwd.status, 200);
  const b = fwd.body as ForwardLike;
  assert.equal(b.dte, 0);
  assert.ok(b.gexValid);
  const m = composeOdteMap(b, { edition: "personal" });
  assert.equal(m.dataState, "ok");
  assert.equal(m.dateEt, "2026-10-12");
  // Sorted high to low, shares within [0,1] and summing to at most 1, per-point = per-1% / (S/100).
  for (let i = 1; i < m.strikes.length; i++) assert.ok(m.strikes[i].strike < m.strikes[i - 1].strike);
  assert.ok(m.strikes.reduce((s, r) => s + r.share, 0) <= 1 + 1e-9);
  for (const r of m.strikes) assert.ok(Math.abs(r.gexPt - Math.round(r.gexPct / (b.spot / 100))) <= 1, `${r.strike}`);
  // Pin is positive and within 1.5%; wall above is the forward's call wall when that sits above spot.
  const pin = m.strikes.find((r) => r.label === "pin")!;
  assert.ok(pin.gexPct > 0 && Math.abs(pin.strike - b.spot) / b.spot <= 0.015);
  if (b.levels.callWall != null && b.levels.callWall > b.spot) assert.equal(m.landmarks.wallAbove, b.levels.callWall);
  if (b.levels.putWall != null && b.levels.putWall < b.spot) assert.equal(m.landmarks.pocketBelow, b.levels.putWall);
  assert.equal(m.landmarks.flip, b.levels.gammaFlip);
  // Band: nearest crossing below spot is the band bottom.
  const below = (b.gammaCrossings ?? []).filter((x) => x < b.spot);
  assert.equal(m.band.low, below.length ? Math.round(below[below.length - 1] * 100) / 100 : null);
  assert.equal(m.band.atSpot, "long");
  // Gap and range.
  assert.equal(m.gap.open, b.sessionOpen);
  assert.equal(m.gap.priorClose, b.priorClose);
  assert.ok(Math.abs(m.range.high! - (b.spot + b.expectedMove.straddle!)) < 0.01);
  assert.ok(Math.abs(m.range.sigmaLow! - (b.spot - b.expectedMove.sigma!)) < 0.01);
  // Zones only in the personal edition; the rest of the map is identical.
  const inv = composeOdteMap(b, { edition: "investor" });
  const demo = composeOdteMap(b, { edition: "demo" });
  assert.ok(m.zones && m.zones.length >= 1);
  assert.equal(inv.zones, null);
  assert.equal(demo.zones, null);
  assert.deepEqual(inv.strikes, m.strikes);
  assert.deepEqual(inv.ladders, m.ladders);
  // Text: both unit conventions render, no instruction language in the investor text.
  const txt = renderOdteMapText(inv, "pct");
  assert.match(txt, /SPX 0DTE MAP/);
  assert.match(txt, /per 1%/);
  assert.match(renderOdteMapText(inv, "pt"), /per pt/);
  assert.ok(!INSTRUCTION.test(txt), txt);
  assert.match(txt, /not a forecast or advice/);
});

function synth(over: Partial<ForwardLike> = {}): ForwardLike {
  const spot = 7000;
  const mk = (strike: number, gex: number): { strike: number; gex: number; callOI: number; putOI: number } => ({ strike, gex, callOI: 100, putOI: 100 });
  return {
    symbol: "$SPX", asOf: "2026-10-12T15:00:00.000Z", spot, expiry: "2026-10-12", dte: 0, gexValid: true, regime: "long_gamma", netGex: 5e9,
    levels: { callWall: 7050, putWall: 6950, gammaFlip: 6962, pin: 7050 },
    expectedMove: { sigma: 38, straddle: 30 },
    session: { state: "intraday", minutesToClose: 240, projMinutes: 240 },
    bars: { priorClose: 6990, sessionHigh: 7012, sessionLow: 6985, orbHigh: 7005, orbLow: 6988, vwap: 7001 },
    strikes: [
      mk(6900, -0.2e9), mk(6950, -1.5e9), mk(6960, 0.3e9), mk(6975, 2.0e9), mk(6985, -0.1e9), mk(6990, 0.9e9), mk(6995, 1.6e9),
      mk(7000, 0.4e9), mk(7010, -1.3e9), mk(7020, 1.2e9), mk(7030, 0.3e9), mk(7040, 1.1e9), mk(7050, 4.0e9), mk(7060, -2.2e9), mk(7080, 0.5e9), mk(7150, 0.6e9),
    ],
    gammaCrossings: [6962, 7071],
    sessionOpen: 6998, priorClose: 6990,
    ...over,
  };
}

test("labels: pin, wall above, magnet below, pockets above and below, shelves and pockets capped at four each", () => {
  const m = composeOdteMap(synth(), { edition: "personal" });
  const L = Object.fromEntries(m.strikes.filter((r) => r.label).map((r) => [r.strike, r.label]));
  assert.equal(L[7050], "pin");                 // largest positive within 1.5%; also the wall above, pin wins the label
  assert.equal(m.landmarks.wallAbove, 7050);
  assert.equal(L[6975], "magnet below");        // largest positive below spot
  assert.equal(L[7060], "pocket above");        // largest negative above
  assert.equal(L[6950], "pocket below");        // largest negative below
  assert.equal(L[7010], "pocket");              // other negative over 30% of the pin (1.3 / 4.0)
  assert.equal(L[6995], "shelf");               // 1.6 / 4.0 >= 35%
  assert.equal(L[7020], undefined);             // 1.2 / 4.0 = 30% < 35%
  assert.ok(m.strikes.filter((r) => r.label === "shelf").length <= 4);
  // 7150 is outside the 2% band (7000 x 1.02 = 7140).
  assert.ok(!m.strikes.some((r) => r.strike === 7150));
  assert.equal(m.band.low, 6962);
  assert.equal(m.band.high, 7071);
  assert.equal(m.gap.points, 8);
  assert.equal(m.gap.read, "flat");             // 8 / 6990 = 0.11% < 0.15%
  assert.equal(m.range.low, 6970);
  assert.equal(m.range.high, 7030);
});

test("zones (personal): dip at the magnet with the premise failing under the next positive strike; fade into the pocket above when it sits past half a straddle; no-trade round a pocket within 1%", () => {
  const m = composeOdteMap(synth(), { edition: "personal" });
  const z = Object.fromEntries((m.zones ?? []).map((x) => [x.kind, x]));
  assert.equal(z.dip.low, 6975);
  assert.ok(z.dip.high > 6975 && z.dip.high < 6980);
  assert.equal(z.dip.invalidation, 6959);       // next positive strike below 6975 is 6960; minus one point
  assert.equal(z.fade.high, 7060);
  assert.equal(z.fade.low, 7030);               // min(spot + straddle, pocket) = 7030
  assert.equal(z["no-trade"].low, 7005);        // nearest pocket to spot (7010, a fifth of the pin or more), spacing 10 -> +-5
  assert.equal(z["no-trade"].high, 7015);
  assert.match(m.zonesNote, /heuristic, not a forecast/);
  // Investor edition: no zones, a reason, and the text says so.
  const inv = composeOdteMap(synth(), { edition: "investor" });
  assert.equal(inv.zones, null);
  assert.match(renderOdteMapText(inv), /not shown in this edition/);
});

test("gap reads, unpriced map, closed session and a short-gamma band are reported, never defaulted", () => {
  assert.equal(composeOdteMap(synth({ sessionOpen: 7010, priorClose: 6990 }), { edition: "investor" }).gap.read, "up");
  assert.equal(composeOdteMap(synth({ sessionOpen: 6970, priorClose: 6990 }), { edition: "investor" }).gap.read, "down");
  assert.equal(composeOdteMap(synth({ sessionOpen: null, priorClose: null, bars: { priorClose: null, sessionHigh: null, sessionLow: null, orbHigh: null, orbLow: null, vwap: null } }), { edition: "investor" }).gap.read, "unknown");
  const dead = composeOdteMap(synth({ gexValid: false, regime: "indeterminate" }), { edition: "personal" });
  assert.equal(dead.dataState, "no_gex");
  assert.equal(dead.zones, null);
  assert.equal(dead.landmarks.pin, null);
  assert.match(renderOdteMapText(dead), /not priced/);
  const closed = composeOdteMap(synth({ session: { state: "closed", minutesToClose: 0, projMinutes: 390 } }), { edition: "investor" });
  assert.equal(closed.dataState, "stale_session");
  const short = composeOdteMap(synth({ regime: "short_gamma", gammaCrossings: [7040] }), { edition: "investor" });
  assert.equal(short.band.atSpot, "short");
  assert.equal(short.band.low, null);
  assert.equal(short.band.high, 7040);
  // No straddle: no range, no fade zone, text says so.
  const noStr = composeOdteMap(synth({ expectedMove: { sigma: null, straddle: null } }), { edition: "personal" });
  assert.equal(noStr.range.low, null);
  assert.ok(!(noStr.zones ?? []).some((z) => z.kind === "fade"));
  assert.match(renderOdteMapText(noStr), /straddle not available/);
});

test("ladders: nearest first on each side, levels within half a point merged, at most eight", () => {
  const m = composeOdteMap(synth(), { edition: "investor" });
  for (let i = 1; i < m.ladders.above.length; i++) assert.ok(m.ladders.above[i].level >= m.ladders.above[i - 1].level);
  for (let i = 1; i < m.ladders.below.length; i++) assert.ok(m.ladders.below[i].level <= m.ladders.below[i - 1].level);
  assert.ok(m.ladders.above.length <= 8 && m.ladders.below.length <= 8);
  assert.ok(m.ladders.above.some((x) => x.level === 7030 && /straddle range top/.test(x.what) && /shelf|pocket|pin|magnet|wall/.test(x.what) === false || x.level === 7030));
  const flipRow = m.ladders.below.find((x) => x.level === 6962);
  assert.ok(flipRow && /gamma flip/.test(flipRow.what) && /band bottom/.test(flipRow.what), JSON.stringify(flipRow));
});

test("compareMaps: a published-style map against ours reports matches, sign agreement and rank correlation, and never changes the map", () => {
  // The published map's shape (levels in points, values in its own $M units).
  const theirs = [
    { level: 7850, value: -14.8 }, { level: 7840, value: 25.5 }, { level: 7845, value: 6.4 }, { level: 7830, value: 5.4 }, { level: 7820, value: 6.5 },
    { level: 7815, value: 8.5 }, { level: 7810, value: -10.6 }, { level: 7800, value: 15.7 }, { level: 7785, value: 4.6 }, { level: 7780, value: 5.4 }, { level: 7745, value: -2.0 },
  ];
  // "Ours": the same structure at the same strikes in per-1% dollars, one sign disagreement (7810) and one level we do not have (7745).
  const ours = theirs.filter((t) => t.level !== 7745).map((t) => ({ strike: t.level, value: (t.level === 7810 ? 1 : 1) * t.value * 1.3e8 * (t.level === 7810 ? -1 : 1) }));
  const c = compareMaps(ours, theirs, 5);
  assert.equal(c.theirs, 11);
  assert.equal(c.matched, 10);
  assert.equal(c.signAgree, 9);
  assert.equal(c.rankCorr, 1);                  // magnitudes are a constant multiple: perfect rank agreement
  assert.equal(c.rows.find((r) => r.theirLevel === 7745)!.ourStrike, null);
  assert.equal(c.rows.find((r) => r.theirLevel === 7810)!.signAgree, false);
  assert.match(c.note, /not adjusted/);
  // Tolerance: a 3-point offset matches at 5 but not at 1 (5-point strikes: the neighbour is 2 away).
  const shifted = ours.map((o) => ({ ...o, strike: o.strike + 3 }));
  assert.equal(compareMaps(shifted, theirs, 5).matched, 10);
  assert.equal(compareMaps(shifted, theirs, 1).matched, 0);
  assert.equal(compareMaps([], theirs).rankCorr, null);
});

test("helpers: strike spacing is the modal gap; ET date of an ISO stamp", () => {
  assert.equal(strikeSpacing([7000, 7005, 7010, 7020, 7025]), 5);
  assert.equal(strikeSpacing([7000]), null);
  assert.equal(etDateOf("2026-10-12T15:00:00.000Z"), "2026-10-12");
  assert.equal(etDateOf("2026-10-13T02:30:00.000Z"), "2026-10-12");   // 22:30 ET the day before
  assert.equal(etDateOf("garbage"), "");
});
