// server/streamStore.ts
//
// In-memory store for the Schwab Streamer (server/schwabStream.ts). Pure:
// no network, no DB, no socket. The connection manager feeds it parsed
// frames; consumers read it through the helpers at the bottom.
//
// What it holds, all with Schwab's own timestamps:
//   - latest LEVELONE_EQUITIES quote per symbol (indexes included, "$SPX")
//   - latest LEVELONE_OPTIONS quote per contract
//   - a ring buffer of every LEVELONE update for the tick symbols ($SPX, SPY,
//     $VIX by default): the closest-to-tick series Schwab offers. Schwab has no
//     documented time-and-sales stream; LEVELONE updates are conflated, so one
//     update can carry several trades (volume delta > last size).
//   - 1-minute bars: CHART_EQUITY bars as Schwab sends them, and 1-minute
//     bars synthesized from LEVELONE last prices for symbols whose chart
//     stream is unconfirmed (indexes), labelled source "l1_synth".
//
// Field numbers are per service and differ between services (BID is 1 on
// equities, 2 on options). Source: schwab-py streaming.py enums
// LevelOneEquityFields / LevelOneOptionFields / ChartEquityFields,
// https://github.com/alexgolec/schwab-py/blob/main/schwab/streaming.py
// LEVELONE services are delta streams: a frame carries only changed fields,
// merged into the stored record (schwabdev docs,
// https://tylerebowers.github.io/Schwabdev/).
//
// Validity rule. A stored quote is current only while the session that
// delivered it is live: connected, the socket heard from (data or heartbeat)
// within maxSilenceMs, and the symbol's snapshot arrived in the current
// session epoch (after the latest login/subscribe). A delta stream's state is
// complete only from its first snapshot in a session; after a reconnect every
// record is invalid until Schwab re-sends it. During the regular session a
// quote whose own Schwab timestamp is older than maxQuoteAgeMs is also not
// used (the REST snapshot may be newer). A record Schwab flags delayed is
// never used as current (user rule: no delayed data shown as current).

import { quoteFreshness } from "./quoteFreshness";
import { OptionTradeSideBook } from "./signedVolume";

// ─── Field maps (numeric keys in Schwab Streamer content items) ─────────────

export const L1_EQUITY_FIELDS = {
  SYMBOL: 0, BID: 1, ASK: 2, LAST: 3, BID_SIZE: 4, ASK_SIZE: 5, TOTAL_VOLUME: 8, LAST_SIZE: 9,
  HIGH: 10, LOW: 11, CLOSE: 12, OPEN: 17, NET_CHANGE: 18, REGULAR_MARKET_LAST: 29, MARK: 33,
  QUOTE_TIME: 34, TRADE_TIME: 35, NET_CHANGE_PERCENT: 42,
} as const;

export const L1_OPTION_FIELDS = {
  SYMBOL: 0, BID: 2, ASK: 3, LAST: 4, TOTAL_VOLUME: 8, OPEN_INTEREST: 9, VOLATILITY: 10,
  BID_SIZE: 16, ASK_SIZE: 17, LAST_SIZE: 18, DELTA: 28, GAMMA: 29, THETA: 30, VEGA: 31,
  UNDERLYING_PRICE: 35, MARK: 37, QUOTE_TIME: 38, TRADE_TIME: 39,
} as const;

export const CHART_EQUITY_FIELDS = {
  SYMBOL: 0, SEQUENCE: 1, OPEN: 2, HIGH: 3, LOW: 4, CLOSE: 5, VOLUME: 6, CHART_TIME: 7, CHART_DAY: 8,
} as const;

/** Comma-joined sorted field numbers for a SUBS request. */
export function fieldList(map: Record<string, number>): string {
  return Array.from(new Set(Object.values(map))).sort((a, b) => a - b).join(",");
}

export type StreamService = "LEVELONE_EQUITIES" | "LEVELONE_OPTIONS" | "CHART_EQUITY";

// ─── Records ─────────────────────────────────────────────────────────────────

export interface StreamEquityQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastSize: number | null;
  totalVolume: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  closePrice: number | null;
  netChange: number | null;
  netChangePercent: number | null;
  regularMarketLast: number | null;
  mark: number | null;
  quoteTimeMs: number | null;
  tradeTimeMs: number | null;
  /** Schwab's "delayed" flag on the item; null when absent. */
  delayed: boolean | null;
  receivedAtMs: number;
  /** Session epoch of the latest update. */
  epoch: number;
  updates: number;
}

export interface StreamOptionQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastSize: number | null;
  totalVolume: number | null;
  openInterest: number | null;
  /** Schwab VOLATILITY field: implied vol in percent as Schwab sends it. */
  volatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  underlyingPrice: number | null;
  quoteTimeMs: number | null;
  tradeTimeMs: number | null;
  delayed: boolean | null;
  receivedAtMs: number;
  epoch: number;
  updates: number;
}

/** One LEVELONE update of a tick symbol, after merging the delta into the quote. */
export interface StreamTick {
  /** Schwab time: tradeTime when the update carried a trade, else quoteTime, else frame time. */
  t: number;
  /** Local receive time, epoch ms. */
  rx: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Session cumulative volume after this update (null for indexes without volume). */
  cumVolume: number | null;
  lastSize: number | null;
  /** True when this update carried LAST (a new last price or a restated one). */
  lastInFrame: boolean;
  /** True when TOTAL_VOLUME increased in this update (at least one trade). */
  trade: boolean;
}

export interface StreamBar {
  symbol: string;
  /** Bar open time, epoch ms (minute start). */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: "chart_equity" | "l1_synth";
  /** Updates aggregated (l1_synth) or Schwab sequence (chart_equity). */
  updates: number;
  /** l1_synth: the stream was live for the whole minute. chart_equity: Schwab's bar. */
  complete: boolean;
}

// ─── Tick ring buffer (columnar, fixed memory) ───────────────────────────────

export class TickRing {
  readonly capacity: number;
  private t: Float64Array;
  private rx: Float64Array;
  private last: Float64Array;
  private bid: Float64Array;
  private ask: Float64Array;
  private vol: Float64Array;
  private size: Float64Array;
  private flags: Uint8Array;
  private head = 0; // next write index
  private n = 0;
  /** Oldest entries overwritten because the buffer was full. */
  dropped = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(16, Math.floor(capacity));
    const c = this.capacity;
    this.t = new Float64Array(c); this.rx = new Float64Array(c); this.last = new Float64Array(c);
    this.bid = new Float64Array(c); this.ask = new Float64Array(c); this.vol = new Float64Array(c);
    this.size = new Float64Array(c); this.flags = new Uint8Array(c);
  }

  get length(): number { return this.n; }

  push(k: StreamTick): void {
    const i = this.head;
    const nz = (v: number | null) => (v == null || !Number.isFinite(v) ? NaN : v);
    this.t[i] = k.t; this.rx[i] = k.rx; this.last[i] = nz(k.last); this.bid[i] = nz(k.bid);
    this.ask[i] = nz(k.ask); this.vol[i] = nz(k.cumVolume); this.size[i] = nz(k.lastSize);
    this.flags[i] = (k.lastInFrame ? 1 : 0) | (k.trade ? 2 : 0);
    this.head = (i + 1) % this.capacity;
    if (this.n < this.capacity) this.n++;
    else this.dropped++;
  }

  private at(j: number): StreamTick {
    const i = (this.head - this.n + j + this.capacity) % this.capacity;
    const v = (x: number) => (Number.isNaN(x) ? null : x);
    return {
      t: this.t[i], rx: this.rx[i], last: v(this.last[i]), bid: v(this.bid[i]), ask: v(this.ask[i]),
      cumVolume: v(this.vol[i]), lastSize: v(this.size[i]),
      lastInFrame: (this.flags[i] & 1) === 1, trade: (this.flags[i] & 2) === 2,
    };
  }

  /** Oldest Schwab time held, or null when empty. */
  firstT(): number | null { return this.n ? this.at(0).t : null; }

  /** Entries with receive time >= sinceRx, oldest first. */
  since(sinceRx: number): StreamTick[] {
    const out: StreamTick[] = [];
    for (let j = 0; j < this.n; j++) {
      const i = (this.head - this.n + j + this.capacity) % this.capacity;
      if (this.rx[i] >= sinceRx) out.push(this.at(j));
    }
    return out;
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export interface StreamStoreOptions {
  /** Symbols whose every LEVELONE update is kept (closest-to-tick series). */
  tickSymbols?: string[];
  /** Symbols for which 1-minute bars are synthesized from LEVELONE last prices. */
  synthBarSymbols?: string[];
  tickCapacity?: number;
  /** Bars kept in memory per symbol. */
  barCapacity?: number;
  /** A synthesized bar is closed this long after its minute ends (late frames). */
  barGraceMs?: number;
  /** CHART_EQUITY bars are treated final this long after their open (Schwab may resend). */
  chartFinalAfterMs?: number;
}

type Num = number | null;
const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface SynthState {
  bar: StreamBar | null;
}

export class StreamStore {
  readonly opts: Required<StreamStoreOptions>;
  epoch = 0;
  connected = false;
  connectedAtMs: number | null = null;
  disconnectedAtMs: number | null = null;
  lastMessageAtMs: number | null = null;
  lastDataAtMs: Partial<Record<StreamService, number>> = {};
  equities = new Map<string, StreamEquityQuote>();
  options = new Map<string, StreamOptionQuote>();
  /** Lee-Ready side of streamed option trade blocks, per contract per ET day (signedVolume.ts). */
  optionSides = new OptionTradeSideBook();
  ticks = new Map<string, TickRing>();
  /** Per tick symbol: receive time of the first update of the current session (continuous coverage start). */
  continuousSince = new Map<string, number>();
  bars = new Map<string, StreamBar[]>();
  private synth = new Map<string, SynthState>();
  private finalized = new Set<string>();
  /** Bars that became final since the last drain (persistence sink). */
  private pendingFinal: StreamBar[] = [];
  /** Called on every new last price of an equity/index (quote shield). */
  onLastPrice: ((symbol: string, price: number, tMs: number) => void) | null = null;
  counters = { frames: 0, items: 0, outOfOrder: 0, delayedItems: 0, unknownService: 0 };

  constructor(opts: StreamStoreOptions = {}) {
    this.opts = {
      tickSymbols: opts.tickSymbols ?? ["$SPX", "SPY", "$VIX"],
      synthBarSymbols: opts.synthBarSymbols ?? ["$SPX"],
      tickCapacity: opts.tickCapacity ?? 120_000,
      barCapacity: opts.barCapacity ?? 1_000,
      barGraceMs: opts.barGraceMs ?? 5_000,
      chartFinalAfterMs: opts.chartFinalAfterMs ?? 120_000,
    };
    for (const s of this.opts.tickSymbols) this.ticks.set(s, new TickRing(this.opts.tickCapacity));
  }

  /** A new streamer session logged in: everything held so far is from an older session. */
  beginSession(now: number): void {
    this.epoch++;
    this.connected = true;
    this.connectedAtMs = now;
    this.disconnectedAtMs = null;
    this.lastMessageAtMs = now;
    this.continuousSince.clear();
    // A bar open across the gap is incomplete: drop it (never persisted).
    this.synth.clear();
  }

  endSession(now: number): void {
    this.connected = false;
    this.disconnectedAtMs = now;
    this.continuousSince.clear();
    this.synth.clear();
  }

  noteMessage(now: number): void {
    this.lastMessageAtMs = now;
  }

  /** Apply one `data` entry of a Streamer frame. */
  applyData(entry: { service?: string; timestamp?: number; content?: any[] }, now: number): void {
    const svc = String(entry?.service ?? "");
    const frameTs = num(entry?.timestamp) ?? now;
    const items = Array.isArray(entry?.content) ? entry.content : [];
    this.counters.frames++;
    if (svc === "LEVELONE_EQUITIES") {
      this.lastDataAtMs.LEVELONE_EQUITIES = now;
      for (const it of items) this.applyEquity(it, frameTs, now);
    } else if (svc === "LEVELONE_OPTIONS") {
      this.lastDataAtMs.LEVELONE_OPTIONS = now;
      for (const it of items) this.applyOption(it, now);
    } else if (svc === "CHART_EQUITY") {
      this.lastDataAtMs.CHART_EQUITY = now;
      for (const it of items) this.applyChart(it, now);
    } else {
      this.counters.unknownService++;
    }
    this.counters.items += items.length;
  }

  private applyEquity(it: any, frameTs: number, now: number): void {
    const F = L1_EQUITY_FIELDS;
    const symbol = String(it?.key ?? it?.[String(F.SYMBOL)] ?? "");
    if (!symbol) return;
    const g = (f: number): Num | undefined => (String(f) in it ? num(it[String(f)]) : undefined);
    const prev = this.equities.get(symbol);
    const fresh = !prev || prev.epoch !== this.epoch; // first item this session = snapshot
    const base: StreamEquityQuote = fresh || !prev ? {
      symbol, bid: null, ask: null, last: null, bidSize: null, askSize: null, lastSize: null, totalVolume: null,
      high: null, low: null, open: null, closePrice: null, netChange: null, netChangePercent: null,
      regularMarketLast: null, mark: null, quoteTimeMs: null, tradeTimeMs: null, delayed: null,
      receivedAtMs: now, epoch: this.epoch, updates: 0,
    } : prev;
    const q: StreamEquityQuote = { ...base };
    const set = <K extends keyof StreamEquityQuote>(k: K, f: number) => {
      const v = g(f);
      if (v !== undefined) (q as any)[k] = v;
    };
    set("bid", F.BID); set("ask", F.ASK); set("last", F.LAST); set("bidSize", F.BID_SIZE); set("askSize", F.ASK_SIZE);
    set("totalVolume", F.TOTAL_VOLUME); set("lastSize", F.LAST_SIZE); set("high", F.HIGH); set("low", F.LOW);
    set("open", F.OPEN); set("closePrice", F.CLOSE); set("netChange", F.NET_CHANGE);
    set("netChangePercent", F.NET_CHANGE_PERCENT); set("regularMarketLast", F.REGULAR_MARKET_LAST); set("mark", F.MARK);
    set("quoteTimeMs", F.QUOTE_TIME); set("tradeTimeMs", F.TRADE_TIME);
    if (typeof it?.delayed === "boolean") q.delayed = it.delayed;
    if (q.delayed) this.counters.delayedItems++;
    q.receivedAtMs = now;
    q.epoch = this.epoch;
    q.updates = (fresh ? 0 : base.updates) + 1;
    this.equities.set(symbol, q);

    const lastInFrame = g(F.LAST) !== undefined && q.last != null;
    const volNow = q.totalVolume;
    const volPrev = fresh ? null : prev?.totalVolume ?? null;
    const trade = !fresh && volNow != null && volPrev != null && volNow > volPrev;
    const t = (trade || lastInFrame) && q.tradeTimeMs != null && g(F.TRADE_TIME) !== undefined
      ? q.tradeTimeMs
      : g(F.QUOTE_TIME) !== undefined && q.quoteTimeMs != null ? q.quoteTimeMs : frameTs;

    const ring = this.ticks.get(symbol);
    if (ring) {
      if (!this.continuousSince.has(symbol)) this.continuousSince.set(symbol, now);
      ring.push({ t, rx: now, last: q.last, bid: q.bid, ask: q.ask, cumVolume: q.totalVolume, lastSize: q.lastSize, lastInFrame, trade });
    }
    if (lastInFrame && q.last != null && !q.delayed) {
      if (this.onLastPrice) {
        try { this.onLastPrice(symbol, q.last, t); } catch { /* observer must not break ingest */ }
      }
      if (this.opts.synthBarSymbols.includes(symbol)) this.synthUpdate(symbol, q.last, t, now);
    }
  }

  private applyOption(it: any, now: number): void {
    const F = L1_OPTION_FIELDS;
    const symbol = String(it?.key ?? it?.[String(F.SYMBOL)] ?? "");
    if (!symbol) return;
    const g = (f: number): Num | undefined => (String(f) in it ? num(it[String(f)]) : undefined);
    const prev = this.options.get(symbol);
    const fresh = !prev || prev.epoch !== this.epoch;
    const base: StreamOptionQuote = fresh || !prev ? {
      symbol, bid: null, ask: null, last: null, mark: null, bidSize: null, askSize: null, lastSize: null,
      totalVolume: null, openInterest: null, volatility: null, delta: null, gamma: null, theta: null, vega: null,
      underlyingPrice: null, quoteTimeMs: null, tradeTimeMs: null, delayed: null, receivedAtMs: now, epoch: this.epoch, updates: 0,
    } : prev;
    const q: StreamOptionQuote = { ...base };
    const set = <K extends keyof StreamOptionQuote>(k: K, f: number) => {
      const v = g(f);
      if (v !== undefined) (q as any)[k] = v;
    };
    set("bid", F.BID); set("ask", F.ASK); set("last", F.LAST); set("mark", F.MARK); set("bidSize", F.BID_SIZE);
    set("askSize", F.ASK_SIZE); set("lastSize", F.LAST_SIZE); set("totalVolume", F.TOTAL_VOLUME);
    set("openInterest", F.OPEN_INTEREST); set("volatility", F.VOLATILITY); set("delta", F.DELTA); set("gamma", F.GAMMA);
    set("theta", F.THETA); set("vega", F.VEGA); set("underlyingPrice", F.UNDERLYING_PRICE);
    set("quoteTimeMs", F.QUOTE_TIME); set("tradeTimeMs", F.TRADE_TIME);
    if (typeof it?.delayed === "boolean") q.delayed = it.delayed;
    if (q.delayed) this.counters.delayedItems++;
    q.receivedAtMs = now;
    q.epoch = this.epoch;
    q.updates = (fresh ? 0 : base.updates) + 1;
    this.options.set(symbol, q);
    if (!q.delayed) {
      this.optionSides.update(symbol, { t: q.tradeTimeMs ?? q.quoteTimeMs ?? now, last: q.last, bid: q.bid, ask: q.ask, cumVolume: q.totalVolume }, this.epoch);
    }
  }

  private applyChart(it: any, now: number): void {
    const F = CHART_EQUITY_FIELDS;
    const symbol = String(it?.key ?? it?.[String(F.SYMBOL)] ?? "");
    const t = num(it?.[String(F.CHART_TIME)]);
    const o = num(it?.[String(F.OPEN)]), h = num(it?.[String(F.HIGH)]), l = num(it?.[String(F.LOW)]), c = num(it?.[String(F.CLOSE)]);
    if (!symbol || t == null || o == null || h == null || l == null || c == null) return;
    const bar: StreamBar = {
      symbol, t, open: o, high: h, low: l, close: c, volume: num(it?.[String(F.VOLUME)]),
      source: "chart_equity", updates: num(it?.[String(F.SEQUENCE)]) ?? 0, complete: true,
    };
    this.upsertBar(bar);
    void now;
  }

  private upsertBar(bar: StreamBar): void {
    const arr = this.bars.get(bar.symbol) ?? [];
    // Prefer a chart_equity bar over an l1_synth bar for the same minute.
    const i = arr.findIndex((b) => b.t === bar.t);
    if (i >= 0) {
      if (arr[i].source === "chart_equity" && bar.source === "l1_synth") return;
      arr[i] = bar;
    } else {
      arr.push(bar);
      if (arr.length > 1 && arr[arr.length - 2].t > bar.t) arr.sort((a, b) => a.t - b.t);
      if (arr.length > this.opts.barCapacity) arr.splice(0, arr.length - this.opts.barCapacity);
    }
    this.bars.set(bar.symbol, arr);
  }

  private synthUpdate(symbol: string, price: number, t: number, now: number): void {
    const st = this.synth.get(symbol) ?? { bar: null };
    const m = Math.floor(t / 60_000) * 60_000;
    const cur = st.bar;
    if (cur && m < cur.t) {
      this.counters.outOfOrder++;
      return;
    }
    if (cur && m === cur.t) {
      cur.high = Math.max(cur.high, price);
      cur.low = Math.min(cur.low, price);
      cur.close = price;
      cur.updates++;
    } else {
      if (cur) this.closeSynth(symbol, cur);
      // Complete only if this session was already live when the minute began
      // (a reconnect clears the open bar, so no update of the minute was lost).
      const complete = this.connectedAtMs != null && this.connectedAtMs <= m;
      st.bar = { symbol, t: m, open: price, high: price, low: price, close: price, volume: null, source: "l1_synth", updates: 1, complete };
    }
    if (st.bar) this.upsertBar({ ...st.bar });
    this.synth.set(symbol, st);
    void now;
  }

  private closeSynth(symbol: string, bar: StreamBar): void {
    this.upsertBar({ ...bar });
    if (bar.complete) this.markFinal({ ...bar });
    void symbol;
  }

  private markFinal(bar: StreamBar): void {
    const k = `${bar.symbol}|${bar.t}|${bar.source}`;
    if (this.finalized.has(k)) return;
    this.finalized.add(k);
    if (this.finalized.size > 50_000) this.finalized.clear();
    this.pendingFinal.push(bar);
  }

  /**
   * Close bars whose minute is over (synth: minute end + grace with no later
   * update; chart: chartFinalAfterMs after open) and return every bar that
   * became final since the last call. Only complete bars are returned.
   */
  drainFinalBars(now: number): StreamBar[] {
    for (const [symbol, st] of Array.from(this.synth.entries())) {
      const b = st.bar;
      if (b && now >= b.t + 60_000 + this.opts.barGraceMs && this.connected) {
        this.closeSynth(symbol, b);
        st.bar = null;
      }
    }
    for (const arr of Array.from(this.bars.values())) {
      for (const b of arr) {
        if (b.source === "chart_equity" && now >= b.t + this.opts.chartFinalAfterMs) this.markFinal({ ...b });
      }
    }
    const out = this.pendingFinal;
    this.pendingFinal = [];
    return out;
  }

  /** Bars held for a symbol (both sources, chart preferred per minute), oldest first. */
  getBars(symbol: string): StreamBar[] {
    return (this.bars.get(symbol) ?? []).map((b) => ({ ...b }));
  }

  /** Continuous tick series of the current session for a tick symbol. */
  sessionTicks(symbol: string): { ticks: StreamTick[]; continuousSinceMs: number | null } {
    const ring = this.ticks.get(symbol);
    const since = this.continuousSince.get(symbol) ?? null;
    if (!ring || since == null || !this.connected) return { ticks: [], continuousSinceMs: null };
    return { ticks: ring.since(since), continuousSinceMs: since };
  }
}

// ─── Freshness decision (pure) ───────────────────────────────────────────────

export interface StreamValidityOptions {
  /** The socket must have delivered something (data or heartbeat) this recently. */
  maxSilenceMs: number;
  /** During the regular session, a quote whose Schwab time is older than this is not used. */
  maxQuoteAgeMs: number;
}

export const DEFAULT_VALIDITY: StreamValidityOptions = { maxSilenceMs: 45_000, maxQuoteAgeMs: 120_000 };

export type StreamUse = { use: true; ageMs: number | null } | { use: false; reason: string };

/** Is this stored record usable as the current quote? */
export function streamRecordUsable(
  store: Pick<StreamStore, "connected" | "epoch" | "lastMessageAtMs">,
  rec: { epoch: number; delayed: boolean | null; quoteTimeMs: number | null; tradeTimeMs: number | null } | undefined,
  now: number,
  opts: StreamValidityOptions = DEFAULT_VALIDITY,
): StreamUse {
  if (!store.connected) return { use: false, reason: "stream not connected" };
  if (store.lastMessageAtMs == null || now - store.lastMessageAtMs > opts.maxSilenceMs) {
    return { use: false, reason: `stream silent > ${Math.round(opts.maxSilenceMs / 1000)} s` };
  }
  if (!rec) return { use: false, reason: "symbol not streamed" };
  if (rec.epoch !== store.epoch) return { use: false, reason: "no snapshot since reconnect" };
  if (rec.delayed === true) return { use: false, reason: "Schwab flagged the stream record delayed" };
  const ts = rec.quoteTimeMs ?? rec.tradeTimeMs;
  const f = quoteFreshness(ts, now);
  if (f.marketOpen && (f.ageMs == null || f.ageMs > opts.maxQuoteAgeMs)) {
    return { use: false, reason: f.ageMs == null ? "stream record has no Schwab timestamp" : `stream record ${Math.round(f.ageMs / 1000)} s old` };
  }
  return { use: true, ageMs: f.ageMs };
}

// ─── Active store registry + consumer helpers ────────────────────────────────

let _active: StreamStore | null = null;
let _validity: StreamValidityOptions = DEFAULT_VALIDITY;

export function setActiveStreamStore(s: StreamStore | null, validity: StreamValidityOptions = DEFAULT_VALIDITY): void {
  _active = s;
  _validity = validity;
}

export function getActiveStreamStore(): StreamStore | null {
  return _active;
}

/** Stream equity/index quote if usable now, else null with the reason (caller falls back to Schwab REST). */
export function streamEquityQuote(symbol: string, now = Date.now()): { quote: StreamEquityQuote; ageMs: number | null } | { quote: null; reason: string } {
  const s = _active;
  if (!s) return { quote: null, reason: "stream not started" };
  const rec = s.equities.get(symbol);
  const u = streamRecordUsable(s, rec, now, _validity);
  if (!u.use || !rec) return { quote: null, reason: u.use ? "symbol not streamed" : u.reason };
  return { quote: { ...rec }, ageMs: u.ageMs };
}

/** Stream option quote (Schwab option symbol) if usable now. */
export function streamOptionQuote(symbol: string, now = Date.now()): { quote: StreamOptionQuote; ageMs: number | null } | { quote: null; reason: string } {
  const s = _active;
  if (!s) return { quote: null, reason: "stream not started" };
  const rec = s.options.get(symbol);
  const u = streamRecordUsable(s, rec, now, _validity);
  if (!u.use || !rec) return { quote: null, reason: u.use ? "symbol not streamed" : u.reason };
  return { quote: { ...rec }, ageMs: u.ageMs };
}

/**
 * Option mark from the stream for a contract when it is usable and at least
 * as new as the REST quote time the caller holds. Returns null otherwise, so
 * the caller keeps its Schwab REST value. bid/ask in $ per share.
 */
export function streamOptionOverlay(
  symbol: string | null | undefined,
  restQuoteTimeMs: number | null,
  now = Date.now(),
): { bid: number | null; ask: number | null; last: number | null; mark: number | null; totalVolume: number | null; quoteTimeMs: number | null; tradeTimeMs: number | null } | null {
  if (!symbol) return null;
  const r = streamOptionQuote(symbol, now);
  if (!r.quote) return null;
  const q = r.quote;
  const t = q.quoteTimeMs ?? q.tradeTimeMs;
  if (restQuoteTimeMs != null && t != null && t < restQuoteTimeMs) return null;
  if (q.bid == null && q.ask == null && q.last == null && q.mark == null) return null;
  return { bid: q.bid, ask: q.ask, last: q.last, mark: q.mark, totalVolume: q.totalVolume, quoteTimeMs: q.quoteTimeMs, tradeTimeMs: q.tradeTimeMs };
}

// Dynamic option subscriptions: consumers declare the set they want by owner;
// the connection manager subscribes the union (see schwabStream.ts).
const _optionWants = new Map<string, string[]>();
let _optionListener: (() => void) | null = null;

/** Replace the option symbols wanted by one owner ("odte", "whale"). Order = priority (first kept under the cap). */
export function syncStreamOptions(owner: string, symbols: string[]): void {
  const clean = Array.from(new Set(symbols.filter((s) => typeof s === "string" && s.trim().length > 0)));
  const prev = _optionWants.get(owner) ?? [];
  if (prev.length === clean.length && prev.every((s, i) => s === clean[i])) return;
  _optionWants.set(owner, clean);
  if (_optionListener) {
    try { _optionListener(); } catch { /* subscription errors surface in stream status */ }
  }
}

/** Union of wanted option symbols, owners in the given priority order, capped. */
export function wantedOptionSymbols(cap: number, ownerPriority: string[] = ["odte", "whale"]): { symbols: string[]; overCap: string[] } {
  const owners = ownerPriority.concat(Array.from(_optionWants.keys()).filter((o) => !ownerPriority.includes(o)));
  const all: string[] = [];
  for (const o of owners) for (const s of _optionWants.get(o) ?? []) if (!all.includes(s)) all.push(s);
  return { symbols: all.slice(0, Math.max(0, cap)), overCap: all.slice(Math.max(0, cap)) };
}

export function onOptionWantsChanged(fn: (() => void) | null): void {
  _optionListener = fn;
}

/** Test helper: clear option wants. */
export function _resetOptionWants(): void {
  _optionWants.clear();
}
