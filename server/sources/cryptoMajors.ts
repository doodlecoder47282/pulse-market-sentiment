// server/sources/cryptoMajors.ts
//
// BTC, ETH, SOL from the exchanges that print the trades: Coinbase Exchange
// and Kraken public REST (keyless), cross-checked against each other, with
// CoinGecko as a labeled reference only. Crypto is outside Schwab (user rule
// 3); nothing here feeds an equity price, greeks, options or sizing input.
//
// Endpoints and field meanings (official docs, checked 2026-10-09):
//   Coinbase Exchange, base https://api.exchange.coinbase.com
//     GET /products/{id}/ticker -> trade_id, price, size, time, bid, ask, volume
//       https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker
//     GET /products/{id}/trades -> trade_id, side, size, price, time.
//       "The side of a trade indicates the maker order side ... A buy side
//       indicates a down-tick because the maker was a buy order ... A sell
//       side indicates an up-tick." So taker side = opposite of `side`.
//       https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-trades
//     Public rate limit 10 req/s per IP (bursts 15):
//       https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits
//   Kraken, base https://api.kraken.com/0/public
//     GET /Ticker?pair=... -> a=[ask,wlv,lv], b=[bid,wlv,lv], c=[last,vol],
//       v=[today,24h] volume, p=[today,24h] VWAP; no timestamp.
//       https://docs.kraken.com/api/docs/rest-api/get-ticker-information
//     GET /Trades?pair=..&count=N -> [price, volume, time, b/s, m/l, misc, id];
//       b/s is the taker side ("The side of the taker order", WebSocket v2
//       trade docs: https://docs.kraken.com/api/docs/websocket-v2/trade).
//       https://docs.kraken.com/api/docs/rest-api/get-recent-trades
//     Rate limits: per-client counter, max 15, decay 0.33/s at the lowest
//       tier: https://docs.kraken.com/exchange/guides/rest/ratelimits.md
//
// Cross-venue check. Mid = (bid + ask) / 2, the standard efficient-price
// proxy (Hasbrouck, "Empirical Market Microstructure", OUP 2007, ch. 1).
// Divergence = |midA - midB| / mean(mid) in basis points. Makarov & Schoar,
// "Trading and arbitrage in cryptocurrency markets", Journal of Financial
// Economics 135(2), 2020 (https://eprints.lse.ac.uk/100409) document that
// cross-exchange gaps within one region are small and arbitraged within fee
// bounds, while large gaps signal frictions or a broken feed. Thresholds
// here: < 25 bps agree; 25-100 bps watch (inside retail taker fee bounds);
// > 100 bps diverge (treat either print as suspect). These are operating
// thresholds, not estimated parameters.

import { SourceCache } from "./state";

export type Major = "BTC" | "ETH" | "SOL";
export const MAJORS: Major[] = ["BTC", "ETH", "SOL"];
export const COINBASE_PRODUCT: Record<Major, string> = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD" };
export const KRAKEN_PAIR: Record<Major, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
/** Result keys Kraken may return for each requested pair. */
export const KRAKEN_KEYS: Record<Major, string[]> = { BTC: ["XXBTZUSD", "XBTUSD", "BTC/USD"], ETH: ["XETHZUSD", "ETHUSD", "ETH/USD"], SOL: ["SOLUSD", "SOL/USD"] };
export const COINGECKO_ID: Record<Major, string> = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };

export const AGREE_BPS = 25;
export const DIVERGE_BPS = 100;
/** A major that has not printed a trade in this long is a feed problem, not a quiet market. */
export const TRADE_STALE_MS = 5 * 60_000;
export const FLOW_WINDOW_MS = 5 * 60_000;

export interface Trade { price: number; size: number; timeMs: number; takerSide: "buy" | "sell" }

export interface VenueQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** last trade time (UTC ms); null when the venue's quote carries none */
  lastTradeMs: number | null;
  volume24h: number | null; // base units
  vwap24h: number | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseCoinbaseTicker(j: any): VenueQuote {
  const t = typeof j?.time === "string" ? Date.parse(j.time) : NaN;
  return {
    bid: num(j?.bid), ask: num(j?.ask), last: num(j?.price),
    lastTradeMs: Number.isFinite(t) ? t : null,
    volume24h: num(j?.volume), vwap24h: null,
  };
}

/** Coinbase `side` is the MAKER side; the aggressor (taker) is the opposite. */
export function parseCoinbaseTrades(arr: any): Trade[] {
  if (!Array.isArray(arr)) return [];
  const out: Trade[] = [];
  for (const r of arr) {
    const price = num(r?.price), size = num(r?.size);
    const t = typeof r?.time === "string" ? Date.parse(r.time) : NaN;
    if (price == null || size == null || !Number.isFinite(t) || (r?.side !== "buy" && r?.side !== "sell")) continue;
    out.push({ price, size, timeMs: t, takerSide: r.side === "sell" ? "buy" : "sell" });
  }
  return out;
}

function krakenResult(j: any, m: Major): any {
  if (Array.isArray(j?.error) && j.error.length) throw new Error(`kraken: ${String(j.error[0]).slice(0, 80)}`);
  const r = j?.result ?? {};
  for (const k of KRAKEN_KEYS[m]) if (r[k] != null) return r[k];
  return null;
}

export function parseKrakenTicker(j: any, m: Major): VenueQuote | null {
  const r = krakenResult(j, m);
  if (!r) return null;
  return {
    bid: num(r?.b?.[0]), ask: num(r?.a?.[0]), last: num(r?.c?.[0]),
    lastTradeMs: null,
    volume24h: num(r?.v?.[1]), vwap24h: num(r?.p?.[1]),
  };
}

/** Kraken trade rows: [price, volume, time(s), "b"|"s" taker side, ...]. */
export function parseKrakenTrades(j: any, m: Major): Trade[] {
  const rows = krakenResult(j, m);
  if (!Array.isArray(rows)) return [];
  const out: Trade[] = [];
  for (const r of rows) {
    const price = num(r?.[0]), size = num(r?.[1]), ts = num(r?.[2]);
    if (price == null || size == null || ts == null || (r?.[3] !== "b" && r?.[3] !== "s")) continue;
    out.push({ price, size, timeMs: Math.round(ts * 1000), takerSide: r[3] === "b" ? "buy" : "sell" });
  }
  return out;
}

export interface TradeFlow {
  /** trades inside the window */
  count: number;
  buyBase: number;
  sellBase: number;
  /** taker-buy share of base volume; null when no trades in the window */
  takerBuyShare: number | null;
  vwap: number | null;
  notionalUsd: number;
  largestUsd: number | null;
  /** seconds of the window the fetched batch actually covers */
  coveredSec: number;
  lastTradeMs: number | null;
}

/**
 * Aggressor flow over the last `windowMs`. If the batch's oldest trade is
 * newer than the window start, the flow covers only that span and says so
 * (coveredSec) instead of implying a full window.
 */
export function tradeFlow(trades: Trade[], nowMs: number, windowMs = FLOW_WINDOW_MS): TradeFlow {
  const start = nowMs - windowMs;
  const inWin = trades.filter((t) => t.timeMs >= start && t.timeMs <= nowMs + 5_000);
  const all = trades.map((t) => t.timeMs);
  const oldest = all.length ? Math.min(...all) : null;
  const lastTradeMs = all.length ? Math.max(...all) : null;
  let buy = 0, sell = 0, pv = 0, largest: number | null = null;
  for (const t of inWin) {
    if (t.takerSide === "buy") buy += t.size; else sell += t.size;
    pv += t.price * t.size;
    const usd = t.price * t.size;
    if (largest == null || usd > largest) largest = usd;
  }
  const vol = buy + sell;
  const coveredFrom = oldest == null ? nowMs : Math.max(start, oldest);
  return {
    count: inWin.length,
    buyBase: buy,
    sellBase: sell,
    takerBuyShare: vol > 0 ? buy / vol : null,
    vwap: vol > 0 ? pv / vol : null,
    notionalUsd: pv,
    largestUsd: largest,
    coveredSec: Math.max(0, Math.round((nowMs - coveredFrom) / 1000)),
    lastTradeMs,
  };
}

export function mid(q: VenueQuote | null): number | null {
  if (!q || q.bid == null || q.ask == null || q.bid <= 0 || q.ask < q.bid) return null;
  return (q.bid + q.ask) / 2;
}

export function spreadBps(q: VenueQuote | null): number | null {
  const m = mid(q);
  return m == null ? null : ((q!.ask! - q!.bid!) / m) * 1e4;
}

export type VenueState = "ok" | "stale" | "failed";
export type CrossState = "agree" | "watch" | "diverge" | "single-source" | "unavailable";

export interface VenueRead { quote: VenueQuote | null; trades: Trade[] | null; fetchedAtMs: number | null; error: string | null }

/** ok when a usable two-sided quote exists and the venue printed a trade recently. */
export function venueState(v: VenueRead, nowMs: number): VenueState {
  if (!v.quote || mid(v.quote) == null) return "failed";
  const lastTrade = Math.max(v.quote.lastTradeMs ?? -Infinity, ...(v.trades ?? []).map((t) => t.timeMs));
  if (!Number.isFinite(lastTrade)) return "stale"; // no evidence the book is live
  return nowMs - lastTrade > TRADE_STALE_MS ? "stale" : "ok";
}

export function crossCheck(a: number | null, b: number | null): { state: CrossState; divergenceBps: number | null; reference: number | null } {
  if (a == null && b == null) return { state: "unavailable", divergenceBps: null, reference: null };
  if (a == null || b == null) return { state: "single-source", divergenceBps: null, reference: a ?? b };
  const avg = (a + b) / 2;
  const bps = (Math.abs(a - b) / avg) * 1e4;
  const state: CrossState = bps < AGREE_BPS ? "agree" : bps <= DIVERGE_BPS ? "watch" : "diverge";
  // A diverged pair has no single trustworthy reference.
  return { state, divergenceBps: bps, reference: state === "diverge" ? null : avg };
}

export interface MajorRow {
  asset: Major;
  coinbase: { state: VenueState; mid: number | null; spreadBps: number | null; last: number | null; lastTradeUtc: string | null; volume24h: number | null; flow: TradeFlow | null; error: string | null };
  kraken: { state: VenueState; mid: number | null; spreadBps: number | null; last: number | null; lastTradeUtc: string | null; volume24h: number | null; vwap24h: number | null; flow: TradeFlow | null; error: string | null };
  cross: { state: CrossState; divergenceBps: number | null; reference: number | null; note: string };
  coingecko: { price: number | null; deviationBps: number | null; asOfUtc: string | null; label: string };
}

const iso = (ms: number | null) => (ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Pure: build one asset row from the two venue reads and the CoinGecko reference. */
export function buildMajorRow(
  asset: Major,
  cb: VenueRead,
  kr: VenueRead,
  cg: { price: number | null; asOfMs: number | null },
  nowMs: number,
): MajorRow {
  const cbState = venueState(cb, nowMs);
  const krState = venueState(kr, nowMs);
  // Only live venues enter the cross-check; a stale book is not a price.
  const cbMid = cbState === "ok" ? mid(cb.quote) : null;
  const krMid = krState === "ok" ? mid(kr.quote) : null;
  const x = crossCheck(cbMid, krMid);
  const note = x.state === "agree" ? `Coinbase and Kraken mids within ${AGREE_BPS} bps`
    : x.state === "watch" ? `venues ${x.divergenceBps!.toFixed(0)} bps apart (inside fee bounds; watch)`
    : x.state === "diverge" ? `venues ${x.divergenceBps!.toFixed(0)} bps apart: no reference price shown, treat both prints as suspect`
    : x.state === "single-source" ? `one venue only (${cbMid != null ? "Coinbase" : "Kraken"}); not cross-checked`
    : "no live exchange quote";
  const cgDev = cg.price != null && x.reference != null ? ((cg.price - x.reference) / x.reference) * 1e4 : null;
  const cbFlow = cb.trades ? tradeFlow(cb.trades, nowMs) : null;
  const krFlow = kr.trades ? tradeFlow(kr.trades, nowMs) : null;
  const lastCb = Math.max(cb.quote?.lastTradeMs ?? -Infinity, cbFlow?.lastTradeMs ?? -Infinity);
  const lastKr = krFlow?.lastTradeMs ?? null;
  return {
    asset,
    coinbase: {
      state: cbState, mid: mid(cb.quote), spreadBps: spreadBps(cb.quote), last: cb.quote?.last ?? null,
      lastTradeUtc: iso(Number.isFinite(lastCb) ? lastCb : null), volume24h: cb.quote?.volume24h ?? null, flow: cbFlow, error: cb.error,
    },
    kraken: {
      state: krState, mid: mid(kr.quote), spreadBps: spreadBps(kr.quote), last: kr.quote?.last ?? null,
      lastTradeUtc: iso(lastKr), volume24h: kr.quote?.volume24h ?? null, vwap24h: kr.quote?.vwap24h ?? null, flow: krFlow, error: kr.error,
    },
    cross: { ...x, note },
    coingecko: { price: cg.price, deviationBps: cgDev, asOfUtc: iso(cg.asOfMs), label: "CoinGecko (aggregator reference, not in the cross-check)" },
  };
}

export interface MajorsSnapshot {
  asOf: number;
  state: "ok" | "partial" | "unavailable";
  rows: MajorRow[];
  sources: Array<{ id: string; name: string; tier: string; state: "ok" | "partial" | "failed" | "not_configured"; fetchedAtUtc: string | null; error: string | null }>;
  note: string;
}

// ─── Network adapter ─────────────────────────────────────────────────────


const UA = "Batcave/1.0 (personal market terminal)";
const cache = new SourceCache();

async function getJson(url: string, timeoutMs = 8000, extra: Record<string, string> = {}): Promise<any> {
  // Errors carry the status only (never the URL or headers, which may hold a key).
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...extra }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

type VenueBatch = { reads: Record<Major, VenueRead>; fetchedAtMs: number };

/** Coinbase: 3 tickers + 3 trade pages, sequential (6 requests per minute). */
async function fetchCoinbase(): Promise<VenueBatch> {
  const reads = {} as Record<Major, VenueRead>;
  let okCount = 0;
  for (const m of MAJORS) {
    const p = COINBASE_PRODUCT[m];
    const r: VenueRead = { quote: null, trades: null, fetchedAtMs: Date.now(), error: null };
    try { r.quote = parseCoinbaseTicker(await getJson(`https://api.exchange.coinbase.com/products/${p}/ticker`)); okCount++; } catch (e: any) { r.error = String(e?.message ?? e).slice(0, 100); }
    try { r.trades = parseCoinbaseTrades(await getJson(`https://api.exchange.coinbase.com/products/${p}/trades?limit=300`)); } catch (e: any) { r.error = r.error ?? String(e?.message ?? e).slice(0, 100); }
    reads[m] = r;
  }
  if (okCount === 0) throw new Error("every Coinbase ticker request failed");
  return { reads, fetchedAtMs: Date.now() };
}

/** Kraken: one Ticker call for all three pairs + 3 trade pages (4 requests per minute). */
async function fetchKraken(): Promise<VenueBatch> {
  const reads = {} as Record<Major, VenueRead>;
  const tick = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${MAJORS.map((m) => KRAKEN_PAIR[m]).join(",")}`);
  for (const m of MAJORS) {
    const r: VenueRead = { quote: null, trades: null, fetchedAtMs: Date.now(), error: null };
    try { r.quote = parseKrakenTicker(tick, m); if (!r.quote) r.error = "pair missing from ticker"; } catch (e: any) { r.error = String(e?.message ?? e).slice(0, 100); }
    try { r.trades = parseKrakenTrades(await getJson(`https://api.kraken.com/0/public/Trades?pair=${KRAKEN_PAIR[m]}&count=300`), m); } catch (e: any) { r.error = r.error ?? String(e?.message ?? e).slice(0, 100); }
    reads[m] = r;
  }
  return { reads, fetchedAtMs: Date.now() };
}

/**
 * CoinGecko's keyless API is documented as "not suitable for production
 * workloads, scheduled polling" (https://docs.coingecko.com/docs/keyless-public-api.md),
 * so the reference is read only with a free Demo key from the optional env
 * BATCAVE_COINGECKO_DEMO_KEY (header x-cg-demo-api-key, root api.coingecko.com:
 * https://docs.coingecko.com/demo/reference/authentication.md). Without it
 * the reference reports not_configured and is never called. One call per
 * 5 minutes.
 */
export function coingeckoDemoKey(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env.BATCAVE_COINGECKO_DEMO_KEY ?? "").trim();
  return v && /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : null;
}

async function fetchCoinGecko(): Promise<{ prices: Record<Major, number | null>; fetchedAtMs: number }> {
  const key = coingeckoDemoKey();
  if (!key) throw new Error("not configured");
  const ids = MAJORS.map((m) => COINGECKO_ID[m]).join(",");
  const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, 8000, { "x-cg-demo-api-key": key });
  const prices = {} as Record<Major, number | null>;
  for (const m of MAJORS) prices[m] = num(j?.[COINGECKO_ID[m]]?.usd);
  return { prices, fetchedAtMs: Date.now() };
}

const EMPTY: VenueRead = { quote: null, trades: null, fetchedAtMs: null, error: "venue request failed" };

/**
 * Snapshot for the Crypto tab. Exchange reads cache for 60 s and a failed
 * refresh may serve the previous read for at most 2 minutes (the trade-age
 * check then marks it stale anyway); CoinGecko (optional key) caches 5 min.
 */
export async function readMajors(nowMs = Date.now()): Promise<MajorsSnapshot> {
  const [cb, kr, cg] = await Promise.all([
    cache.get("majors:coinbase", 60_000, 120_000, fetchCoinbase),
    cache.get("majors:kraken", 60_000, 120_000, fetchKraken),
    coingeckoDemoKey()
      ? cache.get("majors:coingecko", 5 * 60_000, 15 * 60_000, fetchCoinGecko)
      : Promise.resolve({ value: null, fetchedAtMs: null, state: "failed" as const, error: "not configured: set BATCAVE_COINGECKO_DEMO_KEY (free Demo key) to show the reference" }),
  ]);
  const rows = MAJORS.map((m) => buildMajorRow(
    m,
    cb.value?.reads[m] ?? { ...EMPTY, error: cb.error ?? EMPTY.error },
    kr.value?.reads[m] ?? { ...EMPTY, error: kr.error ?? EMPTY.error },
    { price: cg.value?.prices[m] ?? null, asOfMs: cg.value?.fetchedAtMs ?? null },
    nowMs,
  ));
  const venueSt = (r: typeof cb, key: "coinbase" | "kraken"): "ok" | "partial" | "failed" =>
    r.value == null ? "failed" : rows.every((x) => x[key].state === "ok") ? "ok" : "partial";
  const sources: MajorsSnapshot["sources"] = [
    { id: "coinbase", name: "Coinbase Exchange", tier: "official", state: venueSt(cb, "coinbase"), fetchedAtUtc: iso(cb.fetchedAtMs), error: cb.error },
    { id: "kraken", name: "Kraken", tier: "official", state: venueSt(kr, "kraken"), fetchedAtUtc: iso(kr.fetchedAtMs), error: kr.error },
    { id: "coingecko", name: "CoinGecko (reference)", tier: "aggregator", state: !coingeckoDemoKey() ? "not_configured" : cg.value == null ? "failed" : "ok", fetchedAtUtc: iso(cg.fetchedAtMs), error: cg.error },
  ];
  const crossOk = rows.filter((r) => r.cross.state === "agree" || r.cross.state === "watch").length;
  const state: MajorsSnapshot["state"] = rows.every((r) => r.cross.state === "unavailable") ? "unavailable"
    : crossOk === rows.length ? "ok" : "partial";
  return {
    asOf: nowMs,
    state,
    rows,
    sources,
    note: "exchange-direct public market data (Coinbase Exchange, Kraken), cross-checked; CoinGecko is a reference only",
  };
}
