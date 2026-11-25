// server/models.ts
//
// Forward-model engine — Daily / Weekly / Monthly price paths for SPX & SPY,
// anchored to the same dealer-exposure math the Trade Desk already uses.
//
// For each horizon:
//   1. Build a dealer exposure profile out to the horizon's DTE window
//      (Daily ≤2 DTE, Weekly ≤7 DTE, Monthly ≤45 DTE).
//   2. From the GEX curve + OI distribution, derive structural anchors:
//        callWall  → upside magnet / resistance
//        putWall   → downside support
//        zeroGamma → regime pivot (positive vs negative gamma)
//        extremeVac → largest negative-GEX strike band (vacuum / tail risk)
//        dominantMag → largest positive-GEX strike (primary magnet)
//        strongMag → 2nd-largest positive-GEX strike
//        mopexMaxPain → classic max-pain (min total $ value of OI)
//        upsidePivot / downsidePivot → call wall + vanna flip / put wall + charm flip
//        vommaPockets → zones where ∂Vega/∂σ spikes (tail IV churn)
//   3. Produce three price paths to end of horizon:
//        BASE path → spot → zeroGamma → dominantMag (gravity)
//        BULL path → spot → dominantMag → callWall → upsidePivot
//        BEAR path → spot → zeroGamma → putWall → downsidePivot
//      Each path is a small number of ordered waypoints with % probability.
//   4. Compute the AUDIT block: near/above/below exposures, slope, OPEX gravity,
//      total GEX, DEX, charm. This matches the screenshot's top-left audit panel.
//
// Scope: SPX ("^GSPC") and SPY only for v1 (options chain is SPY-driven; SPX is
// shown at SPX price scale using SPY's chain rescaled by the ratio — a common
// approach since SPX·0.1 ≈ SPY to a few bps).

import { buildHorizonDates } from "./horizonDates";
import { vixToAtmPct } from "@shared/vol";
import { dexSlopeSignAt, dexSlopeSignValue, dexSlopeLegacyLabel, flipDistanceEM, type DexSlopeSign } from "@shared/gammaRegime";
import { horizonExpectedMove, type HorizonExpectedMove } from "@shared/horizonExpectedMove";
import type { ExposureProfile, ExposureRow } from "./exposureProfile";
import { buildExposureProfile, rowYears } from "./exposureProfile";
import { exposureRowsFromSchwabChain, chainSpot } from "./schwabChainRows";
import { computeGreeks } from "./greeks";
import { gexRegime } from "./gammaProfile";
import { storage } from "./storage";
import { getQuotes as schwabGetQuotes, getOptionChainLadder } from "./schwab";
import { sharedLevels, levelSourceOf, wallBucket, type LevelSource, type SharedLevels, type SharedView } from "./sharedLevels";
import { cdfAt, type ImpliedDistribution } from "./breedenLitzenberger";
import { isRegularSessionOpen } from "./exchangeCalendar";
import { buildOiBasis, chainReadMs, gammaWeighting } from "../shared/gammaBasis";
import {
  etNowParts,
  horizonTargetIso,
  impliedDistributionForExpiry,
  pickExpiryKey,
  quotesFromSchwabExpiry,
  gradedScenarioOdds,
  scenarioOddsFromCdf,
  straddleExpectedMove,
  toPercentTriple,
  type StraddleExpectedMove,
} from "./impliedScenario";
import { fetchOHLC } from "./ohlc";
import { buildMMMatrix } from "./mmMatrix";

// Resolve real SPX spot from Schwab `$SPX`, else the last Schwab $SPX bar (fetchOHLC is Schwab).
// Never derive from SPY×10 — SPY price drifts vs SPX due to accumulated dividends.
async function resolveRealSpxSpot(): Promise<number | null> {
  // 1) Schwab $SPX quote
  try {
    const qs = await schwabGetQuotes(["$SPX"]);
    const p = qs?.[0]?.last;
    if (p != null && Number.isFinite(p) && p > 1000) return p;
  } catch { /* fall through */ }
  // 2) Schwab $SPX price history (same source /api/ohlc uses)
  try {
    const ohlc = await fetchOHLC("^GSPC", "1D");
    if (ohlc?.stale || ohlc?.dataState === "unavailable") return null;
    const p = ohlc?.price ?? ohlc?.candles?.[ohlc.candles.length - 1]?.c ?? null;
    if (p != null && Number.isFinite(p) && p > 1000) return p;
  } catch { /* fall through */ }
  return null;
}

// America/New_York trade date YYYY-MM-DD
function etTradeDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const da = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${da}`;
}

export type Horizon = "daily" | "weekly" | "monthly" | "quarterly";

export interface ModelLevel {
  label: string;
  name: string;                            // short name (e.g. "UPSIDE PIVOT")
  price: number;
  kind:
    | "callWall"
    | "putWall"
    | "zeroGamma"
    | "dominantMag"
    | "strongMag"
    | "extremeVac"
    | "mopexMaxPain"
    | "upsidePivot"
    | "downsidePivot"
    | "spot"
    | "vommaPocket"
    | "t1Up" | "t2Up"
    | "t1Down" | "t2Down"
    // experimental dealer-map kinds (behind ?experimental=1)
    | "vannaFlip"
    | "zommaBridge"
    | "charmTarget"
    | "negGammaEntry"
    | "upperVomma"
    | "lowerVomma";
  gex?: number;                            // $ per 1% (signed)
  tag?: string;                            // "FLOOR" / "CEILING" / "VAC" / "FADES" etc.
  note?: string;
  // Live status vs current spot — server-computed so alert engines and UI
  // share one source of truth instead of each reimplementing the comparator.
  status?: "held" | "approaching" | "broken";
  // Side: "resistance" if level is above spot, "support" if below, "at" if within 0.05%.
  side?: "resistance" | "support" | "at";
  // Distance from current spot in basis points (signed: + means above spot).
  distBps?: number;
}

export interface ModelPathWaypoint {
  label: string;                           // e.g. "MON", "TUE", "WED 7,030"
  t: number;                               // fractional x position 0..1 across horizon
  price: number;
}

export type ScenarioProbSource = "risk-neutral-implied" | "hand-set-heuristic";

export interface ModelPath {
  kind: "base" | "bull" | "bear";
  name: string;
  probability: number;                     // 0..1 (see probabilitySource)
  // Where `probability` comes from. "risk-neutral-implied" = read from the
  // SVI-smoothed implied distribution of the horizon's expiry (Q measure,
  // not a real-world forecast). "hand-set-heuristic" = fixed regime splits,
  // used only when no usable chain is available.
  probabilitySource?: ScenarioProbSource;
  // The event `probability` refers to. Path odds (implied) split terminal
  // prices halfway between the three PATH targets; they are not the event
  // calibration.ts grades (that is audit.scenarioProb, see scenarioProbEvent).
  probabilityEvent?: string;
  pCloseBeyond?: number | null;            // Q: P(S_T beyond target) (bull/bear only)
  pTouch?: number | null;                  // ~ 2 x pCloseBeyond (reflection), null when that does not apply
  touchWithheld?: string | null;           // why pTouch is null (implied odds only)
  /** Price region the path's probability refers to (null bound = open-ended); set with implied odds. */
  region?: { lo: number | null; hi: number | null } | null;
  target: number;                          // end-of-horizon price
  waypoints: ModelPathWaypoint[];
  color: "base" | "bull" | "bear";
}

export interface ModelAudit {
  asOf: number;
  spot: number;
  spotChange: string;                      // e.g. "-40.6 in 14 min" — stubbed to intraday delta
  slope: string;                           // "DN" / "UP" with degrees
  path: string;                            // "liquid path down" / "range-bound"
  opexGravity: string;                     // text describing pull direction
  gexTotal: number;                        // absolute $ per 1%
  dex: number;                             // $B signed
  charmPerDay: number;                     // $B/day signed
  netCTrue: number;                        // Σ charm_strike × OI_strike × 100 (dealer-signed, Perfiliev Table VIII)
  vexPerVolPct: number;                    // $B / 1% vol (signed)
  vannaBias: "positive" | "negative";
  vannaM: number;                          // vanna exposure in $M
  gammaZone: "y+" | "y-" | "y?";           // positive = dampening, negative = amplifying, "y?" = unknown (missing / no material gamma)
  gammaZoneLabel: string;                  // "DAMPENING" / "AMPLIFYING" / "UNKNOWN"
  gammaAtSpot: number;                     // signed GEX at current spot, $M
  // Sign of the dealer delta-exposure slope (dDEX/dS) at spot. A sign only: it is not a flow measure and has no magnitude.
  dexSlopeSign: DexSlopeSign;
  /** @deprecated A SIGN ONLY: +1 / -1 / 0 (0 for flat and for unavailable, see dfiState). Was the "Delta Flow Indicator", which was pinned at +5 / -5; read dexSlopeSign instead. */
  dfi: number;
  /** @deprecated "unavailable" = the DEX curve had fewer than 3 points, so no slope exists. Read dexSlopeSign instead. */
  dfiState: "ok" | "unavailable";
  /** @deprecated "POSITIVE SLOPE" / "NEGATIVE SLOPE" / "FLAT" / "UNAVAILABLE": the sign of the DEX slope, not a bullish / bearish reading. */
  dfiLabel: string;
  dfiFlipped: boolean;                     // true when spot is within 0.3% of the charm zero (NOT a slope sign change; the name is historical)
  gammaFlip: number | null;                // zero-gamma spot (the gamma flip); null when the profile has none
  // Signed distance of spot from the gamma flip in 1-day expected moves, (spot - gammaFlip) / oneDayEM; null when either is missing.
  // The regime bucket reads STRONG at |distance| >= FLIP_DISTANCE_STRONG_EM (shared/gammaRegime.ts), else WEAK.
  flipDistanceEM: number | null;
  contractCount: number;                   // rows in the chain for this horizon
  mainPivot: number | null;                // dominant magnet / zero-gamma — the primary intraday pivot
  charmZero: number | null;               // zero-charm spot (drift target — primary)
  charmZeros: number[];                   // Selz #1 — full charm-zero CLUSTER (within ±3% of spot)
  charmTightening: {                      // Selz #2 — 2nd-derivative / slope based chop flag
    rate: number;                         // |charmSlope| normalised (unitless, >0)
    label: "DECEL" | "STEADY" | "EXPANDING";
    chopFlag: boolean;                    // true when tightening crosses threshold
    note: string;                         // human-readable: "DECEL above 1.5 — chop risk"
  };
  doubleZeroLow: number | null;           // lower bound of double-zero zone
  doubleZeroHigh: number | null;          // upper bound of double-zero zone
  scenarioProb: { bull: number; base: number; bear: number };  // percentages summing to 100
  scenarioProbSource?: ScenarioProbSource;
  scenarioProbNote?: string;
  // The graded event (calibration.ts): bull = close >= scenarioTargets.bull,
  // bear = close <= scenarioTargets.bear, base = neither.
  scenarioProbEvent?: string;
  // Expected move of THIS horizon (1 standard deviation of the close at the
  // horizon's end, index points), shared/horizonExpectedMove.ts. The scenario
  // targets are capped to it and the scenario odds are read at those targets.
  // daily: "0dte-straddle" (same-day ATM straddle, Brenner-Subrahmanyam) else
  // "vix-scaled" (x 0.55 hand-set residual-session factor); other horizons:
  // "implied-atm" (the horizon expiry's SVI-smoothed ATM total vol, the same
  // distribution the odds come from) else "vix-scaled" sqrt(days/252).
  expectedMove?: HorizonExpectedMove;
  impliedDistribution?: {
    expiry: string;
    measure: "risk-neutral";
    method: "svi-smoothed";
    forward: number;
    coverage: number;                      // mass inside the quoted strikes
    fitRmse: number;                       // index points per share
    quotesUsed: number;
    negativeMassClipped: number;
  } | null;
  // Price targets per scenario for the close at the END of this horizon:
  // bull = spot + EM, base = spot, bear = spot - EM,
  // with EM = expectedMove.oneSigma of this horizon (horizonEM). oneDayEM is
  // the 1-day figure (same as horizonEM on the daily card), kept for the
  // intraday target decay (realtimeTargets) and the Discord card.
  scenarioTargets: { bull: number; base: number; bear: number; oneDayEM: number; horizonEM: number; horizonDays: number };
  closeTargets: {                         // Selz #5 — discrete BULL / BASE / BEAR close targets (chart right edge)
    bull:  { price: number; prob: number } | null;
    base:  { price: number; prob: number } | null;
    bear:  { price: number; prob: number } | null;
  };
  lastRecal: {                            // Selz #3 — intraday recal snapshots
    at: number;                           // epoch seconds
    dfi: number;                          // deprecated name: SIGN of the DEX slope at recal time (+1 / -1 / 0)
    dfiDeltaSinceOpen: number | null;     // sign now minus sign at the first snapshot of the day: non-zero = the slope sign changed
  } | null;
  termStructureDoD: {                     // Selz #4 — term structure day-over-day
    iv1d: number | null;                  // today's 1D IV %
    iv1dPrev: number | null;               // yesterday's 1D IV %
    iv1dDelta: number | null;             // iv1d - iv1dPrev (VIX-derived daily sigma, percent)
    vixDeltaPts: number | null;           // the same day-over-day change in VIX points
    charmNow: number;                     // current $B
    charmPrev: number | null;              // yesterday's $B
    label: string;                        // e.g. "Vol Bid Up" / "Vol Offered" / "Flat"
  };
  nearby: {
    price: number;
    note: string;
    dir: "up" | "down";
  }[];
}

export interface ModelHorizon {
  horizon: Horizon;
  /** Where ceiling, floor and turning point come from when they are the shared map's (server/sharedLevels.ts); null = the model's own. */
  levelSource?: LevelSource | null;
  label: string;                           // "SPX DAILY MODEL" etc.
  symbol: string;                          // "^GSPC" | "SPY"
  displaySymbol: string;                   // "SPX" | "SPY"
  spot: number;
  spotAnchorDate: string;                  // "TUE 4/21"
  targetDate: string;                      // "FRI 4/24" (daily = same day; weekly = Fri; monthly = 3rd Friday of next month)
  targetDateLong: string;                  // "Wed Apr 22, 2026"
  priceRange: [number, number];            // y-axis suggested bounds
  // Compression band the market is currently sitting in — derived from the
  // nearest support and resistance to spot. Used by alerts and the daily
  // brief to surface explicit breakout / breakdown trigger prices.
  rangeBox: {
    low: number;
    high: number;
    width: number;                         // high - low
    widthPct: number;                      // (high - low) / spot * 100
    breakoutTrigger: number;               // price that flips bias bullish if exceeded (== high)
    breakdownTrigger: number;              // price that flips bias bearish if broken (== low)
    status: "contained" | "breakout" | "breakdown";  // where spot sits vs the band
    anchorHigh: { name: string; kind: ModelLevel["kind"] } | null;  // which level seeds the high
    anchorLow:  { name: string; kind: ModelLevel["kind"] } | null;  // which level seeds the low
  } | null;
  levels: ModelLevel[];
  paths: ModelPath[];
  audit: ModelAudit;
  vol: {
    vix: number | null;
    vixChangePct: number | null;
    termRatio: number | null;              // vix3m / vix
    termLabel: string;                     // "contango" / "backwardation"
  };
  /** VIX above 20 = "elevated"; a missing VIX is "unavailable", never "normal". */
  vomma: "elevated" | "normal" | "unavailable";
  confidence: "HIGH" | "MODERATE" | "LOW";
  mmMatrix?: import("./mmMatrix").MMMatrix;
  /** Option chain provenance: Schwab symbol, when Schwab produced it (epoch ms), stale flag, strike coverage. */
  chainSource?: "schwab";
  chainSymbol?: string;
  chainAsOfMs?: number;
  chainStale?: boolean;
  /** Market closed: the settled last-session chain (the latest that exists; not stale). */
  chainLastSession?: boolean;
  chainMaxAgeMs?: number;
  chainCoverageComplete?: boolean | null;
  /** Trading date whose end-of-day open interest the gamma levels use, and the weight (shared/gammaBasis.ts). */
  oiBasis?: import("../shared/gammaBasis").OiBasis;
  weighting?: import("../shared/gammaBasis").GammaWeighting;
}

export interface ModelsResponse {
  asOf: number;
  session: "live" | "last-close";          // persisted session vs. live
  /** Set when a stored copy is served after a failed live build (within the chain max age). */
  stale?: boolean;
  /** Oldest chain time behind the served payload, epoch ms. */
  chainAsOfMs?: number | null;
  horizons: Record<Horizon, ModelHorizon | null>;
  warnings: string[];
  experimental?: boolean;                  // true when ?experimental=1 — client can surface extra dealer-map kinds
}

// ──────────────────────────────────────────────────────────────────────────
// Horizon DTE windows
// ──────────────────────────────────────────────────────────────────────────

const DTE_MAX: Record<Horizon, number> = {
  daily: 2,      // 0DTE + next-day
  weekly: 7,     // current week + front-week
  monthly: 45,   // Include monthly OPEX
  quarterly: 100, // 3-month OPEX window (captures next 3 monthly OPEX)
};

// ──────────────────────────────────────────────────────────────────────────
// Per-strike aggregation — groups chain rows by strike, separates call/put
// GEX, computes "dollars of OI" for max pain.
// ──────────────────────────────────────────────────────────────────────────

interface StrikeBucket {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callOi: number;
  putOi: number;
  gamma: number;      // avg gamma (at current spot) across rows in bucket
}

function bucketByStrike(rows: ExposureRow[], spot: number, r: number, q: number): StrikeBucket[] {
  const byStrike = new Map<number, StrikeBucket>();

  for (const row of rows) {
    const T = rowYears(row); // ONE clock (timeToExpiry), 0 once settled
    if (!(T > 0)) continue;
    const g = computeGreeks(spot, row.strike, row.iv, T, r, q, row.type);
    const oiMult = row.oi * 100;
    const gex = g.gamma * oiMult * spot * spot * 0.01; // positive magnitude

    let b = byStrike.get(row.strike);
    if (!b) {
      b = { strike: row.strike, callGex: 0, putGex: 0, netGex: 0, callOi: 0, putOi: 0, gamma: 0 };
      byStrike.set(row.strike, b);
    }
    if (row.type === "C") {
      b.callGex += gex;          // calls contribute positive to net GEX
      b.callOi  += row.oi;
    } else {
      b.putGex  += gex;
      b.putOi   += row.oi;
      // puts contribute negative to net GEX (naive model: dealers short put gamma)
    }
    b.netGex = b.callGex - b.putGex;
    b.gamma = Math.max(b.gamma, g.gamma);
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

// Max-pain = strike where total intrinsic $ value across all OI is minimized.
function maxPain(rows: ExposureRow[]): number | null {
  const strikes = Array.from(new Set(rows.map(r => r.strike))).sort((a,b)=>a-b);
  if (!strikes.length) return null;
  let best = strikes[0], bestVal = Infinity;
  for (const K of strikes) {
    let total = 0;
    for (const r of rows) {
      if (r.type === "C") total += Math.max(0, K - r.strike) * r.oi * 100;
      else                total += Math.max(0, r.strike - K) * r.oi * 100;
    }
    if (total < bestVal) { bestVal = total; best = K; }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Level extraction — finds the key magnets, walls, vacuum, pivots.
// ──────────────────────────────────────────────────────────────────────────

// sigmaBand — expected one-sigma move from VIX and horizon.
// vix is in annualized %; returns a price delta.
// VIX overstates true ATM vol (it prices the whole put wing), so convert
// via VIX_TO_ATM before building the band — otherwise "1σ" is really ~1.15σ.
function sigmaBand(spot: number, vix: number | null, horizon: Horizon): number {
  const vol = vixToAtmPct(Math.max(8, Math.min(80, vix ?? 18))) / 100;  // clamp for sanity
  const days =
    horizon === "daily" ? 1
      : horizon === "weekly" ? 5
      : horizon === "monthly" ? 21
      : 63; // quarterly = 63 trading days
  return spot * vol * Math.sqrt(days / 252);
}

function extractLevels(
  buckets: StrikeBucket[],
  profile: ExposureProfile,
  spot: number,
  rows: ExposureRow[],
  horizon: Horizon,
  vix: number | null,
  experimental: boolean,
  shared?: { ceiling: number | null; floor: number | null } | null,
): ModelLevel[] {
  const out: ModelLevel[] = [];

  // ±2σ search window (constrains DOWNSIDE PIVOT + EXTREME VAC so they
  // don't wander to far-OTM tail strikes with almost no OI).
  const sigma = sigmaBand(spot, vix, horizon);
  const twoSigmaUp = spot + 2 * sigma;
  const twoSigmaDown = spot - 2 * sigma;

  // Call wall — highest positive call GEX within reasonable band (±15%)
  const band = buckets.filter((b) => Math.abs(b.strike - spot) / spot < 0.15);
  // Tight band for vacuum / pivot searches — prevents wandering
  const tight = buckets.filter((b) => b.strike >= twoSigmaDown && b.strike <= twoSigmaUp);
  // With a shared map the ceiling and floor are its levels (server/sharedLevels.ts), so this tab and the top
  // card name one ceiling and one floor; the model's own pick is the fallback.
  const callWall = wallBucket(band, band
    .filter((b) => b.strike >= spot)
    .sort((a, b) => b.callGex - a.callGex)[0], shared?.ceiling);
  if (callWall) {
    out.push({
      label: `CALL WALL ${fmtK(callWall.strike)}`,
      name: "CALL WALL",
      price: callWall.strike,
      kind: "callWall",
      gex: callWall.callGex,
      tag: "CEILING",
    });
  }

  // Put wall — highest put GEX below spot
  const putWall = wallBucket(band, band
    .filter((b) => b.strike <= spot)
    .sort((a, b) => b.putGex - a.putGex)[0], shared?.floor);
  if (putWall) {
    out.push({
      label: `PUT WALL ${fmtK(putWall.strike)}`,
      name: "PUT WALL",
      price: putWall.strike,
      kind: "putWall",
      gex: -putWall.putGex,
      tag: "FLOOR",
    });
  }

  // Zero gamma from profile curve
  if (profile.zeroGammaSpot) {
    out.push({
      label: `ZERO-Γ FLIP ${fmtK(profile.zeroGammaSpot)}`,
      name: "ZERO-Γ FLIP",
      price: profile.zeroGammaSpot,
      kind: "zeroGamma",
      tag: "FLIP",
    });
  }

  // Dominant magnet — largest NET positive GEX near spot
  const positive = band.filter((b) => b.netGex > 0).sort((a, b) => b.netGex - a.netGex);
  if (positive[0]) {
    out.push({
      label: `DOMINANT MAG ${fmtK(positive[0].strike)}`,
      name: "DOMINANT MAG",
      price: positive[0].strike,
      kind: "dominantMag",
      gex: positive[0].netGex,
      tag: "MAG",
    });
  }
  if (positive[1]) {
    out.push({
      label: `STRONG MAG ${fmtK(positive[1].strike)}`,
      name: "STRONG MAG",
      price: positive[1].strike,
      kind: "strongMag",
      gex: positive[1].netGex,
      tag: "MAG",
    });
  }

  // Extreme vacuum — largest net NEGATIVE GEX band (zone of least hedging flow)
  // Constrained to ±2σ so it stops snapping to far-OTM strikes.
  const negative = tight.filter((b) => b.netGex < 0).sort((a, b) => a.netGex - b.netGex);
  if (negative[0]) {
    out.push({
      label: `EXTREME VAC ${fmtK(negative[0].strike)}`,
      name: "EXTREME VAC",
      price: negative[0].strike,
      kind: "extremeVac",
      gex: negative[0].netGex,
      tag: "VAC",
      note: "Liquidity vacuum — moves extend here",
    });
  }

  // Max pain over EVERY expiry in this horizon's DTE window (the strike
  // minimising total intrinsic value across all open interest in the rows),
  // not the monthly expiry alone. The kind id "mopexMaxPain" is kept as the
  // persistent key the backtests and target derivation use; the label says
  // what the number is.
  const mp = maxPain(rows);
  if (mp) {
    out.push({
      label: `WINDOW MAX PAIN ${fmtK(mp)}`,
      name: "WINDOW MAX PAIN",
      price: mp,
      kind: "mopexMaxPain",
      tag: "PIN",
      note: "strike minimising total intrinsic value over all expiries in this horizon's window (not the monthly expiry alone)",
    });
  }

  // Upside pivot — just above call wall, where vanna flip sits if present
  const upPivot = profile.zeroVannaSpot && callWall
    ? (profile.zeroVannaSpot > callWall.strike ? profile.zeroVannaSpot : callWall.strike * 1.008)
    : callWall ? callWall.strike * 1.005 : null;
  if (upPivot) {
    out.push({
      label: `UPSIDE PIVOT ${fmtK(upPivot)}`,
      name: "UPSIDE PIVOT",
      price: upPivot,
      kind: "upsidePivot",
      tag: "VOMMA",
    });
  }

  // Downside pivot — where charm flip sits, or just below put wall.
  // Clamp to ±2σ window — without this, the charm zero-crossing often
  // lands at a far-OTM strike (e.g. 6629) with no economic meaning.
  let downPivotRaw = profile.zeroCharmSpot && putWall
    ? (profile.zeroCharmSpot < putWall.strike ? profile.zeroCharmSpot : putWall.strike * 0.992)
    : putWall ? putWall.strike * 0.995 : null;
  if (downPivotRaw != null) {
    const downPivot = Math.max(downPivotRaw, twoSigmaDown);
    out.push({
      label: `DOWNSIDE PIVOT ${fmtK(downPivot)}`,
      name: "DOWNSIDE PIVOT",
      price: downPivot,
      kind: "downsidePivot",
      tag: "VOMMA",
    });
  }

  // ─── Experimental dealer-map levels (behind ?experimental=1) ───
  // These replicate the @OptionsDepth / Green-Room output: vanna flip,
  // zomma bridge, charm target, negative-gamma entry, upper/lower vomma.
  if (experimental) {
    // VANNA FLIP — the profile's zero-vanna spot, constrained to within 1σ
    // of spot (otherwise it's not the "nearest-to-spot flip" traders watch).
    if (profile.zeroVannaSpot && Math.abs(profile.zeroVannaSpot - spot) <= sigma * 1.5) {
      out.push({
        label: `VANNA FLIP ${fmtK(profile.zeroVannaSpot)}`,
        name: "VANNA FLIP",
        price: profile.zeroVannaSpot,
        kind: "vannaFlip",
        tag: "VANNA",
        note: "Sign change in ∂Δ/∂σ — hedge direction flips here",
      });
    }

    // ZOMMA BRIDGE — ∂Vega/∂σ peak at or below spot. We approximate this
    // from the curve: find spot where gex slope (d gex / d spot) is most
    // negative below current spot, i.e. the "shoulder" where γ compresses
    // fastest when vol rises. Serves as a support shelf when dealers long γ.
    const curveBelow = profile.curve.filter((p) => p.spot <= spot);
    if (curveBelow.length >= 3) {
      let bestIdx = -1, bestSlope = 0;
      for (let i = 1; i < curveBelow.length; i++) {
        const dGex = curveBelow[i].gex - curveBelow[i - 1].gex;
        const dS = curveBelow[i].spot - curveBelow[i - 1].spot;
        const slope = dS !== 0 ? dGex / dS : 0;
        if (slope > bestSlope) { bestSlope = slope; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const zStrike = curveBelow[bestIdx].spot;
        if (zStrike >= twoSigmaDown) {
          out.push({
            label: `ZOMMA BRIDGE ${fmtK(zStrike)}`,
            name: "ZOMMA BRIDGE",
            price: zStrike,
            kind: "zommaBridge",
            tag: "SHELF",
            note: "∂Vega/∂σ shelf — vol-expansion support",
          });
        }
      }
    }

    // CHARM TARGET — where accumulated charm wants price to drift by expiry.
    // Take the callWall-side charm magnet: if dealers are short-γ and
    // long-charm above spot, charm decay pulls spot upward toward the strike
    // with highest |charm × OI|. We approximate with the highest netGex
    // strike above spot within 1σ.
    const charmBand = buckets.filter((b) => b.strike > spot && b.strike <= spot + sigma * 1.5);
    const charmTarget = charmBand.sort((a, b) => b.netGex - a.netGex)[0];
    if (charmTarget) {
      out.push({
        label: `CHARM TGT ${fmtK(charmTarget.strike)}`,
        name: "CHARM TARGET",
        price: charmTarget.strike,
        kind: "charmTarget",
        gex: charmTarget.netGex,
        tag: "DECAY",
        note: "Charm-decay magnet — dealers re-hedge toward here into close",
      });
    }

    // NEG γ ENTRY — first strike above spot where cumulative net-GEX flips
    // negative. This is the price level where dealer hedging starts amplifying
    // moves (the ignition point). Walk up from spot.
    const above = buckets.filter((b) => b.strike >= spot).sort((a, b) => a.strike - b.strike);
    let cum = 0;
    let negEntry: number | null = null;
    for (const b of above) {
      cum += b.netGex;
      if (cum < 0) { negEntry = b.strike; break; }
    }
    if (negEntry != null && negEntry <= twoSigmaUp) {
      out.push({
        label: `NEG γ ENTRY ${fmtK(negEntry)}`,
        name: "NEG γ ENTRY",
        price: negEntry,
        kind: "negGammaEntry",
        tag: "IGNITION",
        note: "Cumulative γ turns negative — trend-extension zone starts here",
      });
    }

    // UPPER VOMMA / LOWER VOMMA — far-OTM vomma peaks. Proxy: highest |netGex|
    // strike in the 1σ→2.5σ zone on each side (tails where ∂Vega/∂σ spikes).
    const upperBand = buckets.filter(
      (b) => b.strike > spot + sigma && b.strike <= spot + sigma * 2.5,
    );
    const upperVomma = upperBand.sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0];
    if (upperVomma) {
      out.push({
        label: `UPPER VOMMA ${fmtK(upperVomma.strike)}`,
        name: "UPPER VOMMA",
        price: upperVomma.strike,
        kind: "upperVomma",
        gex: upperVomma.netGex,
        tag: "TAIL",
        note: "Upside vomma pocket — IV-churn zone",
      });
    }

    const lowerBand = buckets.filter(
      (b) => b.strike < spot - sigma && b.strike >= spot - sigma * 2.5,
    );
    const lowerVomma = lowerBand.sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))[0];
    if (lowerVomma) {
      out.push({
        label: `LOWER VOMMA ${fmtK(lowerVomma.strike)}`,
        name: "LOWER VOMMA",
        price: lowerVomma.strike,
        kind: "lowerVomma",
        gex: lowerVomma.netGex,
        tag: "TAIL",
        note: "Downside vomma pocket — IV-churn zone",
      });
    }
  }

  // T1/T2 up/down — simple ATR-ish targets from GEX profile range
  const rng = profile.ranges.gex.max - profile.ranges.gex.min;
  const spread = Math.abs(callWall && putWall ? callWall.strike - putWall.strike : spot * 0.02);
  const t1Up = spot + spread * 0.8;
  const t2Up = spot + spread * 1.6;
  const t1Down = spot - spread * 0.8;
  const t2Down = spot - spread * 1.6;
  out.push({ label: `T1 UP ${fmtK(t1Up)}`, name: "T1 UP", price: t1Up, kind: "t1Up" });
  out.push({ label: `T2 UP ${fmtK(t2Up)}`, name: "T2 UP", price: t2Up, kind: "t2Up" });
  out.push({ label: `T1 DOWN ${fmtK(t1Down)}`, name: "T1 DOWN", price: t1Down, kind: "t1Down" });
  out.push({ label: `T2 DOWN ${fmtK(t2Down)}`, name: "T2 DOWN", price: t2Down, kind: "t2Down" });

  return out.sort((a, b) => b.price - a.price);
}

// ──────────────────────────────────────────────────────────────────────────
// Path generation — BASE / BULL / BEAR waypoints across the horizon.
// ──────────────────────────────────────────────────────────────────────────

/** Dealer gamma regime of an exposure profile: material sign at spot, else "unknown". */
function profileGexRegime(profile: ExposureProfile): "positive" | "negative" | "unknown" {
  const peak = Math.max(0, ...profile.curve.map((p) => (Number.isFinite(p.gex) ? Math.abs(p.gex) : 0)));
  return gexRegime(profile.current?.gex, peak, profile.contractCount ?? 0);
}

function generatePaths(
  levels: ModelLevel[],
  spot: number,
  profile: ExposureProfile,
  horizon: Horizon,
  waypointDates: string[],
): ModelPath[] {
  const byKind = (k: string) => levels.find((l) => l.kind === k);
  const callWall = byKind("callWall");
  const putWall = byKind("putWall");
  const dominantMag = byKind("dominantMag");
  const strongMag = byKind("strongMag");
  const zeroGamma = byKind("zeroGamma");
  const upsidePivot = byKind("upsidePivot");
  const downsidePivot = byKind("downsidePivot");
  const t1Up = byKind("t1Up")!;
  const t1Down = byKind("t1Down")!;

  const regime = profileGexRegime(profile);

  // Probability split reflects regime:
  //   positive GEX → dampening → BASE gets highest weight (range-bound drift to magnet)
  //   negative GEX → amplifying → BULL / BEAR more likely (trends extend)
  //   unknown (no usable contracts, GEX exactly 0 or below the materiality
  //   floor) → NO regime split: equal weights, labelled (round 3, N3-3; it
  //   used to fall into the negative branch). These placeholders are replaced
  //   by the risk-neutral odds or the audit's split in buildHorizon.
  const probs = regime === "positive"
    ? { base: 0.45, bull: 0.30, bear: 0.25 }
    : regime === "negative"
      ? { base: 0.30, bull: 0.30, bear: 0.40 }
      : { base: 1 / 3, bull: 1 / 3, bear: 1 / 3 };

  const nWay = waypointDates.length;

  function path(
    kind: "base" | "bull" | "bear",
    endPrice: number,
    waypoints: number[],          // price at each intermediate date
  ): ModelPath {
    const wps: ModelPathWaypoint[] = waypointDates.map((d, i) => ({
      label: i === nWay - 1 ? `${d} ${fmtK(endPrice)}` : d,
      t: i / Math.max(1, nWay - 1),
      price: waypoints[i] ?? endPrice,
    }));
    // Force first waypoint to spot, last to endPrice
    wps[0].price = spot;
    wps[nWay - 1].price = endPrice;
    return {
      kind,
      name: kind === "base" ? "BASE" : kind === "bull" ? "BULL" : "BEAR",
      probability: probs[kind],
      target: endPrice,
      waypoints: wps,
      color: kind,
    };
  }

  // BASE = gravitate toward dominant magnet (or zero-γ if no magnet)
  const baseTarget = dominantMag?.price ?? zeroGamma?.price ?? spot;
  const basePath = path(
    "base",
    baseTarget,
    lerpPath(spot, baseTarget, nWay, 0.6),
  );

  // BULL = push through zero-γ → strong mag → call wall (capped at upside pivot).
  // Via waypoint must sit ABOVE spot AND BELOW the bull target — otherwise
  // midPath would send the bull path through a pivot on the wrong side
  // (e.g. a magnet that sits under spot) before arcing up to the target,
  // which produces a non-monotonic curve that dips below spot first.
  const bullTarget = upsidePivot?.price ?? callWall?.price ?? spot * 1.01;
  const bullViaRaw = strongMag?.price ?? zeroGamma?.price ?? spot * 1.003;
  const bullVia = bullViaRaw > spot && bullViaRaw < bullTarget ? bullViaRaw : null;
  const bullPath = path(
    "bull",
    bullTarget,
    bullVia ? [spot, ...midPath(spot, bullVia, bullTarget, nWay - 1)] : lerpPath(spot, bullTarget, nWay, 1.0),
  );

  // BEAR = break below put wall → downside pivot. Cap distance to avoid nonsense
  // multi-percent drops on weekly/monthly when the put wall sits right under spot.
  let bearTarget = downsidePivot?.price ?? putWall?.price ?? spot * 0.99;
  // Sanity clamp: bear target shouldn't exceed ~3% below spot for daily, ~5%
  // for weekly, ~7% for monthly — otherwise the curve dominates the chart.
  const maxDropPct =
    horizon === "daily" ? 0.03
      : horizon === "weekly" ? 0.05
      : horizon === "monthly" ? 0.07
      : 0.12;  // quarterly allows wider drawdown range
  if (bearTarget < spot * (1 - maxDropPct)) bearTarget = spot * (1 - maxDropPct);
  // Via waypoint must sit BELOW spot AND ABOVE the bear target. Without this
  // check, if zero-gamma is above spot (common in positive gamma regimes),
  // the bear curve is forced UP through it before collapsing — so the 12:00
  // bear waypoint ends up higher than the bull waypoint. Hard fallback to
  // a monotone linear path when no valid downside pivot is available.
  const bearViaRaw = zeroGamma?.price ?? t1Down.price;
  const bearVia = bearViaRaw && bearViaRaw < spot && bearViaRaw > bearTarget ? bearViaRaw : null;
  const bearPath = path(
    "bear",
    bearTarget,
    bearVia ? [spot, ...midPath(spot, bearVia, bearTarget, nWay - 1)] : lerpPath(spot, bearTarget, nWay, 1.0),
  );

  return [basePath, bullPath, bearPath];
}

function lerpPath(from: number, to: number, n: number, curve: number): number[] {
  // curve 0→1 controls how fast the move happens. curve=1 → linear, curve<1 →
  // front-loaded (fast move then drift), curve>1 → back-loaded.
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    const eased = Math.pow(t, curve);
    xs.push(from + (to - from) * eased);
  }
  return xs;
}

// 3-leg path: spot → via at midpoint → end
function midPath(spot: number, via: number, end: number, nAfter: number): number[] {
  if (nAfter < 2) return [end];
  const half = Math.max(1, Math.floor(nAfter / 2));
  const leg1 = lerpPath(spot, via, half + 1, 1.0).slice(1);
  const leg2 = lerpPath(via, end, nAfter - half + 1, 1.0).slice(1);
  return [...leg1, ...leg2];
}

// ──────────────────────────────────────────────────────────────────────────
// Audit block — right-sized summary matching the screenshot's top-left panel
// ──────────────────────────────────────────────────────────────────────────

// ─── Scenario probabilities ──────────────────────────────────────────────────
// Hand-set fallback, used only when the options-implied (risk-neutral) odds
// are unavailable. Derived from gamma regime, VIX term structure, and
// proximity to call/put walls.
//
// heuristic:
//   baseProb starts at 0.37 — positive GEX (dampening) boosts it, negative cuts it.
//   (Until 2026-11-17 a "DFI" boost of 0.10 * tanh(dfi / 3) tilted bull or bear.
//   DFI was pinned at +5 / -5, so the boost was a constant 0.093 in the direction
//   of the DEX slope sign: a second count of the gamma term. Removed.)
//   #5: VIX term ratio < 1 (backwardation/inversion) = stress → bear weight up,
//   base weight cut. Term ratio >> 1 (steep contango) = calm → base weight up.
//   #5: spot within 50bps of call wall caps bull (gamma resistance overhead);
//   spot within 50bps of put wall caps bear (gamma support below). Within 15bps
//   the cap is harder still — scenarios collapse toward base.
//   Normalise to sum = 100, clamp each to minimum 10%.
export function computeScenarioProb(
  gammaZone: "y+" | "y-" | "y?",
  ctx?: {
    vixTermRatio: number | null;
    callWallDistBps: number | null;   // signed: + means wall above spot
    putWallDistBps: number | null;    // signed: - means wall below spot
  },
): { bull: number; base: number; bear: number } {
  // Unknown regime ("y?": missing or immaterial GEX): no regime adjustment.
  const rawBase = 0.37 + (gammaZone === "y+" ? 0.08 : gammaZone === "y-" ? -0.08 : 0);

  // #5a: VIX term structure tilt
  // term < 1 = backwardation (front-month richer than 3m) = stress
  // term > 1 = contango (calm)
  // map to a [-0.06, +0.04] tilt range; 1.0 = neutral
  let termBearTilt = 0;
  let termBaseTilt = 0;
  const term = ctx?.vixTermRatio ?? null;
  if (term != null) {
    if (term < 1) {
      // stress regime: punish base, reward bear
      const stress = Math.min(1, (1 - term) / 0.10); // 0..1 ramp; full at 0.90
      termBearTilt = 0.06 * stress;
      termBaseTilt = -0.04 * stress;
    } else {
      // calm regime: reward base modestly
      const calm = Math.min(1, (term - 1) / 0.15); // full at 1.15
      termBaseTilt = 0.04 * calm;
    }
  }

  let bull = 0.20;
  let bear = 0.25 + termBearTilt;
  let base = rawBase + termBaseTilt;

  // #5b: γ-wall distance caps. When spot is right under a call wall, upside
  // gets blocked by gamma resistance — shrink bull. When right above put wall,
  // downside is cushioned — shrink bear. The closer, the harder the cap.
  const callDist = ctx?.callWallDistBps ?? null;
  const putDist = ctx?.putWallDistBps ?? null;
  // Only matters when wall is on the relevant side of spot (call above, put below)
  if (callDist != null && callDist > 0 && callDist < 50) {
    // 0bps = full damp, 50bps = none
    const damp = (50 - callDist) / 50;            // 0..1
    const shrink = 0.40 * damp;                   // up to 40% bull haircut
    const moved = bull * shrink;
    bull -= moved;
    base += moved;
  }
  if (putDist != null && putDist < 0 && Math.abs(putDist) < 50) {
    const damp = (50 - Math.abs(putDist)) / 50;
    const shrink = 0.40 * damp;
    const moved = bear * shrink;
    bear -= moved;
    base += moved;
  }

  // Normalise
  const total = bull + bear + base;
  bull /= total; bear /= total; base /= total;

  // Clamp to minimum 10% each
  const clamp = (v: number) => Math.max(0.10, Math.min(0.80, v));
  bull = clamp(bull); base = clamp(base); bear = clamp(bear);

  // Re-normalise after clamping
  const total2 = bull + bear + base;
  bull /= total2; bear /= total2; base /= total2;

  return {
    bull: Math.round(bull * 100),
    base: Math.round(base * 100),
    bear: Math.round(bear * 100),
  };
}

function buildAudit(
  profile: ExposureProfile,
  levels: ModelLevel[],
  spot: number,
  intradayDelta: { change: number | null; windowMin: number | null },
  extras: {
    paths: ModelPath[];
    scenarioProbIn?: { bull: number; base: number; bear: number };
    // Implied CDF P(S_T <= K) of this horizon's expiry; when present the
    // audit scenarioProb is the risk-neutral probability of the graded events.
    impliedCdf?: ((K: number) => number) | null;
    iv1d: number | null;
    iv1dPrev: number | null;
    charmPrev: number | null;
    lastRecal: { at: number; dfi: number; dfiDeltaSinceOpen: number | null } | null;
    vixTermRatio?: number | null;
    vixForEM?: number | null;
    vix9d?: number | null;
    straddleEM?: StraddleExpectedMove | null;
    impliedDistribution?: ModelAudit["impliedDistribution"];
    /** sigma_ATM sqrt(T) of the accepted implied distribution (the one impliedCdf reads), for the horizon EM. */
    impliedAtmTotalVol?: number | null;
    horizon: Horizon;
  },
): ModelAudit {
  const cur = profile.current;
  const byKind = (k: string) => levels.find((l) => l.kind === k);

  const slopeDir = cur.charm > 0 ? "UP" : "DN";
  const slopeDeg = Math.min(2.0, Math.abs(cur.charm) / 1e9 * 0.5).toFixed(2);
  // Regime only from material gamma at spot (round 3, N3-3): missing, an
  // exact 0 or sub-floor noise is UNKNOWN, not positive or negative.
  const regimeA = profileGexRegime(profile);
  const gammaZone: "y+" | "y-" | "y?" = regimeA === "positive" ? "y+" : regimeA === "negative" ? "y-" : "y?";
  const gammaZoneLabel = regimeA === "positive" ? "DAMPENING" : regimeA === "negative" ? "AMPLIFYING" : "UNKNOWN";

  // Path classification from the material-gamma regime (not the raw GEX
  // sign: sub-floor noise or missing GEX is UNKNOWN) + charm direction.
  let path = "range-bound";
  if (gammaZone === "y?") path = "gamma unknown (no path claim)";
  else if (gammaZone === "y-" && cur.charm < 0) path = "liquid path down";
  else if (gammaZone === "y-" && cur.charm > 0) path = "liquid path up";
  else if (gammaZone === "y+" && cur.charm < 0) path = "grind down into pin";
  else if (gammaZone === "y+" && cur.charm > 0) path = "grind up into pin";

  // OPEX gravity — direction to nearest mopex max pain * distance in bps
  const mp = byKind("mopexMaxPain")?.price;
  let opexGravity = "—";
  if (mp) {
    const bps = Math.round((mp - spot) / spot * 10000);
    const arrow = bps > 0 ? "↑" : bps < 0 ? "↓" : "→";
    opexGravity = `${Math.abs(bps)}pt ${bps >= 0 ? "above" : "below"} ${fmtK(mp)} ${arrow} ${Math.abs(bps / 100).toFixed(1)}%`;
  }

  const nearby: ModelAudit["nearby"] = levels
    .filter((l) => l.kind !== "t1Up" && l.kind !== "t2Up" && l.kind !== "t1Down" && l.kind !== "t2Down" && l.kind !== "vommaPocket")
    .slice(0, 6)
    .map((l) => ({
      price: l.price,
      note: `${Math.round((l.price - spot) / spot * 10000)}bp · ${l.name}`,
      dir: l.price >= spot ? "up" : "down",
    }));

  const vannaBias: "positive" | "negative" = cur.vex >= 0 ? "positive" : "negative";
  // Vanna in $M. cur.vex is raw dollars of delta-notional change per 1 vol pt
  // (vanna · OI · 100 · S · 0.01, summed) — so $M is simply vex / 1e6.
  // MISSION FIX audit note: scale verified against exposureProfile.ts:92; the
  // old comment implied a different unit chain but the math was already right.
  const vannaM = parseFloat((cur.vex / 1e6).toFixed(1));

  const spotChange = (intradayDelta.change != null && intradayDelta.windowMin != null)
    ? `${intradayDelta.change >= 0 ? "+" : ""}${intradayDelta.change.toFixed(1)} in ${intradayDelta.windowMin} min`
    : "";

  // DEX slope sign: the sign of dDEX/dS on the exposure curve at spot.
  // This was the "Delta Flow Indicator": the slope divided by |GEX| and scaled
  // by 1e9, clamped to [-5, 5]. The scaling pinned it at the clamp, so it only
  // ever carried this sign. The scaling and the clamp are gone; `dfi` stays in
  // the payload as the sign (+1 / -1 / 0) for stored rows and older clients.
  // With fewer than 3 curve points there is no slope: "unavailable", dfi 0.
  const dexSlopeSign = dexSlopeSignAt(profile.curve, spot);
  const dfi = dexSlopeSignValue(dexSlopeSign);
  const dfiState: "ok" | "unavailable" = dexSlopeSign === "unavailable" ? "unavailable" : "ok";
  const dfiLabel = dexSlopeLegacyLabel(dexSlopeSign);
  // dfiFlipped: for real-time use — here we mark true when we're near the charm zero crossover
  const charmZero = profile.zeroCharmSpot;
  const dfiFlipped = charmZero != null && Math.abs(charmZero - spot) / spot < 0.003;

  // Main pivot: zero-gamma if present, otherwise dominant magnet
  const mainPivot = byKind("zeroGamma")?.price ?? byKind("dominantMag")?.price ?? null;

  // Double Zero Zone: the band between zero-gamma and zero-charm (where both flip sign)
  const zg = profile.zeroGammaSpot;
  const zc = profile.zeroCharmSpot;
  let doubleZeroLow: number | null = null;
  let doubleZeroHigh: number | null = null;
  if (zg != null && zc != null) {
    doubleZeroLow = Math.min(zg, zc);
    doubleZeroHigh = Math.max(zg, zc);
  }

  // Gamma at spot (signed GEX, for display)
  const gammaAtSpot = parseFloat((cur.gex / 1e6).toFixed(0)); // $M

  // #5: γ-wall distances (signed bps from spot) for scenario weighting
  const callWallPrice = byKind("callWall")?.price ?? null;
  const putWallPrice = byKind("putWall")?.price ?? null;
  const callWallDistBps = callWallPrice != null
    ? Math.round(((callWallPrice - spot) / spot) * 10_000)
    : null;
  const putWallDistBps = putWallPrice != null
    ? Math.round(((putWallPrice - spot) / spot) * 10_000)
    : null;
  let scenarioProb = extras.scenarioProbIn ?? computeScenarioProb(gammaZone, {
    vixTermRatio: extras.vixTermRatio ?? null,
    callWallDistBps,
    putWallDistBps,
  });

  // ─── Scenario TARGETS (price levels per scenario for the close at the END of this horizon) ──
  //   BULL = spot + EM, BASE = spot, BEAR = spot - EM
  // EM is the 1-sigma move to THIS horizon's end (shared/horizonExpectedMove.ts): the same-day straddle for
  // the daily card; for the other horizons the ATM total vol of the horizon expiry's implied distribution
  // (the same distribution the odds below are read from), else a VIX cone.
  const vixForEM = extras.vixForEM ?? null;
  const straddle = extras.straddleEM ?? null;
  const expectedMove: HorizonExpectedMove = horizonExpectedMove({
    spot, horizon: extras.horizon, vix: vixForEM, vix9d: extras.vix9d ?? null,
    straddle: extras.horizon === "daily" && straddle ? { oneSigmaMove: straddle.oneSigmaMove, straddleMid: straddle.straddleMid, strike: straddle.strike } : null,
    implied: extras.horizon !== "daily" && extras.impliedAtmTotalVol != null && extras.impliedDistribution?.expiry
      ? { atmTotalVol: extras.impliedAtmTotalVol, expiry: extras.impliedDistribution.expiry }
      : null,
  });
  const horizonEM = expectedMove.oneSigma;
  // The 1-day figure for the intraday decay and the Discord card (identical on the daily card).
  const oneDayEM = extras.horizon === "daily"
    ? horizonEM
    : horizonExpectedMove({ spot, horizon: "daily", vix: vixForEM, straddle: straddle ? { oneSigmaMove: straddle.oneSigmaMove, straddleMid: straddle.straddleMid, strike: straddle.strike } : null }).oneSigma;

  // Scenario targets: spot + 1 EM, spot, spot - 1 EM of THIS horizon. That is what this code has always
  // produced: the "nearest structural resistance / support, capped to EM" described here before never
  // happened, because it filtered on `side`, a field the levels only receive later (enrichedLevels), so
  // both lists were always empty and the caps were always the answer. The event the odds and the
  // calibration record have always been about is therefore "close beyond 1 sigma of the horizon", a
  // stable, comparable event. Kept, and now said plainly. (A structural version would put the bull
  // target at the nearest of a dozen level kinds, often a few points from spot, and change what every
  // graded forecast so far was a forecast of: a model change for the owner to decide, not a silent fix.)
  const bullTarget = spot + horizonEM;
  const baseTarget = spot;
  const bearTarget = spot - horizonEM;

  const scenarioTargets = {
    bull: parseFloat(bullTarget.toFixed(2)),
    base: parseFloat(baseTarget.toFixed(2)),
    bear: parseFloat(bearTarget.toFixed(2)),
    oneDayEM: parseFloat(oneDayEM.toFixed(2)),
    horizonEM: parseFloat(horizonEM.toFixed(2)),
    horizonDays: expectedMove.days,
  };

  // Risk-neutral odds of exactly the events calibration.ts grades against
  // these targets, so the logged Brier scores the number that was shown.
  let scenarioProbSource: ScenarioProbSource = "hand-set-heuristic";
  if (extras.impliedCdf) {
    const g = gradedScenarioOdds(extras.impliedCdf, { bull: scenarioTargets.bull, bear: scenarioTargets.bear });
    if (g) {
      scenarioProb = toPercentTriple(g);
      scenarioProbSource = "risk-neutral-implied";
    }
  }
  // Paths carry their own (halfway-partition) odds when implied; otherwise
  // they show the same heuristic split as the audit.
  const pathPct = (p: ModelPath | undefined, k: "bull" | "base" | "bear") =>
    p && p.probabilitySource === "risk-neutral-implied" ? Math.round(p.probability * 100) : scenarioProb[k];

  // Selz #1 — charm-zero CLUSTER filtered to ±3% of spot
  const charmZeros = profile.zeroCharmSpots.filter((x) => Math.abs(x - spot) / spot <= 0.03);

  // Selz #2 — charm tightening: normalise |dCharm/dS| against the curve's own
  // charm range and spot range, giving a unitless "tightening index".
  // rate ≈ 1 means charm traverses its full range over the full spot window.
  // rate >> 1 means the slope at spot is much steeper than the avg slope —
  // charm is tightening fast around current spot (chop risk).
  const charmRange = Math.max(1, profile.ranges.charm.max - profile.ranges.charm.min);
  const spotRange = Math.max(1, spot * 0.1); // ±5% spot window baseline
  const avgSlope = charmRange / spotRange;
  const rawRate = avgSlope > 0 ? Math.abs(profile.charmSlope) / avgSlope : 0;
  const rate = parseFloat(rawRate.toFixed(2));
  // Thresholds tuned for this index: >3 = meaningful tightening near spot,
  // <0.8 = slope shallower than average (charm expanding), middle = steady.
  const CHOP_THRESHOLD = 3;
  let tightenLabel: "DECEL" | "STEADY" | "EXPANDING" = "STEADY";
  if (rate > CHOP_THRESHOLD) tightenLabel = "DECEL";
  else if (rate < 0.8) tightenLabel = "EXPANDING";
  const charmTightening = {
    rate,
    label: tightenLabel,
    chopFlag: tightenLabel === "DECEL",
    note: tightenLabel === "DECEL"
      ? `DECEL above ${CHOP_THRESHOLD} — charm tightening fast, chop risk into close`
      : tightenLabel === "EXPANDING"
        ? "Charm slope slackening — directional path easier"
        : "Charm slope steady — range-bound drift",
  };

  // Selz #5 — discrete BULL / BASE / BEAR close targets pulled straight from paths
  const bullPath = extras.paths.find((p) => p.kind === "bull");
  const basePath = extras.paths.find((p) => p.kind === "base");
  const bearPath = extras.paths.find((p) => p.kind === "bear");
  const closeTargets = {
    bull: bullPath ? { price: bullPath.target, prob: pathPct(bullPath, "bull") } : null,
    base: basePath ? { price: basePath.target, prob: pathPct(basePath, "base") } : null,
    bear: bearPath ? { price: bearPath.target, prob: pathPct(bearPath, "bear") } : null,
  };

  // Selz #4 — term structure DoD
  const iv1dNow = extras.iv1d;
  const iv1dDelta = (iv1dNow != null && extras.iv1dPrev != null) ? iv1dNow - extras.iv1dPrev : null;
  const charmNow = cur.charm / 1e9;
  const charmDelta = extras.charmPrev != null ? charmNow - extras.charmPrev : null;
  // The same change in VIX points. iv1d is a VIX-derived DAILY sigma in percent (vixToAtmPct(vix) / sqrt(252)),
  // so a 4-point VIX day moves it by about 0.22: the 0.25 test below and the MM matrix's ">= 1.0, VIX moved
  // over 1 pt" were both reading that number as VIX points and almost never fired. Both now read points.
  const VIX_PTS_PER_IV1D = vixToAtmPct(1) > 0 ? Math.sqrt(252) / vixToAtmPct(1) : null;
  const vixDeltaPts = iv1dDelta != null && VIX_PTS_PER_IV1D != null ? parseFloat((iv1dDelta * VIX_PTS_PER_IV1D).toFixed(2)) : null;
  let dodLabel = "Flat";
  if (vixDeltaPts != null && Math.abs(vixDeltaPts) >= 1.0) {
    dodLabel = vixDeltaPts > 0 ? "Vol Bid Up" : "Vol Offered";
  } else if (charmDelta != null && Math.abs(charmDelta) >= 0.5) {
    dodLabel = charmDelta > 0 ? "Charm Lifting" : "Charm Pressing";
  }
  const termStructureDoD = {
    iv1d: iv1dNow,
    iv1dPrev: extras.iv1dPrev,
    iv1dDelta,
    vixDeltaPts,
    charmNow: parseFloat(charmNow.toFixed(2)),
    charmPrev: extras.charmPrev,
    label: dodLabel,
  };

  return {
    asOf: Math.floor(Date.now() / 1000),
    spot,
    spotChange,
    slope: `${slopeDir} ${slopeDeg}° → ${cur.charm >= 0 ? "+" : ""}${(cur.charm / 1e9).toFixed(2)}`,
    path,
    opexGravity,
    gexTotal: cur.gex,
    dex: cur.dex / 1e9,
    charmPerDay: cur.charm / 1e9,
    netCTrue: profile.netCTrue,
    vexPerVolPct: cur.vex / 1e9,
    vannaBias,
    vannaM,
    gammaZone,
    gammaZoneLabel,
    gammaAtSpot,
    dexSlopeSign,
    dfi,
    dfiState,
    dfiLabel,
    dfiFlipped,
    gammaFlip: profile.zeroGammaSpot ?? null,
    flipDistanceEM: (() => { const d = flipDistanceEM(spot, profile.zeroGammaSpot, oneDayEM); return d == null ? null : parseFloat(d.toFixed(3)); })(),
    contractCount: profile.contractCount,
    mainPivot,
    charmZero,
    doubleZeroLow,
    doubleZeroHigh,
    scenarioProb,
    scenarioProbSource,
    scenarioProbNote: scenarioProbSource === "risk-neutral-implied"
      ? "Risk-neutral (options-implied) probability of the graded events: close >= bull target, close <= bear target, else base (SVI-smoothed distribution of this horizon's expiry). Not a real-world forecast."
      : "Heuristic: hand-set regime splits with flow/term-structure tilts. Not calibrated to outcomes.",
    scenarioProbEvent: `bull: close >= ${scenarioTargets.bull}; bear: close <= ${scenarioTargets.bear}; base: neither (${extras.horizon} horizon${extras.impliedDistribution?.expiry ? `, ${extras.impliedDistribution.expiry} close` : ""})`,
    expectedMove,
    impliedDistribution: extras.impliedDistribution ?? null,
    scenarioTargets,
    closeTargets,
    lastRecal: extras.lastRecal,
    termStructureDoD,
    charmZeros,
    charmTightening,
    nearby,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry: build a ModelHorizon for a single (symbol, horizon)
// ──────────────────────────────────────────────────────────────────────────

export interface ModelBuildInput {
  horizon: Horizon;
  symbol: "^GSPC" | "SPY";
  chainSymbol: "SPY" | "SPX";              // Schwab chain: "SPX" -> $SPX, "SPY" -> SPY
  vix: number | null;
  vixPrev: number | null;
  vix3m: number | null;
  /** VIX9D, the weekly EM fallback when no implied distribution is accepted. */
  vix9d?: number | null;
  intradayChange?: { change: number | null; windowMin: number | null };
  experimental?: boolean;
  /** Test seam: the shared ceiling, floor and turning point (server/sharedLevels.ts). */
  sharedLevels?: (symbol: string, view: SharedView) => Promise<SharedLevels | null>;
}

async function buildHorizon(input: ModelBuildInput): Promise<ModelHorizon> {
  const { horizon, symbol, chainSymbol, vix, vixPrev, vix3m, vix9d, intradayChange } = input;

  // Schwab chain for the model's own index (was the CBOE SPY chain rescaled
  // x realSPX/SPY for the SPX view). "SPX" -> $SPX (AM SPX + PM SPXW, each on
  // its own settlement clock), "SPY" -> SPY. No other source: when Schwab
  // cannot answer, this horizon is unavailable.
  // Shared DTE ladder (schwab.getOptionChainLadder): each horizon reuses the
  // segments the shorter horizons already fetched this minute (round 3, N1-1).
  const chain = await getOptionChainLadder(chainSymbol === "SPX" ? "$SPX" : "SPY", DTE_MAX[horizon]);
  if ("error" in chain) throw new Error(`Schwab ${chainSymbol} chain unavailable: ${chain.reason ?? chain.error}`);
  const spySpot = chainSpot(chain);
  if (!spySpot) throw new Error(`No spot in the Schwab chain for ${chainSymbol}`);
  const { rows: allRows } = exposureRowsFromSchwabChain(chain, { maxDte: DTE_MAX[horizon], spot: spySpot, r: 0.05, q: 0.013 });

  // SPX view on the SPY chain: rescale strikes by the real Schwab $SPX / SPY
  // ratio, or fail (unavailable) -- never a fixed x10 (was the fallback when
  // the SPX quote was missing). With the $SPX chain no rescale is needed.
  let displaySpot = spySpot;
  let scale = 1;
  if (symbol === "^GSPC" && chainSymbol === "SPY") {
    const realSpx = await resolveRealSpxSpot();
    if (realSpx == null || !(realSpx > 0)) throw new Error("SPX spot unavailable from Schwab");
    displaySpot = realSpx;
    scale = realSpx / spySpot;
  }

  // Build exposure profile at SPY spot (real math), we'll rescale strikes for display
  const profile = buildExposureProfile(chainSymbol, allRows, spySpot, { r: 0.05, q: 0.013 });

  // Rescale buckets + levels to display spot
  const spyBuckets = bucketByStrike(allRows, spySpot, 0.05, 0.013);
  const displayBuckets: StrikeBucket[] = spyBuckets.map((b) => ({ ...b, strike: b.strike * scale }));
  const displayRows: ExposureRow[] = allRows.map((r) => ({ ...r, strike: r.strike * scale }));

  // Build scaled profile-lite with just what extractLevels needs
  const scaledProfile: ExposureProfile = {
    ...profile,
    currentSpot: displaySpot,
    curve: profile.curve.map((p) => ({ ...p, spot: p.spot * scale })),
    current: { ...profile.current, spot: displaySpot },
    zeroGammaSpot: profile.zeroGammaSpot != null ? profile.zeroGammaSpot * scale : null,
    zeroCharmSpot: profile.zeroCharmSpot != null ? profile.zeroCharmSpot * scale : null,
    zeroCharmSpots: profile.zeroCharmSpots.map((x) => x * scale),
    zeroVannaSpot: profile.zeroVannaSpot != null ? profile.zeroVannaSpot * scale : null,
    charmSlope: profile.charmSlope,
  };

  // One source for ceiling, floor and turning point (framework section 7): the daily model reads the Today
  // map and the weekly model the This-week map, the ones the top card shows. The monthly model keeps its own
  // (to 45 days: the "Structure" view). SPX only: the shared map is read for $SPX.
  const sharedView = symbol === "^GSPC" && chainSymbol === "SPX" ? (horizon === "daily" ? "today" : horizon === "weekly" ? "week" : null) : null;
  const shared = sharedView ? await (input.sharedLevels ?? sharedLevels)("$SPX", sharedView) : null;
  if (shared?.turningPoint != null) scaledProfile.zeroGammaSpot = shared.turningPoint;
  const levelSource: LevelSource | null = shared ? levelSourceOf(shared) : null;

  const levels = extractLevels(
    displayBuckets,
    scaledProfile,
    displaySpot,
    displayRows,
    horizon,
    vix,
    input.experimental ?? false,
    shared,
  );
  const { spotAnchorDate, targetDate, targetDateLong, waypointLabels } = buildHorizonDates(horizon);
  const paths = generatePaths(levels, displaySpot, scaledProfile, horizon, waypointLabels);

  // ---- Options-implied scenario odds + 0DTE straddle expected move ----
  const implied = await impliedContextFor(symbol, horizon, displaySpot);
  let scenarioProbSource: ScenarioProbSource = "hand-set-heuristic";
  let impliedCdf: ((K: number) => number) | null = null;
  const dist = implied.dist;
  const bullP = paths.find((p) => p.kind === "bull");
  const baseP = paths.find((p) => p.kind === "base");
  const bearP = paths.find((p) => p.kind === "bear");
  if (dist && implied.expiry && dist.quotesUsed >= 10 && dist.coverage >= 0.6 && bullP && baseP && bearP) {
    const odds = scenarioOddsFromCdf((K) => cdfAt(dist, K), displaySpot, {
      bull: bullP.target, base: baseP.target, bear: bearP.target,
    });
    if (odds) {
      bullP.probability = odds.bull;
      baseP.probability = odds.base;
      bearP.probability = odds.bear;
      bullP.pCloseBeyond = odds.pCloseBeyondBull;
      bullP.pTouch = odds.pTouchBull;
      bullP.touchWithheld = odds.pTouchBull == null ? odds.touchWithheld : null;
      bearP.pCloseBeyond = odds.pCloseBeyondBear;
      bearP.pTouch = odds.pTouchBear;
      bearP.touchWithheld = odds.pTouchBear == null ? odds.touchWithheld : null;
      // The regions the odds refer to, sent so the card shows these and not a band around each target.
      bullP.region = { lo: odds.upper, hi: null };
      baseP.region = { lo: odds.lower, hi: odds.upper };
      bearP.region = { lo: null, hi: odds.lower };
      for (const p of [bullP, baseP, bearP]) {
        p.probabilityEvent = `risk-neutral P(close in region), regions split halfway between path targets (upper ${odds.upper.toFixed(2)}, lower ${odds.lower.toFixed(2)})`;
      }
      if (odds.baseOutsideRange) {
        // The base path heads to the dominant magnet, which sits outside the bull/bear range: it is a
        // magnet reference; the middle region is centred on spot when spot is inside (bear, bull),
        // else on the bull/bear midpoint (impliedScenario.ts).
        baseP.name = "MAGNET";
        baseP.probabilityEvent = `risk-neutral P(close in the middle region ${odds.lower.toFixed(2)}-${odds.upper.toFixed(2)}, centred on ${displaySpot > bearP.target && displaySpot < bullP.target ? "spot" : "the bull/bear midpoint"}); the MAGNET path heads to ${baseP.target.toFixed(2)}, outside the bull/bear range, and has no probability of its own`;
      }
      impliedCdf = (K) => cdfAt(dist, K);
      scenarioProbSource = "risk-neutral-implied";
    }
  }
  for (const p of paths) p.probabilitySource = scenarioProbSource;

  // ---- Selz #3/#4: intraday recal + DoD lookups ----
  const tradeDate = etTradeDate(new Date());
  const iv1dNow = vix != null ? vixToAtmPct(vix) / Math.sqrt(252) : null;
  const prevDay = storage.getPrevTradeDayRecal(symbol, horizon, tradeDate);
  const lastRecalRow = storage.getLatestRecal(symbol, horizon);
  const openRecal = storage.getTodayOpenRecal(symbol, horizon, tradeDate);

  // DEX slope sign for the recal snapshot (same helper as buildAudit). The
  // model_recal.dfi column keeps its name; from 2026-11-17 it holds the sign
  // (+1 / -1 / 0), where it used to hold the pinned +5 / -5.
  const dfiForSnap = dexSlopeSignValue(dexSlopeSignAt(scaledProfile.curve, displaySpot));

  // Record the recal — throttle to at most one write per 30 minutes per (symbol, horizon)
  const nowS = Math.floor(Date.now() / 1000);
  const MIN_RECAL_GAP = 30 * 60;
  if (!lastRecalRow || nowS - lastRecalRow.capturedAt >= MIN_RECAL_GAP) {
    try {
      storage.insertModelRecal({
        symbol, horizon, capturedAt: nowS, tradeDate,
        spot: displaySpot, dfi: dfiForSnap,
        charmPerDay: scaledProfile.current.charm / 1e9,
        iv1d: iv1dNow,
        charmZero: scaledProfile.zeroCharmSpot,
        zeroGamma: scaledProfile.zeroGammaSpot,
      });
    } catch { /* table may not exist in legacy DB — swallow */ }
  }

  const latestForDisplay = storage.getLatestRecal(symbol, horizon);
  const lastRecalOut = latestForDisplay
    ? {
        at: latestForDisplay.capturedAt,
        // Math.sign: rows written before 2026-11-17 hold +5 / -5; only the sign was ever information.
        dfi: Math.sign(latestForDisplay.dfi),
        dfiDeltaSinceOpen: openRecal ? Math.sign(latestForDisplay.dfi) - Math.sign(openRecal.dfi) : null,
      }
    : null;

  // #5: VIX term ratio fed into scenario weighting
  const vixTermRatioForAudit = vix && vix3m ? vix3m / vix : null;

  const audit = buildAudit(scaledProfile, levels, displaySpot, intradayChange ?? { change: null, windowMin: null }, {
    paths,
    iv1d: iv1dNow,
    iv1dPrev: prevDay?.iv1d ?? null,
    charmPrev: prevDay?.charmPerDay ?? null,
    lastRecal: lastRecalOut,
    vixTermRatio: vixTermRatioForAudit,
    vixForEM: vix ?? null,
    vix9d: vix9d ?? null,
    horizon,
    impliedCdf,
    impliedAtmTotalVol: dist && scenarioProbSource === "risk-neutral-implied" ? dist.atmTotalVol : null,
    straddleEM: implied.straddle,
    impliedDistribution: dist && implied.expiry && scenarioProbSource === "risk-neutral-implied"
      ? {
          expiry: implied.expiry,
          measure: "risk-neutral",
          method: "svi-smoothed",
          forward: parseFloat(dist.forward.toFixed(2)),
          coverage: parseFloat(dist.coverage.toFixed(4)),
          fitRmse: parseFloat(dist.fitRmse.toFixed(4)),
          quotesUsed: dist.quotesUsed,
          negativeMassClipped: parseFloat(dist.negativeMassClipped.toFixed(5)),
        }
      : null,
  });
  // One probability set per scenario: in the heuristic fallback the paths
  // carry the same numbers the audit shows (they used to differ).
  if (scenarioProbSource === "hand-set-heuristic") {
    for (const p of paths) p.probabilityEvent = "heuristic split, same numbers as audit.scenarioProb";
    if (bullP) bullP.probability = audit.scenarioProb.bull / 100;
    if (baseP) baseP.probability = audit.scenarioProb.base / 100;
    if (bearP) bearP.probability = audit.scenarioProb.bear / 100;
  }

  // Price range: widest of call wall → put wall vs. ±2% of spot, padded
  const cw = levels.find((l) => l.kind === "callWall")?.price ?? displaySpot * 1.02;
  const pw = levels.find((l) => l.kind === "putWall")?.price ?? displaySpot * 0.98;
  const t2Up = levels.find((l) => l.kind === "t2Up")?.price ?? displaySpot * 1.03;
  const t2Dn = levels.find((l) => l.kind === "t2Down")?.price ?? displaySpot * 0.97;
  const yMax = Math.max(cw, t2Up, displaySpot * 1.015);
  const yMin = Math.min(pw, t2Dn, displaySpot * 0.985);

  const termRatio = vix && vix3m ? vix3m / vix : null;
  // Missing VIX or VIX3M is "unavailable", not backwardation.
  const termLabel = termRatio == null ? "unavailable"
    : termRatio > 1 ? "contango (calm front-end)" : "backwardation (stress front-end)";
  const vixChangePct = vix && vixPrev ? ((vix - vixPrev) / vixPrev) * 100 : null;
  const vomma: "elevated" | "normal" | "unavailable" = vix == null ? "unavailable" : vix > 20 ? "elevated" : "normal";
  const confidence: "HIGH" | "MODERATE" | "LOW" =
    Math.abs(scaledProfile.current.gex) > 5e9 ? "HIGH" : Math.abs(scaledProfile.current.gex) > 1e9 ? "MODERATE" : "LOW";

  const horizonDays = horizon === "daily" ? 1 : horizon === "weekly" ? 5 : horizon === "monthly" ? 21 : 63;

  // ── #4: per-level live status vs spot (held / approaching / broken) ────
  // "approaching" threshold is 15bps (0.15%) which corresponds to ~SPX 11pt
  // or ~SPY 1.05 — tight enough to catch real tags, loose enough not to
  // flicker on quote noise. Sides: levels above spot are resistance, below
  // are support. Status flips based on whether the most recent traded spot
  // has crossed (broken) or merely touched (approaching) the level.
  const APPROACH_BPS = 15;
  const enrichedLevels: ModelLevel[] = levels.map((lv) => {
    const distBps = ((lv.price - displaySpot) / displaySpot) * 10_000;
    const absBps = Math.abs(distBps);
    let side: ModelLevel["side"] = distBps > 5 ? "resistance" : distBps < -5 ? "support" : "at";
    let status: ModelLevel["status"];
    if (side === "resistance") {
      // Above spot — still HELD as ceiling; BROKEN if spot crossed it (won't usually fire here since side=='resistance' means level > spot)
      status = absBps <= APPROACH_BPS ? "approaching" : "held";
    } else if (side === "support") {
      // Below spot — HELD as floor; APPROACHING if within threshold
      status = absBps <= APPROACH_BPS ? "approaching" : "held";
    } else {
      // At spot — currently being tested
      status = "approaching";
    }
    return { ...lv, distBps: Math.round(distBps), side, status };
  });

  // ── #3: derive rangeBox from nearest resistance + nearest support ──────
  // Prefers structural levels (charm-zero, vanna flip, dominant magnet,
  // pivots, walls) over T1/T2 targets so the band reflects DEALER mechanics,
  // not just ATR projections. Skips kinds that are themselves price targets
  // rather than supply/demand structure.
  const STRUCTURAL_KINDS = new Set<ModelLevel["kind"]>([
    "callWall", "putWall", "zeroGamma", "dominantMag", "strongMag",
    "upsidePivot", "downsidePivot", "charmTarget", "vannaFlip",
    "negGammaEntry", "upperVomma", "lowerVomma",
  ]);
  const structural = enrichedLevels.filter((lv) => STRUCTURAL_KINDS.has(lv.kind));
  const aboveSpot = structural
    .filter((lv) => lv.price > displaySpot)
    .sort((a, b) => a.price - b.price);
  const belowSpot = structural
    .filter((lv) => lv.price < displaySpot)
    .sort((a, b) => b.price - a.price);
  const nearestUp = aboveSpot[0] ?? null;
  const nearestDn = belowSpot[0] ?? null;

  let rangeBox: ModelHorizon["rangeBox"] = null;
  if (nearestUp && nearestDn) {
    const high = nearestUp.price;
    const low = nearestDn.price;
    const width = high - low;
    const widthPct = (width / displaySpot) * 100;
    let status: "contained" | "breakout" | "breakdown" = "contained";
    if (displaySpot > high) status = "breakout";
    else if (displaySpot < low) status = "breakdown";
    rangeBox = {
      low, high, width, widthPct,
      breakoutTrigger: high,
      breakdownTrigger: low,
      status,
      anchorHigh: { name: nearestUp.name, kind: nearestUp.kind },
      anchorLow:  { name: nearestDn.name, kind: nearestDn.kind },
    };
  }

  const horizonOut: ModelHorizon = {
    horizon,
    levelSource,
    label: `${symbol === "^GSPC" ? "SPX" : "SPY"} ${horizon.toUpperCase()} MODEL`,
    symbol,
    displaySymbol: symbol === "^GSPC" ? "SPX" : "SPY",
    spot: displaySpot,
    spotAnchorDate,
    targetDate,
    targetDateLong,
    priceRange: [yMin, yMax],
    rangeBox,
    levels: enrichedLevels,
    paths,
    audit,
    vol: {
      vix, vixChangePct,
      termRatio,
      termLabel,
    },
    vomma,
    confidence,
    chainSource: "schwab",
    chainSymbol: chainSymbol === "SPX" ? "$SPX" : "SPY",
    chainAsOfMs: chain.asOfMs,
    chainStale: chain.stale,
    chainLastSession: chain.lastSession === true,
    chainMaxAgeMs: chain.maxAgeMs,
    chainCoverageComplete: chain.strikeCoverage?.complete ?? null,
    oiBasis: buildOiBasis(chainReadMs(chain), chain.oiState),
    weighting: gammaWeighting("oi"),
  };

  // MM probability matrix — 5×5 regime × zone grid with conditional probs + action tags
  try {
    horizonOut.mmMatrix = buildMMMatrix(horizonOut, horizonDays);
  } catch (e) {
    // Non-fatal — matrix is supplementary
  }

  return horizonOut;
}

// ──────────────────────────────────────────────────────────────────────────
// Options-implied context: the horizon expiry's smoothed implied distribution
// and the same-day ATM straddle. Schwab chain (getOptionChain; Schwab only,
// no fallback source). Missing data -> nulls, and the
// callers fall back to labeled heuristics.
// ──────────────────────────────────────────────────────────────────────────

async function impliedContextFor(
  symbol: "^GSPC" | "SPY",
  horizon: Horizon,
  spot: number,
): Promise<{ dist: ImpliedDistribution | null; expiry: string | null; straddle: StraddleExpectedMove | null }> {
  const none = { dist: null, expiry: null, straddle: null };
  try {
    const chain = await getOptionChainLadder(symbol === "^GSPC" ? "$SPX" : "SPY", DTE_MAX[horizon]);
    if (!chain || "error" in chain) return none;
    const calls = chain.callExpDateMap, puts = chain.putExpDateMap;
    const now = new Date();
    const et = etNowParts(now);
    // Regular session per the exchange calendar (holidays, 13:00 half days)
    const rth = isRegularSessionOpen(now.getTime());
    // Today's expiry is only live during the regular session; after the close
    // its quotes are stale, so it is excluded rather than shown as a move.
    const keys = Array.from(new Set([...Object.keys(calls || {}), ...Object.keys(puts || {})]))
      .filter((k) => k.split(":")[0] > et.iso || (rth && k.split(":")[0] === et.iso));
    const todayKey = rth ? keys.find((k) => k.split(":")[0] === et.iso) ?? null : null;
    const straddle = todayKey ? straddleExpectedMove(quotesFromSchwabExpiry(calls, puts, todayKey), spot) : null;
    const expKey = pickExpiryKey(keys, horizonTargetIso(horizon, now));
    const dist = expKey ? impliedDistributionForExpiry(calls, puts, expKey, spot, 0.05) : null;
    return { dist, expiry: expKey ? expKey.split(":")[0] : null, straddle };
  } catch {
    return none;
  }
}

export async function buildModelsSnapshot(input: {
  vix: number | null;
  vixPrev: number | null;
  vix3m: number | null;
  vix9d?: number | null;
  spxIntraday?: { change: number | null; windowMin: number | null };
  spyIntraday?: { change: number | null; windowMin: number | null };
  symbols?: Array<"^GSPC" | "SPY">;
  horizons?: Horizon[];
  experimental?: boolean;
}): Promise<ModelsResponse> {
  const warnings: string[] = [];
  const symbols = input.symbols ?? ["^GSPC", "SPY"];
  const horizons = input.horizons ?? (["daily", "weekly", "monthly", "quarterly"] as Horizon[]);

  const out: ModelsResponse = {
    asOf: Math.floor(Date.now() / 1000),
    session: "live",
    horizons: { daily: null, weekly: null, monthly: null, quarterly: null },
    warnings,
    experimental: input.experimental ?? false,
  };

  // We build once per (symbol, horizon) but the UI currently picks one symbol at
  // a time — so we return a horizons map, with each entry defaulting to the
  // first requested symbol. The client can re-request with ?symbol= later.
  const primarySymbol = symbols[0];

  await Promise.all(
    horizons.map(async (h) => {
      try {
        const mh = await buildHorizon({
          horizon: h,
          symbol: primarySymbol,
          // Schwab SPY chain, rescaled to SPX by the real $SPX/SPY ratio for the
          // SPX view (the exact replacement of the old CBOE SPY chain, so GEX
          // magnitudes and the HIGH/MODERATE/LOW thresholds keep their scale).
          // chainSymbol "SPX" ($SPX chain, no rescale) is supported; switching
          // the default is a model-calibration change (R2-B).
          chainSymbol: "SPY",
          vix: input.vix,
          vixPrev: input.vixPrev,
          vix3m: input.vix3m,
          vix9d: input.vix9d ?? null,
          intradayChange: primarySymbol === "^GSPC" ? input.spxIntraday : input.spyIntraday,
          experimental: input.experimental ?? false,
        });
        out.horizons[h] = mh;
      } catch (e: any) {
        warnings.push(`${h} model failed: ${e?.message ?? e}`);
      }
    }),
  );

  // "live" only when the regular session is open and no horizon was built on a last-session chain copy.
  // It used to be "live" on every successful build, so a weekend build on Friday's chain read "● LIVE".
  const built = Object.values(out.horizons).filter((h): h is ModelHorizon => h != null);
  if (!isRegularSessionOpen(Date.now()) || built.some((h) => h.chainLastSession === true)) out.session = "last-close";

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1000) return Math.round(n).toLocaleString();
  return n.toFixed(2);
}

