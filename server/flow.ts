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
