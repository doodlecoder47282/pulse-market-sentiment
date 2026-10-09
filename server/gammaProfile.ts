/**
 * Gamma Profile — Perfiliev-style (canonical) zero-gamma level calculation.
 *
 * Source methodology: https://perfiliev.com/blog/how-to-calculate-gamma-exposure-and-zero-gamma-level/
 *
 * KEY DIFFERENCE from our original cumulative-by-strike approach:
 *   - Original: sum per-strike GEX as you move up through strikes at CURRENT spot;
 *     find where cumulative flips sign. Answers "where is the GEX centroid?".
 *   - Perfiliev (this module): recompute Black-Scholes gamma for EVERY option at
 *     60 hypothetical spot levels between 0.8·S and 1.2·S. Sum signed dollar-gamma
 *     at each level. Find where TOTAL gamma flips sign as spot moves. That is the
 *     "gamma flip" — the level at which dealer hedging regime would invert.
 *
 * This is the method Perfiliev and SpotGamma describe for the zero-gamma level.
 * Batcave uses ONE flip definition everywhere (Signals, Heatseeker, Trade Desk
 * environment, gamma curve, killbox/thermal maps): the re-priced crossing from
 * buildGammaProfile / repricedFlipFromChain below. The cumulative-by-strike
 * number survives only as a labeled secondary (cumulativeStrikeFlip).
 */

import { contractYears, dteYears, ivForClock } from "./chainClock";
import type { SettlementStyle } from "./timeToExpiry";

// Standard-normal PDF.
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes gamma for a single option (per share, per 1.00 of spot).
 * Perfiliev's notebook writes the call form as e^(-qT)·φ(d₁)/(S·σ·√T) and the
 * put form as K·e^(-rT)·φ(d₂)/(S²·σ·√T). They are the same number for any r, q
 * because S·e^(-qT)·φ(d₁) = K·e^(-rT)·φ(d₂) (Hull, OFOD, gamma is identical
 * for calls and puts); the put form is kept to stay line-for-line comparable.
 */
export function bsGamma(
  S: number, K: number, vol: number, T: number,
  r: number, q: number, type: "C" | "P",
): number {
  if (T <= 0 || vol <= 0 || S <= 0 || K <= 0) return 0;
  const dp = (Math.log(S / K) + (r - q + 0.5 * vol * vol) * T) / (vol * Math.sqrt(T));
  const dm = dp - vol * Math.sqrt(T);
  if (type === "C") {
    return Math.exp(-q * T) * normPdf(dp) / (S * vol * Math.sqrt(T));
  }
  // Put form per Perfiliev's code (uses dm and K/(S²)).
  return K * Math.exp(-r * T) * normPdf(dm) / (S * S * vol * Math.sqrt(T));
}

/** Contract-level option record we need for profile re-computation. */
export interface OptionRow {
  type: "C" | "P";
  strike: number;
  iv: number;     // implied vol, decimal (0.15 = 15%)
  oi: number;     // open interest (or the caller's position weight)
  dte: number;    // calendar days to expiry
  /** Optional time to expiry in years (server/timeToExpiry.ts clock). When
   *  set it is used as is; <= 0 means settled and the row is dropped. */
  T?: number;
  /** Optional expiry date "YYYY-MM-DD" and settlement style; used for T when
   *  T is not supplied (more precise than the whole-day dte). */
  expiry?: string;
  style?: SettlementStyle;
}

export interface GammaProfilePoint {
  spot: number;   // hypothetical spot level
  gex: number;    // net dealer gamma in $ per 1% move at this spot
}

export interface GammaProfile {
  curve: GammaProfilePoint[];       // nLevels spot levels, lowPct·S → highPct·S
  /** THE gamma flip used across Batcave: the re-priced zero crossing of net
   *  dealer gamma vs spot that lies nearest the current spot, refined by
   *  bisection on the exact sum (not just linear interpolation on the grid).
   *  null when net gamma keeps one sign across the whole range. */
  zeroGammaSpot: number | null;
  /** Every sign change of the re-priced curve inside the range, ascending. */
  zeroCrossings: number[];
  currentSpot: number;
  currentGex: number;               // total GEX evaluated at the current spot
  minGex: number;
  maxGex: number;
  rowsUsed: number;                 // contracts with usable IV and OI
  method: "repriced-profile";
  /** Materiality floor ($ per 1%) below which a curve point counts as zero
   *  when looking for sign changes (see GEX_NOISE_REL). */
  noiseFloor: number;
  /** Sign changes found only between sub-floor points (far-wing underflow),
   *  reported for transparency and NOT used as flips. */
  discardedCrossings: number[];
  /** Kept crossings whose bracket spans a sub-floor valley (net gamma ~0 over
   *  a stretch of spot): a real change of sign between two material lobes,
   *  but its exact location inside the valley is not meaningful. */
  valleyCrossings: number[];
  /** true when zeroGammaSpot is one of valleyCrossings. */
  zeroGammaInValley: boolean;
  /** |currentGex| >= noiseFloor: there is material dealer gamma at spot. */
  currentGexMaterial: boolean;
  /** Sign of currentGex when material; null = "no material gamma at spot"
   *  (or no contracts), never a long/short call. */
  currentGexSign: 1 | -1 | null;
  /** Dealer sign per call / put contract used for this profile. */
  callSign: number;
  putSign: number;
}

/** T for a row: the caller's T when supplied, else the shared clock
 *  (server/timeToExpiry.ts: calendar minutes to the settlement instant /
 *  525,600, 15-minute floor) from the row's expiry date or whole-day dte.
 *  null = drop the row: T <= 0 (or non-finite) means the contract has
 *  settled (e.g. AM-settled SPX after the open), so it carries no gamma. */
function rowT(row: OptionRow, nowMs: number): number | null {
  const T = row.T != null ? row.T : dteYears(row.dte, { expiry: row.expiry ?? null, style: row.style, nowMs });
  return Number.isFinite(T) && T > 0 ? T : null;
}

/**
 * Rate and dividend yield used by EVERY gamma-flip consumer (passed
 * explicitly at each call site so they cannot drift apart). These are the
 * values the Signals snapshot and the Models exposure profile already used:
 * r = 5% (front-end T-bill level), q = 1.3% (S&P 500 trailing dividend
 * yield). Gamma is insensitive to both at these horizons; they matter only
 * for consistency between panels.
 */
export const FLIP_RATE = 0.05;
export const FLIP_DIV_YIELD = 0.013;

/**
 * Dividend yield for a chain's underlying. FLIP_DIV_YIELD is the S&P 500
 * index yield, so it applies only to S&P 500 underlyings (SPX, SPXW, XSP,
 * SPY). Any other symbol gets q = 0 unless a yield is known: an index yield
 * is not a single name's yield, and for the short tenors these maps weight q
 * barely moves gamma anyway.
 */
export function dividendYieldFor(symbol: string | null | undefined): number {
  const s = String(symbol ?? "").toUpperCase().replace(/^\$/, "").replace(/\.X$/, "");
  return s === "SPX" || s === "SPXW" || s === "XSP" || s === "SPY" || s === "^GSPC" || s === "GSPC" ? FLIP_DIV_YIELD : 0;
}

/**
 * Dollar gamma of a position, in $ per 1% move of the underlying:
 *   gamma (per share, per $1 of spot) x contracts x 100 (shares per contract,
 *   SPX/SPXW/SPY/XSP/QQQ and US equity options) x S^2 x 0.01.
 * Derivation: a 1% move dS = 0.01 S changes delta by gamma * 0.01 S per
 * share; the hedge notional of that delta change is (gamma * 0.01 S) * S per
 * share, times 100 shares per contract.
 */
export function dollarGexPerPct(gamma: number, contracts: number, spot: number, multiplier = 100): number {
  return gamma * contracts * multiplier * spot * spot * 0.01;
}

type PricedRow = OptionRow & { T: number; sign: number };

/**
 * Materiality floor for zero crossings, relative to the largest |net GEX| on
 * the profile. Far from every strike, 0DTE gamma falls as exp(-d^2/2) and
 * underflows towards zero (sigma sqrt T ~ 0.2% for 2 h at 15% vol, so a
 * strike 3% away sits ~13 standard deviations out): there the sign of the sum
 * is set by whichever strike happens to be least far away, and the curve
 * "crosses zero" at levels like 7,160.8 with |GEX| ~ 1e-20 of the peak. Such a
 * crossing is a property of floating point, not of dealer hedging. A crossing
 * is kept only when both bracketing grid points are at least this fraction of
 * the profile's peak |GEX| (1e-6: a millionth of the peak, e.g. $5k per 1%
 * against a $5B peak). Real flips between two sizeable lobes are unaffected:
 * the grid points on either side of them are far above the floor.
 */
export const GEX_NOISE_REL = 1e-6;

/** Net dealer GEX ($ per 1% move) at hypothetical spot S, every contract re-priced. */
function netGexAt(rows: PricedRow[], S: number, r: number, q: number): number {
  let total = 0;
  for (const row of rows) {
    const gamma = bsGamma(S, row.strike, row.iv, row.T, r, q, row.type);
    // dollar-gamma per 1% move: γ · OI · 100 · S² · 0.01
    total += row.sign * dollarGexPerPct(gamma, row.oi, S);
  }
  return total;
}

/** Bisection on the exact re-priced sum inside a bracketing interval [a, b]
 *  where sign(f(a)) != sign(f(b)). Compares signs, not products, so tiny
 *  values (deep-OTM 0DTE gamma underflows towards 0) cannot flip the branch. */
function refineRoot(
  rows: PricedRow[], r: number, q: number,
  a: number, fa: number, b: number,
): number {
  let lo = a, hi = b;
  const sLo = Math.sign(fa);
  for (let i = 0; i < 60 && hi - lo > 1e-9 * Math.max(1, Math.abs(lo)); i++) {
    const mid = 0.5 * (lo + hi);
    const sm = Math.sign(netGexAt(rows, mid, r, q));
    if (sm === 0) return mid;
    if (sm === sLo) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Sign changes of a re-priced curve. Exact zeros are skipped (they appear where
 * every contract's gamma has underflowed, e.g. 0DTE far from all strikes); a
 * sign change across such a zero plateau is bracketed by the nearest non-zero
 * points on either side and bisected like any other crossing.
 */
function findCrossings(
  curve: GammaProfilePoint[], rows: PricedRow[], r: number, q: number, floor = 0,
): Array<{ x: number; valley: boolean }> {
  const out: Array<{ x: number; valley: boolean }> = [];
  let prev: GammaProfilePoint | null = null;
  let skipped = false; // a zero / sub-floor point lies between prev and p
  for (const p of curve) {
    if (!(p.gex !== 0 && Number.isFinite(p.gex)) || Math.abs(p.gex) < floor) {
      skipped = true; // underflow or below the materiality floor: plateau
      continue;
    }
    if (prev && Math.sign(prev.gex) !== Math.sign(p.gex)) {
      out.push({ x: refineRoot(rows, r, q, prev.spot, prev.gex, p.spot), valley: skipped });
    }
    prev = p;
    skipped = false;
  }
  return out;
}

export interface GammaProfileOptions {
  r?: number; q?: number; nLevels?: number; lowPct?: number; highPct?: number; nowMs?: number;
  /** Dealer sign of one call / put contract. Default +1 / -1: the naive
   *  SqueezeMetrics convention ("Call options are sold by investors; bought
   *  by market-makers. Put options are bought by investors; sold by
   *  market-makers." SqueezeMetrics, "Gamma Exposure (GEX)", 2016, rev.
   *  2017, https://squeezemetrics.com/download/white_paper.pdf). 0 drops
   *  that side. Used for the dealer-convention sensitivity. */
  callSign?: number;
  putSign?: number;
}

/**
 * Build the gamma profile.
 *
 * @param rows    All option contracts (0-45 DTE), with IV + OI per contract
 * @param spot    Current spot price
 * @param r       Risk-free rate (default 0.05 — Perfiliev uses 0 but 5% is closer to 2026 reality)
 * @param q       Dividend yield (default 0.013 for SPY)
 * @param nLevels Number of spot levels to evaluate (default 60)
 * @param lowPct  Low end of spot range (default 0.9 — ±10% is more useful than ±20% for near-term flip)
 * @param highPct High end (default 1.1)
 */
export function buildGammaProfile(
  rows: OptionRow[],
  spot: number,
  opts: GammaProfileOptions = {},
): GammaProfile {
  const nowMs = opts.nowMs ?? Date.now();
  const r = opts.r ?? FLIP_RATE;
  const q = opts.q ?? FLIP_DIV_YIELD;
  const nLevels = Math.max(2, Math.floor(opts.nLevels ?? 60));
  const lowPct = opts.lowPct ?? 0.9;
  const highPct = opts.highPct ?? 1.1;
  const callSign = opts.callSign ?? 1;
  const putSign = opts.putSign ?? -1;

  const lo = lowPct * spot;
  const hi = highPct * spot;
  const step = (hi - lo) / (nLevels - 1);

  // Pre-compute T per row (doesn't change with spot).
  const precomputed: PricedRow[] = [];
  for (const row of rows) {
    if (!(row.iv > 0 && row.oi > 0 && row.dte >= 0 && Number.isFinite(row.iv) && Number.isFinite(row.strike))) continue;
    const T = rowT(row, nowMs);
    if (T == null) continue; // settled contract: no gamma
    const sign = row.type === "C" ? callSign : putSign;
    if (sign === 0) continue;
    precomputed.push({ ...row, T, sign });
  }

  const curve: GammaProfilePoint[] = [];
  for (let i = 0; i < nLevels; i++) {
    const S = lo + i * step;
    curve.push({ spot: S, gex: netGexAt(precomputed, S, r, q) });
  }

  // Every zero crossing on the grid, each refined by bisection on the exact
  // re-priced sum (grid steps are ~0.3% of spot, so linear interpolation alone
  // can miss the true root by several SPX points).
  // Crossings between points below the materiality floor (far-wing 0DTE
  // underflow) are discarded; see GEX_NOISE_REL.
  let peak = 0;
  for (const p of curve) if (Number.isFinite(p.gex)) peak = Math.max(peak, Math.abs(p.gex));
  const noiseFloor = GEX_NOISE_REL * peak;
  const kept = findCrossings(curve, precomputed, r, q, noiseFloor);
  const zeroCrossings = kept.map((c) => c.x);
  const valleyCrossings = kept.filter((c) => c.valley).map((c) => c.x);
  const rawCrossings = findCrossings(curve, precomputed, r, q, 0).map((c) => c.x);
  const discardedCrossings = rawCrossings.filter((z) => !zeroCrossings.some((k) => Math.abs(k - z) <= 1e-6 * Math.max(1, Math.abs(z))));
  // The flip that matters to the trader is the one nearest current spot: it is
  // the level whose crossing changes the sign of dealer gamma from here.
  // (Perfiliev's notebook reports the first crossing; on a single-crossing
  // profile — the usual SPX shape — the two agree.)
  let zeroGammaSpot: number | null = null;
  for (const z of zeroCrossings) {
    if (zeroGammaSpot == null || Math.abs(z - spot) < Math.abs(zeroGammaSpot - spot)) zeroGammaSpot = z;
  }

  // Evaluate current spot GEX by re-running the sum at S (for a consistent
  // "this is what the profile says right now" number).
  const currentGex = netGexAt(precomputed, spot, r, q);
  // Regime sign at spot only when the gamma there is material (same floor as
  // the crossings): a 0DTE spot far from every strike has |GEX| ~ 0 and its
  // sign is set by underflow, not hedging.
  const currentGexMaterial = precomputed.length > 0 && Number.isFinite(currentGex) && currentGex !== 0 && Math.abs(currentGex) >= noiseFloor;
  const currentGexSign: 1 | -1 | null = currentGexMaterial ? (currentGex > 0 ? 1 : -1) : null;

  const values = curve.map((p) => p.gex);
  return {
    curve,
    zeroGammaSpot,
    zeroCrossings,
    currentSpot: spot,
    currentGex,
    minGex: Math.min(...values),
    maxGex: Math.max(...values),
    rowsUsed: precomputed.length,
    method: "repriced-profile",
    noiseFloor,
    discardedCrossings,
    valleyCrossings,
    zeroGammaInValley: zeroGammaSpot != null && valleyCrossings.includes(zeroGammaSpot),
    currentGexMaterial,
    currentGexSign,
    callSign,
    putSign,
  };
}


// ─── Shared flip helpers (one definition for every panel) ─────────────────

/**
 * LEGACY secondary metric: the first strike (walking up from the lowest) at
 * which cumulative per-strike net GEX, evaluated at today's spot, changes
 * sign. It answers "where is the GEX centroid", not "where does dealer gamma
 * flip if spot moves there", and on a put-heavy chain it often finds no flip
 * at all. Show it only as a clearly labeled secondary field.
 */
export function cumulativeStrikeFlip(
  perStrike: ReadonlyArray<{ strike: number; netGex: number }>,
): number | null {
  const sorted = [...perStrike].filter((p) => Number.isFinite(p.strike) && Number.isFinite(p.netGex))
    .sort((a, b) => a.strike - b.strike);
  let cum = 0;
  for (const p of sorted) {
    const prev = cum;
    cum += p.netGex;
    if ((prev < 0 && cum >= 0) || (prev > 0 && cum <= 0)) return p.strike;
  }
  return null;
}

/** Minimal Schwab-shaped chain (the CBOE adapter emits the same shape). */
export interface ChainMapsLike {
  callExpDateMap?: Record<string, Record<string, any[]>> | null;
  putExpDateMap?: Record<string, Record<string, any[]>> | null;
}

export interface ChainRowOptions {
  /** Only these "YYYY-MM-DD:N" expiry keys (default: every expiry). */
  expiryKeys?: ReadonlyArray<string>;
  /** Drop expiries beyond this many calendar days. */
  maxDte?: number;
  /** Position weight per contract (default: open interest). */
  weight?: (contract: any, side: "C" | "P") => number;
  /** Time to expiry in years; undefined = the shared clock for this contract
   *  (chainClock.contractYears: AM SPX vs PM SPXW, half days), <= 0 = settled
   *  (row dropped). Gets the contract so a caller can tell the two apart. */
  tYears?: (expKey: string, dte: number, contract: any) => number | undefined;
  /** Spot: when given, sigma for expiries within 3 days is re-solved from the
   *  quote mid with our T (chainClock.ivForClock). */
  spot?: number;
  /** Valuation instant (default now). */
  nowMs?: number;
}

/** Calendar DTE from a Schwab expiry key "YYYY-MM-DD:N". */
function dteFromKey(expKey: string): number {
  const n = parseFloat(expKey.split(":")[1] ?? "");
  return Number.isFinite(n) ? Math.max(0, n) : NaN;
}

/**
 * Convert a Schwab/CBOE-adapter chain into re-pricing rows. IV is Schwab's
 * percent `volatility`; Schwab's -999 sentinel, NaN and absurd values are
 * dropped rather than treated as zero.
 */
export function rowsFromChain(chain: ChainMapsLike, opts: ChainRowOptions = {}): OptionRow[] {
  const keep = opts.expiryKeys ? new Set(opts.expiryKeys) : null;
  const nowMs = opts.nowMs ?? Date.now();
  const rows: OptionRow[] = [];
  const passes: Array<{ side: "C" | "P"; map: Record<string, Record<string, any[]>> | null | undefined }> = [
    { side: "C", map: chain.callExpDateMap },
    { side: "P", map: chain.putExpDateMap },
  ];
  for (const { side, map } of passes) {
    if (!map) continue;
    for (const expKey of Object.keys(map)) {
      if (keep && !keep.has(expKey)) continue;
      const strikes = map[expKey] || {};
      for (const strikeKey of Object.keys(strikes)) {
        const strikeFromKey = parseFloat(strikeKey);
        for (const c of strikes[strikeKey] || []) {
          const dteRaw = dteFromKey(expKey);
          const dte = Number.isFinite(dteRaw) ? dteRaw : Number(c?.daysToExpiration);
          if (!Number.isFinite(dte) || dte < 0) continue;
          if (opts.maxDte != null && dte > opts.maxDte) continue;
          const strike = Number.isFinite(strikeFromKey) ? strikeFromKey : Number(c?.strikePrice);
          if (!Number.isFinite(strike) || strike <= 0) continue;
          const w = opts.weight ? opts.weight(c, side) : Number(c?.openInterest) || 0;
          if (!Number.isFinite(w) || w <= 0) continue;
          const T = opts.tYears?.(expKey, dte, c) ?? contractYears(expKey, c, nowMs);
          if (!(Number.isFinite(T) && T > 0)) continue; // settled
          const ivPct = Number(c?.volatility);
          const vendorIv = Number.isFinite(ivPct) && ivPct > 0 && ivPct < 500 ? ivPct / 100 : NaN;
          const iv = opts.spot != null && opts.spot > 0
            ? ivForClock({ vendorIv, bid: Number(c?.bid), ask: Number(c?.ask), spot: opts.spot, strike, T, type: side })
            : vendorIv;
          if (!(Number.isFinite(iv) && iv > 0)) continue;
          rows.push({ type: side, strike, iv, oi: w, dte, T });
        }
      }
    }
  }
  return rows;
}

export interface RepricedFlip {
  zeroGamma: number | null;         // re-priced flip nearest spot (THE flip)
  zeroCrossings: number[];
  /** Re-priced net dealer GEX at spot, in $ per 1% spot move
   *  (gamma x weight x 100 x S^2 x 0.01). null when no usable contracts:
   *  missing data is not "zero gamma". */
  gexAtSpot: number | null;
  rowsUsed: number;
  method: "repriced-profile";
  /** Sub-noise far-wing sign changes that were NOT used (see GEX_NOISE_REL). */
  discardedCrossings?: number[];
  /** Materiality floor ($ per 1%) of this profile; null without contracts. */
  noiseFloor?: number | null;
  /** Sign of gexAtSpot when material; null = no material gamma at spot. */
  gexSignAtSpot?: 1 | -1 | null;
  /** The flip lies inside a sub-floor valley (location not meaningful). */
  zeroGammaInValley?: boolean;
  valleyCrossings?: number[];
}

/** Re-priced gamma flip straight from a chain: rowsFromChain + buildGammaProfile. */
export function repricedFlipFromChain(
  chain: ChainMapsLike,
  spot: number,
  opts: ChainRowOptions & GammaProfileOptions = {},
): RepricedFlip {
  const rows = rowsFromChain(chain, { ...opts, spot: opts.spot ?? spot });
  return repricedFlipFromRows(rows, spot, opts);
}

export function repricedFlipFromRows(
  rows: OptionRow[],
  spot: number,
  opts: GammaProfileOptions = {},
): RepricedFlip {
  if (!(spot > 0) || rows.length === 0) {
    return { zeroGamma: null, zeroCrossings: [], gexAtSpot: null, rowsUsed: 0, method: "repriced-profile", discardedCrossings: [], noiseFloor: null, gexSignAtSpot: null, zeroGammaInValley: false, valleyCrossings: [] };
  }
  const p = buildGammaProfile(rows, spot, opts);
  return {
    zeroGamma: p.zeroGammaSpot,
    zeroCrossings: p.zeroCrossings,
    gexAtSpot: p.rowsUsed > 0 ? p.currentGex : null,
    rowsUsed: p.rowsUsed,
    method: "repriced-profile",
    discardedCrossings: p.discardedCrossings,
    noiseFloor: p.rowsUsed > 0 ? p.noiseFloor : null,
    gexSignAtSpot: p.currentGexSign,
    zeroGammaInValley: p.zeroGammaInValley,
    valleyCrossings: p.valleyCrossings,
  };
}

// ─── Flip inputs label (weight + universe), shown by every flip consumer ──

export type FlipWeight = "open_interest" | "oi_plus_quarter_volume" | "volume";

/**
 * What a gamma flip was computed from. Panels deliberately differ:
 *   - Heatseeker / 0DTE forward: ONE expiry (default the nearest, usually
 *     0DTE), because they describe today's tape and the hedging that settles
 *     today;
 *   - Signals snapshot / gamma curve / thermal / killbox: every expiry inside
 *     the chain request (0-45 or 0-60 DTE), aggregate dealer positioning.
 * Weights: open interest is the standard (SqueezeMetrics, Perfiliev).
 * Killbox / thermal / 0DTE forward default to OI + 0.25 x today's volume
 * because 0DTE open interest is last night's count and misses positions
 * opened today; volume does not say whether a trade opened or closed, so the
 * 0.25 is a heuristic down-weight, not an estimate. The two flips therefore
 * answer different questions and can sit at different levels on the same
 * chain; the label says which one the trader is looking at.
 */
export interface FlipInputs {
  weight: FlipWeight;
  universe: "single-expiry" | "all-expiries-in-request";
  expiries: string[];            // "YYYY-MM-DD", ascending
  dteRange: [number, number] | null;
  dealerConvention: "naive-dealer-long-calls-short-puts";
  label: string;                 // one line for the UI
}

export function flipInputs(args: {
  weight: FlipWeight;
  universe: FlipInputs["universe"];
  expiryKeys: ReadonlyArray<string>;
  /** When expiry keys are not at hand: the DTE window the rows were filtered to. */
  dteRange?: [number, number];
}): FlipInputs {
  const parsed = Array.from(new Set(args.expiryKeys.map((k) => k.slice(0, 10)))).sort();
  const dtes = args.expiryKeys.map((k) => dteFromKey(k)).filter((x) => Number.isFinite(x));
  const dteRange: [number, number] | null = args.dteRange ?? (dtes.length ? [Math.min(...dtes), Math.max(...dtes)] : null);
  const w = args.weight === "open_interest" ? "OI-weighted"
    : args.weight === "volume" ? "volume-weighted"
    : "OI + 0.25 x volume";
  const u = args.universe === "single-expiry"
    ? `single expiry ${parsed[0] ?? "?"}${dteRange ? ` (${dteRange[0]} DTE)` : ""}`
    : `${parsed.length ? `${parsed.length} expiries` : "all expiries"}${dteRange ? `, ${dteRange[0]}-${dteRange[1]} DTE` : ""}`;
  return {
    weight: args.weight,
    universe: args.universe,
    expiries: parsed,
    dteRange,
    dealerConvention: "naive-dealer-long-calls-short-puts",
    label: `${w}, ${u}, naive dealer convention (long calls, short puts)`,
  };
}

// ─── Dealer-convention sensitivity ───────────────────────────────────────

/**
 * Schwab gives open interest only: no open/close flag, no customer type. The
 * dealer side of each contract is therefore ASSUMED. The naive convention
 * (dealers long calls, short puts: SqueezeMetrics 2016/2017; Perfiliev calls
 * it "a crude approximation ... true to some extent on an index level",
 * https://perfiliev.com/blog/how-to-calculate-gamma-exposure-and-zero-gamma-level/)
 * is the default everywhere. These alternatives show how much a conclusion
 * depends on it:
 *   dealer-short-all   customers net long every option (e.g. 0DTE call AND put
 *                      buying): dealers short calls and puts;
 *   calls-flat         call OI split evenly between customer buyers and
 *                      writers (dealer flat calls), dealers short puts.
 * Professional desks replace the assumption with trade-classified open/close
 * data (e.g. Cboe Open-Close), which Batcave does not have.
 */
export const DEALER_CONVENTIONS = [
  { id: "naive", label: "naive: dealers long calls, short puts (SqueezeMetrics)", callSign: 1, putSign: -1 },
  { id: "dealer-short-all", label: "dealers short calls and puts (customers net long both)", callSign: -1, putSign: -1 },
  { id: "calls-flat", label: "dealers flat calls, short puts", callSign: 0, putSign: -1 },
] as const;

export interface DealerConventionResult {
  id: string;
  label: string;
  callSign: number;
  putSign: number;
  /** $ per 1% move. 0 is an OBSERVED zero (the convention gives every usable
   *  contract zero weight, e.g. "calls flat" on a calls-only chain); null only
   *  when there are no usable contracts at all. */
  gexAtSpot: number | null;
  /** Sign at spot when material (>= the naive profile's floor); null = no material gamma. */
  gexSign: 1 | -1 | null;
  zeroGamma: number | null;      // re-priced flip nearest spot under this convention
}

export interface DealerSensitivity {
  assumption: "naive-dealer-long-calls-short-puts";
  conventions: DealerConventionResult[];
  /** true when every convention gives the same gamma sign at spot. */
  regimeSignRobust: boolean | null;
  note: string;
}

export function dealerConventionSensitivity(
  rows: OptionRow[],
  spot: number,
  opts: GammaProfileOptions = {},
): DealerSensitivity {
  // One materiality floor for every convention: the naive profile's (the
  // largest |GEX| scale the chain supports), so a convention is not judged
  // material against its own, possibly tiny, peak.
  const naive = repricedFlipFromRows(rows, spot, { ...opts, callSign: 1, putSign: -1 });
  const usable = naive.rowsUsed > 0;
  const floor = naive.noiseFloor ?? 0;
  const conventions: DealerConventionResult[] = DEALER_CONVENTIONS.map((c) => {
    const f = repricedFlipFromRows(rows, spot, { ...opts, callSign: c.callSign, putSign: c.putSign });
    // Usable contracts but none weighted under this convention: observed 0.
    const g = f.gexAtSpot != null ? f.gexAtSpot : usable ? 0 : null;
    const gexSign: 1 | -1 | null = g != null && g !== 0 && Math.abs(g) >= floor ? (g > 0 ? 1 : -1) : null;
    return { id: c.id, label: c.label, callSign: c.callSign, putSign: c.putSign, gexAtSpot: g, gexSign, zeroGamma: f.zeroGamma };
  });
  // Robustness over the conventions that HAVE a material value: an observed
  // zero has no sign to disagree with, and is reported, not dropped as missing.
  const signs = conventions.map((c) => c.gexSign).filter((x): x is 1 | -1 => x != null);
  const regimeSignRobust = !usable || signs.length === 0 ? null : signs.every((x) => x === signs[0]);
  const zeros = conventions.filter((c) => c.gexAtSpot != null && c.gexSign == null).map((c) => c.id);
  const zNote = zeros.length ? ` (no material gamma under: ${zeros.join(", ")})` : "";
  const note = !usable
    ? "sensitivity unavailable: no usable contracts"
    : signs.length === 0
      ? "no material gamma at spot under any convention"
      : regimeSignRobust
        ? `gamma sign at spot is the same under every convention with material gamma${zNote}`
        : `gamma sign at spot DEPENDS on the dealer-positioning assumption: treat the long/short gamma call as unconfirmed${zNote}`;
  return { assumption: "naive-dealer-long-calls-short-puts", conventions, regimeSignRobust, note };
}

// ─── Per-strike GEX from a chain (Signals snapshot, gamma curve, killbox DB) ──

export interface GexStrike { strike: number; callGex: number; putGex: number; netGex: number }

export interface ChainGex {
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  zeroGammaCumulative: number | null;
  profile: GexStrike[];
  /** "ok", or "no_spot" when the chain has no underlying last price (nothing computed). */
  dataState: "ok" | "no_spot";
  /** Weight and universe of the flip (0-45 DTE, OI-weighted). */
  flipInputs?: FlipInputs;
}

/**
 * Per-strike dealer GEX, $ per 1% move: vendor gamma x OI x 100 x S^2 x 0.01
 * (calls +, puts -), call/put walls, the app-wide re-priced flip and the
 * legacy cumulative flip. Settled contracts (chainClock.contractYears = 0)
 * and Schwab's -999 gamma sentinel are dropped. Without a real spot
 * (underlying.last missing or <= 0) nothing is computed: the old code used
 * spot = 1, which scaled every GEX by 1/S^2 and placed both walls by
 * comparing strikes with 1.
 */
export function gexByStrikeFromChain(
  chain: ChainMapsLike & { underlying?: { last?: number | null } | null },
  nowMs: number = Date.now(),
): ChainGex {
  const last = chain.underlying?.last;
  const spot = last != null && Number.isFinite(last) && last > 0 ? last : null;
  if (spot == null) {
    return { callWall: null, putWall: null, zeroGamma: null, zeroGammaCumulative: null, profile: [], dataState: "no_spot" };
  }
  const strikeMap = new Map<number, GexStrike>();
  const processMap = (map: Record<string, Record<string, any[]>> | null | undefined, side: "call" | "put") => {
    for (const expKey of Object.keys(map ?? {})) {
      const strikesObj = map![expKey];
      for (const strikeStr of Object.keys(strikesObj)) {
        const strike = parseFloat(strikeStr);
        if (!isFinite(strike)) continue;
        for (const c of strikesObj[strikeStr] ?? []) {
          if (!(contractYears(expKey, c, nowMs) > 0)) continue;
          const rawGamma = Number(c?.gamma ?? 0);
          const gamma = rawGamma <= -999 || !isFinite(rawGamma) ? 0 : rawGamma;
          const gex = dollarGexPerPct(gamma, Number(c?.openInterest ?? 0) || 0, spot);
          let row = strikeMap.get(strike);
          if (!row) { row = { strike, callGex: 0, putGex: 0, netGex: 0 }; strikeMap.set(strike, row); }
          if (side === "call") row.callGex += gex;
          else row.putGex -= gex; // puts invert
          row.netGex = row.callGex + row.putGex;
        }
      }
    }
  };
  processMap(chain.callExpDateMap, "call");
  processMap(chain.putExpDateMap, "put");

  const profile = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
  if (!profile.length) return { callWall: null, putWall: null, zeroGamma: null, zeroGammaCumulative: null, profile: [], dataState: "ok" };

  const callWall = profile.filter((p) => p.strike >= spot).reduce<GexStrike | null>((best, p) => (!best || p.callGex > best.callGex ? p : best), null);
  const putWall = profile.filter((p) => p.strike < spot).reduce<GexStrike | null>((best, p) => (!best || p.putGex < best.putGex ? p : best), null);
  // Flip: re-priced profile, same 0-45 DTE universe as the Signals snapshot.
  const zeroGamma = repricedFlipFromChain(chain, spot, { maxDte: 45, r: FLIP_RATE, q: FLIP_DIV_YIELD, nowMs }).zeroGamma;
  const keys = Array.from(new Set([...Object.keys(chain.callExpDateMap ?? {}), ...Object.keys(chain.putExpDateMap ?? {})]))
    .filter((k) => { const d = dteFromKey(k); return Number.isFinite(d) && d <= 45; });
  return {
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
    zeroGamma,
    zeroGammaCumulative: cumulativeStrikeFlip(profile),
    profile,
    dataState: "ok",
    flipInputs: flipInputs({ weight: "open_interest", universe: "all-expiries-in-request", expiryKeys: keys }),
  };
}
