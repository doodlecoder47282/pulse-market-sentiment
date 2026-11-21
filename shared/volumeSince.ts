// shared/volumeSince.ts
// CONTRACTS TRADED SINCE A FLAG, ACROSS SESSIONS. Schwab's option volume is the running total for the current
// session and starts again from zero the next one. "Volume now minus volume at the flag" is therefore right
// only on the day of the flag: the day after, it reads low or zero for a contract that kept trading. This
// keeps a running sum instead: each read adds what traded since the previous read, and a new session's total
// is counted from zero. It is a FLOOR, not an exact count: trading in a session the scanner never read, and
// the part of a new session that is still under the previous day's last total when it is first read, are
// not seen. Pure.

export interface VolumeState {
  /** Session volume at the previous read. */
  volume: number;
  /** Contracts counted since the flag so far. */
  since: number;
  /** ET date of the session `volume` belongs to. */
  day: string;
}

/**
 * The state after a new read of the session volume on ET date `today`.
 *   - Same session, volume up: add the increase.
 *   - Volume lower than before, and the previous total was an earlier session's: a new session has begun;
 *     all of its volume so far is new.
 *   - Volume lower on the same session: a correction or an older snapshot; nothing is added and the total
 *     already counted is kept (the previous reading stays the baseline, so the same contracts are not
 *     counted again when the feed catches up).
 *   - A later date with volume at or above the previous total: usually the previous session's figure still
 *     being served before the open, so the session is not treated as new yet; any increase is added.
 */
export function nextVolumeState(prev: VolumeState, newVolume: number, today: string): VolumeState {
  if (!Number.isFinite(newVolume) || newVolume < 0) return prev;
  if (newVolume >= prev.volume) return { volume: newVolume, since: prev.since + (newVolume - prev.volume), day: prev.day };
  if (today > prev.day) return { volume: newVolume, since: prev.since + newVolume, day: today };
  return prev;
}
