// server/flowIntradayState.ts
// Pure helpers behind the intraday call/put flow series (flow.ts
// buildIntradayFlowSnapshot). No DB or network imports, so they are testable.
//
// Rules (round 3, R3-2 item 2):
//   - A sample enters the intraday buffer only from a FRESH Schwab chain
//     (read this poll and not marked stale). A stale or failed chain adds
//     nothing: the series is observed data only.
//   - No synthesized series. The old U-curve backfill spread today's
//     cumulative volume over 30-minute buckets with fixed weights; it drew
//     a shape nobody observed. With fewer than MIN_SERIES_SAMPLES real
//     samples the series is empty and its state is "insufficient_samples".
//   - Current volumes: "live" from this poll's fresh chain (an observed 0
//     stays 0); "last_sample" when this poll had no fresh chain but the last
//     fresh sample is younger than LAST_SAMPLE_MAX_AGE_MS (its real asOf is
//     returned); otherwise "unavailable" with null values, never 0.

export const MIN_SERIES_SAMPLES = 2;
/** Max age of the last fresh sample re-used when a poll has no fresh chain. */
export const LAST_SAMPLE_MAX_AGE_MS = 5 * 60_000;
/** Minimum spacing between buffered samples (seconds). */
export const SAMPLE_SPACING_S = 55;

export type IntradaySeriesState = "ok" | "insufficient_samples";
export type IntradayVolumeState = "live" | "last_sample" | "unavailable";

export interface ChainRead {
  /** A chain was returned by Schwab this poll. */
  read: boolean;
  /** Schwab marked it stale (served from cache past its fresh TTL). */
  stale: boolean;
  callVol: number;
  putVol: number;
}

/** Fresh = read this poll and not stale. Only fresh chains feed samples. */
export function isFreshChain(c: ChainRead): boolean {
  return c.read && !c.stale;
}

/** Whether a fresh chain at `nowS` should append a sample after `lastT` (epoch s). */
export function shouldAppendSample(c: ChainRead, lastT: number | null, nowS: number): boolean {
  if (!isFreshChain(c)) return false;
  return lastT == null || nowS - lastT >= SAMPLE_SPACING_S;
}

export function seriesFrom<T>(samples: ReadonlyArray<T>): { series: T[]; seriesState: IntradaySeriesState; seriesReason: string | null } {
  if (samples.length >= MIN_SERIES_SAMPLES) return { series: [...samples], seriesState: "ok", seriesReason: null };
  return {
    series: [],
    seriesState: "insufficient_samples",
    seriesReason: `insufficient samples: ${samples.length} of ${MIN_SERIES_SAMPLES} fresh Schwab chain reads so far today (no estimated series is drawn)`,
  };
}

export interface CurrentVolumes {
  callVol: number | null;
  putVol: number | null;
  pcr: number | null;
  volumeState: IntradayVolumeState;
  /** Epoch seconds the volumes were observed at; null when unavailable. */
  volumeAsOf: number | null;
}

/**
 * Current cumulative volumes for the ticker header.
 * @param c this poll's chain read
 * @param last last fresh buffered sample (t in epoch s), if any
 */
export function currentVolumes(
  c: ChainRead,
  last: { t: number; callVolume: number; putVolume: number } | null,
  nowS: number,
): CurrentVolumes {
  if (isFreshChain(c)) {
    return { callVol: c.callVol, putVol: c.putVol, pcr: c.callVol > 0 ? c.putVol / c.callVol : null, volumeState: "live", volumeAsOf: nowS };
  }
  if (last && (nowS - last.t) * 1000 <= LAST_SAMPLE_MAX_AGE_MS) {
    return {
      callVol: last.callVolume, putVol: last.putVolume,
      pcr: last.callVolume > 0 ? last.putVolume / last.callVolume : null,
      volumeState: "last_sample", volumeAsOf: last.t,
    };
  }
  return { callVol: null, putVol: null, pcr: null, volumeState: "unavailable", volumeAsOf: null };
}

/** The side breakdown may be re-used only under the same age bound as the volumes. */
export function aggressorStateOf(fresh: boolean, lastAggAsOf: number | null, nowS: number): "live" | "cached" | "unavailable" {
  if (fresh) return "live";
  if (lastAggAsOf != null && (nowS - lastAggAsOf) * 1000 <= LAST_SAMPLE_MAX_AGE_MS) return "cached";
  return "unavailable";
}
