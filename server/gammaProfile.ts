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
 * This is the number SpotGamma / MenthorQ / Cboe's Volatility Pulse publish.
 */

// Standard-normal PDF.
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes gamma for a single option.
 * Perfiliev uses slightly different formulas for calls vs puts. The call form is
 * the textbook BS gamma; the put form he shows is algebraically equivalent when
 * q = 0, but reproducing his exact code keeps us comparable to his reference
 * numbers. Both reduce to φ(d₁) / (S·σ·√T) under q = 0, r = 0.
 */
function bsGamma(
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
  oi: number;     // open interest
  dte: number;    // calendar days to expiry
}

export interface GammaProfilePoint {
  spot: number;   // hypothetical spot level
  gex: number;    // net dealer gamma in $ per 1% move at this spot
}

export interface GammaProfile {
  curve: GammaProfilePoint[];       // 60 spot levels, 0.8·S → 1.2·S
  zeroGammaSpot: number | null;     // interpolated spot price where total γ flips
  currentSpot: number;
  currentGex: number;               // total GEX evaluated at the current spot
  minGex: number;
  maxGex: number;
}

/**
 * Perfiliev's convention: 262 trading days/yr, 1/262 floor for 0DTE.
 * We receive dte in CALENDAR days, so convert: ~262/365 ≈ 0.7178 to get trading days.
 */
function toTradingYears(dteCalendar: number): number {
  const tradingDays = Math.max(1, Math.round(dteCalendar * (262 / 365)));
  return tradingDays / 262;
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
  opts: { r?: number; q?: number; nLevels?: number; lowPct?: number; highPct?: number } = {},
): GammaProfile {
  const r = opts.r ?? 0.05;
  const q = opts.q ?? 0.013;
  const nLevels = opts.nLevels ?? 60;
  const lowPct = opts.lowPct ?? 0.9;
  const highPct = opts.highPct ?? 1.1;

  const lo = lowPct * spot;
  const hi = highPct * spot;
  const step = (hi - lo) / (nLevels - 1);

  // Pre-compute T per row (doesn't change with spot).
  const precomputed = rows
    .filter((row) => row.iv > 0 && row.oi > 0 && row.dte >= 0)
    .map((row) => ({
      ...row,
      T: toTradingYears(row.dte),
      sign: row.type === "C" ? 1 : -1,
    }));

  const curve: GammaProfilePoint[] = [];
  for (let i = 0; i < nLevels; i++) {
    const S = lo + i * step;
    let totalGex = 0;
    for (const row of precomputed) {
      const gamma = bsGamma(S, row.strike, row.iv, row.T, r, q, row.type);
      // dollar-gamma per 1% move: γ · OI · 100 · S² · 0.01
      totalGex += row.sign * gamma * row.oi * 100 * S * S * 0.01;
    }
    curve.push({ spot: S, gex: totalGex });
  }

  // Find zero-crossing via linear interpolation between adjacent levels.
  let zeroGammaSpot: number | null = null;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.gex === 0) { zeroGammaSpot = a.spot; break; }
    if (a.gex * b.gex < 0) {
      // linear: spot where gex = 0
      zeroGammaSpot = a.spot - a.gex * (b.spot - a.spot) / (b.gex - a.gex);
      break;
    }
  }

  // Evaluate current spot GEX by re-running the sum at S (for a consistent
  // "this is what the profile says right now" number).
  let currentGex = 0;
  for (const row of precomputed) {
    const gamma = bsGamma(spot, row.strike, row.iv, row.T, r, q, row.type);
    currentGex += row.sign * gamma * row.oi * 100 * spot * spot * 0.01;
  }

  const values = curve.map((p) => p.gex);
  return {
    curve,
    zeroGammaSpot,
    currentSpot: spot,
    currentGex,
    minGex: Math.min(...values),
    maxGex: Math.max(...values),
  };
}
