// server/multiDayProjection.ts
//
// Multi-day forward vol cone for SPX / SPY.
//
// This is NOT a trained ML model. It's a realized-vol cone with regime
// adjustment — labeled honestly. Bands are:
//   q10/q90 = ±1.282σ * √t
//   q25/q75 = ±0.674σ * √t
//   q50     = drift line (recent 10d slope, dampened)
//
// σ is realized daily log-return stdev from last 30 sessions. We adjust σ up
// by the current VIX/realized ratio when available (vol-of-vol overlay).
//
// Drift comes from the median 10-day log return, dampened by 0.5 (we don't
// want to extrapolate a parabolic rally into a parabolic cone).
//
// Output: bands for N=1..10 trading days forward.

export type ConeBand = {
  day: number;          // 1..10 forward sessions
  date: string;         // approximate ISO date (calendar — not skipping weekends)
  q10: number;
  q25: number;
  q50: number;          // drift mid
  q75: number;
  q90: number;
};

export type MultiDayConeResp = {
  symbol: string;
  spot: number;
  asOfTs: number;
  sigmaDaily: number;     // realized daily stdev (log returns)
  sigmaAnnualizedPct: number;
  driftDaily: number;     // log return per day (dampened)
  volBlowupFactor: number; // VIX/realized ratio applied to σ (1.0 if no VIX)
  bands: ConeBand[];
  source: "realized_vol_cone";
  honestyNote: string;
  computedAt: string;
};

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

// 5min in-memory bars cache — keeps Models tab from racing pivot, ML accuracy,
// and multi-day cone for the same /pricehistory call when Schwab is saturated.
const _coneBarsCache = new Map<string, { ts: number; bars: { t: number; c: number }[] }>();
const CONE_BARS_TTL_MS = 5 * 60 * 1000;

export async function buildMultiDayCone(symbol: string): Promise<MultiDayConeResp> {
  const { getPriceHistory, getQuotes } = await import("./schwab");
  // Schwab uses $SPX for SPX
  const wireSym = symbol === "^GSPC" ? "$SPX" : symbol;

  // Pull 2 months of daily bars for σ estimation — cached with stale fallback
  // so a transient Schwab throttle doesn't blank the cone panel.
  let bars: { t: number; c: number }[] = [];
  const cached = _coneBarsCache.get(wireSym);
  if (cached && Date.now() - cached.ts < CONE_BARS_TTL_MS) {
    bars = cached.bars;
  } else {
    try {
      const resp = await getPriceHistory(wireSym, "month", 2, "daily", 1);
      bars = (resp?.candles || [])
        .filter((c: any) => c.close != null && isFinite(c.close))
        .map((c: any) => ({ t: c.datetime, c: c.close }));
      if (bars.length >= 15) {
        _coneBarsCache.set(wireSym, { ts: Date.now(), bars });
      }
    } catch (fetchErr: any) {
      if (cached) {
        console.log(`[multiDayCone] Schwab fetch failed for ${wireSym}, using stale cache (${cached.bars.length} bars)`);
        bars = cached.bars;
      } else {
        throw new Error(`Schwab fetch failed for ${symbol}: ${fetchErr?.message ?? fetchErr}`);
      }
    }
  }

  if (bars.length < 15) {
    // Last-resort fallback to any stale cache before throwing
    if (cached && cached.bars.length >= 15) {
      bars = cached.bars;
    } else {
      throw new Error(`insufficient bars for ${symbol} (${bars.length})`);
    }
  }

  // Log returns
  const logRets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    logRets.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  // Use the last 30 returns for σ
  const recentRets = logRets.slice(-30);
  const sigmaDaily = std(recentRets);
  const sigmaAnnualizedPct = sigmaDaily * Math.sqrt(252) * 100;

  // Drift = median of last 10 log returns, dampened by 0.5
  const last10 = logRets.slice(-10);
  const driftDaily = median(last10) * 0.5;

  // Vol blowup = VIX / realized annualized (clamped 0.7..2.0)
  let volBlowupFactor = 1.0;
  try {
    const quotes = await getQuotes(["$VIX"]);
    const vix = quotes.find((q) => q.symbol === "$VIX")?.last;
    if (vix && sigmaAnnualizedPct > 0) {
      const ratio = vix / sigmaAnnualizedPct;
      volBlowupFactor = Math.max(0.7, Math.min(2.0, ratio));
    }
  } catch {
    // VIX optional
  }
  const sigmaAdj = sigmaDaily * volBlowupFactor;

  const spot = bars[bars.length - 1].c;
  const asOfTs = bars[bars.length - 1].t;
  const now = new Date();

  const bands: ConeBand[] = [];
  for (let n = 1; n <= 10; n++) {
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
    sigmaDaily,
    sigmaAnnualizedPct,
    driftDaily,
    volBlowupFactor,
    bands,
    source: "realized_vol_cone",
    honestyNote:
      "Vol cone (not a trained ML model). σ from 30d realized daily stdev, drift from 10d median, dampened 0.5x. VIX/realized used as vol-blowup factor (clamped 0.7-2.0).",
    computedAt: new Date().toISOString(),
  };
}
