// shared/signalRecord.ts
//
// One read-only record of what the terminal's signal sources have logged and
// graded (docs/PRO_REVIEW_2026-11-17.md, options "missing" item 1). Pure:
// types and the gate rules only. No grading rule lives here: each source keeps
// its own entry basis, exit rule and costs, and its own summary function does
// the arithmetic (server/signalRecord.ts calls them).
//
// Rules this file encodes:
//   - Under the source's own minimum sample (or DEFAULT_MIN_GRADED when the
//     source defines none) the state is "insufficient" and the win share, its
//     interval and the mean net are null: counts only.
//   - A source whose store cannot be read is "unavailable" with the reason and
//     null counts. It is never shown as zero.
//   - Sources are graded on different bases, so nothing here pools them. The
//     record has no overall win share and no helper that makes one.
//   - A win share is never produced without its sample size and interval. The
//     interval is Wilson 95%, computed by the repo's existing helper, which the
//     caller passes in (this file holds no interval formula).

/**
 * Minimum graded sample for a source that defines none of its own. Hand-set:
 * 30 is a convention for "enough rows to print a proportion with an interval",
 * not a fitted or tested threshold. Sources with their own gate use that gate.
 */
export const DEFAULT_MIN_GRADED = 30;

export type SignalRecordState = "ok" | "insufficient" | "unavailable";

/**
 * win_loss:    the source grades each signal as a win or not (its own rule).
 * calibration: the source scores stated odds against what happened; there is
 *              no per-signal win, so no win share is shown.
 * counts_only: the source's store is readable but it has no summary function
 *              this record can call, so only counts are shown.
 */
export type SignalRecordKind = "win_loss" | "calibration" | "counts_only";

export interface SignalRecordBasis {
  /** What price or moment a signal is entered at. */
  entry: string;
  /** The exit / grading rule, including what counts as a win for this source. */
  exit: string;
  /** Fees and costs treatment. */
  costs: string;
}

/** All null when the store could not be read (unknown is not zero). */
export interface SignalRecordCounts {
  emitted: number | null;
  graded: number | null;
  open: number | null;
  excluded: number | null;
}

/** How meanNet is expressed: "fraction" (0.12 = 12%) or "percent" (12 = 12%). */
export type MeanNetScale = "fraction" | "percent";

export interface SignalRecordSource {
  id: string;
  name: string;
  kind: SignalRecordKind;
  state: SignalRecordState;
  /** Why the state is what it is (always set for insufficient / unavailable). */
  reason: string | null;
  basis: SignalRecordBasis;
  n: SignalRecordCounts;
  /** Wins / graded. Null under the gate, when unavailable, and for sources without a per-signal win. */
  winShare: number | null;
  /** Wilson 95% interval of winShare. Null whenever winShare is null. */
  winLo: number | null;
  winHi: number | null;
  /** The source's own mean net result. Null under the gate or when the source reports none. */
  meanNet: number | null;
  /** What meanNet is a mean of, in words. Null when the source reports no mean. */
  meanNetUnit: string | null;
  meanNetScale: MeanNetScale | null;
  minSample: number;
  /** "source" = the gate the source's own code uses; "default" = DEFAULT_MIN_GRADED (hand-set). */
  minSampleFrom: "source" | "default";
  /** Start of the window the counts cover, epoch ms. Null = everything the store holds, or unknown. */
  since: number | null;
  notes: string[];
}

/** The response of GET /api/record/signals. Deliberately has no overall / pooled figure. */
export interface SignalRecord {
  asOf: number;
  defaultMinSample: number;
  sources: SignalRecordSource[];
  note: string;
}

export const SIGNAL_RECORD_NOTE =
  "What a win means differs by source and is stated per row. Sources are graded on different bases and are not comparable to each other, so no overall figure is computed. " +
  "These are counts of what was logged and how it was graded: not a forecast and not a claim of edge.";

export type WilsonFn = (successes: number, n: number) => { lo: number; hi: number };

export interface SourceMeta {
  id: string;
  name: string;
  kind: SignalRecordKind;
  basis: SignalRecordBasis;
}

export interface SourceInput extends SourceMeta {
  n: { emitted: number; graded: number; open: number; excluded: number };
  /** Graded signals the source counts as wins. Null for calibration / counts-only sources or when the source does not report it. */
  wins: number | null;
  /** The source's own mean net result (never recomputed here). */
  meanNet?: number | null;
  meanNetUnit?: string | null;
  meanNetScale?: MeanNetScale | null;
  /** The source's own minimum graded sample; null or undefined = it defines none. */
  minSample?: number | null;
  /** A further gate the source itself applies (for example too many unpriced rows). */
  sourceGate?: { ready: boolean; reason: string | null } | null;
  since?: number | null;
  notes?: string[];
}

const count = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};

/** The gate a source is held to: its own minimum when it has one, else the hand-set default. */
export function resolveMinSample(own: number | null | undefined): { minSample: number; from: "source" | "default" } {
  return own != null && Number.isFinite(own) && own > 0
    ? { minSample: Math.ceil(own), from: "source" }
    : { minSample: DEFAULT_MIN_GRADED, from: "default" };
}

/** "INSUFFICIENT DATA: n of m needed". */
export function insufficientText(graded: number, minSample: number): string {
  return `INSUFFICIENT DATA: ${graded} of ${minSample} needed`;
}

/**
 * Apply the record's gate rules to one source. `wilson` is the repo's
 * existing Wilson helper (server/validationMath.wilsonInterval).
 */
export function buildSource(input: SourceInput, wilson: WilsonFn): SignalRecordSource {
  const n = {
    emitted: count(input.n.emitted),
    graded: count(input.n.graded),
    open: count(input.n.open),
    excluded: count(input.n.excluded),
  };
  const { minSample, from } = resolveMinSample(input.minSample);
  const notes = [...(input.notes ?? [])];
  const base = {
    id: input.id, name: input.name, kind: input.kind, basis: input.basis, n,
    minSample, minSampleFrom: from, since: input.since ?? null,
  };
  const empty = { winShare: null, winLo: null, winHi: null, meanNet: null, meanNetUnit: input.meanNetUnit ?? null, meanNetScale: input.meanNetScale ?? null };

  const underMin = n.graded < minSample;
  const gateBlocked = input.sourceGate != null && input.sourceGate.ready === false;
  if (underMin || gateBlocked) {
    const reason = underMin
      ? insufficientText(n.graded, minSample)
      : `INSUFFICIENT DATA: ${input.sourceGate?.reason ?? "the source's own sample gate is not met"}`;
    return { ...base, state: "insufficient", reason, ...empty, notes };
  }

  const meanNet = input.meanNet != null && Number.isFinite(input.meanNet) ? input.meanNet : null;
  if (input.kind !== "win_loss") {
    const reason = input.kind === "calibration"
      ? "stated odds scored against outcomes: there is no per-signal win, so no win share is shown"
      : "this source has no summary function the record can call: counts only";
    return { ...base, state: "ok", reason, ...empty, meanNet, notes };
  }
  const wins = input.wins;
  if (wins == null || !Number.isFinite(wins) || wins < 0 || wins > n.graded) {
    return { ...base, state: "ok", reason: "the source's summary does not report a win count: counts only", ...empty, meanNet, notes };
  }
  const w = wilson(wins, n.graded);
  return {
    ...base, state: "ok", reason: null,
    winShare: wins / n.graded, winLo: w.lo, winHi: w.hi,
    meanNet, meanNetUnit: input.meanNetUnit ?? null, meanNetScale: input.meanNetScale ?? null,
    notes,
  };
}

/** A source whose store could not be read: never zero, never a pass. */
export function unavailableSource(meta: SourceMeta, reason: string, minSample?: number | null): SignalRecordSource {
  const m = resolveMinSample(minSample);
  return {
    id: meta.id, name: meta.name, kind: meta.kind, basis: meta.basis,
    state: "unavailable",
    reason: reason && reason.trim() ? reason.trim() : "the store could not be read",
    n: { emitted: null, graded: null, open: null, excluded: null },
    winShare: null, winLo: null, winHi: null,
    meanNet: null, meanNetUnit: null, meanNetScale: null,
    minSample: m.minSample, minSampleFrom: m.from,
    since: null, notes: [],
  };
}

/**
 * Whole-number wins from a rate the source computed as wins / n (exact for a
 * rate that was never rounded). Null when the rate is not a usable number.
 */
export function winsFromRate(rate: number | null | undefined, n: number): number | null {
  if (rate == null || !Number.isFinite(rate) || rate < 0 || rate > 1 || !(n >= 0)) return null;
  return Math.round(rate * n);
}

export function makeSignalRecord(sources: SignalRecordSource[], asOf: number): SignalRecord {
  return { asOf, defaultMinSample: DEFAULT_MIN_GRADED, sources, note: SIGNAL_RECORD_NOTE };
}

// ── Text for the card (shared so it is unit-tested without React) ──────────

const pct0 = (x: number) => `${Math.round(x * 100)}%`;

/** The result cell of one row: never a win share without its interval and n. */
export function resultText(s: SignalRecordSource): string {
  if (s.state === "unavailable") return `UNAVAILABLE: ${s.reason ?? "the store could not be read"}`;
  if (s.state === "insufficient") return s.reason ?? insufficientText(s.n.graded ?? 0, s.minSample);
  if (s.winShare == null || s.winLo == null || s.winHi == null) {
    return s.kind === "calibration" ? "no win share (calibration source): see notes" : "counts only";
  }
  return `${pct0(s.winShare)} wins (95% interval ${pct0(s.winLo)} to ${pct0(s.winHi)}, n=${s.n.graded})`;
}

/** Mean net with its unit, or null when there is none to show. */
export function meanNetText(s: SignalRecordSource): string | null {
  if (s.state !== "ok" || s.meanNet == null || !Number.isFinite(s.meanNet) || !s.meanNetUnit) return null;
  const v = s.meanNetScale === "fraction" ? s.meanNet * 100 : s.meanNet;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}% ${s.meanNetUnit}`;
}

/** A count for display: an unread store is a dash, never 0. */
export function countText(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "-" : String(v);
}
