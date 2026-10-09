// server/outlookVerdictMath.ts
//
// Pure helpers for the single-name Ticker Outlook verdict (server/tickerOutlook.ts).
// No network, no DB, no SDK imports, so they can be unit-tested.
//
// Sizing: the Outlook shows NO position size. Kelly (1956) needs a win
// probability and a payoff ratio estimated from graded outcomes; single-name
// outlooks have neither (the old "quarter-Kelly" was |composite|/100 x 0.25,
// or a number written by a language model). The 0DTE sizer sizes from the
// Wilson lower bound of the win rate in its realized option-mark ledger
// (graded on real option prices); no such graded ledger exists for
// single-name outlooks yet, so sizing.available is always false.
//
// Scenario weights: bull/base/bear weights are heuristic (hand-set or
// LLM-written), not calibrated probabilities. They are only normalized so the
// three integers are each in [0, 100] and sum to exactly 100.

export const NO_SIZE_REASON =
  "No size: single-name outlooks have no fitted win probability. The old figure was the composite score x 0.25 (or an LLM's number), not Kelly.";

export interface OutlookSizing {
  available: boolean;
  reason: string;
}

/** The only sizing state the Outlook can honestly report today. */
export function noOutlookSizing(): OutlookSizing {
  return { available: false, reason: NO_SIZE_REASON };
}

function finiteOr(x: unknown, fallback: number): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalizes heuristic bull/bear weights (base is the remainder) to integers
 * in [0, 100] that sum to exactly 100.
 *  - Non-numeric inputs fall back to the given fallback weights.
 *  - Negative inputs clamp to 0.
 *  - If bull + bear > 100 they are scaled down proportionally (base = 0);
 *    previously each was only clamped to 100, so 70 + 60 showed 130 in total.
 */
export function normalizeScenarioWeights(
  bullRaw: unknown,
  bearRaw: unknown,
  fallback: { bull: number; bear: number },
): { bull: number; base: number; bear: number } {
  let bull = Math.max(0, finiteOr(bullRaw, fallback.bull));
  let bear = Math.max(0, finiteOr(bearRaw, fallback.bear));
  const total = bull + bear;
  if (total > 100) {
    bull = (bull / total) * 100;
    bear = (bear / total) * 100;
  }
  const b = Math.min(100, Math.round(bull));
  const x = Math.min(100 - b, Math.round(bear));
  return { bull: b, base: 100 - b - x, bear: x };
}
