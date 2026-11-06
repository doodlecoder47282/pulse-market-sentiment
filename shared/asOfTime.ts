// shared/asOfTime.ts
//
// An "asOf" stamp as epoch milliseconds, whatever form a payload used:
// epoch seconds, epoch milliseconds, or an ISO string. null when it cannot be
// read, so a card hides "updated ..." instead of printing "Invalid Date".

export function asOfToMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
