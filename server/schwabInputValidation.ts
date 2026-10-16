import type { MarketDataCheck, MarketDataValidation, ValidationVerdict } from "../shared/marketDataValidation";
import { withRequestDeadline } from "../shared/requestDeadline";
import { etDate, isCovered, isTradingDay, isRegularSessionOpen, prevTradingDay, sessionCloseMs, addDays } from "./exchangeCalendar";

type Json = Record<string, any>;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const count = (v: unknown) => finite(v) && Number.isInteger(v) && v >= 0;
const timestamp = (v: unknown, now: number): v is number => positive(v) && v > 1e12 && v <= now + 5_000;
const fresh = (v: unknown, now: number, maxAge: number) => timestamp(v, now) && now - v <= maxAge;
const check = (name: string, verdict: ValidationVerdict, detail: string, observedAt: number | null = null): MarketDataCheck =>
  ({ name, verdict, ok: verdict === "pass", detail, observedAt, status: 200, source: "Schwab direct REST" });

export function validateQuote(payload: Json | null, symbol: string, now: number): MarketDataCheck {
  const name = `${symbol} quote`;
  const row = payload?.[symbol], q = row?.quote;
  if (!q || row.symbol !== symbol || !positive(q.lastPrice)) return check(name, "fail", "Missing quote, wrong instrument or invalid price.");
  if (!isCovered(etDate(now))) return check(name, "blocked", "Exchange calendar does not cover this date.");
  // lastPrice belongs to the last trade, not a later bid/ask update.
  const at = q.tradeTime;
  if (!timestamp(at, now)) return check(name, "fail", "Provider observation time is missing or invalid; receipt time is not a substitute.");
  if (!timestamp(q.quoteTime, now)) return check(name, "fail", "Provider quote timestamp is missing or invalid.", at);
  if (row.realtime !== true) return check(name, "partial", "Provider real-time entitlement flag is absent or false.", at);
  if (!isRegularSessionOpen(now)) return check(name, "partial", "Market is outside its regular session. This observation is not certified as a live-session quote.", at);
  const oldest = Math.min(at, q.quoteTime);
  if (!fresh(oldest, now, 120_000)) return check(name, "fail", "Trade or quote observation exceeds the two-minute freshness limit.", oldest);
  return check(name, "pass", "Exact instrument, positive last-trade price, real-time flag and both provider timestamps checked. Time shown is the older observation.", oldest);
}

export function validateDailyHistory(payload: Json | null, now: number): MarketDataCheck {
  const name = "SPY daily history";
  if (payload?.symbol !== "SPY" || payload.empty === true || !Array.isArray(payload.candles) || !payload.candles.length) {
    return check(name, "fail", "No usable SPY candles. An HTTP 200 is not a data-quality pass.");
  }
  const today = etDate(now);
  if (!isCovered(today)) return check(name, "blocked", "Exchange calendar does not cover this date.");
  const close = sessionCloseMs(today);
  // Allow fifteen minutes for the just-completed daily bar to settle.
  const expected = close != null && now >= close + 15 * 60_000 ? today : prevTradingDay(today);
  let previous = -Infinity;
  const days: string[] = [];
  const completed: Json[] = [];
  for (const c of payload.candles) {
    if (!c || !timestamp(c.datetime, now) || c.datetime <= previous ||
        ![c.open, c.high, c.low, c.close].every(positive) || !count(c.volume) ||
        c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || c.high < c.low) {
      return check(name, "fail", "Malformed OHLCV, duplicate/out-of-order candles or invalid timestamps.");
    }
    previous = c.datetime;
    const day = etDate(c.datetime);
    if (!isCovered(day) || !isTradingDay(day) || days.includes(day)) return check(name, "fail", "Invalid or duplicated trading-session date.");
    days.push(day);
    if (day <= expected) completed.push(c);
  }
  if (completed.length < 15) return check(name, "partial", "Fewer than fifteen completed sessions; indicator history is insufficient.");
  const last = completed[completed.length - 1];
  if (etDate(last.datetime) !== expected) return check(name, "fail", "The latest completed session is missing.", last.datetime);
  for (let i = 1; i < completed.length; i++) {
    if (etDate(completed[i - 1].datetime) !== prevTradingDay(etDate(completed[i].datetime))) {
      return check(name, "fail", "A trading session is missing from the returned history.", last.datetime);
    }
  }
  return check(name, "pass", `${completed.length} completed sessions checked for identity, OHLCV consistency, order and calendar continuity. This does not verify split adjustments.`, last.datetime);
}

export function validateOptionSample(payload: Json | null, now: number): MarketDataCheck {
  const name = "SPY option sample";
  if (!payload || payload.symbol !== "SPY" || payload.status !== "SUCCESS") return check(name, "fail", "Missing or mismatched successful SPY chain.");
  const at = payload.underlying?.quoteTime;
  if (payload.isDelayed !== false || payload.underlying?.delayed === true) return check(name, "partial", "Chain delay status is delayed or unverified.");
  if (!positive(payload.underlyingPrice) || !fresh(at, now, 60_000)) return check(name, "fail", "Underlying price or its sub-minute provider timestamp is missing or stale.");
  let total = 0, valid = 0, calls = 0, puts = 0;
  let oldest = at as number;
  const seen = new Set<string>();
  for (const [field, side] of [["callExpDateMap", "CALL"], ["putExpDateMap", "PUT"]]) {
    const dates = payload[field];
    if (!dates || typeof dates !== "object" || Array.isArray(dates)) continue;
    for (const [expiry, strikeMap] of Object.entries(dates)) {
      if (!strikeMap || typeof strikeMap !== "object" || Array.isArray(strikeMap)) continue;
      for (const [strike, contracts] of Object.entries(strikeMap)) {
        if (!Array.isArray(contracts)) continue;
        for (const c of contracts) {
          total++;
          if (total > 2000) return check(name, "fail", "Validation sample exceeded its bounded contract limit.");
          const occ = typeof c?.symbol === "string" ? /^SPY\s*(\d{6})([CP])(\d{8})$/.exec(c.symbol) : null;
          const expiryDate = expiry.slice(0, 10);
          const expiryStamp = typeof c?.expirationDate === "string" ? c.expirationDate.slice(0, 10) : null;
          const matching = occ && `20${occ[1].slice(0, 2)}-${occ[1].slice(2, 4)}-${occ[1].slice(4, 6)}` === expiryDate
            && (side === "CALL" ? occ[2] === "C" : occ[2] === "P")
            && Number(occ[3]) / 1000 === Number(strike) && c.strikePrice === Number(strike)
            && c.putCall === side && expiryStamp === expiryDate && expiryDate >= etDate(now);
          if (!matching || seen.has(c.symbol)) continue;
          seen.add(c.symbol);
          if (c.multiplier !== 100 || c.nonStandard !== false || !fresh(c.quoteTimeInLong, now, 60_000) ||
              !positive(c.bid) || !positive(c.ask) || c.ask < c.bid ||
              !count(c.openInterest) || !count(c.totalVolume) ||
              !positive(c.volatility) || c.volatility >= 999 ||
              !finite(c.gamma) || c.gamma < 0 || !finite(c.delta) || Math.abs(c.delta) > 1 ||
              (side === "CALL" ? c.delta < 0 : c.delta > 0)) continue;
          oldest = Math.min(oldest, c.quoteTimeInLong);
          valid++; if (side === "CALL") calls++; else puts++;
        }
      }
    }
  }
  if (!total || !valid || !calls || !puts) return check(name, "fail", "No usable fresh standard call-and-put sample.", at);
  return check(name, valid === total ? "pass" : "partial",
    `${valid}/${total} sampled contracts passed identity, bid/ask, timestamp, multiplier, IV, Greek and OI/volume shape checks. Time shown is the oldest passing quote. OI publication age and full-chain GEX accuracy are not established.`, oldest);
}

export function validateStreamingInfo(payload: Json | null): MarketDataCheck {
  return check("Streaming configuration", Array.isArray(payload?.streamerInfo) && payload.streamerInfo.length ? "partial" : "fail",
    Array.isArray(payload?.streamerInfo) && payload.streamerInfo.length
      ? "Configuration is available. This is not proof that the socket delivers fresh prices."
      : "No streaming configuration returned.");
}

interface ValidationDependencies {
  demo: () => boolean;
  token: () => Promise<string | null>;
  fetch: typeof fetch;
  now?: () => number;
}

/** Direct provider probes only: never use demoSchwabPayload or stale adapter fallbacks. */
export function createSchwabInputValidator(deps: ValidationDependencies) {
  const now = deps.now ?? Date.now;
  let pending: Promise<MarketDataValidation> | null = null;
  let last: { token: string; result: MarketDataValidation } | null = null;
  const report = (connected: boolean, realDataChecked: boolean, items: MarketDataCheck[]): MarketDataValidation => {
    const checkedAt = now();
    // A fast probe can expire while another endpoint is still returning.
    items = items.map(item => item.ok && item.observedAt != null &&
      (item.name.endsWith("quote") || item.name === "SPY option sample") &&
      !fresh(item.observedAt, checkedAt, item.name === "SPY option sample" ? 60_000 : 120_000)
      ? { ...item, ok: false, verdict: "fail" as const, detail: "Observation expired before the full check completed. Recheck; no live-data approval was issued." }
      : item);
    return {
      version: 1, connected, realDataChecked,
      marketInputsValid: items.length >= 5 && items.slice(0, 5).every(item => item.verdict === "pass"),
      checkedAt, expiresAt: Math.min(checkedAt + 30_000, ...items.filter(item => item.ok && item.observedAt != null && (item.name.endsWith("quote") || item.name === "SPY option sample"))
        .map(item => item.observedAt! + (item.name === "SPY option sample" ? 60_000 : 120_000))), cached: false,
      scope: "Sampled Schwab input checks only. Not a calibration, execution, full-chain or prediction-accuracy certificate.",
      items,
    };
  };
  return async (): Promise<MarketDataValidation> => {
    if (deps.demo()) return report(false, false, [{ ...check("Real-data validation", "blocked", "Demo data cannot validate market outputs. Connect your protected personal server first."), status: null, source: "none" }]);
    if (pending) return structuredClone(await pending);
    pending = (async () => {
      const token = await withRequestDeadline(() => deps.token(), 8_000).catch(() => null);
      if (!token || token === "demo-sample-data") return report(false, false, [{ ...check("Schwab sign-in", "blocked", "No usable Schwab authorization. Connect Schwab in Settings; developer secrets stay on the server."), status: null, source: "none" }]);
      if (last?.token === token && now() < last.result.expiresAt) return { ...structuredClone(last.result), cached: true };
      let dataReceived = false;
      const probe = async (path: string, names: string[], validate: (body: Json, at: number) => MarketDataCheck[]) => {
        try {
          return await withRequestDeadline(async signal => {
            const res = await deps.fetch(`https://api.schwabapi.com/${path}`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
            if (!res.ok) return names.map(name => ({ ...check(name, "fail",
              res.status === 401 ? "Authorization refused by this API." : res.status === 403 ? "This API entitlement was refused." : res.status === 429 ? "Provider rate limit. Wait before rechecking." : "Provider request failed."),
              status: res.status, source: "none" as const }));
            const body = await res.json();
            if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Malformed response");
            dataReceived ||= names[0] !== "Streaming configuration" && Object.keys(body).length > 0;
            return validate(body, now());
          }, 10_000);
        } catch {
          return names.map(name => ({ ...check(name, "fail", "Timed out, unreachable or malformed provider response. No fallback was substituted."), status: null, source: "none" as const }));
        }
      };
      const groups = await Promise.all([
        probe("marketdata/v1/quotes?symbols=SPY,%24SPX,%24VIX&fields=quote", ["SPY quote", "$SPX quote", "$VIX quote"], (j, at) => ["SPY", "$SPX", "$VIX"].map(symbol => validateQuote(j, symbol, at))),
        probe("marketdata/v1/pricehistory?symbol=SPY&periodType=month&period=1&frequencyType=daily&frequency=1", ["SPY daily history"], (j, at) => [validateDailyHistory(j, at)]),
        probe(`marketdata/v1/chains?symbol=SPY&strikeCount=4&contractType=ALL&includeUnderlyingQuote=true&fromDate=${etDate(now())}&toDate=${addDays(etDate(now()), 7)}`, ["SPY option sample"], (j, at) => [validateOptionSample(j, at)]),
        probe("trader/v1/userPreference", ["Streaming configuration"], j => [validateStreamingInfo(j)]),
      ]);
      const result = report(true, dataReceived, groups.flat());
      last = { token, result: structuredClone(result) };
      return result;
    })().finally(() => { pending = null; });
    return structuredClone(await pending);
  };
}
