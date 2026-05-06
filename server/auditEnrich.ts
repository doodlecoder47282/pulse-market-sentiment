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
 * Main entry — augments daily horizon audit with the 5 missing fields.
 * Returns the same response object (mutated in place).
 *
 * IMPORTANT: This must run AFTER applyTermStructureRescale so the
 * scenarioTargets are already proper for non-daily horizons.
 */
export function enrichAudit(
  result: ModelsResponse,
  vixData: { vix: number | null; vix9d: number | null; vix3m: number | null },
): ModelsResponse {
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

    // Mutate audit
    daily.audit = {
      ...audit,
      vommaPockets: vommaPockets.map((p) => p.strike),
      vommaPocketWeights: vommaPockets,                        // detailed
      realizedSigma20d: realizedSigma20d != null ? parseFloat(realizedSigma20d.toFixed(4)) : null,
      intradayPivot: wickZone ? wickZone.pivot : (audit.mainPivot ?? null),
      wickZones: wickZone,
    };

    return result;
  } catch {
    return result;
  }
}
