// server/convexityFit.ts
//
// Fit of the convexity index's driver points to FORWARD realized range
// (review items 6.5 / R2-C 8). Pure: no DB, no network.
//
// The Trade Environment index adds hand-set points for seven drivers. To find
// out whether those points carry information, every 30-minute bucket of the
// regular session logs the driver points and, 30 minutes later, the SPY
// realized high-low range over the next 30 minutes, normalized by the
// time-scaled 20-day ATR the range driver already uses:
//   y = ln( range_next30m / (ATR20 x sqrt(30/390)) )
// The high-low range is the classic efficient range-based volatility proxy
// (M. Parkinson, "The Extreme Value Method for Estimating the Variance of the
// Rate of Return", J. Business 53(1), 1980), and the log makes the
// multiplicative scale additive.
//
// Model (OLS):  y = c + sum_j b_j x_j + e,   x_j = points_j / max_j in [0, 1]
// Windows inside one session share that day's volatility, so they are not
// independent: standard errors are cluster-robust by session (CR1, Liang &
// Zeger 1986; A. C. Cameron & D. L. Miller, "A Practitioner's Guide to
// Cluster-Robust Inference", J. Human Resources 50(2), 2015,
// http://cameron.econ.ucdavis.edu/research/Cameron_Miller_JHR_2015_February.pdf),
// and the gate counts SESSIONS, not windows. Cameron-Miller warn that
// cluster-robust inference is unreliable with few clusters (rule of thumb
// below about 50); the gate asks for MIN_SESSIONS = 120 sessions (about six
// months) and MIN_WINDOWS = 1,000 graded windows, plus an out-of-sample check
// on the last 30% of sessions (R^2 vs the training mean, Campbell & Thompson
// 2008). Even at "fit-ready" the live index keeps its hand-set points until a
// person reviews the fit: nothing swaps automatically.

export const CONVEXITY_MIN_SESSIONS = 120;
export const CONVEXITY_MIN_WINDOWS = 1000;
export const CONVEXITY_DRIVERS = ["gamma", "vol", "range", "ofi", "canary", "whales", "wall"] as const;

export interface ConvexitySample {
  sessionDate: string;
  ts: number;                                // ms
  points: Record<string, number | null>;     // driver key -> points (null = unavailable)
  max: Record<string, number>;               // driver key -> max points
  fwdRatio: number | null;                   // range_next30m / (ATR20 x sqrt(30/390))
}

export interface ConvexityFit {
  status: "insufficient-data" | "fit-ready" | "fit-failed";
  sessions: number;
  windows: number;
  minSessions: number;
  minWindows: number;
  droppedIncomplete: number;                 // windows with an unavailable driver (never filled with 0)
  intercept: number | null;
  coefficients: Array<{ driver: string; b: number; seCluster: number; t: number; handSetMax: number }>;
  r2: number | null;
  oosR2: number | null;
  note: string;
}

/** Solve the k x k system / invert via Gauss-Jordan with partial pivoting. Null when singular. */
export function invert(a: number[][]): number[][] | null {
  const k = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  let scale = 0;
  for (let i = 0; i < k; i++) scale = Math.max(scale, Math.abs(a[i][i]));
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) <= 1e-12 * Math.max(1, scale)) return null;
    if (piv !== col) { const t = m[piv]; m[piv] = m[col]; m[col] = t; }
    const d = m[col][col];
    for (let j = 0; j < 2 * k; j++) m[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f !== 0) for (let j = 0; j < 2 * k; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(k));
}

/**
 * OLS with cluster-robust (CR1) standard errors:
 *   V = (X'X)^-1 [ sum_g (X_g' e_g)(X_g' e_g)' ] (X'X)^-1 x G/(G-1) x (N-1)/(N-K)
 */
export function olsClustered(X: number[][], y: number[], cluster: string[]): {
  ok: boolean; coef: number[]; se: number[]; r2: number; n: number; groups: number;
} {
  const n = X.length, k = n ? X[0].length : 0;
  const fail = { ok: false, coef: [], se: [], r2: NaN, n, groups: 0 };
  if (n <= k || k === 0) return fail;
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) {
    xty[a] += X[i][a] * y[i];
    for (let b = 0; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
  }
  const inv = invert(xtx);
  if (!inv) return fail;
  const coef = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const e = X.map((row, i) => y[i] - row.reduce((s, v, j) => s + v * coef[j], 0));
  const scores = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const s = scores.get(cluster[i]) ?? new Array(k).fill(0);
    for (let a = 0; a < k; a++) s[a] += X[i][a] * e[i];
    scores.set(cluster[i], s);
  }
  const G = scores.size;
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const s of Array.from(scores.values())) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += s[a] * s[b];
  const adj = G > 1 ? (G / (G - 1)) * ((n - 1) / (n - k)) : NaN;
  const se = new Array(k).fill(0).map((_, a) => {
    let v = 0;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) v += inv[a][i] * meat[i][j] * inv[j][a];
    return Math.sqrt(Math.max(0, v * adj));
  });
  const yBar = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - yBar) ** 2, 0);
  const ssr = e.reduce((s, v) => s + v * v, 0);
  return { ok: true, coef, se, r2: sst > 0 ? 1 - ssr / sst : NaN, n, groups: G };
}

export function fitConvexityWeights(
  samples: ConvexitySample[],
  opts: { minSessions?: number; minWindows?: number } = {},
): ConvexityFit {
  const minSessions = opts.minSessions ?? CONVEXITY_MIN_SESSIONS;
  const minWindows = opts.minWindows ?? CONVEXITY_MIN_WINDOWS;
  const graded = samples.filter((s) => s.fwdRatio != null && Number.isFinite(s.fwdRatio) && (s.fwdRatio as number) > 0);
  const complete = graded.filter((s) => CONVEXITY_DRIVERS.every((d) => s.points[d] != null && Number.isFinite(s.points[d] as number) && s.max[d] > 0));
  const droppedIncomplete = graded.length - complete.length;
  const sessions = new Set(complete.map((s) => s.sessionDate)).size;
  const base: ConvexityFit = {
    status: "insufficient-data", sessions, windows: complete.length, minSessions, minWindows, droppedIncomplete,
    intercept: null, coefficients: [], r2: null, oosR2: null,
    note: `hand-set points: need >= ${minSessions} sessions and >= ${minWindows} graded 30-minute windows with every driver available; have ${sessions} sessions, ${complete.length} windows`,
  };
  if (sessions < minSessions || complete.length < minWindows) return base;

  const rows = [...complete].sort((a, b) => a.ts - b.ts);
  const used = CONVEXITY_DRIVERS.filter((d) => {
    const v = rows.map((r) => (r.points[d] as number) / r.max[d]);
    return Math.max(...v) - Math.min(...v) > 1e-9;
  });
  const X = rows.map((r) => [1, ...used.map((d) => (r.points[d] as number) / r.max[d])]);
  const y = rows.map((r) => Math.log(r.fwdRatio as number));
  const cl = rows.map((r) => r.sessionDate);
  const f = olsClustered(X, y, cl);
  if (!f.ok) return { ...base, status: "fit-failed", note: "hand-set points: OLS failed (collinear drivers)" };

  // Out-of-sample: train on the first 70% of SESSIONS, score the rest vs the training mean.
  const dates = Array.from(new Set(cl)).sort();
  const cut = dates[Math.floor(dates.length * 0.7)];
  const trIdx = rows.map((r, i) => (r.sessionDate < cut ? i : -1)).filter((i) => i >= 0);
  const teIdx = rows.map((r, i) => (r.sessionDate >= cut ? i : -1)).filter((i) => i >= 0);
  let oosR2: number | null = null;
  const tr = olsClustered(trIdx.map((i) => X[i]), trIdx.map((i) => y[i]), trIdx.map((i) => cl[i]));
  if (tr.ok && teIdx.length > 0) {
    const yBar = trIdx.reduce((s, i) => s + y[i], 0) / trIdx.length;
    let sse = 0, sseBench = 0;
    for (const i of teIdx) {
      const yh = X[i].reduce((s, v, j) => s + v * tr.coef[j], 0);
      sse += (y[i] - yh) ** 2;
      sseBench += (y[i] - yBar) ** 2;
    }
    oosR2 = sseBench > 0 ? 1 - sse / sseBench : null;
  }
  return {
    status: "fit-ready", sessions, windows: rows.length, minSessions, minWindows, droppedIncomplete,
    intercept: f.coef[0],
    coefficients: used.map((d, j) => ({
      driver: d, b: f.coef[j + 1], seCluster: f.se[j + 1], t: f.se[j + 1] > 0 ? f.coef[j + 1] / f.se[j + 1] : NaN,
      handSetMax: rows[0].max[d],
    })),
    r2: f.r2,
    oosR2,
    note: "fit available for review (b = change in ln forward-range ratio for a driver at full points); the live index still uses hand-set points until a reviewed fit is promoted",
  };
}

/** Forward realized range over (ts, ts + windowMin] from 1-minute bars; null with fewer than minBars bars. */
export function forwardRange(
  bars: Array<{ datetime: number; high: number; low: number }>,
  ts: number,
  windowMin = 30,
  minBars = 25,
): number | null {
  const end = ts + windowMin * 60_000;
  const w = bars.filter((b) => b.datetime > ts && b.datetime <= end && Number.isFinite(b.high) && Number.isFinite(b.low));
  if (w.length < minBars) return null;
  return Math.max(...w.map((b) => b.high)) - Math.min(...w.map((b) => b.low));
}
