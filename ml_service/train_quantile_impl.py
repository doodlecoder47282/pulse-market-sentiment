"""
Quantile overlay training (Model B), real data only.

History: versions v1-v4 were trained on simulated 1-minute bars (a zero-drift
Gaussian walk rebuilt from daily bars) and, from v3, on random "dealer level"
offsets. That trainer is removed (review items 9.1/9.2). The served v4 file is
left in place and its meta is marked training_data = "synthetic_gbm" so every
screen can say so.

Data (written by server/mlDataLog.ts into data.db):
  - ml_feature_log: the exact feature dict the live model is fed, every 5 min
    in RTH, with the list of features that were placeholders for missing
    inputs (those cells become NaN here, never 0);
  - spx_minute_bars: Schwab $SPX 1-minute candles (bar open time, ms).
Label: simple SPX return over [t, t + h] from bar closes, h in HORIZONS
minutes, same ET session only, refusing stale prices (> 3 min) or gaps.

Leakage control (Lopez de Prado, "Advances in Financial Machine Learning",
2018, ch. 7: purging and embargo). Labels overlap in time inside a session,
so folds are whole ET days, walk-forward (train strictly before test) with an
embargo of EMBARGO_DAYS between the last training day and the first test day.
Labels never cross a session, so day boundaries purge every overlap.

Data-sufficiency gate: MIN_REAL_DAYS sessions with at least MIN_ROWS_PER_DAY
labelled rows each. Below it nothing is trained and no model file is written.
60 sessions is about one quarter: enough for 5 walk-forward folds of roughly a
week or more each and several volatility regimes. Intraday rows are strongly
autocorrelated, so the number of DAYS, not rows, is the effective sample.
This is a heuristic floor, not a power calculation.

Out-of-sample check (Gneiting & Raftery 2007): per horizon, the fraction of
test-fold outcomes inside [q10, q90] (nominal 0.80) and the pinball loss per
quantile are stored in the meta.
"""
from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger("ml.quantile_overlay")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"
MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

HORIZONS = [5, 15, 30, 60]
QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
MIN_REAL_DAYS = 60
MIN_ROWS_PER_DAY = 40
N_SPLITS = 5
EMBARGO_DAYS = 1
MAX_STALE_MS = 180_000
MISSING_THRESH = 0.40  # drop a feature if more than 40% of its cells are missing

# The live feature dict (server/mlGreekFeatures.ts). Same names at train and serve.
FEATURE_NAMES = [
    "hour_of_day", "minute_of_hour", "day_of_week", "is_first_30min", "is_post_lunch", "is_last_30min",
    "spx_spot", "vix_level", "vix_change_pct",
    "realized_vol_30m", "realized_vol_5m", "atr_5m", "trend_30m", "trend_5m",
    "dist_to_callwall_atr", "dist_to_putwall_atr", "dist_to_flip_atr", "dist_to_maxpain_atr",
    "dist_to_zomma_atr", "dist_to_upvomma_atr", "dist_to_dnvomma_atr",
    "vanna_level_dist_atr", "charm_level_dist_atr",
    "net_gex_sign", "net_gex_magnitude",
]

LGBM_PARAMS = dict(
    n_estimators=300, learning_rate=0.05, max_depth=5, min_child_samples=50,
    num_leaves=24, reg_lambda=1.0, n_jobs=-1, verbose=-1,
)


# ─── Data ────────────────────────────────────────────────────────────────────

def _et_day(ms: np.ndarray) -> np.ndarray:
    ts = pd.to_datetime(ms, unit="ms", utc=True).tz_convert("America/New_York")
    return np.asarray(ts.strftime("%Y-%m-%d"))


def price_at(bar_open_ms: np.ndarray, bar_close: np.ndarray, t_ms: np.ndarray, max_stale_ms: int = MAX_STALE_MS) -> np.ndarray:
    """Close of the latest 1-minute bar that finished by t (bar end = open + 60 s), NaN if older than max_stale_ms."""
    ends = bar_open_ms + 60_000
    idx = np.searchsorted(ends, t_ms, side="right") - 1
    out = np.full(t_ms.shape, np.nan)
    ok = idx >= 0
    safe = np.where(ok, idx, 0)
    fresh = ok & ((t_ms - ends[safe]) <= max_stale_ms)
    out[fresh] = bar_close[safe[fresh]]
    return out


def build_frame(conn: sqlite3.Connection) -> pd.DataFrame:
    """Feature rows from ml_feature_log with real forward-return labels from spx_minute_bars."""
    try:
        feats = pd.read_sql_query("SELECT ts, features_json, missing_json FROM ml_feature_log ORDER BY ts", conn)
        bars = pd.read_sql_query("SELECT t, close FROM spx_minute_bars ORDER BY t", conn)
    except Exception as e:  # tables not created yet
        logger.warning("real-data tables unavailable: %s", e)
        return pd.DataFrame()
    if feats.empty or bars.empty:
        return pd.DataFrame()

    rows = []
    for ts, fj, mj in feats.itertuples(index=False):
        try:
            f = json.loads(fj or "{}")
            missing = set(json.loads(mj or "[]"))
        except Exception:
            continue
        row = {"ts": int(ts)}
        for name in FEATURE_NAMES:
            v = f.get(name)
            row[name] = np.nan if (name in missing or v is None) else float(v)
        rows.append(row)
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    t = df["ts"].to_numpy(dtype=np.int64)
    bo = bars["t"].to_numpy(dtype=np.int64)
    bc = bars["close"].to_numpy(dtype=float)
    p0 = price_at(bo, bc, t)
    day0 = _et_day(t)
    for h in HORIZONS:
        th = t + h * 60_000
        p1 = price_at(bo, bc, th)
        same_day = _et_day(th) == day0
        r = p1 / p0 - 1.0
        df[f"ret_{h}"] = np.where(same_day & np.isfinite(p0) & np.isfinite(p1) & (p0 > 0), r, np.nan)
    df["day"] = day0
    return df


# ─── Gate and folds ──────────────────────────────────────────────────────────

def data_sufficiency(df: pd.DataFrame) -> Dict[str, Any]:
    """Real-data gate. Counts sessions with >= MIN_ROWS_PER_DAY rows labelled at every horizon."""
    if df is None or df.empty:
        return {"sufficient": False, "qualifying_days": 0, "rows": 0, "required_days": MIN_REAL_DAYS,
                "required_rows_per_day": MIN_ROWS_PER_DAY, "first_day": None, "last_day": None}
    lab = df.dropna(subset=[f"ret_{h}" for h in HORIZONS])
    per_day = lab.groupby("day").size()
    good = per_day[per_day >= MIN_ROWS_PER_DAY]
    return {
        "sufficient": bool(len(good) >= MIN_REAL_DAYS),
        "qualifying_days": int(len(good)),
        "rows": int(len(lab)),
        "required_days": MIN_REAL_DAYS,
        "required_rows_per_day": MIN_ROWS_PER_DAY,
        "first_day": str(good.index.min()) if len(good) else None,
        "last_day": str(good.index.max()) if len(good) else None,
    }


def walk_forward_day_folds(days: List[str], n_splits: int = N_SPLITS, embargo_days: int = EMBARGO_DAYS,
                           min_train_days: int = 20) -> List[Tuple[List[str], List[str]]]:
    """
    Expanding-window folds on whole days: test blocks are the last
    n_splits consecutive slices of the day list; training is every day before
    the block minus `embargo_days` days next to it. No training day is ever on
    or after a test day.
    """
    d = sorted(set(days))
    n = len(d)
    if n < min_train_days + embargo_days + n_splits:
        return []
    test_total = n - min_train_days - embargo_days
    size = max(1, test_total // n_splits)
    folds = []
    for k in range(n_splits):
        start = min_train_days + embargo_days + k * size
        end = n if k == n_splits - 1 else start + size
        if start >= n:
            break
        train = d[: start - embargo_days]
        test = d[start:end]
        if train and test:
            folds.append((train, test))
    return folds


def pinball(y: np.ndarray, q_pred: np.ndarray, alpha: float) -> float:
    diff = y - q_pred
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1) * diff)))


# ─── Training ────────────────────────────────────────────────────────────────

def _next_version() -> int:
    versions = []
    for p in MODELS_DIR.glob("quantile_overlay_v*_meta.json"):
        try:
            versions.append(int(p.stem.split("_v")[1].split("_meta")[0]))
        except (IndexError, ValueError):
            pass
    return max(versions) + 1 if versions else 1


def train_quantile_overlay(db_path: Optional[Path] = None) -> Dict[str, Any]:
    """Train on real logged data only. Writes nothing below the sufficiency gate."""
    t0 = time.time()
    path = Path(db_path) if db_path else DB_PATH
    try:
        with sqlite3.connect(str(path)) as conn:
            df = build_frame(conn)
    except Exception as e:
        return {"status": "INSUFFICIENT_REAL_DATA", "error": str(e)}

    gate = data_sufficiency(df)
    if not gate["sufficient"]:
        logger.info("real-data gate not met: %s", gate)
        return {"status": "INSUFFICIENT_REAL_DATA", "gate": gate,
                "note": "no synthetic fallback: the model is trained only on logged live features and real SPX minute bars"}

    from lightgbm import LGBMRegressor  # imported here so the gate and tests run without lightgbm
    import joblib

    lab = df.dropna(subset=[f"ret_{h}" for h in HORIZONS]).sort_values("ts").reset_index(drop=True)
    active, dropped = [], []
    for f in FEATURE_NAMES:
        (dropped if lab[f].isna().mean() > MISSING_THRESH else active).append(f)
    X = lab[active].to_numpy(dtype=np.float32)  # NaN kept: LightGBM routes missing values natively
    days = lab["day"].to_numpy()
    folds = walk_forward_day_folds(list(days))

    models: Dict[Tuple[int, float], Any] = {}
    cv: Dict[str, Any] = {}
    for h in HORIZONS:
        y = lab[f"ret_{h}"].to_numpy(dtype=np.float64)
        losses = {q: [] for q in QUANTILES}
        inside, total = 0, 0
        for train_days, test_days in folds:
            tr = np.isin(days, train_days)
            te = np.isin(days, test_days)
            preds = {}
            for q in QUANTILES:
                m = LGBMRegressor(objective="quantile", alpha=q, **LGBM_PARAMS)
                m.fit(X[tr], y[tr])
                preds[q] = m.predict(X[te])
                losses[q].append(pinball(y[te], preds[q], q))
            lo = np.minimum(preds[0.10], preds[0.90])
            hi = np.maximum(preds[0.10], preds[0.90])
            inside += int(np.sum((y[te] >= lo) & (y[te] <= hi)))
            total += int(te.sum())
        cv[str(h)] = {
            "pinball": {str(q): (float(np.mean(v)) if v else None) for q, v in losses.items()},
            "coverage_10_90": (inside / total) if total else None,
            "n_test": total,
        }
        for q in QUANTILES:
            m = LGBMRegressor(objective="quantile", alpha=q, **LGBM_PARAMS)
            m.fit(X, y)
            models[(h, q)] = m

    version = _next_version()
    model_path = MODELS_DIR / f"quantile_overlay_v{version}.lgb"
    tmp = model_path.with_suffix(".lgb.tmp")
    joblib.dump(models, tmp)
    os.rename(str(tmp), str(model_path))
    meta = {
        "status": "TRAINED",
        "version": version,
        "trained_at": int(time.time()),
        "training_data": "real",
        "n_train": int(len(lab)),
        "n_days": gate["qualifying_days"],
        "first_day": gate["first_day"],
        "last_day": gate["last_day"],
        "feature_names": active,
        "dropped_features": dropped,
        "training_medians": {f: (float(lab[f].median()) if lab[f].notna().any() else 0.0) for f in active},
        "cv": cv,
        "cv_scheme": f"walk-forward on whole ET days, {len(folds)} folds, embargo {EMBARGO_DAYS} day(s)",
        "horizons": HORIZONS,
        "quantiles": QUANTILES,
        "label": "SPX simple return over [t, t+h] from Schwab 1-minute bar closes, same session",
        "model_path": str(model_path),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    meta_path = MODELS_DIR / f"quantile_overlay_v{version}_meta.json"
    tmp_meta = meta_path.with_suffix(".json.tmp")
    tmp_meta.write_text(json.dumps(meta, default=str), encoding="utf-8")
    os.rename(str(tmp_meta), str(meta_path))
    return {"status": "TRAINED", "version": version, "n_train": meta["n_train"], "n_days": meta["n_days"], "cv": cv}


def train_quantile_v3() -> Dict[str, Any]:
    """Removed: v3 trained on random dealer-level offsets. Kept as a stub so old callers get a clear status."""
    return {"status": "DISABLED_SYNTHETIC", "note": "synthetic Greek-level training removed; use train_quantile_overlay (real data only)"}
