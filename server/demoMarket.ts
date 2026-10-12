// server/demoMarket.ts
//
// Simulated market for the demo edition (BATCAVE_EDITION=demo). It answers
// the four Schwab endpoints this app uses (quotes, pricehistory, chains,
// userPreference) with Schwab-shaped JSON, so every engine runs its real math
// on SAMPLE DATA. Nothing here is a real price. The demo edition labels every
// screen as sample data and never calls Schwab (server/schwab.ts).
//
// Deterministic: the same instant always gives the same numbers, so repeated
// calls agree and charts line up with quotes. Model:
//   - one market factor plus one idiosyncratic factor per symbol, each a
//     mean-reverting daily log level (AR(1)) and, inside a session, a Brownian
//     bridge from the open (previous close + gap) to that day's close;
//   - VIX family driven by the market factor (down market, higher VIX), with
//     a contango that flattens and inverts as VIX rises;
//   - option chains priced with Black-Scholes on a VIX-based term structure
//     and a put skew; open interest shaped around spot, round strikes and a
//     call wall / put wall set from the prior close.
// Sessions follow the real exchange calendar (server/exchangeCalendar.ts):
// live-moving during regular hours, frozen at the close otherwise.

import {
  addDays,
  dayOfWeek,
  etClock,
  etWallToEpochMs,
  isEarlyClose,
  isHoliday,
  isWeekend,
  REGULAR_OPEN_MIN,
  type IsoDate,
} from "./exchangeCalendar";
import { strikeSpacingFor } from "./schwabDataPolicy";

export const DEMO_DISCLOSURE = "Sample data: simulated market, not real prices";

// ── Deterministic randomness ────────────────────────────────────────────────

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalFrom(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Uniform [0,1) for a key. */
function uniform(key: string): number {
  return mulberry32(hash32(key))();
}

/** Standard normal for a key. */
function normal(key: string): number {
  return normalFrom(mulberry32(hash32(key)));
}

// ── Session calendar ────────────────────────────────────────────────────────

const EPOCH: IsoDate = "2024-01-02";
const DAYS: IsoDate[] = [];
const DAY_INDEX = new Map<IsoDate, number>();

export function simTradingDay(date: IsoDate): boolean {
  return !isWeekend(date) && !isHoliday(date);
}

function simSessionMinutes(date: IsoDate): number {
  return simTradingDay(date) ? (isEarlyClose(date) ? 210 : 390) : 0;
}

function ensureDaysThrough(date: IsoDate): void {
  let d = DAYS.length ? addDays(DAYS[DAYS.length - 1], 1) : EPOCH;
  while (d <= date) {
    if (simTradingDay(d)) {
      DAY_INDEX.set(d, DAYS.length);
      DAYS.push(d);
    }
    d = addDays(d, 1);
  }
}

/** Index of the last session that has started at `t` (today once 09:30 ET has passed). */
interface SessionState {
  /** Session index (DAYS) of the session the quote reflects. */
  idx: number;
  /** Minutes into that session (fractional), or null when it is closed. */
  m: number | null;
  phase: "pre" | "open" | "post" | "closed";
  date: IsoDate;
}

export function sessionState(t: number): SessionState {
  const c = etClock(t);
  ensureDaysThrough(c.date);
  if (simTradingDay(c.date)) {
    const idx = DAY_INDEX.get(c.date)!;
    const L = simSessionMinutes(c.date);
    const into = c.minutes - REGULAR_OPEN_MIN + c.ss / 60;
    if (into < 0) return { idx: Math.max(0, idx - 1), m: null, phase: "pre", date: c.date };
    if (into < L) return { idx, m: into, phase: "open", date: c.date };
    return { idx, m: null, phase: "post", date: c.date };
  }
  let d = addDays(c.date, -1);
  while (!DAY_INDEX.has(d) && d >= EPOCH) d = addDays(d, -1);
  return { idx: DAY_INDEX.get(d) ?? 0, m: null, phase: "closed", date: c.date };
}

function sessionOpenMsOf(idx: number): number {
  return etWallToEpochMs(DAYS[idx], REGULAR_OPEN_MIN);
}

function sessionCloseMsOf(idx: number): number {
  return etWallToEpochMs(DAYS[idx], REGULAR_OPEN_MIN + simSessionMinutes(DAYS[idx]));
}

// ── Factors ─────────────────────────────────────────────────────────────────

const PHI = 0.985; // daily mean reversion of each log level
const _daily = new Map<string, number[]>();
const _intra = new Map<string, Float64Array>();
const INTRA_CAP = 800;

/** Daily closing log level of a factor at session idx. */
function dailyX(seed: string, sigma: number, idx: number): number {
  if (idx < 0) return 0;
  const key = `${seed}|${sigma}`;
  let arr = _daily.get(key);
  if (!arr) {
    arr = [];
    _daily.set(key, arr);
  }
  while (arr.length <= idx) {
    const i = arr.length;
    const prev = i ? arr[i - 1] : 0;
    arr.push(PHI * prev + sigma * normal(`${seed}:d:${DAYS[i]}`));
  }
  return arr[idx];
}

/** Intraday log-level path of a factor for session idx, one point per minute (0..L). */
function intradayPath(seed: string, sigma: number, idx: number): Float64Array {
  const date = DAYS[idx];
  const key = `${seed}|${sigma}|${date}`;
  const hit = _intra.get(key);
  if (hit) return hit;
  const L = simSessionMinutes(date);
  const r = mulberry32(hash32(`${seed}:i:${date}`));
  const prev = dailyX(seed, sigma, idx - 1);
  const close = dailyX(seed, sigma, idx);
  const open = prev + 0.3 * sigma * normalFrom(r);
  const w = new Float64Array(L + 1);
  for (let k = 1; k <= L; k++) w[k] = w[k - 1] + normalFrom(r);
  const s = (0.9 * sigma) / Math.sqrt(L);
  const out = new Float64Array(L + 1);
  for (let k = 0; k <= L; k++) {
    const f = k / L;
    out[k] = open + (close - open) * f + s * (w[k] - f * w[L]);
  }
  if (_intra.size >= INTRA_CAP) _intra.delete(_intra.keys().next().value as string);
  _intra.set(key, out);
  return out;
}

/** Factor log level at session idx: minute m (fractional), or the close when m is null. */
function factor(seed: string, sigma: number, idx: number, m: number | null): number {
  if (m == null) return dailyX(seed, sigma, idx);
  const p = intradayPath(seed, sigma, idx);
  const L = p.length - 1;
  const x = Math.max(0, Math.min(L, m));
  const k = Math.floor(x);
  if (k >= L) return p[L];
  return p[k] + (x - k) * (p[k + 1] - p[k]);
}

const MKT_SIGMA = 0.0085;
const mkt = (idx: number, m: number | null) => factor("mkt", MKT_SIGMA, idx, m);

// ── Symbols ─────────────────────────────────────────────────────────────────

type Kind = "index" | "equity" | "vol" | "breadth";
interface Spec {
  kind: Kind;
  base: number;
  beta: number;
  idio: number;
  idioSeed: string;
  /** Average daily share volume (0 for indexes). */
  volume: number;
  /** Option IV relative to SPX ATM IV. */
  ivMult: number;
  description: string;
}

const EQ = (base: number, beta: number, idio: number, volume: number, ivMult: number, description: string, idioSeed?: string): Omit<Spec, "kind" | "idioSeed"> & { idioSeed?: string } =>
  ({ base, beta, idio, volume, ivMult, description, idioSeed });

const TABLE: Record<string, { kind: Kind } & Omit<Spec, "kind" | "idioSeed"> & { idioSeed?: string }> = {
  $SPX: { kind: "index", ...EQ(6950, 1, 0, 0, 1, "S&P 500 Index") },
  $XSP: { kind: "index", ...EQ(695, 1, 0, 0, 1, "Mini S&P 500 Index") },
  $NDX: { kind: "index", ...EQ(25400, 1.2, 0.004, 0, 1.22, "Nasdaq-100 Index", "QQQ") },
  $COMPX: { kind: "index", ...EQ(23200, 1.15, 0.0035, 0, 1.2, "Nasdaq Composite", "QQQ") },
  $RUT: { kind: "index", ...EQ(2420, 1.25, 0.006, 0, 1.35, "Russell 2000 Index", "IWM") },
  $DJI: { kind: "index", ...EQ(46800, 0.85, 0.003, 0, 0.95, "Dow Jones Industrial Average", "DIA") },
  SPY: { kind: "equity", ...EQ(693, 1, 0, 68e6, 1, "SPDR S&P 500 ETF") },
  QQQ: { kind: "equity", ...EQ(618, 1.2, 0.004, 45e6, 1.22, "Invesco QQQ Trust", "QQQ") },
  IWM: { kind: "equity", ...EQ(241, 1.25, 0.006, 32e6, 1.35, "iShares Russell 2000 ETF", "IWM") },
  DIA: { kind: "equity", ...EQ(468, 0.85, 0.003, 4e6, 0.95, "SPDR Dow Jones ETF", "DIA") },
  AAPL: { kind: "equity", ...EQ(252, 1.05, 0.011, 52e6, 1.5, "Apple Inc") },
  MSFT: { kind: "equity", ...EQ(515, 1.0, 0.010, 21e6, 1.4, "Microsoft Corp") },
  NVDA: { kind: "equity", ...EQ(188, 1.6, 0.020, 180e6, 2.5, "NVIDIA Corp") },
  AMZN: { kind: "equity", ...EQ(228, 1.2, 0.014, 40e6, 1.8, "Amazon.com Inc") },
  GOOGL: { kind: "equity", ...EQ(246, 1.1, 0.013, 30e6, 1.7, "Alphabet Inc Class A", "GOOG") },
  GOOG: { kind: "equity", ...EQ(247, 1.1, 0.013, 22e6, 1.7, "Alphabet Inc Class C", "GOOG") },
  META: { kind: "equity", ...EQ(722, 1.3, 0.016, 13e6, 2.0, "Meta Platforms Inc") },
  TSLA: { kind: "equity", ...EQ(436, 1.8, 0.028, 95e6, 3.2, "Tesla Inc") },
  AVGO: { kind: "equity", ...EQ(342, 1.5, 0.018, 25e6, 2.2, "Broadcom Inc") },
  AMD: { kind: "equity", ...EQ(214, 1.7, 0.022, 50e6, 2.8, "Advanced Micro Devices") },
  NFLX: { kind: "equity", ...EQ(1210, 1.1, 0.016, 4e6, 2.0, "Netflix Inc") },
  JPM: { kind: "equity", ...EQ(304, 0.9, 0.010, 9e6, 1.3, "JPMorgan Chase & Co") },
  XLK: { kind: "equity", ...EQ(282, 1.2, 0.005, 8e6, 1.3, "Technology Select Sector SPDR") },
  XLF: { kind: "equity", ...EQ(53, 0.95, 0.005, 40e6, 1.2, "Financial Select Sector SPDR") },
  XLE: { kind: "equity", ...EQ(89, 0.6, 0.011, 15e6, 1.5, "Energy Select Sector SPDR") },
  XLV: { kind: "equity", ...EQ(141, 0.6, 0.006, 8e6, 1.0, "Health Care Select Sector SPDR") },
  XLI: { kind: "equity", ...EQ(152, 0.95, 0.005, 9e6, 1.1, "Industrial Select Sector SPDR") },
  XLY: { kind: "equity", ...EQ(236, 1.15, 0.006, 4e6, 1.3, "Consumer Discretionary Select Sector SPDR") },
  XLP: { kind: "equity", ...EQ(79, 0.45, 0.005, 9e6, 0.8, "Consumer Staples Select Sector SPDR") },
  XLU: { kind: "equity", ...EQ(86, 0.4, 0.007, 11e6, 0.9, "Utilities Select Sector SPDR") },
  XLB: { kind: "equity", ...EQ(91, 0.9, 0.006, 6e6, 1.1, "Materials Select Sector SPDR") },
  XLRE: { kind: "equity", ...EQ(42, 0.7, 0.007, 7e6, 1.0, "Real Estate Select Sector SPDR") },
  XLC: { kind: "equity", ...EQ(115, 1.05, 0.006, 5e6, 1.2, "Communication Services Select Sector SPDR") },
  SMH: { kind: "equity", ...EQ(318, 1.6, 0.012, 7e6, 2.0, "VanEck Semiconductor ETF") },
  TLT: { kind: "equity", ...EQ(90, -0.15, 0.006, 35e6, 0.8, "iShares 20+ Year Treasury Bond ETF") },
  GLD: { kind: "equity", ...EQ(372, 0.05, 0.009, 9e6, 0.9, "SPDR Gold Shares") },
  HYG: { kind: "equity", ...EQ(80, 0.25, 0.002, 30e6, 0.5, "iShares High Yield Corporate Bond ETF") },
  UUP: { kind: "equity", ...EQ(27, -0.1, 0.003, 3e6, 0.5, "Invesco DB US Dollar Index Bullish Fund") },
};

const VOLS: Record<string, string> = {
  $VIX: "CBOE Volatility Index (sample)",
  $VIX1D: "CBOE 1-Day Volatility Index (sample)",
  $VIX9D: "CBOE 9-Day Volatility Index (sample)",
  $VIX3M: "CBOE 3-Month Volatility Index (sample)",
  $VVIX: "CBOE VIX of VIX (sample)",
  $SKEW: "CBOE SKEW Index (sample)",
  $VXN: "CBOE Nasdaq-100 Volatility Index (sample)",
  $RVX: "CBOE Russell 2000 Volatility Index (sample)",
};
const BREADTH = new Set(["$ADVN", "$DECN", "$UVOL", "$DVOL", "$TICK", "$TRIN", "$ADD"]);

function specFor(sym: string): Spec | null {
  const t = TABLE[sym];
  if (t) return { ...t, idioSeed: t.idioSeed ?? sym };
  if (sym in VOLS) return { kind: "vol", base: 0, beta: 0, idio: 0, idioSeed: sym, volume: 0, ivMult: 0, description: VOLS[sym] };
  if (BREADTH.has(sym)) return { kind: "breadth", base: 0, beta: 0, idio: 0, idioSeed: sym, volume: 0, ivMult: 0, description: `${sym} (sample)` };
  if (!/^[A-Z][A-Z.]{0,5}$/.test(sym)) return null; // futures, other indexes: unavailable
  const h = hash32(sym);
  return {
    kind: "equity",
    base: 20 + (h % 480),
    beta: 0.8 + ((h >>> 9) % 80) / 100,
    idio: 0.012 + ((h >>> 3) % 12) / 1000,
    idioSeed: sym,
    volume: 2e6 + ((h >>> 5) % 30) * 1e6,
    ivMult: 1.4 + ((h >>> 7) % 15) / 10,
    description: `${sym} (sample)`,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function vixLevel(idx: number, m: number | null): number {
  return clamp(16 * Math.exp(-6 * mkt(idx, m) + factor("VIX", 0.045, idx, m)), 9.5, 60);
}

/** Price (or index level) of a symbol at session idx, minute m (null = close). */
function level(sym: string, spec: Spec, idx: number, m: number | null): number {
  if (spec.kind === "index" || spec.kind === "equity") {
    let x = Math.log(spec.base) + spec.beta * mkt(idx, m);
    if (spec.idio > 0) x += factor(spec.idioSeed, spec.idio, idx, m);
    return Math.exp(x);
  }
  if (spec.kind === "vol") {
    const vix = vixLevel(idx, m);
    switch (sym) {
      case "$VIX": return vix;
      case "$VIX1D": return vix * 0.84 * Math.exp(factor("VIX1D", 0.06, idx, m));
      case "$VIX9D": return vix * 0.93 * Math.exp(factor("VIX9D", 0.02, idx, m));
      case "$VIX3M": return vix * (1.13 - 0.012 * (vix - 16)) * Math.exp(factor("VIX3M", 0.01, idx, m));
      case "$VVIX": return (72 + 1.25 * vix) * Math.exp(factor("VVIX", 0.03, idx, m));
      case "$SKEW": return 141 * Math.exp(factor("SKEW", 0.015, idx, m));
      case "$VXN": return vix * 1.22 * Math.exp(factor("VXN", 0.02, idx, m));
      default: return vix * 1.32 * Math.exp(factor("RVX", 0.02, idx, m));
    }
  }
  // Breadth: from the market's move since the prior close.
  const dr = mkt(idx, m) - mkt(idx - 1, null);
  const noise = 25 * factor("breadth", 1, idx, m);
  const adv = Math.round(clamp(1700 + 1300 * Math.tanh(dr / 0.007) + noise, 150, 3300));
  const dec = Math.max(100, 3450 - adv - 120);
  const L = simSessionMinutes(DAYS[idx]);
  const prog = volumeProgress(m == null ? 1 : m / L);
  const upShare = clamp(0.5 + 0.42 * Math.tanh(dr / 0.007), 0.04, 0.96);
  const total = 4.5e9 * prog;
  switch (sym) {
    case "$ADVN": return adv;
    case "$DECN": return dec;
    case "$ADD": return adv - dec;
    case "$UVOL": return Math.round(total * upShare);
    case "$DVOL": return Math.round(total * (1 - upShare));
    case "$TICK": {
      const mm = m == null ? L : m;
      const d5 = mkt(idx, mm) - mkt(idx, Math.max(0, mm - 5));
      return Math.round(clamp(900 * Math.tanh(d5 / 0.0009), -1600, 1600));
    }
    default: return Number(((adv / dec) / Math.max(0.05, upShare / (1 - upShare))).toFixed(2)); // $TRIN
  }
}

/** Share of the day's volume traded by fraction x of the session (U-shaped profile). */
export function volumeProgress(x: number): number {
  const c = (y: number) => y + 3 * 0.05 * (1 - Math.exp(-y / 0.05)) + 2 * 0.04 * (Math.exp(-(1 - y) / 0.04) - Math.exp(-1 / 0.04));
  const xx = clamp(x, 0, 1);
  return c(xx) / c(1);
}

function dailyVolume(sym: string, spec: Spec, idx: number): number {
  return Math.round(spec.volume * Math.exp(0.25 * normal(`${sym}:v:${DAYS[idx]}`)));
}

const r2 = (x: number) => Math.round(x * 100) / 100;

// ── Quotes ──────────────────────────────────────────────────────────────────

/** OHLC of session idx up to minute m (null = full session). */
function sessionOhlc(sym: string, spec: Spec, idx: number, m: number | null) {
  const L = simSessionMinutes(DAYS[idx]);
  const end = m == null ? L : Math.min(L, m);
  const open = level(sym, spec, idx, 0);
  let hi = open;
  let lo = open;
  for (let k = 1; k <= Math.floor(end); k++) {
    const p = level(sym, spec, idx, k);
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  const last = level(sym, spec, idx, m == null ? null : end);
  return { open, high: Math.max(hi, last), low: Math.min(lo, last), last };
}

function fiftyTwoWeek(sym: string, spec: Spec, idx: number): { hi: number; lo: number } {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = Math.max(0, idx - 251); i <= idx; i++) {
    const p = level(sym, spec, i, null);
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  return { hi, lo };
}

export function demoQuote(sym: string, t: number): any | null {
  const spec = specFor(sym);
  if (!spec) return null;
  const st = sessionState(t);
  const idx = st.idx;
  let last: number;
  let prevClose: number;
  let ohlc: { open: number; high: number; low: number };
  let volume: number;
  let quoteTime: number;
  if (st.phase === "open") {
    const o = sessionOhlc(sym, spec, idx, st.m);
    last = o.last;
    ohlc = o;
    prevClose = level(sym, spec, idx - 1, null);
    volume = Math.round(dailyVolume(sym, spec, idx) * volumeProgress(st.m! / simSessionMinutes(DAYS[idx])));
    quoteTime = Math.floor(t / 1000) * 1000;
  } else if (st.phase === "pre") {
    last = level(sym, spec, idx, null);
    prevClose = last;
    ohlc = { open: last, high: last, low: last };
    volume = 0;
    quoteTime = sessionCloseMsOf(idx);
  } else {
    const o = sessionOhlc(sym, spec, idx, null);
    last = o.last;
    ohlc = o;
    prevClose = level(sym, spec, idx - 1, null);
    volume = dailyVolume(sym, spec, idx);
    quoteTime = sessionCloseMsOf(idx);
  }
  const isBreadthCount = spec.kind === "breadth";
  const round = (x: number) => (isBreadthCount ? Math.round(x * 100) / 100 : r2(x));
  const change = round(last - prevClose);
  const pct = prevClose ? r2(((last - prevClose) / prevClose) * 100) : 0;
  const w52 = spec.kind === "breadth" ? { hi: last, lo: last } : fiftyTwoWeek(sym, spec, idx);
  const q: Record<string, any> = {
    "52WeekHigh": round(Math.max(w52.hi, last)),
    "52WeekLow": round(Math.min(w52.lo, last)),
    closePrice: round(prevClose),
    highPrice: round(ohlc.high),
    lastPrice: round(last),
    lowPrice: round(ohlc.low),
    mark: round(last),
    markChange: change,
    markPercentChange: pct,
    netChange: change,
    netPercentChange: pct,
    openPrice: round(ohlc.open),
    quoteTime,
    securityStatus: "Normal",
    totalVolume: volume,
    tradeTime: quoteTime,
  };
  if (spec.kind === "equity") {
    const spread = last < 300 ? 0.01 : 0.02;
    const bid = r2(last - spread / 2);
    q.bidPrice = bid;
    q.askPrice = r2(bid + spread);
    q.bidSize = 1 + Math.floor(uniform(`${sym}:bs:${quoteTime}`) * 9);
    q.askSize = 1 + Math.floor(uniform(`${sym}:as:${quoteTime}`) * 9);
    q.lastSize = 100;
  }
  return {
    assetMainType: spec.kind === "equity" ? "EQUITY" : "INDEX",
    symbol: sym,
    realtime: true,
    quoteType: "NBBO",
    quote: q,
    reference: { description: `${spec.description} - ${DEMO_DISCLOSURE}`, exchangeName: spec.kind === "equity" ? "NYSE" : "IND" },
  };
}

function demoQuotes(params: Record<string, string | number> | undefined, t: number): any {
  const out: Record<string, any> = {};
  const list = String(params?.symbols ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of list) {
    const q = demoQuote(s, t);
    if (q) out[s] = q;
  }
  return out;
}

// ── Price history ───────────────────────────────────────────────────────────

type Candle = { open: number; high: number; low: number; close: number; volume: number; datetime: number };

function minuteCandles(sym: string, spec: Spec, idx: number, upTo: number | null): Candle[] {
  const L = simSessionMinutes(DAYS[idx]);
  const n = upTo == null ? L : Math.min(L, Math.floor(upTo));
  const openMs = sessionOpenMsOf(idx);
  const dv = spec.volume ? dailyVolume(sym, spec, idx) : 0;
  const out: Candle[] = [];
  const sig = 0.35 * (spec.kind === "index" || spec.kind === "equity" ? MKT_SIGMA * Math.max(0.5, Math.abs(spec.beta)) : 0.02) / Math.sqrt(L);
  for (let k = 0; k < n; k++) {
    const o = level(sym, spec, idx, k);
    const c = level(sym, spec, idx, k + 1);
    const u1 = Math.abs(normal(`${sym}:h:${DAYS[idx]}:${k}`));
    const u2 = Math.abs(normal(`${sym}:l:${DAYS[idx]}:${k}`));
    const v = dv ? Math.round(dv * (volumeProgress((k + 1) / L) - volumeProgress(k / L)) * (0.7 + 0.6 * uniform(`${sym}:mv:${DAYS[idx]}:${k}`))) : 0;
    out.push({
      open: r2(o),
      high: r2(Math.max(o, c) * Math.exp(sig * u1)),
      low: r2(Math.min(o, c) * Math.exp(-sig * u2)),
      close: r2(c),
      volume: v,
      datetime: openMs + k * 60_000,
    });
  }
  return out;
}

function aggregate(candles: Candle[], keyOf: (c: Candle) => string | number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curKey: string | number | null = null;
  for (const c of candles) {
    const k = keyOf(c);
    if (cur && k === curKey) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    } else {
      if (cur) out.push(cur);
      cur = { ...c };
      curKey = k;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function dailyCandle(sym: string, spec: Spec, idx: number, m: number | null, exact: boolean): Candle {
  // exact: OHLC from the intraday path (recent sessions, so it matches the
  // quote and the minute bars); older sessions use a seeded wick.
  const o = m != null || exact ? sessionOhlc(sym, spec, idx, m) : null;
  const open = level(sym, spec, idx, 0);
  const close = o ? o.last : level(sym, spec, idx, null);
  let high: number;
  let low: number;
  if (o) {
    high = o.high;
    low = o.low;
  } else {
    // Full intraday paths only for recent sessions; older days use a seeded wick.
    const sigD = spec.kind === "index" || spec.kind === "equity" ? MKT_SIGMA * Math.max(0.5, Math.abs(spec.beta)) + spec.idio : 0.05;
    high = Math.max(open, close) * Math.exp(0.35 * sigD * Math.abs(normal(`${sym}:dh:${DAYS[idx]}`)));
    low = Math.min(open, close) * Math.exp(-0.35 * sigD * Math.abs(normal(`${sym}:dl:${DAYS[idx]}`)));
  }
  const fullVol = spec.volume ? dailyVolume(sym, spec, idx) : 0;
  const volume = m == null ? fullVol : Math.round(fullVol * volumeProgress(m / simSessionMinutes(DAYS[idx])));
  return { open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume, datetime: etWallToEpochMs(DAYS[idx], 60) };
}

export function demoPriceHistory(params: Record<string, string | number> | undefined, t: number): any {
  const sym = String(params?.symbol ?? "");
  const spec = specFor(sym);
  if (!spec || spec.kind === "breadth") return { symbol: sym, empty: true, candles: [] };
  const periodType = String(params?.periodType ?? "day");
  const frequencyType = String(params?.frequencyType ?? (periodType === "day" ? "minute" : "daily"));
  const frequency = Math.max(1, Number(params?.frequency ?? 1) || 1);
  const endMs = Math.min(t, Number(params?.endDate ?? t) || t);
  const startMs = params?.startDate != null ? Number(params.startDate) : null;
  const st = sessionState(endMs);
  // Sessions that have started by endMs: through st.idx, plus today when open/post.
  const lastIdx = st.idx;
  const lastM = st.phase === "open" ? st.m : null;
  const periodRaw = Number(params?.period);
  let candles: Candle[] = [];

  if (frequencyType === "minute") {
    const days = Math.max(1, Math.min(10, Number.isFinite(periodRaw) && periodRaw > 0 ? periodRaw : 1));
    const firstIdx = Math.max(0, lastIdx - days + 1);
    for (let i = firstIdx; i <= lastIdx; i++) {
      const bars = minuteCandles(sym, spec, i, i === lastIdx ? lastM : null);
      const openMs = sessionOpenMsOf(i);
      candles.push(...(frequency > 1 ? aggregate(bars, (c) => Math.floor((c.datetime - openMs) / 60_000 / frequency)) : bars));
    }
  } else {
    let n: number;
    const p = Number.isFinite(periodRaw) && periodRaw > 0 ? periodRaw : 1;
    if (periodType === "month") n = 21 * p;
    else if (periodType === "ytd") n = lastIdx - (DAYS.findIndex((d) => d.slice(0, 4) === DAYS[lastIdx].slice(0, 4))) + 1;
    else if (periodType === "day") n = p;
    else n = 252 * p;
    const firstIdx = Math.max(0, lastIdx - n + 1);
    for (let i = firstIdx; i <= lastIdx; i++) candles.push(dailyCandle(sym, spec, i, i === lastIdx ? lastM : null, lastIdx - i < 10));
    if (frequencyType === "weekly") {
      candles = aggregate(candles, (c) => {
        const d = etClock(c.datetime).date;
        return addDays(d, -((dayOfWeek(d) + 6) % 7));
      });
    } else if (frequencyType === "monthly") {
      candles = aggregate(candles, (c) => etClock(c.datetime).date.slice(0, 7));
    }
  }
  if (startMs != null && Number.isFinite(startMs)) candles = candles.filter((c) => c.datetime >= startMs);
  candles = candles.filter((c) => c.datetime <= endMs);
  const prevIdx = Math.max(0, lastIdx - 1);
  return {
    symbol: sym,
    empty: candles.length === 0,
    candles,
    previousClose: r2(level(sym, spec, prevIdx, null)),
    previousCloseDate: etWallToEpochMs(DAYS[prevIdx], 60),
  };
}

// ── Option chains ───────────────────────────────────────────────────────────

const OPTION_ROOT: Record<string, string> = { $SPX: "SPXW", $NDX: "NDXP", $RUT: "RUTW", $XSP: "XSP" };
const DAILY_EXPIRY = new Set(["$SPX", "$XSP", "$NDX", "$RUT", "SPY", "QQQ", "IWM"]);
const OI_SCALE: Record<string, number> = { $SPX: 4000, $XSP: 300, $NDX: 400, $RUT: 600, SPY: 9000, QQQ: 7000, IWM: 6000 };
const RATE = 0.042;

function normCdf(x: number): number {
  // erfc approximation (Numerical Recipes erfcc), |error| < 1.2e-7
  const z = Math.abs(x) / Math.SQRT2;
  const tt = 1 / (1 + 0.5 * z);
  const r = tt * Math.exp(-z * z - 1.26551223 + tt * (1.00002368 + tt * (0.37409196 + tt * (0.09678418 + tt * (-0.18628806 + tt * (0.27886807 + tt * (-1.13520398 + tt * (1.48851587 + tt * (-0.82215223 + tt * 0.17087277)))))))));
  return x >= 0 ? 1 - r / 2 : r / 2;
}
const normPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export interface BsResult { price: number; delta: number; gamma: number; theta: number; vega: number; rho: number }

/** Black-Scholes-Merton (European). theta per calendar day, vega and rho per 1 point (1%). */
export function bsm(call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number): BsResult {
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  const eq = Math.exp(-q * T);
  const er = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const gamma = (eq * pdf) / (S * sigma * sq);
  const vega = (S * eq * pdf * sq) / 100;
  const decay = -(S * eq * pdf * sigma) / (2 * sq);
  if (call) {
    return {
      price: S * eq * normCdf(d1) - K * er * normCdf(d2),
      delta: eq * normCdf(d1),
      gamma,
      theta: (decay - r * K * er * normCdf(d2) + q * S * eq * normCdf(d1)) / 365,
      vega,
      rho: (K * T * er * normCdf(d2)) / 100,
    };
  }
  return {
    price: K * er * normCdf(-d2) - S * eq * normCdf(-d1),
    delta: eq * (normCdf(d1) - 1),
    gamma,
    theta: (decay + r * K * er * normCdf(-d2) - q * S * eq * normCdf(-d1)) / 365,
    vega,
    rho: -(K * T * er * normCdf(-d2)) / 100,
  };
}

/** ATM implied vol (decimal) for a tenor in days, from the sample VIX term structure. */
function atmVol(idx: number, m: number | null, days: number): number {
  const pts: Array<[number, number]> = [
    [1, level("$VIX1D", specFor("$VIX1D")!, idx, m)],
    [9, level("$VIX9D", specFor("$VIX9D")!, idx, m)],
    [30, level("$VIX", specFor("$VIX")!, idx, m)],
    [91, level("$VIX3M", specFor("$VIX3M")!, idx, m)],
  ];
  const d = clamp(days, 1, 91);
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, va] = pts[i];
    const [b, vb] = pts[i + 1];
    if (d <= b) {
      const f = (Math.log(d) - Math.log(a)) / (Math.log(b) - Math.log(a));
      return (va + f * (vb - va)) / 100;
    }
  }
  return pts[pts.length - 1][1] / 100;
}

function isThirdFriday(date: IsoDate): boolean {
  const day = Number(date.slice(8, 10));
  return dayOfWeek(date) === 5 && day >= 15 && day <= 21;
}

/** Expiry dates in [from, to]: daily for index/SPY/QQQ/IWM up to 45 days, else weekly (Friday, or Thursday when Friday is a holiday). */
function expiries(sym: string, from: IsoDate, to: IsoDate, today: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  const daily = DAILY_EXPIRY.has(sym);
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!simTradingDay(d)) continue;
    const dte = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    const dow = dayOfWeek(d);
    const weekly = dow === 5 || (dow === 4 && !simTradingDay(addDays(d, 1)));
    if ((daily && dte <= 45) || weekly) out.push(d);
  }
  return out;
}

function occSymbol(root: string, date: IsoDate, call: boolean, strike: number): string {
  const ymd = date.slice(2).replace(/-/g, "");
  const k = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${root.padEnd(6, " ")}${ymd}${call ? "C" : "P"}${k}`;
}

const _chains = new Map<string, { at: number; data: any }>();
const CHAIN_CAP = 6;

export function demoChain(params: Record<string, string | number> | undefined, t: number): any | null {
  const sym = String(params?.symbol ?? "");
  const spec = specFor(sym);
  const optionable = spec && (spec.kind === "equity" || sym in OPTION_ROOT);
  if (!spec || !optionable) return { symbol: sym, status: "FAILED", callExpDateMap: {}, putExpDateMap: {} };
  const minuteKey = Math.floor(t / 60_000);
  const key = `${minuteKey}|${JSON.stringify(params)}`;
  const hit = _chains.get(key);
  if (hit) return hit.data;

  const st = sessionState(t);
  const idx = st.idx;
  const m = st.phase === "open" ? st.m : null;
  const today = etClock(t).date;
  const S = level(sym, spec, idx, st.phase === "pre" ? null : m);
  const Sprev = st.phase === "pre" ? S : level(sym, spec, idx - 1, null);
  const Sopen = st.phase === "pre" ? S : level(sym, spec, idx, 0);
  const q = spec.kind === "index" ? 0.012 : 0.005;
  const spacing = strikeSpacingFor(sym, S);
  const nStrikes = clamp(Math.round(Number(params?.strikeCount ?? 40) || 40), 2, 300);
  const atmK = Math.round(S / spacing) * spacing;
  const below = Math.floor(nStrikes / 2);
  const strikes: number[] = [];
  for (let j = -below; j < nStrikes - below; j++) {
    const k = Number((atmK + j * spacing).toFixed(2));
    if (k > 0) strikes.push(k);
  }
  const from = String(params?.fromDate ?? today);
  const to = String(params?.toDate ?? addDays(today, 60));
  // Today's expiry is gone once its session has closed.
  const sessionOver = st.phase === "post" || st.phase === "closed";
  const exps = expiries(sym, from < today ? today : from, to, today).filter((d) => !(d === today && sessionOver));
  const root = OPTION_ROOT[sym] ?? sym;
  const oiScale = OI_SCALE[sym] ?? 2500;
  const bigStep = spacing * 10;
  const callWall = Math.ceil((Sprev * 1.012) / bigStep) * bigStep;
  const putWall = Math.floor((Sprev * 0.985) / bigStep) * bigStep;
  const tradeDate = DAYS[idx];
  const L = simSessionMinutes(tradeDate);
  const volProg = st.phase === "pre" ? 0 : m == null ? 1 : volumeProgress(m / L);
  const nowQuoteMs = st.phase === "open" ? Math.floor(t / 1000) * 1000 : sessionCloseMsOf(idx);
  const tickOf = (mark: number) =>
    spec.kind === "index" ? (mark >= 3 ? 0.1 : 0.05) : DAILY_EXPIRY.has(sym) || mark < 3 ? 0.01 : 0.05;
  const callMap: Record<string, Record<string, any[]>> = {};
  const putMap: Record<string, Record<string, any[]>> = {};
  let contracts = 0;
  let atmIvFront: number | null = null;

  for (const exp of exps) {
    const expMs = etWallToEpochMs(exp, REGULAR_OPEN_MIN + simSessionMinutes(exp));
    const T = Math.max(expMs - t, 5 * 60_000) / (365 * 86_400_000);
    const dte = Math.max(0, Math.round((Date.parse(`${exp}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000));
    const atm = atmVol(idx, m, Math.max(T * 365, 0.25)) * spec.ivMult;
    if (atmIvFront == null) atmIvFront = atm;
    const F = S * Math.exp((RATE - q) * T);
    const monthly = isThirdFriday(exp);
    const expW = dte === 0 ? 0.7 : monthly ? 2.4 : dayOfWeek(exp) === 5 ? 1.4 : 0.8;
    const ck: Record<string, any[]> = {};
    const pk: Record<string, any[]> = {};
    for (const K of strikes) {
      const mStd = clamp(Math.log(K / F) / (atm * Math.sqrt(Math.max(T, 1 / 365))), -6, 6);
      const skewSlope = spec.kind === "index" ? 0.18 : 0.08;
      const iv = clamp(atm * (1 - skewSlope * mStd + 0.03 * mStd * mStd), atm * 0.5, atm * 4);
      const bell = Math.exp(-0.5 * (mStd / 1.6) ** 2) + 0.08 * Math.exp(-0.5 * (mStd / 3.5) ** 2);
      const roundBoost = K % (bigStep * 2) === 0 ? 2.6 : K % bigStep === 0 ? 1.8 : K % (spacing * 5) === 0 ? 1.3 : 1;
      for (const call of [true, false]) {
        const g = bsm(call, S, K, T, RATE, q, iv);
        const theo = Math.max(0, g.price);
        const tick = tickOf(theo);
        let bid: number;
        let ask: number;
        if (theo < tick / 2) {
          bid = 0;
          ask = tick;
        } else {
          const width = Math.max(tick, Math.ceil((theo * (spec.kind === "index" ? 0.02 : 0.012)) / tick) * tick);
          bid = Math.max(0, Math.floor((theo - width / 2) / tick) * tick);
          ask = bid + width;
        }
        bid = r2(bid);
        ask = r2(ask);
        const mark = r2((bid + ask) / 2);
        const side = call ? (K > S ? 1.15 : 0.55) : K < S ? 1.35 : 0.5;
        const wall = dte <= 30 && ((call && K === callWall) || (!call && K === putWall)) ? 3.5 : 1;
        const rnd = 0.55 + 0.9 * uniform(`${sym}:oi:${exp}:${K}:${call ? "C" : "P"}:${tradeDate}`);
        const oi = Math.round(oiScale * bell * roundBoost * side * expW * wall * rnd);
        const vr = dte === 0 ? 1.6 * Math.exp(-0.5 * (mStd / 1.2) ** 2) + 0.1 : 0.12 * bell + 0.02;
        const vol = Math.round(oi * vr * volProg * (0.5 + uniform(`${sym}:vo:${exp}:${K}:${call ? "C" : "P"}:${tradeDate}`)));
        const closePx = r2(Math.max(0, mark - g.delta * (S - Sprev)));
        const openPx = r2(Math.max(0, mark - g.delta * (S - Sopen)));
        const lastPx = vol > 0 ? r2(Math.max(0, mark + (uniform(`${sym}:lp:${exp}:${K}:${call}:${minuteKey}`) - 0.5) * (ask - bid))) : closePx;
        const contract = {
          putCall: call ? "CALL" : "PUT",
          symbol: occSymbol(root, exp, call, K),
          description: `${root} ${exp} ${K} ${call ? "Call" : "Put"} (sample)`,
          exchangeName: "OPR",
          bid,
          ask,
          last: lastPx,
          mark,
          bidSize: 1 + Math.floor(uniform(`${sym}:bz:${exp}:${K}:${call}:${minuteKey}`) * 40),
          askSize: 1 + Math.floor(uniform(`${sym}:az:${exp}:${K}:${call}:${minuteKey}`) * 40),
          lastSize: vol > 0 ? 1 + Math.floor(uniform(`${sym}:lz:${exp}:${K}:${call}:${minuteKey}`) * 10) : 0,
          highPrice: r2(Math.max(openPx, mark, closePx) * 1.04),
          lowPrice: r2(Math.min(openPx, mark, closePx) * 0.96),
          openPrice: openPx,
          closePrice: closePx,
          totalVolume: vol,
          tradeTimeInLong: vol > 0 ? nowQuoteMs - Math.floor(uniform(`${sym}:tt:${exp}:${K}:${call}:${minuteKey}`) * 50_000) : 0,
          quoteTimeInLong: nowQuoteMs,
          netChange: r2(mark - closePx),
          volatility: r2(iv * 100),
          delta: Number(g.delta.toFixed(3)),
          gamma: Number(g.gamma.toFixed(5)),
          theta: Number(g.theta.toFixed(3)),
          vega: Number(g.vega.toFixed(3)),
          rho: Number(g.rho.toFixed(3)),
          openInterest: oi,
          timeValue: r2(Math.max(0, mark - Math.max(0, call ? S - K : K - S))),
          theoreticalOptionValue: r2(theo),
          theoreticalVolatility: r2(iv * 100),
          strikePrice: K,
          expirationDate: new Date(expMs).toISOString(),
          daysToExpiration: dte,
          expirationType: monthly ? "S" : "W",
          lastTradingDay: expMs,
          multiplier: 100,
          settlementType: "P",
          deliverableNote: "",
          percentChange: closePx > 0 ? r2(((mark - closePx) / closePx) * 100) : 0,
          markChange: r2(mark - closePx),
          markPercentChange: closePx > 0 ? r2(((mark - closePx) / closePx) * 100) : 0,
          inTheMoney: call ? K < S : K > S,
          mini: false,
          nonStandard: false,
          optionRoot: root,
        };
        (call ? ck : pk)[K.toFixed(1)] = [contract];
        contracts++;
      }
    }
    callMap[`${exp}:${dte}`] = ck;
    putMap[`${exp}:${dte}`] = pk;
  }

  const uq = demoQuote(sym, t)?.quote ?? {};
  const data = {
    symbol: sym,
    status: "SUCCESS",
    underlying: {
      symbol: sym,
      description: `${spec.description} - ${DEMO_DISCLOSURE}`,
      change: uq.netChange ?? null,
      percentChange: uq.netPercentChange ?? null,
      close: uq.closePrice ?? null,
      quoteTime: uq.quoteTime ?? nowQuoteMs,
      tradeTime: uq.tradeTime ?? nowQuoteMs,
      bid: uq.bidPrice ?? r2(S),
      ask: uq.askPrice ?? r2(S),
      last: r2(S),
      mark: r2(S),
      openPrice: uq.openPrice ?? null,
      highPrice: uq.highPrice ?? null,
      lowPrice: uq.lowPrice ?? null,
      totalVolume: uq.totalVolume ?? 0,
      exchangeName: spec.kind === "index" ? "IND" : "NYS",
      fiftyTwoWeekHigh: uq["52WeekHigh"] ?? null,
      fiftyTwoWeekLow: uq["52WeekLow"] ?? null,
      delayed: false,
    },
    strategy: "SINGLE",
    interval: 0,
    isDelayed: false,
    isIndex: spec.kind === "index",
    interestRate: RATE * 100,
    underlyingPrice: r2(S),
    volatility: atmIvFront != null ? r2(atmIvFront * 100) : null,
    daysToExpiration: 0,
    dividendYield: q * 100,
    numberOfContracts: contracts,
    assetMainType: spec.kind === "index" ? "INDEX" : "EQUITY",
    isChainTruncated: false,
    callExpDateMap: callMap,
    putExpDateMap: putMap,
  };
  _chains.forEach((v, k) => { if (t - v.at > 120_000) _chains.delete(k); });
  if (_chains.size >= CHAIN_CAP) _chains.delete(_chains.keys().next().value as string);
  _chains.set(key, { at: t, data });
  return data;
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Schwab-shaped payload for a Schwab REST path, or null when Schwab would have
 * nothing (the streamer's userPreference has no demo equivalent).
 */
export function demoSchwabPayload(path: string, params: Record<string, string | number> | undefined, t: number = Date.now()): any | null {
  const p = path.replace(/^\/+/, "").split("?")[0];
  if (p === "marketdata/v1/quotes") return demoQuotes(params, t);
  if (p === "marketdata/v1/pricehistory") return demoPriceHistory(params, t);
  if (p === "marketdata/v1/chains") return demoChain(params, t);
  return null;
}
