// server/impliedScenario.ts
//
// Pure helpers that turn one expiry of an option chain into
//   (a) the daily expected move from the at-the-money straddle, and
//   (b) bull / base / bear scenario odds read from the smoothed implied
//       (risk-neutral) distribution (breedenLitzenberger.ts).
// No I/O. All prices are per share in index points (SPX: $100 per point per
// contract; nothing here is a dollar P&L).

import { black76, fitImpliedDistribution, type ImpliedDistribution, type OptionQuote } from "./breedenLitzenberger";
import { timeToExpiry } from "./timeToExpiry";

// ─── (a) Straddle expected move ─────────────────────────────────────────────
//
// Brenner & Subrahmanyam (1988), "A Simple Formula to Compute the Implied
// Standard Deviation", Financial Analysts Journal 44(5): an at-the-money call
// is worth about 0.4 * S * sigma * sqrt(T) (exactly S*sigma*sqrt(T)/sqrt(2*pi)
// to first order), so the ATM straddle is about 0.8 * S * sigma * sqrt(T), and
// the one-standard-deviation move to expiry is about straddle / 0.8.
// Here the straddle is inverted exactly with Black-76 for the total vol
// v = sigma * sqrt(T) (the price depends on sigma and T only through v, so no
// time-to-expiry clock is needed), and the 1-sigma move is F * v. The
// first-order value straddle / sqrt(2/pi) is reported alongside.

export interface StraddleExpectedMove {
  method: "atm-straddle";
  strike: number;            // strike(s) used: nearest the forward
  straddleMid: number;       // call mid + put mid at that strike, index points per share
  forward: number;           // put-call parity forward: K + (C - P) / D
  totalVol: number;          // v = sigma_ATM * sqrt(T), solved from the straddle
  oneSigmaMove: number;      // F * v: 1 standard deviation of S_T, index points
  approxOneSigma: number;    // straddle / sqrt(2/pi) = straddle / 0.7979 (Brenner-Subrahmanyam)
}

const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI); // 0.79788

function straddleTotalVol(F: number, K: number, undiscountedStraddle: number): number | null {
  const intrinsic = Math.abs(F - K);
  if (!(undiscountedStraddle > intrinsic)) return null;
  const price = (v: number) => black76(F, K, v * v, "C") + black76(F, K, v * v, "P");
  let lo = 1e-7, hi = 2;
  if (price(hi) < undiscountedStraddle) return null;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (price(mid) < undiscountedStraddle) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * 1-sigma move to expiry from the ATM straddle of ONE expiry.
 * @param quotes   strikes with call and put mids (per share)
 * @param spot     current underlying price (used only to locate ATM)
 * @param discount e^(-rT); 1 is fine for 0DTE (r*T ~ 2e-4)
 */
export function straddleExpectedMove(
  quotes: OptionQuote[],
  spot: number,
  discount = 1,
): StraddleExpectedMove | null {
  if (!(spot > 0) || !(discount > 0)) return null;
  const both = quotes
    .filter((q) => Number.isFinite(q.strike) && q.callMid != null && q.putMid != null
      && (q.callMid as number) > 0 && (q.putMid as number) > 0)
    .map((q) => ({ K: q.strike, c: (q.callMid as number) / discount, p: (q.putMid as number) / discount }))
    .sort((a, b) => Math.abs(a.K - spot) - Math.abs(b.K - spot));
  if (both.length === 0) return null;

  // Forward from parity on the (up to 3) strikes nearest spot, median.
  const fwds = both.slice(0, 3).map((x) => x.K + x.c - x.p).sort((a, b) => a - b);
  const F = fwds[Math.floor(fwds.length / 2)];

  // Straddle total vol at the strikes bracketing F, interpolated linearly in K.
  const below = both.filter((x) => x.K <= F).sort((a, b) => b.K - a.K)[0];
  const above = both.filter((x) => x.K >= F).sort((a, b) => a.K - b.K)[0];
  const at = (x: { K: number; c: number; p: number }) => straddleTotalVol(F, x.K, x.c + x.p);
  let v: number | null = null;
  let strike = both[0].K;
  let straddle = both[0].c + both[0].p;
  if (below && above && below.K !== above.K) {
    const vb = at(below), va = at(above);
    if (vb != null && va != null) {
      const t = (F - below.K) / (above.K - below.K);
      v = vb + t * (va - vb);
      const near = t <= 0.5 ? below : above;
      strike = near.K;
      straddle = near.c + near.p;
    }
  }
  if (v == null) {
    v = at(both[0]);
    strike = both[0].K;
    straddle = both[0].c + both[0].p;
  }
  if (v == null || !(v > 0)) return null;
  return {
    method: "atm-straddle",
    strike,
    straddleMid: straddle * discount,
    forward: F,
    totalVol: v,
    oneSigmaMove: F * v,
    approxOneSigma: (straddle * discount) / SQRT_2_OVER_PI,
  };
}

// ─── (b) Scenario odds from the implied distribution ────────────────────────
//
// Partition terminal prices into three regions split halfway between the
// scenario targets: BEAR = S_T < L, BASE = L <= S_T <= U, BULL = S_T > U, with
// U = (center + bullTarget)/2, L = (center + bearTarget)/2 and center = the
// base target (or spot if the base target is not strictly between the other
// two). Odds therefore fall as a target moves further away, which the old
// fixed 45/30/25 split did not do.
//
// Touch odds use the reflection principle for driftless Brownian motion,
// P(max_{t<=T} W_t >= b) = 2 P(W_T >= b) (Shreve, Stochastic Calculus for
// Finance II, sec. 3.7): pTouch ~= min(1, 2 * P(S_T beyond target)). It is an
// approximation (it ignores the small risk-neutral drift and the smile).
//
// Every number here is RISK-NEUTRAL (options-implied), not a real-world
// forecast: it embeds the variance and skew risk premia.

export interface ScenarioOdds {
  measure: "risk-neutral";
  bull: number;              // P(S_T > upper)
  base: number;              // P(lower <= S_T <= upper)
  bear: number;              // P(S_T < lower)
  upper: number;             // region boundary (price)
  lower: number;             // region boundary (price)
  pCloseBeyondBull: number;  // P(S_T > bull target)
  pCloseBeyondBear: number;  // P(S_T < bear target)
  pTouchBull: number;        // ~ min(1, 2 * pCloseBeyondBull)
  pTouchBear: number;        // ~ min(1, 2 * pCloseBeyondBear)
}

/**
 * @param cdf  P(S_T <= K) under the implied distribution
 * @param spot current price
 * @param targets scenario target prices (same units as cdf)
 */
export function scenarioOddsFromCdf(
  cdf: (K: number) => number,
  spot: number,
  targets: { bull: number; base: number; bear: number },
): ScenarioOdds | null {
  const { bull, base, bear } = targets;
  if (![bull, base, bear, spot].every((x) => Number.isFinite(x))) return null;
  if (!(bull > bear)) return null;
  const center = base > bear && base < bull ? base
    : spot > bear && spot < bull ? spot
    : 0.5 * (bull + bear);
  const upper = 0.5 * (center + bull);
  const lower = 0.5 * (center + bear);
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const pBull = clamp01(1 - cdf(upper));
  const pBear = clamp01(cdf(lower));
  const pBase = clamp01(1 - pBull - pBear);
  const beyondBull = clamp01(1 - cdf(bull));
  const beyondBear = clamp01(cdf(bear));
  return {
    measure: "risk-neutral",
    bull: pBull,
    base: pBase,
    bear: pBear,
    upper,
    lower,
    pCloseBeyondBull: beyondBull,
    pCloseBeyondBear: beyondBear,
    pTouchBull: Math.min(1, 2 * beyondBull),
    pTouchBear: Math.min(1, 2 * beyondBear),
  };
}

/**
 * Risk-neutral odds of exactly the events calibration.ts grades for the
 * audit's scenarioProb: bull = close >= T_up, bear = close <= T_dn, base =
 * neither. With a continuous distribution P(S_T >= T_up) = 1 - CDF(T_up).
 */
export function gradedScenarioOdds(
  cdf: (K: number) => number,
  targets: { bull: number; bear: number },
): { bull: number; base: number; bear: number } | null {
  const { bull, bear } = targets;
  if (!Number.isFinite(bull) || !Number.isFinite(bear) || !(bull > bear)) return null;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const pBull = clamp01(1 - cdf(bull));
  const pBear = clamp01(cdf(bear));
  return { bull: pBull, base: clamp01(1 - pBull - pBear), bear: pBear };
}

/** Whole percentages that sum to exactly 100 (largest-remainder rounding). */
export function toPercentTriple(o: { bull: number; base: number; bear: number }): { bull: number; base: number; bear: number } {
  const keys = ["bull", "base", "bear"] as const;
  const total = o.bull + o.base + o.bear;
  const raw = keys.map((k) => (total > 0 ? (o[k] / total) * 100 : 100 / 3));
  const floors = raw.map(Math.floor);
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rest <= 0) break; floors[i] += 1; rest -= 1; }
  return { bull: floors[0], base: floors[1], bear: floors[2] };
}

// ─── ET calendar helpers for picking the horizon expiry ───

export function etNowParts(d: Date): { iso: string; dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    iso: `${get("year")}-${get("month")}-${get("day")}`,
    dow: dowMap[get("weekday")] ?? 1,
    minutes: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10),
  };
}

function isoAddDays(iso: string, days: number): string {
  const t = Date.parse(iso + "T12:00:00Z") + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function thirdFridayIso(year: number, month0: number): string {
  const first = new Date(Date.UTC(year, month0, 1, 12));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month0, 1 + offset + 14, 12)).toISOString().slice(0, 10);
}

/** Target expiry date (ET calendar) for a models.ts horizon: today, this week's
 *  Friday, this month's (or next) third Friday, third Friday three months out. */
export function horizonTargetIso(h: "daily" | "weekly" | "monthly" | "quarterly", now: Date): string {
  const et = etNowParts(now);
  if (h === "daily") return et.iso;
  if (h === "weekly") {
    const toFri = et.dow === 6 ? 6 : et.dow === 0 ? 5 : 5 - et.dow;
    return isoAddDays(et.iso, toFri);
  }
  const y = parseInt(et.iso.slice(0, 4), 10), m0 = parseInt(et.iso.slice(5, 7), 10) - 1;
  if (h === "monthly") {
    const tf = thirdFridayIso(y, m0);
    if (et.iso < tf) return tf; // on OPEX day itself buildHorizonDates rolls to next month
    return thirdFridayIso(m0 === 11 ? y + 1 : y, (m0 + 1) % 12);
  }
  const m3 = m0 + 3;
  return thirdFridayIso(y + Math.floor(m3 / 12), m3 % 12);
}

// ─── Schwab chain adapter ───────────────────────────────────────────────────

type ExpMap = Record<string, Record<string, any[]>> | null | undefined;

/** Mid of a Schwab contract (per share); null when there is no two-sided-ish quote. */
function contractMid(c: any): number | null {
  const bid = Number(c?.bid), ask = Number(c?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !(ask > 0) || bid < 0 || bid > ask) return null;
  return 0.5 * (bid + ask);
}

/** Prefer the PM-settled contract when a strike lists AM and PM (SPX vs SPXW). */
function pickContract(list: any[] | undefined): any | null {
  if (!list || list.length === 0) return null;
  const pm = list.find((c) => String(c?.settlementType ?? "").toUpperCase() === "P");
  return pm ?? list[0];
}

/** Calls and puts of one Schwab expiry key ("YYYY-MM-DD:N") as OptionQuote[]. */
export function quotesFromSchwabExpiry(callMap: ExpMap, putMap: ExpMap, expKey: string): OptionQuote[] {
  const byK = new Map<number, OptionQuote>();
  const add = (map: ExpMap, side: "C" | "P") => {
    const strikes = map?.[expKey];
    if (!strikes) return;
    for (const sk of Object.keys(strikes)) {
      const K = parseFloat(sk);
      if (!Number.isFinite(K)) continue;
      const mid = contractMid(pickContract(strikes[sk]));
      if (mid == null) continue;
      const q = byK.get(K) ?? { strike: K, callMid: null, putMid: null };
      if (side === "C") q.callMid = mid; else q.putMid = mid;
      byK.set(K, q);
    }
  };
  add(callMap, "C");
  add(putMap, "P");
  return Array.from(byK.values()).sort((a, b) => a.strike - b.strike);
}

/** Calendar DTE from a Schwab expiry key. */
export function dteOfKey(expKey: string): number {
  const n = parseFloat(expKey.split(":")[1] ?? "");
  return Number.isFinite(n) ? n : NaN;
}

/** Expiry key whose date is closest to targetIso (YYYY-MM-DD), preferring on/after. */
export function pickExpiryKey(keys: string[], targetIso: string): string | null {
  const t = Date.parse(targetIso + "T00:00:00Z");
  let best: string | null = null;
  let bestScore = Infinity;
  for (const k of keys) {
    const d = Date.parse(k.split(":")[0] + "T00:00:00Z");
    if (!Number.isFinite(d)) continue;
    const diff = d - t;
    const score = Math.abs(diff) + (diff < 0 ? 0.5 * 86_400_000 : 0); // tie -> on/after
    if (score < bestScore) { bestScore = score; best = k; }
  }
  return best;
}

/** Fit the implied distribution for one Schwab expiry (r for discounting only). */
export function impliedDistributionForExpiry(
  callMap: ExpMap, putMap: ExpMap, expKey: string, spot: number, r: number,
): ImpliedDistribution | null {
  const quotes = quotesFromSchwabExpiry(callMap, putMap, expKey);
  const dte = dteOfKey(expKey);
  // discounting only; one clock (timeToExpiry, PM settlement)
  const T = Number.isFinite(dte) ? timeToExpiry(expKey.slice(0, 10)).years : 0;
  return fitImpliedDistribution(quotes, { spot, r, T });
}
