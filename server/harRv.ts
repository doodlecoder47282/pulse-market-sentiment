// server/harRv.ts
//
// HAR-RV volatility forecast and the IV-minus-forecast spread z-score.
// Pure math, no I/O (ivRv.ts does the database and chain reads).
//
// Model: Corsi (2009), "A Simple Approximate Long-Memory Model of Realized
// Volatility", Journal of Financial Econometrics 7(2), 174-196,
// https://ideas.repec.org/a/oup/jfinec/v7y2009i2p174-196.html. Realized
// variance is regressed on its own daily, weekly (5-day) and monthly (22-day)
// averages:
//   RV_{t+1..t+h} = c + b_d RV_t + b_w RV_t^(w) + b_m RV_t^(m) + e,
// where the left side is the average daily RV over the next h sessions (the
// direct h-step form, so one fit gives the forecast that matches the option
// tenor: h = 21 sessions for a 30-calendar-day IV).
//
// RV proxy: squared daily close-to-close log returns. Batcave stores daily
// closes only, so this is the noisiest unbiased RV proxy (intraday realized
// variance would be better; Andersen & Bollerslev 1998). OLS on it is still
// consistent for the conditional mean; the noise lowers R^2, not the bias.
//
// Spread: IV30 - HAR forecast vol (annualized, vol points). Implied vol sits
// above expected realized vol on average (the variance risk premium: Carr &
// Wu 2009, "Variance Risk Premiums", Review of Financial Studies 22(3)), so the
// spread is judged against its OWN history: z = (spread - mean) / sd over
// past snapshots, with no look-ahead (each past spread uses only closes up to
// that day). Fixed IV/RV cut-offs (1.25 / 0.95) are no longer the verdict.

export const HAR_WEEK = 5;
export const HAR_MONTH = 22;
/** Fewer returns than this: no forecast (22 lags + horizon + a sensible sample). */
export const HAR_MIN_RETURNS = 250;
/** Fewer past spreads than this: no z-score verdict. */
export const SPREAD_MIN_HISTORY = 60;
/** |z| at or beyond this reads rich / cheap. A convention (one sd), not a tested edge. */
export const SPREAD_Z_CUT = 1;

export interface HarFit {
  coef: [number, number, number, number]; // c, b_d, b_w, b_m (daily variance units)
  n: number;                               // regression rows
  r2: number;
  horizon: number;
}

/** Squared daily log returns from closes (oldest first); invalid pairs skipped. */
export function squaredLogReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const r = Math.log(b / a);
    out.push(r * r);
  }
  return out;
}

function mean(xs: ArrayLike<number>, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += xs[i];
  return s / (to - from);
}

/** HAR regressors at time t (needs t >= HAR_MONTH - 1). */
function regressors(rv: number[], t: number): [number, number, number, number] {
  return [1, rv[t], mean(rv, t - HAR_WEEK + 1, t + 1), mean(rv, t - HAR_MONTH + 1, t + 1)];
}

/** Solve the 4x4 normal equations by Gaussian elimination with pivoting. */
function solve4(A: number[][], b: number[]): number[] | null {
  const n = 4;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/** OLS fit of the direct h-step HAR on an RV series (oldest first). */
export function fitHar(rv: number[], horizon = 21): HarFit | null {
  const h = Math.max(1, Math.round(horizon));
  const XtX = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const Xty = [0, 0, 0, 0];
  const ys: number[] = [];
  const xs: Array<[number, number, number, number]> = [];
  for (let t = HAR_MONTH - 1; t + h < rv.length; t++) {
    const x = regressors(rv, t);
    const y = mean(rv, t + 1, t + 1 + h);
    xs.push(x); ys.push(y);
    for (let i = 0; i < 4; i++) {
      Xty[i] += x[i] * y;
      for (let j = 0; j < 4; j++) XtX[i][j] += x[i] * x[j];
    }
  }
  if (ys.length < 30) return null;
  const beta = solve4(XtX, Xty);
  if (!beta || beta.some((b) => !Number.isFinite(b))) return null;
  const ybar = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sse = 0, sst = 0;
  for (let k = 0; k < ys.length; k++) {
    const yhat = beta[0] + beta[1] * xs[k][1] + beta[2] * xs[k][2] + beta[3] * xs[k][3];
    sse += (ys[k] - yhat) ** 2;
    sst += (ys[k] - ybar) ** 2;
  }
  return { coef: [beta[0], beta[1], beta[2], beta[3]], n: ys.length, r2: sst > 0 ? 1 - sse / sst : 0, horizon: h };
}

/** Forecast of the average daily variance over the next fit.horizon sessions, from the end of rv. */
export function harForecastVariance(rv: number[], fit: HarFit): number | null {
  const t = rv.length - 1;
  if (t < HAR_MONTH - 1) return null;
  const x = regressors(rv, t);
  const v = fit.coef[0] + fit.coef[1] * x[1] + fit.coef[2] * x[2] + fit.coef[3] * x[3];
  return v > 0 && Number.isFinite(v) ? v : null;
}

export interface HarVolForecast {
  annualVol: number;   // sqrt(252 x forecast average daily variance)
  fit: HarFit;
  returnsUsed: number;
}

/** HAR forecast of annualized vol over the next `horizon` sessions from daily closes. */
export function harVolForecast(closes: number[], horizon = 21): HarVolForecast | null {
  const rv = squaredLogReturns(closes);
  if (rv.length < HAR_MIN_RETURNS) return null;
  const fit = fitHar(rv, horizon);
  if (!fit) return null;
  const v = harForecastVariance(rv, fit);
  if (v == null) return null;
  return { annualVol: Math.sqrt(252 * v), fit, returnsUsed: rv.length };
}

export interface SpreadZ {
  spread: number;          // today's IV - forecast vol (decimal vol, 0.02 = 2 vol points)
  z: number | null;        // vs past spreads; null below SPREAD_MIN_HISTORY
  percentile: number | null; // share of past spreads below today's (0-1)
  historyN: number;
  mean: number | null;
  sd: number | null;
}

/** z-score and percentile of today's spread against past spreads (no look-ahead: caller passes only the past). */
export function spreadZScore(today: number, past: number[]): SpreadZ {
  const xs = past.filter(Number.isFinite);
  const n = xs.length;
  if (n < SPREAD_MIN_HISTORY || !Number.isFinite(today)) {
    return { spread: today, z: null, percentile: null, historyN: n, mean: null, sd: null };
  }
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const below = xs.filter((x) => x < today).length;
  return { spread: today, z: sd > 0 ? (today - m) / sd : null, percentile: below / n, historyN: n, mean: m, sd };
}

/** Verdict from the spread z-score; "insufficient" when there is no z. */
export function spreadVerdict(z: number | null): "rich" | "fair" | "cheap" | "insufficient" {
  if (z == null || !Number.isFinite(z)) return "insufficient";
  return z >= SPREAD_Z_CUT ? "rich" : z <= -SPREAD_Z_CUT ? "cheap" : "fair";
}
