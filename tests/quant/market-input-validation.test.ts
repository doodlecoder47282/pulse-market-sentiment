import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSchwabInputValidator, validateDailyHistory, validateOptionSample, validateQuote, validateStreamingInfo } from "../../server/schwabInputValidation";
import { prevTradingDay, etWallToEpochMs } from "../../server/exchangeCalendar";

const now = Date.parse("2026-10-16T15:00:00Z");
const quotes = () => Object.fromEntries(["SPY", "$SPX", "$VIX"].map(symbol =>
  [symbol, { symbol, realtime: true, quote: { lastPrice: 100, quoteTime: now - 1000, tradeTime: now - 1000 } }]));
const history = () => {
  const dates: string[] = [];
  let date = "2026-10-15";
  for (let i = 0; i < 18; i++) { dates.unshift(date); date = prevTradingDay(date); }
  return { symbol: "SPY", empty: false, candles: dates.map(d => ({ datetime: etWallToEpochMs(d, 0), open: 100, high: 102, low: 98, close: 101, volume: 2000 })) };
};
const chain = () => {
  const c = (side: "C" | "P") => ({
    symbol: `SPY   261016${side}00100000`, putCall: side === "C" ? "CALL" : "PUT",
    expirationDate: "2026-10-16T20:00:00Z", strikePrice: 100, multiplier: 100, nonStandard: false,
    quoteTimeInLong: now - 1000, bid: 1, ask: 1.2, totalVolume: 0, openInterest: 100,
    volatility: 20, gamma: .01, delta: side === "C" ? .5 : -.5,
  });
  return { symbol: "SPY", status: "SUCCESS", isDelayed: false, underlyingPrice: 100,
    underlying: { quoteTime: now - 1000, delayed: false },
    callExpDateMap: { "2026-10-16:0": { "100.0": [c("C")] } },
    putExpDateMap: { "2026-10-16:0": { "100.0": [c("P")] } } };
};
test("snapshot loading cannot replace the recovery shell", () => {
  const source = readFileSync(new URL("../../client/src/pages/dashboard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /if\s*\(isLoading\)\s*return/);
  assert.match(source, /data-testid="snapshot-loading-status"/);
  assert.match(source, /<SchwabSettings open=\{settingsOpen\}/);
  const settings = readFileSync(new URL("../../client/src/components/SchwabSettings.tsx", import.meta.url), "utf8");
  assert.match(settings, /className="h-auto min-h-\[44px\] w-full whitespace-normal[^"]*"[^>]*data-testid="schwab-selftest-btn"/);
});
test("quote requires exact identity, real-time flag, valid price and provider time", () => {
  assert.equal(validateQuote(quotes(), "SPY", now).verdict, "pass");
  const bad = quotes(); bad.SPY.symbol = "QQQ";
  assert.equal(validateQuote(bad, "SPY", now).ok, false);
  for (const time of [0, NaN, now + 6000, now - 121000]) {
    const j = quotes(); j.SPY.quote.quoteTime = time;
    assert.equal(validateQuote(j, "SPY", now).ok, false);
  }
  const delayed = quotes(); delayed.SPY.realtime = false;
  assert.equal(validateQuote(delayed, "SPY", now).verdict, "partial");
  const zero = quotes(); zero.SPY.quote.lastPrice = 0;
  assert.equal(validateQuote(zero, "SPY", now).verdict, "fail");
  for (const tradeTime of [undefined, 0, now + 6000, now - 121000]) {
    const j: any = quotes(); j.SPY.quote.tradeTime = tradeTime;
    assert.equal(validateQuote(j, "SPY", now).ok, false, "a fresh bid/ask timestamp cannot freshen the last trade");
  }
});
test("outside-session quote is qualified, not called live", () => {
  assert.equal(validateQuote(quotes(), "SPY", Date.parse("2026-10-17T15:00:00Z")).verdict, "partial");
});
test("history passes completed-calendar continuity and rejects empty HTTP-200-shaped bodies", () => {
  assert.equal(validateDailyHistory(history(), now).verdict, "pass");
  for (const j of [{}, { symbol: "SPY", candles: [] }, { ...history(), symbol: "QQQ" }]) {
    assert.equal(validateDailyHistory(j, now).verdict, "fail");
  }
});
test("history rejects duplicate, out-of-order, future, malformed and missing-session candles", () => {
  const cases = [
    (j: ReturnType<typeof history>) => { j.candles.push(j.candles.at(-1)!); },
    (j: ReturnType<typeof history>) => { j.candles.reverse(); },
    (j: ReturnType<typeof history>) => { j.candles[0].high = 50; },
    (j: ReturnType<typeof history>) => { j.candles[0].volume = -1; },
    (j: ReturnType<typeof history>) => { j.candles.splice(5, 1); },
    (j: ReturnType<typeof history>) => { j.candles.pop(); },
    (j: ReturnType<typeof history>) => { j.candles.at(-1)!.datetime = now + 60_000; },
  ];
  for (const mutate of cases) {
    const j = history(); mutate(j);
    assert.equal(validateDailyHistory(j, now).ok, false);
  }
});
test("chain sample requires fresh standard identified contracts on both sides", () => {
  assert.equal(validateOptionSample(chain(), now).verdict, "pass");
  assert.equal(validateOptionSample({}, now).verdict, "fail");
  assert.equal(validateOptionSample({ ...chain(), isDelayed: true }, now).verdict, "partial");
  const stale = chain(); stale.underlying.quoteTime = now - 60_001;
  assert.equal(validateOptionSample(stale, now).verdict, "fail");
  for (const update of [
    { symbol: "QQQ   261016C00100000" }, { expirationDate: "2026-10-17T20:00:00Z" }, { strikePrice: 101 },
    { multiplier: 10 }, { nonStandard: true }, { quoteTimeInLong: 0 }, { quoteTimeInLong: now - 60_001 },
    { bid: 2, ask: 1 }, { volatility: 999 }, { gamma: -999 }, { openInterest: null }, { delta: -999 },
  ]) {
    const j = chain(); Object.assign(j.callExpDateMap["2026-10-16:0"]["100.0"][0], update);
    assert.equal(validateOptionSample(j, now).ok, false, JSON.stringify(update));
  }
});
test("streamer info alone never certifies a working live feed", () => {
  assert.equal(validateStreamingInfo({ streamerInfo: [{}] }).verdict, "partial");
  assert.equal(validateStreamingInfo({}).verdict, "fail");
});
test("demo blocks all token/provider calls and cannot return an OK demo test", async () => {
  let calls = 0;
  const run = createSchwabInputValidator({ demo: () => true, now: () => now,
    token: async () => { calls++; return "fixture"; }, fetch: async () => { calls++; throw new Error(); } });
  const result = await run();
  assert.equal(calls, 0);
  assert.equal(result.connected, false);
  assert.equal(result.realDataChecked, false);
  assert.equal(result.marketInputsValid, false);
  assert.equal(result.items[0].verdict, "blocked");
});
test("no authorization cannot probe real provider", async () => {
  let calls = 0;
  const run = createSchwabInputValidator({ demo: () => false, token: async () => null, now: () => now, fetch: async () => { calls++; throw new Error(); } });
  assert.equal((await run()).items[0].verdict, "blocked");
  assert.equal(calls, 0);
});
test("direct samples are shared, cached briefly and copy-protected; expiry reruns probes", async () => {
  let clock = now, calls = 0;
  const run = createSchwabInputValidator({
    demo: () => false, token: async () => "fixture-only", now: () => clock,
    fetch: async input => {
      calls++;
      const url = String(input);
      return Response.json(url.includes("/quotes") ? quotes() : url.includes("pricehistory") ? history() : url.includes("/chains") ? chain() : { streamerInfo: [{ privateIdentifier: "must-not-leak" }] });
    },
  });
  const [one, two] = await Promise.all([run(), run()]);
  assert.equal(calls, 4);
  assert.equal(one.marketInputsValid, true);
  assert.doesNotMatch(JSON.stringify(one), /must-not-leak|fixture-only/);
  one.items[0].detail = "mutated";
  const cached = await run();
  assert.equal(cached.cached, true);
  assert.notEqual(cached.items[0].detail, "mutated");
  assert.notEqual(two.items[0].detail, "mutated");
  clock += 31_000; await run();
  assert.equal(calls, 8);
});
test("HTTP 200 empty/malformed bodies do not pass input validation", async () => {
  const run = createSchwabInputValidator({ demo: () => false, token: async () => "fixture", now: () => now, fetch: async () => Response.json({}) });
  const result = await run();
  assert.equal(result.marketInputsValid, false);
  assert.equal(result.realDataChecked, false);
  assert.ok(result.items.every(item => item.verdict === "fail"));
});
test("report expiry follows the oldest passing contract rather than a newer underlying", async () => {
  const sample = chain();
  sample.callExpDateMap["2026-10-16:0"]["100.0"][0].quoteTimeInLong = now - 59_000;
  const run = createSchwabInputValidator({
    demo: () => false, token: async () => "fixture", now: () => now,
    fetch: async input => Response.json(String(input).includes("/quotes") ? quotes() : String(input).includes("pricehistory") ? history() : String(input).includes("/chains") ? sample : {}),
  });
  const result = await run();
  assert.equal(result.marketInputsValid, true);
  assert.equal(result.expiresAt, now + 1000);
});
test("a quote that expires while the chain loads cannot pass the completed report", async () => {
  let clock = now;
  const earlyQuotes = quotes();
  for (const row of Object.values(earlyQuotes)) row.quote.tradeTime = now - 119_000;
  const run = createSchwabInputValidator({
    demo: () => false, token: async () => "fixture", now: () => clock,
    fetch: async input => {
      const url = String(input);
      if (url.includes("/chains")) {
        await new Promise(resolve => setImmediate(resolve));
        clock += 2000;
      }
      return Response.json(url.includes("/quotes") ? earlyQuotes : url.includes("pricehistory") ? history() : url.includes("/chains") ? chain() : {});
    },
  });
  const result = await run();
  assert.equal(result.marketInputsValid, false);
  assert.equal(result.items[0].verdict, "fail");
  assert.match(result.items[0].detail, /expired before/);
});
test("HTTP failures and provider error bodies are not exposed as successful data", async () => {
  for (const status of [401, 403, 429, 500]) {
    const run = createSchwabInputValidator({ demo: () => false, token: async () => "fixture", now: () => now, fetch: async () => Response.json({ private: "not-for-ui" }, { status }) });
    const result = await run();
    assert.equal(result.marketInputsValid, false);
    assert.ok(result.items.every(item => item.status === status && !item.ok));
    assert.doesNotMatch(JSON.stringify(result), /not-for-ui/);
  }
});
