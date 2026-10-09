// server/tradeEnvState.ts
//
// State of the Trade Environment heuristic composite (pure; tradeEnvironment.ts).
// SF-1: an unavailable driver scores 0, so the index is a LOWER BOUND. A
// missing core driver (gamma, vol, range) never yields a quiet state: the
// state is PARTIAL, or UNAVAILABLE when all three are missing. Any other
// missing driver blocks NORMAL/CHOP/STAND_DOWN (they assert an absence);
// LOADED/STRIKE remain valid because missing points can only raise the score.

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
  if (x.score >= 70) state = "STRIKE";
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
