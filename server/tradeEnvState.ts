// server/tradeEnvState.ts
//
// State of the Trade Environment heuristic composite (pure; tradeEnvironment.ts).
// SF-1: an unavailable driver scores 0, so the index is a LOWER BOUND. A
// missing core driver (gamma, vol, range) never yields a quiet state: the
// state is PARTIAL, or UNAVAILABLE when all three are missing. Any other
// missing driver blocks NORMAL/CHOP/STAND_DOWN (they assert an absence);
// LOADED/STRIKE remain valid because missing points can only raise the score.
//
// R3-2 item 8: STRIKE's headline claims "short gamma, expanding range and
// directional tick volume are present together", so STRIKE requires exactly
// those three observed conditions, not score >= 70 alone. A score >= 70
// without them is LOADED. Missing range or tick volume cannot confirm STRIKE.

export type TradeEnvState = "STAND_DOWN" | "CHOP" | "NORMAL" | "LOADED" | "STRIKE" | "PARTIAL" | "UNAVAILABLE";

export const CORE_DRIVERS = ["gamma", "vol", "range"] as const;

export function classifyEnvState(x: {
  score: number;
  shortGamma: boolean;
  gammaPts: number;
  rangePts: number;
  ofiPts: number;
  volPts: number;
  missing: string[];
  /** r2-b gexSignAtSpot === null: no material gamma at spot, so CHOP (a long-gamma claim) is not made. */
  noMaterialGamma?: boolean;
}): TradeEnvState {
  let state: TradeEnvState;
  if (x.score >= 70) state = strikeConditionsMet(x) ? "STRIKE" : "LOADED";
  else if (x.score >= 45) state = "LOADED";
  else if (x.score >= 25) state = "NORMAL";
  else state = x.shortGamma || x.rangePts > 0 ? "NORMAL" : (x.gammaPts === 0 && !x.shortGamma ? "CHOP" : "STAND_DOWN");
  // CHOP refinement: deep long gamma + quiet flow + calm vol = pin day
  if (x.score < 25 && !x.shortGamma && x.ofiPts === 0 && x.volPts === 0) state = "CHOP";
  else if (x.score < 25 && state !== "CHOP") state = "STAND_DOWN";
  if (state === "CHOP" && x.noMaterialGamma) state = "STAND_DOWN";
  const coreMissing = CORE_DRIVERS.filter((k) => x.missing.includes(k));
  if (coreMissing.length === CORE_DRIVERS.length) return "UNAVAILABLE";
  if (coreMissing.length > 0) return "PARTIAL";
  if (x.missing.length > 0 && (state === "CHOP" || state === "STAND_DOWN" || state === "NORMAL")) return "PARTIAL";
  return state;
}

/** The three conditions STRIKE's headline asserts, each observed (not missing). */
export function strikeConditionsMet(x: { shortGamma: boolean; rangePts: number; ofiPts: number; missing: string[] }): boolean {
  return x.shortGamma && !x.missing.includes("gamma")
    && x.rangePts > 0 && !x.missing.includes("range")
    && x.ofiPts > 0 && !x.missing.includes("ofi");
}

/**
 * Vol term structure points (hand-set): 9D above 30D +12, 3M below 30D
 * (backwardation) +10, VIX >= 20 with a normal back end +4. All three of
 * $VIX, $VIX9D and $VIX3M are required: a missing leg cannot be read as "not
 * inverted" or "not backwardated", so the driver is unavailable (R3-2 item 8).
 */
export function volTermPoints(vix: number | null, vix9d: number | null, vix3m: number | null): {
  ok: boolean; points: number; inverted9d: boolean | null; backwardated: boolean | null; missing: string[];
} {
  const ok = (v: number | null) => v != null && Number.isFinite(v) && v > 0;
  const missing: string[] = [];
  if (!ok(vix)) missing.push("VIX");
  if (!ok(vix9d)) missing.push("VIX9D");
  if (!ok(vix3m)) missing.push("VIX3M");
  if (missing.length) return { ok: false, points: 0, inverted9d: null, backwardated: null, missing };
  const inverted9d = (vix9d as number) > (vix as number);
  const backwardated = (vix3m as number) < (vix as number);
  let points = 0;
  if (inverted9d) points += 12;
  if (backwardated) points += 10;
  if ((vix as number) >= 20 && !backwardated) points += 4;
  return { ok: true, points, inverted9d, backwardated, missing };
}
