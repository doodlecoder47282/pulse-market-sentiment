// server/breedenLitzenberger.ts
//
// Tier 3 experiment #1 (MASTER_SYNTHESIS) — Breeden-Litzenberger implied
// risk-neutral PDF from an option chain. Pure observer. Read-only.
//
// Method (MathWorks reference):
//   For European calls C(K) at strike K:
//     ∂²C / ∂K² = e^(rT) · f(K)
//   where f(K) is the risk-neutral density of S_T.
//
// We approximate the second derivative with central finite differences
// across adjacent strikes. The chain is assumed to share a single expiry.
//
// Output: an array of {strike, density} pairs plus integrated probabilities
// for "close above spot+1%", "above spot", and "below spot-1%". These are
// the numbers we'll Brier-score against actual outcomes — the source of
// the "earn its slot" gating.

export type CallStrike = {
  strike: number;
  callMid: number; // (bid + ask) / 2 OR last
};

export type BLDensityPoint = {
  strike: number;
  density: number; // raw RND, may be negative on noisy chains — we clip later
};

export type BLProbabilities = {
  pUpOnePct: number;   // P(S_T > spot * 1.01)
  pUp: number;         // P(S_T > spot)
  pDownOnePct: number; // P(S_T < spot * 0.99)
  pInOneEM: number;    // P(spot - EM ≤ S_T ≤ spot + EM)
};

/**
 * Compute risk-neutral density via central finite differences. Returns the
 * density curve (clipped to non-negative) and the integrated probabilities
 * the dashboard will display.
 *
 * @param chain  Sorted-by-strike call chain at a single expiry
 * @param spot   Current underlying price
 * @param r      Risk-free rate (decimal, e.g. 0.045)
 * @param T      Time to expiry in years
 * @param oneDayEM  One-day expected move in price units (for the band integral)
 */
export function computeRND(
  chain: CallStrike[],
  spot: number,
  r: number,
  T: number,
  oneDayEM: number,
): { curve: BLDensityPoint[]; probs: BLProbabilities | null } {
  if (!chain || chain.length < 5) return { curve: [], probs: null };

  // Sort defensively, drop any non-finite mids
  const c = chain
    .filter((p) => isFinite(p.strike) && isFinite(p.callMid) && p.callMid >= 0)
    .sort((a, b) => a.strike - b.strike);
  if (c.length < 5) return { curve: [], probs: null };

  const erT = Math.exp(r * T);
  const curve: BLDensityPoint[] = [];

  for (let i = 1; i < c.length - 1; i++) {
    const km1 = c[i - 1].strike;
    const k0 = c[i].strike;
    const kp1 = c[i + 1].strike;
    const cm1 = c[i - 1].callMid;
    const c0 = c[i].callMid;
    const cp1 = c[i + 1].callMid;

    // Non-uniform-grid central second derivative:
    //   d²C/dK² ≈ 2·(c_{i-1}·(k+ - k0) - c_i·(k+ - k-) + c_{i+1}·(k0 - k-)) /
    //             ((k0 - k-)·(k+ - k0)·(k+ - k-))
    const km = k0 - km1;
    const kp = kp1 - k0;
    const denom = km * kp * (km + kp);
    if (denom === 0) continue;
    const num = 2 * (cm1 * kp - c0 * (km + kp) + cp1 * km);
    const d2 = num / denom;
    let density = erT * d2;
    if (!isFinite(density)) continue;
    if (density < 0) density = 0; // arbitrage-free clip — noisy mids cause negatives
    curve.push({ strike: k0, density });
  }

  if (curve.length === 0) return { curve, probs: null };

  // Trapezoidal normalize to integrate to 1
  let area = 0;
  for (let i = 1; i < curve.length; i++) {
    const dx = curve[i].strike - curve[i - 1].strike;
    area += 0.5 * (curve[i].density + curve[i - 1].density) * dx;
  }
  if (area > 0) {
    for (const p of curve) p.density = p.density / area;
  }

  // Integrate over regions for the dashboard probabilities
  const integrate = (lo: number, hi: number): number => {
    let s = 0;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1].strike;
      const b = curve[i].strike;
      if (b < lo || a > hi) continue;
      const x0 = Math.max(a, lo);
      const x1 = Math.min(b, hi);
      // Linear interpolation of density at x0/x1
      const t0 = (x0 - a) / (b - a || 1);
      const t1 = (x1 - a) / (b - a || 1);
      const f0 = curve[i - 1].density + t0 * (curve[i].density - curve[i - 1].density);
      const f1 = curve[i - 1].density + t1 * (curve[i].density - curve[i - 1].density);
      s += 0.5 * (f0 + f1) * (x1 - x0);
    }
    return Math.max(0, Math.min(1, s));
  };

  const lastK = curve[curve.length - 1].strike;
  const firstK = curve[0].strike;
  const probs: BLProbabilities = {
    pUpOnePct: integrate(spot * 1.01, lastK),
    pUp: integrate(spot, lastK),
    pDownOnePct: integrate(firstK, spot * 0.99),
    pInOneEM: integrate(spot - oneDayEM, spot + oneDayEM),
  };

  return { curve, probs };
}
