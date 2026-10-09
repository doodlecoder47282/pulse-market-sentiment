// server/masterAlpha.ts
// ═══════════════════════════════════════════════════════════════════════════
// MASTER UNIFIED ALPHA FORMULA — hand-set weights (not yet fit to this app's data)
//
// Consumes what the terminal already computes (ModelHorizon.audit + PivotBundle)
// so every number is honest to the rest of the app. No duplicated greek math.
//
// Runs PER HORIZON (daily / weekly / monthly / quarterly) so the daily charm
// edge and the monthly SOQ edge are both surfaced independently.
//
// Sources:
//   [PAPER]  Baltussen, Terstegge & Whelan (2024) "The Derivative Payoff Bias"
//   [REF]    Debellefroid "The Derivatives Academy" Ch.5
//   [BLMM]   Baltussen, Da, Lammers, Martens (2021) JFE — Hedging Demand Intraday
//   [BLW]    Boyarchenko, Larsen, Whelan (2023) RFS — The Overnight Drift
//   [DEV]    Dim, Eraker, Vilkov (2023) SSRN — 0DTEs Gamma Risk
//   [VOL]    DeLorenzo et al. (2023) Volland — Dealer Flows
//
// Wire in routes.ts:
//   import { masterAlphaRoute } from "./masterAlpha";
//   app.post("/api/master-alpha", masterAlphaRoute);
// ═══════════════════════════════════════════════════════════════════════════

import { vixToAtmPct } from "@shared/vol";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelHorizon, Horizon } from "./models";
import type { PivotBundle } from "./pivots";
import { horizonTargetIso } from "./impliedScenario";
import { yearsToExpiry } from "./timeToExpiry";
import { etDate, nextTradingDay } from "./exchangeCalendar";
import { gammaBudgetContracts } from "./sizingMath";
import { atmContractFrom, contractsFromAsk, masterAlphaPromotionGate, promotedForecastBps, resolveMasterAlphaRiskBudget, type MasterAlphaPromotion } from "./masterAlphaFit";
import { feeForProduct } from "./feeConfig";
import { readFileSync } from "node:fs";

const client = new Anthropic();

// ═══════════════════════════════════════════════════════════════════════════
// TUNABLE CONSTANTS — HAND-SET, adjustable in one place.
// β_charm and the net-C σ are borrowed from the Baltussen-Terstegge-Whelan
// sample (R² = 3.2%), whose net-C differs from this app's in OI coverage,
// sign assumptions and time units; the component weights are hand-picked.
// None of these are calibrated on this app's history. masterAlphaFit.ts
// re-estimates them from the logged snapshots (mmPredictions) once enough
// independent sessions exist (MASTER_ALPHA_MIN_SESSIONS); until a reviewed
// fit is promoted, outputs carry coefficientStatus = "hand-set".
// ═══════════════════════════════════════════════════════════════════════════

export const MASTER_ALPHA_COEFFICIENT_STATUS = "hand-set" as const;
const COEFFICIENT_NOTE =
  "hand-set weights: β_charm and net-C σ borrowed from a published sample, component weights hand-picked; not fit to this app's history yet";

// R2-C 9: direction labels (LONG/SHORT, STRONG_*) and any contract count are
// GATED on a reviewed, promoted fit (masterAlphaFit.masterAlphaPromotionGate:
// >= 250 sessions, out-of-sample R^2 > 0, reviewer + date). The promotion
// record is a JSON file a reviewer writes; nothing promotes automatically.
// Until then compositeSignal is "UNRATED", the hand-set composite is reported
// as a heuristic score (heuristicBand keeps the old band for logging), and no
// size is given. A size also needs the user's account input; there is no
// default dollar budget.
const PROMOTION_FILE = process.env.MASTER_ALPHA_PROMOTION_FILE || "data/master_alpha_promotion.json";
let promotionCache: { at: number; rec: MasterAlphaPromotion | null } | null = null;
function loadPromotion(): MasterAlphaPromotion | null {
  if (promotionCache && Date.now() - promotionCache.at < 60_000) return promotionCache.rec;
  let rec: MasterAlphaPromotion | null = null;
  try { rec = JSON.parse(readFileSync(PROMOTION_FILE, "utf8")) as MasterAlphaPromotion; } catch { rec = null; }
  promotionCache = { at: Date.now(), rec };
  return rec;
}

// Charm — paper Table IX regression (β on standardised net-C)
const BETA_CHARM       = -0.18;    // paper reported, t=2.99, R²=3.2%
const NETC_SD_M        = 80;       // stdev of net-C from paper Table VIII
const OVERNIGHT_RET_SD = 50;       // stdev of overnight ret on 3rd-Thu close, bps
// ⇒ 1σ shift in net-C predicts |−0.18 × 50| = 9bps overnight move

// GEX thresholds — SYMMETRIC around zero (industry standard, honest)
const GEX_POS_THRESH_M = 150;      // > +$150M → POSITIVE_GAMMA
const GEX_NEG_THRESH_M = -150;     // < −$150M → NEGATIVE_GAMMA

// GEX dampener/amplifier coefficients (independent, not charm-coupled)
const GEX_DAMPEN_COEF  = -0.30;    // positive γ dampens composite charm+OD by 30%
const GEX_AMPLIFY_COEF =  0.15;    // negative γ amplifies composite by 15%

// Vanna amplifier — [PAPER + VOL] when confluent with charm
const VANNA_AMP_COEF   = 0.20;     // vanna contributes 20% of charm dir when confluent

// Overnight drift [BLW] — asymmetric, only negative imbalance reverses
const OD_BPS_PER_100M  = 3.5;      // 3.5bps per −$100M close imbalance
const OD_EXPIRY_MULT   = 1.30;     // stacks 1.3× on 3rd-Friday expiry weeks

// Triple-witching multiplier — applied ONCE in aggregator [PAPER Table VI]
const TW_MULT          = 1.86;

// Horizon-specific charm activation windows
// Daily:    only on 3rd-Thursday (paper's actual finding — vanishes off-expiry)
// Weekly:   within 5 days of any Friday opex
// Monthly:  within 15 days of 3rd Friday (tracks buildup across cycle)
// Quarterly: always on (structural)
const CHARM_WINDOW_DAYS: Record<Horizon, number> = {
  daily:     1,    // only fires on 3rd-Thu close (paper finding)
  weekly:    5,    // fires during expiry week
  monthly:   15,   // fires across the monthly cycle
  quarterly: 45,   // always on during the quarter
};

// Component weights (should sum to 1) — hand-set
const W_CHARM = 0.45, W_VANNA = 0.20, W_GEX = 0.15, W_GTBR = 0.10, W_OD = 0.10;

// Signal thresholds (bps) — ordered so STRONG bands are checked before plain
const THRESH_STRONG = 20;
const THRESH_NORMAL = 8;

// ═══════════════════════════════════════════════════════════════════════════
// USER'S LOCKED SPX WEEKLY TARGETS (design decision — never re-derive live)
// Used to tag composite signal against operator's own framework.
// ═══════════════════════════════════════════════════════════════════════════
export const LOCKED_SPX_TARGETS = {
  upside:     7140,
  downside:   6950,
  t2Up:       7270,
  t2Down:     6885,
  mopex:      7025,
  vanna:      7089,
  zomma:      7070,
  charm:      7128,
  negGamma:   7100,
  upperVomma: 7265,
  lowerVomma: 6960,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface MasterAlphaInput {
  horizon:           ModelHorizon;        // full horizon block (audit + levels)
  pivots?:           PivotBundle;         // prior-day classic/fib/camarilla
  prevCloseImbalance_M?: number;          // $M — negative = net selling at close [BLW]
  realisedVol?:      number;              // 20-day realised vol as decimal
  // Sizing inputs (user's own; no default budget). Used only with a promoted fit.
  accountSize?:      number;              // $ account size
  riskPct?:          number;              // fraction of account at risk (default 1%, cap 5%)
  riskBudgetDollars?: number;             // explicit $ premium-at-risk budget
  riskBudget_M?:     number;              // legacy explicit $M budget (no default)
  /** Test/override hook; defaults to the reviewer's promotion file. */
  promotion?:        MasterAlphaPromotion | null;
}

export interface AlphaComponent {
  name:          string;
  rawValue:      number;
  normalised:    number;                   // z-score or 0–1
  directionBps:  number;                   // bps contribution to horizon return
  weight:        number;                   // portfolio weight in composite
  signal:        "LONG" | "NEUTRAL" | "SHORT";
  confidence:    number;                   // 0–1
  source:        string;                   // paper citation
}

export type GexRegime = "POSITIVE_GAMMA" | "NEGATIVE_GAMMA" | "NEUTRAL";
export type CompositeSignal = "STRONG_LONG" | "LONG" | "NEUTRAL" | "SHORT" | "STRONG_SHORT";
/** UNRATED: no promoted fit, so no direction-strength label is given. */
export type GatedSignal = CompositeSignal | "UNRATED";

export interface MasterAlphaOutput {
  // meta
  timestamp:           string;             // ISO date (ET)
  horizon:             Horizon;
  symbol:              string;
  spot:                number;
  daysTo3rdFriday:     number;
  is3rdThursday:       boolean;
  isThirdFriday:       boolean;       // today IS the monthly 3rd-Friday OPEX (distinct from weekly OPEX)
  isWeeklyOpex:        boolean;       // today is Friday AND today is NOT the 3rd Friday
  isTripleWitching:    boolean;
  settlementType:      "AM_SOQ" | "PM";

  // components
  components:          AlphaComponent[];

  // composite
  compositeEdgeBps:    number;             // fitted forecast when promoted, else the heuristic score (bps units)
  compositeSignal:     GatedSignal;        // "UNRATED" until a reviewed fit is promoted
  compositeConfidence: number;
  /** Band of the hand-set heuristic score (kept for logging/backtests; not a rating). */
  heuristicBand:       CompositeSignal;
  heuristicScoreBps:   number;
  directionStatus:     "unrated_heuristic" | "fitted_promoted";
  directionNote:       string;

  // regime snapshot (mirrored from audit)
  gexRegime:           GexRegime;
  gexDollars_M:        number;
  zeroGammaStrike:     number | null;
  callWallStrike:      number | null;
  putWallStrike:       number | null;
  charmZero:           number | null;

  // GTBR
  gtbrPoints:          number;
  gtbrPct:             number;

  // pivot proximity (closest classic/fib/camarilla level to spot)
  nearestPivot:        { name: string; value: number; distBps: number } | null;

  // user's locked framework — composite's agreement with operator targets
  lockedTargetAlignment: {
    bias: "confirms_upside" | "confirms_downside" | "mixed" | "n/a";
    note: string;
  };

  // sizing — null unless a promoted fit AND the user's account/budget input
  recommendedContracts: number | null;     // whole contracts; premium at risk <= the user's budget
  premiumPerContract:   number | null;     // $ per chosen contract: Schwab ask x 100 + opening fee; null when not sized
  premiumAtRisk_M:      number | null;     // $M: recommendedContracts x premiumPerContract
  dollarGammaAggregate: number;            // $M (from audit)
  gammaPnlAt_r_hat:     number | null;     // $M at the fitted forecast (null when unrated)
  sizingNote:          string;

  // AI narrative
  aiAnalysis:          string;

  // Honesty label for the coefficients (added): "hand-set" until a fit on
  // the app's own logged history is reviewed and promoted.
  coefficientStatus:   "hand-set" | "fitted";
  coefficientNote:     string;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// America/New_York trade date components
function etDateParts(d: Date): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const year  = parseInt(parts.find(p => p.type === "year")!.value, 10);
  const month = parseInt(parts.find(p => p.type === "month")!.value, 10) - 1;
  const day   = parseInt(parts.find(p => p.type === "day")!.value, 10);
  const wdStr = parts.find(p => p.type === "weekday")!.value;
  const wdMap: Record<string, number> = { Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6 };
  const weekday = wdMap[wdStr] ?? 0;
  return { year, month, day, weekday };
}

function getThirdFriday(year: number, month: number): { day: number } {
  // month is 0-indexed. 3rd Friday = 15th..21st.
  // Jan 1 2000 was a Saturday. We can compute: day-of-week for day=1 of (year, month)
  // via Zeller-ish approach, but simpler: walk.
  for (let day = 15; day <= 21; day++) {
    const dt = new Date(Date.UTC(year, month, day));
    if (dt.getUTCDay() === 5) return { day };
  }
  return { day: 21 };
}

function getCalendarContext(d: Date) {
  const { year, month, day, weekday } = etDateParts(d);
  let tf = getThirdFriday(year, month);
  let target = { year, month, day: tf.day };
  // if we've passed this month's 3rd Friday, roll to next month
  if (day > tf.day) {
    const nm = month === 11 ? 0 : month + 1;
    const ny = month === 11 ? year + 1 : year;
    const nf = getThirdFriday(ny, nm);
    target = { year: ny, month: nm, day: nf.day };
  }
  // days to target (approx — using ET dates)
  const todayUTC  = Date.UTC(year, month, day);
  const targetUTC = Date.UTC(target.year, target.month, target.day);
  const daysAway  = Math.max(0, Math.round((targetUTC - todayUTC) / 86_400_000));
  // Triple-witching: expiry month ∈ {Mar(2),Jun(5),Sep(8),Dec(11)}
  const isTripleWitching = [2, 5, 8, 11].includes(target.month);
  // 3rd-Thursday: today is Thursday AND expiry is tomorrow
  const is3rdThursday = weekday === 4 && daysAway === 1;
  // 3rd-Friday: today IS the monthly OPEX day (daysAway === 0 on a Friday).
  // Distinct from weekly OPEX — 3rd-Friday brings monthly/quarterly SPX SOQ settlement,
  // massive gamma unwind, and the paper's entire overnight-drift regression is anchored
  // to 3rd-Thu close → 3rd-Fri AM settle. Weekly OPEX is every other Friday (1st/2nd/4th/5th).
  const isThirdFriday = weekday === 5 && daysAway === 0;
  const isWeeklyOpex  = weekday === 5 && !isThirdFriday;
  return { daysAway, isTripleWitching, is3rdThursday, isThirdFriday, isWeeklyOpex, targetMonth: target.month };
}

// ═══════════════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────────────
//
//  MASTER FORMULA — hand-set weights, decoupled
//
//  COMPOSITE EXPECTED HORIZON RETURN:
//
//  r̂_final = TW · (regimeMult) · Σ wᵢ · rᵢ
//
//  TW = 1.86 if triple-witching AND daysTo3F ≤ 1, else 1.0 (APPLIED ONCE)
//  regimeMult = 1 + GEX_DAMPEN_COEF  if POSITIVE_GAMMA
//             = 1 + GEX_AMPLIFY_COEF if NEGATIVE_GAMMA
//             = 1                     if NEUTRAL
//
//  COMPONENT RETURNS (decoupled — each has its own raw input):
//
//  1. CHARM  r̂_C = β_C × z(net_C) × OVERNIGHT_RET_SD   [PAPER Table IX]
//     - z(net_C) = (net_C_M − paper_mean) / paper_sd
//     - charm only fires within CHARM_WINDOW_DAYS[horizon]
//
//  2. VANNA  r̂_V = VANNA_AMP_COEF × r̂_C   when confluent (same sign) AND IV>HV
//                = 0                         otherwise
//     (vanna is ALWAYS a charm amplifier, never a standalone signal —
//      this is the paper's mechanism [VOL whitepaper §2])
//
//  3. GEX    r̂_G is NOT a weighted component — it becomes the regimeMult
//            applied to the composite. This avoids double-counting and
//            matches the mechanism [BLMM]: gamma regime SCALES existing
//            flow pressure, it doesn't generate independent return.
//
//  4. GTBR   r̂_GTBR = +5bps if GTBR < 0.3% spot (tight trigger)
//                   = +2bps if GTBR < 0.6% spot (moderate)
//                   = 0     otherwise
//     GTBR is an intraday momentum confirmation — informational unless tight.
//
//  5. OD     r̂_OD = (−imbalance_M × 3.5/100) × expiryMult   [BLW asymmetric]
//                  only when imbalance < 0
//
// ───────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function neutralComponent(name: string, source: string, weight: number): AlphaComponent {
  return { name, rawValue: 0, normalised: 0, directionBps: 0, weight,
           signal: "NEUTRAL", confidence: 0.30, source };
}

// ── 1. CHARM ───────────────────────────────────────────────────────────────
function charmComponent(
  netCharm_M: number, daysTo3F: number, horizon: Horizon
): AlphaComponent {
  const windowDays = CHARM_WINDOW_DAYS[horizon];
  if (daysTo3F > windowDays) {
    return neutralComponent("Charm — overnight drift", "PAPER Table IX / windowed by horizon", W_CHARM);
  }
  // Paper mean for net-C on 3rd-Thu close is −$48.1M. Use 0 as baseline here
  // since we're looking at LIVE net-C, not just 3rd-Thu close distribution.
  // Standardise against paper sd so β_CHARM applies cleanly.
  const z = netCharm_M / NETC_SD_M;
  // β × z gives normalised return (in sd-units of overnight ret); scale to bps
  const dirBps = BETA_CHARM * z * OVERNIGHT_RET_SD;
  const absM = Math.abs(netCharm_M);
  const conf = Math.max(0.30, Math.min(0.85, 0.35 + absM / 200));
  const signal: AlphaComponent["signal"] =
    dirBps >  THRESH_NORMAL ? "LONG"
    : dirBps < -THRESH_NORMAL ? "SHORT"
    : "NEUTRAL";
  return {
    name: `Charm — ${horizon} window`,
    rawValue: netCharm_M,
    normalised: z,
    directionBps: dirBps,
    weight: W_CHARM,
    signal,
    confidence: conf,
    source: "PAPER eq.7-8 Table IX β=-0.18 t=2.99 R²=3.2%",
  };
}

// ── 2. VANNA AMPLIFIER ─────────────────────────────────────────────────────
function vannaComponent(
  netVanna_M: number, charmDirBps: number,
  iv: number | null, realisedVol: number | null, daysTo3F: number, horizon: Horizon
): AlphaComponent {
  const windowDays = CHARM_WINDOW_DAYS[horizon];
  if (daysTo3F > windowDays || charmDirBps === 0) {
    return neutralComponent("Vanna — delta amplifier", "REF §5.8.2 / VOL whitepaper", W_VANNA);
  }
  // Confluence: vanna and charm same SIGN, and IV elevated vs realised
  // (vol term-structure steepening → vanna delta-rebalance stacks on charm)
  const charmDirSign = Math.sign(charmDirBps);
  const vannaDealerSign = netVanna_M < 0 ? 1 : -1;
  // dealers short vanna (netVanna<0) want IV-up → they buy delta → up pressure
  const confluent = charmDirSign === vannaDealerSign;
  const ivPremium = (iv != null && realisedVol != null) ? iv - realisedVol : 0;
  const volPremiumOK = ivPremium > 0;
  const amplifierBps = (confluent && volPremiumOK) ? charmDirBps * VANNA_AMP_COEF : 0;
  const signal: AlphaComponent["signal"] =
    amplifierBps >  2 ? "LONG"
    : amplifierBps < -2 ? "SHORT"
    : "NEUTRAL";
  return {
    name: "Vanna — IV-confluent delta amplifier",
    rawValue: netVanna_M,
    normalised: confluent ? vannaDealerSign : 0,
    directionBps: amplifierBps,
    weight: W_VANNA,
    signal,
    confidence: (confluent && volPremiumOK) ? 0.60 : 0.30,
    source: "REF §5.8.2 Vanna=∂Δ/∂σ / VOL whitepaper §2",
  };
}

// ── 3. GEX REGIME (returns a MULTIPLIER, not a bps component) ──────────────
interface GexRegimeResult {
  regime: GexRegime;
  component: AlphaComponent;              // zero directionBps — regime enters via mult
  compositeMultiplier: number;
}
function gexRegime(gexTotal_M: number): GexRegimeResult {
  let regime: GexRegime;
  let mult = 1;
  if (gexTotal_M > GEX_POS_THRESH_M)      { regime = "POSITIVE_GAMMA"; mult = 1 + GEX_DAMPEN_COEF; }
  else if (gexTotal_M < GEX_NEG_THRESH_M) { regime = "NEGATIVE_GAMMA"; mult = 1 + GEX_AMPLIFY_COEF; }
  else                                    { regime = "NEUTRAL"; }
  const signal: AlphaComponent["signal"] =
    regime === "NEGATIVE_GAMMA" ? "LONG"
    : regime === "POSITIVE_GAMMA" ? "NEUTRAL"
    : "NEUTRAL";
  return {
    regime,
    component: {
      name: `GEX regime — ${regime.replace("_"," ").toLowerCase()}`,
      rawValue: gexTotal_M,
      normalised: gexTotal_M / 1000,
      directionBps: 0,                    // regime does not contribute bps directly
      weight: W_GEX,
      signal,
      confidence: Math.max(0.35, Math.min(0.80, Math.abs(gexTotal_M) / 1000)),
      source: `BLMM JFE 2021 / SpotGamma — mult ${mult.toFixed(2)}× on composite`,
    },
    compositeMultiplier: mult,
  };
}

// ── 4. GTBR — intraday momentum trigger ────────────────────────────────────
// Compute from aggregate audit signals (gammaAtSpot + vix) rather than raw chain.
// GTBR (pts) = S · σ · √(dt) · k   where k is an empirical dealer-trigger factor
// This approximates the BS-balance re-arrangement without per-contract data.
function gtbrComponent(
  spot: number, gammaAtSpot_M: number, vix: number | null, horizon: Horizon
): { component: AlphaComponent; gtbrPoints: number; gtbrPct: number } {
  if (!vix || vix <= 0 || gammaAtSpot_M === 0) {
    return {
      component: neutralComponent("GTBR — momentum trigger", "REF §5.4.4 / AFA 2024", W_GTBR),
      gtbrPoints: 0, gtbrPct: 0,
    };
  }
  // dt scales by horizon
  const dtDays = horizon === "daily" ? 1 : horizon === "weekly" ? 5 : horizon === "monthly" ? 21 : 63;
  const dt = dtDays / 252;
  const sigma = vixToAtmPct(vix) / 100; // VIX → true ATM vol
  // 1σ move, then scale inversely by |gamma| (more gamma → tighter trigger)
  const sigma1pt = spot * sigma * Math.sqrt(dt);
  // Dealer-trigger factor: empirical — tighter when gamma is concentrated
  const gammaFactor = Math.max(0.3, Math.min(1.5, 1 / Math.log10(Math.max(10, Math.abs(gammaAtSpot_M)))));
  const gtbrPoints = sigma1pt * gammaFactor * 0.5;  // half-σ × gamma-weighted factor
  const gtbrPct = gtbrPoints / spot;
  const bpsContrib =
    gtbrPct < 0.003 ? 5 :
    gtbrPct < 0.006 ? 2 : 0;
  const signal: AlphaComponent["signal"] = bpsContrib >= 5 ? "LONG" : "NEUTRAL";
  return {
    component: {
      name: "GTBR — gamma-theta momentum trigger",
      rawValue: gtbrPoints,
      normalised: Math.max(0, 1 - gtbrPct / 0.01),
      directionBps: bpsContrib,
      weight: W_GTBR,
      signal,
      confidence: bpsContrib > 0 ? 0.55 : 0.35,
      source: "AFA 2024 GTBR / REF §5.4.4 Θ+½ΓS²σ²=r(V-ΔS)",
    },
    gtbrPoints: Math.round(gtbrPoints * 100) / 100,
    gtbrPct:    Math.round(gtbrPct   * 10000) / 10000,
  };
}

// ── 5. OVERNIGHT DRIFT [BLW asymmetric] ────────────────────────────────────
function overnightDriftComponent(
  imbalance_M: number | undefined, daysTo3F: number
): AlphaComponent {
  if (imbalance_M === undefined) {
    return neutralComponent("Overnight drift", "BLW RFS 2023", W_OD);
  }
  const rawBps = imbalance_M < 0 ? -imbalance_M * (OD_BPS_PER_100M / 100) : 0;
  const expiryMult = daysTo3F <= 2 ? OD_EXPIRY_MULT : 1.0;
  const dirBps = rawBps * expiryMult;
  const signal: AlphaComponent["signal"] = dirBps > 2 ? "LONG" : "NEUTRAL";
  const conf =
    imbalance_M < -200 ? 0.65 :
    imbalance_M < -100 ? 0.52 :
                         0.35;
  return {
    name: "Overnight drift — close imbalance reversal",
    rawValue: imbalance_M,
    normalised: imbalance_M / 300,
    directionBps: dirBps,
    weight: W_OD,
    signal,
    confidence: conf,
    source: "BLW RFS 2023 — asymmetric ~3.5bps per −$100M",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSITE AGGREGATOR
// ═══════════════════════════════════════════════════════════════════════════
//
//  r̂_final = TW · regimeMult · Σ wᵢ · rᵢ
//            where GEX component has rᵢ=0 (regime enters as regimeMult)
//
function aggregate(
  components: AlphaComponent[], regimeMult: number,
  isTriple: boolean, daysTo3F: number
): { bps: number; signal: CompositeSignal; confidence: number } {
  // TW applied ONCE, gated to 3rd-Thursday/Friday of a triple-witching month
  const tw = (isTriple && daysTo3F <= 1) ? TW_MULT : 1.0;
  const weightedSum = components.reduce((s, c) => s + c.weight * c.directionBps, 0);
  const bps = weightedSum * regimeMult * tw;
  // Confidence = weighted avg of component confidences (weight normalised)
  const wSum = components.reduce((s, c) => s + c.weight, 0) || 1;
  const avgConf = components.reduce((s, c) => s + c.weight * c.confidence, 0) / wSum;
  let signal: CompositeSignal;
  if      (bps >= THRESH_STRONG)      signal = "STRONG_LONG";
  else if (bps >= THRESH_NORMAL)      signal = "LONG";
  else if (bps <= -THRESH_STRONG)     signal = "STRONG_SHORT";
  else if (bps <= -THRESH_NORMAL)     signal = "SHORT";
  else                                signal = "NEUTRAL";
  return {
    bps: Math.round(bps * 10) / 10,
    signal,
    confidence: Math.round(avgConf * 100) / 100,
  };
}

/** Band of a bps forecast (used for the fitted forecast once promoted). */
function bandOf(bps: number): CompositeSignal {
  if (bps >= THRESH_STRONG) return "STRONG_LONG";
  if (bps >= THRESH_NORMAL) return "LONG";
  if (bps <= -THRESH_STRONG) return "STRONG_SHORT";
  if (bps <= -THRESH_NORMAL) return "SHORT";
  return "NEUTRAL";
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION SIZING [REF §5.3.8 Dollar Gamma]
// ═══════════════════════════════════════════════════════════════════════════
//
//  $Γ = Γ·S²/100  (per contract)
//  Gamma P&L per contract = 50·$Γ·R²
//  N = risk_budget / (50·$Γ_per_contract·R²)
//
//  We use ATM-equivalent $Γ per contract ≈ (S² × 0.01 × gammaDensity)
//  where gammaDensity ≈ 1/(S·σ·√T) × npdf(0) for ATM
function horizonOptionYears(horizon: Horizon, nowMs: number = Date.now()): number {
  const target = horizonTargetIso(horizon, new Date(nowMs));
  let T = yearsToExpiry(target, nowMs);
  if (!(T > 0)) T = yearsToExpiry(nextTradingDay(etDate(nowMs)), nowMs);
  return T;
}

function sizePosition(
  spot: number, vix: number | null, dollarGamma_M: number,
  rHat_bps: number, riskBudget_M: number, horizon: Horizon
): { contracts: number; pnl_M: number; dg_per_contract: number; premium_per_contract: number; premiumAtRisk_M: number; binding: string } {
  const R = rHat_bps / 10000;
  const pnl_M = 50 * Math.abs(dollarGamma_M) * R * R;
  // ATM-equivalent per-contract $Γ
  const sigma = Math.max(0.08, vixToAtmPct(vix ?? 20) / 100);
  // T of an option expiring at the horizon's target expiry, on the one clock
  // (timeToExpiry: calendar minutes to the settlement instant / 525,600, the
  // same basis as VIX). After today's close the daily target rolls to the
  // next session.
  const T = horizonOptionYears(horizon);
  // Whole contracts, rounded DOWN, gamma-P&L target AND premium at risk <=
  // budget (sizingMath.gammaBudgetContracts): the old count capped only the
  // gamma P&L, so 500 ATM contracts could cost more than the budget.
  const s = gammaBudgetContracts({ spot, sigma, T, rHatBps: rHat_bps, riskBudgetDollars: riskBudget_M * 1e6 });
  const dgEff = Math.max(s.dollarGammaPerContract / 1e6, 0.0001);  // $M/contract
  return {
    contracts: s.contracts,
    pnl_M: Math.round(pnl_M * 1000) / 1000,
    dg_per_contract: Math.round(dgEff * 1000) / 1000,
    premium_per_contract: Math.round(s.premiumPerContract * 100) / 100,                 // $ per contract
    premiumAtRisk_M: Math.round(s.contracts * s.premiumPerContract / 1e6 * 1000) / 1000, // $M, <= budget
    binding: s.binding,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PIVOT & LOCKED-TARGET ALIGNMENT
// ═══════════════════════════════════════════════════════════════════════════

function nearestPivot(spot: number, pb?: PivotBundle) {
  if (!pb) return null;
  const all: { name: string; value: number }[] = [
    { name: "PP",           value: pb.classic.pp },
    { name: "R1",           value: pb.classic.r1 },
    { name: "R2",           value: pb.classic.r2 },
    { name: "R3",           value: pb.classic.r3 },
    { name: "S1",           value: pb.classic.s1 },
    { name: "S2",           value: pb.classic.s2 },
    { name: "S3",           value: pb.classic.s3 },
    { name: "Fib R1",       value: pb.fibonacci.r1 },
    { name: "Fib R2",       value: pb.fibonacci.r2 },
    { name: "Fib S1",       value: pb.fibonacci.s1 },
    { name: "Fib S2",       value: pb.fibonacci.s2 },
    { name: "Cam H3",       value: pb.camarilla.h3 },
    { name: "Cam H4",       value: pb.camarilla.h4 },
    { name: "Cam H5",       value: pb.camarilla.h5 },
    { name: "Cam L3",       value: pb.camarilla.l3 },
    { name: "Cam L4",       value: pb.camarilla.l4 },
    { name: "Cam L5",       value: pb.camarilla.l5 },
  ];
  let best = all[0];
  let bestDist = Math.abs(best.value - spot);
  for (const p of all) {
    const d = Math.abs(p.value - spot);
    if (d < bestDist) { best = p; bestDist = d; }
  }
  return {
    name: best.name,
    value: Math.round(best.value * 100) / 100,
    distBps: Math.round((best.value - spot) / spot * 10000),
  };
}

function lockedTargetAlignment(
  compositeSignal: GatedSignal, spot: number, symbol: string
): { bias: "confirms_upside" | "confirms_downside" | "mixed" | "n/a"; note: string } {
  if (compositeSignal === "UNRATED") {
    return { bias: "n/a", note: "Direction not rated (no promoted fit): no alignment claim." };
  }
  // Only meaningful for SPX
  if (!symbol.includes("GSPC") && symbol !== "SPX") {
    return { bias: "n/a", note: "Locked targets are SPX-scale only." };
  }
  const t = LOCKED_SPX_TARGETS;
  const aboveVanna   = spot >= t.vanna;
  const nearCharm    = Math.abs(spot - t.charm) / spot < 0.003;
  const atUpsideZone = spot >= t.upside;
  const atDownsideZone = spot <= t.downside;
  if (compositeSignal === "STRONG_LONG" || compositeSignal === "LONG") {
    if (atUpsideZone)   return { bias: "mixed", note: `At locked UPSIDE ${t.upside} — edge is chasing.` };
    if (aboveVanna)     return { bias: "confirms_upside", note: `Above locked VANNA ${t.vanna}, long signal aligns with drift to UPSIDE ${t.upside} / CHARM ${t.charm}.` };
    return { bias: "confirms_upside", note: `Below VANNA ${t.vanna} but signal long — reclaim vanna is the trigger.` };
  }
  if (compositeSignal === "STRONG_SHORT" || compositeSignal === "SHORT") {
    if (atDownsideZone) return { bias: "mixed", note: `At locked DOWNSIDE ${t.downside} — edge is chasing.` };
    if (!aboveVanna)    return { bias: "confirms_downside", note: `Below VANNA ${t.vanna}, short signal aligns with drift to DOWNSIDE ${t.downside} / T2 DOWN ${t.t2Down}.` };
    return { bias: "confirms_downside", note: `Above VANNA ${t.vanna} but signal short — lose vanna is the trigger.` };
  }
  return { bias: "mixed", note: `Neutral signal. Watch VANNA ${t.vanna} as regime pivot; CHARM ${t.charm} as upside magnet.` };
}

// ═══════════════════════════════════════════════════════════════════════════
// AI SYSTEM PROMPT — fixed wording, no formula hallucination
// ═══════════════════════════════════════════════════════════════════════════

const MASTER_SYSTEM_PROMPT = `You are the master alpha engine inside BATCAVE. You receive a fully computed data packet for a SINGLE horizon (daily/weekly/monthly/quarterly). Synthesise the packet into a brief. Use only the numbers in the packet — do not compute new ones.

WHAT THE NUMBERS MEAN:
- The weights and β are HAND-SET (borrowed from a published sample), not fit to this terminal's history; say so once, plainly, and do not call them calibrated.
- r̂_final is in bps of expected horizon return. Paper baseline: 18.2bps per −$48.1M net-C on 3rd-Thu SOQ.
- If directionStatus is "unrated_heuristic" (compositeSignal "UNRATED"): the composite is a hand-set HEURISTIC score. Do NOT state a direction, a strength (strong/weak long/short), a size, or an expected P&L. Report the components and levels only, and say the direction is unrated until a fit on this terminal's history is reviewed and promoted.
- Only when directionStatus is "fitted_promoted": STRONG_LONG ≥ +20bps | LONG ≥ +8bps | NEUTRAL | SHORT ≤ −8bps | STRONG_SHORT ≤ −20bps of the fitted forecast.
- GEX regime enters as a MULTIPLIER on composite (0.70× in POS γ, 1.15× in NEG γ), not as its own bps.
- Charm fires only within its horizon window: daily=1d, weekly=5d, monthly=15d, quarterly=45d. OUTSIDE the window the signal is neutral by design — that is correct, not missing data.
- Vanna is ONLY ever an amplifier on charm when sign-confluent and IV>HV. If charm is zero, vanna is zero.
- TW multiplier (1.86×) is applied ONCE, only on 3rd-Thu/Fri of Mar/Jun/Sep/Dec.
- nearestPivot tells you which PRIOR-DAY classic/fib/camarilla level the spot is nearest to.
- lockedTargetAlignment maps the composite to the operator's hard-locked SPX framework.

OUTPUT FORMAT (markdown, concise):

## r̂ ${"{horizon-name-uppercase}"}
[signal or UNRATED] | [X]bps ([heuristic score] or [fitted forecast])

## Components
| Component | bps | Weight | Signal | Conf |
(table — one row per component. use the "directionBps" field.)

## Regime & Levels
GEX [X]$M · [regime] · multiplier [X]×
Zero-γ [X] · Call Wall [X] · Put Wall [X] · Charm-zero [X]
Nearest pivot: [name] @ [value] ([distBps]bps)

## Trade Setup
Only when directionStatus is "fitted_promoted" and recommendedContracts is present: Direction · GTBR trigger [X]pts · Size [N] contracts (premium at risk $[premiumAtRisk_M]M) · $Γ/ctrct [X]M. Otherwise write "direction unrated; no size" and the GTBR trigger only.

## Locked Framework
[one line on lockedTargetAlignment]

## Flags
Only list if real: charm outside window, vanna not confluent, GTBR wide, TW inactive, imbalance not provided.

## Calendar Context
One sentence on days-to-3F, triple-witching state, horizon fit.

Tone: senior desk, lowercase ok, direct. No disclaimers. No emojis.`.trim();

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

export async function runMasterAlpha(input: MasterAlphaInput): Promise<MasterAlphaOutput> {
  const { horizon, pivots, prevCloseImbalance_M, realisedVol } = input;
  const audit = horizon.audit;
  const spot = audit.spot;
  const symbol = horizon.symbol;
  const h = horizon.horizon;

  const now = new Date();
  const { daysAway, isTripleWitching, is3rdThursday, isThirdFriday, isWeeklyOpex } = getCalendarContext(now);

  // --- Pull dealer net-greeks directly from the audit block (source of truth) ---
  // netCTrue is Σ charm_strike × OI_strike × 100 per Perfiliev Table VIII — the
  // standardised net-C against which the paper measured NETC_SD_M = $80M. Falls back
  // to legacy charmPerDay * 1000 for older audit blocks that predate netCTrue.
  // Scale to $M (netCTrue is in raw $, divide by 1e6).
  const netCharm_M = audit.netCTrue != null
    ? audit.netCTrue / 1e6
    : audit.charmPerDay * 1000;
  const netVanna_M   = audit.vannaM;              // already $M, signed
  const gexTotal_M   = audit.gexTotal / 1e6;       // gexTotal is signed $ per 1%
  const gammaAtSpot_M = audit.gammaAtSpot;         // already $M
  // dollar gamma aggregate for sizing — |gex| converted to $M
  const dollarGamma_M = Math.abs(gexTotal_M);
  const vix          = horizon.vol?.vix ?? null;

  // --- Component 1: Charm ---
  const charmC = charmComponent(netCharm_M, daysAway, h);

  // --- Component 2: Vanna (amplifier on charm, not standalone) ---
  const iv = vix != null ? vixToAtmPct(vix) / 100 : null; // true ATM vol for honest IV/RV comparison
  const hv = realisedVol ?? null;
  const vannaC = vannaComponent(netVanna_M, charmC.directionBps, iv, hv, daysAway, h);

  // --- Component 3: GEX regime (enters as multiplier, not bps) ---
  const gexR = gexRegime(gexTotal_M);

  // --- Component 4: GTBR ---
  const gtbrR = gtbrComponent(spot, gammaAtSpot_M, vix, h);

  // --- Component 5: Overnight drift ---
  const odC = overnightDriftComponent(prevCloseImbalance_M, daysAway);

  const components = [charmC, vannaC, gexR.component, gtbrR.component, odC];

  // --- Composite (hand-set heuristic) ---
  const comp = aggregate(components, gexR.compositeMultiplier, isTripleWitching, daysAway);

  // --- Gate: direction label and size only from a reviewed, promoted fit ---
  const gate = masterAlphaPromotionGate(input.promotion !== undefined ? input.promotion : loadPromotion(), h);
  const fittedBps = gate.promoted ? promotedForecastBps(gate.model, components) : null;
  const promoted = gate.promoted && fittedBps != null;
  const edgeBps = promoted ? Math.round((fittedBps as number) * 10) / 10 : comp.bps;
  const gatedSignal: GatedSignal = promoted ? bandOf(edgeBps) : "UNRATED";
  const directionNote = promoted
    ? gate.reason
    : gate.promoted ? "promoted fit needs a component that is missing in this snapshot: unrated" : gate.reason;

  // --- Sizing: promoted fit AND the user's own budget input ---
  const budget = resolveMasterAlphaRiskBudget(input);
  const size = sizePosition(spot, vix, dollarGamma_M, edgeBps, (budget.dollars ?? 0) / 1e6, h);
  // SF-7: the count is priced on the CHOSEN contract (ATM option of the
  // horizon's target expiry on the fitted side) at its Schwab ask plus the
  // fee, whole contracts rounded down, never on a model premium: premium plus
  // opening fee at risk <= the user's budget.
  let chosen: { strike: number; ask: number; symbol: string | null; type: "C" | "P" } | null = null;
  let sizeFromAsk: ReturnType<typeof contractsFromAsk> = null;
  let sizeWhyNot = "";
  const wantsSize = promoted && budget.dollars != null && budget.dollars > 0 && gatedSignal !== "NEUTRAL" && gatedSignal !== "UNRATED";
  if (wantsSize) {
    try {
      const { getOptionChain } = await import("./schwab");
      const expiryIso = horizonTargetIso(h, now).slice(0, 10);
      const dte = Math.max(0, Math.round((Date.parse(expiryIso) - Date.parse(etDate(now.getTime()))) / 86_400_000));
      const chain: any = await getOptionChain(symbol === "SPY" ? "SPY" : "$SPX", dte);
      const type: "C" | "P" = gatedSignal.includes("LONG") ? "C" : "P";
      const map = chain && !("error" in chain) ? (type === "C" ? chain.callExpDateMap : chain.putExpDateMap) ?? {} : {};
      const key = Object.keys(map).find((k) => k.startsWith(expiryIso));
      const atm = key ? atmContractFrom(map[key], spot) : null;
      if (!atm) sizeWhyNot = `no Schwab quote for the ${expiryIso} ATM ${type === "C" ? "call" : "put"}`;
      else {
        chosen = { strike: atm.strike, ask: atm.ask, symbol: atm.symbol, type };
        const fee = feeForProduct(atm.symbol ?? (symbol === "SPY" ? "SPY" : "SPXW"));
        sizeFromAsk = contractsFromAsk({ budgetDollars: budget.dollars as number, ask: atm.ask, fee: fee.fee });
        if (!sizeFromAsk) sizeWhyNot = fee.basis;
      }
    } catch (e: any) {
      sizeWhyNot = `chain unavailable: ${e?.message ?? e}`;
    }
  }
  const sized = wantsSize && sizeFromAsk != null;
  const sizingNote = !promoted ? "no size: direction unrated (no promoted fit)"
    : budget.dollars == null ? `no size: ${budget.source}`
    : !wantsSize ? "no size: neutral forecast"
    : !sized ? `no size: ${sizeWhyNot}`
    : `${sizeFromAsk!.contracts} x ${chosen!.strike}${chosen!.type} at the Schwab ask $${chosen!.ask.toFixed(2)} + fee = $${sizeFromAsk!.costPerContract.toFixed(2)}/contract; premium at risk $${sizeFromAsk!.premiumAtRisk.toFixed(2)} <= ${budget.source} budget, whole contracts rounded down`;
  const R = edgeBps / 10000;
  const gammaPnlAt_r_hat = promoted ? 50 * dollarGamma_M * R * R : null;

  // --- Structural levels (mirrored from horizon.levels) ---
  const byKind = (k: string) => horizon.levels.find(l => l.kind === k)?.price ?? null;
  const callWallStrike = byKind("callWall");
  const putWallStrike  = byKind("putWall");
  const zeroGammaStrike = byKind("zeroGamma");

  // --- Pivot proximity & locked-target alignment ---
  const np = nearestPivot(spot, pivots);
  const lta = lockedTargetAlignment(gatedSignal, spot, symbol);

  // --- Packet to Claude ---
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const packet = {
    date: new Date().toISOString().split("T")[0],
    horizon: h,
    symbol,
    spot: r2(spot),
    daysTo3rdFriday: daysAway,
    is3rdThursday,
    isThirdFriday,
    isWeeklyOpex,
    isTripleWitching,
    masterFormula: "r̂_final = TW · regimeMult · Σ wᵢ · rᵢ",
    tripleWitchingMultiplier: (isTripleWitching && daysAway <= 1) ? TW_MULT : 1.0,
    gexRegimeMultiplier: r2(gexR.compositeMultiplier),
    components: components.map(c => ({
      name: c.name,
      directionBps: r2(c.directionBps),
      weight: c.weight,
      signal: c.signal,
      confidence: Math.round(c.confidence * 100),
      rawValue: r2(c.rawValue),
      source: c.source,
    })),
    compositeEdgeBps: edgeBps,
    compositeSignal: gatedSignal,
    directionStatus: promoted ? "fitted_promoted" : "unrated_heuristic",
    directionNote,
    heuristicScoreBps: comp.bps,
    compositeConfidence: Math.round(comp.confidence * 100),
    regime: gexR.regime,
    gexDollars_M: r2(gexTotal_M),
    zeroGammaStrike: zeroGammaStrike != null ? Math.round(zeroGammaStrike) : null,
    callWallStrike:  callWallStrike  != null ? Math.round(callWallStrike)  : null,
    putWallStrike:   putWallStrike   != null ? Math.round(putWallStrike)   : null,
    charmZero:       audit.charmZero != null ? Math.round(audit.charmZero) : null,
    gtbrPoints: gtbrR.gtbrPoints,
    gtbrPct: r2(gtbrR.gtbrPct * 100),
    // Size only with a promoted fit and the user's budget; premium at risk
    // <= that budget (the most the size loses if the options expire worthless).
    recommendedContracts: sized ? sizeFromAsk!.contracts : null,
    premiumPerContract: sized ? sizeFromAsk!.costPerContract : null,
    premiumAtRisk_M: sized ? sizeFromAsk!.premiumAtRisk / 1e6 : null,
    sizeBinding: sized ? sizeFromAsk!.binding : null,
    sizingNote,
    dollarGamma_per_contract_M: size.dg_per_contract,
    dollarGammaAggregate_M: r2(dollarGamma_M),
    gammaPnlAt_r_hat_M: gammaPnlAt_r_hat != null ? r2(gammaPnlAt_r_hat) : null,
    netCharm_M: r2(netCharm_M),
    netVanna_M: r2(netVanna_M),
    gammaAtSpot_M: r2(gammaAtSpot_M),
    vix, realisedVol: hv,
    nearestPivot: np,
    lockedTargetAlignment: lta,
    priorDayRange: pivots?.range != null ? r2(pivots.range) : null,
    coefficientStatus: promoted ? "fitted" : MASTER_ALPHA_COEFFICIENT_STATUS,
  };

  let aiAnalysis = "Unavailable.";
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1400,
      system: MASTER_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `BATCAVE ${h.toUpperCase()} alpha packet:\n\n${JSON.stringify(packet, null, 2)}`,
      }],
    });
    aiAnalysis = response.content[0].type === "text" ? response.content[0].text : aiAnalysis;
  } catch (err) {
    // AI is supplementary — composite stands on its own
    aiAnalysis = `AI narrative unavailable: ${(err as any)?.message ?? err}`;
  }

  return {
    timestamp: packet.date,
    horizon: h,
    symbol,
    spot,
    daysTo3rdFriday: daysAway,
    is3rdThursday,
    isThirdFriday,
    isWeeklyOpex,
    isTripleWitching,
    settlementType: "AM_SOQ",
    components,
    compositeEdgeBps: edgeBps,
    compositeSignal: gatedSignal,
    compositeConfidence: comp.confidence,
    heuristicBand: comp.signal,
    heuristicScoreBps: comp.bps,
    directionStatus: promoted ? "fitted_promoted" : "unrated_heuristic",
    directionNote,
    gexRegime: gexR.regime,
    gexDollars_M: gexTotal_M,
    zeroGammaStrike,
    callWallStrike,
    putWallStrike,
    charmZero: audit.charmZero,
    gtbrPoints: gtbrR.gtbrPoints,
    gtbrPct: gtbrR.gtbrPct,
    nearestPivot: np,
    lockedTargetAlignment: lta,
    recommendedContracts: sized ? sizeFromAsk!.contracts : null,
    premiumPerContract: sized ? sizeFromAsk!.costPerContract : null,
    premiumAtRisk_M: sized ? sizeFromAsk!.premiumAtRisk / 1e6 : null,
    dollarGammaAggregate: dollarGamma_M,
    gammaPnlAt_r_hat,
    sizingNote,
    aiAnalysis,
    coefficientStatus: promoted ? "fitted" : MASTER_ALPHA_COEFFICIENT_STATUS,
    coefficientNote: promoted ? gate.reason : COEFFICIENT_NOTE,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE — consumes a horizon (daily/weekly/monthly) and optional pivots
// ═══════════════════════════════════════════════════════════════════════════

import { buildModelsSnapshot } from "./models";
import { buildPivotBundle } from "./pivots";
import { fetchOHLC } from "./ohlc";
import { fetchPrevDayOHLC } from "./quotes";
import { getQuotes as schwabGetQuotes, getSchwabStatus } from "./schwab";
import { classifyRouteError, unavailableBody } from "@shared/unavailable";

export async function masterAlphaRoute(req: any, res: any) {
  try {
    const horizonKey = (req.query?.horizon ?? req.body?.horizon ?? "daily") as Horizon;
    // Normalize SPX aliases to ^GSPC so buildModelsSnapshot/buildHorizon hits the SPX spot path.
    // Without this, symbol="SPX" silently falls through to SPY math (spot ~708 instead of ~7108).
    const rawSymbol = String(req.query?.symbol ?? req.body?.symbol ?? "^GSPC").toUpperCase();
    const symbol: "^GSPC" | "SPY" =
      rawSymbol === "SPX" || rawSymbol === "$SPX" || rawSymbol === "$SPX.X" || rawSymbol === "^GSPC"
        ? "^GSPC"
        : rawSymbol === "SPY"
          ? "SPY"
          : "^GSPC";
    const prevCloseImbalance_M = req.body?.prevCloseImbalance_M as number | undefined;
    const realisedVol = req.body?.realisedVol as number | undefined;
    // Sizing inputs are the user's own (no default $1M budget).
    const accountSize = req.body?.accountSize as number | undefined;
    const riskPct = req.body?.riskPct as number | undefined;
    const riskBudgetDollars = req.body?.riskBudgetDollars as number | undefined;
    const riskBudget_M = req.body?.riskBudget_M as number | undefined;

    // pull vix from ohlc
    let vix: number | null = null, vixPrev: number | null = null, vix3m: number | null = null;
    try {
      const v  = await fetchOHLC("^VIX", "1D");
      vix = v?.price ?? v?.candles?.[v.candles.length - 1]?.c ?? null;
      // Prior SESSION close (ohlc.prevClose via dayChange), not the previous
      // 5-minute bar of a 1D intraday series.
      vixPrev = v?.prevClose ?? null;
    } catch { /* non-fatal */ }
    try {
      const v3 = await fetchOHLC("^VIX3M", "1D");
      vix3m = v3?.price ?? v3?.candles?.[v3.candles.length - 1]?.c ?? null;
    } catch { /* non-fatal */ }

    // build the horizon via existing snapshot engine
    const snapshot = await buildModelsSnapshot({
      vix, vixPrev, vix3m,
      symbols: [symbol],
      horizons: [horizonKey],
    });
    const horizon = snapshot.horizons[horizonKey];
    if (!horizon) {
      // buildModelsSnapshot records a failed horizon (Schwab chain/spot
      // missing) as a warning: that is a missing upstream, not a bug.
      const why = (snapshot.warnings ?? []).join("; ") || "no Schwab data for this horizon";
      return res.status(503).json({ ...unavailableBody(`Horizon ${horizonKey} unavailable: ${why}`), error: `Horizon ${horizonKey} unavailable`, warnings: snapshot.warnings });
    }

    // build prior-day pivot bundle from the most recent COMPLETED daily
    // session (fetchPrevDayOHLC, exchange-calendar aware). The old code took
    // the second-to-last bar of a 1D intraday series: a 5-minute bar, not a day.
    let pivots: PivotBundle | undefined;
    try {
      const prior = await fetchPrevDayOHLC(symbol);
      if (prior) pivots = buildPivotBundle(symbol, { o: prior.o, h: prior.h, l: prior.l, c: prior.c });
    } catch { /* pivots are optional */ }

    const out = await runMasterAlpha({
      horizon, pivots, prevCloseImbalance_M, realisedVol,
      accountSize, riskPct, riskBudgetDollars, riskBudget_M,
    });
    res.json(out);
  } catch (err: any) {
    // Missing upstream (typed error, or Schwab not connected) -> 503 with the
    // reason; anything else is a real bug -> 500.
    let schwabConnected: boolean | null = null;
    try { schwabConnected = getSchwabStatus().connected; } catch { schwabConnected = null; }
    const out = classifyRouteError(err, "master alpha failed", { schwabConnected, key: "error" });
    if (out.kind === "bug") console.error("[masterAlpha]", err);
    res.status(out.status).json(out.body);
  }
}
