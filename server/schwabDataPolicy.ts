// server/schwabDataPolicy.ts
//
// Pure policy for Schwab market data (no DB, network or package imports, so it
// is unit tested in tests/quant/data-r2.test.ts):
//
//   1. What kind of data a Schwab request is (quotes, chains, minute bars,
//      daily bars, market hours).
//   2. How long a cached Schwab response may be reused as fresh (TTL) and the
//      hard maximum age at which it may still be served, with its real asOf,
//      when Schwab cannot answer (403 / 429 / 5xx / throttle / network).
//      Past the maximum age the answer is "unavailable", never older data.
//   3. How many strikes to request from /marketdata/v1/chains for a given
//      expiry window (strikeCount sized from the expected move), and how to
//      verify the coverage that actually came back.
//
// User decision 2026-10-08: Schwab is the only market-data source. No CBOE,
// no delayed or cached fallback presented as current.

import { isRegularSessionOpen } from "./exchangeCalendar";

export type SchwabDataKind = "quotes" | "chains" | "minute_bars" | "daily_bars" | "markets" | "other";

/** Classify a Schwab market-data path (+ params) into a data kind. */
export function schwabDataKind(path: string, params?: Record<string, string | number>): SchwabDataKind {
  const p = path.replace(/^\/+/, "");
  if (p.startsWith("marketdata/v1/quotes")) return "quotes";
  if (p.startsWith("marketdata/v1/chains")) return "chains";
  if (p.startsWith("marketdata/v1/pricehistory")) {
    const ft = params ? String(params.frequencyType ?? "").toLowerCase() : "";
    return ft === "minute" ? "minute_bars" : "daily_bars";
  }
  if (p.startsWith("marketdata/v1/markets")) return "markets";
  return "other";
}

/**
 * Fresh-reuse TTL (ms): a cached response younger than this is returned
 * without a new request. 0 = never cached. Unchanged from the previous
 * per-endpoint TTLs (quotes 30 s, chains 60 s, minute bars 20 s, daily+ 5 min,
 * market hours 5 min).
 */
export const FRESH_TTL_MS: Record<SchwabDataKind, number> = {
  quotes: 30_000,
  chains: 60_000,
  minute_bars: 20_000,
  daily_bars: 300_000,
  markets: 300_000,
  other: 0,
};

/**
 * Hard maximum age (ms) at which a cached Schwab response may still be served
 * when a fresh request fails. Beyond it the caller gets null / unavailable.
 *
 * Regular session (prices move):
 *   quotes       2 min  = quoteFreshness.QUOTE_STALE_AFTER_MS (same rule the
 *                         quote chip already uses; 4x the 30 s TTL)
 *   chains       3 min  = 3x the 60 s TTL. A 0DTE chain older than a few
 *                         minutes misstates gamma/charm (theta and spot have
 *                         moved), so we do not stretch it further.
 *   minute bars  2 min  = the last 1-minute bar is at most ~2 bars behind
 *   daily bars  15 min  = today's partial daily bar; completed bars do not change
 *   market hours 6 h    = the session calendar for the day does not change
 * Outside the regular session (no regular-hours trading; prices static apart
 * from extended-hours equity prints and Cboe GTH index options):
 *   quotes 15 min, chains 30 min, minute bars 30 min, daily bars 6 h, hours 24 h.
 * These are operating limits (heuristics), stated so the UI can show them;
 * they are not derived from a model.
 */
export const MAX_SERVE_AGE_MS: Record<"rth" | "closed", Record<SchwabDataKind, number>> = {
  rth: {
    quotes: 120_000,
    chains: 180_000,
    minute_bars: 120_000,
    daily_bars: 15 * 60_000,
    markets: 6 * 3600_000,
    other: 0,
  },
  closed: {
    quotes: 15 * 60_000,
    chains: 30 * 60_000,
    minute_bars: 30 * 60_000,
    daily_bars: 6 * 3600_000,
    markets: 24 * 3600_000,
    other: 0,
  },
};

export function maxServeAgeMs(kind: SchwabDataKind, nowMs: number = Date.now()): number {
  return MAX_SERVE_AGE_MS[isRegularSessionOpen(nowMs) ? "rth" : "closed"][kind];
}

/** Provenance carried on every chain / price-history response. */
export interface SchwabFreshness {
  /** When Schwab produced this payload (our receive time), epoch ms. */
  asOfMs: number;
  /** now - asOfMs, ms. */
  ageMs: number;
  /** true when this payload came from the in-memory cache rather than a request made for this call. */
  servedFromCache: boolean;
  /**
   * true when a refresh was attempted and failed, so an older payload (still
   * within maxAgeMs) is being served. A normal TTL cache hit is not stale.
   */
  stale: boolean;
  /** Max age this kind may be served at right now. */
  maxAgeMs: number;
  /** Why the payload is stale or unavailable (e.g. "403 cooldown"); null when fresh. */
  reason: string | null;
}

export type CacheDecision =
  | { serve: true; freshness: SchwabFreshness }
  | { serve: false; ageMs: number | null; maxAgeMs: number; reason: string };

/**
 * May a cached payload fetched at `fetchedAtMs` be served after a failed
 * refresh? Yes within maxServeAgeMs(kind) (stale = true, age attached);
 * otherwise unavailable.
 */
export function staleServeDecision(
  fetchedAtMs: number | null | undefined,
  kind: SchwabDataKind,
  reason: string,
  nowMs: number = Date.now(),
): CacheDecision {
  const maxAgeMs = maxServeAgeMs(kind, nowMs);
  if (fetchedAtMs == null || !Number.isFinite(fetchedAtMs)) {
    return { serve: false, ageMs: null, maxAgeMs, reason: `${reason}; no cached Schwab response` };
  }
  const ageMs = Math.max(0, nowMs - fetchedAtMs);
  if (maxAgeMs <= 0 || ageMs > maxAgeMs) {
    return {
      serve: false, ageMs, maxAgeMs,
      reason: `${reason}; cached Schwab response is ${Math.round(ageMs / 1000)} s old (max ${Math.round(maxAgeMs / 1000)} s)`,
    };
  }
  return {
    serve: true,
    freshness: { asOfMs: fetchedAtMs, ageMs, servedFromCache: true, stale: true, maxAgeMs, reason },
  };
}

/** Freshness of a payload served fresh (new request) or from a TTL cache hit. */
export function freshFreshness(
  fetchedAtMs: number,
  kind: SchwabDataKind,
  servedFromCache: boolean,
  nowMs: number = Date.now(),
): SchwabFreshness {
  return {
    asOfMs: fetchedAtMs,
    ageMs: Math.max(0, nowMs - fetchedAtMs),
    servedFromCache,
    stale: false,
    maxAgeMs: maxServeAgeMs(kind, nowMs),
    reason: null,
  };
}

// ─── Option-chain strike coverage (finding 1.7) ──────────────────────────────
//
// Old request: strikeCount 60 for every symbol and window. On SPX (5-point
// strikes near the money) that is +-150 points (about +-2.2%) if Schwab
// counts strikes in total, or +-300 (about +-4.5%) if it counts per side:
// narrower than the +-10% re-priced flip scan and far short of the 25-delta
// put at 60-90 DTE (about -8% at a 0.18 ATM vol with a put-skew wing).
//
// New request: strikeCount sized from the expected move of the longest expiry
// in the window:
//   halfWidth = max(10%, z10 * wingMult * iv * sqrt(T_max)),  capped at 35%
//   z10 = N^-1(0.90) = 1.2816: the 10-delta strike sits ~z10 * sigma * sqrt(T)
//         from the forward, so the window brackets 25 delta on both sides
//         (needed to interpolate IV to exactly 25 delta) with room to spare;
//   wingMult = 1.5: OTM put IV runs well above ATM on index skews, which pushes
//         the 10-delta put further out;
//   10% floor = the re-priced gamma-flip scan range (gammaProfile 0.9S-1.1S).
//   strikes per side = ceil(halfWidth * S / spacing), spacing = finest listed
//   strike interval near the money for the symbol.
// Schwab documents strikeCount as "the number of strikes to return above and
// below the at-the-money price" (schwab-py client docs) without saying whether
// that is per side or in total. Until a response tells us (inferStrikeCountSemantics),
// we request 2x the per-side count, which covers the window under either
// reading; the returned chain's coverage is then measured (strikeCoverage) and
// reported on the response, so a short window is visible, not silent.
//
// Request-size cost (estimate; actual bytes are recorded per request in
// /api/schwab/diag once live): a Schwab option contract object is ~1.3 KB of
// JSON (about 50 fields). SPX 0DTE window at 10%: ~270 strikes x 2 sides x 1-2
// expiry dates = 0.5-1.1k contracts, ~0.7-1.4 MB (was ~0.15-0.3 MB at 60).

/** N^-1(0.90): standard normal quantile of the 10-delta strike. */
export const Z_10_DELTA = 1.2815515655446004;
export const WING_IV_MULT = 1.5;
export const MIN_HALF_WIDTH_PCT = 0.10;
export const MAX_HALF_WIDTH_PCT = 0.35;
/** Hard cap on the strikeCount sent to Schwab (bounds payload size on long windows). */
export const MAX_STRIKE_COUNT = 300;
/** Default ATM vol when no recent chain for the symbol is known. */
export const DEFAULT_ATM_IV = 0.25;

function baseSymbol(symbol: string): string {
  let s = symbol.toUpperCase().trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (s.endsWith(".X")) s = s.slice(0, -2);
  if (s.startsWith("^")) s = s.slice(1);
  return s;
}

/**
 * Finest strike interval listed near the money (assumption per symbol class;
 * the response's real coverage is verified afterwards).
 *  - SPX/SPXW, RUT, XSP-style index options: 5 points near the money (SPX)
 *  - NDX: 10 points
 *  - VIX: 0.5-1 point (0.5 used)
 *  - liquid ETFs (SPY, QQQ, IWM, DIA, ...): $1
 *  - single stocks by price: <$25: $0.5, <$200: $1, <$500: $2.5, else $5
 */
export function strikeSpacingFor(symbol: string, spot: number | null): number {
  const b = baseSymbol(symbol);
  if (b === "SPX" || b === "SPXW" || b === "RUT") return 5;
  if (b === "NDX" || b === "NDXP") return 10;
  if (b === "VIX") return 0.5;
  if (b === "XSP") return 1;
  if (["SPY", "QQQ", "IWM", "DIA", "TLT", "GLD", "SLV", "XLF", "XLE", "SMH", "HYG", "EEM"].includes(b)) return 1;
  const s = spot != null && spot > 0 ? spot : 100;
  if (s < 25) return 0.5;
  if (s < 200) return 1;
  if (s < 500) return 2.5;
  return 5;
}

export type StrikeCountSemantics = "per_side" | "unknown";

export interface StrikePlan {
  /** Target coverage each side of spot, decimal (0.10 = +-10%). */
  halfWidthPct: number;
  spacing: number;
  /** Strikes needed on each side of spot to reach halfWidthPct. */
  perSide: number;
  /** strikeCount sent to Schwab. */
  strikeCount: number;
  /** true when MAX_STRIKE_COUNT cut the request below the target. */
  capped: boolean;
  basis: string;
}

/**
 * strikeCount for a chain request covering expiries up to `dteMax` calendar days.
 * @param spot   underlying price (null = unknown: falls back to 200 strikes)
 * @param atmIv  ATM implied vol, decimal (null = DEFAULT_ATM_IV)
 */
export function chainStrikePlan(args: {
  symbol: string;
  spot: number | null;
  dteMax: number | null | undefined;
  atmIv?: number | null;
  semantics?: StrikeCountSemantics;
}): StrikePlan {
  const dte = args.dteMax != null && Number.isFinite(args.dteMax) && args.dteMax > 0 ? args.dteMax : 1;
  const iv = args.atmIv != null && Number.isFinite(args.atmIv) && args.atmIv > 0.01 && args.atmIv < 3 ? args.atmIv : DEFAULT_ATM_IV;
  const T = dte / 365;
  const emWidth = Z_10_DELTA * WING_IV_MULT * iv * Math.sqrt(T);
  const halfWidthPct = Math.min(MAX_HALF_WIDTH_PCT, Math.max(MIN_HALF_WIDTH_PCT, emWidth));
  const spacing = strikeSpacingFor(args.symbol, args.spot);
  const basis = `+-${(halfWidthPct * 100).toFixed(1)}% = max(10% flip scan, 10-delta wing ${(emWidth * 100).toFixed(1)}%: z10 ${Z_10_DELTA.toFixed(4)} x ${WING_IV_MULT} x iv ${(iv * 100).toFixed(1)}% x sqrt(${dte}/365))`;
  if (args.spot == null || !(args.spot > 0)) {
    return { halfWidthPct, spacing, perSide: 100, strikeCount: 200, capped: false, basis: `${basis}; spot unknown, 200 strikes` };
  }
  const perSide = Math.ceil((halfWidthPct * args.spot) / spacing);
  const wanted = args.semantics === "per_side" ? perSide : 2 * perSide;
  const strikeCount = Math.min(MAX_STRIKE_COUNT, Math.max(10, wanted));
  return { halfWidthPct, spacing, perSide, strikeCount, capped: wanted > MAX_STRIKE_COUNT, basis };
}

/**
 * Infer how Schwab counts strikeCount from one response: in the nearest
 * expiry, count listed strikes strictly below and above spot. Only one
 * conclusion is safe to draw: if BOTH sides hold at least 80% of the
 * requested count, strikeCount must be per side (a total count cannot put
 * that many on each side). Anything else is "unknown" -- a short listing can
 * mimic a total count -- and the planner keeps the conservative 2x request.
 */
export function inferStrikeCountSemantics(requested: number, strikesBelow: number, strikesAbove: number): StrikeCountSemantics {
  if (!(requested > 0)) return "unknown";
  if (Math.min(strikesBelow, strikesAbove) >= 0.8 * requested) return "per_side";
  return "unknown";
}

export interface StrikeCoverage {
  /** Target from the plan (decimal each side). */
  targetHalfWidthPct: number;
  /** Worst (smallest) coverage below spot across expiries, decimal. */
  belowPct: number | null;
  /** Worst (smallest) coverage above spot across expiries, decimal. */
  abovePct: number | null;
  /** true when every expiry reaches the target on both sides (within one strike). */
  complete: boolean;
  expiries: number;
  /** Strikes below / above spot in the nearest expiry (for inferStrikeCountSemantics). */
  nearestBelow: number;
  nearestAbove: number;
}

type ExpMap = Record<string, Record<string, unknown[]>> | null | undefined;

/** Measure the strike coverage a chain response actually delivered. */
export function strikeCoverage(
  chain: { callExpDateMap?: ExpMap; putExpDateMap?: ExpMap },
  spot: number,
  targetHalfWidthPct: number,
  spacing: number,
): StrikeCoverage {
  const byExp = new Map<string, Set<number>>();
  for (const map of [chain.callExpDateMap, chain.putExpDateMap]) {
    if (!map) continue;
    for (const expKey of Object.keys(map)) {
      const set = byExp.get(expKey) ?? new Set<number>();
      for (const sk of Object.keys(map[expKey] ?? {})) {
        const k = parseFloat(sk);
        if (Number.isFinite(k) && k > 0) set.add(k);
      }
      byExp.set(expKey, set);
    }
  }
  const keys = Array.from(byExp.keys()).sort();
  if (!(spot > 0) || keys.length === 0) {
    return { targetHalfWidthPct, belowPct: null, abovePct: null, complete: false, expiries: keys.length, nearestBelow: 0, nearestAbove: 0 };
  }
  let below = Infinity, above = Infinity;
  for (const k of keys) {
    const strikes = Array.from(byExp.get(k) ?? []);
    if (!strikes.length) continue;
    const lo = Math.min(...strikes), hi = Math.max(...strikes);
    below = Math.min(below, Math.max(0, (spot - lo) / spot));
    above = Math.min(above, Math.max(0, (hi - spot) / spot));
  }
  const near = Array.from(byExp.get(keys[0]) ?? []);
  const nearestBelow = near.filter((k) => k < spot).length;
  const nearestAbove = near.filter((k) => k > spot).length;
  const slack = spacing / spot;
  const belowPct = Number.isFinite(below) ? below : null;
  const abovePct = Number.isFinite(above) ? above : null;
  const complete = belowPct != null && abovePct != null
    && belowPct + slack >= targetHalfWidthPct && abovePct + slack >= targetHalfWidthPct;
  return { targetHalfWidthPct, belowPct, abovePct, complete, expiries: keys.length, nearestBelow, nearestAbove };
}

/** ATM implied vol (decimal) of the nearest expiry: mean of the call and put vol at the strike closest to spot. */
export function atmIvFromChain(
  chain: { callExpDateMap?: ExpMap; putExpDateMap?: ExpMap },
  spot: number,
): number | null {
  if (!(spot > 0)) return null;
  const keys = Array.from(new Set([
    ...Object.keys(chain.callExpDateMap ?? {}),
    ...Object.keys(chain.putExpDateMap ?? {}),
  ])).sort();
  for (const key of keys) {
    const vols: number[] = [];
    let bestK: number | null = null;
    for (const map of [chain.callExpDateMap, chain.putExpDateMap]) {
      for (const sk of Object.keys(map?.[key] ?? {})) {
        const k = parseFloat(sk);
        if (Number.isFinite(k) && (bestK == null || Math.abs(k - spot) < Math.abs(bestK - spot))) bestK = k;
      }
    }
    if (bestK == null) continue;
    for (const map of [chain.callExpDateMap, chain.putExpDateMap]) {
      const strikes = map?.[key] ?? {};
      for (const sk of Object.keys(strikes)) {
        if (parseFloat(sk) !== bestK) continue;
        for (const c of (strikes[sk] ?? []) as any[]) {
          const v = Number(c?.volatility);
          if (Number.isFinite(v) && v > 0 && v < 500) vols.push(v / 100);
        }
      }
    }
    if (vols.length) return vols.reduce((a, b) => a + b, 0) / vols.length;
  }
  return null;
}
