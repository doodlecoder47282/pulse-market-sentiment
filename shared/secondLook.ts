// shared/secondLook.ts
//
// The second look: one more row per coin, written a fixed time after its first logged signal. Pure.
//
// Why. The record keeps each coin's FIRST signal, written at a median of about two and a half minutes old,
// usually under a $100k cap, before the holder, authority and Jupiter reads have landed. Read on 2026-11-17,
// no candidate rule set on those rows held up (median net -90% to -100% for every set), and the structure
// rules passed almost every row on absence: top-10 holders had nothing recorded on 3,154 of 3,154 first
// signals. The record could not say what a coin that SURVIVED its first half hour did afterwards, because it
// never wrote that state down. This does.
//
// What it is. A recording, not a verdict. The trigger is time alone (minutesAfterFirstSignal after the coin's
// first logged row), so no outcome and no score chooses which coins get one; the coin must still be tracked
// and its pair data fresh, and its cap must be read and under the ride target (at or above it there is no
// entry to measure). The row is stored in crypto_signals with verdict LOOK2 so the existing grader, peak
// sampler and horizon pass measure it from ITS OWN cap and liquidity, on the same rules as every other row.
// It never enters the expectancy sample, the first-signal counts, the signal list or the exit-plan book.
//
// The parameter is versioned here (SECOND_LOOK_VERSION), like the candidate sets: it moves no live verdict,
// score, grade or exit level, so it is not a rule-book threshold and the rule-book version does not move.

import { bandReadout, splitReadout, type BandReadout, type ReplayRow, type SplitReadout } from "./cryptoReplay";
import { CRYPTO_RULES } from "./cryptoRules";

export const SECOND_LOOK_VERSION = "second-look-2026.11.17-1";
export const SECOND_LOOK_VERDICT = "LOOK2";
export const SECOND_LOOK_PARAMS = {
  /** Written on the first fresh refresh at or after this many minutes past the coin's first logged signal. */
  minutesAfterFirstSignal: 30,
  /** Not written later than this after the first signal: a much later row is a different measurement. */
  maxMinutesAfterFirstSignal: 90,
} as const;
/** Under this many priced rows the readout shows counts only (the desk's own minimum for a graded sample). */
export const SECOND_LOOK_MIN_SAMPLE = 50;

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export type SecondLookSkip = "no_first_signal" | "already_written" | "too_early" | "too_late" | "data_unread" | "unmeasurable" | "at_or_above_target";

/**
 * Whether the second look is due. `dataAt` is when the pair data being recorded was read (never the clock):
 * the row describes the coin at that time, and the delay is measured to it.
 */
export function secondLookDue(
  a: { firstSignalAt: number | null; alreadyAt: number | null; dataAt: number | null; cap: number | null; liquidityUsd: number | null },
  targetMcap: number = CRYPTO_RULES.universe.targetMcapUsd,
  p: typeof SECOND_LOOK_PARAMS = SECOND_LOOK_PARAMS,
): { due: true; minutesAfterFirst: number } | { due: false; why: SecondLookSkip } {
  if (!fin(a.firstSignalAt)) return { due: false, why: "no_first_signal" };
  if (a.alreadyAt != null) return { due: false, why: "already_written" };
  if (!fin(a.dataAt)) return { due: false, why: "data_unread" };
  const minutes = (a.dataAt - a.firstSignalAt) / 60_000;
  if (minutes < p.minutesAfterFirstSignal) return { due: false, why: "too_early" };
  if (minutes > p.maxMinutesAfterFirstSignal) return { due: false, why: "too_late" };
  // An entry cannot be measured from a missing or zero cap, or priced without a pool: the grader would read
  // any later sample as a multiple of nothing. The engine counts coins whose window passes this way.
  if (!fin(a.cap) || a.cap <= 0 || !fin(a.liquidityUsd) || a.liquidityUsd <= 0) return { due: false, why: "unmeasurable" };
  if (a.cap >= targetMcap) return { due: false, why: "at_or_above_target" };
  return { due: true, minutesAfterFirst: Math.round(minutes * 10) / 10 };
}

/** What the look row stores about itself, beside the usual signal features. */
export interface SecondLookMeta {
  version: string;
  minutesAfterFirst: number;
  /** The desk's verdict on the coin at the look (ENTER / WATCH / PASS); the row's own verdict column is LOOK2. */
  verdictAtLook: string | null;
  verdictCodeAtLook: string | null;
  /** A hard kill stood at the look (drained pool, active authority, honeypot pattern ...). */
  hardKill: boolean;
  /** The pair had left the pump.fun bonding curve (any DEX id other than "pump-fun"). */
  leftCurve: boolean;
  dexId: string | null;
  /** Cap and liquidity of the coin's first logged signal, for the multiple since. */
  firstCap: number | null;
  firstLiquidity: number | null;
}

export interface LookRow extends ReplayRow {
  look: SecondLookMeta | null;
}

export interface ReadCoverage {
  /** Rows compared: looks whose coin's first signal is in the record. */
  of: number;
  top10: { first: number; look: number };
  authorities: { first: number; look: number };
  jupiterChecked: { first: number; look: number };
}

export interface SecondLookReadout {
  version: string;
  minutesAfterFirstSignal: number;
  written: number;
  open: number;
  graded: number;
  /** Graded with an outcome (not NO_DATA). */
  priced: number;
  insufficient: boolean;
  medianMinutesAfterFirst: number | null;
  medianCapAtLook: number | null;
  /** Median of look cap over the same coin's first-signal cap. */
  medianCapMultipleSinceFirst: number | null;
  /** Looks written with a hard kill standing. */
  hardKilledAtLook: number;
  /** Tracked coins whose window passed without a row (attached by the server; null when not counted). */
  windowPassedNoRow: number | null;
  coverage: ReadCoverage;
  /** Every graded look, measured from the look's own cap and liquidity. */
  all: SplitReadout;
  /** Graded looks with no hard kill standing at the look (a state read at the look, not an outcome). */
  notKilled: SplitReadout;
  /** Graded looks whose pair had left the bonding curve. */
  leftCurve: SplitReadout;
  /** The same coins' FIRST signals, for comparison (graded ones only). */
  sameCoinsFirstSignal: SplitReadout;
  bands: BandReadout[];
  caveats: string[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const isGraded = (r: ReplayRow) => !!r.outcome && r.outcome !== "OPEN";
const JUP_CHECKED = new Set(["agree", "watch", "diverge", "no-reliable-price"]);
const top10Read = (r: ReplayRow) => fin(r.features.top10Pct);
const authRead = (r: ReplayRow) => typeof r.features.mintAuthorityActive === "boolean" && typeof r.features.freezeAuthorityActive === "boolean";
const jupRead = (r: ReplayRow) => JUP_CHECKED.has(String(r.features.gates?.jupState ?? ""));

/**
 * The second looks read against the same coins' first signals.
 * `looks`: LOOK2 rows. `firsts`: the first signal per coin (shared/cryptoReplay.ts firstPerCoin) over the other rows.
 */
export function secondLookReadout(looks: LookRow[], firsts: ReplayRow[], targetMcap: number = CRYPTO_RULES.universe.targetMcapUsd): SecondLookReadout {
  const sorted = [...looks].sort((a, b) => a.detectedAt - b.detectedAt || a.id.localeCompare(b.id));
  const firstOf = new Map(firsts.map((r) => [r.coinKey, r]));
  const g = sorted.filter(isGraded);
  const paired = sorted.filter((r) => firstOf.has(r.coinKey));
  const pairedFirsts = paired.map((r) => firstOf.get(r.coinKey)!);
  const count = (rows: ReplayRow[], f: (r: ReplayRow) => boolean) => rows.filter(f).length;
  const multiples = paired
    .map((r) => { const f = firstOf.get(r.coinKey)!; return fin(r.mcapAtSignal) && fin(f.mcapAtSignal) && f.mcapAtSignal > 0 ? r.mcapAtSignal / f.mcapAtSignal : null; })
    .filter(fin);
  const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
  const priced = g.filter((r) => r.outcome !== "NO_DATA").length;
  const gradedCoins = new Set(g.map((r) => r.coinKey));
  return {
    version: SECOND_LOOK_VERSION,
    minutesAfterFirstSignal: SECOND_LOOK_PARAMS.minutesAfterFirstSignal,
    written: sorted.length,
    open: sorted.length - g.length,
    graded: g.length,
    priced,
    insufficient: priced < SECOND_LOOK_MIN_SAMPLE,
    medianMinutesAfterFirst: r2(median(sorted.map((r) => r.look?.minutesAfterFirst).filter(fin))),
    medianCapAtLook: (() => { const m = median(sorted.map((r) => r.mcapAtSignal).filter(fin)); return m == null ? null : Math.round(m); })(),
    medianCapMultipleSinceFirst: r2(median(multiples)),
    hardKilledAtLook: count(sorted, (r) => r.look?.hardKill === true),
    windowPassedNoRow: null,
    coverage: {
      of: paired.length,
      top10: { first: count(pairedFirsts, top10Read), look: count(paired, top10Read) },
      authorities: { first: count(pairedFirsts, authRead), look: count(paired, authRead) },
      jupiterChecked: { first: count(pairedFirsts, jupRead), look: count(paired, jupRead) },
    },
    all: splitReadout("every second look", g, targetMcap),
    // A row with no stored meta is not counted as "not killed" or "left the curve": the state was not recorded.
    notKilled: splitReadout("no hard kill at the look", g.filter((r) => r.look?.hardKill === false), targetMcap),
    leftCurve: splitReadout("off the bonding curve at the look", g.filter((r) => r.look?.leftCurve === true), targetMcap),
    sameCoinsFirstSignal: splitReadout("the same coins, from their first signal", firsts.filter((r) => gradedCoins.has(r.coinKey) && isGraded(r)).sort((a, b) => a.detectedAt - b.detectedAt), targetMcap),
    bands: bandReadout(g, targetMcap),
    caveats: [
      `One row per coin, written on the first fresh refresh between ${SECOND_LOOK_PARAMS.minutesAfterFirstSignal} and ${SECOND_LOOK_PARAMS.maxMinutesAfterFirstSignal} minutes after its first logged signal, whatever the coin had done by then. Time is the only trigger; no score or outcome selects the row.`,
      "Only coins the desk was still tracking get one. The tracked list is capped and drops the lowest-scored names first, so the second looks lean toward coins that still scored: this is a record of survivors of the desk's own list, not of every launch.",
      "Each row is measured from its own cap and liquidity at the look, by the same grader as every other row: a win is a sampled touch of the target or of 2x from the look, and net figures sell when the row was graded, net of pool fees and impact.",
      "A coin with a hard kill standing at the look is still written (the count says how many), and the 'no hard kill' line leaves those out using only what was read at the look. A coin whose cap or pool read missing or zero through the whole window gets no row, because nothing can be measured from it; those are counted, with coins whose data went stale or whose window fell while the desk was not running, as pool windows passed without a row (a count of pools, so a coin with two tracked pools can count twice). They are mostly dead pools, so the rows that exist understate how many coins had collapsed.",
      "The first-signal line covers the same coins from their earlier, lower entry, so the two lines are two entries into the same coins, not two independent samples.",
      "Rows detected before this recording began do not exist: the second-look record starts at its first row and nothing is back-filled.",
      `Under ${SECOND_LOOK_MIN_SAMPLE} priced rows the readout shows counts only. A second look is a recording, never a verdict, and none of this is a claim of edge.`,
    ],
  };
}
