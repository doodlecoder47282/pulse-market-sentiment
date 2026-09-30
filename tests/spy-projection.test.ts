import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSpyTape, buildSpyProjectionResponse, createSpyProjectionService } from "../server/spyProjection";
import { SpyProjectionResponseSchema } from "../shared/spyProjection";
import { etEpochMs } from "../server/etTime";
import { readFileSync } from "node:fs";

const now = Date.parse("2026-09-30T14:00:30Z"); // 10:00:30 ET
const open = etEpochMs("2026-09-30", 9, 30);
function quote(patch: Record<string, unknown> = {}) {
  return { SPY: { symbol: "SPY", assetMainType: "EQUITY", realtime: true,
    quote: { lastPrice: 600, tradeTime: now - 1_000, ...patch } } };
}
function history() {
  return { symbol: "SPY", candles: Array.from({ length: 7 }, (_, i) => ({
    datetime: open + i * 300_000, open: 600, high: 601, low: 599, close: 600, volume: i ? 100 : 0,
  })) };
}

test("only real completed aligned same-day SPY bars are exposed, never a forecast", () => {
  const tape = assessSpyTape(quote(), history(), now);
  assert.equal(tape.status, "available");
  assert.equal(tape.candles.length, 6); // forming 10:00 candle is excluded
  assert.equal(tape.candles[0].v, 0); // observed zero preserved
  assert.equal(tape.observedAt, "2026-09-30T14:00:00.000Z");
  const result = buildSpyProjectionResponse(quote(), history(), now);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.projection.bands, null);
  assert.equal(result.levels, null);
  assert.equal(result.synthetic, false);
  assert.equal(result.predictionValidation, "not_established");
  assert.ok(result.blockers.some(r => r.includes("SPX")));
});

test("zero/invalid quote cannot anchor a synthetic ramp; stale/future/delayed price withheld", () => {
  for (const q of [
    null, quote({ lastPrice: 0 }), quote({ lastPrice: NaN }), quote({ lastPrice: Infinity }),
    quote({ tradeTime: now + 1 }), quote({ tradeTime: now - 60_000 }),
    { SPY: { ...quote().SPY, symbol: "$SPX" } }, { SPY: { ...quote().SPY, realtime: false } },
    { SPY: { ...quote().SPY, reference: { currency: "EUR" } } },
  ]) {
    const result = buildSpyProjectionResponse(q, history(), now);
    assert.equal(result.tape.candles.length, 0);
    assert.equal(result.tape.lastTrade, null);
    assert.equal(result.status, "UNAVAILABLE");
  }
});

test("yesterday, partial, off-grid, mixed, duplicate, synthetic and nonfinite tapes fail closed", () => {
  const bad = [
    { ...history(), symbol: "$SPX" },
    { ...history(), synthetic: true },
    { ...history(), candles: history().candles.map(c => ({ ...c, synthetic: true })) },
    { ...history(), candles: history().candles.map(c => ({ ...c, datetime: c.datetime - 86_400_000 })) },
    { ...history(), candles: history().candles.slice(1) },
    { ...history(), candles: history().candles.slice(0, 2) },
    { ...history(), candles: history().candles.filter((_, i) => i !== 3) },
    { ...history(), candles: [...history().candles, history().candles[0]] },
    { ...history(), candles: history().candles.map(c => ({ ...c, datetime: c.datetime + 1_000 })) },
    { ...history(), candles: history().candles.map(c => ({ ...c, low: 605 })) },
    { ...history(), candles: history().candles.map(c => ({ ...c, close: NaN })) },
    { ...history(), candles: history().candles.map(c => ({ ...c, volume: -1 })) },
    { ...history(), candles: [...history().candles, { ...history().candles[0], datetime: now + 1 }] },
  ];
  for (const h of bad) {
    const tape = assessSpyTape(quote(), h, now);
    assert.notEqual(tape.status, "available");
    assert.equal(tape.candles.length, 0);
    assert.equal(tape.lastTrade, null);
  }
});

test("weekend and outside-hours frames do not pretend to be current regular-session charts", () => {
  for (const date of ["2026-09-30T12:00:00Z", "2026-09-30T20:00:00Z", "2026-10-03T15:00:00Z"]) {
    assert.equal(assessSpyTape(quote(), history(), Date.parse(date)).status, "outside_session");
  }
});

test("new strict response contract rejects legacy synthetic and directional payloads", () => {
  const good = buildSpyProjectionResponse(quote(), history(), now);
  assert.equal(SpyProjectionResponseSchema.safeParse(good).success, true);
  assert.equal(SpyProjectionResponseSchema.safeParse({ ...good, synthetic: true }).success, false);
  assert.equal(SpyProjectionResponseSchema.safeParse({ ...good, projection: { status: "TRAINED", bands: { "60": { q50: 0 } } } }).success, false);
  assert.equal(SpyProjectionResponseSchema.safeParse({ ...good, tape: { ...good.tape, status: "stale" } }).success, false);
});

test("bounded cached read is deduplicated and retains real observation timestamps", async () => {
  let calls = 0, clock = now;
  const service = createSpyProjectionService({ now: () => clock, read: async () => {
    calls++; return { quote: quote(), history: history() };
  } });
  const [a, b] = await Promise.all([service.get(), service.get()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(await service.get(), a);
  clock += 31_000;
  await service.get();
  assert.equal(calls, 2);
  clock += 31_000;
  const old = await service.get();
  assert.equal(old.tape.status, "stale");
  assert.equal(old.tape.lastTrade, null);
});

test("provider timeout/failure is generic, no calls to models or synthetic generators", async () => {
  let calls = 0, clock = now;
  const service = createSpyProjectionService({
    now: () => clock, timeoutMs: 5,
    read: () => { calls++; return new Promise(() => {}); },
  });
  const first = await service.get();
  assert.equal(first.tape.status, "unavailable");
  clock += 31_000;
  const second = await service.get();
  assert.equal(second.projection.bands, null);
  assert.equal(calls, 1); // no repeated unfinished read
  const failed = createSpyProjectionService({ read: async () => { throw new Error("SECRET_TOKEN"); } });
  assert.equal(JSON.stringify(await failed.get()).includes("SECRET_TOKEN"), false);
});

test("SPY route is replaced, not shadowed; automatic GBM generator is physically absent", () => {
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  assert.equal((routes.match(/app\.get\("\/api\/ml\/projection-spy"/g) ?? []).length, 1);
  assert.ok(routes.includes('app.get("/api/ml/projection-spy", spyProjectionRoute)'));
  assert.equal(routes.includes("Schwab intraday tape unavailable; deterministic GBM walk"), false);
  assert.equal(routes.includes("const synth: any[] = []"), false);
  assert.equal((routes.match(/registerTradeBriefRoutes\(app\)/g) ?? []).length, 1);
  assert.ok(routes.includes('import { getCryptoContext } from "./cryptoContext"'));
  assert.ok(routes.includes('"/api/crypto/context"'));
});
