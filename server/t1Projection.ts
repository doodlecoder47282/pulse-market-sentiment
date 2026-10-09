// server/t1Projection.ts
//
// Projected option return if the underlying reaches a target (T1/T2) during
// the session (review items 6.7 / R2-C 7). Pure: imports only pricing and
// clock helpers.
//
// The old projection (contractPicker / odteAlertEngine Gate 3) used
//   pnl = |delta_now| x move + 0.5 gamma_now x move^2 + theta to the CLOSE
// i.e. Greeks at today's time to expiry but the WHOLE remaining decay, and the
// extrinsic charged at spot, not at the target. If T1 is reached at all it is
// reached before the close, so the trade loses only the decay up to the touch,
// and the option is then worth its value at the target price. It also ignored
// the half spread paid on exit and the fees.
//
// This module reprices directly:
//
//   1. Time to T1. Under the diffusion the option is priced with (log price
//      with the risk-neutral drift -sigma^2/2; zero-drift closed forms below), the first
//      time tau that |ln S| moves a distance d = |ln(H/S0)| has
//        P(tau <= t) = 2 [1 - Phi(a / sqrt t)],  a = d / sigma
//      (reflection principle; R. Lockhart, "Brownian Motion", SFU STAT 870
//      lecture notes, https://sfu.ca/~lockhart/richard/870/11_2/lectures/BrownianMotion/web.pdf;
//      S. Shreve, "Stochastic Calculus for Finance II", 2004, sec. 3.6-3.7).
//      Its unconditional mean is infinite, so the expectation used is the
//      mean CONDITIONAL on a touch before the close, which is exactly the
//      scenario "if T1 is hit":
//        E[tau ; tau <= T] = a sqrt(2T/pi) exp(-a^2/2T) - a^2 erfc(a / sqrt(2T))
//        E[tau | tau <= T] = E[tau ; tau <= T] / P(tau <= T)
//      (integral of t f(t) with f the first-passage density; derivation in
//      the test file). The path vol is the ATM implied vol (N-2), i.e. the
//      market's speed, not a forecast of realized speed: implied usually
//      exceeds realized, so the touch time and the decay charged are, if
//      anything, understated.
//   2. Value at the touch: Black-Scholes at S = H with T - tau left
//      (intrinsic once nothing is left), averaged over the touch-time density
//      (N-1 below), same strike vol (sticky strike), anchored to the market:
//      projected mid = mid_now + E[BS(H, T - tau) | touch] - BS(S0, T).
//      Within 3 days sigma is solved from the mid, so BS(S0, T) = mid_now.
//   3. Fill: buy at the ask now; sell at projected mid - half the current
//      spread (spread in $ assumed unchanged); fee per contract per side.
//        return = (bid_exit x m - fee - (ask x m + fee)) / (ask x m + fee)
//      This "return IF T1 is reached" is what Gate 3 tests (>= 30%).
//
// Returns null (unavailable) without a two-sided quote, a usable sigma, or
// when the contract has settled: callers must not treat that as a pass.

//   4. Expected value (SF-6). With pHit the touch probability:
//        EV = pHit x R(touch) + (1 - pHit) x R(no touch)
//      R(no touch) values the position at the close on the paths that never
//      touched: the reflection-principle density of the log price given no
//      touch, phi(x) - phi(x - 2a) for x < a (call target above spot; mirrored
//      for a put), applied to intrinsic (0DTE cash settlement: no closing
//      spread or fee when it settles) or to Black-Scholes when the contract
//      outlives the session. Under the pricing measure itself (zero drift, the
//      same vol for path and price) the option value is a martingale, so EV
//      collapses to minus the round-trip spread and fees (risk-neutral
//      valuation, Hull, "Options, Futures, and Other Derivatives", ch. 13;
//      optional stopping: Shreve II, sec. 8.2): the model EV measures COST,
//      not edge. Gate 3 therefore keeps testing the return IF T1 is reached
//      (the payoff the alert advertises); an EV gate needs a real-world touch
//      probability (the graded hit_t1 ledger), not the model pHit.
//
// N-1: the value at the touch is AVERAGED over the touch-time density
// f(t) = a / sqrt(2 pi t^3) exp(-a^2/2t) on (0, close] (not a plug-in at the
// mean time). N-2: the underlying's path uses the ATM implied vol when the
// caller passes it (the market's vol for the index), while the contract is
// repriced with its own strike's vol held fixed (sticky strike: E. Derman,
// "Regimes of Volatility", Risk, April 1999,
// https://hpirotte.ulb.be/INGESTriskmgt/readings/Derman%20(1999)%20-%20Volatility%20regimes.pdf).
//
// Fees (SF-2): feeConfig.feeForProduct. An index root without a configured
// all-in fee gets returns BEFORE fees (feeIncluded false) and no dollar P&L.

import { bsPrice, delta as bsDelta } from "./greeks";
import { cdf } from "./stats";
import { ivForClock } from "./chainClock";
import { settlementStyleOf, timeToExpiry } from "./timeToExpiry";
import { feeForProduct } from "./feeConfig";

const MINUTES_PER_YEAR = 525_600;

/** @deprecated kept for callers; use feeForProduct. Returns the configured index fee or null. */
export function odteProjectionFee(): number | null {
  return feeForProduct("SPXW").fee;
}

export interface FirstPassage {
  /** P(touch within the horizon). A model quantity under implied vol, not a calibrated probability. */
  pHit: number;
  /** E[tau | tau <= horizon], years. 0 when already at/through the level. */
  condMeanYears: number;
}

/** First passage of driftless Brownian motion with vol sigma (per sqrt year) over log-distance d within T years. */
export function firstPassage(d: number, sigma: number, T: number): FirstPassage | null {
  if (!(sigma > 0) || !(T > 0) || !Number.isFinite(d)) return null;
  if (d <= 0) return { pHit: 1, condMeanYears: 0 };
  const a = d / sigma;
  const z = a / Math.sqrt(T);
  const tail = 1 - cdf(z);                 // 1 - Phi(a / sqrt T)
  const pHit = 2 * tail;                   // = erfc(a / sqrt(2T))
  if (!(pHit > 1e-12)) return { pHit: 0, condMeanYears: T };
  const partial = a * Math.sqrt((2 * T) / Math.PI) * Math.exp(-(a * a) / (2 * T)) - a * a * pHit;
  const cond = Math.min(T, Math.max(0, partial / pHit));
  return { pHit, condMeanYears: cond };
}

/** Composite Simpson rule on [lo, hi] with n (even) panels. */
function simpson(f: (x: number) => number, lo: number, hi: number, n = 2000): number {
  if (!(hi > lo)) return 0;
  const h = (hi - lo) / n;
  let s = f(lo) + f(hi);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(lo + i * h);
  return (s * h) / 3;
}

// Drifted forms (x = ln S, drift nu per year; the pricing measure with zero
// rates has nu = -sigma^2/2, which keeps S a martingale). For a barrier d > 0
// above the start (S. Shreve, "Stochastic Calculus for Finance II", 2004,
// sec. 7.2, maximum of Brownian motion with drift):
//   first-passage density  f(t) = d / (sigma sqrt(2 pi t^3)) exp(-(d - nu t)^2 / (2 sigma^2 t))
//   P(tau <= T)            = Phi((nu T - d)/(sigma sqrt T)) + e^(2 nu d / sigma^2) Phi((-d - nu T)/(sigma sqrt T))
//   no-touch density, x<d  = phi(x - nu T) - e^(2 nu d / sigma^2) phi(x - 2d - nu T),  phi ~ N(0, sigma^2 T)
// A barrier BELOW the start is the same problem for -x with drift -nu.

/** P(touch within T) of a BM with drift nu, vol sigma, barrier at log-distance d > 0 above the start. */
export function touchProbability(d: number, sigma: number, T: number, nu = 0): number {
  if (d <= 0) return 1;
  const sT = sigma * Math.sqrt(T);
  return Math.min(1, Math.max(0, cdf((nu * T - d) / sT) + Math.exp((2 * nu * d) / (sigma * sigma)) * cdf((-d - nu * T) / sT)));
}

/**
 * E[g(tau); tau <= T] for the first passage over log-distance d (barrier above,
 * drift nu): integral of g(t) f(t) dt, with t = T u^2 so the density's sharp
 * rise near 0 is resolved.
 */
export function touchTimeExpectation(g: (t: number) => number, d: number, sigma: number, T: number, n = 2000, nu = 0): number {
  const f = (t: number) => (t <= 0 ? 0 : (d / (sigma * Math.sqrt(2 * Math.PI * t * t * t))) * Math.exp(-((d - nu * t) ** 2) / (2 * sigma * sigma * t)));
  return simpson((u) => { const t = T * u * u; return t <= 0 ? 0 : g(t) * f(t) * 2 * T * u; }, 0, 1, n);
}

/**
 * E[h(x); no touch] for x = ln(S_T / S_0) (drift nu, vol sigma, horizon T) on
 * paths that never reached +d (up = true) or -d (up = false).
 */
export function noTouchExpectation(h: (x: number) => number, d: number, sigma: number, T: number, up: boolean, n = 2000, nu = 0): number {
  const s = sigma * Math.sqrt(T);
  const v = up ? nu : -nu;                       // drift of the process whose barrier is above
  const k = Math.exp((2 * v * d) / (sigma * sigma));
  const phi = (x: number) => Math.exp(-(x * x) / (2 * s * s)) / (s * Math.sqrt(2 * Math.PI));
  const g = (y: number) => phi(y - v * T) - k * phi(y - 2 * d - v * T);
  // y = x for an upper barrier, y = -x for a lower one.
  return simpson((y) => h(up ? y : -y) * g(y), -10 * s + v * T, d, n);
}

export interface TargetProjection {
  method: "bs_reprice_at_target_first_passage_v2";
  target: number;
  sigma: number;                // contract's own vol (repricing, sticky strike)
  pathSigma: number;            // vol of the underlying's path (ATM when given)
  pHit: number;                 // model touch probability before the close (implied vol; not calibrated)
  minutesToTarget: number;      // E[tau | touch before close], minutes (display)
  entryAsk: number;             // $ per share
  projectedMid: number;         // E[mid at the touch], averaged over the touch-time density
  projectedExitBid: number;     // projected mid - half spread, floored at 0
  // Per-share decomposition of projectedMid - mid_now:
  projDeltaPnl: number;         // BS delta now x signed move
  projGammaBoost: number;       // rest of the move repricing at constant T
  projThetaCost: number;        // expected decay until the touch, at the target (<= 0)
  spreadCost: number;           // full spread paid (half in, half out), $ per share (>= 0)
  feePerContract: number | null;
  feeIncluded: boolean;         // false: index root without a configured fee; returns are before fees
  feeBasis: string;
  feesPerContract: number | null; // round trip, $ (null when no fee is configured)
  projPnlPerContract: number | null; // $ per contract if T1 is reached, after spread (and fees when included)
  projReturnPct: number;        // return IF T1 is reached: the number Gate 3 tests
  noTouchReturnPct: number;     // return at the close on the paths that never touch
  evReturnPct: number;          // pHit x projReturnPct + (1 - pHit) x noTouchReturnPct (model; = -costs under its own measure)
  gateTests: "return_if_t1_reached";
}

export function projectToTarget(args: {
  spot: number;
  strike: number;
  type: "C" | "P";
  target: number;
  expiry: string;               // YYYY-MM-DD
  symbol?: string | null;       // for AM/PM settlement and the fee rule
  bid: number | null | undefined;
  ask: number | null | undefined;
  vendorIv: number;             // decimal, used only when the mid cannot be solved
  minutesToClose: number;
  nowMs: number;
  /** $ per contract per side; null = unavailable (returns before fees); undefined = feeForProduct(symbol). */
  feePerContract?: number | null;
  /** ATM implied vol for the underlying's path (decimal); default: the contract's own vol. */
  pathSigma?: number | null;
  multiplier?: number;
}): TargetProjection | null {
  const { spot: S, strike: K, type, target: H } = args;
  const bid = args.bid, ask = args.ask;
  if (!(S > 0) || !(K > 0) || !(H > 0)) return null;
  if (bid == null || ask == null || !(bid >= 0) || !(ask > 0) || ask < bid) return null;
  const tte = timeToExpiry(args.expiry, { nowMs: args.nowMs, style: settlementStyleOf(args.symbol ?? null) });
  if (tte.expired || !(tte.years > 0)) return null;
  const T = tte.years;
  const sigma = ivForClock({ vendorIv: args.vendorIv, bid, ask, spot: S, strike: K, T, type });
  if (!(sigma > 0)) return null;
  const pathSigma = args.pathSigma != null && args.pathSigma > 0 ? args.pathSigma : sigma;
  const m = args.multiplier ?? 100;
  const feeRes = args.feePerContract === undefined
    ? feeForProduct(args.symbol ?? "SPXW")
    : { fee: args.feePerContract, basis: args.feePerContract == null ? "fee unavailable: returns before fees" : "fee given by caller" };
  const feeIncluded = feeRes.fee != null;
  const fee = feeIncluded ? Math.max(0, feeRes.fee as number) : 0;
  const mid = (bid + ask) / 2;
  const half = (ask - bid) / 2;
  const intrinsic = (x: number) => (type === "C" ? Math.max(0, x - K) : Math.max(0, K - x));
  const price = (x: number, tLeft: number) => (tLeft > 1e-12 ? bsPrice(x, K, sigma, tLeft, 0, 0, type) : intrinsic(x));
  const modelNow = bsPrice(S, K, sigma, T, 0, 0, type);
  const anchor = mid - modelNow; // 0 when sigma is solved from the mid (T <= 3 days)

  // Favourable direction only: a call target above spot, a put target below.
  const favourable = type === "C" ? H >= S : H <= S;
  const d = favourable ? Math.abs(Math.log(H / S)) : 0;
  const horizon = Math.min(T, Math.max(1, args.minutesToClose) / MINUTES_PER_YEAR);
  // Risk-neutral log drift with zero rates: -sigma^2/2 (S is then a
  // martingale). For a call target above spot the barrier is above (drift nu);
  // for a put target below, the mirrored process has drift -nu.
  const nu = -0.5 * pathSigma * pathSigma;
  const nuUp = type === "C" ? nu : -nu;
  const pTouch = favourable ? (d > 0 ? touchProbability(d, pathSigma, horizon, nuUp) : 1) : 1;
  const condMean = d > 0 && pTouch > 1e-12 ? touchTimeExpectation((t) => t, d, pathSigma, horizon, 2000, nuUp) / pTouch : 0;
  const fp = { pHit: pTouch, condMeanYears: Math.min(horizon, Math.max(0, condMean)) };

  // Value at the touch, averaged over the touch-time density (N-1).
  let atTarget: number;
  if (d <= 0) atTarget = price(H, T);
  else if (fp.pHit > 1e-9) atTarget = touchTimeExpectation((t) => price(H, T - t), d, pathSigma, horizon, 2000, nuUp) / fp.pHit;
  else atTarget = price(H, Math.max(0, T - horizon));
  const atTargetNoDecay = price(H, T);
  const projectedMid = Math.max(0, mid + atTarget - modelNow);
  const projectedExitBid = Math.max(0, projectedMid - half);

  // Value at the close on the no-touch paths.
  const tAfter = Math.max(0, T - horizon);
  const settlesAtClose = tAfter <= 1e-12;
  let noTouchValue = 0;
  if (fp.pHit < 1 - 1e-9 && d > 0) {
    const h = (x: number) => (settlesAtClose ? intrinsic(S * Math.exp(x)) : Math.max(0, price(S * Math.exp(x), tAfter) + anchor - half));
    noTouchValue = noTouchExpectation(h, d, pathSigma, horizon, type === "C", 2000, nu) / (1 - fp.pHit);
  }

  const cost = ask * m + fee;
  const touchProceeds = projectedExitBid * m - fee;
  // Cash settlement or a worthless option: no closing trade, no closing fee.
  const noTouchProceeds = noTouchValue * m - (settlesAtClose || noTouchValue <= 0 ? 0 : fee);
  const pnl = touchProceeds - cost;
  const projReturnPct = cost > 0 ? pnl / cost : 0;
  const noTouchReturnPct = cost > 0 ? (noTouchProceeds - cost) / cost : 0;
  const dNow = bsDelta(S, K, sigma, T, 0, 0, type);
  const moveRepricing = atTargetNoDecay - modelNow;
  return {
    method: "bs_reprice_at_target_first_passage_v2",
    target: H,
    sigma,
    pathSigma,
    pHit: fp.pHit,
    minutesToTarget: fp.condMeanYears * MINUTES_PER_YEAR,
    entryAsk: ask,
    projectedMid,
    projectedExitBid,
    projDeltaPnl: dNow * (H - S),
    projGammaBoost: moveRepricing - dNow * (H - S),
    projThetaCost: Math.min(0, atTarget - atTargetNoDecay),
    spreadCost: 2 * half,
    feePerContract: feeIncluded ? fee : null,
    feeIncluded,
    feeBasis: feeRes.basis,
    feesPerContract: feeIncluded ? 2 * fee : null,
    projPnlPerContract: feeIncluded ? Math.round(pnl * 100) / 100 : null,
    projReturnPct,
    noTouchReturnPct,
    evReturnPct: fp.pHit * projReturnPct + (1 - fp.pHit) * noTouchReturnPct,
    gateTests: "return_if_t1_reached",
  };
}

/**
 * ATM implied vol for the underlying's path (N-2): the strike nearest spot in
 * a Schwab expDateMap slice ({ strike: [contract] }), solved from its mid on
 * the app clock (chainClock.ivForClock). Null without a two-sided ATM quote.
 */
export function atmPathSigma(
  strikes: Record<string, any[]> | null | undefined,
  spot: number,
  type: "C" | "P",
  expiry: string,
  nowMs: number,
): number | null {
  if (!strikes || !(spot > 0)) return null;
  let best: { k: number; c: any } | null = null;
  for (const [ks, arr] of Object.entries(strikes)) {
    const k = parseFloat(ks);
    const c = Array.isArray(arr) ? arr[0] : null;
    if (!Number.isFinite(k) || !c || !(typeof c.bid === "number" && typeof c.ask === "number" && c.bid > 0 && c.ask >= c.bid)) continue;
    if (!best || Math.abs(k - spot) < Math.abs(best.k - spot)) best = { k, c };
  }
  if (!best) return null;
  const tte = timeToExpiry(expiry, { nowMs, style: settlementStyleOf(best.c.symbol ?? null) });
  if (tte.expired || !(tte.years > 0)) return null;
  const vendor = typeof best.c.volatility === "number" ? best.c.volatility / 100 : 0;
  const s = ivForClock({ vendorIv: vendor, bid: best.c.bid, ask: best.c.ask, spot, strike: best.k, T: tte.years, type });
  return s > 0 ? s : null;
}
