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
//   1. Time to T1. Under the diffusion the option is priced with (log price,
//      zero drift; the -sigma^2/2 drift is negligible over hours), the first
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
//      the test file). sigma is the contract's implied vol solved from its mid
//      on the app clock (chainClock.ivForClock), i.e. the market's speed, not
//      a forecast of realized speed: implied usually exceeds realized, so the
//      touch time and the decay charged are, if anything, understated.
//   2. Value at the touch: Black-Scholes at S = H with T - E[tau] left
//      (intrinsic once nothing is left), same sigma (sticky strike), anchored
//      to the market: projected mid = mid_now + BS(H, T - tau) - BS(S0, T).
//      Within 3 days sigma is solved from the mid, so BS(S0, T) = mid_now.
//   3. Fill: buy at the ask now; sell at projected mid - half the current
//      spread (spread in $ assumed unchanged); fee per contract per side.
//        return = (bid_exit x m - fee - (ask x m + fee)) / (ask x m + fee)
//
// Returns null (unavailable) without a two-sided quote, a usable sigma, or
// when the contract has settled: callers must not treat that as a pass.

import { bsPrice, delta as bsDelta } from "./greeks";
import { cdf } from "./stats";
import { ivForClock } from "./chainClock";
import { settlementStyleOf, timeToExpiry } from "./timeToExpiry";

const MINUTES_PER_YEAR = 525_600;

/** Fee assumed for SPX/SPXW 0DTE projections, $ per contract per side: Schwab's
 *  $0.65 commission (https://www.schwab.com/public/file/P-3346815). Cboe index
 *  option fees are extra and not included unless ODTE_FEE_PER_CONTRACT is set. */
export const ODTE_PROJECTION_FEE_DEFAULT = 0.65;
export function odteProjectionFee(): number {
  const v = Number(process.env.ODTE_FEE_PER_CONTRACT);
  return Number.isFinite(v) && v >= 0 ? v : ODTE_PROJECTION_FEE_DEFAULT;
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

export interface TargetProjection {
  method: "bs_reprice_at_target_first_passage";
  target: number;
  sigma: number;
  pHit: number;                 // model touch probability under implied vol (not calibrated)
  minutesToTarget: number;      // E[tau | touch before close], minutes
  yearsLeftAtTarget: number;
  entryAsk: number;             // $ per share
  projectedMid: number;         // $ per share at the touch
  projectedExitBid: number;     // projected mid - half spread, floored at 0
  // Per-share decomposition of projectedMid - mid_now:
  projDeltaPnl: number;         // BS delta now x signed move
  projGammaBoost: number;       // rest of the move repricing at constant T: BS(H,T) - BS(S,T) - delta move
  projThetaCost: number;        // decay until the touch at the target: BS(H, T - tau) - BS(H, T) (<= 0)
  spreadCost: number;           // full spread paid (half in, half out), $ per share (>= 0)
  feesPerContract: number;      // round trip, $
  projPnlPerContract: number;   // $ per contract after spread and fees
  projReturnPct: number;        // fraction of cash paid (ask x m + fee)
}

export function projectToTarget(args: {
  spot: number;
  strike: number;
  type: "C" | "P";
  target: number;
  expiry: string;               // YYYY-MM-DD
  symbol?: string | null;       // for AM/PM settlement
  bid: number | null | undefined;
  ask: number | null | undefined;
  vendorIv: number;             // decimal, used only when the mid cannot be solved
  minutesToClose: number;
  nowMs: number;
  feePerContract?: number;
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
  const m = args.multiplier ?? 100;
  const fee = Math.max(0, args.feePerContract ?? ODTE_PROJECTION_FEE_DEFAULT);
  const mid = (bid + ask) / 2;
  const half = (ask - bid) / 2;

  // Favourable direction only: a call target above spot, a put target below.
  const favourable = type === "C" ? H >= S : H <= S;
  const d = favourable ? Math.abs(Math.log(H / S)) : 0;
  const horizon = Math.min(T, Math.max(1, args.minutesToClose) / MINUTES_PER_YEAR);
  const fp = favourable ? firstPassage(d, sigma, horizon) : { pHit: 1, condMeanYears: 0 };
  if (!fp) return null;
  const tau = fp.condMeanYears;
  const tLeft = Math.max(0, T - tau);
  const intrinsicAtH = type === "C" ? Math.max(0, H - K) : Math.max(0, K - H);
  const atTarget = tLeft > 1e-12 ? bsPrice(H, K, sigma, tLeft, 0, 0, type) : intrinsicAtH;
  const modelNow = bsPrice(S, K, sigma, T, 0, 0, type);
  const atTargetNoDecay = bsPrice(H, K, sigma, T, 0, 0, type);
  const projectedMid = Math.max(0, mid + atTarget - modelNow);
  const projectedExitBid = Math.max(0, projectedMid - half);

  const cost = ask * m + fee;
  const proceeds = projectedExitBid * m - fee;
  const pnl = proceeds - cost;
  const dNow = bsDelta(S, K, sigma, T, 0, 0, type);
  const moveRepricing = atTargetNoDecay - modelNow;
  return {
    method: "bs_reprice_at_target_first_passage",
    target: H,
    sigma,
    pHit: fp.pHit,
    minutesToTarget: tau * MINUTES_PER_YEAR,
    yearsLeftAtTarget: tLeft,
    entryAsk: ask,
    projectedMid,
    projectedExitBid,
    projDeltaPnl: dNow * (H - S),
    projGammaBoost: moveRepricing - dNow * (H - S),
    projThetaCost: Math.min(0, atTarget - atTargetNoDecay),
    spreadCost: 2 * half,
    feesPerContract: 2 * fee,
    projPnlPerContract: Math.round(pnl * 100) / 100,
    projReturnPct: cost > 0 ? pnl / cost : 0,
  };
}
