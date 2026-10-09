// server/mlFeatureMath.ts
//
// Pure math for the ML quantile forecaster's live feature dict (review item
// R2-F 1/2). No DB, network or framework imports: tests/quant/ml-r2.test.ts
// loads it directly.
//
// Feature schema v2 (ML_FEATURE_SCHEMA_VERSION). What changed from v1 and why:
//   - Dealer levels come from the Schwab $SPX option chain, the same index as
//     the spot they are measured against (call/put wall and per-strike GEX:
//     gammaProfile.gexByStrikeFromChain; flip and net GEX at spot: the
//     app-wide re-priced profile, gammaProfile.repricedFlipFromChain; vanna,
//     charm, vomma and zomma peaks: chainAudit.buildChainAudit; max pain:
//     validationMath.maxPainStrike on the front unsettled expiry). v1 took
//     walls/flip from the Signals snapshot (CBOE SPY points, ~670) and
//     measured them against SPX spot (~6700): about -1,200 ATR. v1 rows are
//     never used for training (the trainer filters on schema_version).
//   - Unit guard: a level is only measured against spot when both carry the
//     same underlying symbol (the chain's own symbol when it reports one) AND
//     level/spot lies in [0.7, 1.3]. A ratio near 0.1 or 10 (a SPY level
//     against SPX spot) is "scale_mismatch"; any other ratio outside the band
//     (a far strike) is "out_of_range". Neither is ever rescaled or measured.
//   - Freshness: dealer levels are missing when the chain was served from a
//     cache (servedFromCache), flagged stale, older than 5 minutes, or of
//     unknown age; bars are only today's regular-session bars up to now.
//   - Missing is NaN (JSON null), never 0 or a training median: LightGBM
//     routes NaN down its learned missing-value branch ("LightGBM uses NA
//     (NaN) to represent missing values by default", LightGBM docs, Advanced
//     Topics, Missing Value Handle:
//     https://lightgbm.readthedocs.io/en/stable/Advanced-Topics.html), so the
//     model sees at serve time exactly what it saw in training.
//   - net_gex_sign is the sign of re-priced net dealer gamma AT spot (v1
//     compared spot with a SPY-scale flip, so it was always +1).
//   - realized_vol_5m is |r_last| annualized (v1 took the sample stdev of ONE
//     return, which is always 0).
//   - rv_session_5m (new): RMS of today's 5-minute log returns, per bar; the
//     sigma of the baseline volatility cone (mlServedBand.ts).

import { gexByStrikeFromChain, repricedFlipFromChain, FLIP_RATE, FLIP_DIV_YIELD, type ChainMapsLike } from "./gammaProfile";
import { buildChainAudit } from "./chainAudit";
import { maxPainStrike } from "./validationMath";
import { contractYears } from "./chainClock";
import { etClock, etDate, sessionCloseMinutes } from "./exchangeCalendar";

export const ML_FEATURE_SCHEMA_VERSION = 2;

/** Dealer levels older than this (chain asOf) are missing, not stale-but-shown. */
export const DEALER_LEVEL_MAX_AGE_MS = 5 * 60_000;

/** A level is only comparable with spot when level/spot is inside this band. */
export const SCALE_GUARD_LO = 0.7;
export const SCALE_GUARD_HI = 1.3;

/** Minimum 5-minute returns for the session realized-vol estimate (one hour). */
export const RV_SESSION_MIN_RETURNS = 12;

/** 5-minute bars per regular session and trading days per year (annualization). */
export const BARS_PER_DAY_5M = 78;
export const TRADING_DAYS = 252;

export interface DealerLevels {
  /** Underlying the strikes belong to, e.g. "$SPX". */
  underlying: string;
  source: "schwab";
  /** Instant the chain was produced (Schwab response time), epoch ms. */
  asOfMs: number;
  /** Underlying last from the chain itself. */
  chainSpot: number;
  callWall: number | null;
  putWall: number | null;
  /** Re-priced zero-gamma level nearest spot; null when no crossing in +/-20%. */
  flip: number | null;
  maxPain: number | null;
  zomma: number | null;
  upVomma: number | null;
  dnVomma: number | null;
  vanna: number | null;
  charm: number | null;
  /** Re-priced net dealer GEX at spot, $ per 1% move; null = not computable. */
  gexAtSpot: number | null;
  rowsUsed: number;
  /** Three largest |net GEX| strikes ($ per 1% move), for display. */
  topGex?: Array<{ strike: number; gex: number }>;
}

export interface ChainLike extends ChainMapsLike {
  underlying?: { last?: number | null; bid?: number | null; ask?: number | null } | null;
  source?: string | null;
  /** Set by the Schwab fetch layer when known (R2-A); else the caller's fetch time. */
  asOfMs?: number | null;
  servedFromCache?: boolean | null;
  /** R2-A: true when the fetch layer judged the chain stale; null = unknown. */
  stale?: boolean | null;
  /** Requested/returned symbol, when the fetch layer reports it. */
  symbol?: string | null;
}

/** "$SPX.X" -> "$SPX", "spy" -> "SPY". */
export function normalizeUnderlying(sym: string | null | undefined): string | null {
  if (!sym || typeof sym !== "string") return null;
  const u = sym.trim().toUpperCase();
  return u ? (u.startsWith("$") && u.endsWith(".X") ? u.slice(0, -2) : u) : null;
}

/** Front unsettled expiry's contracts for max pain (same expiry key, both sides). */
function frontExpiryContracts(chain: ChainLike, nowMs: number): Array<{ strike: number; type: "C" | "P"; openInterest: number }> {
  const keys = new Set<string>();
  for (const m of [chain.callExpDateMap, chain.putExpDateMap]) for (const k of Object.keys(m ?? {})) keys.add(k);
  const sorted = Array.from(keys).sort();
  for (const k of sorted) {
    const out: Array<{ strike: number; type: "C" | "P"; openInterest: number }> = [];
    for (const [side, map] of [["C", chain.callExpDateMap], ["P", chain.putExpDateMap]] as const) {
      const strikes = (map ?? {})[k] ?? {};
      for (const sk of Object.keys(strikes)) {
        const strike = parseFloat(sk);
        for (const c of strikes[sk] ?? []) {
          if (!(contractYears(k, c, nowMs) > 0)) continue; // settled (AM SPX after the open, 0DTE after the close)
          const oi = Number(c?.openInterest);
          if (Number.isFinite(strike) && strike > 0 && Number.isFinite(oi) && oi > 0) out.push({ strike, type: side, openInterest: oi });
        }
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * Dealer levels from ONE Schwab option chain of `underlying` (e.g. "$SPX").
 * Refuses (levels null + reason) a chain that is not from Schwab, reports a
 * different symbol, was served from a cache or flagged stale, is older than
 * DEALER_LEVEL_MAX_AGE_MS or of unknown age, or has no underlying last: those
 * are "unavailable", never an older or delayed substitute. The levels carry
 * the chain's own symbol (else the requested one) for the unit guard.
 */
export function dealerLevelsFromChain(
  chain: ChainLike | null | undefined,
  underlying: string,
  opts: { nowMs?: number; fetchedAtMs?: number } = {},
): { levels: DealerLevels | null; reason: string | null } {
  const nowMs = opts.nowMs ?? Date.now();
  if (!chain) return { levels: null, reason: "chain_unavailable" };
  if (chain.source !== "schwab") return { levels: null, reason: `chain_source_${chain.source ?? "unknown"}_refused` };
  const want = normalizeUnderlying(underlying);
  const chainSym = normalizeUnderlying(chain.symbol);
  if (chainSym && chainSym !== want) return { levels: null, reason: "chain_symbol_mismatch" };
  if (chain.servedFromCache === true) return { levels: null, reason: "chain_served_from_cache" };
  if (chain.stale === true) return { levels: null, reason: "chain_stale" };
  const asOfMs = typeof chain.asOfMs === "number" && Number.isFinite(chain.asOfMs) ? chain.asOfMs
    : typeof opts.fetchedAtMs === "number" && Number.isFinite(opts.fetchedAtMs) ? opts.fetchedAtMs : null;
  if (asOfMs == null) return { levels: null, reason: "chain_age_unknown" };
  if (nowMs - asOfMs > DEALER_LEVEL_MAX_AGE_MS) return { levels: null, reason: "chain_stale" };
  const last = chain.underlying?.last;
  const spot = last != null && Number.isFinite(last) && last > 0 ? last : null;
  if (spot == null) return { levels: null, reason: "chain_no_underlying_last" };

  const gex = gexByStrikeFromChain({ ...chain, underlying: { last: spot } }, nowMs);
  const flip = repricedFlipFromChain(chain, spot, { maxDte: 45, r: FLIP_RATE, q: FLIP_DIV_YIELD, nowMs });
  let zomma: number | null = null, vanna: number | null = null, charm: number | null = null;
  let upVomma: number | null = null, dnVomma: number | null = null;
  try {
    const audit = buildChainAudit(chain as any, spot, nowMs);
    zomma = audit.zomma.peakZommaStrike;
    vanna = audit.vanna.peakVannaStrike;
    charm = audit.charm.peakCharmStrike;
    const pick = (above: boolean) => audit.vomma.profile
      .filter((p) => Number.isFinite(p.vommaExposure) && p.vommaExposure !== 0 && (above ? p.strike > spot : p.strike < spot))
      .reduce<{ strike: number; vommaExposure: number } | null>((b, p) => (!b || Math.abs(p.vommaExposure) > Math.abs(b.vommaExposure) ? p : b), null)?.strike ?? null;
    upVomma = pick(true);
    dnVomma = pick(false);
  } catch { /* audit failed: those levels stay null (missing) */ }

  return {
    levels: {
      underlying: chainSym ?? want ?? underlying,
      source: "schwab",
      asOfMs,
      chainSpot: spot,
      callWall: gex.callWall,
      putWall: gex.putWall,
      flip: flip.zeroGamma,
      maxPain: maxPainStrike(frontExpiryContracts(chain, nowMs)),
      zomma, upVomma, dnVomma, vanna, charm,
      gexAtSpot: flip.gexAtSpot,
      rowsUsed: flip.rowsUsed,
      topGex: gex.profile.slice().sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, 3)
        .map((p) => ({ strike: p.strike, gex: p.netGex })),
    },
    reason: null,
  };
}

/**
 * Unit guard. Distance from spot to a level in ATR units, or NaN with a
 * reason. Refuses a level from a different underlying ("underlying_mismatch"),
 * or whose ratio to spot is outside [SCALE_GUARD_LO, SCALE_GUARD_HI]: a ratio
 * within 2x of 0.1 or 10 is a unit error ("scale_mismatch": a SPY strike
 * against SPX spot is ~0.1), anything else a far strike ("out_of_range").
 * Never rescaled, never measured.
 */
export function guardedDistanceAtr(
  level: number | null | undefined,
  levelUnderlying: string | null | undefined,
  spot: number | null | undefined,
  spotUnderlying: string,
  atr: number | null | undefined,
): { value: number; reason: string | null } {
  if (level == null || !Number.isFinite(level) || level <= 0) return { value: NaN, reason: "level_missing" };
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return { value: NaN, reason: "spot_missing" };
  const lu = normalizeUnderlying(levelUnderlying);
  if (!lu || lu !== normalizeUnderlying(spotUnderlying)) return { value: NaN, reason: "underlying_mismatch" };
  const ratio = level / spot;
  if (!(ratio >= SCALE_GUARD_LO && ratio <= SCALE_GUARD_HI)) {
    const unitError = (ratio >= 0.05 && ratio <= 0.2) || (ratio >= 5 && ratio <= 20);
    return { value: NaN, reason: unitError ? "scale_mismatch" : "out_of_range" };
  }
  if (atr == null || !Number.isFinite(atr) || atr <= 0) return { value: NaN, reason: "atr_missing" };
  return { value: (level - spot) / atr, reason: null };
}

export interface Bar5m { t: number; o: number; h: number; l: number; c: number; v?: number | null }

function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** Mean true range over the last `lookback` bars (needs >= 2 bars), else NaN. */
export function atrFromBars(bars: Bar5m[], lookback: number): number {
  const slice = bars.slice(-lookback);
  if (slice.length < 2) return NaN;
  let sum = 0, n = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(slice[i].h - slice[i].l, Math.abs(slice[i].h - slice[i - 1].c), Math.abs(slice[i].l - slice[i - 1].c));
    if (Number.isFinite(tr)) { sum += tr; n++; }
  }
  return n > 0 ? sum / n : NaN;
}

/** Root mean square of 5-minute log returns, per bar; NaN below RV_SESSION_MIN_RETURNS returns. */
export function sessionRealizedVolPerBar(logRets: number[]): number {
  const ok = logRets.filter((r) => Number.isFinite(r));
  if (ok.length < RV_SESSION_MIN_RETURNS) return NaN;
  return Math.sqrt(ok.reduce((s, r) => s + r * r, 0) / ok.length);
}

/** Bar open time in epoch ms (fetchOHLC candles carry epoch seconds). */
export function barOpenMs(t: number): number {
  return t < 1e11 ? t * 1000 : t;
}

/**
 * Bars of the regular session of nowMs's ET date only: 09:30 <= open < the
 * session close (13:00 on half days), opened before nowMs, sorted. A
 * multi-day series (e.g. a "1D" request that also returns yesterday's bars)
 * never leaks yesterday into today's returns, ATR or session RV.
 */
export function todaysSessionBars<T extends { t: number }>(bars: T[], nowMs: number): T[] {
  const day = etDate(nowMs);
  const close = sessionCloseMinutes(day);
  if (close == null) return [];
  return bars
    .filter((b) => {
      const ms = barOpenMs(b.t);
      if (!Number.isFinite(ms) || ms > nowMs) return false;
      const c = etClock(ms);
      return c.date === day && c.minutes >= 9 * 60 + 30 && c.minutes < close;
    })
    .sort((a, b) => barOpenMs(a.t) - barOpenMs(b.t));
}

export interface FeatureBuildInputs {
  nowMs: number;
  /** 5-minute bars of the spot index (any span; filtered to today's session), oldest first. */
  bars: Bar5m[];
  spot: number | null;
  /** Symbol of `spot`, e.g. "$SPX". */
  spotUnderlying: string;
  vix: number | null;
  vixPrev: number | null;
  dealer: DealerLevels | null;
  /** Why `dealer` is null, when it is. */
  dealerReason?: string | null;
}

export interface FeatureBuildResult {
  /** NaN = missing (serialized as JSON null). */
  features: Record<string, number>;
  missing: string[];
  /** Feature -> why it is missing. */
  reasons: Record<string, string>;
  schemaVersion: number;
  liveChain: boolean;
  dealerAsOfMs: number | null;
}

/**
 * The live feature dict, schema v2. Every feature whose input is unavailable
 * is NaN and listed in `missing` with a reason; nothing is filled with 0.
 */
export function computeMlFeatures(inp: FeatureBuildInputs): FeatureBuildResult {
  const reasons: Record<string, string> = {};
  const f: Record<string, number> = {};
  const set = (k: string, v: number, why = "input_missing") => {
    f[k] = Number.isFinite(v) ? v : NaN;
    if (!Number.isFinite(v)) reasons[k] = reasons[k] ?? why;
  };
  const bars = todaysSessionBars(inp.bars, inp.nowMs).filter((b) => [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0));
  const spot = inp.spot != null && Number.isFinite(inp.spot) && inp.spot > 0 ? inp.spot : (bars[bars.length - 1]?.c ?? NaN);

  // Time (ET wall clock) and the real session close (half days).
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(inp.nowMs));
  const pm: Record<string, string> = {};
  for (const p of parts) pm[p.type] = p.value;
  const hourEt = Number(pm.hour), minEt = Number(pm.minute);
  const dow = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[pm.weekday] ?? NaN;
  const frac = hourEt + minEt / 60;
  const closeHour = (sessionCloseMinutes(etDate(inp.nowMs)) ?? 16 * 60) / 60;
  set("hour_of_day", frac);
  set("minute_of_hour", minEt);
  set("day_of_week", dow);
  set("is_first_30min", frac >= 9.5 && frac < 10 ? 1 : 0);
  set("is_post_lunch", frac >= 13 && frac < Math.min(15.5, closeHour - 0.5) ? 1 : 0);
  set("is_last_30min", frac >= closeHour - 0.5 && frac < closeHour ? 1 : 0);

  set("spx_spot", spot, "spot_missing");
  const vix = inp.vix != null && inp.vix > 0 ? inp.vix : NaN;
  const vixPrev = inp.vixPrev != null && inp.vixPrev > 0 ? inp.vixPrev : NaN;
  set("vix_level", vix, "vix_missing");
  set("vix_change_pct", (vix - vixPrev) / vixPrev, Number.isFinite(vix) ? "vix_prev_missing" : "vix_missing");
  set("vix_pct_of_5d_avg", NaN, "not_computed");

  // Returns, vol, ATR, trend from today's bars.
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].c / bars[i - 1].c));
  const ANN = Math.sqrt(BARS_PER_DAY_5M * TRADING_DAYS);
  const last6 = rets.slice(-6);
  const enough = bars.length >= 7; // 6 returns = 30 minutes
  const why = "insufficient_bars";
  const rv30 = enough ? stdev(last6) : NaN;
  const rLast = rets.length > 0 ? rets[rets.length - 1] : NaN;
  set("realized_vol_30m", rv30 * ANN, why);
  set("realized_vol_5m", Math.abs(rLast) * ANN, why);
  const atr30 = enough ? atrFromBars(bars, 7) : NaN; // 6 true ranges = 30 minutes
  set("atr_5m", atr30, why);
  set("trend_30m", enough ? last6.reduce((s, x) => s + x, 0) / last6.length : NaN, why);
  set("trend_5m", rLast, why);
  set("rv_session_5m", sessionRealizedVolPerBar(rets), "insufficient_bars");
  // Legacy v1 names, same quantities, kept so the dict stays a superset.
  set("realized_vol_5min", Math.abs(rLast), why);
  set("realized_vol_30min", rv30, why);
  set("bar_return_1min", rLast, why);
  set("momentum_15min", rets.length >= 3 ? rets.slice(-3).reduce((s, x) => s + x, 0) : NaN, why);
  const open = bars[0]?.o;
  set("distance_from_open_pct", open != null && open > 0 ? (spot - open) / open : NaN, why);

  // Dealer levels: same index as spot, unit-guarded.
  const d = inp.dealer;
  const atrDen = Number.isFinite(atr30) ? Math.max(atr30, spot * 1e-4) : NaN;
  const dist = (k: string, lvl: number | null | undefined) => {
    if (!d) { f[k] = NaN; reasons[k] = inp.dealerReason ?? "dealer_levels_unavailable"; return; }
    const g = guardedDistanceAtr(lvl, d.underlying, spot, inp.spotUnderlying, atrDen);
    f[k] = g.value;
    if (g.reason) reasons[k] = g.reason;
  };
  dist("dist_to_callwall_atr", d?.callWall);
  dist("dist_to_putwall_atr", d?.putWall);
  dist("dist_to_flip_atr", d?.flip);
  dist("dist_to_maxpain_atr", d?.maxPain);
  dist("dist_to_zomma_atr", d?.zomma);
  dist("dist_to_upvomma_atr", d?.upVomma);
  dist("dist_to_dnvomma_atr", d?.dnVomma);
  dist("vanna_level_dist_atr", d?.vanna);
  dist("charm_level_dist_atr", d?.charm);
  const sameIndex = !!d && d.underlying === inp.spotUnderlying;
  const gex = sameIndex && d!.gexAtSpot != null && Number.isFinite(d!.gexAtSpot) ? d!.gexAtSpot : NaN;
  const gexWhy = !d ? (inp.dealerReason ?? "dealer_levels_unavailable") : !sameIndex ? "underlying_mismatch" : "gex_not_computable";
  set("net_gex_sign", Number.isFinite(gex) ? Math.sign(gex) : NaN, gexWhy);
  set("net_gex_magnitude", Math.abs(gex) / 1e9, gexWhy);
  set("gex_regime_ord", Number.isFinite(gex) ? Math.sign(gex) : NaN, gexWhy);
  set("net_gex_b", gex / 1e9, gexWhy);

  const missing = Object.keys(f).filter((k) => !Number.isFinite(f[k]));
  return {
    features: f,
    missing,
    reasons,
    schemaVersion: ML_FEATURE_SCHEMA_VERSION,
    liveChain: !!d,
    dealerAsOfMs: d?.asOfMs ?? null,
  };
}

/** JSON-safe copy for transport/logging: NaN -> null (JSON has no NaN). */
export function featuresForJson(f: Record<string, number>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(f)) out[k] = Number.isFinite(f[k]) ? f[k] : null;
  return out;
}

// ─── ML Lab chart levels (R2-F fix round item 6) ────────────────────────────

export interface LabLevelEntry { value: number | null; source: string; spxValue?: number | null }

/**
 * SPX-per-SPY conversion from two Schwab quotes, or null with a reason. Both
 * quotes must be fresh (stale === false: an unknown age is not fresh), taken
 * within 2 minutes of each other when both carry a time, and the ratio must
 * be in [0.08, 0.12] (SPY is about 1/10 of SPX less accrued dividends). The
 * old fixed /10 drifted by the dividend gap (~0.5% over a quarter: ~30 SPX
 * points at a wall).
 */
export function spyPerSpxRatio(
  spx: { last?: number | null; stale?: boolean | null; quoteTimeMs?: number | null } | null | undefined,
  spy: { last?: number | null; stale?: boolean | null; quoteTimeMs?: number | null } | null | undefined,
): { ratio: number | null; reason: string | null } {
  if (!spx || !(Number(spx.last) > 0)) return { ratio: null, reason: "spx_quote_missing" };
  if (!spy || !(Number(spy.last) > 0)) return { ratio: null, reason: "spy_quote_missing" };
  if (spx.stale !== false || spy.stale !== false) return { ratio: null, reason: "quote_stale_or_unknown_age" };
  if (spx.quoteTimeMs != null && spy.quoteTimeMs != null && Math.abs(spx.quoteTimeMs - spy.quoteTimeMs) > 120_000) {
    return { ratio: null, reason: "quotes_not_simultaneous" };
  }
  const r = Number(spy.last) / Number(spx.last);
  if (!(r >= 0.08 && r <= 0.12)) return { ratio: null, reason: "ratio_out_of_range" };
  return { ratio: r, reason: null };
}

/**
 * Chart levels for the ML Lab panel (same shape the panel already reads:
 * callWall, putWall, gammaFlip, zomma, vommaUpper/Lower, vanna, charm, mopex
 * = max pain, topGexStrikes, weeklyTargets) from the Schwab $SPX chain's
 * dealer levels, multiplied by `scale` (1 for SPX; the live SPY/SPX quote
 * ratio for SPY). Never the Signals snapshot gamma (CBOE SPY points). With no
 * dealer levels or no scale, every chain level is null and dataState says
 * why. User targets (SPX points) are scaled the same way and labeled.
 */
export function mlLabLevels(
  dealer: DealerLevels | null,
  dealerReason: string | null,
  opts: {
    scale: number | null;
    scaleReason?: string | null;
    display: string;
    targets?: Partial<Record<"upside" | "downside" | "t2Up" | "t2Down" | "negGamma", number | null>>;
  },
): Record<string, any> {
  const scale = opts.scale != null && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : null;
  const ok = !!dealer && scale != null;
  const entry = (v: number | null | undefined): LabLevelEntry | null =>
    ok && v != null && Number.isFinite(v) && v > 0 ? { value: v * scale!, source: "schwab_spx_chain", spxValue: v } : null;
  const target = (v: number | null | undefined): LabLevelEntry | null =>
    scale != null && v != null && Number.isFinite(v) && v > 0 ? { value: v * scale, source: "user_targets", spxValue: v } : null;
  const t = opts.targets ?? {};
  return {
    gammaFlip: entry(dealer?.flip),
    callWall: entry(dealer?.callWall),
    putWall: entry(dealer?.putWall),
    topGexStrikes: ok ? (dealer!.topGex ?? []).map((g) => ({ strike: g.strike * scale!, gex: g.gex, source: "schwab_spx_chain" })) : [],
    vanna: entry(dealer?.vanna),
    charm: entry(dealer?.charm),
    vommaUpper: entry(dealer?.upVomma),
    vommaLower: entry(dealer?.dnVomma),
    zomma: entry(dealer?.zomma),
    mopex: entry(dealer?.maxPain),
    negGamma: target(t.negGamma),
    weeklyTargets: { upside: target(t.upside), downside: target(t.downside), t2Up: target(t.t2Up), t2Down: target(t.t2Down) },
    spxNow: dealer?.chainSpot ?? null,
    asOf: dealer ? new Date(dealer.asOfMs).toISOString() : null,
    display: opts.display,
    scale,
    source: "Schwab $SPX option chain (dealer levels re-computed, same index as spot)",
    dataState: ok ? "ok" : "unavailable",
    reason: ok ? null : (!dealer ? (dealerReason ?? "dealer_levels_unavailable") : (opts.scaleReason ?? "scale_unavailable")),
  };
}
