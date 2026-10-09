// server/tickerProjection.ts
//
// Forward cone for ANY ticker (single-name Outlook card), N sessions out
// (default 60, max 120).
//
// Round 3 (N3-1): the cone is the index cone's model with the stock's OWN
// option-implied volatility:
//   sigma: the stock's Schwab ATM implied-vol term structure (ATM IV per
//          listed expiry, interpolated linearly in total variance to the close
//          of each session; server/tickerConeMath.ts). It used to be 30-day
//          realized vol times a VIX/realized "blow-up" ratio, i.e. the INDEX's
//          implied vol level imposed on every stock.
//   drift: zero (median = spot). It used to carry 0.5 x the median of the last
//          10 daily log returns forward; one-to-two-week momentum is not
//          evidence of drift (Lehmann 1990, QJE 105(1); Jegadeesh 1990,
//          J. Finance 45(3)), and the index cone already uses zero drift.
//   tails: standardised sum of n iid unit-variance Student-t(4) daily shocks
//          (same helper family as the index cone).
// When Schwab has no usable chain for the symbol, the cone falls back to the
// 30-day realized vol from Schwab daily bars, UNSCALED and labelled
// (sigmaSource "realized_30d"), never VIX-scaled.
// HONEST: a volatility cone, not a trained model; band coverage is untested.

import { getPriceHistory, getOptionChain } from "./schwab";
import { contractYears } from "./chainClock";
import { UpstreamUnavailableError } from "@shared/unavailable";
import { etDate, isTradingDay, nextTradingDay, sessionCloseMs } from "./exchangeCalendar";
import { atmIvTermFromChain, coneBandsFromVariance, totalVarianceAt, type AtmIvPoint } from "./tickerConeMath";

export type ProjectionBand = {
  day: number;        // 1..N forward sessions
  date: string;       // ISO YYYY-MM-DD (exchange trading days)
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
};

export type TickerProjectionResp = {
  symbol: string;
  spot: number;
  asOfTs: number;
  sessionsForward: number;
  /** Equivalent per-session sd at the horizon end: sqrt(w(T_N) / N). */
  sigmaDaily: number;
  /** Annualised vol at the horizon end: sqrt(w(T_N) / T_N), percent. */
  sigmaAnnualizedPct: number;
  /** 0: martingale median (kept for older readers). */
  driftDaily: number;
  /** 1: no VIX scaling any more (kept for older readers). */
  volBlowupFactor: number;
  sigmaSource: "atm_iv_term" | "realized_30d";
  /** ATM IV per listed expiry used for the term structure (atm_iv_term only). */
  ivTerm?: AtmIvPoint[];
  tailModel: string;
  bands: ProjectionBand[];
  source: "implied_vol_cone" | "realized_vol_cone";
  honestyNote: string;
  computedAt: string;
};

const _barsCache = new Map<string, { ts: number; bars: { t: number; c: number }[] }>();
const BARS_TTL_MS = 5 * 60 * 1000;

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sq = arr.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(sq / (arr.length - 1));
}

/** The next `sessions` exchange trading days after today (ET). */
function forwardSessions(nowMs: number, sessions: number): string[] {
  const out: string[] = [];
  let d = etDate(nowMs);
  // Today counts as session 1 only while its close is still ahead.
  const closeToday = isTradingDay(d) ? sessionCloseMs(d) : null;
  if (closeToday != null && closeToday > nowMs) out.push(d);
  while (out.length < sessions) {
    d = nextTradingDay(d);
    out.push(d);
  }
  return out;
}

async function fetchDailyBars(wireSym: string): Promise<{ t: number; c: number }[]> {
  const cached = _barsCache.get(wireSym);
  if (cached && Date.now() - cached.ts < BARS_TTL_MS) return cached.bars;
  const fetchWithTimeout = async (pt: "day" | "month" | "year", pr: number) =>
    Promise.race([
      getPriceHistory(wireSym, pt, pr, "daily", 1),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("schwab bars timeout 10s")), 10000)),
    ]) as Promise<Awaited<ReturnType<typeof getPriceHistory>>>;
  let resp = await fetchWithTimeout("month", 6);
  if (!resp?.candles?.length) resp = await fetchWithTimeout("year", 1);
  const bars = (resp?.candles || [])
    .filter((c: any) => c.close != null && isFinite(c.close))
    .map((c: any) => ({ t: c.datetime, c: c.close }));
  if (bars.length >= 20) _barsCache.set(wireSym, { ts: Date.now(), bars });
  return bars;
}

export async function buildTickerProjection(
  symbol: string,
  sessions = 60,
): Promise<TickerProjectionResp> {
  const wireSym = symbol === "^GSPC" ? "$SPX" : symbol;
  const nowMs = Date.now();
  const nSess = Math.max(1, Math.min(120, Math.round(sessions)));
  const dates = forwardSessions(nowMs, nSess);
  const closes = dates.map((d) => sessionCloseMs(d) ?? nowMs);
  const horizonDays = Math.ceil((closes[closes.length - 1] - nowMs) / 86_400_000);

  // 1. The stock's own ATM implied-vol term structure (Schwab chain, ATM
  //    strikes only, expiries out to one month past the horizon so the last
  //    sessions are interpolated, not extrapolated).
  let term: AtmIvPoint[] = [];
  let spot: number | null = null;
  let asOfTs: number | null = null;
  try {
    const chain = await getOptionChain(wireSym, horizonDays + 35, { coverage: "atm" });
    if (!("error" in chain)) {
      const last = chain.underlying?.last;
      if (last != null && last > 0) {
        spot = last;
        asOfTs = chain.asOfMs;
        term = atmIvTermFromChain(chain, last, (k, c) => contractYears(k, c, nowMs));
      }
    }
  } catch { /* falls back below */ }

  let sigmaSource: TickerProjectionResp["sigmaSource"] = "atm_iv_term";
  let realizedDaily: number | null = null;
  if (!term.length || spot == null) {
    // 2. Fallback: 30-day realized vol from Schwab daily bars, unscaled.
    sigmaSource = "realized_30d";
    // Neither Schwab source can answer: upstream unavailable (route -> 503 +
    // dataState), not a server error. A bars timeout / fetch error is the same.
    let bars: { t: number; c: number }[];
    try {
      bars = await fetchDailyBars(wireSym);
    } catch (e: any) {
      throw new UpstreamUnavailableError(`no Schwab option chain for ${symbol} and Schwab daily bars failed (${String(e?.message ?? e).slice(0, 80)})`);
    }
    if (bars.length < 20) throw new UpstreamUnavailableError(`no Schwab option chain and insufficient Schwab daily bars for ${symbol} (${bars.length} of 20)`);
    const logRets: number[] = [];
    for (let i = 1; i < bars.length; i++) logRets.push(Math.log(bars[i].c / bars[i - 1].c));
    realizedDaily = std(logRets.slice(-30));
    if (spot == null) { spot = bars[bars.length - 1].c; asOfTs = bars[bars.length - 1].t; }
  }

  const S = spot as number;
  const YEAR_MS = 365 * 86_400_000;
  const variance = (n: number): number => {
    if (sigmaSource === "atm_iv_term") return totalVarianceAt(term, Math.max(0, closes[n - 1] - nowMs) / YEAR_MS) ?? 0;
    return (realizedDaily as number) ** 2 * n;
  };

  const bands: ProjectionBand[] = [];
  for (let n = 1; n <= nSess; n++) {
    const b = coneBandsFromVariance(S, variance(n), n, nSess);
    bands.push({ day: n, date: dates[n - 1], ...b });
  }
  const wN = variance(nSess);
  const TN = Math.max(1e-9, (closes[nSess - 1] - nowMs) / YEAR_MS);
  const sigmaDaily = Math.sqrt(wN / nSess);
  const sigmaAnnualizedPct = (sigmaSource === "atm_iv_term" ? Math.sqrt(wN / TN) : (realizedDaily as number) * Math.sqrt(252)) * 100;

  return {
    symbol,
    spot: S,
    asOfTs: asOfTs ?? nowMs,
    sessionsForward: nSess,
    sigmaDaily,
    sigmaAnnualizedPct,
    driftDaily: 0,
    volBlowupFactor: 1,
    sigmaSource,
    ivTerm: sigmaSource === "atm_iv_term" ? term : undefined,
    tailModel: "standardised sum of n iid unit-variance Student-t(4) daily shocks",
    bands,
    source: sigmaSource === "atm_iv_term" ? "implied_vol_cone" : "realized_vol_cone",
    honestyNote: sigmaSource === "atm_iv_term"
      ? "Implied-vol cone (NOT a trained model): the stock's Schwab ATM implied vol term structure, interpolated in total variance to each session close; zero drift (median = spot); Student-t(4) daily shocks. Implied vol includes the variance risk premium and any earnings inside the horizon. Band coverage untested."
      : "Realized-vol cone (NOT a trained model): no usable Schwab option chain, so 30-day realized vol from Schwab daily bars, unscaled; zero drift (median = spot); Student-t(4) daily shocks. Band coverage untested.",
    computedAt: new Date().toISOString(),
  };
}
