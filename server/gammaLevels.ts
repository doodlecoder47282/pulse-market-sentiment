// server/gammaLevels.ts
//
// Enhanced gamma levels endpoint — augments computed SPY/SPX gamma structure
// (gamma flip, call wall, put wall, top GEX strikes) with user-defined weekly
// targets for vanna, charm, vomma, zomma, negGamma, and mopex.
//
// Computed levels: from the Schwab SPY chain (0-45 DTE) via the getOrBuild()
// snapshot, in SPY dollars. User targets: locked weekly reference levels from
// the user's playbook, in SPX points. Source field: "computed" | "user_targets"
// per level; `units` states the scale of each source so no consumer measures
// an SPY-scale level against SPX spot (ML features, R2-F: compute SPX
// features from the Schwab $SPX chain instead, e.g. chainAudit/gammaProfile).

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
  /** Scale of each source: computed levels are SPY dollars, user targets SPX points. */
  units: { computed: "SPY"; userTargets: "SPX" };
  /** Computed-level provenance: Schwab chain symbol and when Schwab produced it (epoch s). */
  computedSource: { provider: "schwab"; chainSymbol: "SPY"; chainAsOf: number | null; stale: boolean };
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

// Missing user levels are null (shown as missing), never 0.
function userTargets(): Record<keyof typeof TARGET_IDS, number | null> {
  const levels = readLevelsSync().levels;
  const byId = new Map(levels.map((l) => [l.id, l.value]));
  const out: any = {};
  for (const [key, id] of Object.entries(TARGET_IDS)) {
    const v = byId.get(id);
    out[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

function userEntry(v: number | null): GammaLevelEntry | null {
  return v != null ? { value: v, source: "user_targets" } : null;
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
  provenance: { chainAsOf?: number | null; stale?: boolean } = {},
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
    vanna: userEntry(targets.vanna),
    charm: userEntry(targets.charm),
    vommaUpper: userEntry(targets.vommaUpper),
    vommaLower: userEntry(targets.vommaLower),
    zomma: userEntry(targets.zomma),
    negGamma: userEntry(targets.negGamma),
    mopex: userEntry(targets.mopex),
    // Weekly targets keep their non-null shape because clients read .value
    // directly; the editable store seeds all four ids, so 0 appears only if a
    // user deletes one (TODO: make these nullable together with the readers).
    weeklyTargets: {
      upside:   { value: targets.upside ?? 0,   source: "user_targets" },
      downside: { value: targets.downside ?? 0, source: "user_targets" },
      t2Up:     { value: targets.t2Up ?? 0,     source: "user_targets" },
      t2Down:   { value: targets.t2Down ?? 0,   source: "user_targets" },
    },
    spxNow,
    asOf: new Date().toISOString(),
    units: { computed: "SPY", userTargets: "SPX" },
    computedSource: { provider: "schwab", chainSymbol: "SPY", chainAsOf: provenance.chainAsOf ?? null, stale: provenance.stale ?? false },
  };
}
