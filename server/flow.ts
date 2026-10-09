// server/flow.ts
// Put/Call flow ratio — pluggable provider architecture. Schwab adapter drops
// in later. Current provider: CBOE delayed-quote options endpoints which serve
// full chain snapshots without needing a crumb/cookie (unlike Yahoo).
//
// Ratio convention:
//   pcr = totalPutVolume / totalCallVolume
// Zones are NOT fixed cut-offs: each symbol's ratio is z-scored against its
// own completed Schwab sessions (pcrHistory.ts, review item 4.5); without 20
// recorded sessions the zone is "insufficient_history".
//
// CBOE endpoint: https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
// Returns: { data: { options: [{ option: "SPY250509C00500000", volume, open_interest, ... }] } }
// OCC format: ROOT + YYMMDD + C/P + STRIKE(8 digits) — we parse side from pos[-17].

import { LAST_PRINT_SIDE_NOTE } from "@shared/flowLabels";
import { etDate, isRegularSessionOpen, isTradingDay, sessionCloseMinutes, sessionCloseMs } from "./exchangeCalendar";
import { pcrReadFromHistory, type PcrRead, type PcrZone } from "./pcrHistory";
import { loadPcrHistory, recordPcrSnapshot } from "./pcrHistoryStore";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

export type FlowTicker = {
  symbol: string;
  label: string;
  spot: number | null;
  putVol: number;
  callVol: number;
  putOI: number;
  callOI: number;
  pcrVolume: number | null;
  pcrOI: number | null;
  changeFromOpen: number | null;
  /** Zone vs this symbol's own history (pcrHistory.ts); never a fixed cut-off. */
  zone: PcrZone;
  /** z-score detail behind `zone` (added; absent until attachPcrHistory runs). */
  pcrRead?: PcrRead;
  asOf: number;
};

export type FlowResponse = {
  provider: "cboe" | "schwab"; // TODO: Schwab-only mode — yahoo provider removed
  indexGroup: FlowTicker[];
  mag7Group: FlowTicker[];
  aggregate: {
    indexPcr: number | null;
    mag7Pcr: number | null;
    combinedPcr: number | null;
    zone: PcrZone;
    pcrRead?: PcrRead;
  };
  cboe: {
    equityPcr: number | null;
    indexPcr: number | null;
    totalPcr: number | null;
    asOf: number | null;
  };
  intradaySeries: {
    t: number;
    combined: number;
    index: number;
    mag7: number;
  }[];
  warnings: string[];
  asOf: number;
};

const INDEX_SYMBOLS: { symbol: string; label: string; cboeSymbol: string }[] = [
  { symbol: "SPY", label: "SPY", cboeSymbol: "SPY" },
  { symbol: "QQQ", label: "QQQ", cboeSymbol: "QQQ" },
  { symbol: "IWM", label: "IWM", cboeSymbol: "IWM" },
  // VIX is weird — CBOE's delayed-quote endpoint doesn't serve VIX options the
  // same way. We use ^VIX pricing (Yahoo) for the spot display but mark volume
  // as 0 (VIX options are a separate product space).
  { symbol: "^VIX", label: "VIX", cboeSymbol: "_VIX" },
];

const MAG7_SYMBOLS: { symbol: string; label: string; cboeSymbol: string }[] = [
  { symbol: "AAPL", label: "AAPL", cboeSymbol: "AAPL" },
  { symbol: "MSFT", label: "MSFT", cboeSymbol: "MSFT" },
  { symbol: "NVDA", label: "NVDA", cboeSymbol: "NVDA" },
  { symbol: "GOOGL", label: "GOOGL", cboeSymbol: "GOOGL" },
  { symbol: "META", label: "META", cboeSymbol: "META" },
  { symbol: "AMZN", label: "AMZN", cboeSymbol: "AMZN" },
  { symbol: "TSLA", label: "TSLA", cboeSymbol: "TSLA" },
];

async function cboeFetch(cboeSymbol: string, timeoutMs = 10_000): Promise<any> {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(cboeSymbol)}.json`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`CBOE ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// Parse OCC-style option symbol. Returns 'C' or 'P' or null.
// Format: ROOT(1-6 letters) + YYMMDD + C/P + STRIKE(8 digits). Total length
// varies, but the side flag is exactly at position length - 9.
const OCC_RE = /^[A-Z]+\d{6}([CP])\d{8}$/;
function parseSide(name: string): "C" | "P" | null {
  const m = OCC_RE.exec(name);
  return m ? (m[1] as "C" | "P") : null;
}

// Placeholder until attachPcrHistory z-scores the ratio against the symbol's
// own history: missing volume is "unavailable", never "neutral".
function zoneFor(pcr: number | null): PcrZone {
  return pcr == null ? "unavailable" : "insufficient_history";
}

async function fetchTickerFlow(
  symbol: string,
  label: string,
  cboeSymbol: string,
): Promise<FlowTicker> {
  let spot: number | null = null;
  let prevClose: number | null = null;
  let putVol = 0, callVol = 0, putOI = 0, callOI = 0;

  try {
    const d = await cboeFetch(cboeSymbol);
    const data = d?.data;
    if (data) {
      spot = typeof data.current_price === "number" ? data.current_price : null;
      prevClose = typeof data.prev_day_close === "number" ? data.prev_day_close : null;
      const opts: any[] = data.options || [];
      for (const o of opts) {
        const side = parseSide(String(o.option || ""));
        if (!side) continue;
        const v = Number(o.volume || 0);
        const oi = Number(o.open_interest || 0);
        if (side === "P") { putVol += v; putOI += oi; }
        else { callVol += v; callOI += oi; }
      }
    }
  } catch (_) {
    // swallow — return nulls below
  }

  const pcrVolume = callVol > 0 ? putVol / callVol : null;
  const pcrOI = callOI > 0 ? putOI / callOI : null;
  const changeFromOpen =
    spot != null && prevClose ? ((spot - prevClose) / prevClose) * 100 : null;

  return {
    symbol,
    label,
    spot,
    putVol,
    callVol,
    putOI,
    callOI,
    pcrVolume,
    pcrOI,
    changeFromOpen,
    zone: zoneFor(pcrVolume),
    asOf: Math.floor(Date.now() / 1000),
  };
}

// Intraday ring buffer — last 120 samples (≈20 min at 10s poll).
const RING_MAX = 120;
type Sample = { t: number; combined: number; index: number; mag7: number };
let intradayRing: Sample[] = [];

// ─── Intraday call/put volume tracker ─────────────────────────────────────
// Maintains per-ticker rolling cumulative volume buffers. Each sample is a
// {timeLabel, cumulativeCallVol, cumulativePutVol, pcRatio} snapshot.
// Resets daily at market open (4:00 AM ET transition check).

export interface IntradayVolSample {
  t: number;             // epoch seconds
  timeLabel: string;     // "9:30", "10:00", etc.
  callVolume: number;    // cumulative calls from open
  putVolume: number;     // cumulative puts from open
  pcRatio: number | null;
  // Last-print-side cumulative volumes: each contract's whole day volume tagged
  // by its latest print vs the current bid/ask (not trade-by-trade aggressor data)
  boughtCallVol: number;
  soldCallVol: number;
  unknownCallVol: number;
  boughtPutVol: number;
  soldPutVol: number;
  unknownPutVol: number;
  // Cumulative premium paid ($) — dollar-weighted conviction
  boughtCallPrem: number;
  soldCallPrem: number;
  boughtPutPrem: number;
  soldPutPrem: number;
}

export interface AggressorBreakdown {
  // Volumes
  boughtCallVol: number;
  soldCallVol: number;
  unknownCallVol: number;
  boughtPutVol: number;
  soldPutVol: number;
  unknownPutVol: number;
  // Premium in $ (volume * last * 100)
  boughtCallPrem: number;
  soldCallPrem: number;
  boughtPutPrem: number;
  soldPutPrem: number;
  // Classified percentage (share of vol we could classify vs unknown)
  classifiedPct: number;
}

export interface IntradayFlowTicker {
  symbol: string;
  label: string;
  series: IntradayVolSample[];
  currentCallVol: number;
  currentPutVol: number;
  currentPcr: number | null;
  isEstimated: boolean; // true until real rolling sampler kicks in
  // Classification of the snapshot
  aggressor: AggressorBreakdown;
  // Convenience: total overall contract volume (calls + puts)
  totalVol: number;
  totalPrem: number;
  // Net aggressor score: (boughtCall + soldPut) - (soldCall + boughtPut)
  // positive = bullish aggression, negative = bearish aggression (premium $)
  // Field names are historical; "bought"/"sold" mean ask-side/bid-side by last print.
  netAggressorPrem: number;
  /** "live" = classified from this poll's chain; "cached" = fetch failed, last good
   *  breakdown reused; "unavailable" = no chain data (breakdown zeros are placeholders). */
  aggressorState: "live" | "cached" | "unavailable";
  /** Honest label for the side classification shown in the UI. */
  sideMethod: string;
}

export interface IntradayFlowResponse {
  tickers: IntradayFlowTicker[];
  asOf: string;
  marketOpen: boolean;
  estimated: boolean;
}

// Per-ticker volume buffer: symbol → array of { t, callVolume, putVolume }
interface VolBuffer {
  lastResetDay: string; // YYYY-MM-DD ET
  samples: IntradayVolSample[];
  lastCallVol: number;
  lastPutVol: number;
  lastAggressor: AggressorBreakdown | null;
}
const volBuffers = new Map<string, VolBuffer>();

const INTRADAY_TICKERS = [
  { symbol: "SPY",  label: "SPY",  cboeSymbol: "SPY"  },
  { symbol: "QQQ",  label: "QQQ",  cboeSymbol: "QQQ"  },
  { symbol: "IWM",  label: "IWM",  cboeSymbol: "IWM"  },
];

function getEtDateString(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" });
}

// Regular session per the exchange calendar (holidays, 13:00 half days).
function isMarketOpen(): boolean {
  return isRegularSessionOpen();
}

function getTimeLabel(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const etStr = d.toLocaleTimeString("en-US", { timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false });
  return etStr;
}

// Synthesize a U-shaped intraday volume distribution when real samples are scarce
// Uses a typical opening/closing volume surge pattern
function synthesizeIntradaySeries(
  totalCallVol: number,
  totalPutVol: number,
  agg: AggressorBreakdown | null,
  now: Date,
): IntradayVolSample[] {
  const samples: IntradayVolSample[] = [];
  // 30-min buckets from 9:30 to today's close (exchange calendar: 13 on a
  // full day, 7 on a 13:00 half day).
  const marketOpenH = 9 * 60 + 30; // minutes since midnight ET
  const marketCloseH = sessionCloseMinutes(etDate(now.getTime())) ?? 16 * 60;
  const nowEt = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const nowMins = nowEt.getHours() * 60 + nowEt.getMinutes();
  // U-curve weights for each 30-min bucket (higher at open/close). On a half
  // day keep the U: the first buckets of the full-day curve plus its last
  // ones, so the cumulative fraction reaches 1 at the real close.
  const FULL_DAY_WEIGHTS = [0.15, 0.09, 0.07, 0.06, 0.06, 0.06, 0.06, 0.07, 0.08, 0.09, 0.10, 0.08, 0.07];
  const nBuckets = Math.max(1, Math.min(FULL_DAY_WEIGHTS.length, Math.round((marketCloseH - marketOpenH) / 30)));
  const weights = nBuckets === FULL_DAY_WEIGHTS.length
    ? FULL_DAY_WEIGHTS
    : [...FULL_DAY_WEIGHTS.slice(0, Math.ceil(nBuckets / 2)), ...FULL_DAY_WEIGHTS.slice(FULL_DAY_WEIGHTS.length - Math.floor(nBuckets / 2))];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // ET-aware 09:30 open epoch. The old version re-parsed an ET wall-clock string as
  // server-local time, so on a UTC host every sample stamp was shifted by the ET offset.
  const marketOpenEpoch = (() => {
    // ET offset from UTC in ms (negative), independent of the host zone.
    const etOffsetMs = nowEt.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const openAsIfUtc = Date.UTC(nowEt.getFullYear(), nowEt.getMonth(), nowEt.getDate(), 9, 30, 0, 0);
    return Math.floor((openAsIfUtc - etOffsetMs) / 1000);
  })();

  for (let i = 0; i < weights.length; i++) {
    const bucketMins = marketOpenH + i * 30;
    if (bucketMins > Math.min(nowMins, marketCloseH)) break;
    const elapsed = (bucketMins - marketOpenH) / 30;
    const t = marketOpenEpoch + elapsed * 1800;
    const fraction = weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / totalWeight;
    // The old "dayFraction" blend was algebraically x*f*d + x*(1-d)*f = x*f, i.e. a no-op.
    // These samples are a synthetic U-curve backfill of today's cumulative volume, not
    // observed intraday prints.
    const cumCall = Math.round(totalCallVol * fraction);
    const cumPut = Math.round(totalPutVol * fraction);
    // Still used (as a genuine scale) by the premium backfill below.
    const dayFraction = Math.min(1, (nowMins - marketOpenH) / (marketCloseH - marketOpenH));
    samples.push({
      t,
      timeLabel: getTimeLabel(t),
      callVolume: cumCall,
      putVolume: cumPut,
      pcRatio: cumCall > 0 ? cumPut / cumCall : null,
      boughtCallVol: Math.round(cumCall * (agg && agg.boughtCallVol + agg.soldCallVol + agg.unknownCallVol > 0 ? agg.boughtCallVol / (agg.boughtCallVol + agg.soldCallVol + agg.unknownCallVol) : 0.5)),
      soldCallVol: Math.round(cumCall * (agg && agg.boughtCallVol + agg.soldCallVol + agg.unknownCallVol > 0 ? agg.soldCallVol / (agg.boughtCallVol + agg.soldCallVol + agg.unknownCallVol) : 0.5)),
      unknownCallVol: agg && agg.boughtCallVol + agg.soldCallVol + agg.unknownCallVol > 0 ? Math.round(cumCall * agg.unknownCallVol / (agg.boughtCallVol + agg.soldCallVol + agg.unknownCallVol)) : 0,
      boughtPutVol: Math.round(cumPut * (agg && agg.boughtPutVol + agg.soldPutVol + agg.unknownPutVol > 0 ? agg.boughtPutVol / (agg.boughtPutVol + agg.soldPutVol + agg.unknownPutVol) : 0.5)),
      soldPutVol: Math.round(cumPut * (agg && agg.boughtPutVol + agg.soldPutVol + agg.unknownPutVol > 0 ? agg.soldPutVol / (agg.boughtPutVol + agg.soldPutVol + agg.unknownPutVol) : 0.5)),
      unknownPutVol: agg && agg.boughtPutVol + agg.soldPutVol + agg.unknownPutVol > 0 ? Math.round(cumPut * agg.unknownPutVol / (agg.boughtPutVol + agg.soldPutVol + agg.unknownPutVol)) : 0,
      boughtCallPrem: agg ? Math.round(agg.boughtCallPrem * fraction * dayFraction) : 0,
      soldCallPrem: agg ? Math.round(agg.soldCallPrem * fraction * dayFraction) : 0,
      boughtPutPrem: agg ? Math.round(agg.boughtPutPrem * fraction * dayFraction) : 0,
      soldPutPrem: agg ? Math.round(agg.soldPutPrem * fraction * dayFraction) : 0,
    });
  }
  return samples;
}

// ─── Last-print side classifier (quote rule on each contract's latest print) ─
// NOT Lee-Ready (which classifies each trade against the prevailing quote):
// the chain snapshot only has the day's cumulative volume and the latest print,
// so the whole day volume of a contract takes the side of its latest print.
// For each contract with volume > 0, classify today's volume as
// buyer-initiated, seller-initiated, or unknown using bid/ask/last price.
//   - last >= ask - eps  → BUY  (paid the offer)
//   - last <= bid + eps  → SELL (hit the bid)
//   - bid < last < ask   → midpoint tiebreak
//   - missing data       → UNKNOWN
// eps = max(0.01, 0.02 * spread). Dollar volume = volume * last * 100.
export function classifyAggressor(options: any[]): AggressorBreakdown {
  const out: AggressorBreakdown = {
    boughtCallVol: 0, soldCallVol: 0, unknownCallVol: 0,
    boughtPutVol: 0, soldPutVol: 0, unknownPutVol: 0,
    boughtCallPrem: 0, soldCallPrem: 0, boughtPutPrem: 0, soldPutPrem: 0,
    classifiedPct: 0,
  };
  for (const o of options) {
    const side = parseSide(String(o?.option || ""));
    if (!side) continue;
    const vol = Number(o.volume || 0);
    if (!vol || vol <= 0) continue;
    const bid = Number(o.bid);
    const ask = Number(o.ask);
    const last = Number(o.last_trade_price);
    const prem = Number.isFinite(last) && last > 0 ? vol * last * 100 : 0;
    let tag: "buy" | "sell" | "unknown" = "unknown";
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 && ask >= bid && Number.isFinite(last) && last > 0) {
      const spread = Math.max(0, ask - bid);
      const eps = Math.max(0.01, 0.02 * spread);
      const mid = (bid + ask) / 2;
      if (last >= ask - eps) tag = "buy";
      else if (last <= bid + eps) tag = "sell";
      else if (last > mid + eps) tag = "buy";
      else if (last < mid - eps) tag = "sell";
      else tag = "unknown";
    }
    if (side === "C") {
      if (tag === "buy")   { out.boughtCallVol += vol; out.boughtCallPrem += prem; }
      else if (tag === "sell") { out.soldCallVol += vol; out.soldCallPrem += prem; }
      else out.unknownCallVol += vol;
    } else {
      if (tag === "buy")   { out.boughtPutVol += vol; out.boughtPutPrem += prem; }
      else if (tag === "sell") { out.soldPutVol += vol; out.soldPutPrem += prem; }
      else out.unknownPutVol += vol;
    }
  }
  const totalVol = out.boughtCallVol + out.soldCallVol + out.unknownCallVol +
                   out.boughtPutVol + out.soldPutVol + out.unknownPutVol;
  const classifiedVol = totalVol - out.unknownCallVol - out.unknownPutVol;
  out.classifiedPct = totalVol > 0 ? (classifiedVol / totalVol) * 100 : 0;
  return out;
}

export async function buildIntradayFlowSnapshot(): Promise<IntradayFlowResponse> {
  const today = getEtDateString();
  const open = isMarketOpen();
  const now = new Date();
  const tickers: IntradayFlowTicker[] = [];
  let anyEstimated = false;

  for (const tk of INTRADAY_TICKERS) {
    // Fetch current snapshot from CBOE
    let callVol = 0, putVol = 0;
    let agg: AggressorBreakdown | null = null;
    let chainRows = 0;
    try {
      const d = await cboeFetch(tk.cboeSymbol, 8_000);
      const opts: any[] = d?.data?.options || [];
      chainRows = opts.length;
      for (const o of opts) {
        const side = parseSide(String(o.option || ""));
        const v = Number(o.volume || 0);
        if (side === "C") callVol += v;
        else if (side === "P") putVol += v;
      }
      agg = classifyAggressor(opts);
    } catch (_) {
      // fallback to buffer if available
    }

    let buf = volBuffers.get(tk.symbol);
    // Reset buffer daily
    if (!buf || buf.lastResetDay !== today) {
      buf = { lastResetDay: today, samples: [], lastCallVol: 0, lastPutVol: 0, lastAggressor: null };
      volBuffers.set(tk.symbol, buf);
    }

    const nowEpoch = Math.floor(now.getTime() / 1000);
    const hasRealData = callVol > 0 || putVol > 0;

    if (hasRealData) {
      // Only add a new sample if time has advanced meaningfully (>= 60s)
      const lastSample = buf.samples[buf.samples.length - 1];
      if (!lastSample || nowEpoch - lastSample.t >= 55) {
        const pcRatio = callVol > 0 ? putVol / callVol : null;
        buf.samples.push({
          t: nowEpoch,
          timeLabel: getTimeLabel(nowEpoch),
          callVolume: callVol,
          putVolume: putVol,
          pcRatio,
          boughtCallVol: agg?.boughtCallVol ?? 0,
          soldCallVol: agg?.soldCallVol ?? 0,
          unknownCallVol: agg?.unknownCallVol ?? 0,
          boughtPutVol: agg?.boughtPutVol ?? 0,
          soldPutVol: agg?.soldPutVol ?? 0,
          unknownPutVol: agg?.unknownPutVol ?? 0,
          boughtCallPrem: agg?.boughtCallPrem ?? 0,
          soldCallPrem: agg?.soldCallPrem ?? 0,
          boughtPutPrem: agg?.boughtPutPrem ?? 0,
          soldPutPrem: agg?.soldPutPrem ?? 0,
        });
        // Keep max 390 samples (1 per minute for 6.5h session)
        if (buf.samples.length > 390) buf.samples.shift();
      }
      buf.lastCallVol = callVol;
      buf.lastPutVol = putVol;
      if (agg) buf.lastAggressor = agg;
    }

    // Use real samples if we have them, else synthesize
    let series: IntradayVolSample[];
    let isEstimated: boolean;
    if (buf.samples.length >= 2) {
      series = [...buf.samples];
      isEstimated = false;
    } else {
      // Synthesize from cumulative total
      const totalCall = hasRealData ? callVol : buf.lastCallVol;
      const totalPut = hasRealData ? putVol : buf.lastPutVol;
      series = synthesizeIntradaySeries(totalCall, totalPut, agg ?? buf.lastAggressor, now);
      isEstimated = true;
      anyEstimated = true;
    }

    const currentCall = hasRealData ? callVol : buf.lastCallVol;
    const currentPut = hasRealData ? putVol : buf.lastPutVol;
    // Data state for the side breakdown: never present a failed fetch as a $0 read.
    const aggressorState: IntradayFlowTicker["aggressorState"] =
      agg && chainRows > 0 ? "live" : !agg && buf.lastAggressor ? "cached" : "unavailable";
    const effectiveAgg: AggressorBreakdown = agg ?? buf.lastAggressor ?? {
      boughtCallVol: 0, soldCallVol: 0, unknownCallVol: 0,
      boughtPutVol: 0, soldPutVol: 0, unknownPutVol: 0,
      boughtCallPrem: 0, soldCallPrem: 0, boughtPutPrem: 0, soldPutPrem: 0,
      classifiedPct: 0,
    };
    const totalVol = currentCall + currentPut;
    const totalPrem = effectiveAgg.boughtCallPrem + effectiveAgg.soldCallPrem + effectiveAgg.boughtPutPrem + effectiveAgg.soldPutPrem;
    // Bullish aggression = bought calls + sold puts (premium paid for upside / premium collected on downside)
    // Bearish aggression = sold calls + bought puts
    // HEURISTIC: classifyAggressor tags a contract's ENTIRE day volume by where its most
    // recent print sat vs the current bid/ask, so this is a last-print proxy, not a
    // trade-by-trade aggressor sum. Treat as directional colour only.
    const netAggressorPrem = (effectiveAgg.boughtCallPrem + effectiveAgg.soldPutPrem)
                           - (effectiveAgg.soldCallPrem + effectiveAgg.boughtPutPrem);

    tickers.push({
      symbol: tk.symbol,
      label: tk.label,
      series,
      currentCallVol: currentCall,
      currentPutVol: currentPut,
      currentPcr: currentCall > 0 ? currentPut / currentCall : null,
      isEstimated,
      aggressor: effectiveAgg,
      totalVol,
      totalPrem,
      netAggressorPrem,
      aggressorState,
      sideMethod: LAST_PRINT_SIDE_NOTE,
    });
  }

  return {
    tickers,
    asOf: new Date().toISOString(),
    marketOpen: open,
    estimated: anyEstimated,
  };
}

function mean(nums: (number | null)[]): number | null {
  const xs = nums.filter((n): n is number => typeof n === "number" && isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ─── Per-symbol P/C history (review item 4.5) ───────────────────────────────
// Records each symbol's day volume from Schwab snapshots and replaces every
// zone with a z-score against that symbol's own completed sessions.
const PCR_COMBINED_KEY = "__COMBINED";

export function attachPcrHistory(resp: FlowResponse, nowMs: number = Date.now()): FlowResponse {
  const today = etDate(nowMs);
  const readFor = (key: string, putVol: number, callVol: number, observed: boolean): PcrRead => {
    if (observed) recordPcrSnapshot({ symbol: key, putVol, callVol, provider: resp.provider, capturedAtMs: nowMs });
    const hist = loadPcrHistory(key, today);
    return pcrReadFromHistory(observed ? { putVol, callVol } : null, hist, { today });
  };
  for (const t of [...resp.indexGroup, ...resp.mag7Group]) {
    const observed = t.putVol + t.callVol > 0 && t.pcrVolume != null;
    const r = readFor(t.symbol, t.putVol, t.callVol, observed);
    t.pcrRead = r;
    t.zone = r.zone;
  }
  let puts = 0, calls = 0;
  for (const t of [...resp.indexGroup, ...resp.mag7Group]) {
    if (t.symbol === "^VIX") continue;
    puts += t.putVol || 0; calls += t.callVol || 0;
  }
  const r = readFor(PCR_COMBINED_KEY, puts, calls, resp.aggregate.combinedPcr != null && puts + calls > 0);
  resp.aggregate.pcrRead = r;
  resp.aggregate.zone = r.zone;
  ensurePcrCloseRecorder();
  return resp;
}

// The day's full-session ratio must be captured in the last minutes of the
// session even when nobody has the panel open: a deterministic timer (no AI)
// rebuilds the snapshot every 5 minutes from 10 minutes before to 15 minutes
// after the close on trading days.
let pcrRecorder: ReturnType<typeof setInterval> | null = null;
function ensurePcrCloseRecorder(): void {
  if (pcrRecorder) return;
  pcrRecorder = setInterval(() => {
    const now = Date.now();
    const d = etDate(now);
    const close = isTradingDay(d) ? sessionCloseMs(d) : null;
    if (close == null || now < close - 10 * 60_000 || now > close + 15 * 60_000) return;
    buildFlowSnapshot().catch((e: any) => console.warn(`[flow] close P/C record failed: ${e?.message ?? e}`));
  }, 5 * 60_000);
  (pcrRecorder as any).unref?.();
}

export async function buildFlowSnapshot(): Promise<FlowResponse> {
  const warnings: string[] = [];

  const indexPromises = INDEX_SYMBOLS.map((s) => fetchTickerFlow(s.symbol, s.label, s.cboeSymbol));
  const mag7Promises = MAG7_SYMBOLS.map((s) => fetchTickerFlow(s.symbol, s.label, s.cboeSymbol));
  const [indexGroup, mag7Group] = await Promise.all([
    Promise.all(indexPromises),
    Promise.all(mag7Promises),
  ]);

  // Exclude VIX from the index aggregate (its options behave differently).
  // Aggregate PCR = sum(puts) / sum(calls) across the group. The old mean-of-ratios let a
  // thin name with 3 puts / 1 call (PCR 3.0) swamp SPX, and it dropped tickers whose
  // pcrVolume was null while still counting the rest.
  const volumePcr = (group: FlowTicker[]): number | null => {
    let puts = 0, calls = 0;
    for (const t of group) { puts += t.putVol || 0; calls += t.callVol || 0; }
    return calls > 0 ? puts / calls : null;
  };
  const indexTickers = indexGroup.filter((t) => t.symbol !== "^VIX");
  const indexPcr = volumePcr(indexTickers);
  const mag7Pcr = volumePcr(mag7Group);
  const combinedPcr = volumePcr([...indexTickers, ...mag7Group]);

  if (indexPcr != null && mag7Pcr != null && combinedPcr != null) {
    const now = Math.floor(Date.now() / 1000);
    if (
      intradayRing.length === 0 ||
      now - intradayRing[intradayRing.length - 1].t >= 8
    ) {
      intradayRing.push({ t: now, combined: combinedPcr, index: indexPcr, mag7: mag7Pcr });
      if (intradayRing.length > RING_MAX) intradayRing.shift();
    }
  } else {
    warnings.push("Intraday aggregate unavailable for at least one group.");
  }

  return attachPcrHistory({
    provider: "cboe",
    indexGroup,
    mag7Group,
    aggregate: {
      indexPcr,
      mag7Pcr,
      combinedPcr,
      zone: zoneFor(combinedPcr),
    },
    cboe: {
      equityPcr: null,
      indexPcr: null,
      totalPcr: null,
      asOf: null,
    },
    intradaySeries: [...intradayRing],
    warnings,
    asOf: Math.floor(Date.now() / 1000),
  });
}
