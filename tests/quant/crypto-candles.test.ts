// The 1-minute tape as measurements: parse, launch high, first dip, reclaim,
// wicks, volume trend. Recorded with the signal; no rule reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { candleFeatures, parseGtOhlcv, unavailableCandles, CANDLES_MIN, RECLAIM_SHARE, type Candle } from "../../shared/cryptoCandles";

const M = 60_000;
const mk = (i: number, o: number, h: number, l: number, c: number, v = 100): Candle => ({ t: i * M, o, h, l, c, v });

test("parseGtOhlcv: newest-first rows become oldest-first candles; bad rows dropped; seconds become ms", () => {
  const cs = parseGtOhlcv([[120, 1, 1.2, 0.9, 1.1, 50], [60, 0.9, 1.0, 0.8, 1.0, 40], ["x", 1, 1, 1, 1, 1], [30, 1, 0.5, 0.9, 1, 1], [0, 1, 1, 1, 1, 1]]);
  assert.deepEqual(cs.map((c) => c.t), [60_000, 120_000]);
  assert.equal(cs[1].c, 1.1);
  assert.deepEqual(parseGtOhlcv(null), []);
  assert.deepEqual(parseGtOhlcv("nope"), []);
});

test("insufficient and unavailable are states, never numbers", () => {
  const u = unavailableCandles("not read yet");
  assert.equal(u.state, "unavailable"); assert.equal(u.firstDipPct, null); assert.match(u.text, /not read yet/);
  const few = candleFeatures([mk(0, 1, 1, 1, 1), mk(1, 1, 1, 1, 1)], 10 * M);
  assert.equal(few.state, "insufficient"); assert.equal(few.candles, 2); assert.match(few.text, new RegExp(`${CANDLES_MIN} needed`));
  assert.equal(few.reclaimShare, null);
  // Candles from the future are not read.
  assert.equal(candleFeatures([mk(50, 1, 1, 1, 1)], 10 * M).state, "unavailable");
});

test("launch high, first dip, reclaim and its timing", () => {
  // Rally to a high at minute 3, dip to -40% by minute 6, reclaim 90% of the high at minute 9.
  const cs: Candle[] = [
    mk(0, 1.0, 1.1, 0.95, 1.05), mk(1, 1.05, 1.4, 1.0, 1.35), mk(2, 1.35, 1.8, 1.3, 1.75), mk(3, 1.75, 2.0, 1.7, 1.9),
    mk(4, 1.9, 1.92, 1.5, 1.55), mk(5, 1.55, 1.6, 1.3, 1.35), mk(6, 1.35, 1.4, 1.2, 1.3),
    mk(7, 1.3, 1.6, 1.28, 1.55), mk(8, 1.55, 1.75, 1.5, 1.7), mk(9, 1.7, 1.85, 1.65, 1.82), mk(10, 1.82, 1.9, 1.8, 1.85),
  ];
  const f = candleFeatures(cs, 11 * M);
  assert.equal(f.state, "ok"); assert.equal(f.candles, 11);
  assert.equal(f.launchHigh, 2.0); assert.equal(f.minutesSinceHigh, 8);
  assert.equal(f.firstDipPct, -40); assert.equal(f.minutesHighToLow, 3);
  assert.equal(f.reclaimShare, 0.93); assert.equal(f.reclaimed, true);
  assert.equal(f.minutesToReclaim, 3, "first close at or above 90% of the high is minute 9, three minutes after the low");
  assert.match(f.text, /first dip -40% in 3 min, 90% of the high reclaimed in 3 min/);
  assert.ok(RECLAIM_SHARE === 0.9);
});

test("no dip when the high is the latest candle; not reclaimed reads as such; wick shares and volume trend", () => {
  const up: Candle[] = Array.from({ length: 12 }, (_, i) => mk(i, 1 + i * 0.1, 1.1 + i * 0.1, 0.95 + i * 0.1, 1.08 + i * 0.1, i < 7 ? 100 : 300));
  const f = candleFeatures(up, 13 * M);
  assert.equal(f.firstDipPct, null); assert.equal(f.minutesHighToLow, null); assert.match(f.text, /no dip since the high/);
  assert.equal(f.volumeTrend, 3, "last 5 candles at 300 vs the 5 before at 100");
  assert.equal(f.upCloseShare, 1);
  // Each candle: range 0.15, upper wick 0.02, lower wick 0.05.
  assert.ok(Math.abs(f.upperWickShare! - 0.13) < 0.011 && Math.abs(f.lowerWickShare! - 0.33) < 0.011, JSON.stringify([f.upperWickShare, f.lowerWickShare]));
  const dead: Candle[] = [mk(0, 1, 2, 1, 1.9), ...Array.from({ length: 11 }, (_, i) => mk(i + 1, 0.5, 0.55, 0.45, 0.5, 0))];
  const d = candleFeatures(dead, 13 * M);
  assert.equal(d.reclaimed, false); assert.equal(d.minutesToReclaim, null); assert.match(d.text, /not reclaimed \(25% of the high now\)/);
  assert.equal(d.volumeTrend, null, "no prior volume: no ratio");
});

test("wiring: candles engine reads ENTER/WATCH pairs within budget, records features with the signal, moves no verdict", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /const CANDLE_BATCH = 8;\s*const CANDLE_REFRESH_MS = 5 \* 60_000;/);
  assert.match(e, /\.filter\(\(c\) => c\.chain === "solana" && \(c\.verdict === "ENTER" \|\| c\.verdict === "WATCH"\)\)/);
  assert.match(e, /ohlcv\/minute\?aggregate=1&limit=\$\{CANDLE_LIMIT\}&currency=usd/);
  assert.match(e, /candles: c\.candlesReadAt == null \? null : candleFeatures\(c\.candles, Date\.now\(\)\),/, "recorded on the signal row");
  assert.match(e, /arm\("candles", CANDLES_MS, candlesTick, 50_000\);/);
  // No rule reads the candles: the scorer, verdict and exit plan never reference them.
  const scorer = e.slice(e.indexOf("function scoreCandidate"), e.indexOf("function scoreCandidate") + 8000);
  assert.doesNotMatch(scorer, /candles|candleFeatures/);
  const rules = readFileSync(new URL("../../shared/cryptoRules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rules, /candle/i, "the rule book has no candle threshold (none has earned one)");
  const panel = readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /recorded with the signal, no rule reads it yet/);
});
