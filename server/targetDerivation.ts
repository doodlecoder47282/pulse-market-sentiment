// server/targetDerivation.ts
//
// T1/T2 AUTO-DERIVATION from the walk-forward touch-rate table.
//
// Problem: eod-setup fires landed in odte_alert_audit with t1_target=0 and the
// grader marked them "insufficient_inputs — no t1_target". Every ungradeable
// fire is a wasted sample for BOTH calibration and the hazard-engine refit.
//
// Approach: instead of arbitrary point offsets, targets come from the
// walk-forward backtest (1,162 dates / 51k observations, stride-sampled so
// forward windows never overlap). Each level kind carries an honest daily
// touch rate and a median tag distance. A level's touch probability is
// distance-dependent, so we adjust the base rate by how far the level sits
// today vs its historical median distance:
//
//   adjProb = wfTouchRate * clamp(medianDistBps / todayDistBps, 0.25, 2.5)
//
// This is a first-order adjustment, not a fitted model — disclosed in the
// basis string of every target. Levels with no walk-forward table entry
// (vanna/zomma/charm/negGamma third-order strikes) are EXCLUDED from
// derivation rather than given invented probabilities, and listed in caveats.
//
// Selection:
//   T1 = nearest in-direction level with adjProb >= T1_MIN (0.30);
//        fallback: highest-adjProb candidate; fallback: nearest candidate.
//   T2 = nearest candidate strictly beyond T1 with adjProb >= T2_MIN (0.10).
//
// Read-only, pure w.r.t. inputs; walk-forward summary is cached upstream.

import { getWalkForwardSummary, type LevelKind } from "./backtest";

export interface CandidateLevel {
  kind: string;   // caller-facing kind (callWall, hvl, upside, ...)
  name: string;   // display name for briefs/cards
  price: number;
}

export interface DerivedTarget {
  name: string;
  kind: string;
  wfKind: LevelKind;
  price: number;
  distPts: number;
  distBps: number;
  wfTouchRate: number;      // unconditional daily walk-forward touch rate
  wfMedianDistBps: number;  // historical median tag distance for this kind
  adjProb: number;          // distance-adjusted touch probability (0-0.95)
  basis: string;            // human-readable provenance
}

export interface DerivedTargets {
  side: "call" | "put";
  spot: number;
  t1: DerivedTarget | null;
  t2: DerivedTarget | null;
  candidatesConsidered: number;
  excluded: string[];       // levels skipped for having no walk-forward stats
  method: string;
  caveats: string[];
}

// Map caller-facing level kinds -> walk-forward table kinds.
// Kinds absent here have NO backtest basis and are excluded (honest > invented).
const WF_KIND_MAP: Record<string, LevelKind> = {
  callWall: "callWall",
  putWall: "putWall",
  zeroGamma: "zeroGamma",
  gammaFlip: "zeroGamma",     // same structural object in our stack
  hvl: "dominantMag",         // HVL is the dominant magnet in the daily model
  dominantMag: "dominantMag",
  upside: "upsidePivot",
  upsidePivot: "upsidePivot",
  t2up: "upsidePivot",
  downside: "downsidePivot",
  downsidePivot: "downsidePivot",
  t2down: "downsidePivot",
  mopex: "mopexMaxPain",
  mopexMaxPain: "mopexMaxPain",
  upperVomma: "vommaPocket",
  lowerVomma: "vommaPocket",
  vommaPocket: "vommaPocket",
};

const T1_MIN_PROB = 0.30;
const T2_MIN_PROB = 0.10;
const MAX_DIST_BPS = 400;        // beyond ~4% on the day is fantasy for 0-1d targets
const MIN_DIST_BPS = 3;          // sitting on top of spot is not a target
const RATIO_CLAMP_LO = 0.25;     // distance-adjustment bounds
const RATIO_CLAMP_HI = 2.5;
const PROB_CAP = 0.95;

const METHOD =
  "walk-forward daily touch rates (stride-sampled, non-overlapping) with first-order distance adjustment: adjProb = wfTouchRate * clamp(medianDistBps/todayDistBps, 0.25, 2.5)";

export function deriveTargets(args: {
  spot: number;
  side: "call" | "put";
  levels: CandidateLevel[];
}): DerivedTargets {
  const { spot, side, levels } = args;
  const caveats: string[] = [];
  const excluded: string[] = [];

  const empty: DerivedTargets = {
    side, spot, t1: null, t2: null, candidatesConsidered: 0,
    excluded, method: METHOD, caveats,
  };
  if (!Number.isFinite(spot) || spot <= 0) {
    caveats.push("no valid spot — derivation skipped");
    return empty;
  }

  // Walk-forward daily rows keyed by level kind
  let wfRows: Map<LevelKind, { touchRate: number; medDistBps: number; n: number }>;
  try {
    const wf = getWalkForwardSummary();
    wfRows = new Map();
    for (const r of wf.rows) {
      if (r.horizon !== "daily") continue;
      if (r.wfTouchRate == null || r.wfMedianAbsDistBps == null) continue;
      wfRows.set(r.levelKind, {
        touchRate: r.wfTouchRate,
        medDistBps: r.wfMedianAbsDistBps,
        n: r.wfN,
      });
    }
  } catch (e: any) {
    caveats.push(`walk-forward table unavailable (${e?.message ?? e}) — derivation skipped`);
    return empty;
  }
  if (wfRows.size === 0) {
    caveats.push("walk-forward table empty — run POST /api/backtest/rebuild first");
    return empty;
  }

  // Build candidates: strictly in trade direction, mapped to a wf kind, sane distance
  const cands: DerivedTarget[] = [];
  const seenPrices = new Set<number>();
  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const inDirection = side === "call" ? lv.price > spot : lv.price < spot;
    if (!inDirection) continue;

    const wfKind = WF_KIND_MAP[lv.kind];
    if (!wfKind) { excluded.push(`${lv.name} (${lv.kind}): no walk-forward stats`); continue; }
    const stats = wfRows.get(wfKind);
    if (!stats) { excluded.push(`${lv.name} (${lv.kind}): kind ${wfKind} missing from table`); continue; }

    const distPts = Math.abs(lv.price - spot);
    const distBps = (distPts / spot) * 10_000;
    if (distBps < MIN_DIST_BPS) continue;
    if (distBps > MAX_DIST_BPS) { excluded.push(`${lv.name}: ${distBps.toFixed(0)}bps away — beyond daily reach`); continue; }

    // De-dupe identical prices (e.g. zeroGamma == gammaFlip): keep first mapping
    const key = Math.round(lv.price * 100);
    if (seenPrices.has(key)) continue;
    seenPrices.add(key);

    const ratio = Math.min(RATIO_CLAMP_HI, Math.max(RATIO_CLAMP_LO, stats.medDistBps / Math.max(distBps, 1)));
    const adjProb = Math.min(PROB_CAP, stats.touchRate * ratio);

    cands.push({
      name: lv.name, kind: lv.kind, wfKind, price: lv.price,
      distPts: Number(distPts.toFixed(1)),
      distBps: Number(distBps.toFixed(1)),
      wfTouchRate: Number(stats.touchRate.toFixed(3)),
      wfMedianDistBps: Number(stats.medDistBps.toFixed(1)),
      adjProb: Number(adjProb.toFixed(3)),
      basis: `${wfKind} wf touch ${(stats.touchRate * 100).toFixed(1)}% @ median ${stats.medDistBps.toFixed(0)}bps, today ${distBps.toFixed(0)}bps → adj ${(adjProb * 100).toFixed(0)}%`,
    });
  }

  cands.sort((a, b) => a.distBps - b.distBps);

  // PATH MONOTONICITY: touching a further level requires passing every nearer
  // one first, so P(touch) cannot increase with distance. Different level
  // kinds carry different base rates, which can invert that — clamp each
  // candidate's adjProb to the running minimum along the path.
  let runMin = PROB_CAP;
  for (const c of cands) {
    if (c.adjProb > runMin) {
      c.adjProb = runMin;
      c.basis += ` (capped at ${(runMin * 100).toFixed(0)}% by nearer level — path monotonicity)`;
    } else {
      runMin = c.adjProb;
    }
  }

  if (cands.length === 0) {
    caveats.push(`no in-direction levels with walk-forward basis for ${side} side`);
    return { ...empty, excluded };
  }

  // T1: nearest with adjProb >= T1_MIN; else highest adjProb; else nearest
  let t1 = cands.find((c) => c.adjProb >= T1_MIN_PROB) ?? null;
  if (!t1) {
    t1 = cands.slice().sort((a, b) => b.adjProb - a.adjProb)[0] ?? null;
    if (t1) caveats.push(`no candidate reached ${(T1_MIN_PROB * 100).toFixed(0)}% adjusted touch — T1 is best-available at ${(t1.adjProb * 100).toFixed(0)}%`);
  }

  // T2: nearest strictly beyond T1 with adjProb >= T2_MIN
  let t2: DerivedTarget | null = null;
  if (t1) {
    t2 = cands.find((c) => c.distBps > t1!.distBps && c.adjProb >= T2_MIN_PROB) ?? null;
    if (!t2) caveats.push("no viable T2 beyond T1 — single-target setup");
  }

  caveats.push("adjusted probabilities are first-order distance scaling of unconditional rates, not a fitted conditional model — treat as ordering, not odds");

  return {
    side, spot, t1, t2,
    candidatesConsidered: cands.length,
    excluded, method: METHOD, caveats,
  };
}

/** Convenience: derive both directions at once for briefs/cards. */
export function deriveBothSides(spot: number, levels: CandidateLevel[]): {
  up: DerivedTargets; down: DerivedTargets;
} {
  return {
    up: deriveTargets({ spot, side: "call", levels }),
    down: deriveTargets({ spot, side: "put", levels }),
  };
}
