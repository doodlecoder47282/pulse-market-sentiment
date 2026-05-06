// server/auditEnrich.ts
//
// Pure post-processor that augments /api/models response with fields the
// 0DTE engine needs but models.ts (never-edit) doesn't emit:
//
//   - vommaPockets:     strike clusters where dealer vomma piles up
//   - realizedSigma20d: 20-day SPY realized vol (annualized fraction)
//   - intradayPivot:    session-aware pivot for wick-level entries/exits
//   - wickZones:        ±band around intradayPivot scaled by VIX/EM
//
// Plus surfaces vannaM (already in audit) for downstream mappers that
// previously stripped it.
//
// Pivot logic (Hybrid GEX-anchored + charm-blended late-day):
//   • 9:30–11:00 ET:  pivot = max-|GEX| strike within ±1 ATR of spot
//                     (dealers sit at the heaviest gamma node — wicks pin
//                     here in the open's vol explosion)
//   • 11:00–14:00 ET: pivot = blend(maxGEX, dominantMag, mainPivot)
//                     by gamma regime (γ+ favors mag, γ- favors pivot)
//   • 14:00–16:00 ET: pivot = 0.6 × charmTarget + 0.4 × maxGEX
//                     (theta forces close-to-pin behavior — charm wins)
//
// Wick zone half-width = max(0.0015 × spot, 0.40 × dailyEM × √(remainingFrac))
//   - clamped to [4pt, 25pt] for SPX
//   - shrinks as the day burns (sqrt of session-fraction remaining)
//
// Pure function. try/catch guard returns original on any failure.

import type { ModelsResponse } from "./routes";
import Database from "better-sqlite3";
import { getOdteSnapshot } from "./odteTracker";
import { computeVolumeProfile } from "./volumeProfile";
import type { Candle } from "./ohlc";

export interface VommaPocket {
  strike: number;
  weight: number;       // normalized 0..1 within the chain
}

export interface WickZone {
  pivot: number;
  upperEntry: number;   // wick-buy-the-dip mean-revert zone top
  upperExit: number;    // first profit-take zone top
  lowerEntry: number;   // wick-buy-the-dip zone bottom
  lowerExit: number;    // wick-fade-the-rip exit bottom
  halfWidth: number;
  source: string;       // human-readable: "GEX-anchored 9:45 ET" etc.
  asOfMin: number;      // minutes since midnight ET
}

interface DailyBar {
  date: string;
  close: number;
}

// SPY daily closes from data.db (5-min cache)
let spyBarsCache: { ts: number; bars: DailyBar[] } | null = null;
const SPY_CACHE_MS = 5 * 60_000;
let roDb: Database.Database | null = null;

// ─── Wire 9: jump regime cache (5-min TTL) ───────────────────────────────────
export interface JumpRegimeResult {
  jumpRegime: boolean;
  jumpScore: number;  // 0-4, count of triggered features
  features: {
    overnightGapPct: number | null;  // (todayOpen - prevClose) / prevClose * 100
    preMktRangePct: number | null;   // (preMktHigh - preMktLow) / prevClose * 100
    gexSignFlip: boolean | null;     // true if gex sign flipped vs prior day close gex
    vix1dChangePct: number | null;   // (vixNow - vixPrevClose) / vixPrevClose * 100
  };
}
let jumpRegimeCache: { ts: number; result: JumpRegimeResult } | null = null;
const JUMP_REGIME_CACHE_MS = 5 * 60_000;

// Intraday bars cache (1-min or fallback resolution) — refreshed every 2 min
interface IntradayBarsCache {
  ts: number;
  bars: Candle[];
  resolution: string; // "1-min" | "5-min" | "ohlc_minute" | "none"
}
let intradayBarsCache: IntradayBarsCache | null = null;
const INTRADAY_CACHE_MS = 2 * 60_000;

function getReadOnlyDb(): Database.Database {
  if (roDb) return roDb;
  // Open read-only handle to avoid lock contention with the main writer
  roDb = new Database("data.db", { readonly: true, fileMustExist: true });
  return roDb;
}

function getSpyBars(): DailyBar[] {
  if (spyBarsCache && Date.now() - spyBarsCache.ts < SPY_CACHE_MS) {
    return spyBarsCache.bars;
  }
  try {
    const db = getReadOnlyDb();
    const rows = db
      .prepare("SELECT date, close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT 30")
      .all("SPY") as Array<{ date: string; close: number }>;
    const bars = rows
      .map((r) => ({ date: String(r.date), close: Number(r.close) }))
      .filter((b) => isFinite(b.close) && b.close > 0)
      .reverse(); // oldest first for return calculations
    spyBarsCache = { ts: Date.now(), bars };
    return bars;
  } catch {
    return [];
  }
}

/**
 * Fetch intraday SPX bars for the current RTH session (9:30 ET to now).
 *
 * Resolution priority:
 *   1. ohlc_minute table in data.db (1-min bars, if the table exists)
 *   2. Yahoo Finance 1-min via fetchOHLC (live, RTH session only)
 *   3. Yahoo Finance 5-min via fetchOHLC (fallback — coarser POC/VAH/VAL)
 *   4. null (no bars available — Wire 7 skips gracefully)
 *
 * Bars are filtered to current RTH session: today after 09:30 ET (UTC-5/4).
 * Returns cached result if less than INTRADAY_CACHE_MS old.
 */
async function getIntradayBars(): Promise<{ bars: Candle[]; resolution: string }> {
  if (intradayBarsCache && Date.now() - intradayBarsCache.ts < INTRADAY_CACHE_MS) {
    return { bars: intradayBarsCache.bars, resolution: intradayBarsCache.resolution };
  }

  // ── Attempt 1: ohlc_minute in data.db ────────────────────────────────────
  try {
    const db = getReadOnlyDb();
    const etDateNow = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    // Unix seconds for today 09:30 ET
    // We compute it by parsing date and adjusting for ET offset
    const open930Ms = Date.parse(`${etDateNow}T09:30:00-05:00`);
    const open930s = Math.floor((isNaN(open930Ms) ?
      Date.parse(`${etDateNow}T14:30:00Z`) : open930Ms) / 1000);
    const nowS = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(
        "SELECT ts, open AS o, high AS h, low AS l, close AS c, volume AS v " +
        "FROM ohlc_minute WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC"
      )
      .all("SPX", open930s, nowS) as Array<{ ts: number; o: number; h: number; l: number; c: number; v: number | null }>;
    if (rows.length >= 5) {
      const bars: Candle[] = rows.map((r) => ({
        t: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v ?? 0,
      }));
      intradayBarsCache = { ts: Date.now(), bars, resolution: "ohlc_minute" };
      return { bars, resolution: "ohlc_minute" };
    }
  } catch {
    // ohlc_minute table not available in this deployment — expected
  }

  // ── Attempt 2: Yahoo 1-min live bars ─────────────────────────────────────
  try {
    const { fetchOHLC } = await import("./ohlc");
    const ohlc = await fetchOHLC("^GSPC", "1D", "1m");
    if (ohlc.candles.length >= 5) {
      // Filter to RTH (9:30 ET → now): Yahoo includePrePost=false already filters
      // but double-check by epoch: open is t >= 9:30 ET today.
      const etDateNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const open930s = Math.floor(Date.parse(`${etDateNow}T09:30:00-05:00`) / 1000);
      const rthBars = ohlc.candles.filter((b) => b.t >= open930s && (b.v ?? 0) > 0);
      if (rthBars.length >= 5) {
        intradayBarsCache = { ts: Date.now(), bars: rthBars, resolution: "1-min" };
        return { bars: rthBars, resolution: "1-min" };
      }
    }
  } catch {
    // Yahoo 1-min unavailable
  }

  // ── Attempt 3: Yahoo 5-min fallback ──────────────────────────────────────
  try {
    const { fetchOHLC } = await import("./ohlc");
    const ohlc5 = await fetchOHLC("^GSPC", "1D", "5m");
    if (ohlc5.candles.length >= 3) {
      const etDateNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const open930s = Math.floor(Date.parse(`${etDateNow}T09:30:00-05:00`) / 1000);
      const rthBars5 = ohlc5.candles.filter((b) => b.t >= open930s && (b.v ?? 0) > 0);
      if (rthBars5.length >= 3) {
        intradayBarsCache = { ts: Date.now(), bars: rthBars5, resolution: "5-min" };
        return { bars: rthBars5, resolution: "5-min" };
      }
    }
  } catch {
    // Yahoo 5-min unavailable
  }

  // ── No bars available ─────────────────────────────────────────────────────
  intradayBarsCache = { ts: Date.now(), bars: [], resolution: "none" };
  return { bars: [], resolution: "none" };
}

/**
 * 20-day annualized realized vol from SPY daily closes.
 * Returns null if insufficient data.
 */
function computeRealizedSigma20d(bars: DailyBar[]): number | null {
  if (bars.length < 22) return null;
  const recent = bars.slice(-21); // 21 closes → 20 returns
  const rets: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const r = Math.log(recent[i].close / recent[i - 1].close);
    if (isFinite(r)) rets.push(r);
  }
  if (rets.length < 18) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const dailySigma = Math.sqrt(variance);
  return dailySigma * Math.sqrt(252); // annualized
}

/**
 * Detect vomma pockets — strike clusters with high vega-of-vol concentration.
 * We approximate by finding strikes near OI-weighted volume peaks ±1 ATR
 * from spot, since the live response doesn't expose per-strike vomma.
 *
 * Heuristic: top 3 levels (excluding walls, since walls already gate) where
 * the LEVEL kind is dominantMag, strongMag, charmTarget, or zommaBridge —
 * these are the dealer-flow concentration nodes the model already identified.
 */
function extractVommaPockets(levels: any[], spot: number): VommaPocket[] {
  if (!Array.isArray(levels)) return [];
  const KINDS = new Set(["dominantMag", "strongMag", "charmTarget", "zommaBridge", "upperVomma", "lowerVomma"]);
  const candidates = levels
    .filter((l) => l && KINDS.has(l.kind) && typeof l.price === "number")
    .map((l) => ({
      strike: Number(l.price),
      kind: String(l.kind),
      dist: Math.abs(Number(l.price) - spot),
    }))
    .filter((c) => isFinite(c.strike) && c.dist < spot * 0.025) // within 2.5%
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);

  if (candidates.length === 0) return [];
  const maxDist = Math.max(...candidates.map((c) => c.dist), 1);
  return candidates.map((c) => ({
    strike: c.strike,
    weight: parseFloat((1 - c.dist / maxDist).toFixed(3)),
  }));
}

/**
 * Compute the session-aware intraday pivot + wick zones.
 *
 * Phase determined by ET minutes-since-midnight:
 *   570 (9:30) – 660 (11:00):  GEX-anchored
 *   660 – 840 (14:00):         Hybrid blend
 *   840 – 960 (16:00):         Charm-weighted
 *   else:                       fallback to mainPivot
 */
function computeIntradayPivot(args: {
  spot: number;
  dailyEM: number;
  vix: number | null;
  levels: any[];
  audit: any;
  etMinutes: number;
}): WickZone | null {
  const { spot, dailyEM, vix, levels, audit, etMinutes } = args;
  if (!spot || spot <= 0) return null;

  const findLevel = (kind: string): number | null => {
    const l = (levels ?? []).find((x: any) => x?.kind === kind);
    return l && typeof l.price === "number" ? Number(l.price) : null;
  };

  // ATR-equivalent: 1 dailyEM ≈ 1σ, so use 0.5 EM as "1 ATR proxy"
  const atrProxy = Math.max(dailyEM * 0.5, spot * 0.003);

  // Find max-|GEX| strike proxy = nearest dominant magnet within ±1 ATR
  const dominantMag = findLevel("dominantMag");
  const strongMag = findLevel("strongMag");
  const zeroGamma = findLevel("zeroGamma");
  const charmTarget = findLevel("charmTarget");
  const mainPivot = (typeof audit?.mainPivot === "number" ? audit.mainPivot : null) ?? zeroGamma ?? spot;

  // Pick the magnet within ±1 ATR; fall back to main pivot
  const candidates = [dominantMag, strongMag, charmTarget].filter(
    (p) => typeof p === "number" && Math.abs((p as number) - spot) <= atrProxy * 1.5,
  ) as number[];
  const gexAnchor = candidates.length > 0
    ? candidates.reduce((best, c) => (Math.abs(c - spot) < Math.abs(best - spot) ? c : best))
    : (dominantMag ?? mainPivot);

  // Phase logic
  let pivot: number;
  let source: string;

  if (etMinutes < 570) {
    // Pre-open: anchor on yesterday's main pivot
    pivot = mainPivot;
    source = "pre-open mainPivot";
  } else if (etMinutes < 660) {
    // 9:30–11:00 — GEX anchor
    pivot = gexAnchor;
    source = "GEX-anchored open";
  } else if (etMinutes < 840) {
    // 11:00–14:00 — hybrid blend by gamma regime
    const gammaPos = String(audit?.gammaZone ?? "").startsWith("y+");
    if (gammaPos) {
      // Dampening regime → magnets dominate (price pulls toward dealers)
      pivot = 0.55 * gexAnchor + 0.30 * mainPivot + 0.15 * spot;
      source = "hybrid γ+ (mag-weighted)";
    } else {
      // Amplifying regime → main pivot dominates (zero-gamma fights price)
      pivot = 0.40 * gexAnchor + 0.50 * mainPivot + 0.10 * spot;
      source = "hybrid γ- (pivot-weighted)";
    }
  } else if (etMinutes < 960) {
    // 14:00–16:00 — charm pull dominates (theta forces pin)
    if (charmTarget !== null) {
      pivot = 0.6 * charmTarget + 0.4 * gexAnchor;
      source = "charm-weighted close";
    } else {
      pivot = 0.5 * gexAnchor + 0.5 * mainPivot;
      source = "fallback close (no charmTarget)";
    }
  } else {
    pivot = mainPivot;
    source = "post-close mainPivot";
  }

  // Half-width: scaled by EM and time-remaining
  // Session fraction remaining: 1.0 at 9:30, 0.0 at 16:00
  const sessionStart = 570;
  const sessionEnd = 960;
  const sessionLen = sessionEnd - sessionStart;
  const elapsed = Math.max(0, Math.min(sessionLen, etMinutes - sessionStart));
  const remainingFrac = 1 - elapsed / sessionLen;
  const halfWidthRaw = Math.max(
    0.0015 * spot,
    0.40 * dailyEM * Math.sqrt(Math.max(0.05, remainingFrac)),
  );
  const halfWidth = Math.min(25, Math.max(4, halfWidthRaw));

  // Wick zones: entry = inside half-width, exit = at the boundary
  const inner = halfWidth * 0.55;
  const outer = halfWidth;

  return {
    pivot: parseFloat(pivot.toFixed(2)),
    upperEntry: parseFloat((pivot + inner).toFixed(2)),
    upperExit: parseFloat((pivot + outer).toFixed(2)),
    lowerEntry: parseFloat((pivot - inner).toFixed(2)),
    lowerExit: parseFloat((pivot - outer).toFixed(2)),
    halfWidth: parseFloat(halfWidth.toFixed(2)),
    source,
    asOfMin: etMinutes,
  };
}

/**
 * Get current ET minutes-since-midnight.
 */
function etMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return hh * 60 + mm;
}

/**
 * Wire 9 — Paper M re-engineered: jump regime tag.
 *
 * Uses 4 univariate features as a confluence count:
 *   1. |overnight gap| >= 0.4%
 *   2. pre-market range >= 0.5% of prevClose
 *   3. GEX sign flip vs prior trading day
 *   4. |VIX 1d change| >= 5%
 *
 * jumpRegime = true when jumpScore >= 3.
 *
 * Gracefully degrades: any feature that cannot be computed → null,
 * contributes 0 to score. Result cached 5 minutes.
 */
export async function computeJumpRegime(currentGex?: number | null): Promise<JumpRegimeResult> {
  if (jumpRegimeCache && Date.now() - jumpRegimeCache.ts < JUMP_REGIME_CACHE_MS) {
    return jumpRegimeCache.result;
  }

  const features: JumpRegimeResult["features"] = {
    overnightGapPct: null,
    preMktRangePct: null,
    gexSignFlip: null,
    vix1dChangePct: null,
  };

  // ── Feature 1 + 2: overnight gap and pre-market range ───────────────────
  // Fetch ^GSPC with includePrePost=true, 1D range, 1m interval.
  // Extract prevClose from meta, today's first RTH bar open for gap,
  // and 04:00-09:30 ET bars for pre-market range.
  try {
    const { fetchOHLC } = await import("./ohlc");
    // 5d range to get today's pre-market + yesterday's close
    const etDateNow = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    // Fetch 1d range with 1m interval — includePrePost=true to get pre-market bars
    // We manually fetch with prePost since fetchOHLC uses includePrePost=false
    const enc = encodeURIComponent("^GSPC");
    const preMktUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1m&range=1d&includePrePost=true`;
    let preMktData: any = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10_000);
      const r = await fetch(preMktUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PulseDashboard/1.0)", Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (r.ok) preMktData = await r.json();
    } catch { /* network or parse error */ }

    if (preMktData) {
      const result = preMktData?.chart?.result?.[0];
      const meta = result?.meta ?? {};
      const timestamps: number[] = result?.timestamp ?? [];
      const quote = result?.indicators?.quote?.[0] ?? {};
      const opens: number[] = quote.open ?? [];
      const highs: number[] = quote.high ?? [];
      const lows: number[] = quote.low ?? [];

      // prevClose from meta
      const prevClose: number | null = meta.chartPreviousClose ?? meta.previousClose ?? null;

      if (prevClose && isFinite(prevClose) && prevClose > 0 && timestamps.length > 0) {
        // today 9:30 ET in epoch seconds
        const open930Ms = Date.parse(`${etDateNow}T09:30:00-05:00`);
        const open930s = isNaN(open930Ms) ? 0 : Math.floor(open930Ms / 1000);
        // pre-market window: 4:00 ET to 9:29 ET
        const pm400s = isNaN(Date.parse(`${etDateNow}T04:00:00-05:00`))
          ? open930s - 330 * 60
          : Math.floor(Date.parse(`${etDateNow}T04:00:00-05:00`) / 1000);

        // First RTH bar (>= 9:30 ET) open for overnight gap
        let todayOpen: number | null = null;
        for (let i = 0; i < timestamps.length; i++) {
          if (timestamps[i] >= open930s && opens[i] != null && isFinite(opens[i]) && opens[i] > 0) {
            todayOpen = opens[i];
            break;
          }
        }

        if (todayOpen !== null) {
          features.overnightGapPct = ((todayOpen - prevClose) / prevClose) * 100;
        }

        // Pre-market range: bars between 4:00-9:29 ET
        let pmHigh = -Infinity;
        let pmLow = Infinity;
        let pmCount = 0;
        for (let i = 0; i < timestamps.length; i++) {
          if (timestamps[i] >= pm400s && timestamps[i] < open930s) {
            const h = highs[i], l = lows[i];
            if (h != null && isFinite(h) && h > 0) { pmHigh = Math.max(pmHigh, h); pmCount++; }
            if (l != null && isFinite(l) && l > 0) pmLow = Math.min(pmLow, l);
          }
        }
        if (pmCount >= 3 && pmHigh > pmLow && pmLow > 0) {
          features.preMktRangePct = ((pmHigh - pmLow) / prevClose) * 100;
        }
      }
    }
  } catch { /* graceful: features remain null */ }

  // ── Feature 3: GEX sign flip vs prior trading day ─────────────────────
  // Query snapshot_history for the most recent prior-day net_gex.
  // If table missing or no rows, set null (contributes 0). DO NOT create tables.
  try {
    if (typeof currentGex === "number" && isFinite(currentGex)) {
      const db = getReadOnlyDb();
      const etDateNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const row = db
        .prepare("SELECT net_gex FROM snapshot_history WHERE date < ? ORDER BY date DESC LIMIT 1")
        .get(etDateNow) as { net_gex: number } | undefined;
      if (row && typeof row.net_gex === "number" && isFinite(row.net_gex)) {
        const prevGex = row.net_gex;
        // Sign flip: signs differ (not both zero)
        const curSign = currentGex >= 0 ? 1 : -1;
        const prevSign = prevGex >= 0 ? 1 : -1;
        features.gexSignFlip = curSign !== prevSign;
      }
    }
  } catch { /* snapshot_history unavailable or query failed */ }

  // ── Feature 4: VIX 1-day change ──────────────────────────────────
  // Yahoo daily for ^VIX (5d), compute (lastClose - prevClose) / prevClose * 100.
  try {
    const { fetchOHLC } = await import("./ohlc");
    const vixOhlc = await fetchOHLC("^VIX", "5D", "1d");
    const candles = vixOhlc.candles.filter((b) => b.c > 0);
    if (candles.length >= 2) {
      const vixNow = candles[candles.length - 1].c;
      const vixPrev = candles[candles.length - 2].c;
      if (vixPrev > 0) {
        features.vix1dChangePct = ((vixNow - vixPrev) / vixPrev) * 100;
      }
    } else if (vixOhlc.prevClose && vixOhlc.price && vixOhlc.prevClose > 0) {
      features.vix1dChangePct = ((vixOhlc.price - vixOhlc.prevClose) / vixOhlc.prevClose) * 100;
    }
  } catch { /* VIX fetch failed */ }

  // ── Score and classify ─────────────────────────────────────────────────
  let jumpScore = 0;
  if (features.overnightGapPct !== null && Math.abs(features.overnightGapPct) >= 0.4) jumpScore++;
  if (features.preMktRangePct !== null && features.preMktRangePct >= 0.5) jumpScore++;
  if (features.gexSignFlip === true) jumpScore++;
  if (features.vix1dChangePct !== null && Math.abs(features.vix1dChangePct) >= 5) jumpScore++;

  const result: JumpRegimeResult = {
    jumpRegime: jumpScore >= 3,
    jumpScore,
    features,
  };

  jumpRegimeCache = { ts: Date.now(), result };
  console.log(
    `[auditEnrich] computeJumpRegime: score=${jumpScore}/4 regime=${result.jumpRegime} ` +
    `gap=${features.overnightGapPct?.toFixed(2) ?? "null"}% ` +
    `range=${features.preMktRangePct?.toFixed(2) ?? "null"}% ` +
    `gexFlip=${features.gexSignFlip ?? "null"} ` +
    `vix1d=${features.vix1dChangePct?.toFixed(2) ?? "null"}%`,
  );
  return result;
}

/**
 * Main entry — augments daily horizon audit with the 5 missing fields.
 * Returns the same response object (mutated in place).
 *
 * IMPORTANT: This must run AFTER applyTermStructureRescale so the
 * scenarioTargets are already proper for non-daily horizons.
 */
export async function enrichAudit(
  result: ModelsResponse,
  vixData: { vix: number | null; vix9d: number | null; vix3m: number | null },
): Promise<ModelsResponse> {
  try {
    const daily = result.horizons["daily"] as any;
    if (!daily) return result;
    const audit = daily.audit ?? {};
    const spot = Number(daily.spot ?? audit.spot ?? 0);
    if (!spot || spot <= 0) return result;

    const dailyEM = Number(audit.scenarioTargets?.oneDayEM ?? 0);

    // 1. realizedSigma20d (sync from local DB)
    let realizedSigma20d: number | null = null;
    try {
      const bars = getSpyBars();
      realizedSigma20d = computeRealizedSigma20d(bars);
    } catch { /* leave null */ }

    // 2. vommaPockets (sync from levels)
    const vommaPockets = extractVommaPockets(daily.levels ?? [], spot);

    // 3. intradayPivot + wickZones (sync)
    const wickZone = computeIntradayPivot({
      spot,
      dailyEM,
      vix: vixData.vix,
      levels: daily.levels ?? [],
      audit,
      etMinutes: etMinutesNow(),
    });

    // 4. gex: net GEX in $M — read from audit.gexTotal (signed $ per 1%),
    //    divide by 1e6. Negative = dealers short gamma (amplifying regime).
    let gex: number | null = null;
    try {
      const rawGex = audit.gexTotal;
      if (typeof rawGex === "number" && isFinite(rawGex)) {
        gex = parseFloat((rawGex / 1e6).toFixed(1));
      }
    } catch { /* leave null */ }

    // 5. sessionOpen: SPX 09:30 ET bar. Try ohlc_minute, fallback to null.
    //    Table ohlc_minute is not present in this deployment — sessionOpen = null.
    let sessionOpen: number | null = null;
    try {
      const db = getReadOnlyDb();
      // Attempt ohlc_minute with the canonical 9:30 ET open bar
      const etDateNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      // Compute Unix timestamp of today's 9:30 ET in seconds
      const open930 = Date.parse(`${etDateNow}T09:30:00`) - (new Date().getTimezoneOffset() * 60_000);
      // ohlc_minute approach (table may not exist — wrapped in try)
      try {
        const row = db
          .prepare("SELECT close FROM ohlc_minute WHERE symbol = ? AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT 1")
          .get("SPX", Math.floor(open930 / 1000), Math.floor(open930 / 1000) + 120) as { close: number } | undefined;
        if (row && isFinite(row.close) && row.close > 0) sessionOpen = row.close;
      } catch { /* ohlc_minute not available */ }
    } catch { /* leave null */ }

    // 6. atmIV: from live 0DTE contract snapshot — closest-to-spot IV > 0
    let atmIV: number | null = null;
    try {
      const snap = getOdteSnapshot();
      const contracts = snap.contracts ?? [];
      let bestDist = Infinity;
      for (const c of contracts) {
        const iv = (c as any).iv ?? null;
        if (typeof iv !== "number" || !isFinite(iv) || iv <= 0) continue;
        const dist = Math.abs((c as any).strike - spot);
        if (dist < bestDist) { bestDist = dist; atmIV = iv; }
      }
    } catch { /* leave null */ }

    // 7. vwapProfile: intraday VWAP + POC/VAH/VAL from current RTH session bars
    //    tickSize=0.25 for SPX index-point space (spot ~5500-7500)
    //    Falls back gracefully to null if no bars are available
    let vwapProfile: ReturnType<typeof computeVolumeProfile> = null;
    try {
      const { bars: intradayBars, resolution } = await getIntradayBars();
      if (intradayBars.length > 0) {
        // Determine tickSize: SPX point-space (spot ~5000-8000) → 0.25;
        // SPY ETF space (spot ~500-800) → 0.01
        const tickSize = spot > 1000 ? 0.25 : 0.01;
        vwapProfile = computeVolumeProfile(intradayBars, spot, tickSize);
        console.log(
          `[auditEnrich] vwapProfile computed from ${intradayBars.length} ${resolution} bars: ` +
          `vwap=${vwapProfile?.vwap?.toFixed(1)} poc=${vwapProfile?.poc?.toFixed(1)} ` +
          `val=${vwapProfile?.val?.toFixed(1)} vah=${vwapProfile?.vah?.toFixed(1)}`
        );
      } else {
        console.log("[auditEnrich] vwapProfile: no intraday bars available, will be null");
      }
    } catch (e: any) {
      console.warn(`[auditEnrich] vwapProfile error: ${e?.message ?? e}`);
    }

    // 8. Wire 9: jump regime (Paper M re-engineered)
    //    Pass current gex (already computed above) so gexSignFlip can use it.
    let jumpRegimeResult: JumpRegimeResult | null = null;
    try {
      jumpRegimeResult = await computeJumpRegime(gex);
    } catch (e: any) {
      console.warn(`[auditEnrich] computeJumpRegime error: ${e?.message ?? e}`);
    }

    // Mutate audit
    daily.audit = {
      ...audit,
      vommaPockets: vommaPockets.map((p) => p.strike),
      vommaPocketWeights: vommaPockets,                        // detailed
      realizedSigma20d: realizedSigma20d != null ? parseFloat(realizedSigma20d.toFixed(4)) : null,
      intradayPivot: wickZone ? wickZone.pivot : (audit.mainPivot ?? null),
      wickZones: wickZone,
      gex,
      sessionOpen,
      atmIV,
      vwapProfile: vwapProfile ?? null,
      // Wire 9 jump regime fields
      jumpRegime: jumpRegimeResult ? jumpRegimeResult.jumpRegime : null,
      jumpScore: jumpRegimeResult ? jumpRegimeResult.jumpScore : null,
      jumpFeatures: jumpRegimeResult ? jumpRegimeResult.features : null,
    };

    return result;
  } catch {
    return result;
  }
}
