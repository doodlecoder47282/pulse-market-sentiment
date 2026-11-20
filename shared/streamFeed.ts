// shared/streamFeed.ts
// The one line in settings that says how quotes are arriving: streamed live, read by request, or not at all.
// Pure, so the wording for each state is tested.

export interface StreamStatusLike {
  /** The stream's own state; "no_streamer_info" while the sign-in call is being refused or returns nothing. */
  state?: string;
  mode: "live" | "connecting" | "down";
  lastMessageAgeMs?: number | null;
  lastError?: string | null;
  reason?: string;
  perService?: Record<string, { lastDataAgeMs: number | null; keys: number }>;
}

export interface StreamFeedLabel { label: string; color: string; detail: string; /** A longer explanation shown in full under the line. */ note?: string }

/** The text of a refused streaming sign-in (a 401 on the Trader API call that hands out the stream address). */
export const isStreamNotEntitled = (err: string | null | undefined) => /\b401\b/.test(err ?? "") && /userPreference/i.test(err ?? "");

// A 401 does not say why. The note gives the usual cause as the usual cause, names the other one, and lists
// what is off without the stream instead of saying nothing is.
export const STREAM_NOT_ENTITLED_NOTE =
  "Quotes are read from Schwab by request, not streamed. Schwab refused the streaming sign-in: a 401 on the Trader API user-preference call. " +
  "The usual cause is that the Schwab developer app this terminal signs in with does not include the \"Accounts and Trading Production\" product, " +
  "which only the app's owner can add at developer.schwab.com (Schwab reviews the change). A Schwab sign-in that had expired when the call was made gives the same 401. " +
  "Still read by request: prices, history and option chains. Off without the stream: trade-by-trade buy and sell side, streamed option flow, block prints and streamed option marks. " +
  "The terminal tries the streaming sign-in again every 30 minutes.";

/** Feed mode for quotes: Schwab Streamer live, Schwab REST snapshots, or nothing. */
export function streamFeedLabel(connected: boolean, stream: StreamStatusLike | undefined): StreamFeedLabel {
  if (!connected) return { label: "Unavailable", color: "#f87171", detail: "Schwab not connected: no quotes" };
  if (stream?.mode === "live" && stream.lastMessageAgeMs != null && stream.lastMessageAgeMs >= 0 && stream.lastMessageAgeMs <= 60_000
      && (stream.perService?.LEVELONE_EQUITIES?.lastDataAgeMs ?? Infinity) >= 0
      && (stream.perService?.LEVELONE_EQUITIES?.lastDataAgeMs ?? Infinity) <= 60_000) {
    return { label: "Streaming live", color: "#34d399", detail: `${Math.round(stream.lastMessageAgeMs / 1000)}s since last frame` };
  }
  // Only while the stream is in that state now: the last error is kept after a later sign-in succeeds, and an
  // old refusal must not be shown as the reason a signed-in stream is quiet.
  if (stream?.mode !== "live" && stream?.state === "no_streamer_info" && isStreamNotEntitled(stream.lastError)) {
    return { label: "Read by request, streaming off", color: "#fbbf24", detail: "Schwab refused the streaming sign-in (401)", note: STREAM_NOT_ENTITLED_NOTE };
  }
  const why = stream?.lastError ?? stream?.reason ?? (stream?.mode === "connecting" ? "stream connecting" : "stream down");
  return { label: "Feed not verified", color: "#fbbf24", detail: why };
}
