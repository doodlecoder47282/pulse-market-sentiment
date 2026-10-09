// shared/dataState.ts
//
// One vocabulary for "what state is this number in", used by the server
// (dataState fields on API payloads) and the client (DataStateChip). Pure: no
// React, no DB, so it is unit-tested on plain Node.
//
// The rule it encodes (AGENTS.md, user rule 5): missing, stale, failed,
// partial and observed-zero are different states. A failed or missing feed is
// never shown as 0, neutral, quiet or healthy, and an observed 0 is never
// turned into "missing".
//
// States the server emits today (grep `dataState` in server/):
//   ok           complete data
//   partial      some inputs missing (e.g. minute bars without volume)
//   stale        data present but older than its stated max age
//   unavailable  the source could not answer (fetch failed / not connected)
//   no_data      the source answered with nothing (empty tape, holiday)
//   no_spot      chain present but no underlying price, so nothing S-scaled
// Client-side extras:
//   observed_zero a real reading of 0 (not missing)
//   loading       request in flight, nothing to show yet
//   failed        the request itself errored (HTTP 5xx / network)

export type DataState =
  | "ok"
  | "partial"
  | "stale"
  | "unavailable"
  | "no_data"
  | "no_spot"
  | "observed_zero"
  | "loading"
  | "failed";

export type DataStateTone = "ok" | "warn" | "bad" | "neutral";

export interface DataStateView {
  /** Normalized state (unknown strings map to "unavailable", never to "ok"). */
  state: DataState;
  /** Short chip text, lower case, e.g. "partial", "no spot". */
  label: string;
  tone: DataStateTone;
  /** True when the numbers next to the chip must not be read as a signal. */
  blocksSignal: boolean;
  /** Longer explanation for a tooltip. */
  title: string;
}

const KNOWN: Record<DataState, { label: string; tone: DataStateTone; blocksSignal: boolean; title: string }> = {
  ok:            { label: "ok",            tone: "ok",      blocksSignal: false, title: "Complete data from the stated source." },
  partial:       { label: "partial",       tone: "warn",    blocksSignal: false, title: "Some inputs are missing; the missing parts are shown as gaps, not zeros." },
  stale:         { label: "stale",         tone: "warn",    blocksSignal: true,  title: "Data is older than its maximum age; do not read it as current." },
  unavailable:   { label: "unavailable",   tone: "bad",     blocksSignal: true,  title: "The source could not answer. Nothing is shown in place of the data." },
  no_data:       { label: "no data",       tone: "bad",     blocksSignal: true,  title: "The source answered with no data for this window." },
  no_spot:       { label: "no spot",       tone: "bad",     blocksSignal: true,  title: "No underlying price, so price-scaled values cannot be computed." },
  observed_zero: { label: "0 observed",    tone: "neutral", blocksSignal: false, title: "A real reading of zero, not missing data." },
  loading:       { label: "loading",       tone: "neutral", blocksSignal: true,  title: "Request in flight." },
  failed:        { label: "request failed", tone: "bad",    blocksSignal: true,  title: "The request to the server failed." },
};

/**
 * Normalizes any server/client state string. Unknown or empty strings are
 * treated as "unavailable" (fail closed): a state we do not recognise is
 * never shown as healthy.
 */
const ALIASES: Record<string, DataState> = {
  live: "ok",
  fresh: "ok",
  missing: "unavailable",
  error: "unavailable",
  empty: "no_data",
};

function recognize(raw: string | null | undefined): DataState | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(ALIASES, s)) return ALIASES[s];
  if (Object.prototype.hasOwnProperty.call(KNOWN, s)) return s as DataState;
  return null;
}

export function normalizeDataState(raw: string | null | undefined): DataState {
  return recognize(raw) ?? "unavailable";
}

export function describeDataState(raw: string | null | undefined, reason?: string | null): DataStateView {
  const state = normalizeDataState(raw);
  const k = KNOWN[state];
  // An unrecognised state string keeps the fail-closed "unavailable" styling
  // but says so, rather than pretending to know what happened.
  const label = recognize(raw) != null ? k.label : "unknown state";
  const title = [k.title, reason ? `Reason: ${reason}` : null].filter(Boolean).join(" ");
  return { state, label, tone: k.tone, blocksSignal: k.blocksSignal, title };
}

// ── Age ──────────────────────────────────────────────────────────────────────

/**
 * Age text for a chip: "8s", "4m", "2h 05m", "3d 4h". Null or non-finite
 * age is "age unknown" (never "0s"). Negative ages (clock skew, a timestamp
 * slightly in the future) are clamped to 0 and marked with "~".
 */
export function formatAge(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return "age unknown";
  if (ageMs < 0) return "~0s";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export type AgeClass = "fresh" | "stale" | "unknown";

/** Fresh when age <= maxAgeMs; stale when older; unknown without an age or a max. */
export function classifyAge(ageMs: number | null | undefined, maxAgeMs: number | null | undefined): AgeClass {
  if (ageMs == null || !Number.isFinite(ageMs)) return "unknown";
  if (maxAgeMs == null || !Number.isFinite(maxAgeMs)) return "unknown";
  return ageMs <= maxAgeMs ? "fresh" : "stale";
}

/**
 * Age in ms from an as-of timestamp. Accepts epoch ms, epoch seconds (values
 * below 1e12 are treated as seconds) or an ISO string. Null when unparseable.
 */
export function ageFromAsOf(asOf: number | string | null | undefined, nowMs: number): number | null {
  if (asOf == null || asOf === "") return null;
  let t: number;
  if (typeof asOf === "number") {
    if (!Number.isFinite(asOf) || asOf <= 0) return null;
    t = asOf < 1e12 ? asOf * 1000 : asOf;
  } else {
    t = Date.parse(asOf);
    if (!Number.isFinite(t)) return null;
  }
  return nowMs - t;
}

/**
 * Combines a reported state with the data age: an "ok" or "partial" payload
 * older than maxAgeMs is shown as "stale". It never upgrades a bad state.
 */
export function effectiveDataState(
  raw: string | null | undefined,
  ageMs: number | null | undefined,
  maxAgeMs: number | null | undefined,
): DataState {
  const s = normalizeDataState(raw);
  if ((s === "ok" || s === "partial") && classifyAge(ageMs, maxAgeMs) === "stale") return "stale";
  return s;
}

// ── Scan coverage (round 4) ──────────────────────────────────────────────────

/**
 * State of a multi-symbol scan from how many symbols answered: every symbol
 * failed -> "unavailable"; some failed -> "partial"; none failed -> "ok"
 * (zero hits on a complete scan is an observed zero, not missing). An empty
 * universe is "no_data".
 */
export function scanCoverageState(
  scanned: number,
  failed: number,
  what = "symbols",
): { dataState: "ok" | "partial" | "unavailable" | "no_data"; reason: string | null } {
  if (!(scanned > 0)) return { dataState: "no_data", reason: `no ${what} in the scan universe` };
  const f = Math.max(0, Math.min(scanned, failed));
  if (f === scanned) return { dataState: "unavailable", reason: `all ${scanned} ${what} failed to load` };
  if (f > 0) return { dataState: "partial", reason: `${f} of ${scanned} ${what} failed to load; hits cover the rest only` };
  return { dataState: "ok", reason: null };
}
