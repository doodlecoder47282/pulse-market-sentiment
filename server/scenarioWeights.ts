/** Arithmetic normalization only; these weights are not calibrated probabilities. */
export function normalizeScenarioWeights(bull: number, bear: number, base?: number) {
  const finite = (x: number) => Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 0;
  const b = finite(bull), r = finite(bear);
  const n = base == null ? Math.max(0, 100 - b - r) : finite(base);
  const total = b + r + n;
  if (total === 0) return { bull: 0, base: 100, bear: 0 };
  const bullPct = Math.round(100 * b / total);
  const bearPct = Math.min(100 - bullPct, Math.round(100 * r / total));
  return { bull: bullPct, base: 100 - bullPct - bearPct, bear: bearPct };
}
