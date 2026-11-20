// shared/streamFeed.ts
// The one line in settings that says how quotes are arriving: streamed live, read by request, or not at all.
// Pure, so the wording for each state is tested.

export interface StreamStatusLike {
  mode: "live" | "connecting" | "down";
  lastMessageAgeMs?: number | null;
  lastError?: string | null;
  reason?: string;
  perService?: Record<string, { lastDataAgeMs: number | null; keys: number }>;
}

export interface StreamFeedLabel { label: string; color: string; detail: string; /** A longer explanation shown in full under the line. */ note?: string }

/** Schwab refused the streaming sign-in for this app (the Trader API call that hands out the stream address). */
export const isStreamNotEntitled = (err: string | null | undefined) => /\b401\b/.test(err ?? "") && /userPreference/i.test(err ?? "");

export const STREAM_NOT_ENTITLED_NOTE =
  "Quotes are read from Schwab by request, not streamed. Schwab refused the streaming sign-in (401 on the Trader API user-preference call): " +
  "the Schwab developer app this terminal signs in with does not include the \"Accounts and Trading Production\" product. " +
  "Only the app's owner can add it, at developer.schwab.com, and Schwab reviews the change before it takes effect. " +
  "Nothing in the terminal is broken by this: prices, history and option chains still come from Schwab. The terminal checks again every 30 minutes.";

/** Feed mode for quotes: Schwab Streamer live, Schwab REST snapshots, or nothing. */
export function streamFeedLabel(connected: boolean, stream: StreamStatusLike | undefined): StreamFeedLabel {
  if (!connected) return { label: "Unavailable", color: "#f87171", detail: "Schwab not connected: no quotes" };
  if (stream?.mode === "live" && stream.lastMessageAgeMs != null && stream.lastMessageAgeMs >= 0 && stream.lastMessageAgeMs <= 60_000
      && (stream.perService?.LEVELONE_EQUITIES?.lastDataAgeMs ?? Infinity) >= 0
      && (stream.perService?.LEVELONE_EQUITIES?.lastDataAgeMs ?? Infinity) <= 60_000) {
    return { label: "Streaming live", color: "#34d399", detail: `${Math.round(stream.lastMessageAgeMs / 1000)}s since last frame` };
  }
  if (isStreamNotEntitled(stream?.lastError)) {
    return { label: "Read by request, streaming off", color: "#fbbf24", detail: "Schwab app not enabled for streaming", note: STREAM_NOT_ENTITLED_NOTE };
  }
  const why = stream?.lastError ?? stream?.reason ?? (stream?.mode === "connecting" ? "stream connecting" : "stream down");
  return { label: "Feed not verified", color: "#fbbf24", detail: why };
}
