// Pure: how far out the whale follow-through tracker must pull chains.
/** Calendar days to the latest expiry in a tracked group, plus one day of slack; 365 when unknown. */
export function followMaxDte(expirations: string[], nowMs: number): number {
  let best = -1;
  for (const e of expirations) {
    const t = Date.parse(`${String(e).slice(0, 10)}T12:00:00Z`);
    if (!Number.isFinite(t)) return 365;
    best = Math.max(best, Math.ceil((t - nowMs) / 86_400_000));
  }
  if (best < 0) return 1;
  return Math.min(365, best + 1);
}
