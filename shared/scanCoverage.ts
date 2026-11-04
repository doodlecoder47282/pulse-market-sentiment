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
  /** Last cycle's symbols whose chain was served stale (an older chain after a failed refresh). */
  lastStale: number;
  /** Last time a cycle was skipped because the market was closed, and the first skip of that closed spell. */
  lastClosedSkipAt: number | null;
  closedSince: number | null;
  /** Start of the current unbroken run of fully successful cycles (null = none). */
  coveredSince: number | null;
}

export const EMPTY_SCAN_RECORD: ScanRecord = {
  lastAttemptAt: null, lastSuccessAt: null, lastAsked: 0, lastFailed: 0, lastStale: 0, lastClosedSkipAt: null, closedSince: null, coveredSince: null,
};

/** A cycle skipped because regular trading hours are over: nothing was read. */
export function recordClosedSkip(r: ScanRecord, at: number): ScanRecord {
  const continuing = r.closedSince != null && (r.lastAttemptAt == null || r.lastAttemptAt < r.closedSince);
  return { ...r, lastClosedSkipAt: at, closedSince: continuing ? r.closedSince : at, coveredSince: null };
}

/** Longest pause between cycles that still counts as one unbroken run (the engine runs every 30 s). */
export const MAX_CYCLE_GAP_MS = 90_000;

/**
 * A cycle that tried to read `asked` symbols, `failed` of which failed (an
 * exception that ended the cycle early counts every unread symbol as failed).
 * A fully successful cycle extends the covered run; anything less breaks it.
 */
export function recordCycle(r: ScanRecord, c: { startedAt: number; endedAt: number; asked: number; failed: number; stale?: number }): ScanRecord {
  const asked = Math.max(0, Math.floor(c.asked));
  const failed = Math.min(asked, Math.max(0, Math.floor(c.failed)));
  const stale = Math.min(asked - failed, Math.max(0, Math.floor(c.stale ?? 0)));
  const ok = asked - failed - stale;
  // Full = every symbol read from a fresh chain. A stale chain is not a fresh read.
  const full = asked > 0 && failed === 0 && stale === 0;
  // A pause longer than MAX_CYCLE_GAP_MS since the previous cycle breaks the run.
  const gap = r.lastAttemptAt == null || c.startedAt - r.lastAttemptAt > MAX_CYCLE_GAP_MS;
  return {
    ...r,
    lastAttemptAt: c.endedAt,
    lastSuccessAt: ok > 0 ? c.endedAt : r.lastSuccessAt,
    lastAsked: asked,
    lastFailed: failed,
    lastStale: stale,
    coveredSince: full ? (gap || r.coveredSince == null ? c.startedAt : r.coveredSince) : null,
  };
}

export type CoverageState = "fresh" | "partial" | "failed" | "closed" | "stale" | "not_running" | "unknown";

export interface Coverage {
  state: CoverageState;
  /** For partial: whether symbols failed or were served stale; for closed/stale: since when (epoch ms). */
  partialBecause?: "failed" | "stale" | null;
  since?: number | null;
  /** Whole minutes of unbroken complete coverage, up to the last completed cycle (null unless fresh). */
  coveredMinutes: number | null;
}

/** The scanner's coverage now. `maxAgeMs` is how old the last cycle may be before it is stale. */
export function coverage(r: ScanRecord | null | undefined, running: boolean | null | undefined, now: number, maxAgeMs = 3 * 60_000): Coverage {
  if (!r || running == null) return { state: "unknown", coveredMinutes: null };
  if (!running) return { state: "not_running", coveredMinutes: null };
  const attempt = r.lastAttemptAt ?? -Infinity;
  const closed = r.lastClosedSkipAt ?? -Infinity;
  // Closed when the most recent event was a closed-market skip and it is recent.
  if (closed > attempt && now - closed <= maxAgeMs) return { state: "closed", coveredMinutes: null, since: r.closedSince ?? r.lastClosedSkipAt };
  if (r.lastAttemptAt == null) return { state: "unknown", coveredMinutes: null };
  if (now - r.lastAttemptAt > maxAgeMs) return { state: "stale", coveredMinutes: null, since: r.lastSuccessAt };
  if (r.lastAsked === 0 || r.lastFailed >= r.lastAsked) return { state: "failed", coveredMinutes: null };
  if (r.lastFailed > 0 || (r.lastStale ?? 0) > 0) return { state: "partial", coveredMinutes: null, partialBecause: r.lastFailed > 0 ? "failed" : "stale" };
  // Completed coverage ends at the last completed cycle, not at `now`: time
  // passing before the stale deadline adds no coverage.
  const mins = r.coveredSince == null || r.lastAttemptAt == null ? 0 : Math.max(0, Math.floor((r.lastAttemptAt - r.coveredSince) / 60_000));
  return { state: "fresh", coveredMinutes: mins };
}

const etTime = (ms: number | null | undefined): string | null => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET"; }
  catch { return null; }
};

/**
 * "3 whales this hour, calls leading 2-1" over every scanned symbol. Zero is
 * an observation only when complete, fresh scans covered the whole hour; a
 * shorter run states its own window, and every other state names itself
 * instead of reading as a quiet tape. `alerts === null` means the alert
 * history could not be read.
 */
export function whaleCoverageLine(alerts: Array<{ type?: string; detectedAt?: number }> | null, now: number, cov: Coverage): string {
  if (alerts == null) return "Whale alert history unavailable: the read failed";
  const cutoff = now - 60 * 60_000;
  const recent = alerts.filter((w) => typeof w?.detectedAt === "number" && w.detectedAt >= cutoff);
  const calls = recent.filter((w) => w.type === "C").length;
  const puts = recent.filter((w) => w.type === "P").length;
  const since = etTime(cov.since);
  const why: Record<Exclude<CoverageState, "fresh">, string> = {
    partial: cov.partialBecause === "stale" ? "whale scan partial: some chains were stale" : "whale scan partial: some symbols failed",
    failed: "whale scan failed: no chain was read",
    closed: `market closed: whale scan paused${since ? ` since ${since}` : ""}`,
    stale: `whale scan stale${since ? ` since ${since}` : ""}`,
    not_running: "whale scan not running",
    unknown: "whale scan state unknown",
  };
  // Never round up: under one completed minute is said as such.
  const span = (cov.coveredMinutes ?? 0) >= 1 ? `the last ${cov.coveredMinutes} min` : "less than 1 min";
  const shortRun = cov.state === "fresh" && (cov.coveredMinutes ?? 0) < 60;
  if (recent.length === 0) {
    if (cov.state === "fresh") return shortRun ? `No whale flow in ${span} of complete scans` : "No whale flow this hour";
    const w = why[cov.state];
    return `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
  }
  const tail = cov.state === "fresh" ? (shortRun ? ` (complete scans for ${span})` : "") : ` (${why[cov.state]})`;
  const n = `${recent.length} whale${recent.length === 1 ? "" : "s"} this hour`;
  if (calls > puts * 1.5) return `${n}, calls leading ${calls}-${puts}${tail}`;
  if (puts > calls * 1.5) return `${n}, puts leading ${puts}-${calls}${tail}`;
  return `${n}, mixed (${calls} calls / ${puts} puts)${tail}`;
}
