// R2-A: Schwab-only market data. Cache max age and provenance, strike
// coverage, index symbols, rolled closePrice, return-based quote shield,
// Schwab chain conversion for the former CBOE consumers.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  schwabDataKind, staleServeDecision, freshFreshness, maxServeAgeMs, MAX_SERVE_AGE_MS,
  chainStrikePlan, strikeCoverage, inferStrikeCountSemantics, atmIvFromChain,
  Z_10_DELTA, MAX_STRIKE_COUNT, STRIKE_COUNT_STEP, chainIsDelayed, modelsFallbackDecision, oldestChainAsOf,
} from "../../server/schwabDataPolicy";
import { toSchwabSymbol } from "../../server/schwabSymbols";
import { resolvePrevClose, dayChange } from "../../server/dayChange";
import { shieldStep, newShieldState, checkQuote, SHIELD_K } from "../../server/quoteShield";
import { normPpf } from "../../server/stats";
const normInv = (p: number) => normPpf(p, 0, 1);

// Fixed instants. 2026-10-07 is a Wednesday (regular session 09:30-16:00 ET, EDT = UTC-4).
const RTH = Date.parse("2026-10-07T15:00:00Z");     // 11:00 ET, session open
const CLOSED = Date.parse("2026-10-07T23:00:00Z");  // 19:00 ET, session closed

// ---------------------------------------------------------------------------
// 1. Cache max age and provenance (finding 1.1 remainder)
// ---------------------------------------------------------------------------

test("schwab data kind: quotes, chains, minute vs daily bars", () => {
  assert.equal(schwabDataKind("marketdata/v1/quotes", { symbols: "SPY" }), "quotes");
  assert.equal(schwabDataKind("marketdata/v1/chains", { symbol: "$SPX" }), "chains");
  assert.equal(schwabDataKind("marketdata/v1/pricehistory", { frequencyType: "minute" }), "minute_bars");
  assert.equal(schwabDataKind("marketdata/v1/pricehistory", { frequencyType: "daily" }), "daily_bars");
  assert.equal(schwabDataKind("marketdata/v1/pricehistory", { frequencyType: "weekly" }), "daily_bars");
  assert.equal(schwabDataKind("marketdata/v1/markets"), "markets");
});

test("stale serve: a cached chain within its session max age is served stale with its real asOf", () => {
  assert.equal(maxServeAgeMs("chains", RTH), 180_000);
  const fetchedAt = RTH - 100_000;
  const d = staleServeDecision(fetchedAt, "chains", "Schwab 403", RTH);
  assert.equal(d.serve, true);
  if (d.serve) {
    assert.equal(d.freshness.asOfMs, fetchedAt);
    assert.equal(d.freshness.ageMs, 100_000);
    assert.equal(d.freshness.servedFromCache, true);
    assert.equal(d.freshness.stale, true);
    assert.equal(d.freshness.reason, "Schwab 403");
  }
});

test("stale serve: past the max age the answer is unavailable, never older data", () => {
  const d = staleServeDecision(RTH - 181_000, "chains", "Schwab 429 rate limit", RTH);
  assert.equal(d.serve, false);
  if (!d.serve) {
    assert.equal(d.ageMs, 181_000);
    assert.match(d.reason, /181 s old \(max 180 s\)/);
  }
  // quotes: 2 min during the session (same as quoteFreshness)
  assert.equal(staleServeDecision(RTH - 121_000, "quotes", "x", RTH).serve, false);
  assert.equal(staleServeDecision(RTH - 119_000, "quotes", "x", RTH).serve, true);
  // nothing cached -> unavailable
  const none = staleServeDecision(null, "chains", "Schwab 403", RTH);
  assert.equal(none.serve, false);
});

test("stale serve: outside the session the limits are longer but still finite", () => {
  assert.equal(maxServeAgeMs("chains", CLOSED), MAX_SERVE_AGE_MS.closed.chains);
  assert.equal(staleServeDecision(CLOSED - 20 * 60_000, "chains", "x", CLOSED).serve, true);
  assert.equal(staleServeDecision(CLOSED - 31 * 60_000, "chains", "x", CLOSED).serve, false);
  assert.equal(staleServeDecision(CLOSED - 5 * 3600_000, "daily_bars", "x", CLOSED).serve, true);
  assert.equal(staleServeDecision(CLOSED - 7 * 3600_000, "daily_bars", "x", CLOSED).serve, false);
});

test("fresh payloads (new request or TTL hit) are not stale and carry their fetch time", () => {
  const f = freshFreshness(RTH - 30_000, "chains", true, RTH);
  assert.deepEqual(
    { asOfMs: f.asOfMs, ageMs: f.ageMs, servedFromCache: f.servedFromCache, stale: f.stale, reason: f.reason },
    { asOfMs: RTH - 30_000, ageMs: 30_000, servedFromCache: true, stale: false, reason: null },
  );
});

// ---------------------------------------------------------------------------
// 2. Strike coverage (finding 1.7)
// ---------------------------------------------------------------------------

/** Forward-moneyness of the 25-delta put: ln(K/F) = -N^-1(0.75) sigma sqrt(T) + sigma^2 T / 2 (Hull, Options Futures and Other Derivatives, ch. 19 delta of a European put on a forward). */
function put25Moneyness(sigma: number, T: number): number {
  return -normInv(0.75) * sigma * Math.sqrt(T) + 0.5 * sigma * sigma * T;
}

test("strike plan: SPX 0DTE covers the +-10% re-priced flip scan", () => {
  const p = chainStrikePlan({ symbol: "$SPX", spot: 6700, dteMax: 0, atmIv: 0.18 });
  assert.equal(p.spacing, 5);
  assert.equal(p.halfWidthPct, 0.10);
  assert.equal(p.perSide, 134);           // ceil(670 / 5)
  assert.equal(p.strikeCount, 280);       // 2 x 134 = 268, rounded up to a step of 20
  assert.equal(p.capped, false);
  // the old request: 60 strikes, at best 30 per side = 150 points = 2.2%
  assert.ok((30 * 5) / 6700 < 0.023);
});

test("strike plan: 90 DTE window reaches past the 25-delta put even when capped", () => {
  const S = 6700, iv = 0.18, T = 90 / 365;
  const p = chainStrikePlan({ symbol: "$SPX", spot: S, dteMax: 90, atmIv: iv });
  const em = Z_10_DELTA * 1.5 * iv * Math.sqrt(T);
  assert.ok(Math.abs(p.halfWidthPct - em) < 1e-12);
  assert.ok(Math.abs(p.halfWidthPct - 0.17182) < 1e-4, String(p.halfWidthPct));
  assert.equal(p.perSide, 231);           // ceil(0.17182 * 6700 / 5)
  assert.equal(p.strikeCount, MAX_STRIKE_COUNT);
  assert.equal(p.capped, true);
  // 25-delta put at a skewed wing vol of 22%: ln(K/F) = -0.0677 (K ~ 0.9345 F)
  const k25 = put25Moneyness(0.22, T);
  assert.ok(Math.abs(k25 - -0.06772) < 2e-4, String(k25));
  // worst case: cap of 300 read as a TOTAL -> 150 strikes per side = 750 points = 11.2%
  const cappedCoverage = (MAX_STRIKE_COUNT / 2) * 5 / S;
  assert.ok(cappedCoverage > Math.abs(Math.exp(k25) - 1), `${cappedCoverage}`);
  // the old 60-strike request (30 per side, 2.2%) did not reach it
  assert.ok((30 * 5) / S < Math.abs(Math.exp(k25) - 1));
  // once Schwab is known to count per side, the request halves
  assert.equal(chainStrikePlan({ symbol: "$SPX", spot: S, dteMax: 90, atmIv: iv, semantics: "per_side" }).strikeCount, 240); // 231 -> step 20
});

test("strike plan: spacing by symbol and unknown spot", () => {
  assert.equal(chainStrikePlan({ symbol: "SPY", spot: 670, dteMax: 0, atmIv: 0.18 }).perSide, 67);
  assert.equal(chainStrikePlan({ symbol: "$NDX", spot: 24000, dteMax: 0 }).spacing, 10);
  assert.equal(chainStrikePlan({ symbol: "AAPL", spot: 250, dteMax: 30 }).spacing, 2.5);
  const unknown = chainStrikePlan({ symbol: "SPY", spot: null, dteMax: 5 });
  assert.equal(unknown.strikeCount, 200);
});

function synthChain(lo: number, hi: number, step: number, expiries: string[], iv = 18) {
  const m: Record<string, Record<string, any[]>> = {};
  for (const e of expiries) {
    m[e] = {};
    for (let k = lo; k <= hi + 1e-9; k += step) m[e][k.toFixed(1)] = [{ volatility: iv, strikePrice: k }];
  }
  return { callExpDateMap: m, putExpDateMap: m };
}

test("strike coverage: measured on the response, worst expiry wins", () => {
  const short = synthChain(6200, 7200, 5, ["2026-10-07:0", "2026-10-08:1"]);
  const c1 = strikeCoverage(short, 6700, 0.10, 5);
  assert.ok(Math.abs((c1.belowPct ?? 0) - 500 / 6700) < 1e-12);
  assert.equal(c1.complete, false);
  assert.equal(c1.expiries, 2);
  const full = synthChain(6030, 7370, 5, ["2026-10-07:0"]);
  assert.equal(strikeCoverage(full, 6700, 0.10, 5).complete, true);
  // one narrower expiry makes the whole response incomplete
  const mixed = { callExpDateMap: { ...full.callExpDateMap, ...synthChain(6600, 6800, 5, ["2026-10-09:2"]).callExpDateMap }, putExpDateMap: {} };
  assert.equal(strikeCoverage(mixed, 6700, 0.10, 5).complete, false);
});

test("strike-count semantics: only 'per side' is ever inferred", () => {
  assert.equal(inferStrikeCountSemantics(268, 268, 268), "per_side");
  assert.equal(inferStrikeCountSemantics(268, 134, 134), "unknown");
  assert.equal(inferStrikeCountSemantics(268, 90, 180), "unknown"); // short listing
});

test("ATM IV from the nearest expiry", () => {
  const ch = synthChain(6600, 6800, 5, ["2026-10-07:0"], 20);
  assert.ok(Math.abs((atmIvFromChain(ch, 6702) ?? 0) - 0.20) < 1e-12);
  assert.equal(atmIvFromChain({ callExpDateMap: {}, putExpDateMap: {} }, 6700), null);
});

// ---------------------------------------------------------------------------
// 3. Index symbols (item 2)
// ---------------------------------------------------------------------------

test("Schwab index symbols: $ prefix, no .X suffix", () => {
  assert.equal(toSchwabSymbol("^VIX"), "$VIX");
  assert.equal(toSchwabSymbol("^VIX9D"), "$VIX9D");
  assert.equal(toSchwabSymbol("^VIX3M"), "$VIX3M");
  assert.equal(toSchwabSymbol("^VVIX"), "$VVIX");
  assert.equal(toSchwabSymbol("^SKEW"), "$SKEW");
  assert.equal(toSchwabSymbol("^GSPC"), "$SPX");
  assert.equal(toSchwabSymbol("^NDX"), "$NDX");
  assert.equal(toSchwabSymbol("^RUT"), "$RUT");
  assert.equal(toSchwabSymbol("^IXIC"), "$COMPX");
  assert.equal(toSchwabSymbol("$SPX.X"), "$SPX");
  assert.equal(toSchwabSymbol("SPY"), "SPY");
});

// ---------------------------------------------------------------------------
// 4. closePrice after 16:00 (item 7). Daily bars stamped at midnight ET.
// ---------------------------------------------------------------------------

const barT = (iso: string) => Math.floor(Date.parse(`${iso}T04:00:00Z`) / 1000); // 00:00 EDT
const BARS = [
  { t: barT("2026-10-05"), c: 6650.00 },
  { t: barT("2026-10-06"), c: 6680.00 },  // prior session close
  { t: barT("2026-10-07"), c: 6712.40 },  // today's close (bar exists after 16:00)
];

test("day change: closePrice not rolled (equals the prior session bar) is used", () => {
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-07", todayEt: "2026-10-07", prevTradingDate: "2026-10-06",
    quote: { closePrice: 6680.00, lastPrice: 6712.40, netChange: 32.40, regularMarketLast: 6712.40 },
    dailyBars: BARS, afterSessionClose: true,
  });
  assert.equal(r.prevClose, 6680.00);
  assert.equal(r.source, "schwab_quote_close");
  assert.equal(r.prevCloseDate, "2026-10-06");
  assert.equal(r.closeRolled, false);
  const dc = dayChange(6712.40, r.prevClose);
  assert.ok(Math.abs((dc.change ?? 0) - 32.40) < 1e-9);
  assert.ok(Math.abs((dc.changePct ?? 0) - (32.40 / 6680) * 100) < 1e-12);
});

test("day change: closePrice rolled to today's close is detected; the prior daily bar is used", () => {
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-07", todayEt: "2026-10-07", prevTradingDate: "2026-10-06",
    quote: { closePrice: 6712.40, lastPrice: 6712.40, netChange: 0, regularMarketLast: 6712.40 },
    dailyBars: BARS, afterSessionClose: true,
  });
  assert.equal(r.prevClose, 6680.00);
  assert.equal(r.source, "daily_bar");
  assert.equal(r.prevCloseDate, "2026-10-06");
  assert.equal(r.closeRolled, true);
  // the naive read would have shown a flat day
  assert.equal(dayChange(6712.40, 6712.40).change, 0);
  assert.ok(Math.abs((dayChange(6712.40, r.prevClose).change ?? 0) - 32.40) < 1e-9);
});

test("day change: after the close with no bars, close == last is ambiguous -> unavailable, not 0", () => {
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-07", todayEt: "2026-10-07", prevTradingDate: "2026-10-06",
    quote: { closePrice: 6712.40, lastPrice: 6712.40, netChange: 0, regularMarketLast: 6712.40 },
    dailyBars: null, afterSessionClose: true,
  });
  assert.equal(r.prevClose, null);
  assert.equal(r.source, "unavailable");
  assert.match(r.reason ?? "", /rolled or flat/);
});

test("day change: a truly flat day with bars stays an observed 0", () => {
  const flatBars = [{ t: barT("2026-10-06"), c: 6680.00 }, { t: barT("2026-10-07"), c: 6680.00 }];
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-07", todayEt: "2026-10-07", prevTradingDate: "2026-10-06",
    quote: { closePrice: 6680.00, lastPrice: 6680.00, netChange: 0, regularMarketLast: 6680.00 },
    dailyBars: flatBars, afterSessionClose: true,
  });
  assert.equal(r.prevClose, 6680.00);
  assert.equal(dayChange(6680.00, r.prevClose).change, 0);
});

test("day change: during the session the quote close is used as is", () => {
  const r = resolvePrevClose({
    priceSessionDate: "2026-10-07", todayEt: "2026-10-07", prevTradingDate: "2026-10-06",
    quote: { closePrice: 6680.00, lastPrice: 6700.00, netChange: 20 },
    dailyBars: null, afterSessionClose: false,
  });
  assert.equal(r.prevClose, 6680.00);
  assert.equal(r.source, "schwab_quote_close");
});

// ---------------------------------------------------------------------------
// 5. Quote shield on returns (finding 1.9)
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng: () => number) {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The old level test: Tukey 3*IQR fence on the last 60 prices. */
function oldLevelFlag(price: number, recent: number[]): boolean {
  const a = recent.slice().sort((x, y) => x - y);
  const q = (p: number) => a[Math.floor(p * (a.length - 1))];
  const iqr = q(0.75) - q(0.25);
  return price > q(0.75) + 3 * iqr || price < q(0.25) - 3 * iqr;
}

test("quote shield: a quiet tape followed by an ordinary move is not flagged (the old level test flagged it)", () => {
  // SPX: 60 prints within +-0.05 pt every 5 s, then an ordinary grind of 0.5 pt
  // per 5 s (0.75 bp; ~0.5 sigma at 15% vol). The level fence of the quiet
  // window is ~0.2 pt wide, so the old test flagged the first move.
  const prices: number[] = [];
  let st = newShieldState();
  let flagged = 0, oldFlagged = 0;
  const rng = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const p = i < 60 ? 6700 + 0.02 * gauss(rng) : 6700 + 0.5 * (i - 59) + 0.02 * gauss(rng);
    if (prices.length >= 60 && oldLevelFlag(p, prices.slice(-60))) oldFlagged++;
    const r = shieldStep(st, p, i * 5000);
    st = r.state;
    if (r.check.suspect) flagged++;
    prices.push(p);
  }
  assert.equal(flagged, 0);
  assert.ok(oldFlagged > 0, "old level test should have flagged the move");
});

test("quote shield: seeded GBM at 20% vol has no false alarms; a 1% bad print is flagged, its reversion is not", () => {
  const rng = mulberry32(42);
  const sigmaPerSec = 0.20 / Math.sqrt(252 * 23_400);
  let st = newShieldState();
  let p = 6700, flagged = 0;
  const dt = 5;
  for (let i = 0; i < 2000; i++) {
    p *= Math.exp(sigmaPerSec * Math.sqrt(dt) * gauss(rng));
    const r = shieldStep(st, Math.round(p * 100) / 100, i * dt * 1000);
    st = r.state;
    if (r.check.suspect) flagged++;
  }
  assert.equal(flagged, 0);
  const t = 2000 * dt * 1000;
  const bad = shieldStep(st, p * 1.01, t);
  assert.equal(bad.check.suspect, true);
  assert.ok(bad.check.modZ > SHIELD_K);
  const back = shieldStep(bad.state, p, t + 5000);
  assert.equal(back.check.suspect, false);
});

test("quote shield: a real level shift is accepted after 3 consistent prints", () => {
  let st = newShieldState();
  for (let i = 0; i < 30; i++) st = shieldStep(st, 100 + (i % 2) * 0.01, i * 5000).state;
  const a = shieldStep(st, 103, 30 * 5000);
  const b = shieldStep(a.state, 103.01, 31 * 5000);
  const c = shieldStep(b.state, 103.0, 32 * 5000);
  assert.equal(a.check.suspect, true);
  assert.equal(b.check.suspect, true);
  assert.equal(c.check.suspect, false);
  assert.match(c.check.reasons[0], /level shift confirmed/);
  const d = shieldStep(c.state, 103.02, 33 * 5000);
  assert.equal(d.check.suspect, false);
});

test("quote shield: identical repeated observation is ignored; checkQuote helper agrees", () => {
  let st = newShieldState();
  st = shieldStep(st, 100, 0).state;
  const again = shieldStep(st, 100, 0);
  assert.equal(again.state, st);
  const trend = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
  assert.equal(checkQuote(106.0, trend).suspect, false);
  assert.equal(checkQuote(112.0, trend).suspect, true);
});

// ---------------------------------------------------------------------------
// 6. Schwab chain -> rows for the former CBOE consumers (item 1)
// ---------------------------------------------------------------------------

import { flattenSchwabChain, exposureRowsFromSchwabChain, chainVolumeTotals, schwabNum, chainSpot } from "../../server/schwabChainRows";
import { buildGammaStructure } from "../../server/sources";
import { bsPrice } from "../../server/greeks";
import { timeToExpiry } from "../../server/timeToExpiry";

// Friday 2026-10-09 10:00 ET (EDT): AM-settled SPX of that date has settled at
// the 09:30 open (SOQ); PM-settled SPXW settles at the 16:00 close.
const FRI_10ET = Date.parse("2026-10-09T14:00:00Z");

function contract(sym: string, extra: Record<string, unknown>) {
  return { symbol: sym, ...extra };
}

test("flatten: Schwab -999 placeholders and missing fields are null, a reported 0 stays 0", () => {
  const chain = {
    callExpDateMap: {
      "2026-10-09:0": {
        "6700.0": [contract("SPXW  261009C06700000", { bid: 10, ask: 11, last: 10.5, totalVolume: 0, openInterest: 1200, volatility: -999, gamma: -999, delta: 0.5 })],
      },
    },
    putExpDateMap: {
      "2026-10-09:0": {
        "6700.0": [contract("SPX   261009P06700000", { bid: 9, ask: 10, openInterest: 800, volatility: 15.5, gamma: 0.004, settlementType: "A" })],
      },
    },
  };
  const rows = flattenSchwabChain(chain);
  const c = rows.find((r) => r.side === "C")!;
  const p = rows.find((r) => r.side === "P")!;
  assert.equal(c.iv, null);
  assert.equal(c.gamma, null);
  assert.equal(c.volume, 0);            // observed zero
  assert.equal(p.volume, null);         // not reported
  assert.equal(p.last, null);
  assert.equal(p.iv, 0.155);
  assert.equal(c.occ, "SPXW261009C06700000");
  assert.equal(c.root, "SPXW");
  assert.equal(c.style, "PM");
  assert.equal(p.style, "AM");
  assert.equal(schwabNum("-999.0"), null);
  assert.equal(chainSpot({ underlying: { last: null, bid: 6699, ask: 6701 } }), 6700);
  const t = chainVolumeTotals(chain);
  assert.equal(t.volumeMissing, 1);
  assert.equal(t.callVol, 0);
  assert.equal(t.putOI, 800);
});

test("exposure rows: AM SPX settled at the open is dropped; vendor IV percent -> decimal; missing IV solved from the mid", () => {
  const S = 6700, K = 6750, sigma = 0.16;
  const T = timeToExpiry("2026-10-16", { nowMs: FRI_10ET, style: "PM" }).years;
  const mid = bsPrice(S, K, sigma, T, 0.05, 0, "C");
  const chain = {
    underlying: { last: S },
    callExpDateMap: {
      "2026-10-09:0": {
        "6700.0": [
          contract("SPX   261009C06700000", { openInterest: 500, volatility: 14, settlementType: "A" }),
          contract("SPXW  261009C06700000", { openInterest: 700, volatility: 14, bid: 0, ask: 0 }),
        ],
      },
      "2026-10-16:7": {
        "6750.0": [contract("SPXW  261016C06750000", { openInterest: 300, volatility: -999, bid: mid - 0.05, ask: mid + 0.05 })],
        "6800.0": [contract("SPXW  261016C06800000", { openInterest: 0, volatility: 15 })],
      },
    },
    putExpDateMap: {},
  };
  const { rows, solvedIvCount } = exposureRowsFromSchwabChain(chain, { maxDte: 45, spot: S, r: 0.05, q: 0, nowMs: FRI_10ET });
  // AM SPX of today: settled -> dropped. SPXW today: kept, vendor IV 14% -> 0.14.
  assert.equal(rows.filter((r) => r.dte === 0).length, 1);
  assert.equal(rows.find((r) => r.dte === 0)!.style, "PM");
  assert.ok(Math.abs(rows.find((r) => r.dte === 0)!.iv - 0.14) < 1e-12);
  // Missing vendor IV: Black-Scholes IV solved from the quote mid recovers 16%.
  const solved = rows.find((r) => r.strike === 6750)!;
  assert.equal(solvedIvCount, 1);
  assert.ok(Math.abs(solved.iv - sigma) < 1e-4, String(solved.iv));
  // OI 0 carries no exposure weight.
  assert.equal(rows.some((r) => r.strike === 6800), false);
});

test("Signals gamma structure from a Schwab SPY chain: GEX = gamma x OI x 100 x S^2 x 1%, calls +, puts -", () => {
  const S = 670;
  const chain = {
    underlying: { last: S },
    callExpDateMap: {
      "2026-10-16:7": {
        "680.0": [contract("SPY   261016C00680000", { openInterest: 10_000, gamma: 0.02, volatility: 15, totalVolume: 5000 })],
      },
    },
    putExpDateMap: {
      "2026-10-16:7": {
        "660.0": [contract("SPY   261016P00660000", { openInterest: 20_000, gamma: 0.015, volatility: 18, totalVolume: 8000 })],
        "650.0": [contract("SPY   261016P00650000", { openInterest: 5_000, gamma: -999, volatility: 19 })],
      },
      "2026-10-09:0": {
        "665.0": [contract("SPY   261009P00665000", { openInterest: 9_000, gamma: 0.05, volatility: 20 })],
      },
    },
  };
  // After Friday's close the 2026-10-09 PM expiry has settled and is dropped.
  const afterClose = Date.parse("2026-10-09T20:30:00Z");
  const g = buildGammaStructure(chain, afterClose);
  // Hand computation (dollars per 1% move):
  //   call 680: 0.02 x 10,000 x 100 x 670^2 x 0.01 = 89,780,000
  //   put 660: -0.015 x 20,000 x 100 x 670^2 x 0.01 = -134,670,000
  //   put 650: gamma -999 (missing) -> excluded, not zero
  //   put 665 (0DTE, settled at 16:00) -> excluded
  const callG = 0.02 * 10_000 * 100 * S * S * 0.01;
  const putG = -0.015 * 20_000 * 100 * S * S * 0.01;
  assert.equal(callG, 89_780_000);
  assert.equal(putG, -134_670_000);
  assert.ok(Math.abs(g.totalGex - (callG + putG)) < 1e-6);
  assert.equal(g.callWall, 680);
  assert.equal(g.putWall, 660);
  assert.equal(g.spot, S);
  assert.deepEqual(g.profile.map((p) => p.strike), [660, 680]);
  assert.equal(g.pcrOi, 2);              // 20,000 / 10,000
  assert.throws(() => buildGammaStructure({ underlying: { last: null }, callExpDateMap: {}, putExpDateMap: {} }), /no underlying price/);
});

// ---------------------------------------------------------------------------
// 7. Review fixes (R2-G): strikeCount step, delayed chains, models fallback age
// ---------------------------------------------------------------------------

test("strikeCount: rounded up to a step of 20, so small spot/IV moves keep one cache key", () => {
  const a = chainStrikePlan({ symbol: "$SPX", spot: 6700, dteMax: 0, atmIv: 0.18 });
  const b = chainStrikePlan({ symbol: "$SPX", spot: 6712, dteMax: 0, atmIv: 0.19 });
  assert.equal(a.strikeCount % STRIKE_COUNT_STEP, 0);
  assert.equal(a.strikeCount, b.strikeCount);           // 268 and 270 both -> 280
  assert.ok(a.strikeCount >= 2 * a.perSide);            // rounding never shrinks coverage
});

test("delayed chain: Schwab isDelayed=true (or underlying.delayed) is flagged; absent/false is not", () => {
  assert.equal(chainIsDelayed({ isDelayed: true }), true);
  assert.equal(chainIsDelayed({ isDelayed: false, underlying: { delayed: true } }), true);
  assert.equal(chainIsDelayed({ isDelayed: false, underlying: { delayed: false } }), false);
  assert.equal(chainIsDelayed({}), false);
  assert.equal(chainIsDelayed(null), false);
  assert.equal(chainIsDelayed({ isDelayed: "true" as unknown as boolean }), false); // only a real boolean true
});

test("models fallback: in the session a stored build is served only within the chain max age, flagged stale", () => {
  // 2026-10-07 11:00 ET (session open). Copy written 10:58, chain 10:57:30.
  const savedAtMs = RTH - 120_000, close = Date.parse("2026-10-07T20:00:00Z");
  const ok = modelsFallbackDecision({ savedAtMs, sessionCloseMs: close, chainAsOfMs: RTH - 150_000, nowMs: RTH });
  assert.equal(ok.serve, true);
  assert.equal(ok.label, "stale");
  assert.equal(ok.ageMs, 150_000);
  const old = modelsFallbackDecision({ savedAtMs, sessionCloseMs: close, chainAsOfMs: RTH - 181_000, nowMs: RTH });
  assert.equal(old.serve, false);                         // -> 503, never a 30-min-old chain as current
});

test("models fallback: 'last-close' only for a copy built at or after the session close, served outside the session", () => {
  const close = Date.parse("2026-10-07T20:00:00Z");      // 16:00 ET
  const after = modelsFallbackDecision({ savedAtMs: close + 60_000, sessionCloseMs: close, chainAsOfMs: close + 30_000, nowMs: CLOSED });
  assert.equal(after.serve, true);
  assert.equal(after.label, "last-close");
  // Built at 14:00 ET, now 19:00 ET: not a closing copy and 5 h old -> unavailable.
  const intraday = modelsFallbackDecision({ savedAtMs: close - 2 * 3600_000, sessionCloseMs: close, chainAsOfMs: close - 2 * 3600_000, nowMs: CLOSED });
  assert.equal(intraday.serve, false);
  assert.equal(intraday.label, null);
  // Oldest chain across horizons drives the age.
  assert.equal(oldestChainAsOf({ daily: { chainAsOfMs: 5 }, weekly: { chainAsOfMs: 3 }, monthly: null }), 3);
  assert.equal(oldestChainAsOf({ daily: {} }), null);
});
