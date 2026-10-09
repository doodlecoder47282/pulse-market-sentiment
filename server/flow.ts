// server/flow.ts
// Put/Call flow ratio from Schwab option chains (user decision 2026-10-08:
// Schwab is the only market-data source; this was the CBOE delayed chain).
//
// Coverage: the CBOE file held every listed contract. A Schwab chain request
// is bounded, so volumes here are over expiries 0-FLOW_DTE calendar days and
// the strike window getOptionChain requests (at least +-10% of spot; the
// coverage actually delivered is reported per ticker). Most listed-option
// volume is short-dated and near the money, but this is a 0-7 DTE near-money
// put/call ratio, not an all-expiry ratio, and is labelled as such.
//
// Ratio convention:
//   pcr = totalPutVolume / totalCallVolume
// Zones are NOT fixed cut-offs: each symbol's ratio is z-scored against its
// own Schwab history at the same clock time (pcrHistory.ts, review item 4.5,
// SF-5); without 20 recorded sessions the zone is "insufficient_history".
//
// Source rows: schwabChainRows.flattenSchwabChain (side, volume, OI, bid, ask, last).

import { LAST_PRINT_SIDE_NOTE } from "@shared/flowLabels";
import { etDate, isRegularSessionOpen, isTradingDay, sessionCloseMs, sessionOpenMs } from "./exchangeCalendar";
import { pcrReadAtClock, type PcrRead, type PcrZone } from "./pcrHistory";
import { loadPcrSessions, recordPcrSnapshot, sessionMinuteOf } from "./pcrHistoryStore";

import { flattenSchwabChain, chainVolumeTotals, chainSpot, type FlatContract } from "./schwabChainRows";
import {
  aggressorStateOf, currentVolumes, isFreshChain, seriesFrom, shouldAppendSample,
  type ChainRead, type IntradaySeriesState, type IntradayVolumeState,
} from "./flowIntradayState";

/** Expiry window (calendar days) of the chains behind every flow figure. */
export const FLOW_DTE = 7;

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
  /** "ok" = Schwab chain read (zeros are observed zeros); "unavailable" = no chain: volumes are not observed. */
  dataState?: "ok" | "unavailable";
  /** When Schwab produced the chain, epoch ms. */
  chainAsOfMs?: number | null;
  chainStale?: boolean;
};

export type FlowResponse = {
  provider: "schwab";
  /** What the volumes cover (expiry window and strike window). */
  coverage?: string;
  indexGroup: FlowTicker[];
  mag7Group: FlowTicker[];
  aggregate: {
    indexPcr: number | null;
    mag7Pcr: number | null;
    combinedPcr: number | null;
    zone: PcrZone;
    pcrRead?: PcrRead;
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

const INDEX_SYMBOLS: { symbol: string; label: string; chainSymbol: string }[] = [
  { symbol: "SPY", label: "SPY", chainSymbol: "SPY" },
  { symbol: "QQQ", label: "QQQ", chainSymbol: "QQQ" },
  { symbol: "IWM", label: "IWM", chainSymbol: "IWM" },
  // VIX options (Schwab $VIX chain). Excluded from the index aggregate below:
  // they are a separate product space.
  { symbol: "^VIX", label: "VIX", chainSymbol: "$VIX" },
];

const MAG7_SYMBOLS: { symbol: string; label: string; chainSymbol: string }[] = [
  { symbol: "AAPL", label: "AAPL", chainSymbol: "AAPL" },
  { symbol: "MSFT", label: "MSFT", chainSymbol: "MSFT" },
  { symbol: "NVDA", label: "NVDA", chainSymbol: "NVDA" },
  { symbol: "GOOGL", label: "GOOGL", chainSymbol: "GOOGL" },
  { symbol: "META", label: "META", chainSymbol: "META" },
  { symbol: "AMZN", label: "AMZN", chainSymbol: "AMZN" },
  { symbol: "TSLA", label: "TSLA", chainSymbol: "TSLA" },
];

/** Schwab chain for flow (0-FLOW_DTE). null when Schwab cannot answer. */
async function flowChain(chainSymbol: string) {
  const { getOptionChain } = await import("./schwab");
  const chain = await getOptionChain(chainSymbol, FLOW_DTE);
  return "error" in chain ? null : chain;
}

// Placeholder until attachPcrHistory z-scores the ratio against the symbol's
// own history: missing volume is "unavailable", never "neutral".
function zoneFor(pcr: number | null): PcrZone {
  return pcr == null ? "unavailable" : "insufficient_history";
}

async function fetchTickerFlow(
  symbol: string,
  label: string,
  chainSymbol: string,
): Promise<FlowTicker> {
  let spot: number | null = null;
  let putVol = 0, callVol = 0, putOI = 0, callOI = 0;
  let changeFromOpen: number | null = null;
  let chainAsOfMs: number | null = null;
  let chainStale = false;
  let ok = false;

  try {
    const chain = await flowChain(chainSymbol);
    if (chain) {
      ok = true;
      chainAsOfMs = chain.asOfMs;
      chainStale = chain.stale;
      spot = chainSpot(chain);
      const t = chainVolumeTotals(chain);
      putVol = t.putVol; callVol = t.callVol; putOI = t.putOI; callOI = t.callOI;
      // Day change vs the prior session close (server/dayChange.ts), not vs the open.
      if (spot != null) {
        const { resolveSessionPrevClose } = await import("./quotes");
        const pc = await resolveSessionPrevClose(chainSymbol, null).catch(() => null);
        if (pc?.prevClose) changeFromOpen = ((spot - pc.prevClose) / pc.prevClose) * 100;
      }
    }
  } catch (_) {
    ok = false;
  }

  const pcrVolume = ok && callVol > 0 ? putVol / callVol : null;
  const pcrOI = ok && callOI > 0 ? putOI / callOI : null;

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
    asOf: Math.floor((chainAsOfMs ?? Date.now()) / 1000),
    dataState: ok ? "ok" : "unavailable",
    chainAsOfMs,
    chainStale,
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
  /** Observed samples from fresh Schwab chains only; empty until there are enough. */
  series: IntradayVolSample[];
  /** "insufficient_samples" = fewer than MIN_SERIES_SAMPLES fresh reads today (series empty). */
  seriesState: IntradaySeriesState;
  seriesReason: string | null;
  /** null when volumeState is "unavailable" (never a placeholder 0). */
  currentCallVol: number | null;
  currentPutVol: number | null;
  currentPcr: number | null;
  /** "live" = this poll's fresh chain; "last_sample" = last fresh sample within its max age; "unavailable". */
  volumeState: IntradayVolumeState;
  /** Epoch seconds the current volumes were observed at. */
  volumeAsOf: number | null;
  /** This poll's chain: fresh, stale (not sampled) or unavailable. */
  chainState: "fresh" | "stale" | "unavailable";
  /** Always false: the synthesized U-curve series was removed (kept for older clients). */
  isEstimated: boolean;
  // Classification of the snapshot
  aggressor: AggressorBreakdown;
  // Convenience: total overall contract volume (calls + puts); null when unavailable
  totalVol: number | null;
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
  /** Epoch seconds of the fresh chain behind lastAggressor. */
  lastAggressorAsOf: number | null;
}
const volBuffers = new Map<string, VolBuffer>();

const INTRADAY_TICKERS = [
  { symbol: "SPY",  label: "SPY",  chainSymbol: "SPY"  },
  { symbol: "QQQ",  label: "QQQ",  chainSymbol: "QQQ"  },
  { symbol: "IWM",  label: "IWM",  chainSymbol: "IWM"  },
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
export function classifyAggressor(options: ReadonlyArray<Pick<FlatContract, "side" | "volume" | "bid" | "ask" | "last">>): AggressorBreakdown {
  const out: AggressorBreakdown = {
    boughtCallVol: 0, soldCallVol: 0, unknownCallVol: 0,
    boughtPutVol: 0, soldPutVol: 0, unknownPutVol: 0,
    boughtCallPrem: 0, soldCallPrem: 0, boughtPutPrem: 0, soldPutPrem: 0,
    classifiedPct: 0,
  };
  for (const o of options) {
    const side = o?.side;
    if (side !== "C" && side !== "P") continue;
    const vol = Number(o.volume ?? 0);
    if (!vol || vol <= 0) continue;
    const bid = o.bid ?? NaN;
    const ask = o.ask ?? NaN;
    const last = o.last ?? NaN;
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
  const nowEpoch = Math.floor(Date.now() / 1000);
  const tickers: IntradayFlowTicker[] = [];

  for (const tk of INTRADAY_TICKERS) {
    // Current snapshot from the Schwab chain (0-FLOW_DTE).
    let callVol = 0, putVol = 0;
    let agg: AggressorBreakdown | null = null;
    let read = false, stale = false;
    try {
      const chain = await flowChain(tk.chainSymbol);
      if (chain) {
        read = true;
        stale = !!(chain as any).stale;
        const opts = flattenSchwabChain(chain);
        for (const o of opts) {
          const v = o.volume ?? 0;
          if (o.side === "C") callVol += v;
          else putVol += v;
        }
        agg = classifyAggressor(opts);
      }
    } catch (_) {
      read = false;
    }
    const chainRead: ChainRead = { read, stale, callVol, putVol };
    const fresh = isFreshChain(chainRead);

    let buf = volBuffers.get(tk.symbol);
    // Reset buffer daily
    if (!buf || buf.lastResetDay !== today) {
      buf = { lastResetDay: today, samples: [], lastCallVol: 0, lastPutVol: 0, lastAggressor: null, lastAggressorAsOf: null };
      volBuffers.set(tk.symbol, buf);
    }

    // Samples only from fresh chains (an observed zero is a sample; a stale
    // or failed chain is not).
    const lastSample = buf.samples[buf.samples.length - 1] ?? null;
    if (shouldAppendSample(chainRead, lastSample?.t ?? null, nowEpoch)) {
      buf.samples.push({
        t: nowEpoch,
        timeLabel: getTimeLabel(nowEpoch),
        callVolume: callVol,
        putVolume: putVol,
        pcRatio: callVol > 0 ? putVol / callVol : null,
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
    if (fresh) {
      buf.lastCallVol = callVol;
      buf.lastPutVol = putVol;
      if (agg) { buf.lastAggressor = agg; buf.lastAggressorAsOf = nowEpoch; }
    }

    // Observed samples only; no synthesized backfill (R3-2 item 2).
    const { series, seriesState, seriesReason } = seriesFrom(buf.samples);
    const cur = currentVolumes(chainRead, buf.samples[buf.samples.length - 1] ?? null, nowEpoch);

    // Data state for the side breakdown: never present a failed fetch as a $0 read,
    // and re-use the last breakdown only within LAST_SAMPLE_MAX_AGE_MS.
    const aggressorState = aggressorStateOf(fresh && agg != null, buf.lastAggressorAsOf, nowEpoch);
    const effectiveAgg: AggressorBreakdown = (fresh ? agg : aggressorState === "cached" ? buf.lastAggressor : null) ?? {
      boughtCallVol: 0, soldCallVol: 0, unknownCallVol: 0,
      boughtPutVol: 0, soldPutVol: 0, unknownPutVol: 0,
      boughtCallPrem: 0, soldCallPrem: 0, boughtPutPrem: 0, soldPutPrem: 0,
      classifiedPct: 0,
    };
    const totalVol = cur.callVol != null && cur.putVol != null ? cur.callVol + cur.putVol : null;
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
      seriesState,
      seriesReason,
      currentCallVol: cur.callVol,
      currentPutVol: cur.putVol,
      currentPcr: cur.pcr,
      volumeState: cur.volumeState,
      volumeAsOf: cur.volumeAsOf,
      chainState: !read ? "unavailable" : stale ? "stale" : "fresh",
      isEstimated: false,
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
    estimated: false,
  };
}

function mean(nums: (number | null)[]): number | null {
  const xs = nums.filter((n): n is number => typeof n === "number" && isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ─── Per-symbol P/C history (review item 4.5, SF-5) ─────────────────────────
// Records each symbol's cumulative day volume (0-FLOW_DTE chains) from Schwab
// snapshots per 30-minute bucket and replaces every zone with a z-score
// against that symbol's own history at the same clock time. Only chains that
// were read and are not stale are recorded; an unavailable chain is neither
// recorded nor zoned (zone "unavailable").
const PCR_COMBINED_KEY = "__COMBINED";

export function attachPcrHistory(resp: FlowResponse, nowMs: number = Date.now()): FlowResponse {
  const today = etDate(nowMs);
  // Minute of today's session; outside the session the full-day value is compared.
  const at = sessionMinuteOf(nowMs);
  const minute = at && at.date === today ? at.minute : 24 * 60;
  const readFor = (key: string, putVol: number, callVol: number, observed: boolean): PcrRead => {
    if (observed) recordPcrSnapshot({ symbol: key, putVol, callVol, provider: resp.provider, capturedAtMs: nowMs });
    return pcrReadAtClock(observed ? { putVol, callVol } : null, minute, loadPcrSessions(key, today), { today });
  };
  for (const t of [...resp.indexGroup, ...resp.mag7Group]) {
    const observed = t.dataState === "ok" && !t.chainStale && t.putVol + t.callVol > 0;
    const r = readFor(t.symbol, t.putVol, t.callVol, observed);
    t.pcrRead = r;
    t.zone = r.zone;
  }
  let puts = 0, calls = 0;
  let allRead = true;
  for (const t of [...resp.indexGroup, ...resp.mag7Group]) {
    if (t.symbol === "^VIX") continue;
    if (t.dataState !== "ok" || t.chainStale) { allRead = false; continue; }
    puts += t.putVol || 0; calls += t.callVol || 0;
  }
  // The combined history is only comparable when every constituent was read.
  const r = readFor(PCR_COMBINED_KEY, puts, calls, allRead && resp.aggregate.combinedPcr != null && puts + calls > 0);
  resp.aggregate.pcrRead = r;
  resp.aggregate.zone = r.zone;
  ensurePcrCloseRecorder();
  return resp;
}

// Every 30-minute bucket must be captured even when nobody has the panel
// open: a deterministic timer (no AI) rebuilds the snapshot every 10 minutes
// from the open to 15 minutes after the close on trading days.
let pcrRecorder: ReturnType<typeof setInterval> | null = null;
function ensurePcrCloseRecorder(): void {
  if (pcrRecorder) return;
  pcrRecorder = setInterval(() => {
    const now = Date.now();
    const d = etDate(now);
    const close = isTradingDay(d) ? sessionCloseMs(d) : null;
    const open = close != null ? sessionOpenMs(d) : null;
    if (close == null || open == null || now < open || now > close + 15 * 60_000) return;
    buildFlowSnapshot().catch((e: any) => console.warn(`[flow] P/C record failed: ${e?.message ?? e}`));
  }, 10 * 60_000);
  (pcrRecorder as any).unref?.();
}

export async function buildFlowSnapshot(): Promise<FlowResponse> {
  const warnings: string[] = [];

  const indexPromises = INDEX_SYMBOLS.map((s) => fetchTickerFlow(s.symbol, s.label, s.chainSymbol));
  const mag7Promises = MAG7_SYMBOLS.map((s) => fetchTickerFlow(s.symbol, s.label, s.chainSymbol));
  const [indexGroup, mag7Group] = await Promise.all([
    Promise.all(indexPromises),
    Promise.all(mag7Promises),
  ]);

  // Exclude VIX from the index aggregate (its options behave differently).
  // Aggregate PCR = sum(puts) / sum(calls) across the group. The old mean-of-ratios let a
  // thin name with 3 puts / 1 call (PCR 3.0) swamp SPX, and it dropped tickers whose
  // pcrVolume was null while still counting the rest.
  // Only tickers whose chain was read: a failed fetch is not zero volume.
  const volumePcr = (group: FlowTicker[]): number | null => {
    let puts = 0, calls = 0;
    for (const t of group) {
      if (t.dataState === "unavailable") continue;
      puts += t.putVol || 0; calls += t.callVol || 0;
    }
    return calls > 0 ? puts / calls : null;
  };
  const missing = [...indexGroup, ...mag7Group].filter((t) => t.dataState === "unavailable").map((t) => t.label);
  if (missing.length) warnings.push(`Schwab chain unavailable for ${missing.join(", ")}; excluded from the aggregates.`);
  const indexTickers = indexGroup.filter((t) => t.symbol !== "^VIX");
  const indexPcr = volumePcr(indexTickers);
  const mag7Pcr = volumePcr(mag7Group);
  const combinedPcr = volumePcr([...indexTickers, ...mag7Group]);

  // The aggregate ring takes only polls where every constituent chain was
  // read fresh: a stale or missing name would change the basket mid-series.
  const allFresh = [...indexTickers, ...mag7Group].every((t) => t.dataState === "ok" && !t.chainStale);
  if (allFresh && indexPcr != null && mag7Pcr != null && combinedPcr != null) {
    const now = Math.floor(Date.now() / 1000);
    if (
      intradayRing.length === 0 ||
      now - intradayRing[intradayRing.length - 1].t >= 8
    ) {
      intradayRing.push({ t: now, combined: combinedPcr, index: indexPcr, mag7: mag7Pcr });
      if (intradayRing.length > RING_MAX) intradayRing.shift();
    }
  } else {
    warnings.push("Intraday P/C sample skipped: at least one constituent chain was stale or unavailable.");
  }

  return attachPcrHistory({
    provider: "schwab",
    coverage: `Schwab option chains, expiries 0-${FLOW_DTE} calendar days, strikes within the requested window around spot (at least +-10%); a near-dated put/call ratio, not all listed expiries.`,
    indexGroup,
    mag7Group,
    aggregate: {
      indexPcr,
      mag7Pcr,
      combinedPcr,
      zone: zoneFor(combinedPcr),
    },
    intradaySeries: [...intradayRing],
    warnings,
    asOf: Math.floor(Date.now() / 1000),
  });
}
