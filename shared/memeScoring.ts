/**
 * Pure research ranking. Original factor budgets are retained, not renormalized:
 * flow 35 + risk-screen structure 25 + sampled social 10 = 70 possible points.
 * Name/narrative bonuses are withheld. This is not a probability or entry model.
 */
export const MEME_SCORE_VERSION = "meme-research-2026-10-01.2";
export const MEME_SCORE_BUDGET = 70;
export const MEME_MARKET_MAX_AGE_MS = 5 * 60_000;
export const MEME_SOCIAL_MAX_AGE_MS = 10 * 60_000;

export interface MemeScoreInput {
  vol5m: number | null;
  vol1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  lastRefreshAt: number | null;
  socialScore: number | null;
  socialCheckedAt: number | null;
  socialCoverage: string;
  hardKill: boolean;
  riskFlagCount: number;
}

export interface MemeScoreBreakdown {
  version: string;
  mode: "research-only";
  evaluatedAt: number;
  marketObservedAt: number | null;
  socialObservedAt: number | null;
  budget: number;
  score: number | null;
  flowScore: number | null;
  volAccel: number | null;
  netBuyRatio5m: number | null;
  contributions: { flow: number | null; structure: number; social: number | null };
  inputStatus: { market: "fresh" | "stale"; flow: "usable" | "missing"; social: "sampled" | "missing" };
  excluded: string[];
}

const nonnegative = (value: number | null) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const fresh = (at: number | null, now: number, maxAge: number) =>
  at != null && Number.isFinite(at) && at <= now && now - at <= maxAge;
const round = (value: number) => Math.round(value * 1000) / 1000;

export function evaluateMemeScore(input: MemeScoreInput, now: number): MemeScoreBreakdown {
  const marketFresh = Number.isFinite(now) && fresh(input.lastRefreshAt, now, MEME_MARKET_MAX_AGE_MS);
  // The 5m interval is included in the 1h baseline. This is a pace ratio, not
  // an independent-window acceleration estimate. Never invent 5x for no baseline.
  const volumeUsable = nonnegative(input.vol5m) && nonnegative(input.vol1h) &&
    input.vol1h! > 0 && input.vol5m! <= input.vol1h!;
  const tradesUsable = nonnegative(input.buys5m) && nonnegative(input.sells5m) &&
    Number.isInteger(input.buys5m) && Number.isInteger(input.sells5m) &&
    input.buys5m! + input.sells5m! > 0;
  const volAccel = volumeUsable ? (input.vol5m! / input.vol1h!) * 12 : null;
  const netBuyRatio5m = tradesUsable ? input.buys5m! / (input.buys5m! + input.sells5m!) : null;
  const flowScore = volAccel != null && netBuyRatio5m != null
    ? Math.min(100, Math.min(40, volAccel * 10) + Math.max(0, (netBuyRatio5m - 0.5) * 100))
    : null;
  const socialUsable = input.socialCoverage === "ok" && nonnegative(input.socialScore) &&
    input.socialScore! <= 100 && fresh(input.socialCheckedAt, now, MEME_SOCIAL_MAX_AGE_MS);
  const flagCount = Number.isFinite(input.riskFlagCount) && input.riskFlagCount >= 0
    ? Math.ceil(input.riskFlagCount) : 5;
  const contributions = {
    flow: flowScore == null ? null : round(flowScore * 0.35),
    structure: input.hardKill ? 0 : Math.max(0, 25 - flagCount * 5),
    social: socialUsable ? round(input.socialScore! * 0.10) : null,
  };
  return {
    version: MEME_SCORE_VERSION, mode: "research-only", evaluatedAt: now,
    marketObservedAt: input.lastRefreshAt, socialObservedAt: input.socialCheckedAt,
    budget: MEME_SCORE_BUDGET,
    score: marketFresh && contributions.flow != null
      ? Math.round(contributions.flow + contributions.structure + (contributions.social ?? 0)) : null,
    flowScore, volAccel, netBuyRatio5m, contributions,
    inputStatus: { market: marketFresh ? "fresh" : "stale",
      flow: flowScore == null ? "missing" : "usable", social: socialUsable ? "sampled" : "missing" },
    excluded: ["name/memeability bonus", "unverified headline-name matches", "paid/trending discovery bonus"],
  };
}
