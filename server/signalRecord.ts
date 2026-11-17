// server/signalRecord.ts
//
// GET /api/record/signals: one read-only record of what each signal source
// has logged and graded, and on what basis (docs/PRO_REVIEW_2026-11-17.md,
// options "missing" item 1).
//
// This module grades nothing. Every figure comes from the source's existing
// summary function; where a source has none, only counts are read from its
// store. The gate rules (insufficient / unavailable, nulls under the gate) are
// in shared/signalRecord.ts. The Wilson interval is the repo's existing helper
// (validationMath.wilsonInterval), passed in.
//
// Sources and the function each one is read through:
//   whale_follow        whaleFollowThrough.getPerformanceSnapshot / getFollowSnapshot
//   whale_alert_expiry  edgeStats.computeEdgeStats().whaleAlerts
//   tracked_signals     signalTracker.getAllTracked (no summary function: counts only)
//   odte_t1             gradeCalibration.getCalibrationReport
//   odte_option_ledger  odteGrader.getOptionLedgerSummary
//   regime_calls        edgeStats.computeEdgeStats().regimeCalls
//   scenario_odds       calibration.rollingBrier
//   wiener_odds         odteMapLedger.ledgerSummary().wienerScorecard
//   mm_matrix           mmPredictions.empiricalStats
//   crypto_desk         cryptoEngine.getCryptoSignals (stats.enterCoins + expectancy.graded)
//
// Several of those summary functions swallow a store error and return an empty
// result. An empty result must not read as "0 logged", so each SQLite / file
// backed source is preceded by a count query on its store: if that throws, the
// source is "unavailable" with the reason.
//
// The adapters below take their inputs through `SignalRecordDeps`, so they are
// unit-tested without a database; `loadDeps` wires the real modules.

import type { PerformanceSnapshot, FollowSnapshot } from "./whaleFollowThrough";
import type { TrackedSignal } from "./signalTracker";
import type { CalibrationReport } from "./gradeCalibration";
import type { OptionLedgerBucketReport } from "./odteGrader";
import type { EdgeStats } from "./edgeStats";
import type { WienerScorecard } from "../shared/odteWiener";
import type { ExpectancySummary } from "../shared/cryptoExpectancy";
import {
  buildSource, unavailableSource, makeSignalRecord, winsFromRate, remainder,
  type SignalRecord, type SignalRecordSource, type SourceMeta, type WilsonFn,
} from "../shared/signalRecord";

/** Whale follow-through keeps terminal positions for 90 days; the performance rollup accepts at most a 90-day window. */
export const WHALE_FOLLOW_WINDOW_DAYS = 90;
/** The longest window /api/edge/stats accepts. */
export const EDGE_STATS_WINDOW_DAYS = 730;
/** The window the existing calibration card scores over (calibration.CALIBRATION_CARD_DAYS). */
export const SCENARIO_WINDOW_DAYS = 30;
export const WIENER_SYMBOL = "$SPX";
const CACHE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface OdteAuditCounts { fired: number; open: number; rejected: number; firstAt: number | null }
export interface ScenarioCounts { predictionDays: number; settledDays: number }
export interface MapDayCounts { mapped: number; settled: number }
export interface CryptoRead {
  enterCoins: { total: number; open: number; graded: number; noData: number };
  graded: ExpectancySummary;
  basis: string;
  currentVersion: string;
}
export interface RollingBrierLike {
  n: number; total: number; trivialTotal: number;
  topPickHits: number; topPickN: number; gated: boolean; minDays: number;
  /** Which odds the graded rows carried (prob_source); "unrecorded" for rows before the column. */
  probSourceMix?: Record<string, number>;
}

export interface SignalRecordDeps {
  now: () => number;
  wilson: WilsonFn;
  /** Each source's own gate, so a row states it even when its store cannot be read. */
  mins: { odteCalibrationTotal: number; odteLedgerPerBucket: number; scenarioDays: number; wienerDays: number; cryptoGraded: number };
  /** Rows in whale_follows. Throws when the table cannot be read. */
  whaleFollowStoreRows: () => number;
  whalePerformance: (windowDays: number) => PerformanceSnapshot;
  whaleFollowSnapshot: () => FollowSnapshot;
  trackedSignals: () => TrackedSignal[];
  odteAuditCounts: () => OdteAuditCounts;
  odteCalibration: () => CalibrationReport;
  odteIndexFee: () => number | null;
  odteLedger: (feePerContract: number) => OptionLedgerBucketReport[];
  predictionOutcomeRows: () => number;
  edgeStats: (windowDays: number) => EdgeStats;
  scenarioCounts: () => ScenarioCounts;
  scenarioBrier: (days: number) => RollingBrierLike | null;
  mapDayCounts: (symbol: string) => MapDayCounts;
  wienerScorecard: (symbol: string) => WienerScorecard;
  /** "absent" = the log file does not exist yet (nothing logged). Throws when it exists but cannot be read. */
  mmLogProbe: () => Promise<"present" | "absent">;
  mmStats: () => Promise<{ total: number; graded: number }>;
  crypto: () => CryptoRead;
}

// ── Source descriptions (what each source's own code does; nothing is set here) ──

export const SOURCE_META: Record<string, SourceMeta> = {
  whale_follow: {
    id: "whale_follow", name: "Whale flow follow-through", kind: "win_loss",
    basis: {
      entry: "bought at the ask logged at detection",
      exit: "sold at the bid logged at the terminal moment (CLOSED: premium gone to about zero; EXPIRED: last quote at or before the expiry close). Win = positive P&L after fees",
      costs: "fee per contract per side ($0.65 equity/ETF; index roots only with a configured all-in fee, otherwise excluded and counted)",
    },
  },
  whale_alert_expiry: {
    id: "whale_alert_expiry", name: "Whale alerts held to expiry", kind: "win_loss",
    basis: {
      entry: "bought at the ask logged at the alert",
      exit: "sold at the bid logged at the session close of the expiry date (quote at most 20 minutes old). Win = return of +30% or more on the premium",
      costs: "no fees applied (fees are account-specific and not in this grade)",
    },
  },
  tracked_signals: {
    id: "tracked_signals", name: "Tracked signals (flow alerts, UOA, manual)", kind: "counts_only",
    basis: {
      entry: "the mark captured when the signal was tracked",
      exit: "the live mark at the manual close or at expiry (mid to mid)",
      costs: "no fees, no spread: a mid to mid result overstates a tradable one by the round-trip spread",
    },
  },
  odte_t1: {
    id: "odte_t1", name: "0DTE alerts: T1 before stop (underlying)", kind: "win_loss",
    basis: {
      entry: "the underlying price when the alert fired",
      exit: "first touch on minute bars. Win = the underlying reached T1 before the plan's stop",
      costs: "none: graded on the underlying, not on an option",
    },
  },
  odte_option_ledger: {
    id: "odte_option_ledger", name: "0DTE alerts: option P&L of the published plan", kind: "win_loss",
    basis: {
      entry: "option bought at the logged ask",
      exit: "replay of the published plan on logged marks, sold at the bid (5-minute close stop or -20% on the bid; half at T1, runner to T2; settlement at intrinsic). Win = return above zero",
      costs: "set per request below",
    },
  },
  regime_calls: {
    id: "regime_calls", name: "Regime calls", kind: "win_loss",
    basis: {
      entry: "the call logged when the predictor's confidence was 0.30 or more",
      exit: "the realised $SPX path over the called horizon. Win = the path matched the called regime under the stored proxy (a proxy for the regime, not the regime itself); one call per ET session",
      costs: "none: a classification, not a trade",
    },
  },
  scenario_odds: {
    id: "scenario_odds", name: "Scenario odds (bull / base / bear)", kind: "win_loss",
    basis: {
      entry: "the first odds recorded on the trade date",
      exit: "settled at the session close. Win = the scenario given the highest odds was the one that occurred",
      costs: "none: a forecast, not a trade",
    },
  },
  wiener_odds: {
    id: "wiener_odds", name: "0DTE morning odds (Wiener scorecard)", kind: "calibration",
    basis: {
      entry: "the morning map taken at 09:35 ET (or the first one after the open)",
      exit: "settled on the last regular-session print: each level's stated touch and close-above odds against what happened",
      costs: "none: stated odds, not a trade",
    },
  },
  mm_matrix: {
    id: "mm_matrix", name: "MM matrix predictions", kind: "calibration",
    basis: {
      entry: "the (regime, zone) snapshot with its stated up / down / pin odds",
      exit: "the forward move to the close: up or down at 0.15% or more, otherwise pin; observed frequencies per cell against the stated odds",
      costs: "none: stated odds, not a trade",
    },
  },
  crypto_desk: {
    id: "crypto_desk", name: "Crypto desk: first ENTER per coin", kind: "win_loss",
    basis: {
      entry: "bought at the signal, at the pool liquidity recorded then",
      exit: "sold when the row was graded (target hit as a limit sell, rug at the depth seen at detection, otherwise at the horizon). Win = net return above zero",
      costs: "pool fees and price impact on both legs",
    },
  },
};

const msg = (e: unknown): string => {
  const m = (e as any)?.message ?? String(e);
  return String(m).slice(0, 200);
};

// ── Adapters: map an existing summary to the record's shape (no new arithmetic) ──
// Counts: emitted = graded + open + excluded on every row. "excluded" is what
// was logged and is neither graded on the source's basis nor still open; the
// notes say what it holds. Where the parts exceed the whole the unknown part
// is null (shared remainder / buildSource), never forced to 0.

export function whaleFollowSource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.whale_follow;
  const perf = d.whalePerformance(WHALE_FOLLOW_WINDOW_DAYS);
  const snap = d.whaleFollowSnapshot();
  const o = perf.overall;
  const open = snap.byStatus.OPEN + snap.byStatus.TRIMMING + snap.byStatus.CLOSING;
  const terminal = snap.byStatus.CLOSED + snap.byStatus.EXPIRED;
  const inMemory = open + terminal;
  // The scoreboard is computed from the positions held in memory (500 at most,
  // hydrated from whale_follows at boot). The store's row count is the better
  // "emitted" when it can be read: a failed hydration must not read as 0.
  let storeRows: number | null = null;
  let storeError: string | null = null;
  try { storeRows = d.whaleFollowStoreRows(); } catch (e) { storeError = msg(e); }
  if (storeRows == null && inMemory === 0) {
    throw new Error(`whale_follows could not be read and no positions are held in memory: ${storeError}`);
  }
  const notes = [
    `window: terminal positions of the last ${WHALE_FOLLOW_WINDOW_DAYS} days`,
    `excluded holds every position that is neither scored nor open: ${o.excludedNoQuote} without a logged entry ask or exit bid, ${o.excludedNoFee} index-root positions without a configured fee, and terminal positions without a closing print or outside the window`,
    "the same detections are also graded at expiry in the next row, under a different exit rule: the two rows are not additive",
  ];
  let emitted = inMemory;
  if (storeRows == null) {
    notes.push(`emitted counts the positions held in memory: the whale_follows table could not be read (${storeError})`);
  } else if (storeRows >= inMemory) {
    emitted = storeRows;
    if (storeRows !== inMemory) notes.push(`the store holds ${storeRows} positions and ${inMemory} are held in memory; the ${storeRows - inMemory} not in memory (not loaded, or dropped at the 500-position cap or after 90 days) are counted as excluded: the scoreboard cannot score them`);
  } else {
    notes.push(`emitted counts the ${inMemory} positions held in memory: the store holds fewer rows (${storeRows})`);
  }
  return buildSource({
    ...meta,
    n: { emitted, graded: o.count, open, excluded: remainder(emitted, o.count, open) },
    wins: o.wins,
    meanNet: o.avgPct, meanNetUnit: "mean return on cash paid, after fees", meanNetScale: "fraction",
    minSample: null,
    since: d.now() - WHALE_FOLLOW_WINDOW_DAYS * DAY_MS,
    notes,
  }, d.wilson);
}

export function whaleAlertExpirySource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.whale_alert_expiry;
  d.predictionOutcomeRows();
  const s = d.edgeStats(EDGE_STATS_WINDOW_DAYS);
  const w = s.whaleAlerts;
  // The summary's `total` leaves out rows graded under the earlier proxy
  // method; they were emitted, so they are added back and sit in excluded.
  const emitted = w.total + w.legacyProxyExcluded;
  return buildSource({
    ...meta,
    n: { emitted, graded: w.graded, open: w.pending, excluded: remainder(emitted, w.graded, w.pending) },
    wins: winsFromRate(w.hit30Rate, w.graded),
    meanNet: w.avgPctReturn, meanNetUnit: "mean return on the premium, before fees", meanNetScale: "fraction",
    minSample: null,
    since: s.windowFrom,
    notes: [
      `window: alerts captured in the last ${s.windowDays} days`,
      `excluded: ${w.ungradedNoMark} resolved without a usable logged mark (never counted as misses), ${w.legacyProxyExcluded} graded under the earlier proxy method`,
    ],
  }, d.wilson);
}

export function trackedSignalsSource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.tracked_signals;
  const all = d.trackedSignals();
  const open = all.filter((s) => s.status === "OPEN").length;
  const bySource: Record<string, number> = {};
  for (const s of all) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  const first = all.reduce<number | null>((m, s) => (Number.isFinite(s.entry?.at) && (m == null || s.entry.at < m) ? s.entry.at : m), null);
  return buildSource({
    ...meta,
    n: { emitted: all.length, graded: all.length - open, open, excluded: 0 },
    wins: null,
    minSample: null,
    since: first,
    notes: [
      "held in memory only: the counts restart with the server",
      "graded here means closed or expired; the Tracked Signals panel shows each row mid to mid",
      `by origin: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "none tracked"}`,
    ],
  }, d.wilson);
}

export function odteT1Source(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.odte_t1;
  const c = d.odteAuditCounts();
  const r = d.odteCalibration();
  const graded = r.buckets.reduce((s, b) => s + b.n, 0);
  const wins = r.buckets.reduce((s, b) => s + b.wins, 0);
  return buildSource({
    ...meta,
    n: { emitted: c.fired, graded, open: c.open, excluded: remainder(c.fired, graded, c.open) },
    wins,
    minSample: d.mins.odteCalibrationTotal,
    minSampleScope: "graded fires in total",
    since: c.firstAt,
    notes: [
      "graded = fired alerts with a T1-or-stop result inside the grade buckets 72 to 100; per-bucket rates are on the grade calibration card",
      "excluded = fired alerts that were processed without a T1-or-stop result, or scored outside the grade buckets",
      `rejected setups are graded as a counterfactual and are not in this row (${r.rejectedCounterfactual.n} graded, ${c.rejected} logged)`,
      `minimum sample: the ${d.mins.odteCalibrationTotal} graded fires in total the sizer requires before it uses the fitted curve (the calibration report's own total gate)`,
    ],
  }, d.wilson);
}

export function odteOptionLedgerSource(d: SignalRecordDeps): SignalRecordSource {
  const c = d.odteAuditCounts();
  const fee = d.odteIndexFee();
  const buckets = d.odteLedger(fee ?? 0);
  const meta: SourceMeta = {
    ...SOURCE_META.odte_option_ledger,
    basis: {
      ...SOURCE_META.odte_option_ledger.basis,
      costs: fee != null
        ? `net of the configured index fee of $${fee.toFixed(2)} per contract per side`
        : "before fees: no index option fee is configured, so none is deducted",
    },
  };
  const graded = buckets.reduce((s, b) => s + b.n, 0);
  const min = buckets[0]?.minFiresForLedgerBacked ?? d.mins.odteLedgerPerBucket;
  // The ledger's gate is PER GRADE BUCKET and it computes a win rate per
  // bucket only; it never states one across buckets. So the row is held to
  // the largest bucket, and a win share is shown only for a bucket the ledger
  // itself reports as ledger-backed, named as that bucket.
  const largest = buckets.reduce<OptionLedgerBucketReport | null>((m, b) => (m == null || b.n > m.n ? b : m), null);
  const backed = buckets.filter((b) => b.labelStatus === "ledger_backed").map((b) => b.label);
  return buildSource({
    ...meta,
    n: { emitted: c.fired, graded, open: c.open, excluded: remainder(c.fired, graded, c.open) },
    wins: largest ? largest.wins : null,
    winN: largest ? largest.n : null,
    winScope: largest ? `grade bucket ${largest.label} only, the ledger's largest; the ledger states no figure across buckets` : null,
    gateCount: largest ? largest.n : 0,
    gateLabel: largest && largest.n > 0 ? `in one grade bucket (largest: ${largest.label}); the gate is per bucket, not on the ${graded} graded in total` : "in one grade bucket; the gate is per bucket",
    minSample: min,
    minSampleScope: "option-graded fires per grade bucket",
    since: c.firstAt,
    notes: [
      "graded = option-graded fires over all grade buckets; the win share, when shown, is one bucket's, as the ledger computes it",
      `grade buckets at the ledger's gate: ${backed.length ? backed.join(", ") : "none"}; per-bucket figures are on the grade calibration card`,
      "excluded = fired alerts without logged option marks (ungraded, never estimated) or outside the grade buckets",
      "the ledger reports mean winner and mean loser per grade bucket, not one mean for the source, so no mean is shown here",
      `minimum sample: the ${min} option-graded fires a grade bucket needs before the ledger is used as a point estimate (per bucket)`,
    ],
  }, d.wilson);
}

export function regimeCallsSource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.regime_calls;
  d.predictionOutcomeRows();
  const s = d.edgeStats(EDGE_STATS_WINDOW_DAYS);
  const r = s.regimeCalls;
  const cal = r.calibration ?? [];
  const sessions = r.calibrationSessions ?? cal.reduce((a, b) => a + b.n, 0);
  const haveHits = cal.every((b) => b.n === 0 || typeof b.hits === "number");
  const wins = haveHits ? cal.reduce((a, b) => a + (b.hits ?? 0), 0) : null;
  const legacy = r.legacyProxyGraded ?? 0;
  const repeats = Math.max(0, r.graded - sessions);
  return buildSource({
    ...meta,
    n: { emitted: r.total, graded: sessions, open: r.pending, excluded: remainder(r.total, sessions, r.pending) },
    wins,
    minSample: null,
    since: s.windowFrom,
    notes: [
      `window: calls captured in the last ${s.windowDays} days`,
      `graded = independent sessions (the first graded call of each ET session): calls logged minutes apart share one outcome`,
      `excluded: ${repeats} repeat calls inside an already-counted session, ${legacy} calls graded under the earlier close-to-close proxy, and any processed call without a result`,
      r.calibrationEvent ? `graded event: ${r.calibrationEvent}` : "graded event: regime-match proxy on the called horizon",
    ],
  }, d.wilson);
}

/** "risk-neutral-implied 12, hand-set-heuristic 18". */
function mixLine(mix: Record<string, number> | undefined): string | null {
  const e = Object.entries(mix ?? {}).filter(([, v]) => v > 0);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join(", ") : null;
}

export function scenarioOddsSource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.scenario_odds;
  const c = d.scenarioCounts();
  const r = d.scenarioBrier(SCENARIO_WINDOW_DAYS);
  const graded = r?.topPickN ?? 0;
  const min = r?.minDays ?? d.mins.scenarioDays;
  const ready = r != null && !r.gated;
  const open = Math.max(0, c.predictionDays - c.settledDays);
  const notes = [
    `graded = the latest ${SCENARIO_WINDOW_DAYS} settled days that have a recorded morning forecast (the window the calibration card scores)`,
    "excluded = settled days outside that window or without a recorded forecast",
  ];
  const mix = mixLine(r?.probSourceMix);
  if (mix) {
    const forecasters = Object.keys(r?.probSourceMix ?? {}).filter((k) => k !== "unrecorded").length;
    notes.push(`odds recorded as: ${mix}${forecasters > 1 ? " (two forecasters are pooled in this row, as in the source's own score)" : ""}`);
  } else if (r) {
    notes.push("the source did not report which odds the graded days carried");
  }
  if (ready && r && graded >= min) {
    notes.push(`Brier score over the window ${r.total.toFixed(3)} against ${r.trivialTotal.toFixed(3)} for always stating the base rate (lower is closer; the base rate is fitted on the same days)`);
  }
  return buildSource({
    ...meta,
    n: { emitted: c.predictionDays, graded, open, excluded: remainder(c.predictionDays, graded, open) },
    wins: r ? r.topPickHits : null,
    winLabel: "top-pick hits",
    minSample: min,
    minSampleScope: "settled days",
    sourceGate: r ? { ready: !r.gated, reason: `${r.n} of ${min} settled days needed` } : null,
    since: null,
    notes,
  }, d.wilson);
}

export function wienerOddsSource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.wiener_odds;
  const c = d.mapDayCounts(WIENER_SYMBOL);
  const sc = d.wienerScorecard(WIENER_SYMBOL);
  const notes = [`symbol ${WIENER_SYMBOL}; graded = settled days with scored levels; excluded = settled days without scored levels`];
  if (sc.tested) {
    const line = (label: string, x: WienerScorecard["touch"]) =>
      x.brier != null && x.brierBaseRate != null
        ? `${label}: Brier ${x.brier} against ${x.brierBaseRate} for always stating the observed rate, over ${x.n} levels`
        : `${label}: no scored levels`;
    notes.push(line("touch odds", sc.touch), line("close-above odds", sc.close));
  }
  const open = Math.max(0, c.mapped - c.settled);
  return buildSource({
    ...meta,
    n: { emitted: c.mapped, graded: sc.days, open, excluded: remainder(c.mapped, sc.days, open) },
    wins: null,
    minSample: sc.minDays,
    minSampleScope: "scored days",
    since: null,
    notes,
  }, d.wilson);
}

export async function mmMatrixSource(d: SignalRecordDeps): Promise<SignalRecordSource> {
  const meta = SOURCE_META.mm_matrix;
  const probe = await d.mmLogProbe();
  const s = await d.mmStats();
  const open = remainder(s.total, s.graded, 0);
  return buildSource({
    ...meta,
    n: { emitted: s.total, graded: s.graded, open, excluded: open == null ? null : 0 },
    wins: null,
    minSample: null,
    since: null,
    notes: [
      probe === "absent" ? "the prediction log file does not exist yet: nothing has been logged" : "per-cell observed frequencies against the stated odds are in the MM matrix stats",
      "the master alpha composite is logged on the same snapshots and is not a separate row",
      ...(open == null ? [`the log holds more outcome rows (${s.graded}) than snapshots (${s.total}): open and excluded are unknown`] : []),
    ],
  }, d.wilson);
}

export function cryptoDeskSource(d: SignalRecordDeps): SignalRecordSource {
  const meta = SOURCE_META.crypto_desk;
  const c = d.crypto();
  const g = c.graded;
  const blocked = g.validation === "INSUFFICIENT DATA";
  return buildSource({
    ...meta,
    n: { emitted: c.enterCoins.total, graded: g.n, open: c.enterCoins.open, excluded: remainder(c.enterCoins.total, g.n, c.enterCoins.open) },
    wins: g.positiveShare.yes,
    meanNet: g.meanNetPct, meanNetUnit: `mean net return on a $${g.sizeUsd} position`, meanNetScale: "percent",
    minSample: g.minSample,
    sourceGate: { ready: !blocked, reason: g.validationReason },
    since: null,
    notes: [
      `rule book ${c.currentVersion}; one row per coin (its first ENTER), all logged signals`,
      `excluded = resolved coins whose return could not be computed (the summary skipped ${g.skipped}; ${g.noData} could not be priced past the horizon: likely rugs, outside the denominator)`,
      "market-cap multiples stand in for price multiples, which overstates a move when supply grew",
    ],
  }, d.wilson);
}

type Adapter = (d: SignalRecordDeps) => SignalRecordSource | Promise<SignalRecordSource>;
type OwnGate = (d: SignalRecordDeps) => { minSample: number; scope: string };

/** Row order of the record. Each source stands alone: nothing below combines two of them. `gate` = the source's own minimum, stated even when its store cannot be read. */
export const SOURCE_ADAPTERS: Array<{ id: string; build: Adapter; gate?: OwnGate }> = [
  { id: "whale_follow", build: whaleFollowSource },
  { id: "whale_alert_expiry", build: whaleAlertExpirySource },
  { id: "tracked_signals", build: trackedSignalsSource },
  { id: "odte_t1", build: odteT1Source, gate: (d) => ({ minSample: d.mins.odteCalibrationTotal, scope: "graded fires in total" }) },
  { id: "odte_option_ledger", build: odteOptionLedgerSource, gate: (d) => ({ minSample: d.mins.odteLedgerPerBucket, scope: "option-graded fires per grade bucket" }) },
  { id: "regime_calls", build: regimeCallsSource },
  { id: "scenario_odds", build: scenarioOddsSource, gate: (d) => ({ minSample: d.mins.scenarioDays, scope: "settled days" }) },
  { id: "wiener_odds", build: wienerOddsSource, gate: (d) => ({ minSample: d.mins.wienerDays, scope: "scored days" }) },
  { id: "mm_matrix", build: mmMatrixSource },
  { id: "crypto_desk", build: cryptoDeskSource, gate: (d) => ({ minSample: d.mins.cryptoGraded, scope: "graded" }) },
];

/** One call per assembly for a summary two rows read (a result or its error is reused). */
function once<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  let done = false, value: R | undefined, error: unknown;
  return (...a: A): R => {
    if (!done) {
      done = true;
      try { value = fn(...a); } catch (e) { error = e ?? new Error("failed"); }
    }
    if (error !== undefined) throw error;
    return value as R;
  };
}

/** Assemble the record. A source that throws is "unavailable" with the reason; the others are unaffected. */
export async function assembleSignalRecord(deps: SignalRecordDeps): Promise<SignalRecord> {
  // Whale alerts and regime calls read the same edge stats (one fixed window): compute them once.
  const d: SignalRecordDeps = { ...deps, edgeStats: once(deps.edgeStats), predictionOutcomeRows: once(deps.predictionOutcomeRows) };
  const sources: SignalRecordSource[] = [];
  for (const a of SOURCE_ADAPTERS) {
    try {
      sources.push(await a.build(d));
    } catch (e) {
      const g = a.gate ? a.gate(d) : null;
      sources.push(unavailableSource(SOURCE_META[a.id], `could not be read: ${msg(e)}`, g?.minSample ?? null, g?.scope ?? null));
    }
  }
  return makeSignalRecord(sources, d.now());
}

// ── Real wiring ─────────────────────────────────────────────────────────────

export async function loadDeps(): Promise<SignalRecordDeps> {
  const { sqlite } = await import("./storage");
  const { wilsonInterval, MIN_FIRES_FOR_POINT_ESTIMATE } = await import("./validationMath");
  const { SCORECARD_MIN_DAYS } = await import("../shared/odteWiener");
  const { CRYPTO_SAMPLE_READY_MIN_GRADED } = await import("./cryptoStats");
  const { getPerformanceSnapshot, getFollowSnapshot } = await import("./whaleFollowThrough");
  const { getAllTracked } = await import("./signalTracker");
  const { getCalibrationReport, MIN_TOTAL } = await import("./gradeCalibration");
  const { getOptionLedgerSummary, configuredIndexFee } = await import("./odteGrader");
  const { computeEdgeStats } = await import("./edgeStats");
  const { rollingBrier, CALIBRATION_MIN_DAYS } = await import("./calibration");
  const { ledgerSummary } = await import("./odteMapLedger");
  const { empiricalStats, MM_PREDICTIONS_LOG_FILE } = await import("./mmPredictions");
  const { getCryptoSignals } = await import("./cryptoEngine");
  const fs = await import("node:fs/promises");
  const one = (sql: string, ...args: unknown[]): any => sqlite.prepare(sql).get(...args);
  const num = (v: unknown): number => Number(v) || 0;
  return {
    now: () => Date.now(),
    wilson: (k, n) => wilsonInterval(k, n),
    mins: {
      odteCalibrationTotal: MIN_TOTAL, odteLedgerPerBucket: MIN_FIRES_FOR_POINT_ESTIMATE, scenarioDays: CALIBRATION_MIN_DAYS,
      wienerDays: SCORECARD_MIN_DAYS, cryptoGraded: CRYPTO_SAMPLE_READY_MIN_GRADED,
    },
    whaleFollowStoreRows: () => num(one("SELECT COUNT(*) AS n FROM whale_follows").n),
    whalePerformance: (windowDays) => getPerformanceSnapshot({ windowDays }),
    whaleFollowSnapshot: () => getFollowSnapshot({ includeExpired: true }),
    trackedSignals: () => getAllTracked(),
    odteAuditCounts: () => {
      const r = one(`SELECT
          COALESCE(SUM(CASE WHEN tier != 'REJECTED' THEN 1 ELSE 0 END), 0) AS fired,
          COALESCE(SUM(CASE WHEN tier != 'REJECTED' AND graded = 0 THEN 1 ELSE 0 END), 0) AS open,
          COALESCE(SUM(CASE WHEN tier = 'REJECTED' THEN 1 ELSE 0 END), 0) AS rejected,
          MIN(CASE WHEN tier != 'REJECTED' THEN detected_at END) AS firstAt
        FROM odte_alert_audit`);
      return { fired: num(r.fired), open: num(r.open), rejected: num(r.rejected), firstAt: r.firstAt != null ? Number(r.firstAt) : null };
    },
    odteCalibration: () => getCalibrationReport(),
    odteIndexFee: () => configuredIndexFee(),
    odteLedger: (fee) => getOptionLedgerSummary(Date.now(), fee),
    predictionOutcomeRows: () => num(one("SELECT COUNT(*) AS n FROM prediction_outcomes").n),
    edgeStats: (windowDays) => computeEdgeStats(windowDays),
    scenarioCounts: () => ({
      predictionDays: num(one("SELECT COUNT(DISTINCT date) AS n FROM pulse_predictions").n),
      settledDays: num(one("SELECT COUNT(*) AS n FROM pulse_outcomes").n),
    }),
    scenarioBrier: (days) => rollingBrier(days),
    mapDayCounts: (symbol) => {
      const r = one(`SELECT
          COALESCE(SUM(CASE WHEN first_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS mapped,
          COALESCE(SUM(CASE WHEN first_json IS NOT NULL AND settle_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS settled
        FROM odte_map_days WHERE symbol = ?`, symbol);
      return { mapped: num(r.mapped), settled: num(r.settled) };
    },
    wienerScorecard: (symbol) => ledgerSummary(symbol).wienerScorecard,
    mmLogProbe: async () => {
      try { await fs.access(MM_PREDICTIONS_LOG_FILE, (await import("node:fs")).constants.R_OK); return "present"; }
      catch (e: any) { if (e?.code === "ENOENT") return "absent"; throw e; }
    },
    mmStats: async () => { const s = await empiricalStats(); return { total: s.total, graded: s.graded }; },
    crypto: () => {
      const c = getCryptoSignals();
      const e = c.stats.enterCoins;
      return {
        enterCoins: { total: e.total, open: e.open, graded: e.graded, noData: e.noData },
        graded: c.expectancy.graded, basis: c.expectancy.basis, currentVersion: c.expectancy.currentVersion,
      };
    },
  };
}

let _cache: { at: number; record: SignalRecord } | null = null;
let _inFlight: Promise<SignalRecord> | null = null;

/**
 * The record, cached for a minute (the summaries behind it are not free).
 * Concurrent callers on a cold cache share one assembly. `load` is injectable for tests.
 */
export function getSignalRecord(force = false, load: () => Promise<SignalRecordDeps> = loadDeps): Promise<SignalRecord> {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < CACHE_MS) return Promise.resolve(_cache.record);
  if (_inFlight) return _inFlight;
  const run = (async () => {
    const record = await assembleSignalRecord(await load());
    _cache = { at: Date.now(), record };
    return record;
  })();
  _inFlight = run;
  const clear = () => { if (_inFlight === run) _inFlight = null; };
  run.then(clear, clear);
  return run;
}

/** Tests only. */
export function _resetSignalRecordCache(): void { _cache = null; _inFlight = null; }
