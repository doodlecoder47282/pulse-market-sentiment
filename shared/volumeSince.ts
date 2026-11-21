// shared/volumeSince.ts
// CONTRACTS TRADED SINCE A FLAG, ACROSS SESSIONS. Schwab's option volume is the running total for the current
// session and starts again from zero the next one. "Volume now minus volume at the flag" is therefore right
// only on the day of the flag: the day after, it reads low or zero for a contract that kept trading. This
// keeps a running sum instead: each read adds what traded since the previous read, and a new session's total
// is counted from zero. It is a FLOOR, not an exact count: a session the scanner never read is not counted.
// One case is NOT a floor and is not verified against the live feed: if a source still reports the previous
// session's total, stamped during today's session, after today's own count has been read, AND carries no
// last-trade time (or one from today), that total is taken for a jump in today's volume and counted again.
// With a last-trade time from an earlier day the reading is not counted at all. Pure.
import { etDate, isRegularSessionOpen } from "./exchangeCalendar";

export interface VolumeState {
  /** Session volume at the previous read. */
  volume: number;
  /** Contracts counted since the flag so far. */
  since: number;
  /** ET date of the session `volume` belongs to. */
  day: string;
}

/**
 * The state after a read of the session volume taken at `readAtMs`.
 *   - A read on an earlier ET date than the state's: ignored.
 *   - Same session, volume up: add the increase.
 *   - Same session, volume lower: a correction or an older snapshot; nothing is added and the higher reading
 *     stays the baseline, so the same contracts are not counted again when the feed catches up.
 *   - A later ET date, read during that day's regular session: a new session. Its volume started from zero,
 *     so ALL of the reading is new, whether it is below or above the previous session's last total. (Judging
 *     "new session" by "lower than before" lost the whole previous total whenever the first read of the day
 *     came late or the contract opened busier than it closed.)
 *   - A later ET date, read outside the regular session (before the open, a weekend, a holiday): ignored. The
 *     feed can still be showing the previous session's total then.
 *   - The contract's own last trade is on an earlier ET date than the read (`lastTradeMs`, when the feed gives
 *     one): nothing has traded in it today, so whatever volume the feed shows is not today's. The reading is
 *     not counted; a new session, if one has begun, starts at zero. This holds whether or not the feed resets
 *     its volume to zero before the first trade of the day, which is not verified.
 */
export function nextVolumeState(prev: VolumeState, newVolume: number, readAtMs: number, lastTradeMs: number | null = null): VolumeState {
  if (!Number.isFinite(newVolume) || newVolume < 0 || !Number.isFinite(readAtMs)) return prev;
  const today = etDate(readAtMs);
  if (today < prev.day) return prev;
  const untradedToday = typeof lastTradeMs === "number" && Number.isFinite(lastTradeMs) && lastTradeMs > 0 && etDate(lastTradeMs) < today;
  if (today > prev.day) {
    if (!isRegularSessionOpen(readAtMs)) return prev;
    if (untradedToday) return { volume: 0, since: prev.since, day: today };
    return { volume: newVolume, since: prev.since + newVolume, day: today };
  }
  if (untradedToday) return prev;
  if (newVolume > prev.volume) return { volume: newVolume, since: prev.since + (newVolume - prev.volume), day: prev.day };
  return prev;
}
