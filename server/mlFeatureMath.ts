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
//     same underlying symbol AND level/spot lies in [0.7, 1.3]. A SPY-scale
//     level against SPX spot (ratio ~0.1) is refused, never rescaled.
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
import { etDate, sessionCloseMinutes } from "./exchangeCalendar";

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
}

export interface ChainLike extends ChainMapsLike {
  underlying?: { last?: number | null; bid?: number | null; ask?: number | null } | null;
  source?: string | null;
  /** Set by the Schwab fetch layer when known (R2-A); else the caller's fetch time. */
  asOfMs?: number | null;
  servedFromCache?: boolean | null;
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
 * Refuses (levels null + reason) a chain that is not from Schwab, has no
 * underlying last, or is older than DEALER_LEVEL_MAX_AGE_MS: those are
 * "unavailable", never an older or delayed substitute.
 */
export function dealerLevelsFromChain(
  chain: ChainLike | null | undefined,
  underlying: string,
  opts: { nowMs?: number; fetchedAtMs?: number } = {},
): { levels: DealerLevels | null; reason: string | null } {
  const nowMs = opts.nowMs ?? Date.now();
  if (!chain) return { levels: null, reason: "chain_unavailable" };
  if (chain.source !== "schwab") return { levels: null, reason: `chain_source_${chain.source ?? "unknown"}_refused` };
  const asOfMs = Number.isFinite(chain.asOfMs as number) ? (chain.asOfMs as number) : (opts.fetchedAtMs ?? nowMs);
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
      underlying,
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
    },
    reason: null,
  };
}

/**
 * Unit guard. Distance from spot to a level in ATR units, or NaN with a
 * reason. Refuses a level from a different underlying, or whose ratio to spot
 * is outside [SCALE_GUARD_LO, SCALE_GUARD_HI] (a SPY strike against SPX spot
 * is ~0.1): never rescaled, never measured.
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
  if (!levelUnderlying || levelUnderlying !== spotUnderlying) return { value: NaN, reason: "underlying_mismatch" };
  const ratio = level / spot;
  if (!(ratio >= SCALE_GUARD_LO && ratio <= SCALE_GUARD_HI)) return { value: NaN, reason: "scale_mismatch" };
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

export interface FeatureBuildInputs {
  nowMs: number;
  /** Today's regular-session 5-minute bars of the spot index, oldest first. */
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
  const bars = inp.bars.filter((b) => [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0));
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
