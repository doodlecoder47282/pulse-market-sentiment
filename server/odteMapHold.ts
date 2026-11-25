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

/** Fields always taken from the map just computed, never from the held one. */
export const LIVE_FIELDS = ["asOf", "dateEt", "session", "dataState", "chainAsOfMs", "chainStale", "chainLastSession", "reason", "wiener", "gap"] as const;

interface Held<T> { fingerprint: string; body: T; sinceMs: number }
const held = new Map<string, Held<unknown>>();

/**
 * `slot` names the view (symbol and expiry pick). Returns the body to serve and, when it is a held one, since
 * when. `fresh` is the map just computed from `forward`.
 */
export function holdWhileUnchanged<T>(slot: string, forward: HoldableForward, fresh: T, nowMs: number): { body: T; heldSinceMs: number | null } {
  if (forward.session?.state === "intraday") { held.delete(slot); return { body: fresh, heldSinceMs: null }; }
  const fp = dataFingerprint(forward);
  const prev = held.get(slot) as Held<T> | undefined;
  if (prev && prev.fingerprint === fp) {
    // The levels are the held ones; the clock-dependent labels (which session this is, the data's state and
    // times) are today's, so the card still says "for today" after midnight and shows the right chip.
    const body = { ...(prev.body as object) } as Record<string, unknown>;
    for (const k of LIVE_FIELDS) if (k in (fresh as object)) body[k] = (fresh as Record<string, unknown>)[k];
    return { body: body as T, heldSinceMs: prev.sinceMs };
  }
  held.set(slot, { fingerprint: fp, body: fresh, sinceMs: nowMs });
  return { body: fresh, heldSinceMs: null };
}

/** Test hook. */
export function _clearHeldMaps(): void { held.clear(); }
