// shared/labelStack.ts
//
// One-dimensional label spreading: level labels on a price chart sit at
// their level's y, so two levels a few points apart print on top of each
// other. spreadLabels keeps the labels' order, keeps each at least `gap`
// from its neighbours and inside [lo, hi], and moves them as little as
// possible (a forward pass pushes down, a backward pass pulls back up from
// the bottom bound). Pure; the caller draws a connector from the label's
// slot back to the level when they differ.

export function spreadLabels(ys: number[], gap: number, lo: number, hi: number): number[] {
  const n = ys.length;
  if (n === 0) return [];
  const order = ys.map((y, i) => i).sort((a, b) => ys[a] - ys[b]);
  const out = new Array<number>(n);
  const room = hi - lo;
  // Not enough room for every slot: spread evenly across the range instead.
  const g = n > 1 && (n - 1) * gap > room ? room / (n - 1) : gap;
  let prev = -Infinity;
  for (const i of order) {
    const y = Math.max(ys[i], prev + g, lo);
    out[i] = y;
    prev = y;
  }
  // Pull back up from the bottom bound, keeping the gaps.
  let next = Infinity;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const y = Math.min(out[i], next - g, hi);
    out[i] = y;
    next = y;
  }
  // Each touching run of labels was only pushed down: recentre it on its
  // levels (zero mean displacement) as far as the bounds and neighbours allow.
  const eps = 1e-6;
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && out[order[end + 1]] - out[order[end]] <= g + eps) end++;
    let shift = 0;
    for (let k = start; k <= end; k++) shift += ys[order[k]] - out[order[k]];
    shift /= end - start + 1;
    const minShift = Math.max(lo - out[order[start]], start > 0 ? out[order[start - 1]] + g - out[order[start]] : -Infinity);
    const maxShift = Math.min(hi - out[order[end]], end + 1 < n ? out[order[end + 1]] - g - out[order[end]] : Infinity);
    shift = Math.max(minShift, Math.min(maxShift, shift));
    if (Math.abs(shift) > eps) for (let k = start; k <= end; k++) out[order[k]] += shift;
    start = end + 1;
  }
  return out;
}
