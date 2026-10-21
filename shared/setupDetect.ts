// shared/setupDetect.ts
//
// Pure detector and grader for the setup event log. A setup is a stated
// condition met at an instant (shared/setupRules.ts): spot at a dealer
// landmark, the gamma sign the rule needs, a confirming print on the trade's
// side, a quiet calendar, a session window, and a target that clears the
// modelled cost. The server feeds it the structure, flow and quote it already
// holds; it returns either a candidate with every feature that produced it,
// or the list of blockers that kept it from firing (so the Method panel can
// say "why not now").
//
// Grading replays minute bars after detection with the achievable-exit test:
// target touched before invalidation within the horizon is a hit;
// invalidation first (or both in one bar) is a loss; neither is an expiry
// priced at the horizon's close. Returns are signed by direction and net of
// the round-trip cost modelled at detection. Nothing here is a forecast.

import type { SetupRules } from "./setupRules";

export type SetupKind = "fade_call_wall" | "fade_put_wall" | "breakout_above" | "breakout_below";
export type Direction = "up" | "down";

export interface StructureInput {
  spot: number | null;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  /** Dealer gamma sign at spot: positive = long (fade), negative = short (chase). */
  regime: "positive" | "negative" | "unknown";
  /** Share of gross exposure at each wall, 0-1, when the structure source reports it. */
  callWallShare?: number | null;
  putWallShare?: number | null;
  /** Front-month ATM implied vol, 0-1, for the one-day implied move. */
  atmIv?: number | null;
}

export interface FlowInput {
  type: "C" | "P";
  strike: number;
  dte: number;
  premium: number;
  volOiRatio: number;
  isNewStrike: boolean;
  /** AT_ASK / ABOVE_ASK / AT_BID / BELOW_BID / MID. */
  tag: string;
  detectedAt: number;
}

export interface ContextInput {
  nowMs: number;
  minutesSinceOpen: number;
  minutesToClose: number;
  /** Null when the calendar is unknown; an unknown calendar blocks (the gate cannot be checked), it is never treated as quiet. */
  minutesToTier1: number | null;
  minutesSinceTier1?: number | null;
  calendarKnown: boolean;
  /** Underlying bid-ask spread as a fraction of mid; the round-trip cost model. Null when unknown. */
  spreadPct: number | null;
}

export interface SetupFeatures {
  spot: number;
  landmark: number;
  landmarkKind: "callWall" | "putWall";
  landmarkShare: number | null;
  distToLandmarkPct: number;
  regime: StructureInput["regime"];
  gammaFlip: number | null;
  impliedMove1dPct: number | null;
  flow: { type: "C" | "P"; strike: number; dte: number; premium: number; volOiRatio: number; tag: string; ageMin: number } | null;
  minutesSinceOpen: number;
  minutesToClose: number;
  minutesToTier1: number | null;
  minutesSinceTier1: number | null;
  calendarKnown: boolean;
  spreadPct: number | null;
}

/** How far each condition cleared its rule, as a multiple of the threshold (1 = exactly at the rule). */
export interface SetupMargins {
  premium: number | null;
  volOi: number | null;
  wallShare: number | null;
  costMultiple: number;
  rMultiple: number;
  calendarQuiet: number | null;
  impliedMoveRoom: number | null;
}

export interface SetupCandidate {
  kind: SetupKind;
  direction: Direction;
  ruleVersion: string;
  spot: number;
  target: number;
  invalidation: number;
  horizonMin: number;
  /** Modelled round-trip cost as a fraction of spot (the underlying's spread). */
  costPct: number;
  targetPct: number;
  /** Target distance over invalidation distance. */
  rMultiple: number;
  margins: SetupMargins;
  features: SetupFeatures;
}

export interface Blocked {
  kind: SetupKind;
  blockers: string[];
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** One-day implied move from annualised ATM IV. */
export function impliedMove1dPct(atmIv: number | null | undefined): number | null {
  const iv = fin(atmIv);
  return iv == null || iv <= 0 ? null : iv * Math.sqrt(1 / 252);
}

function confirmingPrint(flow: FlowInput[], side: "C" | "P", rules: SetupRules, nowMs: number): FlowInput | null {
  const ok = flow
    .filter((f) => f.type === side)
    .filter((f) => f.dte >= rules.flow.dteMin && f.dte <= rules.flow.dteMax)
    .filter((f) => f.premium >= rules.flow.minPremiumUsd)
    .filter((f) => f.isNewStrike || f.volOiRatio >= rules.flow.minVolOi)
    .filter((f) => !rules.flow.requireAggressor || /^(AT|ABOVE)_ASK$/.test(f.tag))
    .filter((f) => (nowMs - f.detectedAt) / 60_000 <= rules.flow.maxAgeMin)
    .sort((a, b) => b.premium - a.premium);
  return ok[0] ?? null;
}

/**
 * Evaluate every setup kind at this instant. Returns the candidates that
 * fired and, for the kinds that did not, the blockers.
 */
export function detectSetups(s: StructureInput, flow: FlowInput[], ctx: ContextInput, rules: SetupRules): { fired: SetupCandidate[]; blocked: Blocked[] } {
  const spot = fin(s.spot);
  const fired: SetupCandidate[] = [];
  const blocked: Blocked[] = [];
  const kinds: SetupKind[] = ["fade_call_wall", "fade_put_wall", "breakout_above", "breakout_below"];
  if (spot == null || spot <= 0) return { fired, blocked: kinds.map((kind) => ({ kind, blockers: ["no spot"] })) };
  const im = impliedMove1dPct(s.atmIv);

  for (const kind of kinds) {
    const blockers: string[] = [];
    const fade = kind.startsWith("fade");
    const landmarkKind: "callWall" | "putWall" = kind === "fade_call_wall" || kind === "breakout_above" ? "callWall" : "putWall";
    const landmark = fin(landmarkKind === "callWall" ? s.callWall : s.putWall);
    const share = fin(landmarkKind === "callWall" ? s.callWallShare : s.putWallShare);
    const direction: Direction = kind === "fade_call_wall" || kind === "breakout_below" ? "down" : "up";
    const side: "C" | "P" = direction === "up" ? "C" : "P";

    // Session window
    if (ctx.minutesSinceOpen < rules.session.notBeforeMin) blockers.push(`opening rotation: ${Math.round(ctx.minutesSinceOpen)} min since the open, rule needs ${rules.session.notBeforeMin}`);
    if (ctx.minutesToClose < rules.session.notAfterMin) blockers.push(`${Math.round(ctx.minutesToClose)} min to the close, rule needs ${rules.session.notAfterMin}`);
    // Structure
    if (landmark == null) blockers.push(`no ${landmarkKind === "callWall" ? "call wall" : "put wall"} in the structure read`);
    const dist = landmark == null ? null : (spot - landmark) / spot;
    if (dist != null && Math.abs(dist) > rules.structure.atLandmarkPct) blockers.push(`spot ${(dist * 100).toFixed(2)}% from the ${landmarkKind === "callWall" ? "call wall" : "put wall"}, rule needs within ${(rules.structure.atLandmarkPct * 100).toFixed(2)}%`);
    if (share != null && share < rules.structure.minWallShare) blockers.push(`wall carries ${(share * 100).toFixed(1)}% of exposure, rule needs ${(rules.structure.minWallShare * 100).toFixed(0)}%`);
    // Regime
    const need = fade ? rules.regime.fadeRequires : rules.regime.breakoutRequires;
    const have = s.regime === "positive" ? "long" : s.regime === "negative" ? "short" : "unknown";
    if (have !== need) blockers.push(`dealer gamma ${have}, ${fade ? "a fade" : "a breakout"} needs ${need}`);
    // Vol
    if (im != null && im > rules.vol.maxImpliedMovePct) blockers.push(`implied one-day move ${(im * 100).toFixed(2)}% over the ${(rules.vol.maxImpliedMovePct * 100).toFixed(1)}% ceiling (news-priced tape)`);
    // Calendar: unknown blocks (the gate cannot be checked), never passes.
    if (!ctx.calendarKnown) blockers.push("calendar unknown: the tier-1 gate cannot be checked");
    else {
      if (ctx.minutesToTier1 != null && ctx.minutesToTier1 < rules.events.tier1QuietMin) blockers.push(`tier-1 event in ${ctx.minutesToTier1} min, rule needs ${rules.events.tier1QuietMin}`);
      if (ctx.minutesSinceTier1 != null && ctx.minutesSinceTier1 < rules.events.tier1QuietAfterMin) blockers.push(`tier-1 release ${ctx.minutesSinceTier1} min ago, rule needs ${rules.events.tier1QuietAfterMin} after`);
    }
    // Flow
    const print = confirmingPrint(flow, side, rules, ctx.nowMs);
    if (!print) blockers.push(`no confirming ${side === "C" ? "call" : "put"} print (>= $${(rules.flow.minPremiumUsd / 1e6).toFixed(1)}M, ${rules.flow.dteMin}-${rules.flow.dteMax} DTE, vol/OI >= ${rules.flow.minVolOi}${rules.flow.requireAggressor ? ", at the ask" : ""}, under ${rules.flow.maxAgeMin} min old)`);
    // Target, invalidation, cost
    let target: number | null = null, invalidation: number | null = null;
    if (landmark != null) {
      const flip = fin(s.gammaFlip);
      if (kind === "fade_call_wall") {
        target = flip != null && flip < spot ? flip : spot * (1 - rules.outcome.fallbackTargetPct);
        invalidation = landmark * (1 + rules.outcome.invalidationPct);
      } else if (kind === "fade_put_wall") {
        target = flip != null && flip > spot ? flip : spot * (1 + rules.outcome.fallbackTargetPct);
        invalidation = landmark * (1 - rules.outcome.invalidationPct);
      } else if (kind === "breakout_above") {
        target = spot * (1 + rules.outcome.fallbackTargetPct);
        invalidation = landmark * (1 - rules.outcome.invalidationPct);
      } else {
        target = spot * (1 - rules.outcome.fallbackTargetPct);
        invalidation = landmark * (1 + rules.outcome.invalidationPct);
      }
    }
    const targetPct = target == null ? null : Math.abs(target - spot) / spot;
    const invalPct = invalidation == null ? null : Math.abs(invalidation - spot) / spot;
    const rMultiple = targetPct != null && invalPct != null && invalPct > 0 ? targetPct / invalPct : null;
    const cost = fin(ctx.spreadPct);
    if (cost == null || !(cost > 0)) blockers.push(cost == null ? "no spread quote: cost not modelled" : "zero spread (locked or stale quote): cost not modelled");
    else if (targetPct != null && targetPct < cost * rules.outcome.minTargetToCostMultiple) blockers.push(`target ${(targetPct * 100).toFixed(2)}% does not clear ${rules.outcome.minTargetToCostMultiple}x the ${(cost * 100).toFixed(3)}% round-trip cost`);
    if (rMultiple != null && rMultiple < rules.outcome.minRMultiple) blockers.push(`reward to risk ${rMultiple.toFixed(2)}, rule needs ${rules.outcome.minRMultiple}`);
    if (invalidation != null && ((direction === "down" && spot >= invalidation) || (direction === "up" && spot <= invalidation))) blockers.push("invalidation already breached at detection");

    if (blockers.length) { blocked.push({ kind, blockers }); continue; }
    const margins: SetupMargins = {
      premium: print ? print.premium / rules.flow.minPremiumUsd : null,
      volOi: print ? (print.isNewStrike ? null : print.volOiRatio / rules.flow.minVolOi) : null,
      wallShare: share != null ? share / rules.structure.minWallShare : null,
      costMultiple: (targetPct! / cost!) / rules.outcome.minTargetToCostMultiple,
      rMultiple: rMultiple! / rules.outcome.minRMultiple,
      calendarQuiet: ctx.minutesToTier1 != null ? ctx.minutesToTier1 / rules.events.tier1QuietMin : null,
      impliedMoveRoom: im != null ? rules.vol.maxImpliedMovePct / im : null,
    };
    fired.push({
      kind, direction, ruleVersion: rules.version, spot,
      target: r4(target!), invalidation: r4(invalidation!), horizonMin: rules.outcome.horizonMin,
      costPct: cost!, targetPct: targetPct!, rMultiple: r4(rMultiple!), margins,
      features: {
        spot, landmark: landmark!, landmarkKind, landmarkShare: share, distToLandmarkPct: dist!, regime: s.regime, gammaFlip: fin(s.gammaFlip),
        impliedMove1dPct: im,
        flow: print ? { type: print.type, strike: print.strike, dte: print.dte, premium: print.premium, volOiRatio: print.volOiRatio, tag: print.tag, ageMin: Math.round((ctx.nowMs - print.detectedAt) / 60_000) } : null,
        minutesSinceOpen: ctx.minutesSinceOpen, minutesToClose: ctx.minutesToClose, minutesToTier1: ctx.minutesToTier1, minutesSinceTier1: ctx.minutesSinceTier1 ?? null, calendarKnown: ctx.calendarKnown, spreadPct: cost,
      },
    });
  }
  return { fired, blocked };
}

// ─── Ranking ────────────────────────────────────────────────────────────

export interface Rankable { symbol: string; margins: SetupMargins; sector?: string | null }

/** Margins that rank. Calendar distance is a gate, not a merit, so it is shown but not scored. */
export const RANKED_MARGINS: Array<keyof SetupMargins> = ["premium", "volOi", "wallShare", "costMultiple", "rMultiple", "impliedMoveRoom"];

/**
 * Margin score: the mean over a FIXED list of margins of log2(margin), each
 * capped at 3 (8x a rule earns no more than 8x); a margin that could not be
 * read counts 0 (exactly at the rule), so a missing input never raises or
 * lowers a rank by omission. 0 = at every rule. Ranking before outcomes
 * exist is by how comfortably the rules were met, never by predicted edge;
 * every part is shown so the order is auditable.
 */
export function marginScore(m: SetupMargins): { score: number; parts: Array<{ name: string; margin: number }> } {
  const parts = (Object.entries(m) as Array<[string, number | null]>)
    .filter(([, v]) => v != null && Number.isFinite(v) && v > 0)
    .map(([name, v]) => ({ name, margin: v as number }));
  const score = RANKED_MARGINS.reduce((a, k) => { const v = m[k]; return a + (v != null && Number.isFinite(v) && v > 0 ? Math.min(3, Math.log2(v)) : 0); }, 0) / RANKED_MARGINS.length;
  return { score: Math.round(score * 1000) / 1000, parts };
}

/** Top N by margin score with at most `maxPerSector` from one sector (unknown sectors count as their own). */
export function rankSetups<T extends Rankable>(items: T[], topN: number, maxPerSector: number): Array<T & { score: number }> {
  const scored = items.map((it) => ({ ...it, score: marginScore(it.margins).score })).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const perSector = new Map<string, number>();
  const out: Array<T & { score: number }> = [];
  for (const it of scored) {
    const sec = it.sector ?? `unknown:${it.symbol}`;
    const n = perSector.get(sec) ?? 0;
    if (n >= maxPerSector) continue;
    perSector.set(sec, n + 1);
    out.push(it);
    if (out.length >= topN) break;
  }
  return out;
}

// ─── Grading ────────────────────────────────────────────────────────────

export interface MinuteBar { t: number; open: number; high: number; low: number; close: number }

export interface SetupOutcome {
  status: "hit" | "invalidated" | "expired" | "ungraded";
  exitPrice: number | null;
  exitAt: number | null;
  /** Move from spot to the exit, signed so that a move in the setup's direction is positive, as a fraction. */
  movePct: number | null;
  /** movePct minus the round-trip cost modelled at detection. */
  netPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  barsUsed: number;
  reason: string | null;
}

/**
 * Replay the bars after detection. Bars at or before `detectedAt` are
 * ignored; bars after the horizon are ignored. Hit = target touched before
 * invalidation; invalidation first, or both in one bar, = invalidated;
 * neither inside the horizon = expired at the last bar's close. Too few bars
 * to cover the horizon (and the horizon not yet over) = ungraded.
 */
export function gradeSetup(c: Pick<SetupCandidate, "direction" | "spot" | "target" | "invalidation" | "horizonMin" | "costPct">, detectedAt: number, bars: MinuteBar[], nowMs: number): SetupOutcome {
  const sign = c.direction === "up" ? 1 : -1;
  const horizonEnd = detectedAt + c.horizonMin * 60_000;
  const seq = bars.filter((b) => b.t > detectedAt && b.t <= horizonEnd).sort((a, b) => a.t - b.t);
  const base: SetupOutcome = { status: "ungraded", exitPrice: null, exitAt: null, movePct: null, netPct: null, mfePct: null, maePct: null, barsUsed: seq.length, reason: null };
  if (!seq.length) return { ...base, reason: nowMs < horizonEnd ? "horizon still open" : "no bars after detection" };
  let mfe = -Infinity, mae = Infinity;
  const fin2 = (exit: number, at: number, status: SetupOutcome["status"], reason: string | null): SetupOutcome => {
    const move = (sign * (exit - c.spot)) / c.spot;
    return { status, exitPrice: exit, exitAt: at, movePct: r4(move), netPct: r4(move - c.costPct), mfePct: r4(mfe), maePct: r4(mae), barsUsed: seq.length, reason };
  };
  for (const b of seq) {
    const best = sign > 0 ? b.high : b.low, worst = sign > 0 ? b.low : b.high;
    mfe = Math.max(mfe, (sign * (best - c.spot)) / c.spot);
    mae = Math.min(mae, (sign * (worst - c.spot)) / c.spot);
    const hitTarget = sign > 0 ? b.high >= c.target : b.low <= c.target;
    const hitInval = sign > 0 ? b.low <= c.invalidation : b.high >= c.invalidation;
    if (hitInval) return fin2(c.invalidation, b.t, "invalidated", hitTarget ? "target and invalidation in the same bar: counted as a loss" : null);
    if (hitTarget) return fin2(c.target, b.t, "hit", null);
  }
  const last = seq[seq.length - 1];
  if (nowMs < horizonEnd && last.t < horizonEnd - 60_000) return { ...base, reason: "horizon still open" };
  return fin2(last.close, last.t, "expired", "neither target nor invalidation inside the horizon; exit at the horizon close");
}

/** Share positive with a 95% Wilson interval once the sample clears the gate; below it, counts only (no interval, no probability claim). */
export function summarizeOutcomes(nets: number[], minSample: number): { n: number; positive: number; lo: number | null; hi: number | null; meanNetPct: number | null; sampleReady: boolean } {
  const n = nets.length;
  const positive = nets.filter((x) => x > 0).length;
  const sampleReady = n >= minSample;
  if (!n) return { n, positive, lo: null, hi: null, meanNetPct: null, sampleReady: false };
  const mean = r4(nets.reduce((a, b) => a + b, 0) / n);
  if (!sampleReady) return { n, positive, lo: null, hi: null, meanNetPct: mean, sampleReady };
  const p = positive / n, z = 1.96, z2 = z * z, d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { n, positive, lo: r4(Math.max(0, centre - half)), hi: r4(Math.min(1, centre + half)), meanNetPct: mean, sampleReady };
}
