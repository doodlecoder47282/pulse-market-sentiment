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
  /** What a counted win is called for this source ("wins", "top-pick hits"). */
  winLabel: string;
  /** The sample the win share is over when that is not the whole graded count (for example one grade bucket). */
  winN: number | null;
  winScope: string | null;
  /** 0 when no minimum applies (rows that never show a win share and have no gate of their own). */
  minSample: number;
  /** "source" = the gate the source's own code uses; "default" = DEFAULT_MIN_GRADED (hand-set); "not_applicable" = no gate applies to this row. */
  minSampleFrom: "source" | "default" | "not_applicable";
  /** What the minimum counts, when it is not simply graded signals (for example "per grade bucket"). */
  minSampleScope: string | null;
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
  /** A component the source cannot provide is null (and said so in a note), never 0. */
  n: { emitted: number | null; graded: number; open: number | null; excluded: number | null };
  /** Graded signals the source counts as wins. Null for calibration / counts-only sources or when the source does not report it. */
  wins: number | null;
  /** The source's own mean net result (never recomputed here). */
  meanNet?: number | null;
  meanNetUnit?: string | null;
  meanNetScale?: MeanNetScale | null;
  /** The source's own minimum graded sample; null or undefined = it defines none. */
  minSample?: number | null;
  /** What the minimum counts when it is not the whole graded count, e.g. "per grade bucket". */
  minSampleScope?: string | null;
  /** The count held against the minimum when it is not the whole graded count (e.g. the largest bucket). */
  gateCount?: number | null;
  /** Words after "n of m needed", e.g. "in the largest grade bucket (85-89)". */
  gateLabel?: string | null;
  /** Denominator of the win share when it is not the whole graded count. */
  winN?: number | null;
  /** What the win share covers when it is not the whole source, e.g. "grade bucket 85-89 only". */
  winScope?: string | null;
  /** Default "wins". */
  winLabel?: string | null;
  /** A further gate the source itself applies (for example too many unpriced rows). */
  sourceGate?: { ready: boolean; reason: string | null } | null;
  since?: number | null;
  notes?: string[];
}

const count = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};
const countOrNull = (v: unknown): number | null => (v == null ? null : count(v));

/** The gate a source is held to: its own minimum when it has one, else the hand-set default. */
export function resolveMinSample(own: number | null | undefined): { minSample: number; from: "source" | "default" } {
  return own != null && Number.isFinite(own) && own > 0
    ? { minSample: Math.ceil(own), from: "source" }
    : { minSample: DEFAULT_MIN_GRADED, from: "default" };
}

/**
 * The gate as a row states it. A row that never shows a win share has no use
 * for the hand-set default: it carries its own gate when it has one and
 * otherwise none ("not_applicable", 0).
 */
export function gateFor(kind: SignalRecordKind, own: number | null | undefined): { minSample: number; from: "source" | "default" | "not_applicable" } {
  const r = resolveMinSample(own);
  return kind !== "win_loss" && r.from === "default" ? { minSample: 0, from: "not_applicable" } : r;
}

/** "INSUFFICIENT DATA: n of m needed". */
export function insufficientText(have: number, minSample: number, label?: string | null): string {
  return `INSUFFICIENT DATA: ${have} of ${minSample} needed${label ? ` ${label}` : ""}`;
}

/** What a row that never shows a win share is, in words (never a countdown to one). */
export function kindText(kind: SignalRecordKind): string {
  return kind === "calibration"
    ? "calibration: stated odds scored against outcomes; there is no per-signal win, so no win share is shown"
    : kind === "counts_only"
      ? "counts only: this source has no summary function the record can call, so no win share is shown"
      : "win or loss per signal";
}

/** The part of `emitted` that is neither graded nor open; null when the parts exceed the whole (unknown, not 0). */
export function remainder(emitted: number, graded: number, open: number): number | null {
  const r = emitted - graded - open;
  return Number.isFinite(r) && r >= 0 ? r : null;
}

/** True when all four counts are numbers and emitted = graded + open + excluded. */
export function countsReconcile(n: SignalRecordCounts): boolean {
  return n.emitted != null && n.graded != null && n.open != null && n.excluded != null && n.emitted === n.graded + n.open + n.excluded;
}

/**
 * Apply the record's gate rules to one source. `wilson` is the repo's
 * existing Wilson helper (server/validationMath.wilsonInterval).
 */
export function buildSource(input: SourceInput, wilson: WilsonFn): SignalRecordSource {
  const n: SignalRecordCounts = {
    emitted: countOrNull(input.n.emitted),
    graded: count(input.n.graded),
    open: countOrNull(input.n.open),
    excluded: countOrNull(input.n.excluded),
  };
  const graded = n.graded as number;
  const notes = [...(input.notes ?? [])];
  // emitted = graded + open + excluded on every row. Where the source's own
  // counts do not add up, the excluded count is unknown (null), never forced.
  if (n.emitted != null && n.open != null && n.excluded != null && !countsReconcile(n)) {
    notes.push(`the source's counts do not add up (emitted ${n.emitted}, graded ${graded}, open ${n.open}, excluded ${n.excluded}): excluded is shown as unknown`);
    n.excluded = null;
  }
  const { minSample, from } = gateFor(input.kind, input.minSample);
  const base = {
    id: input.id, name: input.name, kind: input.kind, basis: input.basis, n,
    winLabel: input.winLabel || "wins",
    minSample, minSampleFrom: from, minSampleScope: input.minSampleScope ?? null, since: input.since ?? null,
  };
  const empty = { winShare: null, winLo: null, winHi: null, winN: null, winScope: null, meanNet: null, meanNetUnit: input.meanNetUnit ?? null, meanNetScale: input.meanNetScale ?? null };

  // Rows that never show a win share: say what the row is. They are held to
  // a gate only when the source has one of its own (for its notes), and the
  // reason still leads with what the row is, not with a countdown.
  if (input.kind !== "win_loss") {
    const what = kindText(input.kind);
    if (from === "source" && graded < minSample) {
      return { ...base, state: "insufficient", reason: `${what}. The source reads its scorecard from ${minSample} graded; ${graded} so far`, ...empty, notes };
    }
    return { ...base, state: "ok", reason: what, ...empty, notes };
  }

  const have = input.gateCount != null ? count(input.gateCount) : graded;
  const underMin = have < minSample;
  const gateBlocked = input.sourceGate != null && input.sourceGate.ready === false;
  if (underMin || gateBlocked) {
    const reason = underMin
      ? insufficientText(have, minSample, input.gateLabel)
      : `INSUFFICIENT DATA: ${input.sourceGate?.reason ?? "the source's own sample gate is not met"}`;
    return { ...base, state: "insufficient", reason, ...empty, notes };
  }

  const meanNet = input.meanNet != null && Number.isFinite(input.meanNet) ? input.meanNet : null;
  const wins = input.wins;
  const winN = input.winN != null ? count(input.winN) : graded;
  if (wins == null || !Number.isFinite(wins) || wins < 0 || wins > winN || !(winN > 0)) {
    return { ...base, state: "ok", reason: "the source's summary does not report a win count: counts only", ...empty, meanNet, notes };
  }
  const w = wilson(wins, winN);
  return {
    ...base, state: "ok", reason: null,
    winShare: wins / winN, winLo: w.lo, winHi: w.hi,
    winN, winScope: input.winScope ?? null,
    meanNet, meanNetUnit: input.meanNetUnit ?? null, meanNetScale: input.meanNetScale ?? null,
    notes,
  };
}

/** A source whose store could not be read: never zero, never a pass. It still states its own gate. */
export function unavailableSource(meta: SourceMeta, reason: string, minSample?: number | null, minSampleScope?: string | null): SignalRecordSource {
  const m = gateFor(meta.kind, minSample);
  return {
    id: meta.id, name: meta.name, kind: meta.kind, basis: meta.basis,
    state: "unavailable",
    reason: reason && reason.trim() ? reason.trim() : "the store could not be read",
    n: { emitted: null, graded: null, open: null, excluded: null },
    winShare: null, winLo: null, winHi: null, winLabel: "wins", winN: null, winScope: null,
    meanNet: null, meanNetUnit: null, meanNetScale: null,
    minSample: m.minSample, minSampleFrom: m.from, minSampleScope: minSampleScope ?? null,
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
  if (s.kind !== "win_loss") return s.reason ?? kindText(s.kind);
  if (s.state === "insufficient") return s.reason ?? insufficientText(s.n.graded ?? 0, s.minSample);
  if (s.winShare == null || s.winLo == null || s.winHi == null || s.winN == null) return "counts only";
  return `${pct0(s.winShare)} ${s.winLabel} (95% interval ${pct0(s.winLo)} to ${pct0(s.winHi)}, n=${s.winN}${s.winScope ? `; ${s.winScope}` : ""})`;
}

/** The gate a row is held to, in words. */
export function gateText(s: SignalRecordSource): string {
  if (s.minSampleFrom === "not_applicable") return "no minimum sample applies to this row";
  const scope = s.minSampleScope ? ` ${s.minSampleScope}` : " graded";
  return `minimum sample ${s.minSample}${scope}${s.minSampleFrom === "default" ? " (hand-set default)" : " (this source's own gate)"}`;
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
