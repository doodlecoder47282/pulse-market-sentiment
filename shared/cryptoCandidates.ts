// shared/cryptoCandidates.ts
//
// Candidate rule sets, tested on the desk's own record. Pure.
//
// The live rule book (shared/cryptoRules.ts) has never produced an ENTER, so there is no record to judge it
// by. This module asks a different question of the SAME stored signals: had a named, pre-declared set of
// rules been the gate, which first signals would have passed, and what did those coins do, net of cost,
// in the older half of the record and in the newer half.
//
// What this is not. Nothing here moves a live verdict, score or exit level; a candidate becomes a rule only
// by being written into shared/cryptoRules.ts under a new version, after review. The numbers are candidates'
// parameters, not the desk's thresholds, and are versioned here on their own (CANDIDATES_VERSION) so a
// changed number is visible. Every set is declared before it is run: there is no search over parameters,
// and with several sets read on one record the best of them is biased upward, which the readout says.
//
// Each rule reads only fields stored at detection (features_json and the row's own columns). A rule whose
// input was not recorded on a row is "unread" for that row and the row does NOT pass: a candidate is never
// credited with a row it could not have evaluated.

import { signalReturn } from "./cryptoExpectancy";
import { firstPerCoin, splitReadout, type ReplayRow, type SplitReadout } from "./cryptoReplay";
import { CRYPTO_RULES } from "./cryptoRules";

export const CANDIDATES_VERSION = "candidates-2026.11.17-1";

type RuleResult = "pass" | "fail" | "unread";

export interface CandidateRule {
  id: string;
  /** Plain statement of the rule, with its numbers. */
  text: string;
  test: (r: ReplayRow, ctx: CandidateContext) => RuleResult;
}

export interface CandidateContext {
  /** Earlier first signals carrying the same symbol within the look-back, by row id. */
  sameNameBefore: Map<string, number>;
}

/** Parameters of the candidate rules. Not the live rule book: see the header. */
export const CANDIDATE_PARAMS = {
  maxTop10Pct: 45,
  minSells1h: 5,
  minBuys1h: 30,
  buyRatioMin: 0.55,
  buyRatioMax: 0.90,
  minAgeMinutes: 10,
  minCapUsd: 100_000,
  minBskyMentions1h: 3,
  sameNameLookbackHours: 24,
  maxSameNameBefore: 1,
} as const;

const P = CANDIDATE_PARAMS;
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export const RULES: Record<string, CandidateRule> = {
  noActiveAuthority: {
    id: "noActiveAuthority",
    text: "mint and freeze authority not active where they were read (unread passes: the read usually lands after the first signal)",
    test: (r) => (r.features.mintAuthorityActive === true || r.features.freezeAuthorityActive === true ? "fail" : "pass"),
  },
  top10WhenRead: {
    id: "top10WhenRead",
    text: `top-10 holders at most ${P.maxTop10Pct}% where read (unread passes)`,
    test: (r) => { const t = num(r.features.top10Pct); return t != null && t > P.maxTop10Pct ? "fail" : "pass"; },
  },
  jupiterNotAgainst: {
    id: "jupiterNotAgainst",
    text: "Jupiter cross-check not diverging and not no-reliable-price (unchecked passes)",
    test: (r) => { const s = r.features.gates?.jupState ?? null; return s === "diverge" || s === "no-reliable-price" ? "fail" : "pass"; },
  },
  twoSidedTape: {
    id: "twoSidedTape",
    text: `at least ${P.minSells1h} sells and ${P.minBuys1h} buys in the hour, and a 5-minute buy share between ${P.buyRatioMin} and ${P.buyRatioMax}`,
    test: (r) => {
      const g = r.features.gates;
      const buys = num(g?.buys1h), sells = num(g?.sells1h), ratio = num(r.features.netBuyRatio5m);
      if (buys == null || sells == null || ratio == null) return "unread";
      return sells >= P.minSells1h && buys >= P.minBuys1h && ratio >= P.buyRatioMin && ratio <= P.buyRatioMax ? "pass" : "fail";
    },
  },
  attention: {
    id: "attention",
    text: `one attention confirmation: boosted, a narrative hit, or at least ${P.minBskyMentions1h} Bluesky mentions in the hour`,
    test: (r) => {
      const f = r.features;
      const hits = Array.isArray(f.narrativeHits) ? f.narrativeHits.length : null;
      const bsky = num(f.bskyMentions1h);
      if (f.boosted === true || (hits != null && hits > 0) || (bsky != null && bsky >= P.minBskyMentions1h)) return "pass";
      // All three absent from the row: not evaluable. Any one recorded as negative: a real fail.
      return f.boosted == null && hits == null && bsky == null ? "unread" : "fail";
    },
  },
  minAge: {
    id: "minAge",
    text: `pair at least ${P.minAgeMinutes} minutes old at the signal`,
    test: (r) => { const a = num(r.features.ageMinutes); return a == null ? "unread" : a >= P.minAgeMinutes ? "pass" : "fail"; },
  },
  minCap: {
    id: "minCap",
    text: `cap at the signal at least $${P.minCapUsd.toLocaleString("en-US")}`,
    test: (r) => { const c = num(r.mcapAtSignal); return c == null || c <= 0 ? "unread" : c >= P.minCapUsd ? "pass" : "fail"; },
  },
  notRelaunch: {
    id: "notRelaunch",
    text: `the same symbol logged at most ${P.maxSameNameBefore} time in the ${P.sameNameLookbackHours} hours before (a lower bound: only coins the desk logged count)`,
    test: (r, ctx) => {
      if (!r.symbol) return "unread";
      return (ctx.sameNameBefore.get(r.id) ?? 0) <= P.maxSameNameBefore ? "pass" : "fail";
    },
  },
};

export interface CandidateSet { id: string; name: string; rules: CandidateRule[]; why: string }

const BASE = [RULES.noActiveAuthority, RULES.top10WhenRead, RULES.jupiterNotAgainst];

/** Declared once, in this order. Adding or changing a set changes CANDIDATES_VERSION. */
export const CANDIDATE_SETS: CandidateSet[] = [
  { id: "base", name: "Structure only", rules: BASE, why: "the base rate: every first signal with no recorded structural objection" },
  { id: "tape", name: "Two-sided tape", rules: [...BASE, RULES.twoSidedTape], why: "a buy share of 1.00 was the median for winners and losers alike; this asks for real selling being absorbed" },
  { id: "attention", name: "Attention", rules: [...BASE, RULES.attention], why: "boost, narrative hit and Bluesky mentions were the only stored features with separation in the record" },
  { id: "survivors", name: "Past the first minutes", rules: [...BASE, RULES.minAge, RULES.minCap], why: "under $100k cap the median net result was -100% and a third of coins had peaked inside 15 minutes" },
  { id: "combined", name: "Combined", rules: [...BASE, RULES.twoSidedTape, RULES.attention, RULES.minAge, RULES.notRelaunch], why: "all of the above except the cap floor, plus the serial-relaunch filter" },
];

export interface CandidateReadout {
  id: string;
  name: string;
  why: string;
  rules: Array<{ id: string; text: string; pass: number; fail: number; unread: number }>;
  considered: number;
  passed: number;
  /** Rows that failed no rule but had at least one unread rule: not credited. */
  notEvaluable: number;
  inSample: SplitReadout;
  outOfSample: SplitReadout;
  all: SplitReadout;
  /** Mean net per signal under "hold to the 72 h horizon" where priced, for the passing rows. */
  meanNetHoldPct: number | null;
}

export interface CandidatesReadout {
  version: string;
  considered: number;
  sets: CandidateReadout[];
  caveats: string[];
}

/** Earlier first signals with the same symbol inside the look-back window, per row id. */
export function sameNameCounts(firsts: ReplayRow[], lookbackHours: number = P.sameNameLookbackHours): Map<string, number> {
  const out = new Map<string, number>();
  const bySym = new Map<string, number[]>(); // detection times, ascending
  const win = lookbackHours * 3_600_000;
  for (const r of [...firsts].sort((a, b) => a.detectedAt - b.detectedAt || a.id.localeCompare(b.id))) {
    const key = r.symbol ? r.symbol.trim().toLowerCase() : "";
    if (!key) continue;
    const times = bySym.get(key) ?? [];
    out.set(r.id, times.filter((t) => r.detectedAt - t <= win).length);
    times.push(r.detectedAt);
    bySym.set(key, times);
  }
  return out;
}

export function candidatesReadout(rows: ReplayRow[], sets: CandidateSet[] = CANDIDATE_SETS): CandidatesReadout {
  const firsts = firstPerCoin(rows).filter((r) => r.outcome && r.outcome !== "OPEN");
  const ctx: CandidateContext = { sameNameBefore: sameNameCounts(firstPerCoin(rows)) };
  const target = CRYPTO_RULES.universe.targetMcapUsd;
  const out: CandidateReadout[] = sets.map((s) => {
    const tally = s.rules.map((rule) => ({ id: rule.id, text: rule.text, pass: 0, fail: 0, unread: 0 }));
    const passed: ReplayRow[] = [];
    let notEvaluable = 0;
    for (const r of firsts) {
      let anyFail = false, anyUnread = false;
      s.rules.forEach((rule, i) => {
        const v = rule.test(r, ctx);
        tally[i][v]++;
        if (v === "fail") anyFail = true; else if (v === "unread") anyUnread = true;
      });
      if (!anyFail && !anyUnread) passed.push(r);
      else if (!anyFail) notEvaluable++;
    }
    const sorted = passed.sort((a, b) => a.detectedAt - b.detectedAt);
    const cut = Math.floor(sorted.length / 2);
    const holds = sorted.map((r) => signalReturn(r, "hold", 100, {}, { targetMcap: target }).netPct).filter((x): x is number => x != null);
    return {
      id: s.id, name: s.name, why: s.why, rules: tally,
      considered: firsts.length, passed: sorted.length, notEvaluable,
      inSample: splitReadout("older half", sorted.slice(0, cut), target),
      outOfSample: splitReadout("newer half", sorted.slice(cut), target),
      all: splitReadout("all", sorted, target),
      meanNetHoldPct: holds.length ? Math.round((holds.reduce((a, b) => a + b, 0) / holds.length) * 10) / 10 : null,
    };
  });
  return {
    version: CANDIDATES_VERSION,
    considered: firsts.length,
    sets: out,
    caveats: [
      `${sets.length} sets are read on the same record, so the best of them is biased upward: read the newer half, and treat a set as worth a rule version only if it holds there.`,
      "Each coin's FIRST signal is all the record keeps (median about two and a half minutes old), so a rule about a later state of the coin (age, a two-sided tape) passes few rows: that is a limit of the record, not evidence against the rule.",
      "A win is a sampled touch of the target or of 2x; net figures sell when the row was graded, net of pool fees and impact at the liquidity recorded. Rows with no outcome are left out of n.",
      "Rows stored before 2026-11-17 carry the old acceleration figure and the old meaning of the graduate flag; neither is used by these rules.",
      "A rule whose input was not recorded on a row does not pass it. No candidate is a live rule and none is a claim of edge.",
    ],
  };
}
