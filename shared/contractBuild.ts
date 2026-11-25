// How one option contract's volume built through the session, in five-minute steps.
//
// The owner's question about an alert ("48,000 contracts versus 623 open interest: was that all hit?")
// has no answer from a day total. This turns the chain's running day volume per contract, read poll after
// poll, into volume per five-minute step, and describes the shape in plain words.
//
// Limits, stated wherever the build is shown: it comes from the terminal's own chain reads, so a step is
// only as fine as the gap between two reads; volume traded before the first read of the day is one lump
// ("before the first read"); and a chain total cannot say which trades were buys.

export const STEP_MS = 5 * 60_000;
/** A contract is kept once its day volume reaches this (below the alert rule, so the lead-up is kept too). */
export const KEEP_MIN_VOLUME = 250;
/** The alert rule, per contract: day volume at least this many times its own open interest... */
export const UNUSUAL_OI_MULTIPLE = 3;
/** ...and at least this many contracts. */
export const UNUSUAL_MIN_VOLUME = 500;

export interface ContractRead {
  /** OCC symbol: one contract (root, expiry, side, strike). */
  occ: string;
  side: "C" | "P";
  expiry: string;
  strike: number;
  /** Running day volume from the chain; null when the chain omitted it. */
  volume: number | null;
  openInterest: number | null;
  last: number | null;
}

export interface StepDelta {
  occ: string; side: "C" | "P"; expiry: string; strike: number;
  /** Start of the five-minute step, epoch ms. */
  step: number;
  /** Contracts traded between the previous read and this one (0 for a baseline). */
  volume: number;
  /** Running day volume at this read. */
  cum: number;
  /** Volume already on the tape when the contract was first read today: its timing is unknown. */
  baseline: number;
  openInterest: number | null;
  last: number | null;
}

/** The start of the five-minute step an instant falls in. */
export function stepStart(ms: number): number {
  return Math.floor(ms / STEP_MS) * STEP_MS;
}

/**
 * One chain read against what was last seen. `seen` maps OCC symbol to the last running volume and is
 * updated in place. Returns the steps to add: only contracts at or above the keep floor, and only when the
 * running volume rose (or the contract is seen for the first time today, which stores its baseline).
 * A running volume lower than the last one seen is ignored (the caller clears `seen` at each new day).
 */
export function applyRead(seen: Map<string, number>, rows: readonly ContractRead[], asOfMs: number): StepDelta[] {
  const out: StepDelta[] = [];
  const step = stepStart(asOfMs);
  for (const r of rows) {
    if (!r.occ || r.volume == null || !Number.isFinite(r.volume) || r.volume < 0) continue;
    const prev = seen.get(r.occ);
    if (prev == null) {
      // Below the floor nothing is remembered, so the contract is first "seen" when it crosses it:
      // everything up to that read is baseline, because its timing was not recorded.
      if (r.volume < KEEP_MIN_VOLUME) continue;
      seen.set(r.occ, r.volume);
      out.push({ occ: r.occ, side: r.side, expiry: r.expiry, strike: r.strike, step, volume: 0, cum: r.volume, baseline: r.volume, openInterest: r.openInterest, last: r.last });
      continue;
    }
    // The running total only rises within a day. A lower read is another request's slightly older view of the
    // same contract (several modules read overlapping chains): it is ignored, so the dip is not counted twice.
    if (r.volume <= prev) continue;
    seen.set(r.occ, r.volume);
    out.push({ occ: r.occ, side: r.side, expiry: r.expiry, strike: r.strike, step, volume: r.volume - prev, cum: r.volume, baseline: 0, openInterest: r.openInterest, last: r.last });
  }
  return out;
}

export interface BuildStep { step: number; volume: number }

export type BuildShape = "building" | "steady" | "tailing_off" | "quiet" | "one_burst" | "too_short";

export interface BuildRead {
  /** Day volume that the steps account for (excludes the baseline). */
  timed: number;
  /** Volume already there at the first read. */
  baseline: number;
  total: number;
  firstStep: number | null;
  lastActiveStep: number | null;
  peak: BuildStep | null;
  /** Share of the timed volume that came in the single largest step, 0..1. */
  peakShare: number | null;
  shape: BuildShape;
  /** Plain-words sentence for the row. */
  line: string;
}

/**
 * Describe a contract's build. `steps` are its five-minute volumes in time order (gaps are steps with no
 * volume); `nowMs` is the time of the latest chain read; `fmt` turns a step start into a clock string.
 */
export function describeBuild(steps: readonly BuildStep[], baseline: number, nowMs: number, fmt: (ms: number) => string): BuildRead {
  const active = steps.filter((s) => s.volume > 0).sort((a, b) => a.step - b.step);
  const timed = active.reduce((n, s) => n + s.volume, 0);
  const total = timed + baseline;
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  const base = baseline > 0 ? `${n(baseline)} traded before the first read (timing not recorded). ` : "";
  if (!active.length) {
    return { timed, baseline, total, firstStep: null, lastActiveStep: null, peak: null, peakShare: null, shape: "too_short",
      line: `${base}No volume has been added since the terminal started watching this contract.` };
  }
  const first = active[0], lastActive = active[active.length - 1];
  const peak = active.reduce((m, s) => (s.volume > m.volume ? s : m), first);
  const peakShare = timed > 0 ? peak.volume / timed : null;
  const nowStep = stepStart(nowMs);
  const quietSteps = Math.max(0, Math.round((nowStep - lastActive.step) / STEP_MS));
  // The last three COMPLETED steps against the three before them, counting empty steps as zero. The step
  // still in progress is left out: a part-filled step against full ones would read as slowing every time.
  const vol = new Map(active.map((s) => [s.step, s.volume]));
  const sum = (from: number) => [0, 1, 2].reduce((a, i) => a + (vol.get(from - i * STEP_MS) ?? 0), 0);
  const lastDone = nowStep - STEP_MS;
  const recent = sum(lastDone), earlier = sum(lastDone - 3 * STEP_MS);
  let shape: BuildShape;
  if (active.length === 1) shape = quietSteps >= 3 ? "one_burst" : "too_short";
  else if (quietSteps >= 3) shape = "quiet";
  else if (recent > earlier * 1.25) shape = "building";
  else if (recent < earlier * 0.75) shape = "tailing_off";
  else shape = "steady";
  const tail =
    shape === "one_burst" ? `All of it came in one five-minute step at ${fmt(peak.step)}; nothing since.`
    : shape === "quiet" ? `Last added at ${fmt(lastActive.step)}; nothing in the ${quietSteps * 5} minutes since.`
    : shape === "building" ? `Still building: ${n(recent)} in the last three full five-minute steps against ${n(earlier)} in the three before.`
    : shape === "steady" ? `Steady: ${n(recent)} in the last three full five-minute steps against ${n(earlier)} in the three before.`
    : shape === "tailing_off" ? `Slowing: ${n(recent)} in the last three full five-minute steps against ${n(earlier)} in the three before.`
    : `Too early to call a shape.`;
  const line = `${base}${n(timed)} since ${fmt(first.step)}, biggest five minutes ${n(peak.volume)} at ${fmt(peak.step)}. ${tail}`;
  return { timed, baseline, total, firstStep: first.step, lastActiveStep: lastActive.step, peak, peakShare, shape, line };
}

/** The alert rule on one contract's own numbers. */
export function isUnusual(volume: number | null | undefined, openInterest: number | null | undefined): boolean {
  if (volume == null || openInterest == null || !(openInterest > 0)) return false;
  return volume >= UNUSUAL_MIN_VOLUME && volume >= UNUSUAL_OI_MULTIPLE * openInterest;
}

/** A same-day contract is flagged only for a burst: one five-minute step this many times its usual step... */
export const BURST_MULTIPLE = 5;
/** ...and at least this many contracts. */
export const BURST_MIN_VOLUME = 1000;

export interface Burst { step: number; volume: number; usual: number; multiple: number }

/**
 * Volume against open interest says nothing for a contract that expires today: nearly every active one trades
 * many times its open interest (seen live 2026-11-25: 40 of 40 listed rows were same-day contracts near the
 * price). What stands out on such a contract is a burst: one five-minute step far above its own usual step.
 * "Usual" is the median of its other steps with volume; at least three other steps are needed to say so.
 */
export function burstOf(steps: readonly BuildStep[]): Burst | null {
  const active = steps.filter((s) => s.volume > 0);
  if (active.length < 4) return null;
  const peak = active.reduce((m, s) => (s.volume > m.volume ? s : m), active[0]);
  const rest = active.filter((s) => s !== peak).map((s) => s.volume).sort((a, b) => a - b);
  const mid = rest.length >> 1;
  const usual = rest.length % 2 ? rest[mid] : (rest[mid - 1] + rest[mid]) / 2;
  if (!(usual > 0) || peak.volume < BURST_MIN_VOLUME || peak.volume < BURST_MULTIPLE * usual) return null;
  return { step: peak.step, volume: peak.volume, usual, multiple: peak.volume / usual };
}
