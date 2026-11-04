// shared/scanCoverage.ts
//
// What the whale scanner actually READ, kept apart from when it last ran.
// Pure: the engine (server/flowAlertEngine.ts) feeds it one event per cycle,
// and the headline reads the state. A quiet tape ("no whale flow this hour")
// is only stated when successful scans covered that hour; a closed market, a
// failed or partial cycle, a stale scanner or a short run says so instead.

export interface ScanRecord {
  /** End of the last cycle that tried to read chains (null = never). */
  lastAttemptAt: number | null;
  /** End of the last cycle in which at least one symbol was read successfully. */
  lastSuccessAt: number | null;
  /** Last cycle's symbols asked for, and how many of them failed. */
  lastAsked: number;
  lastFailed: number;
  /** Last time a cycle was skipped because the market was closed. */
  lastClosedSkipAt: number | null;
  /** Start of the current unbroken run of fully successful cycles (null = none). */
  coveredSince: number | null;
}

export const EMPTY_SCAN_RECORD: ScanRecord = {
  lastAttemptAt: null, lastSuccessAt: null, lastAsked: 0, lastFailed: 0, lastClosedSkipAt: null, coveredSince: null,
};

/** A cycle skipped because regular trading hours are over: nothing was read. */
export function recordClosedSkip(r: ScanRecord, at: number): ScanRecord {
  return { ...r, lastClosedSkipAt: at, coveredSince: null };
}

/**
 * A cycle that tried to read `asked` symbols, `failed` of which failed (an
 * exception that ended the cycle early counts every unread symbol as failed).
 * A fully successful cycle extends the covered run; anything less breaks it.
 */
export function recordCycle(r: ScanRecord, c: { startedAt: number; endedAt: number; asked: number; failed: number }): ScanRecord {
  const asked = Math.max(0, Math.floor(c.asked));
  const failed = Math.min(asked, Math.max(0, Math.floor(c.failed)));
  const ok = asked - failed;
  const full = asked > 0 && failed === 0;
  return {
    ...r,
    lastAttemptAt: c.endedAt,
    lastSuccessAt: ok > 0 ? c.endedAt : r.lastSuccessAt,
    lastAsked: asked,
    lastFailed: failed,
    coveredSince: full ? (r.coveredSince ?? c.startedAt) : null,
  };
}

export type CoverageState = "fresh" | "partial" | "failed" | "closed" | "stale" | "not_running" | "unknown";

export interface Coverage {
  state: CoverageState;
  /** Minutes of unbroken successful coverage up to now (null unless fresh). */
  coveredMinutes: number | null;
}

/** The scanner's coverage now. `maxAgeMs` is how old the last cycle may be before it is stale. */
export function coverage(r: ScanRecord | null | undefined, running: boolean | null | undefined, now: number, maxAgeMs = 3 * 60_000): Coverage {
  if (!r || running == null) return { state: "unknown", coveredMinutes: null };
  if (!running) return { state: "not_running", coveredMinutes: null };
  const attempt = r.lastAttemptAt ?? -Infinity;
  const closed = r.lastClosedSkipAt ?? -Infinity;
  // Closed when the most recent event was a closed-market skip and it is recent.
  if (closed > attempt && now - closed <= maxAgeMs) return { state: "closed", coveredMinutes: null };
  if (r.lastAttemptAt == null) return { state: "unknown", coveredMinutes: null };
  if (now - r.lastAttemptAt > maxAgeMs) return { state: "stale", coveredMinutes: null };
  if (r.lastAsked === 0 || r.lastFailed >= r.lastAsked) return { state: "failed", coveredMinutes: null };
  if (r.lastFailed > 0) return { state: "partial", coveredMinutes: null };
  const mins = r.coveredSince == null ? 0 : Math.max(0, Math.floor((now - r.coveredSince) / 60_000));
  return { state: "fresh", coveredMinutes: mins };
}

/**
 * "3 whales this hour, calls leading 2-1" over every scanned symbol. Zero is
 * an observation only when successful scans covered the whole hour; a shorter
 * run gives its own window ("in the last 12 min"), and every other state names
 * itself instead of reading as a quiet tape. `alerts === null` means the alert
 * history could not be read.
 */
export function whaleCoverageLine(alerts: Array<{ type?: string; detectedAt?: number }> | null, now: number, cov: Coverage): string {
  if (alerts == null) return "Whale alert history unavailable: the read failed";
  const cutoff = now - 60 * 60_000;
  const recent = alerts.filter((w) => typeof w?.detectedAt === "number" && w.detectedAt >= cutoff);
  const calls = recent.filter((w) => w.type === "C").length;
  const puts = recent.filter((w) => w.type === "P").length;
  const why: Record<Exclude<CoverageState, "fresh">, string> = {
    partial: "whale scan partial: some symbols failed",
    failed: "whale scan failed: no chain was read",
    closed: "market closed: whale scan paused",
    stale: "whale scan stale",
    not_running: "whale scan not running",
    unknown: "whale scan state unknown",
  };
  if (recent.length === 0) {
    if (cov.state === "fresh") {
      const m = cov.coveredMinutes ?? 0;
      return m >= 60 ? "No whale flow this hour" : `No whale flow in the last ${Math.max(1, m)} min (scan running for ${m} min)`;
    }
    const w = why[cov.state];
    return `${w.charAt(0).toUpperCase()}${w.slice(1)}; no ${cov.state === "partial" ? "complete " : ""}flow read this hour`;
  }
  const tail = cov.state === "fresh" ? "" : ` (${why[cov.state]})`;
  const n = `${recent.length} whale${recent.length === 1 ? "" : "s"} this hour`;
  if (calls > puts * 1.5) return `${n}, calls leading ${calls}-${puts}${tail}`;
  if (puts > calls * 1.5) return `${n}, puts leading ${puts}-${calls}${tail}`;
  return `${n}, mixed (${calls} calls / ${puts} puts)${tail}`;
}
