// server/quoteShield.ts
//
// Quote-shield: outlier detection on incoming feed prices. FLAG-ONLY.
//
// CRITICAL: this module DOES NOT delete, suppress, or alter any quote. It only
// returns a metadata flag {suspect: true|false}. Existing calc paths are
// completely unaffected. Callers may log the flag or show it in diagnostics,
// but never drop a quote because of it.
//
// Method (finding 1.9). The old test compared the price LEVEL with the last
// 60 prices (Tukey IQR + MAD on levels). In a steady trend every new price
// sits outside the window's spread, so normal prices were flagged. Desks
// screen the RETURN against the instrument's own recent volatility:
//
//   r_i  = ln(P_i / P_ref)                 P_ref = last accepted price
//   x_i  = r_i / sqrt(dt_i)                dt in seconds: Brownian scaling, so
//                                          irregular poll gaps are comparable
//   s    = 1.4826 * MAD(x over the last 60 accepted returns)
//          (MAD scaled to the normal sigma: Rousseeuw & Croux 1993,
//           "Alternatives to the Median Absolute Deviation", JASA 88(424),
//           https://doi.org/10.1080/01621459.1993.10476408)
//   m    = median(x over the same window) (drift; ~0 at these horizons)
//   suspect when |r_i - m*sqrt(dt_i)| > K * s * sqrt(dt_i) + gamma
//          gamma = 2 ticks / price: the price-granularity allowance of
//          Brownlees & Gallo (2006), "Financial econometric analysis at
//          ultra-high frequency: Data handling concerns", CSDA 51(4),
//          https://econpapers.repec.org/paper/fireconom/wp2006_5f03.htm
//          (their filter also keeps a granularity term so a one-tick move in
//          a quiet market is never an outlier).
//   K = 8 robust sigmas: flag-only, so we want very few false alarms.
//   s is floored at 10% annualised (per sqrt regular-session second), below
//   the realised vol of SPX in almost every regime, so a quiet window cannot
//   make an ordinary move look like an outlier.
//
// A flagged print does not move P_ref and does not enter the volatility
// window, so a single bad print and its reversion are not both flagged. A
// real jump is accepted once 3 consecutive flagged prints agree with each
// other (within the same tolerance): the reference re-anchors to the new level.
// Gaps longer than MAX_GAP_S (overnight, halts) re-anchor without a test.
// Repeated identical observations (same price and timestamp, e.g. a cached
// payload served twice) carry no information and are ignored.

export type QuoteCheck = {
  suspect: boolean;
  reasons: string[];
  /** Robust z of the return: |r| / (s * sqrt(dt)); 0 when not tested. */
  modZ: number;
};

export const SHIELD_K = 8;
export const SHIELD_WINDOW = 60;
export const SHIELD_MIN_RETURNS = 10;
export const SHIELD_MAX_GAP_S = 2 * 3600;
export const SHIELD_JUMP_CONFIRM = 3;
/** Price increment used for the granularity allowance ($0.01 for equities and cash indexes). */
export const SHIELD_TICK = 0.01;
/** Floor on s, per sqrt(second): 10% annualised over 252 x 23,400 regular-session seconds. */
export const SHIELD_SIGMA_FLOOR = 0.10 / Math.sqrt(252 * 23_400);
const MAD_TO_SIGMA = 1.4826;

export interface ShieldState {
  refPrice: number | null;
  refTs: number | null;
  /** Normalised returns x_i = r_i / sqrt(dt_i) of accepted prices. */
  rets: number[];
  /** Consecutive flagged prints (price, ts) awaiting jump confirmation. */
  pending: Array<{ price: number; ts: number }>;
  lastObs: { price: number; ts: number } | null;
  lastCheck: QuoteCheck;
}

export function newShieldState(): ShieldState {
  return { refPrice: null, refTs: null, rets: [], pending: [], lastObs: null, lastCheck: { suspect: false, reasons: [], modZ: 0 } };
}

function median(xs: number[]): number {
  const a = xs.slice().sort((p, q) => p - q);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Robust sigma of normalised returns (per sqrt-second), floored. */
export function robustSigma(rets: number[]): number {
  if (rets.length === 0) return SHIELD_SIGMA_FLOOR;
  const m = median(rets);
  const mad = median(rets.map((x) => Math.abs(x - m)));
  return Math.max(SHIELD_SIGMA_FLOOR, MAD_TO_SIGMA * mad);
}

/** Tolerance on |log return| over dt seconds at robust sigma s. */
function tolerance(s: number, dtS: number, price: number): number {
  return SHIELD_K * s * Math.sqrt(dtS) + (2 * SHIELD_TICK) / price;
}

/**
 * Pure step: test one observation against the state and return the updated
 * state (input is not mutated) and the decision.
 */
export function shieldStep(state: ShieldState, price: number, tsMs: number): { state: ShieldState; check: QuoteCheck } {
  if (!Number.isFinite(price) || price <= 0) {
    return { state, check: { suspect: true, reasons: ["non-finite or non-positive price"], modZ: NaN } };
  }
  if (state.lastObs && state.lastObs.price === price && state.lastObs.ts === tsMs) {
    return { state, check: state.lastCheck };
  }
  const next: ShieldState = {
    refPrice: state.refPrice, refTs: state.refTs, rets: state.rets.slice(),
    pending: state.pending.slice(), lastObs: { price, ts: tsMs }, lastCheck: state.lastCheck,
  };
  const accept = (dtS: number | null, r: number | null): void => {
    if (dtS != null && r != null && dtS > 0) {
      next.rets.push(r / Math.sqrt(dtS));
      while (next.rets.length > SHIELD_WINDOW) next.rets.shift();
    }
    next.refPrice = price;
    next.refTs = tsMs;
    next.pending = [];
  };
  const done = (check: QuoteCheck) => { next.lastCheck = check; return { state: next, check }; };

  if (next.refPrice == null || next.refTs == null) {
    accept(null, null);
    return done({ suspect: false, reasons: [], modZ: 0 });
  }
  const dtS = Math.max(1, (tsMs - next.refTs) / 1000);
  const r = Math.log(price / next.refPrice);
  if (tsMs - next.refTs > SHIELD_MAX_GAP_S * 1000) {
    accept(null, null); // session gap: re-anchor, no test
    return done({ suspect: false, reasons: [], modZ: 0 });
  }
  if (next.rets.length < SHIELD_MIN_RETURNS) {
    accept(dtS, r); // warm-up: not enough returns to judge
    return done({ suspect: false, reasons: [], modZ: 0 });
  }
  const s = robustSigma(next.rets);
  const dev = r - median(next.rets) * Math.sqrt(dtS);
  const modZ = Math.abs(dev) / (s * Math.sqrt(dtS));
  if (Math.abs(dev) <= tolerance(s, dtS, price)) {
    accept(dtS, r);
    return done({ suspect: false, reasons: [], modZ });
  }
  // Flagged. Confirm a level shift after SHIELD_JUMP_CONFIRM consistent prints.
  next.pending.push({ price, ts: tsMs });
  const p = next.pending;
  if (p.length >= SHIELD_JUMP_CONFIRM) {
    const recent = p.slice(-SHIELD_JUMP_CONFIRM);
    let consistent = true;
    for (let i = 1; i < recent.length; i++) {
      const dt = Math.max(1, (recent[i].ts - recent[i - 1].ts) / 1000);
      if (Math.abs(Math.log(recent[i].price / recent[i - 1].price)) > tolerance(s, dt, recent[i].price)) consistent = false;
    }
    if (consistent) {
      accept(null, null); // jump confirmed: re-anchor, keep the jump out of the vol window
      return done({ suspect: false, reasons: [`level shift confirmed after ${SHIELD_JUMP_CONFIRM} consistent prints`], modZ });
    }
  }
  return done({
    suspect: true,
    reasons: [`return ${(r * 1e4).toFixed(1)} bp over ${dtS.toFixed(0)} s is ${modZ.toFixed(1)} robust sigma (limit ${SHIELD_K} + 2 ticks)`],
    modZ,
  });
}

// ─── In-memory state per symbol (flag-only — never gates anything) ──────────
const states: Map<string, ShieldState> = new Map();
const lastFlagTs: Map<string, number> = new Map();

/**
 * Observer entry-point: pass every newly-ingested price (with its own
 * timestamp when known: Schwab quoteTime, or the bar time). Callers MUST NOT
 * use the result to alter quote flow -- only to log or surface in diagnostics.
 */
export function observeQuote(symbol: string, price: number, tsMs: number = Date.now()): QuoteCheck {
  try {
    const st = states.get(symbol) ?? newShieldState();
    const { state, check } = shieldStep(st, price, tsMs);
    states.set(symbol, state);
    lastFlagTs.set(symbol, Date.now());
    if (check.suspect) {
      console.warn(`[quoteShield] ${symbol} suspect price ${price.toFixed(2)} — ${check.reasons.join(", ")}`);
    }
    return check;
  } catch {
    return { suspect: false, reasons: [], modZ: 0 };
  }
}

/** Read-only export of last-flag-per-symbol for the diagnostics endpoint. */
export function shieldStatus(): Array<{
  symbol: string;
  suspect: boolean;
  reasons: string[];
  modZ: number;
  windowSize: number;
  ageSeconds: number;
  method: string;
}> {
  const out: Array<any> = [];
  for (const [symbol, st] of Array.from(states.entries())) {
    out.push({
      symbol,
      suspect: st.lastCheck.suspect,
      reasons: st.lastCheck.reasons,
      modZ: st.lastCheck.modZ,
      windowSize: st.rets.length,
      ageSeconds: Math.round((Date.now() - (lastFlagTs.get(symbol) ?? Date.now())) / 1000),
      method: `log return vs ${SHIELD_K}x robust sigma (MAD of last ${SHIELD_WINDOW} returns, sqrt-time scaled) + 2 ticks`,
    });
  }
  return out;
}

/**
 * Check a new price against a recent, evenly spaced price sequence (oldest
 * first; `spacingS` seconds apart). Returns-based, same rule as observeQuote.
 */
export function checkQuote(newPrice: number, recent: number[], spacingS = 60): QuoteCheck {
  let st = newShieldState();
  const t0 = 0;
  recent.forEach((p, i) => { st = shieldStep(st, p, t0 + i * spacingS * 1000).state; });
  return shieldStep(st, newPrice, t0 + recent.length * spacingS * 1000).check;
}
