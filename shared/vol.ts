// VIX → true ATM vol conversion.
//
// VIX is a variance-swap rate replicated from the entire OTM strip — it
// includes the expensive put wing, so it systematically OVERSTATES true
// at-the-money implied vol. Feeding raw VIX into a lognormal sigma band
// makes every "1σ" band ~15% too wide (real coverage ~82%, not 68%).
//
// 20-year average ratio VIX / true ATM IV ≈ 1.146 (2006–2026, SPX;
// cross-checked live: a 30d SPX chain showed VIX 17.09 vs 13.79% ATM = 1.24x
// in a steep-skew tape — 1.146 is the long-run mean, intentionally
// conservative). Use chain-derived ATM IV directly wherever a live chain is
// available; this constant is for VIX-only paths.
export const VIX_TO_ATM = 1.146;

/** Convert a VIX-style level (annualized %, e.g. 17.5) to true ATM vol in %. */
export function vixToAtmPct(vix: number): number {
  return vix / VIX_TO_ATM;
}

/**
 * Implied vol at an exact |delta| (e.g. 0.25 for "25-delta"), linearly
 * interpolated in delta between the two listed contracts that bracket it, the
 * way desks read constant-delta vols off a smile quoted in delta space
 * (MathFinance, "FX Smile Modelling", 2008). Returns null when no pair of
 * contracts brackets the target: no extrapolation, and no nearest-contract
 * stand-in that could sit anywhere from 10- to 40-delta.
 * Rows: delta as a magnitude or signed (abs is taken), iv as a decimal.
 */
export function ivAtAbsDelta(
  rows: ReadonlyArray<{ delta: number; iv: number }>,
  target: number,
): number | null {
  const pts = rows
    .map((r) => ({ x: Math.abs(r.delta), iv: r.iv }))
    .filter((p) => Number.isFinite(p.x) && p.x > 0 && p.x < 1 && Number.isFinite(p.iv) && p.iv > 0 && p.iv < 5)
    .sort((a, b) => a.x - b.x);
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].x === target) return pts[i].iv;
    if (i + 1 < pts.length && pts[i].x < target && pts[i + 1].x > target) {
      const t = (target - pts[i].x) / (pts[i + 1].x - pts[i].x);
      return pts[i].iv + t * (pts[i + 1].iv - pts[i].iv);
    }
  }
  return null;
}
