// server/flow.ts
// Put/Call flow ratio — pluggable provider architecture. Schwab adapter drops
// in later. Current provider: CBOE delayed-quote options endpoints which serve
// full chain snapshots without needing a crumb/cookie (unlike Yahoo).
//
// Ratio convention:
//   pcr = totalPutVolume / totalCallVolume
//   pcr > 1.05 → bearish / hedging pressure
//   pcr < 0.75 → bullish / call-heavy
//
// CBOE endpoint: https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
// Returns: { data: { options: [{ option: "SPY250509C00500000", volume, open_interest, ... }] } }
// OCC format: ROOT + YYMMDD + C/P + STRIKE(8 digits) — we parse side from pos[-17].

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
  zone: "bullish" | "neutral" | "bearish";
  asOf: number;
};

export type FlowResponse = {
  provider: "cboe" | "yahoo" | "schwab";
  indexGroup: FlowTicker[];
  mag7Group: FlowTicker[];
  aggregate: {
    indexPcr: number | null;
    mag7Pcr: number | null;
    combinedPcr: number | null;
    zone: "bullish" | "neutral" | "bearish";
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

function zoneFor(pcr: number | null): "bullish" | "neutral" | "bearish" {
  if (pcr == null) return "neutral";
  if (pcr > 1.05) return "bearish";
  if (pcr < 0.75) return "bullish";
  return "neutral";
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
}

export interface IntradayFlowTicker {
  symbol: string;
  label: string;
  series: IntradayVolSample[];
  currentCallVol: number;
  currentPutVol: number;
  currentPcr: number | null;
  isEstimated: boolean; // true until real rolling sampler kicks in
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

function isMarketOpen(): boolean {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const totalMins = et.getHours() * 60 + et.getMinutes();
  return totalMins >= 9 * 60 + 30 && totalMins < 16 * 60;
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
  now: Date,
): IntradayVolSample[] {
  const samples: IntradayVolSample[] = [];
  // 13 points from 9:30 to 4:00 in 30-min increments
  const marketOpenH = 9 * 60 + 30; // minutes since midnight ET
  const marketCloseH = 16 * 60;
  const nowEt = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const nowMins = nowEt.getHours() * 60 + nowEt.getMinutes();
  // U-curve weights for each 30-min bucket (higher at open/close)
  const weights = [0.15, 0.09, 0.07, 0.06, 0.06, 0.06, 0.06, 0.07, 0.08, 0.09, 0.10, 0.08, 0.07];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cumCall = 0, cumPut = 0;
  const epochBase = Math.floor(now.getTime() / 1000);
  const marketOpenEpoch = (() => {
    const d = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    d.setHours(9, 30, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  for (let i = 0; i < weights.length; i++) {
    const bucketMins = marketOpenH + i * 30;
    if (bucketMins > Math.min(nowMins, marketCloseH)) break;
    const elapsed = (bucketMins - marketOpenH) / 30;
    const t = marketOpenEpoch + elapsed * 1800;
    const fraction = weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / totalWeight;
    // Scale by how far into the day we are
    const dayFraction = Math.min(1, (nowMins - marketOpenH) / (marketCloseH - marketOpenH));
    cumCall = totalCallVol * fraction * dayFraction + totalCallVol * (1 - dayFraction) * fraction;
    cumPut = totalPutVol * fraction * dayFraction + totalPutVol * (1 - dayFraction) * fraction;
    cumCall = Math.round(cumCall);
    cumPut = Math.round(cumPut);
    samples.push({
      t,
      timeLabel: getTimeLabel(t),
      callVolume: cumCall,
      putVolume: cumPut,
      pcRatio: cumCall > 0 ? cumPut / cumCall : null,
    });
  }
  return samples;
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
    try {
      const d = await cboeFetch(tk.cboeSymbol, 8_000);
      const opts: any[] = d?.data?.options || [];
      for (const o of opts) {
        const side = parseSide(String(o.option || ""));
        const v = Number(o.volume || 0);
        if (side === "C") callVol += v;
        else if (side === "P") putVol += v;
      }
    } catch (_) {
      // fallback to buffer if available
    }

    let buf = volBuffers.get(tk.symbol);
    // Reset buffer daily
    if (!buf || buf.lastResetDay !== today) {
      buf = { lastResetDay: today, samples: [], lastCallVol: 0, lastPutVol: 0 };
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
        });
        // Keep max 390 samples (1 per minute for 6.5h session)
        if (buf.samples.length > 390) buf.samples.shift();
      }
      buf.lastCallVol = callVol;
      buf.lastPutVol = putVol;
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
      series = synthesizeIntradaySeries(totalCall, totalPut, now);
      isEstimated = true;
      anyEstimated = true;
    }

    const currentCall = hasRealData ? callVol : buf.lastCallVol;
    const currentPut = hasRealData ? putVol : buf.lastPutVol;
    tickers.push({
      symbol: tk.symbol,
      label: tk.label,
      series,
      currentCallVol: currentCall,
      currentPutVol: currentPut,
      currentPcr: currentCall > 0 ? currentPut / currentCall : null,
      isEstimated,
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

export async function buildFlowSnapshot(): Promise<FlowResponse> {
  const warnings: string[] = [];

  const indexPromises = INDEX_SYMBOLS.map((s) => fetchTickerFlow(s.symbol, s.label, s.cboeSymbol));
  const mag7Promises = MAG7_SYMBOLS.map((s) => fetchTickerFlow(s.symbol, s.label, s.cboeSymbol));
  const [indexGroup, mag7Group] = await Promise.all([
    Promise.all(indexPromises),
    Promise.all(mag7Promises),
  ]);

  // Exclude VIX from the index aggregate (its options behave differently).
  const indexPcr = mean(
    indexGroup.filter((t) => t.symbol !== "^VIX").map((t) => t.pcrVolume),
  );
  const mag7Pcr = mean(mag7Group.map((t) => t.pcrVolume));
  const combinedPcr =
    indexPcr != null && mag7Pcr != null
      ? (indexPcr + mag7Pcr) / 2
      : indexPcr ?? mag7Pcr ?? null;

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

  return {
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
  };
}
