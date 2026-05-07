"""
Quantile overlay training implementation — Wire 18 Model B.
Called from trainer.py:train_quantile_overlay().

Data reality: spy_1min_history has 500 DAILY bars (SPX daily close from CBOE).
Strategy: synthesize intraday 1-min bars from daily data using a GBM-based
simulation seeded from realized vol, then train on those synthetic bars.

Each trading day provides ~390 1-min bars (6.5 RTH hours).
500 days × 390 bars × ~85% RTH coverage ≈ 165,750 valid (t, t+60) pairs.
"""
from __future__ import annotations

import logging
import math
import os
import random
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from sklearn.metrics import mean_pinball_loss
from sklearn.model_selection import TimeSeriesSplit

logger = logging.getLogger("ml.quantile_overlay")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"
MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

HORIZONS = [5, 15, 30, 60]
QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
MIN_BARS = 500  # minimum valid (t, t+60) pairs

LGBM_PARAMS = dict(
    n_estimators=300,
    learning_rate=0.05,
    max_depth=6,
    min_child_samples=20,
    num_leaves=31,
    reg_lambda=0.5,
    n_jobs=-1,
    verbose=-1,
)

FEATURE_NAMES_ALL = [
    "hour_of_day",
    "minute_of_hour",
    "day_of_week",
    "vix_level",
    "gex_regime_ord",
    "net_gex_b",
    "realized_vol_5min",
    "realized_vol_30min",
    "bar_return_1min",
    "momentum_15min",
    "distance_from_open_pct",
    "is_post_lunch",
    "is_first_30min",
    "is_last_30min",
    "vix_pct_of_5d_avg",
]

MISSING_THRESH = 0.40  # drop feature if >40% missing


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    return sqlite3.connect(str(DB_PATH))


def _load_daily_bars() -> pd.DataFrame:
    """Load spy_1min_history (actually daily bars)."""
    with _conn() as conn:
        df = pd.read_sql_query(
            "SELECT ts, open, high, low, close, volume FROM spy_1min_history ORDER BY ts",
            conn,
        )
    df["date"] = pd.to_datetime(df["ts"], unit="s", utc=True).dt.date.astype(str)
    return df


def _load_snapshot_history() -> pd.DataFrame:
    """Load snapshot_history with VIX, gamma_regime, net_gex."""
    with _conn() as conn:
        df = pd.read_sql_query(
            "SELECT date, vix, gamma_regime, net_gex FROM snapshot_history ORDER BY date",
            conn,
        )
    return df


# ─────────────────────────────────────────────────────────────────────────────
# Feature helpers
# ─────────────────────────────────────────────────────────────────────────────

def _gex_regime_ord(gamma_regime: Optional[str], net_gex: float) -> int:
    """Map gamma_regime + abs(net_gex) magnitude to ordinal."""
    regime = (gamma_regime or "neutral").lower().strip()
    abs_gex = abs(net_gex)
    if regime in ("positive",):
        return 3 if abs_gex > 0.5e9 else 2
    elif regime in ("negative",):
        return -1 if abs_gex > 0.5e9 else 0
    else:  # neutral
        return 1


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic intraday bar generation
# ─────────────────────────────────────────────────────────────────────────────

def _synthesize_intraday(
    daily_bars: pd.DataFrame,
    snapshot_map: Dict[str, Dict],
) -> pd.DataFrame:
    """
    For each daily bar, simulate 390 intraday 1-min returns using a GBM model
    calibrated to the day's realized vol (approximated from daily OHLC range).

    Returns a DataFrame of intraday bars with all feature columns attached.
    Each row = one synthetic 1-min bar at time t.
    """
    RTH_MINUTES = 390  # 9:30 to 16:00
    OPEN_HOUR_FRAC = 9.5  # 9:30

    rng = np.random.default_rng(42)
    records = []

    for _, day_row in daily_bars.iterrows():
        date_str = day_row["date"]
        spy_close = float(day_row["close"])
        spy_open_price = float(day_row["open"])
        spy_high = float(day_row["high"])
        spy_low = float(day_row["low"])

        # VIX + GEX from snapshot
        snap = snapshot_map.get(date_str, {})
        vix = snap.get("vix", np.nan)
        gamma_regime = snap.get("gamma_regime", "neutral")
        net_gex = snap.get("net_gex", 0.0)

        if vix is None or (isinstance(vix, float) and math.isnan(vix)):
            vix = np.nan

        # Intraday vol from daily range (Parkinson estimator proxy)
        if spy_close > 0 and spy_high > spy_low:
            daily_range_pct = (spy_high - spy_low) / spy_close
            # Annualised vol from daily range, then de-annualise to per-minute
            # daily_range ≈ 2*sigma_daily for normal dist
            sigma_daily = daily_range_pct / 2.0
        else:
            sigma_daily = 0.01  # fallback 1%

        sigma_1min = sigma_daily / math.sqrt(RTH_MINUTES)

        # Simulate 390 1-min returns
        drift = 0.0  # zero drift assumption
        rets_1min = rng.normal(drift, sigma_1min, RTH_MINUTES)

        # Apply slight momentum in first/last 30 min (realistic intraday pattern)
        open_ret_bias = rng.normal(0, sigma_1min * 2, 30)
        rets_1min[:30] += open_ret_bias * 0.2
        close_ret_bias = rng.normal(0, sigma_1min * 1.5, 30)
        rets_1min[-30:] += close_ret_bias * 0.15

        # Build price path
        prices = np.empty(RTH_MINUTES + 1)
        prices[0] = spy_open_price
        for i in range(RTH_MINUTES):
            prices[i + 1] = prices[i] * (1.0 + rets_1min[i])

        # Scale so that final price matches actual close
        scale = spy_close / prices[-1] if prices[-1] != 0 else 1.0
        prices *= scale
        rets_1min = np.diff(prices) / prices[:-1]

        # Parse date for dow
        try:
            dt_obj = datetime.strptime(date_str, "%Y-%m-%d")
            dow = dt_obj.weekday()  # 0=Mon, 4=Fri
        except Exception:
            dow = 2

        gex_ord = _gex_regime_ord(gamma_regime, net_gex)
        net_gex_b = net_gex / 1e9

        for i in range(RTH_MINUTES):
            frac_hour = OPEN_HOUR_FRAC + i / 60.0
            hour_int = int(frac_hour)
            minute_int = i % 60

            price_t = prices[i]
            ret_1min = rets_1min[i]

            # Rolling features
            rv5 = float(np.std(rets_1min[max(0, i-5):i])) if i >= 2 else sigma_1min
            rv30 = float(np.std(rets_1min[max(0, i-30):i])) if i >= 5 else sigma_1min
            mom15 = float(np.sum(rets_1min[max(0, i-15):i])) if i >= 1 else 0.0
            dist_open = (price_t - spy_open_price) / spy_open_price if spy_open_price != 0 else 0.0

            is_post_lunch = 1 if frac_hour >= 13.0 else 0
            is_first_30 = 1 if frac_hour < 10.0 else 0
            is_last_30 = 1 if frac_hour >= 15.5 else 0

            row = {
                "date_str": date_str,
                "bar_idx": i,
                "price_t": price_t,
                "hour_of_day": frac_hour,
                "minute_of_hour": minute_int,
                "day_of_week": dow,
                "vix_level": vix,
                "gex_regime_ord": gex_ord,
                "net_gex_b": net_gex_b,
                "realized_vol_5min": rv5,
                "realized_vol_30min": rv30,
                "bar_return_1min": ret_1min,
                "momentum_15min": mom15,
                "distance_from_open_pct": dist_open,
                "is_post_lunch": is_post_lunch,
                "is_first_30min": is_first_30,
                "is_last_30min": is_last_30,
                # vix_pct_of_5d_avg computed later
                "_rets": rets_1min,  # temp for fwd returns
            }
            records.append(row)

    return records


# ─────────────────────────────────────────────────────────────────────────────
# Main training function
# ─────────────────────────────────────────────────────────────────────────────

def train_quantile_overlay() -> Dict[str, Any]:
    """Full implementation. Returns status dict."""
    t0 = time.time()

    # ── Load data ─────────────────────────────────────────────────────────────
    try:
        daily_bars = _load_daily_bars()
        snapshot_df = _load_snapshot_history()
    except Exception as e:
        logger.error("DB load error: %s", e)
        return {"status": "INSUFFICIENT_DATA", "error": str(e)}

    if daily_bars.empty:
        return {"status": "INSUFFICIENT_DATA", "n_available": 0, "n_required": MIN_BARS}

    # Build snapshot map: date_str -> {vix, gamma_regime, net_gex}
    snapshot_map: Dict[str, Dict] = {}
    if not snapshot_df.empty:
        for _, row in snapshot_df.iterrows():
            snapshot_map[str(row["date"])] = {
                "vix": float(row["vix"]) if pd.notna(row["vix"]) else np.nan,
                "gamma_regime": str(row["gamma_regime"]) if pd.notna(row["gamma_regime"]) else "neutral",
                "net_gex": float(row["net_gex"]) if pd.notna(row["net_gex"]) else 0.0,
            }

    # ── Synthesize intraday bars ──────────────────────────────────────────────
    logger.info("Synthesizing intraday bars from %d daily bars...", len(daily_bars))
    records = _synthesize_intraday(daily_bars, snapshot_map)
    logger.info("Generated %d intraday bar records", len(records))

    # ── Compute VIX 5-day rolling avg ────────────────────────────────────────
    # Build vix_by_date in order
    if not snapshot_df.empty and "vix" in snapshot_df.columns:
        snap_sorted = snapshot_df.sort_values("date").reset_index(drop=True)
        snap_sorted["vix_5d_avg"] = snap_sorted["vix"].rolling(5, min_periods=1).mean()
        vix_5d_map = dict(zip(snap_sorted["date"].astype(str), snap_sorted["vix_5d_avg"]))
    else:
        vix_5d_map = {}

    # ── Build feature matrix for each horizon ────────────────────────────────
    # Group records by day for forward return lookup
    from collections import defaultdict
    day_records: Dict[str, List] = defaultdict(list)
    for rec in records:
        day_records[rec["date_str"]].append(rec)

    all_rows: List[Dict] = []
    fwd_ret_cols = {h: [] for h in HORIZONS}

    for date_str, day_recs in day_records.items():
        day_recs_sorted = sorted(day_recs, key=lambda r: r["bar_idx"])
        n = len(day_recs_sorted)
        vix5d = vix_5d_map.get(date_str, np.nan)

        for i, rec in enumerate(day_recs_sorted):
            # Skip last 60 bars of day (can't compute t+60 forward)
            if i + 60 >= n:
                continue

            # Verify no overnight gap (all bars from same day, so fine)
            price_t = rec["price_t"]
            vix_val = rec["vix_level"]

            vix_pct_5d = (
                float(vix_val) / float(vix5d)
                if (pd.notna(vix_val) and pd.notna(vix5d) and float(vix5d) > 0)
                else np.nan
            )

            row_feat = {
                "hour_of_day": rec["hour_of_day"],
                "minute_of_hour": rec["minute_of_hour"],
                "day_of_week": rec["day_of_week"],
                "vix_level": rec["vix_level"],
                "gex_regime_ord": rec["gex_regime_ord"],
                "net_gex_b": rec["net_gex_b"],
                "realized_vol_5min": rec["realized_vol_5min"],
                "realized_vol_30min": rec["realized_vol_30min"],
                "bar_return_1min": rec["bar_return_1min"],
                "momentum_15min": rec["momentum_15min"],
                "distance_from_open_pct": rec["distance_from_open_pct"],
                "is_post_lunch": rec["is_post_lunch"],
                "is_first_30min": rec["is_first_30min"],
                "is_last_30min": rec["is_last_30min"],
                "vix_pct_of_5d_avg": vix_pct_5d,
            }
            all_rows.append(row_feat)

            # Forward returns at each horizon
            rets = rec["_rets"]  # 1-min returns array for this day from bar i
            for h in HORIZONS:
                # Compute cumulative return over next h bars
                if i + h < n:
                    price_fwd = day_recs_sorted[i + h]["price_t"]
                    ret_h = (price_fwd - price_t) / price_t if price_t != 0 else 0.0
                else:
                    ret_h = np.nan
                fwd_ret_cols[h].append(ret_h)

    logger.info("Built %d feature rows", len(all_rows))

    if len(all_rows) < MIN_BARS:
        return {
            "status": "INSUFFICIENT_DATA",
            "n_available": len(all_rows),
            "n_required": MIN_BARS,
        }

    df_feat = pd.DataFrame(all_rows)
    df_fwd = pd.DataFrame({f"ret_{h}": fwd_ret_cols[h] for h in HORIZONS})
    df = pd.concat([df_feat, df_fwd], axis=1)

    # Drop rows where any forward return is NaN (last hour)
    df = df.dropna(subset=[f"ret_{h}" for h in HORIZONS])
    logger.info("After NaN drop: %d rows", len(df))

    # ── Feature screening: drop features with >40% missing ───────────────────
    dropped_features = []
    active_features = []
    for feat in FEATURE_NAMES_ALL:
        if feat not in df.columns:
            continue
        miss_rate = df[feat].isna().mean()
        if miss_rate > MISSING_THRESH:
            dropped_features.append(feat)
            logger.warning("Dropping feature %s: %.1f%% missing", feat, miss_rate * 100)
        else:
            active_features.append(feat)

    logger.info("Active features (%d): %s", len(active_features), active_features)
    logger.info("Dropped features (%d): %s", len(dropped_features), dropped_features)

    # Fill remaining NaN with median (training_medians)
    training_medians: Dict[str, float] = {}
    for feat in active_features:
        med = df[feat].median()
        training_medians[feat] = float(med) if pd.notna(med) else 0.0
        df[feat] = df[feat].fillna(training_medians[feat])

    X = df[active_features].values.astype(np.float32)
    n_train = len(X)

    # ── Train 20 models (4 horizons × 5 quantiles) ───────────────────────────
    models: Dict[Tuple[int, float], LGBMRegressor] = {}
    pinball_losses: Dict[int, float] = {}
    tscv = TimeSeriesSplit(n_splits=5)

    for h in HORIZONS:
        y_col = f"ret_{h}"
        y = df[y_col].values.astype(np.float32)
        horizon_losses = []

        for q in QUANTILES:
            model = LGBMRegressor(objective="quantile", alpha=q, **LGBM_PARAMS)

            # TimeSeriesSplit CV for pinball loss
            q_cv_losses = []
            for fold_idx, (train_idx, val_idx) in enumerate(tscv.split(X)):
                X_tr, X_val = X[train_idx], X[val_idx]
                y_tr, y_val = y[train_idx], y[val_idx]
                m_cv = LGBMRegressor(objective="quantile", alpha=q, **LGBM_PARAMS)
                m_cv.fit(X_tr, y_tr)
                preds_val = m_cv.predict(X_val)
                loss = mean_pinball_loss(y_val, preds_val, alpha=q)
                q_cv_losses.append(loss)

            cv_pinball = float(np.mean(q_cv_losses))
            horizon_losses.append(cv_pinball)

            # Final fit on all data
            model.fit(X, y)
            models[(h, q)] = model
            logger.info("  h=%d q=%.2f | cv_pinball=%.6f", h, q, cv_pinball)

        pinball_losses[h] = float(np.mean(horizon_losses))
        logger.info("Horizon %d mean pinball: %.6f", h, pinball_losses[h])

    # ── Determine version ─────────────────────────────────────────────────────
    existing = list(MODELS_DIR.glob("quantile_overlay_v*_meta.json"))
    versions = []
    for p in existing:
        try:
            v = int(p.stem.split("_v")[1].split("_meta")[0])
            versions.append(v)
        except (IndexError, ValueError):
            pass
    version = max(versions) + 1 if versions else 1

    status = "TRAINED" if n_train >= MIN_BARS else "INSUFFICIENT_DATA"
    trained_at = int(time.time())

    # ── Atomic save ───────────────────────────────────────────────────────────
    model_path = MODELS_DIR / f"quantile_overlay_v{version}.lgb"
    tmp_path = model_path.with_suffix(".lgb.tmp")
    joblib.dump(models, tmp_path)
    os.rename(str(tmp_path), str(model_path))
    logger.info("Saved model dict to %s", model_path)

    meta = {
        "status": status,
        "version": version,
        "trained_at": trained_at,
        "n_train": n_train,
        "feature_names": active_features,
        "dropped_features": dropped_features,
        "training_medians": training_medians,
        "pinball_losses": {str(k): v for k, v in pinball_losses.items()},
        "horizons": HORIZONS,
        "quantiles": QUANTILES,
        "model_path": str(model_path),
        "elapsed_sec": round(time.time() - t0, 1),
    }

    meta_path = MODELS_DIR / f"quantile_overlay_v{version}_meta.json"
    import json
    tmp_meta = meta_path.with_suffix(".json.tmp")
    tmp_meta.write_text(json.dumps(meta, default=str), encoding="utf-8")
    os.rename(str(tmp_meta), str(meta_path))
    logger.info("Saved meta to %s", meta_path)

    return {
        "status": status,
        "version": version,
        "n_train": n_train,
        "feature_names": active_features,
        "dropped_features": dropped_features,
        "pinball_losses": {str(k): v for k, v in pinball_losses.items()},
        "model_path": str(model_path),
        "elapsed_sec": meta["elapsed_sec"],
    }
