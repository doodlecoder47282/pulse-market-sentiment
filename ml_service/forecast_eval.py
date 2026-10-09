"""
Forecast evaluation and the promotion gate for the quantile overlay (R2-F item 3).

Pure numpy/scipy, no lightgbm, so tests run anywhere.

Baseline volatility cone (same math as server/mlServedBand.ts; parity is
tested in tests/quant/ml-r2.test.ts + tests/quant/ml_r2_checks.py):
  sigma per 5-minute bar = rv_session_5m (RMS of today's 5-minute log
  returns, >= 12 of them) else VIX / 100 / sqrt(252 * 78); s_h = sigma *
  sqrt(h / 5); quantile = expm1(z_q * s_h) with z_q the standard normal
  quantile, or the empirical quantile of standardized returns
  log(1 + r_h) / s_h fitted on training rows (filtered historical simulation:
  Barone-Adesi, Giannopoulos & Vosper, "VaR without correlations for
  portfolios of derivative securities", J. Futures Markets 19(5), 1999,
  https://ideas.repec.org/a/wly/jfutmk/v19y1999i5p583-602.html).

Scoring: pinball (quantile) loss, a proper scoring rule for quantiles
(Gneiting & Raftery, "Strictly proper scoring rules, prediction, and
estimation", JASA 102(477), 2007, https://apps.dtic.mil/sti/pdfs/ADA459827.pdf).

Significance: Diebold-Mariano test of equal predictive accuracy on the loss
differential d_t = L_model,t - L_base,t (Diebold & Mariano, "Comparing
predictive accuracy", JBES 13(3), 1995), long-run variance by Newey-West
(Bartlett kernel), lags = max(h - 1, ceil(T^(1/3))), with the Harvey,
Leybourne & Newbold small-sample correction sqrt((T + 1 - 2h + h(h-1)/T)/T)
and Student-t(T - 1) reference ("Testing the equality of prediction mean
squared errors", IJF 13(2), 1997). Same convention as statsmodels'
diebold_mariano_test:
https://www.statsmodels.org/dev/generated/statsmodels.tsa.stattools.diebold_mariano_test.html
Intraday forecasts every 5 minutes overlap and share one realized path, so d
is aggregated to ONE value per test day (mean over the day's rows) and the
test runs on that daily series (h = 1 day).

Promotion rule (stated policy, all horizons must pass):
  1. mean pinball loss (average over q10..q90) of the model <= (1 - MARGIN)
     x the baseline's, MARGIN = 0.02 (2%);
  2. DM one-sided p < DM_ALPHA = 0.05 that the model's loss is lower, on
     >= MIN_DM_DAYS = 20 daily differentials;
  3. 10-90% coverage error |cov - 0.80| of the model <= max(baseline's
     error, COVERAGE_TOL = 0.02).
The margin and tolerance are policy choices, not estimates; they are stored
in the model meta next to the measured values.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Sequence

import numpy as np

QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
Q_NAMES = ["q10", "q25", "q50", "q75", "q90"]
GAUSS_Z = np.array([-1.2815515655446004, -0.6744897501960817, 0.0, 0.6744897501960817, 1.2815515655446004])
BARS_PER_DAY_5M = 78
TRADING_DAYS = 252
NOMINAL = 0.80

MARGIN = 0.02
DM_ALPHA = 0.05
MIN_DM_DAYS = 20
COVERAGE_TOL = 0.02


# ─── Baseline cone ───────────────────────────────────────────────────────────

def baseline_sigma_per_bar(rv_session: np.ndarray, vix: np.ndarray) -> np.ndarray:
    """Sigma per 5-minute bar: realized session RMS when present, else VIX-implied, else NaN."""
    rv = np.asarray(rv_session, dtype=float)
    vx = np.asarray(vix, dtype=float)
    vix_sigma = np.where(np.isfinite(vx) & (vx > 0), vx / 100.0 / math.sqrt(TRADING_DAYS * BARS_PER_DAY_5M), np.nan)
    return np.where(np.isfinite(rv) & (rv > 0), rv, vix_sigma)


def baseline_quantiles(sigma: np.ndarray, h_min: float, z: Optional[Sequence[float]] = None) -> np.ndarray:
    """(n, 5) simple-return quantiles at horizon h minutes. NaN rows where sigma is NaN."""
    s_h = np.asarray(sigma, dtype=float)[:, None] * math.sqrt(h_min / 5.0)
    zz = np.asarray(z if z is not None else GAUSS_Z, dtype=float)[None, :]
    return np.sort(np.expm1(zz * s_h), axis=1)


def fit_fhs_z(y: np.ndarray, sigma: np.ndarray, h_min: float) -> Optional[List[float]]:
    """Empirical quantiles of standardized returns log(1 + r) / s_h (training rows only)."""
    s_h = np.asarray(sigma, dtype=float) * math.sqrt(h_min / 5.0)
    yy = np.asarray(y, dtype=float)
    ok = np.isfinite(yy) & np.isfinite(s_h) & (s_h > 0) & (yy > -1)
    if ok.sum() < 50:
        return None
    zs = np.log1p(yy[ok]) / s_h[ok]
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


def _t_sf(x: float, df: int) -> float:
    try:
        from scipy.stats import t as _t
        return float(_t.sf(x, df))
    except Exception:  # pragma: no cover - scipy missing: normal approximation
        return 0.5 * math.erfc(x / math.sqrt(2))


def diebold_mariano(d: Sequence[float], h: int = 1, lags: Optional[int] = None, harvey: bool = True) -> Dict[str, Any]:
    """
    DM test on a loss-differential series d (model minus baseline; negative =
    model better). Returns the statistic and the one-sided p-value for
    H1: E[d] < 0 (model more accurate), plus the two-sided p-value.
    """
    d = np.asarray([x for x in d if np.isfinite(x)], dtype=float)
    T = d.size
    if T < 3:
        return {"stat": None, "p_less": None, "p_two_sided": None, "n": int(T), "lags": None}
    L = int(lags) if lags is not None else max(h - 1, int(math.ceil(T ** (1.0 / 3.0))))
    L = min(L, T - 1)
    dbar = float(d.mean())
    e = d - dbar
    lrv = float(np.dot(e, e) / T)
    for k in range(1, L + 1):
        w = 1.0 - k / (L + 1.0)  # Bartlett (Newey-West 1987)
        lrv += 2.0 * w * float(np.dot(e[k:], e[:-k]) / T)
    if not (lrv > 0):
        return {"stat": None, "p_less": None, "p_two_sided": None, "n": int(T), "lags": L, "note": "zero long-run variance"}
    stat = dbar / math.sqrt(lrv / T)
    if harvey:
        stat *= math.sqrt((T + 1 - 2 * h + h * (h - 1) / T) / T)
        p_less = 1.0 - _t_sf(stat, T - 1)
        p_two = 2.0 * _t_sf(abs(stat), T - 1)
    else:
        p_less = 0.5 * math.erfc(-stat / math.sqrt(2))
        p_two = math.erfc(abs(stat) / math.sqrt(2))
    return {"stat": float(stat), "p_less": float(p_less), "p_two_sided": float(p_two), "n": int(T), "lags": L, "mean_d": dbar}


def daily_mean(values: np.ndarray, days: np.ndarray) -> np.ndarray:
    """Mean of `values` per day, in day order (aggregates overlapping intraday forecasts)."""
    out = []
    for d in sorted(set(days.tolist())):
        m = days == d
        v = values[m]
        v = v[np.isfinite(v)]
        if v.size:
            out.append(float(v.mean()))
    return np.asarray(out, dtype=float)


# ─── Promotion decision ──────────────────────────────────────────────────────

def horizon_verdict(y: np.ndarray, q_model: np.ndarray, q_base: np.ndarray, days: np.ndarray) -> Dict[str, Any]:
    """Compare model vs baseline on the SAME out-of-sample rows of one horizon."""
    ok = np.isfinite(y) & np.all(np.isfinite(q_model), axis=1) & np.all(np.isfinite(q_base), axis=1)
    y, qm, qb, dd = y[ok], q_model[ok], q_base[ok], days[ok]
    if y.size == 0:
        return {"pass": False, "reason": "no comparable out-of-sample rows", "n": 0}
    lm, lb = pinball_rows(y, qm), pinball_rows(y, qb)
    pm, pb = float(lm.mean()), float(lb.mean())
    dm = diebold_mariano(daily_mean(lm - lb, dd))
    cm, cb = coverage_10_90(y, qm), coverage_10_90(y, qb)
    rel = 1.0 - pm / pb if pb > 0 else None
    c1 = rel is not None and rel >= MARGIN
    c2 = dm["p_less"] is not None and dm["n"] >= MIN_DM_DAYS and dm["p_less"] < DM_ALPHA
    c3 = cm is not None and cb is not None and abs(cm - NOMINAL) <= max(abs(cb - NOMINAL), COVERAGE_TOL)
    reasons = []
    if not c1:
        reasons.append(f"pinball improvement {rel if rel is None else round(rel, 4)} < margin {MARGIN}")
    if not c2:
        reasons.append(f"DM p={dm['p_less']} on {dm['n']} days (need p < {DM_ALPHA}, >= {MIN_DM_DAYS} days)")
    if not c3:
        reasons.append(f"coverage {cm} vs baseline {cb} (nominal {NOMINAL}, tol {COVERAGE_TOL})")
    return {
        "pass": bool(c1 and c2 and c3),
        "n": int(y.size),
        "n_days": int(len(set(dd.tolist()))),
        "pinball_model": pm,
        "pinball_baseline": pb,
        "rel_improvement": rel,
        "dm": dm,
        "coverage_model": cm,
        "coverage_baseline": cb,
        "reasons": reasons,
    }


def promotion_decision(per_horizon: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    ok = bool(per_horizon) and all(v.get("pass") for v in per_horizon.values())
    return {
        "promoted": ok,
        "rule": (f"every horizon: mean pinball <= (1 - {MARGIN}) x baseline cone; Diebold-Mariano (HLN, Newey-West) "
                 f"one-sided p < {DM_ALPHA} on >= {MIN_DM_DAYS} daily loss differentials; |coverage - {NOMINAL}| <= "
                 f"max(baseline's, {COVERAGE_TOL}); walk-forward out-of-sample folds only"),
        "per_horizon": per_horizon,
    }
