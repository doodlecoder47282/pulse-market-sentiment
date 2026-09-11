/**
 * odteProjection.ts — forward 0DTE session map.
 *
 * Two products, both deterministic (no Monte Carlo, consistent with killbox 13w):
 *
 *  1. LEVEL MAP — every meaningful price level for the session, each with a real
 *     probability of being TOUCHED before the close. Uses the reflection principle
 *     for a driftless barrier: P(touch) = 2·Φ(-|L-S| / (σ·√t)). This is the honest
 *     first-passage probability, not a made-up score. Levels already touched today
 *     are marked and get P=1.
 *
 *  2. PROJECTED CANDLES — synthetic OHLC bars from now to 16:00 ET, routed along the
 *     median path (pin gravity + charm tilt + level attraction) with wick extent
 *     scaled by per-bucket sigma. Seeded from the session date so the shape is
 *     STABLE across refreshes within a day — it does not flicker every 60s.
 *
 * These are projections of the model's expected shape, NOT a forecast of actual bars.
 */

export const MIN_PER_YEAR = 252 * 390;

/** Abramowitz-Stegun 7.1.26 normal CDF. */
export function normCdf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

/** Probability of touching barrier L before horizon, driftless. Reflection principle. */
export function pTouch(spot: number, level: number, sigmaAbs: number): number {
  if (!(sigmaAbs > 0)) return 0;
  const d = Math.abs(level - spot) / sigmaAbs;
  return Math.max(0, Math.min(1, 2 * normCdf(-d)));
}

/** Deterministic LCG — stable within a session seed. */
export function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export type LevelKind =
  | "call_wall"
  | "put_wall"
  | "gamma_flip"
  | "pin"
  | "gex_peak"
  | "prior_close"
  | "session_high"
  | "session_low"
  | "orb_high"
  | "orb_low"
  | "vwap"
  | "sigma";

export interface MappedLevel {
  price: number;
  kind: LevelKind;
  label: string;
  side: "above" | "below" | "at";
  distance: number;
  distancePct: number;
  pTouch: number;
  touched: boolean;
  /** structural strength 0-1 — how hard dealers defend it */
  strength: number;
  note: string;
}

export interface SessionBars {
  priorClose: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  orbHigh: number | null;
  orbLow: number | null;
  vwap: number | null;
}

/** Derive session anchors from Schwab minute candles (today's RTH only). */
export function deriveSessionBars(
  candles: Array<{ datetime: number; open: number; high: number; low: number; close: number; volume: number }>,
): SessionBars {
  const out: SessionBars = {
    priorClose: null, sessionHigh: null, sessionLow: null,
    orbHigh: null, orbLow: null, vwap: null,
  };
  if (!candles?.length) return out;

  const etKey = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const etMinutes = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
    const h = parseInt(p.find(x => x.type === "hour")?.value || "0", 10) % 24;
    const m = parseInt(p.find(x => x.type === "minute")?.value || "0", 10);
    return h * 60 + m;
  };

  const todayKey = etKey(Date.now());
  const today = candles.filter(c => etKey(c.datetime) === todayKey && etMinutes(c.datetime) >= 570 && etMinutes(c.datetime) < 960);
  const prior = candles.filter(c => etKey(c.datetime) !== todayKey);

  if (prior.length) out.priorClose = prior[prior.length - 1].close;

  if (today.length) {
    out.sessionHigh = Math.max(...today.map(c => c.high));
    out.sessionLow = Math.min(...today.map(c => c.low));
    const orb = today.filter(c => etMinutes(c.datetime) < 600); // 9:30–10:00
    if (orb.length) {
      out.orbHigh = Math.max(...orb.map(c => c.high));
      out.orbLow = Math.min(...orb.map(c => c.low));
    }
    let pv = 0, vv = 0;
    for (const c of today) {
      const tp = (c.high + c.low + c.close) / 3;
      const v = c.volume || 0;
      pv += tp * v; vv += v;
    }
    if (vv > 0) out.vwap = pv / vv;
  }
  return out;
}

/**
 * Build the ranked level map.
 * sigmaToClose = absolute 1-sigma move remaining to the close.
 */
export function buildLevelMap(args: {
  spot: number;
  sigmaToClose: number;
  levels: { callWall: number | null; putWall: number | null; gammaFlip: number | null; pin: number | null };
  gexPeaks: Array<{ strike: number; gex: number }>;
  bars: SessionBars;
  totalAbsGex: number;
}): MappedLevel[] {
  const { spot, sigmaToClose, levels, gexPeaks, bars, totalAbsGex } = args;
  const raw: Array<{ price: number; kind: LevelKind; label: string; strength: number; note: string }> = [];

  const push = (price: number | null | undefined, kind: LevelKind, label: string, strength: number, note: string) => {
    if (price == null || !isFinite(price) || price <= 0) return;
    raw.push({ price: Math.round(price * 100) / 100, kind, label, strength: Math.max(0, Math.min(1, strength)), note });
  };

  push(levels.callWall, "call_wall", "Call Wall", 0.95, "largest positive GEX — dealers sell into it, hardest ceiling of the day");
  push(levels.putWall, "put_wall", "Put Wall", 0.95, "largest negative GEX — dealers buy into it, hardest floor of the day");
  push(levels.gammaFlip, "gamma_flip", "Gamma Flip", 0.9, "sign change in dealer gamma — above it moves get damped, below they get amplified");
  push(levels.pin, "pin", "Pin", 0.85, "max |GEX| near spot — magnet into the close if we stay long gamma");
  push(bars.priorClose, "prior_close", "Prior Close", 0.6, "gap-fill reference, algo anchor");
  push(bars.sessionHigh, "session_high", "Session High", 0.55, "intraday high — break = trend continuation, reject = fade");
  push(bars.sessionLow, "session_low", "Session Low", 0.55, "intraday low — break = trend continuation, reject = fade");
  push(bars.orbHigh, "orb_high", "ORB High", 0.65, "opening 30min range high — Crabel breakout trigger");
  push(bars.orbLow, "orb_low", "ORB Low", 0.65, "opening 30min range low — Crabel breakdown trigger");
  push(bars.vwap, "vwap", "VWAP", 0.7, "institutional cost basis — mean-reversion magnet in long gamma");

  // secondary GEX peaks (skip ones already captured as walls)
  const taken = new Set([levels.callWall, levels.putWall, levels.pin].filter(x => x != null));
  const sorted = [...gexPeaks].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));
  let added = 0;
  for (const p of sorted) {
    if (added >= 4) break;
    if (taken.has(p.strike)) continue;
    if (Math.abs(p.strike - spot) / spot > 0.02) continue;
    const rel = totalAbsGex > 0 ? Math.abs(p.gex) / totalAbsGex : 0;
    if (rel < 0.02) continue;
    push(p.strike, "gex_peak", `GEX ${p.gex >= 0 ? "+" : "−"}${p.strike}`, 0.4 + rel, `secondary gamma shelf, ${(rel * 100).toFixed(1)}% of book`);
    taken.add(p.strike);
    added++;
  }

  // sigma rails
  if (sigmaToClose > 0) {
    push(spot + sigmaToClose, "sigma", "+1σ", 0.5, "1σ upper rail — ~32% of sessions close beyond one of the rails");
    push(spot - sigmaToClose, "sigma", "−1σ", 0.5, "1σ lower rail — reaching it early means the straddle was underpriced");
    push(spot + 2 * sigmaToClose, "sigma", "+2σ", 0.3, "2σ upper — tail; only on a real vol expansion");
    push(spot - 2 * sigmaToClose, "sigma", "−2σ", 0.3, "2σ lower — tail; only on a real vol expansion");
  }

  // dedupe near-identical prices, keep the strongest
  const byPrice = new Map<number, typeof raw[0]>();
  for (const r of raw) {
    const key = Math.round(r.price / Math.max(1, spot * 0.0004));
    const prev = byPrice.get(key);
    if (!prev || r.strength > prev.strength) byPrice.set(key, r);
  }

  const out: MappedLevel[] = [];
  for (const r of byPrice.values()) {
    const dist = r.price - spot;
    const touchedToday =
      (bars.sessionHigh != null && bars.sessionLow != null && r.price <= bars.sessionHigh && r.price >= bars.sessionLow);
    out.push({
      price: r.price,
      kind: r.kind,
      label: r.label,
      side: Math.abs(dist) < spot * 0.0003 ? "at" : dist > 0 ? "above" : "below",
      distance: +dist.toFixed(2),
      distancePct: +((dist / spot) * 100).toFixed(3),
      pTouch: touchedToday ? 1 : +pTouch(spot, r.price, sigmaToClose).toFixed(3),
      touched: touchedToday,
      strength: +r.strength.toFixed(2),
      note: r.note,
    });
  }
  // rank: nearest-and-strongest first
  out.sort((a, b) => b.pTouch * b.strength - a.pTouch * a.strength);
  return out;
}

export interface ProjCandle {
  minute: number;
  et: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** upper/lower envelope of the model cone at this bucket */
  bandUp: number;
  bandDn: number;
}

/**
 * Generate projected candles from now to the close.
 *
 * Route = median path with level attraction. Long gamma pulls toward the pin;
 * short gamma pushes AWAY from the flip (dealers amplify). Wick extent scales
 * with per-bucket sigma. Seeded so the projection is stable intraday.
 */
export function projectCandles(args: {
  spot: number;
  atmIV: number;
  projMinutes: number;
  startAbsMin: number;
  regime: "long_gamma" | "short_gamma" | "indeterminate";
  pin: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  pinPullMax: number;
  charmNorm: number;
  seed: number;
  bucketMin?: number;
}): ProjCandle[] {
  const {
    spot, atmIV, projMinutes, startAbsMin, regime,
    pin, gammaFlip, callWall, putWall, pinPullMax, charmNorm, seed,
  } = args;
  const bucket = args.bucketMin ?? 15;
  const n = Math.max(1, Math.round(projMinutes / bucket));
  if (!(atmIV > 0) || projMinutes <= 0) return [];

  const rng = makeRng(seed);
  const coneWiden = regime === "short_gamma" ? 1.15 : 1.0;
  const sigAt = (tMin: number) => spot * atmIV * Math.sqrt(Math.max(tMin, 0.01) / MIN_PER_YEAR) * coneWiden;

  const out: ProjCandle[] = [];
  let prevClose = spot;
  // mean-reverting wiggle so the shape is organic but never exceeds the cone
  let wiggle = 0;

  for (let i = 1; i <= n; i++) {
    const tMin = (projMinutes * i) / n;
    const prog = i / n;
    const sig = sigAt(tMin);
    const sigBucket = sigAt(Math.max(bucket, 1));

    // ── median route ──
    let target = spot;
    if (regime === "long_gamma" && pin != null) {
      target = spot + (pin - spot) * pinPullMax * Math.pow(prog, 0.7);
    } else if (regime === "short_gamma" && gammaFlip != null) {
      // dealers amplify: drift away from flip in the direction spot already sits
      const dir = spot >= gammaFlip ? 1 : -1;
      target = spot + dir * sig * 0.25;
    }
    target += charmNorm * sig;

    // clamp inside the walls — dealers defend them
    if (callWall != null && target > callWall) target = callWall - (target - callWall) * 0.4;
    if (putWall != null && target < putWall) target = putWall + (putWall - target) * 0.4;

    // ── organic wiggle, mean-reverting, capped well inside the cone ──
    wiggle = wiggle * 0.55 + (rng() - 0.5) * 2 * sigBucket * 0.45;
    const maxW = sig * 0.5;
    if (wiggle > maxW) wiggle = maxW;
    if (wiggle < -maxW) wiggle = -maxW;

    const close = target + wiggle;
    const open = prevClose;
    const bodyHi = Math.max(open, close);
    const bodyLo = Math.min(open, close);
    const wickUp = sigBucket * (0.45 + rng() * 0.45);
    const wickDn = sigBucket * (0.45 + rng() * 0.45);

    const absMin = startAbsMin + tMin;
    const hh = Math.floor(absMin / 60), mm = Math.floor(absMin % 60);

    out.push({
      minute: Math.round(tMin),
      et: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      open: +open.toFixed(2),
      high: +(bodyHi + wickUp).toFixed(2),
      low: +(bodyLo - wickDn).toFixed(2),
      close: +close.toFixed(2),
      bandUp: +(target + sig).toFixed(2),
      bandDn: +(target - sig).toFixed(2),
    });
    prevClose = close;
  }
  return out;
}

/** Session-stable seed: YYYYMMDD in ET. */
export function sessionSeed(): number {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parseInt(s.replace(/-/g, ""), 10);
}
