// server/tickerProjection.ts
//
// Forward vol cone for ANY ticker. Generalizes multiDayProjection.ts to N
// sessions (default 60) for the single-name Outlook card.
//
// HONEST: This is a realized-vol cone, NOT a trained ML model.
//   q10/q90 = ±1.282σ * √t
//   q25/q75 = ±0.674σ * √t
//   q50     = drift line (10d median log return, dampened 0.5x)
//
// σ from 30d realized daily stdev. Vol-blowup = clamp(VIX/realized, 0.7..2.0)
// when VIX is available — collapses to 1.0 otherwise (degraded gracefully).
//
// Drift dampened to 0.5x so a 5-day rally doesn't extrapolate into a parabolic
// 60-day cone. The cone widens as √t.

import { getPriceHistory, getQuotes } from "./schwab";

export type ProjectionBand = {
  day: number;        // 1..N forward sessions
  date: string;       // ISO YYYY-MM-DD (calendar — skipping weekends)
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
  sigmaDaily: number;
  sigmaAnnualizedPct: number;
  driftDaily: number;
  volBlowupFactor: number;
  bands: ProjectionBand[];
  source: "realized_vol_cone";
  honestyNote: string;
  computedAt: string;
};

const _barsCache = new Map<string, { ts: number; bars: { t: number; c: number }[] }>();
const BARS_TTL_MS = 5 * 60 * 1000;

function nextWeekdayDate(start: Date, sessions: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < sessions) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sq = arr.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(sq / (arr.length - 1));
}

export async function buildTickerProjection(
  symbol: string,
  sessions = 60,
): Promise<TickerProjectionResp> {
  // Schwab uses $SPX for SPX
  const wireSym = symbol === "^GSPC" ? "$SPX" : symbol;

  // Pull ~4 months of daily bars (covers 30d σ + 10d drift + safety margin)
  let bars: { t: number; c: number }[] = [];
  const cached = _barsCache.get(wireSym);
  if (cached && Date.now() - cached.ts < BARS_TTL_MS) {
    bars = cached.bars;
  } else {
    // Schwab periodType="month" only accepts period ∈ {1,2,3,6}. Try 6mo daily,
    // fall back to 1yr daily if that 404s. Always with a hard timeout.
    const fetchWithTimeout = async (
      pt: "day" | "month" | "year",
      pr: number,
      ft: "daily" | "weekly" | "monthly" | "minute",
      fq: number,
    ) =>
      Promise.race([
        getPriceHistory(wireSym, pt, pr, ft, fq),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("schwab bars timeout 10s")), 10000),
        ),
      ]) as Promise<Awaited<ReturnType<typeof getPriceHistory>>>;

    try {
      let resp = await fetchWithTimeout("month", 6, "daily", 1);
      if (!resp?.candles?.length) {
        // Fallback: 1 year daily — always supported
        resp = await fetchWithTimeout("year", 1, "daily", 1);
      }
      bars = (resp?.candles || [])
        .filter((c: any) => c.close != null && isFinite(c.close))
        .map((c: any) => ({ t: c.datetime, c: c.close }));
      if (bars.length >= 20) {
        _barsCache.set(wireSym, { ts: Date.now(), bars });
      }
    } catch (fetchErr: any) {
      if (cached) bars = cached.bars;
      else throw new Error(`bar fetch failed for ${symbol}: ${fetchErr?.message ?? fetchErr}`);
    }
  }

  if (bars.length < 20) {
    if (cached && cached.bars.length >= 20) bars = cached.bars;
    else throw new Error(`insufficient bars for ${symbol} (${bars.length})`);
  }

  // Log returns
  const logRets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    logRets.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  const recentRets = logRets.slice(-30);
  const sigmaDaily = std(recentRets);
  const sigmaAnnualizedPct = sigmaDaily * Math.sqrt(252) * 100;

  const last10 = logRets.slice(-10);
  const driftDaily = median(last10) * 0.5;

  // Vol blowup from VIX
  let volBlowupFactor = 1.0;
  try {
    const quotes = await Promise.race([
      getQuotes(["$VIX"]),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("vix timeout 5s")), 5000),
      ),
    ]) as any[];
    const vix = quotes.find((q: any) => q.symbol === "$VIX")?.last;
    if (vix && sigmaAnnualizedPct > 0) {
      const ratio = vix / sigmaAnnualizedPct;
      volBlowupFactor = Math.max(0.7, Math.min(2.0, ratio));
    }
  } catch {}
  const sigmaAdj = sigmaDaily * volBlowupFactor;

  const spot = bars[bars.length - 1].c;
  const asOfTs = bars[bars.length - 1].t;
  const now = new Date();

  const bands: ProjectionBand[] = [];
  for (let n = 1; n <= sessions; n++) {
    const t = Math.sqrt(n);
    const midLog = driftDaily * n;
    const mid = spot * Math.exp(midLog);
    const z90 = 1.282 * sigmaAdj * t;
    const z75 = 0.674 * sigmaAdj * t;
    bands.push({
      day: n,
      date: nextWeekdayDate(now, n).toISOString().slice(0, 10),
      q10: spot * Math.exp(midLog - z90),
      q25: spot * Math.exp(midLog - z75),
      q50: mid,
      q75: spot * Math.exp(midLog + z75),
      q90: spot * Math.exp(midLog + z90),
    });
  }

  return {
    symbol,
    spot,
    asOfTs,
    sessionsForward: sessions,
    sigmaDaily,
    sigmaAnnualizedPct,
    driftDaily,
    volBlowupFactor,
    bands,
    source: "realized_vol_cone",
    honestyNote:
      "Realized vol cone (NOT a trained ML model). σ from 30d daily stdev, drift from 10d median dampened 0.5x. VIX/realized as vol-blowup factor (clamp 0.7-2.0). Cone widens with √t.",
    computedAt: new Date().toISOString(),
  };
}
