// server/gammaLevels.ts
//
// Enhanced gamma levels endpoint — augments computed SPY/SPX gamma structure
// (gamma flip, call wall, put wall, top GEX strikes) with user-defined weekly
// targets for vanna, charm, vomma, zomma, negGamma, and mopex.
//
// Computed levels: from live CBOE chain via getOrBuild() snapshot.
// User targets: locked weekly reference levels from the user's playbook.
// Source field: "computed" | "user_targets" per level.

export interface GammaLevelEntry {
  value: number;
  source: "computed" | "user_targets";
}

export interface GammaLevelsEnhanced {
  gammaFlip: GammaLevelEntry | null;
  callWall: GammaLevelEntry;
  putWall: GammaLevelEntry;
  topGexStrikes: Array<{ strike: number; gex: number; source: "computed" }>;
  vanna: GammaLevelEntry | null;
  charm: GammaLevelEntry | null;
  vommaUpper: GammaLevelEntry | null;
  vommaLower: GammaLevelEntry | null;
  zomma: GammaLevelEntry | null;
  negGamma: GammaLevelEntry | null;
  mopex: GammaLevelEntry | null;
  weeklyTargets: {
    upside: GammaLevelEntry;
    downside: GammaLevelEntry;
    t2Up: GammaLevelEntry;
    t2Down: GammaLevelEntry;
  };
  spxNow: number;
  asOf: string;
}

// User's weekly SPX reference targets — sourced from the single editable store
// (heatseeker-levels.json via heatseekerLevels). Previously duplicated as a
// hard-coded constant here, which drifted from the Heatseeker tab edits.
import { readLevelsSync } from "./heatseekerLevels";

const TARGET_IDS = {
  upside: "upside",
  downside: "downside",
  t2Up: "t2-up",
  t2Down: "t2-down",
  mopex: "mopex",
  vanna: "vanna",
  zomma: "zomma",
  charm: "charm",
  negGamma: "neg-gamma",
  vommaUpper: "upper-vomma",
  vommaLower: "lower-vomma",
} as const;

function userTargets(): Record<keyof typeof TARGET_IDS, number> {
  const levels = readLevelsSync().levels;
  const byId = new Map(levels.map((l) => [l.id, l.value]));
  const out: any = {};
  for (const [key, id] of Object.entries(TARGET_IDS)) out[key] = byId.get(id) ?? 0;
  return out;
}

export function buildGammaLevelsEnhanced(
  // The GammaStructure from the existing snapshot
  gamma: {
    spot: number;
    callWall: number;
    callWallGex: number;
    putWall: number;
    putWallGex: number;
    zeroGamma: number | null;
    maxPain: number;
    profile: Array<{ strike: number; gex: number }>;
    gexCrossoverStrike: number | null;
  },
  spxNow: number,
): GammaLevelsEnhanced {
  // Top 3 absolute GEX strikes from the profile
  const topGexStrikes = gamma.profile
    .slice()
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 3)
    .map((p) => ({ strike: p.strike, gex: p.gex, source: "computed" as const }));

  // SPY callWall/putWall are in SPY points (~10x SPX).
  // Convert to approximate SPX by multiplying by 10 for display,
  // but since the gamma data is already SPY-based, use as-is for SPY context
  // and note the user targets are in SPX terms.
  // We'll show both: computed (SPY) and user targets (SPX).

  const targets = userTargets();

  return {
    gammaFlip: gamma.zeroGamma != null
      ? { value: gamma.zeroGamma, source: "computed" }
      : null,
    callWall: { value: gamma.callWall, source: "computed" },
    putWall: { value: gamma.putWall, source: "computed" },
    topGexStrikes,
    // Second-order Greek levels — from user targets (not computed from chain)
    vanna: { value: targets.vanna, source: "user_targets" },
    charm: { value: targets.charm, source: "user_targets" },
    vommaUpper: { value: targets.vommaUpper, source: "user_targets" },
    vommaLower: { value: targets.vommaLower, source: "user_targets" },
    zomma: { value: targets.zomma, source: "user_targets" },
    negGamma: { value: targets.negGamma, source: "user_targets" },
    mopex: { value: targets.mopex, source: "user_targets" },
    weeklyTargets: {
      upside:   { value: targets.upside,   source: "user_targets" },
      downside: { value: targets.downside, source: "user_targets" },
      t2Up:     { value: targets.t2Up,     source: "user_targets" },
      t2Down:   { value: targets.t2Down,   source: "user_targets" },
    },
    spxNow,
    asOf: new Date().toISOString(),
  };
}
