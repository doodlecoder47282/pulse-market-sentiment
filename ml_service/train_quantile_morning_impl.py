"""
Morning Anchor quantile model — Model D.
Predicts q10/q25/q50/q75/q90 forward returns at 30/60/120/240/390min horizons,
conditioned on a "morning fingerprint" frozen at 9:45 ET (first 15min of RTH)
plus current live features.

Hypothesis: The first 15 min of regular trading is high informational density —
opening-range establishment, opening drive direction, opening volume informativeness.
Conditioning the projection on this fingerprint should improve mid-day horizons
(60-240min) versus a rolling-only model.

Architecture:
    For each synthetic day, freeze the morning fingerprint at bar 15 (9:45 ET):
        - orb_hi, orb_lo, orb_range_atr (opening range / 20d ATR)
        - opening_drive (signed return 9:30 -> 9:45)
        - opening_drive_atr (drive normalized by per-bar ATR)
        - opening_vol_z (synthetic — proxy: range vs typical)
        - opening_gap (open vs prior close, in ATR units)
        - first15_vwap_dev (current price vs 9:45 VWAP)

    For each bar t in [bar_15, bar_390] of that day, build training row with:
        - All v3 features (time, vol, ATR, trend, Greek distances)
        - 7 morning fingerprint features (frozen at bar 15)
        - 1 live feature: bars_since_open (decay weight)
        - Forward returns at 30/60/120/240/390min

    Train one quantile regressor per (horizon, quantile) pair.

Output: quantile_overlay_morning_vN.lgb + _meta.json
Inference: predictor.predict_quantile_morning(features, horizons)
Blend: weighted average with v3 quantile_overlay; weight ramps from 0 pre-9:45
to ~0.7 by 10:30, decays through close.
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from sklearn.metrics import mean_pinball_loss

# Reuse v3 building blocks
from train_quantile_impl import (
    _load_daily_bars,
    _load_snapshot_history,
    _synthesize_intraday,
    _synthesize_greek_levels,
)

logger = logging.getLogger("ml.quantile_morning")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

# Morning model horizons — the value-add window is 30-240min.
# Cap at 240 because anchor is at bar 15; max possible fwd = 390-15-1 = 374.
HORIZONS = [30, 60, 120, 180, 240]
QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]
MIN_BARS = 500

ANCHOR_BAR = 15  # 9:45 ET (first 15 minutes locked in)
RTH_MINUTES = 390

FEATURE_NAMES = [
    # ── Time / regime (subset of v3) ────────────────────────────────
    "hour_of_day",
    "minute_of_hour",
    "day_of_week",
    "is_post_lunch",
    "is_last_30min",
    # ── Spot / macro ────────────────────────────────────────────────
    "spx_spot",
    "vix_level",
    "vix_change_pct",
    # ── Live vol / ATR / trend ──────────────────────────────────────
    "realized_vol_30m",
    "realized_vol_5m",
    "atr_5m",
    "trend_30m",
    "trend_5m",
    # ── Greek distance (live; carried into model) ───────────────────
    "dist_to_callwall_atr",
    "dist_to_putwall_atr",
    "dist_to_flip_atr",
    "dist_to_zomma_atr",
    "vanna_level_dist_atr",
    "net_gex_sign",
    "net_gex_magnitude",
    # ── Morning fingerprint (FROZEN at 9:45 ET) ─────────────────────
    "morn_orb_range_atr",       # opening 15m range / ATR
    "morn_orb_hi_pct",          # ORB high vs open (%)
    "morn_orb_lo_pct",          # ORB low vs open (%)
    "morn_open_drive_atr",      # signed return 9:30 -> 9:45 / ATR
    "morn_opening_vol_z",       # opening vol intensity proxy
    "morn_gap_atr",             # gap from prior close / ATR
    "morn_vwap_dev_atr",        # current price - 9:45 VWAP / ATR
    # ── Live morning-relative features ──────────────────────────────
    "bars_since_anchor",        # bars elapsed since 9:45 (decay weight)
    "spot_vs_anchor_atr",       # current spot vs 9:45 close, in ATR units
]

LGBM_PARAMS = dict(
    n_estimators=60,
    learning_rate=0.07,
    max_depth=5,
    min_child_samples=40,
    num_leaves=24,
    reg_lambda=0.5,
    n_jobs=-1,
    verbose=-1,
)


def _compute_morning_fingerprint(
    day_recs: List[Dict],
    daily_atr: float,
    prev_close: float,
) -> Dict[str, float]:
    """
    Compute morning fingerprint from first 15 bars of a synthetic day.
    Returns the 7 frozen features that will be attached to every bar
    after 9:45 ET on that day.
    """
    if len(day_recs) < ANCHOR_BAR + 1 or daily_atr <= 0:
        return {
            "morn_orb_range_atr": 0.0,
            "morn_orb_hi_pct": 0.0,
            "morn_orb_lo_pct": 0.0,
            "morn_open_drive_atr": 0.0,
            "morn_opening_vol_z": 0.0,
            "morn_gap_atr": 0.0,
            "morn_vwap_dev_atr": 0.0,
        }

    # First 15 bars = 9:30 -> 9:45
    morning = day_recs[:ANCHOR_BAR]
    open_price = morning[0]["price_t"]
    anchor_close = morning[-1]["price_t"]

    # ORB high / low across the 15 bars (use price + small noise band)
    morning_prices = np.array([r["price_t"] for r in morning])
    orb_hi = float(morning_prices.max())
    orb_lo = float(morning_prices.min())
    orb_range = orb_hi - orb_lo

    # Opening drive
    drive = anchor_close - open_price

    # Opening vol z-score: ratio of morning realized vol to full-day expected vol
    rets = [r["bar_return_1min"] for r in morning]
    morn_rv = float(np.std(rets)) if len(rets) > 2 else 0.0
    # Z-score: how much morning vol deviates from typical full-day per-bar vol
    full_day_rets = [r["bar_return_1min"] for r in day_recs]
    full_day_rv = float(np.std(full_day_rets)) if len(full_day_rets) > 5 else max(morn_rv, 1e-6)
    opening_vol_z = (morn_rv / full_day_rv) - 1.0 if full_day_rv > 0 else 0.0

    # Gap
    gap = open_price - prev_close

    # VWAP of first 15
    vwap = float(np.mean(morning_prices))
    vwap_dev = anchor_close - vwap

    atr = daily_atr if daily_atr > 0 else 1.0

    return {
        "morn_orb_range_atr": float(orb_range / atr),
        "morn_orb_hi_pct": float((orb_hi - open_price) / open_price * 100.0) if open_price > 0 else 0.0,
        "morn_orb_lo_pct": float((orb_lo - open_price) / open_price * 100.0) if open_price > 0 else 0.0,
        "morn_open_drive_atr": float(drive / atr),
        "morn_opening_vol_z": float(np.clip(opening_vol_z, -3.0, 3.0)),
        "morn_gap_atr": float(gap / atr),
        "morn_vwap_dev_atr": float(vwap_dev / atr),
    }


def _gex_regime_to_sign(gamma_regime: str, net_gex: float) -> Tuple[int, float]:
    """Map regime + signed net_gex -> (sign, magnitude_b)."""
    g = (gamma_regime or "neutral").lower()
    if "neg" in g:
        sign = -1
    elif "pos" in g:
        sign = 1
    else:
        sign = 1 if net_gex >= 0 else -1
    return sign, abs(net_gex) / 1e9


def train_quantile_morning() -> Dict[str, Any]:
    """Train the Morning Anchor quantile model. Returns status dict."""
    t0 = time.time()

    try:
        daily_bars = _load_daily_bars()
        snapshot_df = _load_snapshot_history()
    except Exception as e:
        logger.error("DB load: %s", e)
        return {"status": "INSUFFICIENT_DATA", "error": str(e)}

    if daily_bars.empty:
        return {"status": "INSUFFICIENT_DATA", "n_available": 0, "n_required": MIN_BARS}

    snapshot_map: Dict[str, Dict] = {}
    if not snapshot_df.empty:
        for _, row in snapshot_df.iterrows():
            snapshot_map[str(row["date"])] = {
                "vix": float(row["vix"]) if pd.notna(row["vix"]) else np.nan,
                "gamma_regime": str(row["gamma_regime"]) if pd.notna(row["gamma_regime"]) else "neutral",
                "net_gex": float(row["net_gex"]) if pd.notna(row["net_gex"]) else 0.0,
            }

    # Subsample to 40 days. Each day yields ~340 training rows (bars 15..360-30).
    # 40 * 340 = ~13.6k rows total, well above MIN_BARS=500 and tractable
    # for 5 horizons * 5 quantiles = 25 LGBM fits within ~3-5 min.
    if len(daily_bars) > 40:
        daily_bars = daily_bars.sort_values("ts").tail(40).reset_index(drop=True)

    # Compute prior-day close map for gap feature
    daily_sorted = daily_bars.sort_values("ts").reset_index(drop=True)
    prev_close_map: Dict[str, float] = {}
    last_close = float(daily_sorted.iloc[0]["close"])
    for _, r in daily_sorted.iterrows():
        prev_close_map[str(r["date"])] = last_close
        last_close = float(r["close"])

    # ATR-20 proxy. spy_1min_history has only close (H=L=O=C in this DB), so
    # use absolute day-over-day close move as the true-range proxy.
    daily_sorted["abs_dod"] = daily_sorted["close"].diff().abs()
    daily_sorted["atr20"] = daily_sorted["abs_dod"].rolling(20, min_periods=5).mean()
    # Fallback: if still zero/nan, use 0.5% of close as a sane default.
    atr_map: Dict[str, float] = {}
    for _, r in daily_sorted.iterrows():
        v = r["atr20"]
        if pd.notna(v) and v > 0:
            atr_map[str(r["date"])] = float(v)
        else:
            atr_map[str(r["date"])] = float(r["close"]) * 0.005

    # VIX prior-day map for change_pct
    vix_prev_map: Dict[str, float] = {}
    if not snapshot_df.empty:
        snap_sorted = snapshot_df.sort_values("date").reset_index(drop=True)
        prev_vix = np.nan
        for _, row in snap_sorted.iterrows():
            vix_prev_map[str(row["date"])] = (
                prev_vix if pd.notna(prev_vix)
                else float(row["vix"]) if pd.notna(row["vix"])
                else np.nan
            )
            if pd.notna(row["vix"]):
                prev_vix = float(row["vix"])

    logger.info("[morn] Synthesizing intraday from %d daily bars...", len(daily_bars))
    records = _synthesize_intraday(daily_bars, snapshot_map)
    logger.info("[morn] Generated %d 1-min records", len(records))

    from collections import defaultdict
    day_records: Dict[str, List] = defaultdict(list)
    for rec in records:
        day_records[rec["date_str"]].append(rec)

    rng = np.random.default_rng(11)
    all_rows: List[Dict] = []
    fwd_ret_cols: Dict[int, List[float]] = {h: [] for h in HORIZONS}

    for date_str, day_recs in day_records.items():
        # Need enough bars: at least ANCHOR_BAR (lock) + at least 30min forward to predict.
        if len(day_recs) < ANCHOR_BAR + 30 + 1:
            continue

        atr20 = atr_map.get(date_str, 0.0)
        if atr20 <= 0:
            continue
        prev_close = prev_close_map.get(date_str, day_recs[0]["price_t"])

        # Compute morning fingerprint (frozen for the day)
        morn_fp = _compute_morning_fingerprint(day_recs, atr20, prev_close)
        anchor_close = day_recs[ANCHOR_BAR - 1]["price_t"]

        snap = snapshot_map.get(date_str, {})
        vix_level = snap.get("vix", np.nan)
        vix_prev = vix_prev_map.get(date_str, vix_level)
        if pd.isna(vix_prev) or vix_prev == 0:
            vix_change_pct = 0.0
        else:
            vix_change_pct = (vix_level - vix_prev) / vix_prev if pd.notna(vix_level) else 0.0
        gex_sign, gex_mag = _gex_regime_to_sign(snap.get("gamma_regime", "neutral"), snap.get("net_gex", 0.0))

        # Synthesize per-day Greek levels (consistent with v3 approach)
        levels = _synthesize_greek_levels(anchor_close, rng)
        atr_5m_proxy = atr20 / math.sqrt(78)  # 78 5min bars/day

        # Build training rows for each bar t in [ANCHOR_BAR, ...].
        # For each t, only include rows where ALL horizons can be computed.
        # If t + h exceeds day length, that horizon's fwd return is NaN and the
        # row is dropped later in the dropna step.
        max_t = len(day_recs) - 1
        prices = np.array([r["price_t"] for r in day_recs])

        # We want at least the 30min horizon to be valid -> t <= len - 31
        # Use NaN for longer horizons that go past EOD; the dropna at training
        # step is limited to the min horizon to keep the training set large.
        for t in range(ANCHOR_BAR, max_t - 30):
            rec = day_recs[t]
            price_t = rec["price_t"]
            bars_since_anchor = t - ANCHOR_BAR

            # Live realized vol windows
            rv30 = float(np.std(np.diff(prices[max(0, t-30):t+1]) / prices[max(0, t-30):t])) if t >= 5 else 0.0
            rv5 = float(np.std(np.diff(prices[max(0, t-5):t+1]) / prices[max(0, t-5):t])) if t >= 2 else 0.0
            trend30 = float((price_t - prices[max(0, t-30)]) / prices[max(0, t-30)]) if t >= 5 else 0.0
            trend5 = float((price_t - prices[max(0, t-5)]) / prices[max(0, t-5)]) if t >= 2 else 0.0

            # Distance to dealer levels in ATR units
            atr_unit = max(atr_5m_proxy, 0.001)
            dist_call = (levels["callWall"] - price_t) / atr_unit
            dist_put = (levels["putWall"] - price_t) / atr_unit
            dist_flip = (levels["flip"] - price_t) / atr_unit
            dist_zomma = (levels["zomma"] - price_t) / atr_unit
            dist_vanna = (levels["vannaLvl"] - price_t) / atr_unit

            row = {
                "hour_of_day": rec["hour_of_day"],
                "minute_of_hour": rec["minute_of_hour"],
                "day_of_week": rec["day_of_week"],
                "is_post_lunch": rec["is_post_lunch"],
                "is_last_30min": rec["is_last_30min"],
                "spx_spot": price_t,
                "vix_level": vix_level if pd.notna(vix_level) else 18.0,
                "vix_change_pct": vix_change_pct,
                "realized_vol_30m": rv30,
                "realized_vol_5m": rv5,
                "atr_5m": atr_5m_proxy,
                "trend_30m": trend30,
                "trend_5m": trend5,
                "dist_to_callwall_atr": dist_call,
                "dist_to_putwall_atr": dist_put,
                "dist_to_flip_atr": dist_flip,
                "dist_to_zomma_atr": dist_zomma,
                "vanna_level_dist_atr": dist_vanna,
                "net_gex_sign": gex_sign,
                "net_gex_magnitude": gex_mag,
                # Frozen fingerprint
                **morn_fp,
                # Live morning-relative
                "bars_since_anchor": bars_since_anchor,
                "spot_vs_anchor_atr": (price_t - anchor_close) / atr_unit,
            }
            all_rows.append(row)

            # Forward returns. NaN if horizon extends past EOD.
            for h in HORIZONS:
                if (t + h) < len(day_recs):
                    fwd = day_recs[t + h]["price_t"]
                    fwd_ret = (fwd - price_t) / price_t if price_t > 0 else np.nan
                else:
                    fwd_ret = np.nan
                fwd_ret_cols[h].append(fwd_ret)

    logger.info("[morn] Built %d feature rows", len(all_rows))
    if len(all_rows) < MIN_BARS:
        return {"status": "INSUFFICIENT_DATA", "n_available": len(all_rows), "n_required": MIN_BARS}

    df_feat = pd.DataFrame(all_rows)
    df_fwd = pd.DataFrame({f"ret_{h}": fwd_ret_cols[h] for h in HORIZONS})
    df = pd.concat([df_feat, df_fwd], axis=1)
    # Drop rows where the SHORTEST horizon is NaN (drops only EOD-tail rows)
    df = df.dropna(subset=[f"ret_{min(HORIZONS)}"])
    logger.info("[morn] After 30min-NaN drop: %d rows", len(df))

    active_features = [f for f in FEATURE_NAMES if f in df.columns]
    training_medians: Dict[str, float] = {}
    for feat in active_features:
        med = df[feat].median()
        training_medians[feat] = float(med) if pd.notna(med) else 0.0
        df[feat] = df[feat].fillna(training_medians[feat])

    X = df[active_features].values.astype(np.float32)
    n_total = len(X)
    n_val = max(200, int(n_total * 0.2))
    val_split = n_total - n_val
    X_tr, X_val = X[:val_split], X[val_split:]

    models: Dict[Tuple[int, float], LGBMRegressor] = {}
    pinball_losses: Dict[int, float] = {}

    for h in HORIZONS:
        # Per-horizon mask: drop rows where THIS horizon's fwd ret is NaN
        col = f"ret_{h}"
        mask = df[col].notna().values
        df_h = df.loc[mask].reset_index(drop=True)
        if len(df_h) < MIN_BARS:
            logger.warning("[morn] h=%d only %d valid rows, skipping", h, len(df_h))
            pinball_losses[h] = float("nan")
            continue
        X_h = df_h[active_features].values.astype(np.float32)
        y_h = df_h[col].values.astype(np.float32)
        n_h = len(X_h)
        n_val_h = max(200, int(n_h * 0.2))
        split_h = n_h - n_val_h
        Xh_tr, Xh_val = X_h[:split_h], X_h[split_h:]
        yh_tr, yh_val = y_h[:split_h], y_h[split_h:]
        h_losses = []
        for q in QUANTILES:
            # Train on 80% split, evaluate on 20% holdout, persist that model.
            # Skip refit-on-full to save time — holdout-trained model is fine
            # for inference and the unbiased loss estimate is published.
            m = LGBMRegressor(objective="quantile", alpha=q, **LGBM_PARAMS)
            m.fit(Xh_tr, yh_tr)
            preds_val = m.predict(Xh_val)
            loss = float(mean_pinball_loss(yh_val, preds_val, alpha=q))
            h_losses.append(loss)
            models[(h, q)] = m
            logger.info("[morn]  h=%d q=%.2f | n=%d hold-out pinball=%.6f", h, q, n_h, loss)
        pinball_losses[h] = float(np.mean(h_losses))

    # Versioning
    existing = list(MODELS_DIR.glob("quantile_overlay_morning_v*_meta.json"))
    versions = []
    for p in existing:
        try:
            v = int(p.stem.split("_v")[1].split("_meta")[0])
            versions.append(v)
        except (IndexError, ValueError):
            pass
    version = max(versions) + 1 if versions else 1
    trained_at = int(time.time())

    model_path = MODELS_DIR / f"quantile_overlay_morning_v{version}.lgb"
    tmp_path = model_path.with_suffix(".lgb.tmp")
    joblib.dump(models, tmp_path)
    os.rename(str(tmp_path), str(model_path))
    logger.info("[morn] Saved model to %s", model_path)

    meta = {
        "status": "TRAINED",
        "version": version,
        "trained_at": trained_at,
        "n_train": n_total,
        "feature_names": active_features,
        "training_medians": training_medians,
        "pinball_losses": {str(k): v for k, v in pinball_losses.items()},
        "horizons": HORIZONS,
        "quantiles": QUANTILES,
        "model_path": str(model_path),
        "elapsed_sec": round(time.time() - t0, 1),
        "anchor_bar": ANCHOR_BAR,
        "notes": "Morning Anchor — fingerprint frozen at 9:45 ET, live features merged. Synthetic intraday + Greek levels from daily-bar GBM simulation.",
    }
    meta_path = MODELS_DIR / f"quantile_overlay_morning_v{version}_meta.json"
    tmp_meta = meta_path.with_suffix(".json.tmp")
    tmp_meta.write_text(json.dumps(meta, default=str), encoding="utf-8")
    os.rename(str(tmp_meta), str(meta_path))

    return {
        "status": "TRAINED",
        "version": version,
        "n_train": n_total,
        "feature_names": active_features,
        "pinball_losses": {str(k): v for k, v in pinball_losses.items()},
        "model_path": str(model_path),
        "elapsed_sec": meta["elapsed_sec"],
    }


if __name__ == "__main__":
    res = train_quantile_morning()
    print(json.dumps(res, indent=2, default=str))
