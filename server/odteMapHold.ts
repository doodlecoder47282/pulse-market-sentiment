// Hold the option map still while the market is shut and the option data has not changed.
//
// Seen live 2026-11-24 to 25 on one option read (4:54 PM ET): the top card showed ceiling 7,300 / turning
// point 7,224 at 6:09 PM, 7,310 / 7,238 at 9:19 PM and 7,250 / 7,208 at 3:16 AM, and went from "bigger-swing
// side" to "calmer side". Nothing new had arrived: the model is re-priced with the time left to expiry on
// every request, so its levels slide with the clock. For someone planning the next session that reads as
// the levels changing their mind overnight.
//
// Rule: outside the regular session, a map is kept and served again for as long as the data behind it is the
// same (same expiry, same price, same priced move, same open interest). New data, or the session opening,
// replaces it. During the session nothing is held: the data changes every minute and so should the map.
// The held copy lives in this process; after a restart the first map computed is the one held.
// Only the model-derived levels are held (HELD_FIELDS); session numbers and labels are always current.

export interface HoldableForward {
  expiry?: string | null;
  spot?: number | null;
  session?: { state?: string | null } | null;
  expectedMove?: { straddle?: number | null } | null;
  strikes?: Array<{ strike: number; callOI?: number | null; putOI?: number | null }> | null;
}

/** What "the same data" means: expiry, price, the at-the-money straddle and the open interest by strike. */
export function dataFingerprint(f: HoldableForward): string {
  let oi = 0, n = 0;
  for (const s of f.strikes ?? []) { oi += (s.callOI ?? 0) * 3 + (s.putOI ?? 0) * 7 + s.strike; n++; }
  return [f.expiry ?? "", f.spot ?? "", f.expectedMove?.straddle ?? "", n, Math.round(oi)].join("|");
}

/**
 * The parts of a map that come from the dealer-hedging model and slide with the clock: the ceiling, floor,
 * turning point and pin (`landmarks`), which side the price is on (`band`), the per-strike exposures
 * (`strikes`) and the zones built from them. Only these are held. Everything else (session, data state,
 * times, gap, the priced range, the ladders with their prior close and session high and low) always comes
 * from the map just computed, so a held response never mixes one day's session numbers with another's.
 * The ladders' model rungs can therefore still move overnight; the card's levels do not.
 */
export const HELD_FIELDS = ["landmarks", "band", "strikes", "zones", "zonesNote"] as const;
/** Slots kept at most; the oldest goes first. A slot is a symbol and a view, and the symbol comes from the request. */
export const MAX_SLOTS = 24;

interface Held { fingerprint: string; parts: Record<string, unknown>; sinceMs: number }
const held = new Map<string, Held>();

/** A map whose levels were priced: only such a map is kept, and a held one is only laid over such a map. */
function priced(body: unknown): boolean {
  const ds = (body as { dataState?: string } | null)?.dataState;
  return ds === "ok" || ds === "stale_session";
}

/**
 * `slot` names the view (symbol and expiry pick). `fresh` is the map just computed from `forward`. Returns
 * the body to serve and, when its levels are held ones, since when.
 * Not part of "the same data": volume and quotes away from the money. If only those move overnight, the
 * levels stay as they were at the last change of price, priced move or open interest.
 */
export function holdWhileUnchanged<T>(slot: string, forward: HoldableForward, fresh: T, nowMs: number): { body: T; heldSinceMs: number | null } {
  if (forward.session?.state === "intraday") { held.delete(slot); return { body: fresh, heldSinceMs: null }; }
  // An unpriced or stale map is never kept, and held levels are never shown under one.
  if (!priced(fresh)) return { body: fresh, heldSinceMs: null };
  const fp = dataFingerprint(forward);
  const prev = held.get(slot);
  if (prev && prev.fingerprint === fp) {
    return { body: { ...(fresh as object), ...prev.parts } as T, heldSinceMs: prev.sinceMs };
  }
  const parts: Record<string, unknown> = {};
  for (const k of HELD_FIELDS) if (k in (fresh as object)) parts[k] = (fresh as Record<string, unknown>)[k];
  held.delete(slot);
  held.set(slot, { fingerprint: fp, parts, sinceMs: nowMs });
  while (held.size > MAX_SLOTS) held.delete(held.keys().next().value as string);
  return { body: fresh, heldSinceMs: null };
}

/** Test hook. */
export function _clearHeldMaps(): void { held.clear(); }
