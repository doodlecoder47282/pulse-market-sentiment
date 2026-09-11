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
