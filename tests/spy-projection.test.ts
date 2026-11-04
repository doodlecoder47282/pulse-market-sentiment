import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildSpyProjectionResponse, createSpyProjectionService } from "../server/spyProjection";
import { buildSpyFeatureRun, persistSpyFeatureRun } from "../server/spyFeaturePipeline";
import { SpyProjectionResponseSchema } from "../shared/spyProjection";
import { SpyFeaturesSchema, parseSpyHours, normalizeSpyInputs, calculateSpyFeatures, replaySpyFeatureRows,
  shiftSpyDate, type SpyRawInputs } from "../shared/spyFeatures";
import { etEpochMs } from "../server/etTime";

function hours(date: string, close = 16, isOpen = true) {
  return { equity: { EQ: { date, product: "EQ", marketType: "EQUITY", isOpen,
    sessionHours: { regularMarket: isOpen ? [{ start: new Date(etEpochMs(date, 9, 30)).toISOString(),
      end: new Date(etEpochMs(date, close, 0)).toISOString() }] : [] } } } };
}
function fixture(date = "2026-09-30", prior = "2026-09-29", minutes = 61): SpyRawInputs {
  const open = etEpochMs(date, 9, 30), now = open + minutes * 60000 + 15000;
  const h: Record<string, unknown> = { [date]: hours(date), [prior]: hours(prior) };
  for (let d = shiftSpyDate(date, -1); d > prior; d = shiftSpyDate(d, -1)) h[d] = hours(d, 16, false);
  return {
    receivedAt: now, hours: h,
    quote: { SPY: { symbol: "SPY", assetMainType: "EQUITY", realtime: true,
      quote: { lastPrice: 100 + minutes / 10, tradeTime: now - 1000 } } },
    dailyHistory: { symbol: "SPY", previousClose: 1, previousCloseDate: 0,
      candles: [{ datetime: etEpochMs(prior, 0, 0), open: 98, high: 100, low: 97, close: 99, volume: 1000 }] },
    minuteHistory: { symbol: "SPY", candles: Array.from({ length: minutes + 1 }, (_, i) => ({
      datetime: open + i * 60000, open: 100 + i / 10, close: 100 + (i + 1) / 10,
      high: 100.3 + i / 10, low: 99.8 + i / 10, volume: i === 0 ? 0 : 100,
    })) },
  };
}
const val = (f: ReturnType<typeof calculateSpyFeatures>, id: string) => f.values.find(v => v.id === id)!.value;
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-10, `${a} != ${b}`);
test("SPY real 1m normalization, dated prior close, analytic returns, volatility and ATR", () => {
  const raw = fixture(), run = buildSpyFeatureRun(raw, raw.receivedAt), f = run.features;
  assert.equal(f.status, "READY"); assert.equal(run.input!.bars.length, 61);
  assert.equal(f.priorCloseDate, "2026-09-29");
  near(val(f, "prior_session_close_usd"), 99); // not previousClose=1 or penultimate minute
  near(val(f, "session_gap_fraction"), 100 / 99 - 1);
  near(val(f, "spy_close_usd"), 106.1); near(val(f, "atr14_1m_usd"), .5);
  near(val(f, "log_return_5m"), Math.log(106.1 / 105.6));
  const rets = Array.from({ length: 5 }, (_, i) => Math.log((105.7 + i / 10) / (105.6 + i / 10)));
  near(val(f, "realized_vol_5m"), Math.sqrt(rets.reduce((s, x) => s + x * x, 0)));
  assert.ok(val(f, "realized_vol_5m")! > 0); // never one-return sample stdev=0
  near(val(f, "minutes_since_anchor"), 46);
});
test("one shared live/replay function; prefix invariance and frozen anchor prevent future leakage", () => {
  const raw = fixture(), full = normalizeSpyInputs(raw, raw.receivedAt).input!;
  const rows = replaySpyFeatureRows(full), prefix = { ...full, asOf: full.open + 31 * 60000, bars: full.bars.slice(0, 31) };
  assert.deepEqual(rows[30].values, calculateSpyFeatures(prefix).values);
  const changed = structuredClone(full);
  for (const b of changed.bars.slice(31)) { b.high += 100; b.close += 50; }
  assert.deepEqual(calculateSpyFeatures(changed, prefix.asOf).values, rows[30].values);
  for (const key of ["morning_high_usd", "morning_low_usd", "morning_anchor_close_usd", "morning_range_atr14", "morning_drive_atr14"])
    assert.equal(val(rows[14], key), val(rows.at(-1)!, key));
  assert.equal(calculateSpyFeatures(full, full.asOf + 60000).status, "BLOCKED");
});
test("warmups, missing volume, zero volume and absent prior close remain null", () => {
  const raw = fixture("2026-09-30", "2026-09-29", 5);
  let f = buildSpyFeatureRun(raw, raw.receivedAt).features;
  assert.equal(f.status, "PARTIAL"); assert.equal(val(f, "realized_vol_5m"), null);
  assert.equal(val(f, "atr14_1m_usd"), null); assert.equal(val(f, "morning_anchor_close_usd"), null);
  const all = fixture(); (all.dailyHistory as any).candles = [];
  (all.minuteHistory as any).candles[3].volume = null;
  f = buildSpyFeatureRun(all, all.receivedAt).features;
  assert.equal(val(f, "prior_session_close_usd"), null); assert.equal(val(f, "session_gap_fraction"), null);
  assert.equal(val(f, "session_hlc3_vwap_usd"), null);
  (all.minuteHistory as any).candles.forEach((b: any) => b.volume = 0);
  assert.equal(val(buildSpyFeatureRun(all, all.receivedAt).features, "session_hlc3_vwap_usd"), null);
});
test("volume-weighted HLC3 is not an unweighted mean, and zero ATR is not an invented floor", () => {
  const raw = fixture(); const input = normalizeSpyInputs(raw, raw.receivedAt).input!;
  const total = input.bars.reduce((s, b) => s + b.volume!, 0);
  near(val(calculateSpyFeatures(input), "session_hlc3_vwap_usd"),
    input.bars.reduce((s, b) => s + (b.high + b.low + b.close) / 3 * b.volume!, 0) / total);
  input.bars.forEach(b => { b.open = b.high = b.low = b.close = 100; });
  const f = calculateSpyFeatures(input);
  assert.equal(val(f, "atr14_1m_usd"), 0); assert.equal(val(f, "realized_vol_5m"), 0);
  assert.equal(val(f, "morning_range_atr14"), null);
});
test("weekends, holidays, early closes and DST use provider dates, not weekday guesses", () => {
  for (const [date, prior] of [["2026-03-09", "2026-03-06"], ["2026-11-02", "2026-10-30"], ["2026-09-08", "2026-09-04"]]) {
    const raw = fixture(date, prior);
    assert.equal(buildSpyFeatureRun(raw, raw.receivedAt).features.priorCloseDate, prior);
    delete raw.hours[shiftSpyDate(date, -1)];
    assert.equal(val(buildSpyFeatureRun(raw, raw.receivedAt).features, "prior_session_close_usd"), null);
  }
  const raw = fixture("2026-11-27", "2026-11-25");
  raw.hours["2026-11-27"] = hours("2026-11-27", 13);
  assert.equal(parseSpyHours(raw.hours["2026-11-27"], "2026-11-27")!.close, etEpochMs("2026-11-27", 13, 0));
  assert.equal(normalizeSpyInputs(raw, etEpochMs("2026-11-27", 13, 0)).outsideSession, true);
  raw.hours["2026-11-27"] = hours("2026-11-27", 16, false);
  assert.equal(normalizeSpyInputs(raw, raw.receivedAt).outsideSession, true);
});
test("wrong identities, delayed/stale/future/synthetic and malformed quotes fail closed", () => {
  const mutations = [
    (r: any) => r.quote.SPY.symbol = "$SPX", (r: any) => r.quote.SPY.realtime = false,
    (r: any) => r.quote.SPY.currency = "EUR", (r: any) => r.quote.SPY.quote.synthetic = true,
    (r: any) => r.quote.SPY.quote.lastPrice = 0, (r: any) => r.quote.SPY.quote.lastPrice = Infinity,
    (r: any) => r.quote.SPY.quote.tradeTime = r.receivedAt + 1,
    (r: any) => r.quote.SPY.quote.tradeTime = r.receivedAt - 60000,
    (r: any) => r.hours = {},
  ];
  for (const mutate of mutations) {
    const r = fixture(); mutate(r);
    const result = buildSpyProjectionResponse(r, r.receivedAt);
    assert.equal(result.features.status, "BLOCKED"); assert.equal(result.tape.lastTrade, null);
  }
});
test("gaps, duplicates, off-grid, future and invalid candles cannot create a usable feature row", () => {
  for (const change of [
    (r: any) => r.minuteHistory.symbol = "SPX",
    (r: any) => r.minuteHistory.synthetic = true,
    (r: any) => r.minuteHistory.candles.splice(2, 1),
    (r: any) => r.minuteHistory.candles.push(r.minuteHistory.candles[0]),
    (r: any) => r.minuteHistory.candles[2].datetime += 1000,
    (r: any) => r.minuteHistory.candles[2].datetime = r.receivedAt + 1,
    (r: any) => r.minuteHistory.candles[2].low = 9999,
    (r: any) => r.minuteHistory.candles[2].volume = -1,
    (r: any) => r.minuteHistory.candles[2].close = NaN,
    (r: any) => r.minuteHistory.candles = r.minuteHistory.candles.slice(0, -2),
  ]) { const raw = fixture(); change(raw); assert.equal(buildSpyFeatureRun(raw, raw.receivedAt).features.status, "BLOCKED"); }
});
test("five-minute display is aggregated from same input; READY never restores projection", () => {
  const raw = fixture(), r = buildSpyProjectionResponse(raw, raw.receivedAt);
  assert.equal(r.features.status, "READY"); assert.equal(r.tape.candles.length, 12);
  assert.equal(r.tape.candles[0].v, 400); near(r.tape.candles[0].c, 100.5);
  assert.equal(r.tape.sessionCalendarVerified, true);
  assert.equal(r.status, "UNAVAILABLE"); assert.equal(r.projection.bands, null); assert.equal(r.levels, null);
  assert.equal(r.predictionValidation, "not_established");
  assert.equal(SpyProjectionResponseSchema.safeParse({ ...r, features: undefined }).success, false);
  assert.equal(SpyProjectionResponseSchema.safeParse({ ...r, synthetic: true }).success, false);
  assert.equal(SpyProjectionResponseSchema.safeParse({ ...r, projection: { status: "TRAINED", bands: {} } }).success, false);
});
test("hash ignores receipt-only changes but preserves corrected inputs; no network/model in core", () => {
  const raw = fixture(), a = buildSpyFeatureRun(raw, raw.receivedAt);
  raw.receivedAt += 1000; const b = buildSpyFeatureRun(raw, raw.receivedAt);
  assert.equal(a.features.inputHash, b.features.inputHash);
  (raw.minuteHistory as any).candles[10].volume++;
  assert.notEqual(buildSpyFeatureRun(raw, raw.receivedAt).features.inputHash, a.features.inputHash);
  const core = readFileSync(new URL("../shared/spyFeatures.ts", import.meta.url), "utf8");
  assert.equal(/\bfetch\s*\(|Date\.now\s*\(|Math\.random\s*\(/.test(core), false);
});
test("single-flight caching, expiry and bounded provider slots survive timeout and failure", async () => {
  const raw = fixture(); let clock = raw.receivedAt, calls = 0;
  const s = createSpyProjectionService({ now: () => clock, read: async () => { calls++; return raw; } });
  const [a, b] = await Promise.all([s.get(), s.get()]);
  assert.equal(a, b); assert.equal(calls, 1);
  clock += 31000; await s.get(); assert.equal(calls, 2);
  clock += 61000; assert.equal((await s.get()).features.status, "BLOCKED");
  calls = 0;
  const t = createSpyProjectionService({ now: () => clock, timeoutMs: 5, read: () => { calls++; return new Promise(() => {}); } });
  assert.equal((await t.get()).features.status, "BLOCKED"); clock += 31000; await t.get(); assert.equal(calls, 1);
  const bad = createSpyProjectionService({ read: async () => { throw new Error("SECRET_TOKEN"); } });
  assert.equal(JSON.stringify(await bad.get()).includes("SECRET_TOKEN"), false);
});
test("SPY route remains singular with no model bridge or legacy SPX dependency", () => {
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  assert.equal((routes.match(/app\.get\("\/api\/ml\/projection-spy"/g) ?? []).length, 1);
  assert.ok(routes.includes('app.get("/api/ml/projection-spy", spyProjectionRoute)'));
  assert.equal(routes.includes("Schwab intraday tape unavailable; deterministic GBM walk"), false);
  for (const f of ["../server/spyProjection.ts", "../server/spyFeaturePipeline.ts"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.equal(/mlGreekFeatures|mlMorningFingerprint|predictQuantile|fetchOHLC/.test(text), false);
  }
});
test("additive local archive deduplicates, retains corrected bars and reproduces exact stored features", () => {
  const db = new Database(":memory:");
  try {
    const raw = fixture(), a = buildSpyFeatureRun(raw, raw.receivedAt);
    persistSpyFeatureRun(a, db); assert.equal(a.features.archived, true);
    persistSpyFeatureRun(buildSpyFeatureRun(raw, raw.receivedAt), db);
    assert.equal((db.prepare("SELECT count(*) n FROM spy_real_feature_snapshots").get() as any).n, 1);
    (raw.minuteHistory as any).candles[10].volume++;
    persistSpyFeatureRun(buildSpyFeatureRun(raw, raw.receivedAt), db);
    assert.equal((db.prepare("SELECT count(*) n FROM spy_real_feature_snapshots").get() as any).n, 2);
    const row = db.prepare("SELECT input_json,features_json FROM spy_real_feature_snapshots LIMIT 1").get() as any;
    assert.deepEqual(calculateSpyFeatures(JSON.parse(row.input_json)).values, JSON.parse(row.features_json).values);
    db.pragma("query_only=ON");
    const fail = buildSpyFeatureRun(raw, raw.receivedAt);
    persistSpyFeatureRun(fail, db); assert.equal(fail.features.archived, false);
  } finally { db.close(); }
});
test("READY response requires all unique nonmissing feature keys and the supported opening time", () => {
  const raw = fixture(), f = buildSpyFeatureRun(raw, raw.receivedAt).features;
  assert.equal(SpyFeaturesSchema.safeParse({ ...f, values: [] }).success, false);
  assert.equal(SpyFeaturesSchema.safeParse({ ...f, values: f.values.map((x, i) => i === 0 ? { ...x, value: null } : x) }).success, false);
  assert.equal(SpyFeaturesSchema.safeParse({ ...f, values: f.values.map((x, i) => i === 0 ? f.values[1] : x) }).success, false);
  const h = hours("2026-09-30");
  h.equity.EQ.sessionHours.regularMarket[0].start = new Date(etEpochMs("2026-09-30", 10, 0)).toISOString();
  assert.equal(parseSpyHours(h, "2026-09-30"), null); // exceptional opens require a new anchor contract
});
