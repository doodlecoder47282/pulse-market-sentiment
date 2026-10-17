// Demo edition: simulated market (server/demoMarket.ts), edition parsing and
// the read-only /api guard. The simulator must be deterministic, internally
// consistent (quotes, bars and chains agree) and priced correctly, because
// the real engines run their math on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bsm, demoChain, demoPriceHistory, demoQuote, demoSchwabPayload, sessionState, volumeProgress } from "../../server/demoMarket";
import { etWallToEpochMs } from "../../server/exchangeCalendar";
import { gexByStrikeFromChain } from "../../server/gammaProfile";
import { editionFromEnv, featureAllowed, parseEdition } from "../../shared/edition";
import { demoRequestAllowed, gateMode, isLoopbackSocket, makeDemoReadOnly } from "../../server/accessGate";

// Monday 2026-10-12: 11:00 ET (session open), 08:00 ET (pre-market), 17:00 ET (after the close).
const OPEN = etWallToEpochMs("2026-10-12", 11 * 60);
const PRE = etWallToEpochMs("2026-10-12", 8 * 60);
const POST = etWallToEpochMs("2026-10-12", 17 * 60);
const SAT = etWallToEpochMs("2026-10-10", 12 * 60);

test("edition: demo parses, falls back to personal, and gets no personal-only features", () => {
  assert.equal(editionFromEnv({ BATCAVE_EDITION: " Demo " }), "demo");
  assert.equal(editionFromEnv({ BATCAVE_EDITION: "investor" }), "investor");
  assert.equal(editionFromEnv({ BATCAVE_EDITION: "anything" }), "personal");
  assert.equal(parseEdition("demo"), "demo");
  assert.equal(parseEdition("admin"), null);
  assert.equal(featureAllowed("eod-trade-setup", "demo"), false);
  assert.equal(featureAllowed("discord-trade-cards", "demo"), false);
  assert.equal(featureAllowed("eod-trade-setup", "personal"), true);
});

test("gate: demo is open-demo on a public bind, a key still wins", () => {
  assert.equal(gateMode({ RAILWAY_ENVIRONMENT: "p", BATCAVE_EDITION: "demo" }), "open-demo");
  assert.equal(gateMode({ RAILWAY_ENVIRONMENT: "p", BATCAVE_EDITION: "demo", BATCAVE_ACCESS_KEY: "k".repeat(40) }), "key");
  assert.equal(gateMode({ RAILWAY_ENVIRONMENT: "p", BATCAVE_EDITION: "personal" }), "closed");
});

test("demo /api is read-only except listed calculations and authenticated server self-calls", () => {
  assert.equal(demoRequestAllowed("GET", "/schwab/status"), true);
  assert.equal(demoRequestAllowed("POST", "/position-sizer"), true);
  for (const p of ["/schwab/callback", "/schwab/disconnect", "/signals/track", "/flow/config", "/alpha-brief", "/eod-setup"]) {
    assert.equal(demoRequestAllowed("POST", p), false, p);
  }
  assert.equal(demoRequestAllowed("PATCH", "/flow/config"), false);
  assert.equal(demoRequestAllowed("DELETE", "/layout/signals"), false);
  assert.equal(isLoopbackSocket("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackSocket("10.0.0.5"), false);
  const mw = makeDemoReadOnly("internal-fixture-proof");
  let status = 0;
  let nexted = false;
  const res = { status(n: number) { status = n; return { json() {} }; } };
  mw({ method: "POST", path: "/signals/track", socket: { remoteAddress: "10.1.2.3" } }, res, () => { nexted = true; });
  assert.equal(status, 403);
  assert.equal(nexted, false);
  mw({ method: "POST", path: "/mm-snapshot", socket: { remoteAddress: "127.0.0.1" } }, res, () => { nexted = true; });
  assert.equal(nexted, false, "loopback proxy is not authentication");
  mw({ method: "POST", path: "/mm-snapshot", headers: { "x-batcave-key": "wrong" }, socket: { remoteAddress: "127.0.0.1" } }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  mw({ method: "POST", path: "/mm-snapshot", headers: { "x-batcave-key": "internal-fixture-proof" }, socket: { remoteAddress: "127.0.0.1" } }, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test("sessions follow the exchange calendar", () => {
  assert.equal(sessionState(OPEN).phase, "open");
  assert.equal(sessionState(PRE).phase, "pre");
  assert.equal(sessionState(POST).phase, "post");
  assert.equal(sessionState(SAT).phase, "closed");
  assert.ok(Math.abs(sessionState(OPEN).m! - 90) < 1e-9);
  // Pre-market reflects the prior session (Friday 2026-10-09).
  assert.equal(sessionState(PRE).idx, sessionState(SAT).idx);
});

test("quotes: deterministic, Schwab-shaped, change = last - close", () => {
  const a = demoQuote("SPY", OPEN);
  const b = demoQuote("SPY", OPEN);
  assert.deepEqual(a, b);
  const q = a.quote;
  assert.equal(a.assetMainType, "EQUITY");
  assert.ok(q.lastPrice > 0 && q.bidPrice < q.askPrice);
  assert.ok(Math.abs(q.netChange - (q.lastPrice - q.closePrice)) < 0.011);
  assert.ok(q.lowPrice <= q.lastPrice && q.lastPrice <= q.highPrice);
  assert.ok(q.totalVolume > 0);
  assert.match(a.reference.description, /Sample data/);
  const spx = demoQuote("$SPX", OPEN);
  assert.equal(spx.assetMainType, "INDEX");
  assert.equal(spx.quote.bidPrice, undefined, "index quotes carry no bid/ask");
  // SPY tracks SPX (same market factor, no idiosyncratic part).
  assert.ok(Math.abs(spx.quote.netPercentChange - q.netPercentChange) < 0.02);
  // Unsupported symbols are absent, like Schwab omitting them.
  assert.equal(demoQuote("/ES", OPEN), null);
  const multi = demoSchwabPayload("marketdata/v1/quotes", { symbols: "SPY,$VIX,/ES" }, OPEN);
  assert.deepEqual(Object.keys(multi).sort(), ["$VIX", "SPY"]);
});

test("quotes: every plain-ticker macro tape symbol has a named sample level, not a hashed price", () => {
  // server/macro.ts cannot be imported here (it pulls the quote store), so
  // its UNIVERSE is read from the source. Yahoo-style FX/crypto symbols are
  // not Schwab symbols and stay absent (null), like any unsupported symbol.
  const src = readFileSync(new URL("../../server/macro.ts", import.meta.url), "utf8");
  const syms = Array.from(src.matchAll(/\{ symbol: "([^"]+)", label: "([^"]+)"/g)).map((m) => ({ symbol: m[1], label: m[2] }));
  assert.ok(syms.length >= 20, `found ${syms.length} tape symbols`);
  for (const { symbol, label } of syms) {
    const q = demoQuote(symbol, OPEN);
    if (!/^[A-Z][A-Z.]{0,5}$/.test(symbol)) { assert.equal(q, null, `${symbol} (${label}) is not a Schwab symbol`); continue; }
    assert.ok(q, `${symbol} (${label}) missing`);
    assert.doesNotMatch(q.reference.description, new RegExp(`^${symbol} \\(sample\\)`), `${symbol} (${label}) falls back to a hashed price`);
    assert.ok(q.quote.lastPrice > 0, `${symbol} price`);
  }
  // The commodity ETFs sit at ETF-like levels (the old hash put Oil near 196).
  assert.ok(demoQuote("USO", OPEN).quote.lastPrice < 120, "USO is an ETF price, not a barrel price");
  assert.ok(demoQuote("WEAT", OPEN).quote.lastPrice < 10);
});

test("quotes: pre-market shows no change; weekend shows the last session vs the one before", () => {
  const pre = demoQuote("SPY", PRE).quote;
  assert.equal(pre.netChange, 0);
  assert.equal(pre.lastPrice, pre.closePrice);
  const sat = demoQuote("SPY", SAT).quote;
  assert.equal(sat.lastPrice, pre.closePrice, "Friday's close");
  assert.equal(sat.quoteTime, etWallToEpochMs("2026-10-09", 16 * 60));
});

test("VIX family: inverse to the market, ordered term structure in calm markets", () => {
  for (const t of [OPEN, POST, SAT]) {
    const v = (s: string) => demoQuote(s, t).quote.lastPrice;
    assert.ok(v("$VIX") >= 9.5 && v("$VIX") <= 60);
    if (v("$VIX") < 20) assert.ok(v("$VIX3M") > v("$VIX"), "contango below 20");
    assert.ok(v("$VVIX") > 60);
  }
});

test("minute bars: completed bars only, OHLC consistent, last close near the quote", () => {
  const ph = demoPriceHistory({ symbol: "SPY", periodType: "day", period: 1, frequencyType: "minute", frequency: 1, endDate: OPEN }, OPEN);
  assert.equal(ph.candles.length, 90);
  for (const c of ph.candles) {
    assert.ok(c.low <= Math.min(c.open, c.close) + 1e-9 && c.high >= Math.max(c.open, c.close) - 1e-9);
    assert.ok(c.datetime < OPEN);
  }
  const last = ph.candles[ph.candles.length - 1].close;
  assert.ok(Math.abs(last - demoQuote("SPY", OPEN).quote.lastPrice) / last < 0.002);
  const five = demoPriceHistory({ symbol: "SPY", periodType: "day", period: 1, frequencyType: "minute", frequency: 5 }, OPEN);
  assert.equal(five.candles.length, 18);
  assert.equal(five.candles[0].open, ph.candles[0].open);
  // Weekend: the last full session is served (the app's market-closed fallback works).
  const wk = demoPriceHistory({ symbol: "$SPX", periodType: "day", period: 1, frequencyType: "minute", frequency: 1 }, SAT);
  assert.equal(wk.candles.length, 390);
});

test("daily bars: one per session, today's bar matches today's quote", () => {
  const ph = demoPriceHistory({ symbol: "SPY", periodType: "month", period: 1, frequencyType: "daily", frequency: 1 }, POST);
  assert.equal(ph.candles.length, 21);
  const q = demoQuote("SPY", POST).quote;
  const today = ph.candles[ph.candles.length - 1];
  assert.equal(today.close, q.lastPrice);
  assert.equal(today.high, q.highPrice);
  assert.equal(today.low, q.lowPrice);
  assert.equal(ph.candles[ph.candles.length - 2].close, q.closePrice);
  const yr = demoPriceHistory({ symbol: "SPY", periodType: "year", period: 1, frequencyType: "weekly", frequency: 1 }, POST);
  assert.ok(yr.candles.length >= 50 && yr.candles.length <= 54);
  assert.ok(volumeProgress(0) === 0 && Math.abs(volumeProgress(1) - 1) < 1e-12);
  assert.ok(volumeProgress(0.5) > 0.45 && volumeProgress(0.5) < 0.6, "about half the volume by midday (heavy open and close)");
  for (let x = 0; x < 1; x += 0.05) assert.ok(volumeProgress(x + 0.05) > volumeProgress(x));
});

test("Black-Scholes: put-call parity and textbook value", () => {
  const S = 100, K = 105, T = 0.5, r = 0.04, q = 0.01, v = 0.25;
  const c = bsm(true, S, K, T, r, q, v);
  const p = bsm(false, S, K, T, r, q, v);
  assert.ok(Math.abs(c.price - p.price - (S * Math.exp(-q * T) - K * Math.exp(-r * T))) < 1e-6);
  assert.ok(Math.abs(c.delta - p.delta - Math.exp(-q * T)) < 1e-9);
  assert.ok(c.gamma > 0 && Math.abs(c.gamma - p.gamma) < 1e-12);
  // Hull-style reference: S=K=100, T=1, r=5%, q=0, vol=20% -> call 10.4506.
  assert.ok(Math.abs(bsm(true, 100, 100, 1, 0.05, 0, 0.2).price - 10.4506) < 1e-3);
});

test("SPX chain: Schwab shape, window, strikes, quotes and greeks", () => {
  const params = { symbol: "$SPX", contractType: "ALL", strikeCount: 80, includeUnderlyingQuote: "true", fromDate: "2026-10-12", toDate: "2026-10-16" };
  const ch = demoChain(params, OPEN);
  assert.equal(ch.status, "SUCCESS");
  assert.equal(ch.isDelayed, false);
  const keys = Object.keys(ch.callExpDateMap);
  assert.deepEqual(keys.map((k) => k.split(":")[0]), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
  assert.equal(keys[0], "2026-10-12:0");
  const strikes = Object.keys(ch.callExpDateMap[keys[0]]).map(Number);
  assert.equal(strikes.length, 80);
  assert.ok(strikes.every((k) => k % 5 === 0));
  const S = ch.underlying.last;
  assert.ok(strikes[0] < S && strikes[strikes.length - 1] > S);
  for (const k of keys) {
    for (const sk of Object.keys(ch.callExpDateMap[k])) {
      const c = ch.callExpDateMap[k][sk][0];
      const p = ch.putExpDateMap[k][sk][0];
      assert.equal(c.putCall, "CALL");
      assert.equal(p.putCall, "PUT");
      assert.ok(c.bid <= c.mark && c.mark <= c.ask && p.bid <= p.mark && p.mark <= p.ask);
      assert.ok(c.delta >= 0 && c.delta <= 1 && p.delta <= 0 && p.delta >= -1);
      assert.ok(c.gamma >= 0 && c.openInterest >= 0 && c.totalVolume >= 0);
      assert.equal(c.multiplier, 100);
      assert.match(c.symbol, /^SPXW  26101\dC\d{8}$/);
    }
  }
  // Deterministic within the minute.
  assert.equal(demoChain(params, OPEN + 10_000), ch);
});

test("SPX chain: parity on mid prices, walls on the right side of spot", () => {
  const ch = demoChain({ symbol: "$SPX", contractType: "ALL", strikeCount: 200, fromDate: "2026-10-12", toDate: "2026-11-20" }, OPEN);
  const S = ch.underlying.last;
  const k0 = Object.keys(ch.callExpDateMap).find((k) => k.startsWith("2026-10-16"))!;
  const atm = Object.keys(ch.callExpDateMap[k0]).map(Number).sort((a, b) => Math.abs(a - S) - Math.abs(b - S))[0];
  const c = ch.callExpDateMap[k0][atm.toFixed(1)][0];
  const p = ch.putExpDateMap[k0][atm.toFixed(1)][0];
  const T = (Date.parse(c.expirationDate) - OPEN) / (365 * 86_400_000);
  const parity = S * Math.exp(-0.012 * T) - atm * Math.exp(-0.042 * T);
  assert.ok(Math.abs(c.theoreticalOptionValue - p.theoreticalOptionValue - parity) < 0.02, "parity on theoretical values");
  assert.ok(Math.abs(c.mark - p.mark - parity) < Math.max(c.ask - c.bid, p.ask - p.bid) + 0.1, "parity on marks within the spread");
  // Put skew: OTM put IV above OTM call IV at equal distance.
  const dn = ch.putExpDateMap[k0][(atm - 100).toFixed(1)][0];
  const up = ch.callExpDateMap[k0][(atm + 100).toFixed(1)][0];
  assert.ok(dn.volatility > up.volatility);
  const g = gexByStrikeFromChain({ ...ch, underlying: { last: S } }, OPEN);
  assert.equal(g.dataState, "ok");
  assert.ok(g.callWall != null && g.callWall > S, `call wall ${g.callWall} above spot ${S}`);
  assert.ok(g.putWall != null && g.putWall < S, `put wall ${g.putWall} below spot ${S}`);
});

test("chains: today's expiry disappears after the close; no chain for non-optionable symbols", () => {
  const post = demoChain({ symbol: "$SPX", strikeCount: 20, fromDate: "2026-10-12", toDate: "2026-10-14" }, POST);
  assert.deepEqual(Object.keys(post.callExpDateMap).map((k) => k.split(":")[0]), ["2026-10-13", "2026-10-14"]);
  const stock = demoChain({ symbol: "AAPL", strikeCount: 20, fromDate: "2026-10-12", toDate: "2026-10-31" }, OPEN);
  assert.deepEqual(Object.keys(stock.callExpDateMap).map((k) => k.split(":")[0]), ["2026-10-16", "2026-10-23", "2026-10-30"]);
  assert.equal(demoChain({ symbol: "$VIX", strikeCount: 20 }, OPEN).status, "FAILED");
  assert.equal(demoSchwabPayload("trader/v1/userPreference", undefined, OPEN), null);
});

test("chains: open interest is static and totalVolume is monotone within a session (feeds the flow ledger without drops)", () => {
  const params = { symbol: "$SPX", contractType: "ALL", strikeCount: 60, includeUnderlyingQuote: "true", fromDate: "2026-10-12", toDate: "2026-10-16" };
  const times = [10 * 60, 11 * 60, 12 * 60 + 30, 14 * 60, 15 * 60 + 55].map((m) => etWallToEpochMs("2026-10-12", m));
  const snaps = times.map((t) => demoChain(params, t));
  let checked = 0;
  for (const side of ["callExpDateMap", "putExpDateMap"] as const) {
    for (const k of Object.keys(snaps[0][side])) {
      for (const sk of Object.keys(snaps[0][side][k])) {
        let prevVol = -1;
        let oi: number | null = null;
        for (const ch of snaps) {
          const c = ch[side][k]?.[sk]?.[0];
          if (!c) continue;
          if (oi == null) oi = c.openInterest;
          assert.equal(c.openInterest, oi, `${side} ${k} ${sk}: OI moved during the session`);
          assert.ok(c.totalVolume >= prevVol, `${side} ${k} ${sk}: volume fell ${prevVol} -> ${c.totalVolume}`);
          prevVol = c.totalVolume;
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 500);
});

// Sample sweeps: without them the formula volume never exceeds open interest
// by the whale gate's 15x and the demo's whale panel is always empty.
function contractsOf(ch: any): any[] {
  const out: any[] = [];
  for (const map of [ch.callExpDateMap, ch.putExpDateMap]) {
    for (const [k, byStrike] of Object.entries<any>(map)) {
      const dte = Number(k.split(":")[1]);
      for (const arr of Object.values<any[]>(byStrike)) for (const c of arr) out.push({ ...c, dte });
    }
  }
  return out;
}
const whaleShaped = (c: any) =>
  c.dte >= 1 && c.dte <= 3 && c.openInterest > 0 && c.totalVolume / c.openInterest >= 15
  && c.totalVolume * c.mark * 100 >= 2_500_000 && c.last === c.ask && Math.abs(c.delta) >= 0.2 && Math.abs(c.delta) <= 0.8;

test("chains: sample sweeps are whale-shaped (1-3 DTE, lifted at the ask, >= $2.5M, vol/OI >= 15x), OI fixed all day, none pre-market", () => {
  const params = { symbol: "SPY", contractType: "ALL", strikeCount: 60, fromDate: "2026-10-12", toDate: "2026-10-16" };
  const post = contractsOf(demoChain(params, POST));
  const whales = post.filter(whaleShaped);
  assert.ok(whales.length >= 1 && whales.length <= 3, `SPY sweeps after the close: ${whales.length}`);
  for (const w of whales) {
    // Same contract during the session: identical open interest, volume no higher than at the close.
    const open = contractsOf(demoChain(params, OPEN)).find((c) => c.symbol === w.symbol);
    assert.ok(open, "sweep strike listed in the session");
    assert.equal(open.openInterest, w.openInterest, "open interest is the prior close's figure all day");
    assert.ok(open.totalVolume <= w.totalVolume);
    assert.ok(w.tradeTimeInLong <= w.quoteTimeInLong && w.tradeTimeInLong > 0, "the lift has a trade time inside the session");
    assert.ok(w.lastSize >= 100, "the last print is a block");
    assert.match(w.description, /\(sample\)$/);
  }
  // Nothing traded before the open: no sweep, no premium.
  assert.equal(contractsOf(demoChain(params, PRE)).filter(whaleShaped).length, 0);
  // Deterministic across calls and a different minute of the same day keeps the same sweep strikes.
  const again = contractsOf(demoChain(params, POST + 60_000)).filter(whaleShaped).map((c) => c.symbol).sort();
  assert.deepEqual(again, whales.map((c) => c.symbol).sort());
  // The sweep strikes are thin: without the block, volume stays under the gate.
  for (const w of whales) assert.ok(w.openInterest < w.totalVolume / 15 && w.openInterest >= 10);
});

test("chains: single names only get sweeps when a 1-3 DTE expiry is listed (Fridays)", () => {
  const monday = { symbol: "NVDA", contractType: "ALL", strikeCount: 60, fromDate: "2026-10-12", toDate: "2026-10-30" };
  const dtes = contractsOf(demoChain(monday, POST)).map((c) => c.dte);
  assert.ok(!dtes.some((d) => d >= 1 && d <= 3), "NVDA has no 1-3 DTE expiry on a Monday");
  assert.equal(contractsOf(demoChain(monday, POST)).filter(whaleShaped).length, 0);
  // Wednesday 2026-10-14 17:00 ET: Friday is 2 DTE, sweeps possible (0-2, deterministic).
  const wed = etWallToEpochMs("2026-10-14", 17 * 60);
  const n = contractsOf(demoChain({ ...monday, fromDate: "2026-10-14" }, wed)).filter(whaleShaped).length;
  assert.ok(n >= 0 && n <= 2, `NVDA sweeps on a Wednesday: ${n}`);
  // Across the single-name watchlist at least one name sweeps that day.
  let total = 0;
  for (const sym of ["NVDA", "TSLA", "AAPL", "MSFT", "META", "GOOGL", "AMZN", "AMD", "AVGO"]) {
    total += contractsOf(demoChain({ ...monday, symbol: sym, fromDate: "2026-10-14" }, wed)).filter(whaleShaped).length;
  }
  assert.ok(total >= 1, `single-name sweeps on 2026-10-14: ${total}`);
});
