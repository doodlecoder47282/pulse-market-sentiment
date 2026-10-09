"""
Forecast evaluation and the promotion gate for the quantile overlay (R2-F item 3).

Pure numpy/scipy, no lightgbm, so tests run anywhere.

Baseline volatility cone (same math as server/mlServedBand.ts; parity is
tested in tests/quant/ml-r2.test.ts + tests/quant/ml_r2_checks.py):
  Intraday periodicity (Andersen & Bollerslev, "Intraday periodicity and
  volatility persistence in financial markets", J. Empirical Finance 4(2-3),
  1997, 115-158, https://ideas.repec.org/a/eee/empfin/v4y1997i2-3p115-158.html):
  f_b, b = 0..77 the 5-minute buckets from 09:30 ET, = mean over sessions of
  r_{d,b}^2 / mean_b r_{d,b}^2 (each day's squared 5-minute SPX log returns
  normalized by that day's mean, so high-volatility days do not dominate),
  rescaled to mean 1. Flat (f = 1) below MIN_PERIODICITY_DAYS sessions.
  Sigma: per-bar variance sigma^2 = rv_session_5m^2 / E (E = mean f over the
  elapsed part of today's session: the realized RMS is deseasonalized), else
  (VIX / 100)^2 / (252 * 78) (VIX-implied, a whole-day average), else missing.
  Horizon [m0, m0 + h) minutes after 09:30: s_h^2 = sigma^2 * W, W = sum over
  buckets of f_b * (overlap minutes / 5), so with f = 1 inside the session
  W = h / 5 (square-root-of-time); time after the close adds nothing, and a
  horizon wholly outside the session has no cone (NaN, never zero width).
  Quantile q: expm1(z_q * s_h), z_q normal, or the empirical quantiles of
  standardized returns log(1 + r_h) / s_h fitted on training rows (filtered
  historical simulation: Barone-Adesi, Giannopoulos & Vosper, J. Futures
  Markets 19(5), 1999, https://ideas.repec.org/a/wly/jfutmk/v19y1999i5p583-602.html).

Scoring: pinball (quantile) loss, a proper scoring rule for quantiles
(Gneiting & Raftery, JASA 102(477), 2007, https://apps.dtic.mil/sti/pdfs/ADA459827.pdf).

Significance: Diebold-Mariano test (Diebold & Mariano, JBES 13(3), 1995) on
ONE loss differential per test day (intraday forecasts overlap and share a
path). With only ~40 test days, Newey-West HAC with normal or HLN-t critical
values over-rejects; the long-run variance is the Daniell weighted
periodogram with m = floor(T^(1/3)) Fourier frequencies and the statistic is
compared with Student-t(2m), the fixed-smoothing test of Coroneo & Iacone,
"Comparing predictive accuracy in small samples using fixed-smoothing
asymptotics", J. Applied Econometrics 35(4), 2020,
https://eprints.whiterose.ac.uk/155897/15/jae.2756.pdf (section 6:
"m = floor(T^(1/3)) for the WPE-D"). Size is checked by seeded Monte Carlo in
tests/quant/ml_r2_checks.py. The Newey-West/HLN variant stays available
(method="nw") for comparison.

Promotion rule (stated policy, every horizon must pass):
  1. mean pinball loss (average over q10..q90) of the model <= (1 - MARGIN)
     x the baseline's, MARGIN = 0.02;
  2. DM one-sided p < DM_ALPHA = 0.05 that the model's loss is lower, on
     >= MIN_DM_DAYS = 20 daily differentials;
  3. coverage: the model's day-clustered 95% interval for its 10-90%
     coverage contains 0.80 (rows within a day are dependent, so the
     standard error is the cluster-robust one over days), AND its coverage
     error |cov - 0.80| <= max(baseline's error, COVERAGE_TOL = 0.02,
     1.96 x its clustered s.e.). The s.e. term was added in the fix round:
     at 60 minutes with 40 test days the clustered s.e. is ~2.7pp, so a fixed
     2pp tolerance rejected correctly calibrated models (seeded check in
     tests/quant/ml_r2_checks.py: a model fitted to the true conditional
     scale covered 0.77 +- 0.027 and was refused). Under-confidence is
     still penalised by the pinball criterion, and calibration by the CI.
Demotion: an incumbent re-scored on the newest out-of-sample days (after its
training window) that fails the same rule against the baseline is demoted;
live coverage rejected at Kupiec p < 0.01 on >= 20 days demotes too (server).
The margin and tolerances are policy choices, stored in the model meta.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
Q_NAMES = ["q10", "q25", "q50", "q75", "q90"]
GAUSS_Z = np.array([-1.2815515655446004, -0.6744897501960817, 0.0, 0.6744897501960817, 1.2815515655446004])
BARS_PER_DAY_5M = 78
TRADING_DAYS = 252
NOMINAL = 0.80
OPEN_MIN = 570  # 09:30 ET
MIN_PERIODICITY_DAYS = 20

MARGIN = 0.02
DM_ALPHA = 0.05
MIN_DM_DAYS = 20
COVERAGE_TOL = 0.02
LIVE_DEMOTE_KUPIEC_P = 0.01
LIVE_DEMOTE_MIN_DAYS = 20


# ─── Intraday periodicity (Andersen & Bollerslev 1997) ──────────────────────

def _et_day_minute(t_ms: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """(ET date "YYYY-MM-DD", ET minute of day) per epoch-ms timestamp (DST-aware; strftime only per distinct day)."""
    import pandas as pd
    ts = pd.to_datetime(np.asarray(t_ms, dtype=np.int64), unit="ms", utc=True).tz_convert("America/New_York")
    local_ns = ts.tz_localize(None).as_unit("ns").asi8
    day_num = local_ns // 86_400_000_000_000
    uniq, inv = np.unique(day_num, return_inverse=True)
    names = np.asarray(pd.to_datetime(uniq * 86_400_000_000_000).strftime("%Y-%m-%d"))
    return names[inv], np.asarray((local_ns // 60_000_000_000) % 1440)


def periodicity_profile(bar_t_ms, bar_open, bar_close, min_days: int = MIN_PERIODICITY_DAYS) -> Optional[Dict[str, Any]]:
    """
    f_b (78 floats, mean 1) from 1-minute bars (bar open time ms). Bucket b ends
    with the close of the bar opening at 09:30 + 5b + 4; it starts at the
    previous bucket's end (b = 0: the open of the 09:30 bar). A session counts
    when it has the 15:55 bucket and >= 60 of 78 buckets. None below min_days.
    """
    t = np.asarray(bar_t_ms, dtype=np.int64)
    if t.size == 0:
        return None
    o = np.asarray(bar_open, dtype=float)
    c = np.asarray(bar_close, dtype=float)
    days, mins = _et_day_minute(t)
    acc = np.zeros(BARS_PER_DAY_5M)
    cnt = np.zeros(BARS_PER_DAY_5M)
    n_days = 0
    for d in sorted(set(days.tolist())):
        m = days == d
        by_min = {int(mm): (oo, cc) for mm, oo, cc in zip(mins[m], o[m], c[m])}
        ends = []
        for b in range(BARS_PER_DAY_5M):
            e = by_min.get(OPEN_MIN + 5 * b + 4)
            ends.append(e[1] if e else np.nan)
        start0 = by_min.get(OPEN_MIN)
        r2 = np.full(BARS_PER_DAY_5M, np.nan)
        prev = start0[0] if start0 else np.nan
        for b in range(BARS_PER_DAY_5M):
            if np.isfinite(prev) and np.isfinite(ends[b]) and prev > 0 and ends[b] > 0:
                r2[b] = math.log(ends[b] / prev) ** 2
            prev = ends[b]
        ok = np.isfinite(r2)
        if not np.isfinite(r2[-1]) or ok.sum() < 60:
            continue
        day_mean = r2[ok].mean()
        if not day_mean > 0:
            continue
        acc[ok] += r2[ok] / day_mean
        cnt[ok] += 1
        n_days += 1
    if n_days < min_days or np.any(cnt == 0):
        return None
    f = acc / cnt
    f = f / f.mean()
    return {"f": [float(x) for x in f], "n_days": int(n_days)}


def _overlap_weight(m0: float, m1: float, f: Optional[Sequence[float]]) -> float:
    """sum_b f_b * overlap([5b, 5b+5), [m0, m1)) / 5 over the session's 78 buckets."""
    lo, hi = max(0.0, m0), min(5.0 * BARS_PER_DAY_5M, m1)
    if not hi > lo:
        return 0.0
    w = 0.0
    for b in range(int(lo // 5), min(BARS_PER_DAY_5M, int(math.ceil(hi / 5)))):
        ov = min(hi, 5 * b + 5) - max(lo, 5 * b)
        if ov > 0:
            w += (f[b] if f is not None else 1.0) * ov / 5.0
    return w


def baseline_scale(rv_session, vix, hour_of_day, h_min: float, profile: Optional[Sequence[float]] = None) -> Tuple[np.ndarray, np.ndarray]:
    """(s_h, source) per row; source 'rv_session' | 'vix_implied' | '' (missing -> s_h NaN)."""
    rv = np.atleast_1d(np.asarray(rv_session, dtype=float))
    vx = np.atleast_1d(np.asarray(vix, dtype=float))
    hr = np.atleast_1d(np.asarray(hour_of_day, dtype=float))
    n = max(rv.size, vx.size, hr.size)
    rv, vx, hr = (np.broadcast_to(a, (n,)) for a in (rv, vx, hr))
    s = np.full(n, np.nan)
    src = np.array([""] * n, dtype=object)
    memo: Dict[float, Tuple[float, float]] = {}  # rows share a few dozen times of day
    for i in range(n):
        if not np.isfinite(hr[i]):
            continue
        m0 = hr[i] * 60.0 - OPEN_MIN
        if m0 not in memo:
            memo[m0] = (_overlap_weight(m0, m0 + h_min, profile),
                        _overlap_weight(0.0, m0, profile) / (m0 / 5.0) if m0 >= 5 else 1.0)
        W, E = memo[m0]
        if not W > 0:  # horizon entirely outside the session: no cone (never a zero-width band)
            continue
        if np.isfinite(rv[i]) and rv[i] > 0:
            if not E > 0:
                continue
            var = rv[i] ** 2 / E
            src[i] = "rv_session"
        elif np.isfinite(vx[i]) and vx[i] > 0:
            var = (vx[i] / 100.0) ** 2 / (TRADING_DAYS * BARS_PER_DAY_5M)
            src[i] = "vix_implied"
        else:
            continue
        s[i] = math.sqrt(var * W)
    return s, src


def baseline_quantiles_from_scale(s_h: np.ndarray, z: Optional[Sequence[float]] = None) -> np.ndarray:
    """(n, 5) simple-return quantiles expm1(z_q * s_h); NaN rows where s_h is NaN."""
    zz = np.asarray(z if z is not None else GAUSS_Z, dtype=float)[None, :]
    return np.sort(np.expm1(zz * np.asarray(s_h, dtype=float)[:, None]), axis=1)


def baseline_sigma_per_bar(rv_session, vix) -> np.ndarray:
    """Flat-profile per-bar sigma (no periodicity, no time of day): rv else VIX-implied else NaN."""
    rv = np.asarray(rv_session, dtype=float)
    vx = np.asarray(vix, dtype=float)
    vix_sigma = np.where(np.isfinite(vx) & (vx > 0), vx / 100.0 / math.sqrt(TRADING_DAYS * BARS_PER_DAY_5M), np.nan)
    return np.where(np.isfinite(rv) & (rv > 0), rv, vix_sigma)


def baseline_quantiles(sigma: np.ndarray, h_min: float, z: Optional[Sequence[float]] = None) -> np.ndarray:
    """Flat-profile cone inside the session: s_h = sigma * sqrt(h / 5)."""
    return baseline_quantiles_from_scale(np.asarray(sigma, dtype=float) * math.sqrt(h_min / 5.0), z)


def fit_fhs_z(y: np.ndarray, s_h: np.ndarray) -> Optional[List[float]]:
    """Empirical quantiles of standardized returns log(1 + r) / s_h (training rows only)."""
    yy = np.asarray(y, dtype=float)
    ss = np.asarray(s_h, dtype=float)
    ok = np.isfinite(yy) & np.isfinite(ss) & (ss > 0) & (yy > -1)
    if ok.sum() < 50:
        return None
    zs = np.log1p(yy[ok]) / ss[ok]
    return [float(v) for v in np.quantile(zs, QUANTILES)]


# ─── Scores ──────────────────────────────────────────────────────────────────

def pinball(y: np.ndarray, q_pred: np.ndarray, alpha: float) -> float:
    diff = np.asarray(y, dtype=float) - np.asarray(q_pred, dtype=float)
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1) * diff)))


def pinball_rows(y: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Per-row pinball loss averaged over the 5 quantiles; q has shape (n, 5)."""
    diff = np.asarray(y, dtype=float)[:, None] - np.asarray(q, dtype=float)
    a = np.asarray(QUANTILES)[None, :]
    return np.mean(np.maximum(a * diff, (a - 1) * diff), axis=1)


def coverage_10_90(y: np.ndarray, q: np.ndarray) -> Optional[float]:
    y = np.asarray(y, dtype=float)
    if y.size == 0:
        return None
    lo = np.minimum(q[:, 0], q[:, 4])
    hi = np.maximum(q[:, 0], q[:, 4])
    return float(np.mean((y >= lo) & (y <= hi)))


def clustered_coverage_ci(y: np.ndarray, q: np.ndarray, days: np.ndarray, z: float = 1.959963984540054) -> Optional[Dict[str, float]]:
    """
    Coverage with a day-clustered (cluster-robust) standard error:
    var(p_hat) = sum_d (sum_{i in d} (x_i - p_hat))^2 / N^2 (Liang-Zeger
    sandwich for a mean), with the G / (G - 1) small-cluster factor.
    """
    y = np.asarray(y, dtype=float)
    if y.size == 0:
        return None
    x = ((y >= np.minimum(q[:, 0], q[:, 4])) & (y <= np.maximum(q[:, 0], q[:, 4]))).astype(float)
    p = float(x.mean())
    N = x.size
    groups = sorted(set(np.asarray(days).tolist()))
    G = len(groups)
    if G < 2:
        return {"rate": p, "se": float("nan"), "lo": float("nan"), "hi": float("nan"), "clusters": G}
    s = 0.0
    for g in groups:
        s += float(np.sum(x[days == g] - p)) ** 2
    se = math.sqrt(s * G / (G - 1)) / N
    return {"rate": p, "se": se, "lo": p - z * se, "hi": p + z * se, "clusters": G}


def _t_cdf(x: float, df: float) -> float:
    try:
        from scipy.stats import t as _t
        return float(_t.cdf(x, df))
    except Exception:  # pragma: no cover - scipy missing: normal approximation
        return 0.5 * math.erfc(-x / math.sqrt(2))


def diebold_mariano(d: Sequence[float], h: int = 1, method: str = "wpe", lags: Optional[int] = None, harvey: bool = True) -> Dict[str, Any]:
    """
    DM test on a loss-differential series d (model minus baseline; negative =
    model better). p_less = P(statistic <= observed) under H0, i.e. the
    one-sided p-value for H1: E[d] < 0.
    method "wpe": Daniell weighted periodogram, m = floor(T^(1/3)), t(2m)
      (Coroneo & Iacone 2020). sigma^2 = (1/m) sum_{j=1..m} |sum_t d_t e^{-i 2 pi j t / T}|^2 / T.
    method "nw": Newey-West Bartlett, lags = max(h-1, ceil(T^(1/3))), HLN factor, t(T-1).
    """
    d = np.asarray([x for x in d if np.isfinite(x)], dtype=float)
    T = d.size
    if T < 3:
        return {"stat": None, "p_less": None, "p_two_sided": None, "n": int(T), "method": method}
    dbar = float(d.mean())
    if method == "wpe":
        m = int(math.floor(T ** (1.0 / 3.0)))
        m = max(1, min(m, (T - 1) // 2))
        tt = np.arange(1, T + 1)
        I = [abs(np.sum(d * np.exp(-2j * math.pi * j * tt / T))) ** 2 / T for j in range(1, m + 1)]
        lrv = float(np.mean(I))
        if not lrv > 0:
            return {"stat": None, "p_less": None, "p_two_sided": None, "n": int(T), "method": method, "m": m}
        stat = math.sqrt(T) * dbar / math.sqrt(lrv)
        df = 2 * m
        return {"stat": float(stat), "p_less": _t_cdf(stat, df), "p_two_sided": 2 * (1 - _t_cdf(abs(stat), df)),
                "n": int(T), "method": "wpe", "m": m, "df": df, "mean_d": dbar}
    L = int(lags) if lags is not None else max(h - 1, int(math.ceil(T ** (1.0 / 3.0))))
    L = min(L, T - 1)
    e = d - dbar
    lrv = float(np.dot(e, e) / T)
    for k in range(1, L + 1):
        lrv += 2.0 * (1.0 - k / (L + 1.0)) * float(np.dot(e[k:], e[:-k]) / T)
    if not lrv > 0:
        return {"stat": None, "p_less": None, "p_two_sided": None, "n": int(T), "lags": L, "method": "nw"}
    stat = dbar / math.sqrt(lrv / T)
    if harvey:
        stat *= math.sqrt((T + 1 - 2 * h + h * (h - 1) / T) / T)
        p_less, p_two = _t_cdf(stat, T - 1), 2 * (1 - _t_cdf(abs(stat), T - 1))
    else:
        p_less, p_two = 0.5 * math.erfc(-stat / math.sqrt(2)), math.erfc(abs(stat) / math.sqrt(2))
    return {"stat": float(stat), "p_less": float(p_less), "p_two_sided": float(p_two), "n": int(T), "lags": L, "method": "nw", "mean_d": dbar}


def daily_mean(values: np.ndarray, days: np.ndarray) -> np.ndarray:
    """Mean of `values` per day, in day order (aggregates overlapping intraday forecasts)."""
    out = []
    for dd in sorted(set(days.tolist())):
        v = values[days == dd]
        v = v[np.isfinite(v)]
        if v.size:
            out.append(float(v.mean()))
    return np.asarray(out, dtype=float)


# ─── Promotion / demotion decisions ─────────────────────────────────────────

def horizon_verdict(y: np.ndarray, q_model: np.ndarray, q_base: np.ndarray, days: np.ndarray) -> Dict[str, Any]:
    """Compare model vs baseline on the SAME out-of-sample rows of one horizon."""
    ok = np.isfinite(y) & np.all(np.isfinite(q_model), axis=1) & np.all(np.isfinite(q_base), axis=1)
    y, qm, qb, dd = y[ok], q_model[ok], q_base[ok], days[ok]
    if y.size == 0:
        return {"pass": False, "reasons": ["no comparable out-of-sample rows"], "n": 0}
    lm, lb = pinball_rows(y, qm), pinball_rows(y, qb)
    pm, pb = float(lm.mean()), float(lb.mean())
    dm = diebold_mariano(daily_mean(lm - lb, dd))
    cm, cb = coverage_10_90(y, qm), coverage_10_90(y, qb)
    ci = clustered_coverage_ci(y, qm, dd)
    rel = 1.0 - pm / pb if pb > 0 else None
    c1 = rel is not None and rel >= MARGIN
    c2 = dm["p_less"] is not None and dm["n"] >= MIN_DM_DAYS and dm["p_less"] < DM_ALPHA
    noise = 1.959963984540054 * ci["se"] if ci is not None and np.isfinite(ci["se"]) else 0.0
    c3a = cm is not None and cb is not None and abs(cm - NOMINAL) <= max(abs(cb - NOMINAL), COVERAGE_TOL, noise)
    c3b = ci is not None and np.isfinite(ci["lo"]) and ci["lo"] <= NOMINAL <= ci["hi"]
    reasons = []
    if not c1:
        reasons.append(f"pinball improvement {rel if rel is None else round(rel, 4)} < margin {MARGIN}")
    if not c2:
        reasons.append(f"DM p={dm['p_less']} on {dm['n']} days (need p < {DM_ALPHA}, >= {MIN_DM_DAYS} days)")
    if not c3a:
        reasons.append(f"coverage {cm} vs baseline {cb} (nominal {NOMINAL}, tol max({COVERAGE_TOL}, 1.96 s.e. = {round(noise, 4)}))")
    if not c3b:
        reasons.append(f"day-clustered 95% coverage interval {ci and (round(ci['lo'], 4), round(ci['hi'], 4))} excludes {NOMINAL}")
    return {
        "pass": bool(c1 and c2 and c3a and c3b),
        "n": int(y.size),
        "n_days": int(len(set(dd.tolist()))),
        "pinball_model": pm,
        "pinball_baseline": pb,
        "rel_improvement": rel,
        "dm": dm,
        "coverage_model": cm,
        "coverage_baseline": cb,
        "coverage_ci_clustered": ci,
        "reasons": reasons,
    }


def promotion_decision(per_horizon: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    ok = bool(per_horizon) and all(v.get("pass") for v in per_horizon.values())
    return {
        "promoted": ok,
        "rule": (f"every horizon: mean pinball <= (1 - {MARGIN}) x baseline cone (intraday periodicity, FHS); "
                 f"Diebold-Mariano fixed-smoothing (Daniell WPE, m = floor(T^(1/3)), t(2m)) one-sided p < {DM_ALPHA} "
                 f"on >= {MIN_DM_DAYS} daily loss differentials; day-clustered 95% coverage interval contains {NOMINAL} "
                 f"and |coverage - {NOMINAL}| <= max(baseline's, {COVERAGE_TOL}, 1.96 x clustered s.e.); walk-forward out-of-sample folds only"),
        "per_horizon": per_horizon,
    }


def live_coverage_demotion(per_horizon: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    Live rule (same as the server's mlServedBand.liveCoverageDemotion): demote
    when any horizon has >= LIVE_DEMOTE_MIN_DAYS scored days and Kupiec p <
    LIVE_DEMOTE_KUPIEC_P. per_horizon: {h: {"kupiec_p": float, "n_days": int}}.
    """
    bad = [h for h, v in per_horizon.items()
           if v.get("n_days", 0) >= LIVE_DEMOTE_MIN_DAYS and v.get("kupiec_p") is not None and v["kupiec_p"] < LIVE_DEMOTE_KUPIEC_P]
    return {"demote": bool(bad), "horizons": bad}
