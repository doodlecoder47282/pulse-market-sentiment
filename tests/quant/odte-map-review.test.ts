// tests/quant/odte-map-review.test.ts
//
// Independent review of the 0DTE map stack (shared/odteMap.ts,
// shared/odteSettle.ts, server/odteSettleInputs.ts, server/odteForward.ts).
// Tests named "REVIEW FINDING <letter>. ..." encode defects found from first
// principles and fail on the code as reviewed; the expectation in each is
// derived inside the test. The remaining tests pin down properties that were
// checked and hold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOdteForward } from "../../server/odteForward";
import { demoChain, demoPriceHistory } from "../../server/demoMarket";
import { etWallToEpochMs, etDate, addDays, sessionCloseMinutes } from "../../server/exchangeCalendar";
import { settleFromCandles } from "../../server/odteSettleInputs";
import { composeOdteMap, renderOdteMapText, compareMaps, strikeSpacing, fmtMoney, type ForwardLike, type OdteMap } from "../../shared/odteMap";
import { evaluateSettle, tallySettles } from "../../shared/odteSettle";

// ── fixtures ────────────────────────────────────────────────────────────

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

// The repo's subscriber-language gate (tests/quant/no-advice-language.test.ts), copied verbatim.
const INSTRUCTION = /\b(buy (the )?(dip|dips|calls|puts)|sell (the )?(rip|rips|calls|puts|premium|wings)|size (up|down|half)|half size|full size|go long|go short|take (the )?profits?|take the trade|enter (long|short|now)|act on (it|this|the)|fade (the|into|rallies|extremes)|ride (the )?(trend|pullbacks)|load up|scale (in|out)|stand aside|you should (buy|sell|enter)|cut size|size accordingly|reduce [\w-]+( [\w-]+){0,2} size|hedge with|tighten (gamma )?exposure)\b/gi;

type S = { strike: number; gex: number; callOI: number; putOI: number };
const mk = (strike: number, gex: number): S => ({ strike, gex, callOI: 100, putOI: 100 });

/** The hand-built forward of tests/quant/odte-map.test.ts (spot 7000, pin 7050, magnet 6975, pockets 7060 / 6950 / 7010). */
function synth(over: Partial<ForwardLike> = {}): ForwardLike {
  return {
    symbol: "$SPX", asOf: "2026-10-12T15:00:00.000Z", spot: 7000, expiry: "2026-10-12", dte: 0, gexValid: true, regime: "long_gamma", netGex: 5e9,
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

const zonesOf = (m: OdteMap) => Object.fromEntries((m.zones ?? []).map((z) => [z.kind, z]));

// ── 1. odteMap labels, band, ladders, zones ─────────────────────────────

test("labels on the demo forward: each landmark is the extreme of its side among the shown rows, the at-spot row sits in neither side pick, shelves/pockets respect the pin thresholds and the caps", async () => {
  const fwd = await buildOdteForward("$SPX", T, deps);
  assert.equal(fwd.status, 200);
  const b = fwd.body as ForwardLike;
  const m = composeOdteMap(b, { edition: "personal" });
  const rows = m.strikes;
  const spot = m.spot;
  const ext = (pred: (r: typeof rows[number]) => boolean, sign: 1 | -1) => {
    const c = rows.filter(pred);
    return c.length ? c.reduce((a, r) => (sign * r.gexPct > sign * a.gexPct ? r : a)).strike : null;
  };
  assert.equal(m.landmarks.pin, ext((r) => r.gexPct > 0 && Math.abs(r.strike - spot) / spot <= 0.015, 1));
  assert.equal(m.landmarks.wallAbove, ext((r) => r.gexPct > 0 && r.strike > spot, 1));
  assert.equal(m.landmarks.magnetBelow, ext((r) => r.gexPct > 0 && r.strike < spot, 1));
  assert.equal(m.landmarks.pocketAbove, ext((r) => r.gexPct < 0 && r.strike > spot, -1));
  assert.equal(m.landmarks.pocketBelow, ext((r) => r.gexPct < 0 && r.strike < spot, -1));
  const pinMag = rows.find((r) => r.strike === m.landmarks.pin)!.gexPct;
  for (const r of rows) {
    if (r.label === "shelf") assert.ok(r.gexPct >= 0.35 * pinMag, `${r.strike}`);
    if (r.label === "pocket") assert.ok(-r.gexPct >= 0.3 * pinMag, `${r.strike}`);
  }
  assert.ok(rows.filter((r) => r.label === "shelf").length <= 4);
  assert.ok(rows.filter((r) => r.label === "pocket").length <= 4);
  // Every row shown is within 2% and at least 1% of the gross; the ladder keeps nearest-first on each side.
  for (const r of rows) assert.ok(Math.abs(r.strike - spot) / spot <= 0.02 && r.share >= 0.01);
  for (let i = 1; i < m.ladders.above.length; i++) assert.ok(m.ladders.above[i].level > m.ladders.above[i - 1].level);
  for (let i = 1; i < m.ladders.below.length; i++) assert.ok(m.ladders.below[i].level < m.ladders.below[i - 1].level);
});

test("no positive strike within 1.5%: pin null, no shelf or pocket labels are handed out against a zero pin, side picks still made; spot exactly on a strike: that strike is in neither side pick but can be the pin", () => {
  // Pin absent: the only positives sit 1.7% away.
  const noPin = composeOdteMap(synth({ strikes: [mk(6880, 5e9), mk(7120, 4e9), mk(7005, -0.1e9), mk(6990, -0.3e9)] }), { edition: "investor" });
  assert.equal(noPin.landmarks.pin, null);
  assert.equal(noPin.landmarks.wallAbove, 7120);
  assert.equal(noPin.landmarks.magnetBelow, 6880);
  assert.ok(!noPin.strikes.some((r) => r.label === "shelf" || r.label === "pocket"));
  // Spot on the strike: 7000 is positive and the largest within 1.5% -> pin; it is not the wall above or the magnet below.
  const onStrike = composeOdteMap(synth({ strikes: [mk(7000, 5e9), mk(7050, 4e9), mk(6975, 2e9), mk(7060, -2.2e9), mk(6950, -1.5e9)] }), { edition: "investor" });
  const at = onStrike.strikes.find((r) => r.strike === 7000)!;
  assert.equal(at.side, "at");
  assert.equal(at.label, "pin");
  assert.equal(onStrike.landmarks.wallAbove, 7050);
  assert.equal(onStrike.landmarks.magnetBelow, 6975);
});

test("ladders keep the NEAREST eight on each side when more than eight levels exist", () => {
  // Twelve labelled-size positives above spot, 5 apart, all shelves of a 4e9 pin at 7005 -> only four shelves, but the
  // straddle/sigma/band/session/prior-close levels push the above ladder past eight.
  const strikes = [mk(7005, 4e9), mk(6975, 2e9), mk(6950, -1.5e9)];
  for (let k = 7010; k <= 7100; k += 10) strikes.push(mk(k, 1.5e9));
  const m = composeOdteMap(synth({ strikes, gammaCrossings: [6962, 7071], bars: { priorClose: 6990, sessionHigh: 7012, sessionLow: 6985, orbHigh: null, orbLow: null, vwap: null } }), { edition: "investor" });
  assert.equal(m.ladders.above.length, 8);
  const allAbove = [7012, 7030, 7038, 7071, 7005, ...m.strikes.filter((r) => r.label && r.strike > 7000).map((r) => r.strike)].sort((a, b) => a - b);
  const nearestEight = Array.from(new Set(allAbove)).slice(0, 8);
  assert.deepEqual(m.ladders.above.map((x) => Math.round(x.level)), nearestEight.map((x) => Math.round(x)));
});

test("REVIEW FINDING A. short gamma at spot: the crossing-bounded region is not a long-gamma band, so the ladder and the text must not call it one", () => {
  const m = composeOdteMap(synth({ regime: "short_gamma", gammaCrossings: [7040] }), { edition: "investor" });
  assert.equal(m.band.atSpot, "short");
  assert.equal(m.band.low, null);
  assert.equal(m.band.high, 7040);
  // The band's own basis says the crossing is where gamma TURNS positive: between spot and 7040 gamma is negative.
  assert.match(m.band.basis, /turns positive/);
  const row = m.ladders.above.find((x) => x.level === 7040)!;
  assert.ok(row, "the crossing is on the above ladder");
  assert.ok(!/long-gamma band/.test(row.what), `ladder calls the short-gamma side a long-gamma band: "${row.what}"`);
  const txt = renderOdteMapText(m);
  const gammaLine = txt.split("\n").find((l) => l.startsWith("gamma at spot"))!;
  assert.ok(!/long-gamma band/.test(gammaLine), `text contradicts itself: "${gammaLine}"`);
});

test("REVIEW FINDING B. renderOdteMapText in per-point units renders the ladders in per-point units too, not in per 1%", () => {
  const m = composeOdteMap(synth(), { edition: "investor" });
  const pin = m.strikes.find((r) => r.label === "pin")!;
  const txt = renderOdteMapText(m, "pt");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The table shows the pin at its per-point value (+$57.1M = 4.0e9 / 70); the ladder must show the same number, not the per-1% one.
  assert.equal(fmtMoney(pin.gexPt), "+$57.1M");
  assert.match(txt, new RegExp(`${esc(fmtMoney(pin.gexPt))}\\s+pin`));
  const ladderLines = txt.split("\n").filter((l) => /^(above|below):/.test(l));
  for (const l of ladderLines) assert.ok(!/per 1%/.test(l), `per-point text still carries per-1% ladder values: "${l}"`);
  assert.match(txt, new RegExp(`pin ${esc(fmtMoney(pin.gexPt))} per pt`));
});

test("REVIEW FINDING C. fade zone collapses to zero width when the fade top sits inside the straddle range; a zone spans the two levels it names", () => {
  // Pocket above at 7020 (past half a straddle: 7015), straddle top 7030.
  const f = synth({ strikes: [mk(6950, -1.5e9), mk(6960, 0.3e9), mk(6975, 2.0e9), mk(6995, 1.6e9), mk(7020, -1.3e9), mk(7050, 4.0e9), mk(7080, 0.5e9)] });
  const m = composeOdteMap(f, { edition: "personal" });
  assert.equal(m.landmarks.pocketAbove, 7020);
  const z = zonesOf(m).fade;
  assert.ok(z, "fade zone exists: 7020 >= 7000 + 15");
  assert.match(z.basis, /pocket above at 7020 .* straddle range top at 7030/);
  assert.ok(z.low < z.high, `fade zone has no width: ${z.low}-${z.high}`);
  assert.equal(z.low, Math.min(7020, 7030));
  assert.equal(z.high, Math.max(7020, 7030));
});

test("REVIEW FINDING D. no pin: the no-trade rule 'at least a fifth of the pin' cannot be applied, so a negligible pocket must not become a zone", () => {
  // No positive within 1.5%; 7005 is a 1.1%-share pocket (2% of the largest strike on the map).
  const f = synth({ strikes: [mk(6880, 5e9), mk(7120, 4e9), mk(7005, -0.1e9)] });
  const m = composeOdteMap(f, { edition: "personal" });
  assert.equal(m.landmarks.pin, null);
  const z = zonesOf(m)["no-trade"];
  assert.equal(z, undefined, `no-trade zone from a 0.1e9 pocket against a zero pin: ${JSON.stringify(z)}`);
});

test("REVIEW FINDING G. no-trade zone width is half the chain's strike spacing, not half the modal gap of the rows that survived the share filter", () => {
  // 5-point chain; only the big strikes (6950, 6975, 6995, 7010, 7050, 7060) pass the 1% share filter.
  const f = synth();
  const strikes = [...f.strikes.filter((s) => s.strike !== 7150 && [6950, 6975, 6995, 7010, 7050, 7060].includes(s.strike))];
  for (let k = 6900; k <= 7100; k += 5) if (!strikes.some((s) => s.strike === k)) strikes.push(mk(k, 0.01e9));
  const m = composeOdteMap({ ...f, strikes }, { edition: "personal" });
  assert.equal(strikeSpacing(strikes.map((s) => s.strike)), 5);
  assert.deepEqual(m.strikes.map((r) => r.strike), [7060, 7050, 7010, 6995, 6975, 6950]);
  const z = zonesOf(m)["no-trade"];
  assert.ok(z && z.basis.includes("7010"));
  assert.equal(z.low, 7010 - 2.5, `zone ${z.low}-${z.high} is drawn with the survivors' modal gap, not the 5-point grid`);
  assert.equal(z.high, 7010 + 2.5);
});

test("REVIEW FINDING H. dip zone with no positive strike under the magnet: the basis must not claim the premise fails under 'the next positive strike below it' when the fallback was used", () => {
  const f = synth({ strikes: [mk(6950, -1.5e9), mk(6975, 2.0e9), mk(6995, 1.6e9), mk(7010, -1.3e9), mk(7050, 4.0e9), mk(7060, -2.2e9)] });
  const m = composeOdteMap(f, { edition: "personal" });
  const z = zonesOf(m).dip;
  assert.equal(z.low, 6975);
  assert.equal(z.invalidation, 6975 - 7000 * 0.003);   // fallback: 0.3% of spot under the magnet
  assert.ok(!/next positive strike/.test(z.basis), `basis names a strike that does not exist: "${z.basis}"`);
});

test("REVIEW FINDING I. a row classified side 'at' is not labelled as a level on one side of spot", () => {
  // 7001 is 0.014% from spot (side 'at' under the 0.03% rule) and the largest negative strike.
  const f = synth({ strikes: [mk(6950, -1.5e9), mk(6975, 2.0e9), mk(7001, -3e9), mk(7050, 4.0e9), mk(7060, -2.2e9)] });
  const m = composeOdteMap(f, { edition: "investor" });
  const at = m.strikes.find((r) => r.strike === 7001)!;
  assert.equal(at.side, "at");
  assert.notEqual(at.label, "pocket above", "an at-spot row labelled as the pocket ABOVE spot");
  assert.equal(m.landmarks.pocketAbove, 7060);
});

test("REVIEW FINDING K. ladders stay on their side of spot: a session high printed under spot (chain spot ahead of the last 5-minute candle) must not head the above ladder", () => {
  const m = composeOdteMap(synth({ bars: { priorClose: 6990, sessionHigh: 6997, sessionLow: 6985, orbHigh: null, orbLow: null, vwap: null } }), { edition: "investor" });
  for (const x of m.ladders.above) assert.ok(x.level >= 7000, `above ladder holds ${x.level} (${x.what}) below spot`);
  for (const x of m.ladders.below) assert.ok(x.level <= 7000, `below ladder holds ${x.level} (${x.what}) above spot`);
});

test("REVIEW FINDING L. zones of different kinds do not overlap: a dip zone cannot sit inside a no-trade pocket", () => {
  // Magnet 6975; pocket 6980 (within 1%, over a fifth of the pin) -> no-trade 6975-6985 would cover the dip zone 6975-6979.
  const f = synth({ strikes: [
    mk(6950, -1.5e9), mk(6960, 0.3e9), mk(6975, 2.0e9), mk(6980, -1.3e9), mk(6990, 0.9e9), mk(6995, 1.6e9), mk(7000, 0.4e9),
    mk(7020, 1.2e9), mk(7030, 0.3e9), mk(7040, 1.1e9), mk(7050, 4.0e9), mk(7060, -2.2e9), mk(7080, 0.5e9),
  ] });
  const m = composeOdteMap(f, { edition: "personal" });
  const zs = m.zones ?? [];
  for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
    const a = zs[i], b = zs[j];
    const overlap = a.low <= b.high && b.low <= a.high;
    assert.ok(!overlap, `${a.kind} ${a.low}-${a.high} overlaps ${b.kind} ${b.low}-${b.high}`);
  }
});

test("text: the shown rows always include every labelled row (at most 13 labels, cap 14); nulls render as n/a; no NaN", () => {
  const m = composeOdteMap(synth(), { edition: "investor" });
  const txt = renderOdteMapText(m);
  for (const r of m.strikes.filter((r) => r.label)) assert.match(txt, new RegExp(`\\b${r.strike.toLocaleString("en-US")}\\b.*${r.label}`));
  assert.ok(!/NaN|undefined/.test(txt), txt);
  const bare = composeOdteMap(synth({ sessionOpen: null, priorClose: null, expectedMove: { sigma: null, straddle: null }, gammaCrossings: [], levels: { callWall: null, putWall: null, gammaFlip: null, pin: null }, bars: { priorClose: null, sessionHigh: null, sessionLow: null, orbHigh: null, orbLow: null, vwap: null } }), { edition: "personal" });
  const t2 = renderOdteMapText(bare);
  assert.ok(!/NaN|undefined/.test(t2), t2);
  assert.match(t2, /gap: open or prior close not available/);
  assert.match(t2, /straddle not available/);
});

// ── 2. compareMaps ──────────────────────────────────────────────────────

test("REVIEW FINDING J. compareMaps rank correlation must not depend on the order of their rows when their magnitudes tie (midranks)", () => {
  const ours = [{ strike: 7800, value: 100 }, { strike: 7810, value: 60 }, { strike: 7820, value: 50 }, { strike: 7830, value: 10 }];
  const orderA = [{ level: 7800, value: 10 }, { level: 7810, value: 5 }, { level: 7820, value: 5 }, { level: 7830, value: 1 }];
  const orderB = [orderA[0], orderA[2], orderA[1], orderA[3]];
  const a = compareMaps(ours, orderA, 1).rankCorr!;
  const b = compareMaps(ours, orderB, 1).rankCorr!;
  // Midranks: theirs [4, 2.5, 2.5, 1] vs ours [4, 3, 2, 1] -> sum d^2 = 0.5 -> 1 - 6*0.5/(4*15) = 0.95 (Pearson on midranks 0.949).
  assert.equal(a, b, `same data, two row orders: ${a} vs ${b}`);
  assert.ok(Math.abs(a - 0.95) <= 0.01, `${a}`);
});

test("compareMaps: fewer than three matches -> null correlation; a zero value on their side never counts as sign agreement with a signed strike", () => {
  const ours = [{ strike: 7000, value: 1e9 }, { strike: 7005, value: -1e9 }];
  const c = compareMaps(ours, [{ level: 7000, value: 3 }, { level: 7005, value: -2 }], 1);
  assert.equal(c.matched, 2);
  assert.equal(c.rankCorr, null);
  assert.equal(compareMaps(ours, [{ level: 7000, value: 0 }], 1).rows[0].signAgree, false);
});

// ── 3. odteSettle ───────────────────────────────────────────────────────

test("REVIEW FINDING E. no-trade pocket 'crossed' means price went through it, not that it was touched from one side", () => {
  const m = composeOdteMap(synth(), { edition: "personal" });
  const z = zonesOf(m)["no-trade"];
  assert.deepEqual([z.low, z.high], [7005, 7015]);
  // Session 6990-7008: price poked 3 points into the pocket from below and came back; it never reached the far edge.
  const e = evaluateSettle(m, { settle: 7000, sessionHigh: 7008, sessionLow: 6990 });
  const o = e.zones.find((x) => x.kind === "no-trade")!;
  assert.equal(o.touched, true);
  assert.equal(o.heldOrCrossed, false, "a one-sided touch is reported as a crossing");
  assert.match(e.lesson, /no-trade pocket touched/);
  // A real crossing (both edges exceeded) is still a crossing.
  assert.equal(evaluateSettle(m, { settle: 7020, sessionHigh: 7025, sessionLow: 6990 }).zones.find((x) => x.kind === "no-trade")!.heldOrCrossed, true);
});

test("settle on a boundary: range edges are inclusive, the dip 'above' and fade 'below' relations are strict and the lesson wording matches; median over an even count; tally denominators skip absent zones", () => {
  const m = composeOdteMap(synth(), { edition: "personal" });
  const onLow = evaluateSettle(m, { settle: m.range.low!, sessionHigh: 7001, sessionLow: m.range.low! });
  assert.equal(onLow.settleInStraddle, true);
  assert.equal(onLow.sessionInStraddle, true);
  const onDip = evaluateSettle(m, { settle: 6975, sessionHigh: 7001, sessionLow: 6970 });
  assert.equal(onDip.zones.find((z) => z.kind === "dip")!.settleRelation, false);
  assert.match(onDip.lesson, /dip zone touched, settle at or below it/);
  const onFade = evaluateSettle(m, { settle: 7030, sessionHigh: 7031, sessionLow: 6999 });
  assert.equal(onFade.zones.find((z) => z.kind === "fade")!.settleRelation, false);
  assert.match(onFade.lesson, /settle at or above it/);
  const inv = composeOdteMap(synth(), { edition: "investor" });
  const evals = [
    evaluateSettle(inv, { settle: 7001, sessionHigh: 7004, sessionLow: 6993 }),
    evaluateSettle(inv, { settle: 7042, sessionHigh: 7055, sessionLow: 6973 }),
    evaluateSettle(m, { settle: 6940, sessionHigh: 7002, sessionLow: 6935 }),
    evaluateSettle(m, { settle: 7020, sessionHigh: 7025, sessionLow: 6990 }),
  ];
  const t = tallySettles(evals);
  // |pin distance|: 49, 8, 110, 30 -> sorted 8, 30, 49, 110 -> median (30 + 49) / 2.
  assert.equal(t.medianAbsPinDistance, 39.5);
  assert.deepEqual(t.dipTouchedAndHeld, { yes: 0, of: 1 });      // only the personal maps carry zones; one of two touched
  assert.deepEqual(t.fadeTouchedAndHeld, { yes: 0, of: 0 });
  assert.match(t.note, /4 settled days: counts only/);
  assert.match(tallySettles(evals.slice(0, 1)).note, /1 settled day:/);
});

// ── 4. odteForward vs the original route body ───────────────────────────

test("forward: error bodies and the price-history fallback match the original route; additive fields are present and consistent", async () => {
  const errChain = { ...deps, getOptionChain: async () => ({ error: "schwab_down" }) };
  const e1 = await buildOdteForward("$SPX", T, errChain);
  assert.equal(e1.status, 503);
  assert.deepEqual(e1.body, { dataState: "unavailable", reason: "Option chain unavailable", error: "schwab_down", message: "Option chain unavailable" });
  const noSpot = { ...deps, getOptionChain: async (s: string, d: number) => { const c = await deps.getOptionChain(s, d); return { ...c, underlying: { ...c.underlying, last: 0 } }; } };
  const e2 = await buildOdteForward("$SPX", T, noSpot);
  assert.equal(e2.status, 503);
  assert.equal(e2.body.dataState, "no_spot");
  const noKeys = { ...deps, getOptionChain: async (s: string, d: number) => { const c = await deps.getOptionChain(s, d); return { ...c, callExpDateMap: {}, putExpDateMap: {} }; } };
  assert.equal((await buildOdteForward("$SPX", T, noKeys)).body.error, "no_expiries");
  // Price history failing is swallowed exactly as before: 200 with empty session bars, prior close from the chain's quote.
  const noHist = { ...deps, getPriceHistory: async () => { throw new Error("hist down"); } };
  const ok = await buildOdteForward("$SPX", T, noHist);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.bars, { priorClose: null, sessionHigh: null, sessionLow: null, orbHigh: null, orbLow: null, vwap: null });
  const chain = await deps.getOptionChain("$SPX", 1);
  assert.equal(ok.body.priorClose, chain.underlying.close);
  assert.equal(ok.body.sessionOpen, chain.underlying.openPrice);
  // Additive fields on the normal path, asOf on the injected clock, the same strikes band as before.
  const full = await buildOdteForward("$SPX", T, deps);
  assert.equal(full.body.asOf, new Date(T).toISOString());
  assert.equal(full.body.strikeBandPct, 3);
  assert.ok(Array.isArray(full.body.gammaCrossings) && full.body.gammaCrossings.length >= 1);
  assert.ok(full.body.gammaCrossings.includes(+full.body.levels.gammaFlip.toFixed(2)) || Math.abs(full.body.gammaCrossings[0] - full.body.levels.gammaFlip) < 1);
  for (const s of full.body.strikes) assert.ok(Math.abs(s.strike - full.body.spot) / full.body.spot <= 0.03);
  assert.deepEqual(Object.keys(full.body.levels), ["callWall", "putWall", "gammaFlip", "pin"]);
  // Same inputs, same clock -> same numbers (no hidden Date.now()).
  const again = await buildOdteForward("$SPX", T, deps);
  assert.deepEqual(again.body.strikes, full.body.strikes);
  assert.deepEqual(again.body.levels, full.body.levels);
  assert.deepEqual(again.body.expectedMove, full.body.expectedMove);
  assert.equal(again.body.session.minutesToClose, 300);
});

// ── 5. odteSettleInputs ─────────────────────────────────────────────────

test("REVIEW FINDING F. a tape that stops hours before the close is partial data, not a settle: settleFromCandles must not return the 11:59 close as the day's settle", () => {
  const t = etWallToEpochMs("2026-10-12", 16 * 60 + 10);
  const h = demoPriceHistory({ symbol: "$SPX", periodType: "day", period: 1, frequencyType: "minute", frequency: 1, endDate: t }, t);
  const full = settleFromCandles(h.candles, t)!;
  assert.ok(full && full.settle > 0);
  const noon = etWallToEpochMs("2026-10-12", 12 * 60);
  const truncated = h.candles.filter((c: any) => c.datetime < noon);
  assert.ok(truncated.length > 100, "demo tape has morning bars");
  const partial = settleFromCandles(truncated, t);
  assert.equal(partial, null, `a tape ending at 11:59 ET was reported as the settle: ${JSON.stringify(partial)}`);
});

test("settleFromCandles: half-day close at 13:00 drops afternoon prints; the pre-open bar is excluded; a zero last close is null", () => {
  // 2026-11-27 is a 13:00 ET early close.
  assert.equal(sessionCloseMinutes("2026-11-27"), 13 * 60);
  const d = "2026-11-27";
  const bar = (min: number, px: number) => ({ datetime: etWallToEpochMs(d, min), open: px, high: px + 1, low: px - 1, close: px, volume: 1 });
  const candles = [bar(9 * 60 + 29, 6000), bar(9 * 60 + 30, 6010), bar(12 * 60 + 59, 6020), bar(13 * 60, 6050), bar(15 * 60, 6100)];
  const s = settleFromCandles(candles, etWallToEpochMs(d, 16 * 60 + 10))!;
  assert.deepEqual(s, { settle: 6020, sessionHigh: 6021, sessionLow: 6009 });
  assert.equal(settleFromCandles([{ ...bar(9 * 60 + 30, 6010), close: 0 }], etWallToEpochMs(d, 16 * 60 + 10)), null);
});

// ── 6. Language ─────────────────────────────────────────────────────────

test("language: everything the investor edition can show, the labels and ladders, the personal zone text and the lesson lines are descriptive under the repo's instruction regex", async () => {
  const fwd = await buildOdteForward("$SPX", T, deps);
  const b = fwd.body as ForwardLike;
  const texts: string[] = [];
  for (const f of [b, synth(), synth({ regime: "short_gamma", gammaCrossings: [7040] }), synth({ gexValid: false, regime: "indeterminate" })]) {
    for (const edition of ["investor", "personal", "demo"] as const) {
      const m = composeOdteMap(f, { edition });
      texts.push(renderOdteMapText(m, "pct"), renderOdteMapText(m, "pt"), m.zonesNote, m.reason ?? "", m.band.basis, ...m.method);
      texts.push(...m.ladders.above.map((x) => x.what), ...m.ladders.below.map((x) => x.what));
      texts.push(...m.strikes.map((r) => r.label ?? ""));
      for (const z of m.zones ?? []) texts.push(z.basis, z.kind);
      for (const s of [{ settle: 7042, sessionHigh: 7055, sessionLow: 6973 }, { settle: 6940, sessionHigh: 7002, sessionLow: 6935 }, { settle: 7001, sessionHigh: 7004, sessionLow: 6993 }]) {
        const e = evaluateSettle(m, s);
        texts.push(e.lesson);
        texts.push(tallySettles([e]).note, tallySettles(new Array(50).fill(e)).note);
      }
    }
  }
  const hits = texts.flatMap((t) => Array.from(t.matchAll(INSTRUCTION)).map((x) => `${x[0]} <- ${t}`));
  assert.deepEqual(hits, []);
  const inv = renderOdteMapText(composeOdteMap(b, { edition: "investor" }));
  assert.ok(!/\b(DIP|FADE|NO-TRADE)\b/.test(inv), inv);
});
