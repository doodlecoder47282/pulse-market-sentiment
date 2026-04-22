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

// User's locked weekly SPX reference targets (from user context).
// These will be refreshed when the user posts new targets.
const USER_TARGETS = {
  upside: 7140,
  downside: 6950,
  t2Up: 7270,
  t2Down: 6885,
  mopex: 7025,
  vanna: 7089,
  zomma: 7070,
  charm: 7128,
  negGamma: 7100,
  vommaUpper: 7265,
  vommaLower: 6960,
};

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

  return {
    gammaFlip: gamma.zeroGamma != null
      ? { value: gamma.zeroGamma, source: "computed" }
      : null,
    callWall: { value: gamma.callWall, source: "computed" },
    putWall: { value: gamma.putWall, source: "computed" },
    topGexStrikes,
    // Second-order Greek levels — from user targets (not computed from chain)
    vanna: { value: USER_TARGETS.vanna, source: "user_targets" },
    charm: { value: USER_TARGETS.charm, source: "user_targets" },
    vommaUpper: { value: USER_TARGETS.vommaUpper, source: "user_targets" },
    vommaLower: { value: USER_TARGETS.vommaLower, source: "user_targets" },
    zomma: { value: USER_TARGETS.zomma, source: "user_targets" },
    negGamma: { value: USER_TARGETS.negGamma, source: "user_targets" },
    mopex: { value: USER_TARGETS.mopex, source: "user_targets" },
    weeklyTargets: {
      upside:   { value: USER_TARGETS.upside,   source: "user_targets" },
      downside: { value: USER_TARGETS.downside, source: "user_targets" },
      t2Up:     { value: USER_TARGETS.t2Up,     source: "user_targets" },
      t2Down:   { value: USER_TARGETS.t2Down,   source: "user_targets" },
    },
    spxNow,
    asOf: new Date().toISOString(),
  };
}
