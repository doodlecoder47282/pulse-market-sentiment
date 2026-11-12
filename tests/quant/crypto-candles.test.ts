// The 1-minute tape as measurements: parse, window high, first dip vs deepest
// low, reclaim timing, wicks, volume trend, stale state, first-row back-fill.
// Recorded with the signal; no rule reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { candleFeatures, parseGtOhlcv, unavailableCandles, CANDLES_MIN, RECLAIM_SHARE, TAPE_STALE_MINUTES, type Candle } from "../../shared/cryptoCandles";

const M = 60_000;
const mk = (i: number, o: number, h: number, l: number, c: number, v = 100): Candle => ({ t: i * M, o, h, l, c, v });

test("parseGtOhlcv: newest-first rows become oldest-first candles; bad rows dropped; seconds become ms", () => {
  const cs = parseGtOhlcv([[120, 1, 1.2, 0.9, 1.1, 50], [60, 0.9, 1.0, 0.8, 1.0, 40], ["x", 1, 1, 1, 1, 1], [30, 1, 0.5, 0.9, 1, 1], [0, 1, 1, 1, 1, 1]]);
  assert.deepEqual(cs.map((c) => c.t), [60_000, 120_000]);
  assert.equal(cs[1].c, 1.1);
  assert.deepEqual(parseGtOhlcv(null), []);
  assert.deepEqual(parseGtOhlcv("nope"), []);
});

test("insufficient, unavailable and stale are states, never fresh numbers", () => {
  const u = unavailableCandles("not read yet");
  assert.equal(u.state, "unavailable"); assert.equal(u.firstDipPct, null); assert.match(u.text, /not read yet/);
  const few = candleFeatures([mk(0, 1, 1, 1, 1), mk(1, 1, 1, 1, 1)], 10 * M, { readAt: 9 * M });
  assert.equal(few.state, "insufficient"); assert.equal(few.candles, 2); assert.match(few.text, new RegExp(`${CANDLES_MIN} needed`));
  assert.equal(few.reclaimShare, null); assert.equal(few.readAt, 9 * M); assert.equal(few.tapeAgeMinutes, 9);
  assert.equal(candleFeatures([mk(50, 1, 1, 1, 1)], 10 * M).state, "unavailable", "candles from the future are not read");
  // A tape whose last candle is 31 min old, or whose latest read failed, is stale and says so; the numbers are from the last good read.
  const twelve = Array.from({ length: 12 }, (_, i) => mk(i, 1, 1.1, 0.9, 1.05));
  const old = candleFeatures(twelve, 42 * M, { readAt: 12 * M });
  assert.equal(old.state, "stale"); assert.equal(old.tapeAgeMinutes, 31); assert.ok(31 > TAPE_STALE_MINUTES);
  assert.match(old.text, /STALE: last candle 31 min old; numbers are from the last good read; high \d+ min ago/);
  const failed = candleFeatures(twelve, 13 * M, { readAt: 12 * M, error: "429 https://api.geckoterminal.com" });
  assert.equal(failed.state, "stale"); assert.match(failed.text, /latest read failed \(429/);
  assert.equal(candleFeatures(twelve, 13 * M, { readAt: 12 * M }).state, "ok");
});

test("window high, FIRST dip vs deepest low, reclaim measured from the first dip", () => {
  // Rally to a high at minute 3, dip to -40% by minute 6, reclaim 90% of the high at minute 9.
  const cs: Candle[] = [
    mk(0, 1.0, 1.1, 0.95, 1.05), mk(1, 1.05, 1.4, 1.0, 1.35), mk(2, 1.35, 1.8, 1.3, 1.75), mk(3, 1.75, 2.0, 1.7, 1.9),
    mk(4, 1.9, 1.92, 1.5, 1.55), mk(5, 1.55, 1.6, 1.3, 1.35), mk(6, 1.35, 1.4, 1.2, 1.3),
    mk(7, 1.3, 1.6, 1.28, 1.55), mk(8, 1.55, 1.75, 1.5, 1.7), mk(9, 1.7, 1.85, 1.65, 1.82), mk(10, 1.82, 1.9, 1.8, 1.85),
  ];
  const f = candleFeatures(cs, 11 * M, { readAt: 11 * M });
  assert.equal(f.state, "ok"); assert.equal(f.candles, 11);
  assert.equal(f.windowHigh, 2.0); assert.equal(f.minutesSinceHigh, 8);
  assert.equal(f.firstDipPct, -40); assert.equal(f.minutesHighToFirstDip, 3);
  assert.equal(f.maxDrawdownPct, -40); assert.equal(f.minutesHighToDeepestLow, 3, "one leg down: first dip and deepest low coincide");
  assert.equal(f.reclaimShare, 0.93); assert.equal(f.reclaimed, true);
  assert.equal(f.minutesToReclaim, 3, "first close at or above 90% of the high is minute 9, three minutes after the first dip");
  assert.match(f.text, /first dip -40% at 3 min after the high, 90% of the high reclaimed 3 min after the first dip/);
  assert.ok(RECLAIM_SHARE === 0.9);
  // Two legs: dip -50% at minute 1, reclaim at minute 2, crash to -75% at minute 8. The first dip is the first dip; the crash is the drawdown.
  const two: Candle[] = [mk(0, 1, 2, 0.9, 1.9), mk(1, 1.9, 1.95, 1.0, 1.1), mk(2, 1.1, 1.9, 1.05, 1.85), mk(3, 1.85, 1.9, 1.7, 1.8), mk(4, 1.8, 1.85, 1.6, 1.7),
    mk(5, 1.7, 1.75, 1.4, 1.5), mk(6, 1.5, 1.55, 1.1, 1.2), mk(7, 1.2, 1.3, 0.8, 0.9), mk(8, 0.9, 0.95, 0.5, 0.6), mk(9, 0.6, 0.7, 0.55, 0.65), mk(10, 0.65, 0.7, 0.6, 0.68)];
  const g = candleFeatures(two, 11 * M, { readAt: 11 * M });
  assert.equal(g.firstDipPct, -50); assert.equal(g.minutesHighToFirstDip, 1);
  assert.equal(g.maxDrawdownPct, -75); assert.equal(g.minutesHighToDeepestLow, 8);
  assert.equal(g.minutesToReclaim, 1, "the first dip WAS reclaimed, a minute later");
  assert.equal(g.reclaimed, false, "but the latest close is far below the high");
  assert.match(g.text, /first dip -50% at 1 min after the high, deepest -75% at 8 min, 90% of the high reclaimed 1 min after the first dip/);
});

test("no dip when the high is the latest candle; not reclaimed reads as such; wick shares and volume trend in candles, not minutes", () => {
  const up: Candle[] = Array.from({ length: 12 }, (_, i) => mk(i, 1 + i * 0.1, 1.1 + i * 0.1, 0.95 + i * 0.1, 1.08 + i * 0.1, i < 7 ? 100 : 300));
  const f = candleFeatures(up, 13 * M, { readAt: 13 * M });
  assert.equal(f.firstDipPct, null); assert.equal(f.maxDrawdownPct, null); assert.match(f.text, /no dip since the high/);
  assert.equal(f.volumeTrend, 3, "last 5 candles at 300 vs the 5 before at 100");
  assert.match(f.text, /volume 3x the prior 5 candles/);
  assert.equal(f.upCloseShare, 1);
  assert.ok(Math.abs(f.upperWickShare! - 0.13) < 0.011 && Math.abs(f.lowerWickShare! - 0.33) < 0.011, JSON.stringify([f.upperWickShare, f.lowerWickShare]));
  // Candles every 4 minutes (GT skips quiet intervals): the span says so and the window copy counts candles.
  const sparse: Candle[] = Array.from({ length: 10 }, (_, i) => mk(i * 4, 1, 1.1, 0.9, 1.05));
  const sp = candleFeatures(sparse, 37 * M, { readAt: 37 * M });
  assert.equal(sp.spanMinutes, 37); assert.match(sp.text, /10 traded minutes over 37 min/);
  const dead: Candle[] = [mk(0, 1, 2, 1, 1.9), ...Array.from({ length: 11 }, (_, i) => mk(i + 1, 0.5, 0.55, 0.45, 0.5, 0))];
  const d = candleFeatures(dead, 13 * M, { readAt: 13 * M });
  assert.equal(d.reclaimed, false); assert.equal(d.minutesToReclaim, null); assert.match(d.text, /not reclaimed \(25% of the high at the last close\)/);
  assert.equal(d.volumeTrend, null, "no prior volume: no ratio");
  const flat: Candle[] = Array.from({ length: 10 }, (_, i) => mk(i, 1, 1, 1, 1));
  assert.equal(candleFeatures(flat, 11 * M).upperWickShare, null, "zero range: no wick share");
});

test("back-fill SQL: the pair's FIRST ENTER/WATCH row gets the tape once, later rows and rows that already have one are untouched", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  const sql = /const CANDLE_BACKFILL_SQL = `([\s\S]*?)`;/.exec(e)![1];
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE crypto_signals (id TEXT PRIMARY KEY, detected_at INTEGER, chain TEXT, pair_address TEXT, verdict TEXT, features_json TEXT)`);
  const ins = db.prepare(`INSERT INTO crypto_signals VALUES (?, ?, 'solana', 'P1', ?, ?)`);
  ins.run("a", 100, "WATCH", JSON.stringify({ score: 70, candles: null }));
  ins.run("b", 200, "ENTER", JSON.stringify({ score: 80, candles: null }));
  ins.run("c", 50, "PASS", JSON.stringify({ score: 10, candles: null }));
  const st = db.prepare(sql);
  const feats = JSON.stringify({ state: "ok", candles: 12, backfilled: true, minutesAfterSignal: 4 });
  assert.equal(Number(st.run({ candles: feats, chain: "solana", pair: "P1" }).changes), 1);
  const get = (id: string) => JSON.parse((db.prepare(`SELECT features_json FROM crypto_signals WHERE id = ?`).get(id) as any).features_json);
  assert.deepEqual(get("a").candles, JSON.parse(feats), "the first ENTER/WATCH row, not the PASS row before it");
  assert.equal(get("b").candles, null); assert.equal(get("a").score, 70, "other features kept");
  assert.equal(Number(st.run({ candles: JSON.stringify({ state: "ok", candles: 99 }), chain: "solana", pair: "P1" }).changes), 0, "a readable tape is never overwritten");
  // A row holding only an insufficient tape (a young pool's first read) is replaced by the first readable one.
  ins.run("d", 300, "WATCH", JSON.stringify({ candles: { state: "insufficient", candles: 3 } }));
  const st2 = db.prepare(sql.replace("@pair", "'P2'").replace("@chain", "'solana'"));
  db.prepare(`UPDATE crypto_signals SET pair_address = 'P2' WHERE id = 'd'`).run();
  assert.equal(Number(st2.run({ candles: feats }).changes), 1);
  assert.equal(get("d").candles.candles, 12);
  assert.equal(Number(st2.run({ candles: JSON.stringify({ state: "ok", candles: 99 }) }).changes), 0);
  db.close();
});

test("wiring: candles engine reads ENTER/WATCH pairs within budget, gates on the attempt, backs off on 429, records with the signal, moves no verdict", () => {
  const e = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(e, /const CANDLE_BATCH = 8;\s*const CANDLE_REFRESH_MS = 5 \* 60_000;/);
  assert.match(e, /\.filter\(\(c\) => c\.chain === "solana" && \(c\.verdict === "ENTER" \|\| c\.verdict === "WATCH"\)\)/);
  assert.match(e, /\.filter\(\(c\) => c\.candlesAttemptAt == null \|\| now - c\.candlesAttemptAt > CANDLE_REFRESH_MS\)/, "a failing pair does not hold a slot every tick");
  assert.match(e, /c\.candlesAttemptAt = Date\.now\(\);\s*try \{/);
  assert.match(e, /if \(\/\^429\\b\/\.test\(msg\)\) break;/, "rate-limited: the rest of the tick is skipped");
  assert.match(e, /ohlcv\/minute\?aggregate=1&limit=\$\{CANDLE_LIMIT\}&currency=usd/);
  assert.match(e, /candles: c\.candlesReadAt == null \? null : candleFeatures\(c\.candles, Date\.now\(\), \{ readAt: c\.candlesReadAt, error: c\.candlesError \}\),/, "recorded on the signal row with its read time and any failure");
  assert.match(e, /if \(!c\.candlesBackfilled\) \{\s*const feats = candleFeatures\(c\.candles, c\.candlesReadAt, \{ readAt: c\.candlesReadAt \}\);\s*if \(feats\.state === "ok" \|\| feats\.state === "stale"\) \{ backfillFirstSignalCandles\(c, feats\); c\.candlesBackfilled = true; \}/, "back-fill waits for a readable tape and happens once");
  assert.match(e, /arm\("candles", CANDLES_MS, candlesTick, 50_000\);/);
  // No rule reads the candles: the whole scorer up to the structure assignment never references them.
  const start = e.indexOf("function scoreCandidate"); const end = e.indexOf("c.structure = {", start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(e.slice(start, end), /candles|candleFeatures/);
  const rules = readFileSync(new URL("../../shared/cryptoRules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rules, /candle/i, "the rule book has no candle threshold (none has earned one)");
  const panel = readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /high = highest high in the candles read, dip = first local low after it, reclaim = latest close against that high; a candle is a traded minute; recorded with the signal, no rule reads it yet/);
  assert.match(panel, /c\.structure\.candles\.state === "stale" \? "text-amber-300\/90"/);
});
