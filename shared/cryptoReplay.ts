/**
 * cryptoReplay.ts: the replay / diagnostic pass over the desk's logged
 * signals (docs/CRYPTO_DESK.md roadmap item 1). Pure: the server hands it
 * every signal row; it answers, from the record only:
 *
 *  1. Timing: where did the sampled peak fall relative to the signal? A peak
 *     at or before the signal means the desk confirmed a move that was
 *     already over (the whale-blink filter's cost).
 *  2. Cap bands: outcomes by market cap at the signal. A 2x from $60k and a
 *     2x from $600k are different events.
 *  3. Features vs outcome: for each signal-time feature, the median among
 *     winners (HIT_5M, DOUBLED) vs losers (DEAD, RUGGED), and the win share
 *     in the top vs bottom third. Descriptive; nothing here is fitted.
 *  4. Rule re-evaluation: apply the CURRENT rule book to each row's
 *     signal-time features (never to anything learned later) and report the
 *     outcomes of the rows that would be ENTER today, split in-sample /
 *     out-of-sample by detection date, net of cost under the graded rule.
 *
 * Look-ahead: the re-evaluation reads only fields written at detection
 * (score, flow, age, cap, liquidity, authorities, top-10). Outcome, peak and
 * horizon fields are read only by the readouts that are about outcomes, and
 * a test pins that `wouldEnterNow` ignores them. Gates whose inputs were not
 * stored at the time (Jupiter state, 1 h sells, desk risk) cannot be
 * re-checked and are listed as such; the re-evaluation is therefore an
 * UPPER bound on what the current rules would have passed.
 */
import { CRYPTO_RULES, CRYPTO_RULES_VERSION, type CryptoRules } from "./cryptoRules";
import { signalReturn, wilson, type GradedSignalLike } from "./cryptoExpectancy";

export interface ReplayRow extends GradedSignalLike {
  id: string;
  detectedAt: number;
  verdict: string;
  verdictCode?: string | null;
  symbol?: string | null;
  coinKey: string;
  peakAt?: number | null;
  horizonAt?: number | null;
  rulesVersion?: string | null;
  mcapBasis?: string | null;
  features: {
    score?: number | null;
    volAccel?: number | null;
    netBuyRatio5m?: number | null;
    ageMinutes?: number | null;
    top10Pct?: number | null;
    mintAuthorityActive?: boolean | null;
    freezeAuthorityActive?: boolean | null;
    securityCheckedAt?: number | null;
    rcLpLockedPct?: number | null;
    socialScore?: number | null;
    fomo?: number | null;
    meme?: number | null;
    narrativeHits?: string[] | null;
    boosted?: boolean | null;
    pumpfunGraduate?: boolean | null;
    bskyMentions1h?: number | null;
    /** Decision-time evidence for the four gates older rows never stored (rule book 2026.10.27-2 onward). */
    gates?: GateEvidence | null;
  };
}

export interface GateEvidence {
  flowPolls: number; flowHits: number; flowNeed: number; flowWindow: number;
  jupState: string | null; jupGapPct: number | null;
  buys1h: number | null; sells1h: number | null;
  deskRisk: string | null;
}

const WIN = new Set(["HIT_5M", "DOUBLED"]);
const LOSS = new Set(["DEAD", "RUGGED"]);
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** First signal per coin, oldest first (the expectancy sample's own definition). */
export function firstPerCoin(rows: ReplayRow[], verdict?: string): ReplayRow[] {
  const seen = new Set<string>();
  const out: ReplayRow[] = [];
  for (const r of [...rows].sort((a, b) => a.detectedAt - b.detectedAt || a.id.localeCompare(b.id))) {
    if (verdict && r.verdict !== verdict) continue;
    if (seen.has(r.coinKey)) continue;
    seen.add(r.coinKey);
    out.push(r);
  }
  return out;
}

const graded = (rows: ReplayRow[]) => rows.filter((r) => r.outcome && r.outcome !== "OPEN");

// ── 1. Timing ─────────────────────────────────────────────────────────────

export interface TimingReadout {
  n: number;
  /** Rows whose sampled peak is at or before the signal (plus 5 min of sampling slack): the move was over at entry. */
  peakAtOrBeforeSignal: number;
  within15min: number;
  within60min: number;
  later: number;
  noPeak: number;
  medianMinutesToPeak: number | null;
  note: string;
}

export function timingReadout(rows: ReplayRow[]): TimingReadout {
  const g = graded(rows);
  let before = 0, w15 = 0, w60 = 0, later = 0, noPeak = 0;
  const mins: number[] = [];
  for (const r of g) {
    if (!fin(r.peakAt) || !fin(r.peakMcap)) { noPeak++; continue; }
    const m = (r.peakAt - r.detectedAt) / 60_000;
    mins.push(m);
    if (m <= 5) before++;
    else if (m <= 15) w15++;
    else if (m <= 60) w60++;
    else later++;
  }
  return {
    n: g.length, peakAtOrBeforeSignal: before, within15min: w15, within60min: w60, later, noPeak,
    medianMinutesToPeak: r1(median(mins)),
    note: "peak = the highest cap the momentum sampler saw (every ~4 min per coin); a peak inside 5 min of the signal means the desk entered after the move. Peaks between samples are not seen, so 'later' is a floor and 'before' a ceiling.",
  };
}

// ── 2. Cap bands ──────────────────────────────────────────────────────────

export interface BandReadout {
  band: string;
  n: number;
  hit: number;
  doubled: number;
  dead: number;
  rugged: number;
  noData: number;
  winShare: number | null;
  winLo: number | null;
  winHi: number | null;
  medianNetGradedPct: number | null;
}

export const CAP_BANDS: Array<[string, number, number]> = [["< $100k", 0, 100_000], ["$100k-300k", 100_000, 300_000], ["$300k-1M", 300_000, 1_000_000], ["> $1M", 1_000_000, Infinity]];

export function bandReadout(rows: ReplayRow[], targetMcap: number = CRYPTO_RULES.universe.targetMcapUsd): BandReadout[] {
  const g = graded(rows);
  return CAP_BANDS.map(([band, lo, hi]) => {
    const inBand = g.filter((r) => fin(r.mcapAtSignal) && r.mcapAtSignal >= lo && r.mcapAtSignal < hi);
    const count = (o: string) => inBand.filter((r) => r.outcome === o).length;
    const priced = inBand.filter((r) => r.outcome !== "NO_DATA");
    const wins = priced.filter((r) => WIN.has(String(r.outcome))).length;
    const w = wilson(wins, priced.length);
    const nets = priced.map((r) => signalReturn(r, "graded", 100, {}, { targetMcap }).netPct).filter((x): x is number => x != null);
    return {
      band, n: inBand.length, hit: count("HIT_5M"), doubled: count("DOUBLED"), dead: count("DEAD"), rugged: count("RUGGED"), noData: count("NO_DATA"),
      winShare: priced.length ? Math.round((wins / priced.length) * 1000) / 10 : null,
      winLo: w ? Math.round(w.lo * 1000) / 10 : null, winHi: w ? Math.round(w.hi * 1000) / 10 : null,
      medianNetGradedPct: r1(median(nets)),
    };
  });
}

// ── 3. Features vs outcome ────────────────────────────────────────────────

export interface FeatureReadout {
  feature: string;
  nWin: number;
  nLoss: number;
  medianWin: number | null;
  medianLoss: number | null;
  /** Win share among rows in the top third of the feature vs the bottom third (n per third). */
  topThirdWinShare: number | null;
  bottomThirdWinShare: number | null;
  thirdN: number;
}

const FEATURES: Array<[string, (r: ReplayRow) => number | null]> = [
  ["score", (r) => (fin(r.features.score) ? r.features.score : null)],
  ["volAccel", (r) => (fin(r.features.volAccel) ? r.features.volAccel : null)],
  ["netBuyRatio5m", (r) => (fin(r.features.netBuyRatio5m) ? r.features.netBuyRatio5m : null)],
  ["ageMinutes", (r) => (fin(r.features.ageMinutes) ? r.features.ageMinutes : null)],
  ["mcapAtSignal", (r) => (fin(r.mcapAtSignal) ? r.mcapAtSignal : null)],
  ["liquidityAtSignal", (r) => (fin(r.liquidityAtSignal) ? r.liquidityAtSignal : null)],
  ["liqToMcap", (r) => (fin(r.mcapAtSignal) && fin(r.liquidityAtSignal) && r.mcapAtSignal > 0 ? r.liquidityAtSignal / r.mcapAtSignal : null)],
  ["top10Pct", (r) => (fin(r.features.top10Pct) ? r.features.top10Pct : null)],
  ["rcLpLockedPct", (r) => (fin(r.features.rcLpLockedPct) ? r.features.rcLpLockedPct : null)],
  ["socialScore", (r) => (fin(r.features.socialScore) ? r.features.socialScore : null)],
  ["bskyMentions1h", (r) => (fin(r.features.bskyMentions1h) ? r.features.bskyMentions1h : null)],
  ["narrativeHits", (r) => (Array.isArray(r.features.narrativeHits) ? r.features.narrativeHits.length : null)],
  ["pumpfunGraduate", (r) => (r.features.pumpfunGraduate == null ? null : r.features.pumpfunGraduate ? 1 : 0)],
  ["boosted", (r) => (r.features.boosted == null ? null : r.features.boosted ? 1 : 0)],
];

export function featureReadout(rows: ReplayRow[]): FeatureReadout[] {
  const g = graded(rows).filter((r) => WIN.has(String(r.outcome)) || LOSS.has(String(r.outcome)));
  return FEATURES.map(([feature, get]) => {
    const pairs = g.map((r) => [get(r), WIN.has(String(r.outcome)) ? 1 : 0] as [number | null, number]).filter((p): p is [number, number] => p[0] != null);
    const wins = pairs.filter((p) => p[1] === 1).map((p) => p[0]);
    const losses = pairs.filter((p) => p[1] === 0).map((p) => p[0]);
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const third = Math.floor(sorted.length / 3);
    const share = (xs: [number, number][]) => (xs.length ? Math.round((xs.filter((p) => p[1] === 1).length / xs.length) * 1000) / 10 : null);
    return {
      feature, nWin: wins.length, nLoss: losses.length,
      medianWin: r1(median(wins)), medianLoss: r1(median(losses)),
      topThirdWinShare: third >= 3 ? share(sorted.slice(-third)) : null,
      bottomThirdWinShare: third >= 3 ? share(sorted.slice(0, third)) : null,
      thirdN: third,
    };
  });
}

// ── 4. Rule re-evaluation ─────────────────────────────────────────────────

export interface WouldEnter {
  enter: boolean;
  blockers: string[];
  /** Gates the stored features cannot re-check; the answer is an upper bound. */
  unchecked: string[];
}

/** The current rule book applied to a row's signal-time features only. */
export function wouldEnterNow(r: ReplayRow, rules: CryptoRules = CRYPTO_RULES): WouldEnter {
  const f = r.features;
  const b: string[] = [];
  const cap = r.mcapAtSignal, liq = r.liquidityAtSignal;
  if (!fin(liq) || liq < rules.universe.liquidityFloorUsd) b.push("liquidity floor");
  if (!fin(cap) || cap > rules.universe.enterMcapMaxUsd) b.push("cap ceiling");
  if (fin(cap) && fin(liq) && cap > 0 && liq > 0 && liq / cap < rules.hardKills.exitDoorMinLiqToMcap) b.push("exit door");
  if (f.mintAuthorityActive !== false) b.push(f.mintAuthorityActive === true ? "mint authority" : "mint authority unread");
  if (f.freezeAuthorityActive !== false) b.push(f.freezeAuthorityActive === true ? "freeze authority" : "freeze authority unread");
  if (!fin(f.score) || f.score < rules.enter.minScore) b.push("score");
  if (!fin(f.volAccel) || f.volAccel < rules.enter.minVolAccel) b.push("vol accel");
  if (!fin(f.netBuyRatio5m) || f.netBuyRatio5m < rules.enter.minNetBuyRatio5m) b.push("net buy ratio");
  if (rules.enter.requireTop10Read && !fin(f.top10Pct)) b.push("top-10 unread");
  // The four gates older rows never stored: checked from the evidence written
  // at decision time when the row has it, listed as unchecked when it does not.
  const g = f.gates;
  const unchecked: string[] = [];
  if (!g) unchecked.push("flow sustained (2 of 3 polls)", "Jupiter agree/watch", "1 h sells observed", "desk risk on");
  else {
    if (!(g.flowPolls >= g.flowNeed && g.flowHits >= g.flowNeed)) b.push("flow not sustained");
    if (g.jupState !== "agree" && g.jupState !== "watch") b.push(`Jupiter ${g.jupState ?? "unread"}`);
    if (g.sells1h == null) b.push("1 h sells unread");
    else if ((g.buys1h ?? 0) >= rules.hardKills.honeypotMinBuys1h && g.sells1h === 0) b.push("honeypot pattern");
    if (g.deskRisk !== "on") b.push(`desk risk ${g.deskRisk ?? "unread"}`);
  }
  return { enter: b.length === 0, blockers: b, unchecked };
}

export interface SplitReadout {
  label: string;
  from: number | null;
  to: number | null;
  n: number;
  wins: number;
  winShare: number | null;
  winLo: number | null;
  winHi: number | null;
  meanNetGradedPct: number | null;
  medianNetGradedPct: number | null;
  maxDrawdownPct: number | null;
}

function split(label: string, rows: ReplayRow[], targetMcap: number): SplitReadout {
  const priced = rows.filter((r) => r.outcome !== "NO_DATA");
  const nets = priced.map((r) => signalReturn(r, "graded", 100, {}, { targetMcap }).netPct).filter((x): x is number => x != null);
  const wins = priced.filter((r) => WIN.has(String(r.outcome))).length;
  const w = wilson(wins, priced.length);
  // Max drawdown of a $100-per-signal equity path, in order of detection.
  let eq = 0, peak = 0, dd = 0;
  for (const n of nets) { eq += n; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return {
    label, from: rows.length ? rows[0].detectedAt : null, to: rows.length ? rows[rows.length - 1].detectedAt : null,
    n: priced.length, wins,
    winShare: priced.length ? Math.round((wins / priced.length) * 1000) / 10 : null,
    winLo: w ? Math.round(w.lo * 1000) / 10 : null, winHi: w ? Math.round(w.hi * 1000) / 10 : null,
    meanNetGradedPct: nets.length ? r1(nets.reduce((a, b) => a + b, 0) / nets.length) : null,
    medianNetGradedPct: r1(median(nets)),
    maxDrawdownPct: nets.length ? r1(dd) : null,
  };
}

export interface ReevalReadout {
  rulesVersion: string;
  consideredFirstSignals: number;
  wouldEnter: number;
  originallyEnter: number;
  agreeEnter: number;
  blockerCounts: Record<string, number>;
  unchecked: string[];
  /** First signals whose decision-time gate evidence was recorded, of all considered. */
  gateEvidence: { recorded: number; of: number };
  inSample: SplitReadout;
  outOfSample: SplitReadout;
  all: SplitReadout;
  lookAhead: string;
}

export function reevalReadout(rows: ReplayRow[], rules: CryptoRules = CRYPTO_RULES): ReevalReadout {
  const firsts = graded(firstPerCoin(rows));
  const blockerCounts: Record<string, number> = {};
  const enter: ReplayRow[] = [];
  for (const r of firsts) {
    const w = wouldEnterNow(r, rules);
    if (w.enter) enter.push(r);
    for (const b of w.blockers) blockerCounts[b] = (blockerCounts[b] ?? 0) + 1;
  }
  const sorted = [...enter].sort((a, b) => a.detectedAt - b.detectedAt);
  const cut = Math.floor(sorted.length / 2);
  const target = rules.universe.targetMcapUsd;
  return {
    rulesVersion: CRYPTO_RULES_VERSION,
    consideredFirstSignals: firsts.length,
    wouldEnter: enter.length,
    originallyEnter: firsts.filter((r) => r.verdict === "ENTER").length,
    agreeEnter: enter.filter((r) => r.verdict === "ENTER").length,
    blockerCounts,
    unchecked: Array.from(new Set(firsts.flatMap((r) => wouldEnterNow(r, rules).unchecked))),
    gateEvidence: { recorded: firsts.filter((r) => r.features.gates != null).length, of: firsts.length },
    inSample: split("in-sample (older half)", sorted.slice(0, cut), target),
    outOfSample: split("out-of-sample (newer half)", sorted.slice(cut), target),
    all: split("all", sorted, target),
    lookAhead: "re-evaluation reads only fields written at detection; outcomes, peaks and horizon marks are used only to score. Split by detection date, older half first. Rows written before gate evidence was recorded leave four gates unchecked, so the pass count is an upper bound until every row carries it.",
  };
}

export interface CryptoReplay {
  asOf: number;
  rulesVersion: string;
  rows: { total: number; firstSignals: number; graded: number; versions: Record<string, number> };
  timing: TimingReadout;
  bands: BandReadout[];
  features: FeatureReadout[];
  reeval: ReevalReadout;
  samplingLimit: string;
  scope: string;
}

export function buildReplay(rows: ReplayRow[], now: number, rules: CryptoRules = CRYPTO_RULES): CryptoReplay {
  const firsts = firstPerCoin(rows);
  const versions: Record<string, number> = {};
  for (const r of firsts) { const v = r.rulesVersion ?? "unversioned"; versions[v] = (versions[v] ?? 0) + 1; }
  return {
    asOf: now,
    rulesVersion: CRYPTO_RULES_VERSION,
    rows: { total: rows.length, firstSignals: firsts.length, graded: graded(firsts).length, versions },
    timing: timingReadout(firsts),
    bands: bandReadout(firsts, rules.universe.targetMcapUsd),
    features: featureReadout(firsts),
    reeval: reevalReadout(rows, rules),
    samplingLimit: "the record has no full price series per coin: peaks are what the ~4-minute sampler saw, so a 2x that lasted ninety seconds reads as DEAD. DOUBLED counts are a floor. A per-coin high since entry needs a faster read (RPC websocket on the pool) before the label can be trusted upward.",
    scope: "what the logged signals did, re-read under the current rule book. Descriptive bookkeeping on one desk's record; not a forecast, not a fitted model, not evidence of edge until the expectancy card's own tests pass out of sample.",
  };
}
