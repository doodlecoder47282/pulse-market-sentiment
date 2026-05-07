"""
Pulse Batcave — Trainer (Wire 17)
train_score_calibrator: LightGBM binary classifier for p(hit_t1).

Contract:
- Atomic writes: write to .tmp file then os.rename (never half-written)
- Write _meta.json alongside each model
- Return {status: "INSUFFICIENT_DATA"} (no raise) when below data thresholds
- Thresholds: score_calibrator needs >= 100 primary / >= 80 bootstrap rows
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from loaders import load_prediction_outcomes, load_whale_follows, load_backtest_observations

MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

logger = logging.getLogger(__name__)

# ─── Thresholds ───────────────────────────────────────────────────────────────
MIN_ROWS_SCORE_CALIBRATOR = 100   # primary (odte_alert_audit)
MIN_ROWS_SCORE_BOOTSTRAP  = 80    # bootstrap (combined prediction_outcomes)
MIN_ROWS_WHALE_FOLLOW = 50
MIN_ROWS_QUANTILE_OVERLAY = 30


def _atomic_write(path: Path, data: bytes) -> None:
    """Write data atomically via temp file + rename."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.rename(str(tmp), str(path))


def _write_meta(name: str, version: int, meta: Dict[str, Any]) -> Path:
    meta_path = MODELS_DIR / f"{name}_v{version}_meta.json"
    tmp = meta_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, default=str), encoding="utf-8")
    os.rename(str(tmp), str(meta_path))
    return meta_path


def _next_version(name: str) -> int:
    existing = list(MODELS_DIR.glob(f"{name}_v*_meta.json"))
    if not existing:
        return 1
    versions = []
    for p in existing:
        try:
            v = int(p.stem.split("_v")[1].split("_meta")[0])
            versions.append(v)
        except (IndexError, ValueError):
            pass
    return max(versions) + 1 if versions else 1


# ─── Feature engineering helpers ─────────────────────────────────────────────

_REGIME_MAP = {
    "TREND_UP": 0,
    "TREND_DN": 1,
    "CHOP": 2,
    "SQUEEZE": 3,
    "BREAKOUT": 4,
    "REVERSAL": 5,
}

_TIER_MAP = {"STANDARD": 0, "BANGER": 1, "MOONSHOT": 2}
_SETUP_MAP = {"FAILED_BREAK": 0, "PIVOT_RECLAIM": 1, "WALL_REJECT": 2}
_GEX_TIER_MAP = {"THIN": 0, "LIGHT": 1, "SOFT": 2, "FULL": 3}

NY_TZ = "America/New_York"


def _parse_json(s: Any) -> Dict:
    if isinstance(s, str):
        try:
            return json.loads(s)
        except Exception:
            return {}
    return s if isinstance(s, dict) else {}


def _extract_odte_audit_features(row: pd.Series) -> Dict[str, Any]:
    """Extract features from odte_alert_audit row."""
    feats = _parse_json(row.get("features_json", "{}"))
    contract = _parse_json(row.get("contract_json", "{}"))

    # detected_at timestamp -> hour_of_day in NY
    hour = None
    detected_at = row.get("detected_at")
    if detected_at is not None:
        try:
            ts = pd.Timestamp(detected_at, unit="ms", tz="UTC").tz_convert(NY_TZ)
            hour = ts.hour
        except Exception:
            pass

    tier_str = str(row.get("tier", "")).upper()
    setup_str = str(row.get("setup", "")).upper()

    score_val = row.get("score")
    if score_val is None:
        score_val = feats.get("score")

    return {
        "score":               _float(score_val),
        "tier_ord":            _tier_map_val(tier_str),
        "setup_ord":           _SETUP_MAP.get(setup_str),
        "gex_tier_ord":        _GEX_TIER_MAP.get(str(feats.get("gexTier", "")).upper()),
        "gex_magnitude_b":     _float(feats.get("gexMagnitudeB")),
        "iv_rv_ratio":         _float(feats.get("ivRvRatio")),
        "delta":               _float(contract.get("delta") or feats.get("delta")),
        "dte":                 _float(contract.get("dte") or feats.get("dte")),
        "bid_ask_spread_pct":  _float(feats.get("bidAskSpreadPct")),
        "ofi_signed":          _float(feats.get("ofiSigned")),
        "regime_ord":          _regime_map_val(str(feats.get("regime", "")).upper()),
        "is_a_minus":          1.0 if (_float(score_val) or 0) >= 85 else 0.0,
        "hour_of_day":         _float(hour),
        "distance_to_t1_pct":  _float(feats.get("distanceToT1Pct")),
    }


def _extract_bootstrap_features(row: pd.Series, kind: str) -> Dict[str, Any]:
    """
    Extract overlapping features from prediction_outcomes rows.
    whale_alert: inputs_json has regimeAtFire; prediction_json has delta, dte, type.
    regime_call: inputs_json has currentRegime, drivers.vix/breadth/trend.
    Both: pct_return, hit_30.
    """
    inp = _parse_json(row.get("inputs_json", "{}"))
    pred = _parse_json(row.get("prediction_json", "{}"))

    if kind == "whale_alert":
        regime_str = str(inp.get("regimeAtFire", "")).upper()
        delta_raw = pred.get("delta")
        # delta is signed; abs for magnitude, keep sign
        delta = _float(delta_raw)
        dte = _float(pred.get("dte"))
        vol_oi = _float(pred.get("volOiRatio"))
        premium = _float(pred.get("premium"))
        # Proxy score: vol/OI ratio * 10 capped at 100
        score_proxy = min((vol_oi or 0) * 2.0, 100.0) if vol_oi else None
        # type -> is_a_minus proxy (high vol_oi => a-minus)
        is_a_minus = 1.0 if (vol_oi or 0) > 25 else 0.0

        return {
            "score":               score_proxy,
            "tier_ord":            None,
            "setup_ord":           None,
            "gex_tier_ord":        None,
            "gex_magnitude_b":     None,
            "iv_rv_ratio":         None,
            "delta":               delta,
            "dte":                 dte,
            "bid_ask_spread_pct":  None,
            "ofi_signed":          None,
            "regime_ord":          _regime_map_val(regime_str),
            "is_a_minus":          is_a_minus,
            "hour_of_day":         None,
            "distance_to_t1_pct":  None,
            "vol_oi_ratio":        vol_oi,
            "premium_m":           (premium / 1_000_000) if premium else None,
        }

    elif kind == "regime_call":
        regime_str = str(inp.get("currentRegime", "")).upper()
        drivers = inp.get("drivers", {})
        confidence = _float(pred.get("confidence"))

        return {
            "score":               (confidence or 0) * 100 if confidence else None,
            "tier_ord":            None,
            "setup_ord":           None,
            "gex_tier_ord":        None,
            "gex_magnitude_b":     None,
            "iv_rv_ratio":         None,
            "delta":               None,
            "dte":                 None,
            "bid_ask_spread_pct":  None,
            "ofi_signed":          None,
            "regime_ord":          _regime_map_val(regime_str),
            "is_a_minus":          1.0 if (confidence or 0) >= 0.85 else 0.0,
            "hour_of_day":         None,
            "distance_to_t1_pct":  None,
            "vol_oi_ratio":        None,
            "premium_m":           None,
        }

    return {}


def _float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _tier_map_val(s: str) -> Optional[float]:
    v = _TIER_MAP.get(s)
    return float(v) if v is not None else None


def _regime_map_val(s: str) -> Optional[float]:
    v = _REGIME_MAP.get(s)
    return float(v) if v is not None else None


def _build_feature_matrix(
    rows: List[Dict[str, Any]],
    candidate_features: List[str],
    missing_threshold: float = 0.40,
) -> tuple[pd.DataFrame, List[str], List[str]]:
    """
    Build feature matrix, drop features missing > threshold fraction of rows.
    Returns (X_df, kept_features, dropped_features).
    """
    df = pd.DataFrame(rows)
    # Only consider candidate features that actually exist in df
    available = [f for f in candidate_features if f in df.columns]

    null_rates = df[available].isnull().mean()
    dropped = [f for f in available if null_rates[f] > missing_threshold]
    kept = [f for f in available if null_rates[f] <= missing_threshold]

    if dropped:
        logger.info("Dropping features (>%.0f%% missing): %s", missing_threshold * 100, dropped)

    X = df[kept].copy()
    return X, kept, dropped


# ─── train_score_calibrator ───────────────────────────────────────────────────

def train_score_calibrator() -> Dict[str, Any]:
    """
    Train a calibrated LightGBM binary classifier to predict p(hit_t1).

    Priority:
      1. odte_alert_audit WHERE graded=1 AND hit_t1 IS NOT NULL — primary (TRAINED)
         Threshold: >= 100 rows
      2. Bootstrap: combine graded prediction_outcomes (whale_alert + regime_call)
         Threshold: >= 80 rows
      3. INSUFFICIENT_DATA
    """
    import sqlite3
    from lightgbm import LGBMClassifier
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import roc_auc_score, brier_score_loss
    import joblib

    db_path = Path(__file__).resolve().parent.parent / "data.db"

    # ── Step 1: Try odte_alert_audit (primary) ────────────────────────────────
    try:
        conn = sqlite3.connect(str(db_path))
        odte_df = pd.read_sql_query(
            "SELECT * FROM odte_alert_audit WHERE graded=1 AND hit_t1 IS NOT NULL",
            conn,
        )
        conn.close()
    except Exception as e:
        logger.warning("odte_alert_audit load failed: %s", e)
        odte_df = pd.DataFrame()

    primary_n = len(odte_df)
    use_primary = primary_n >= MIN_ROWS_SCORE_CALIBRATOR
    training_status = "TRAINED" if use_primary else "BOOTSTRAP"

    # ── Step 2: Bootstrap fallback ────────────────────────────────────────────
    if not use_primary:
        df_w = load_prediction_outcomes(kind="whale_alert")
        if "graded" in df_w.columns:
            df_w = df_w[df_w["graded"] == 1]

        df_r = load_prediction_outcomes(kind="regime_call")
        if "graded" in df_r.columns:
            df_r = df_r[df_r["graded"] == 1]

        bootstrap_n = len(df_w) + len(df_r)

        if bootstrap_n < MIN_ROWS_SCORE_BOOTSTRAP:
            return {
                "status": "INSUFFICIENT_DATA",
                "n_available": bootstrap_n,
                "n_required": MIN_ROWS_SCORE_BOOTSTRAP,
                "n_odte_primary": primary_n,
            }

        # Build feature dicts
        feat_rows = []
        labels = []

        for _, row in df_w.iterrows():
            feats = _extract_bootstrap_features(row, "whale_alert")
            feat_rows.append(feats)
            labels.append(int(row.get("hit_30") or 0))

        for _, row in df_r.iterrows():
            feats = _extract_bootstrap_features(row, "regime_call")
            feat_rows.append(feats)
            labels.append(int(row.get("hit_30") or 0))

        # Sort by captured_at for temporal split
        ts_vals_w = df_w["captured_at"].tolist() if "captured_at" in df_w.columns else [0] * len(df_w)
        ts_vals_r = df_r["captured_at"].tolist() if "captured_at" in df_r.columns else [0] * len(df_r)
        timestamps = list(ts_vals_w) + list(ts_vals_r)

        # Sort by timestamp
        order = np.argsort(timestamps)
        feat_rows = [feat_rows[i] for i in order]
        labels = [labels[i] for i in order]

        CANDIDATE_FEATURES = [
            "score", "tier_ord", "setup_ord", "gex_tier_ord",
            "gex_magnitude_b", "iv_rv_ratio", "delta", "dte",
            "bid_ask_spread_pct", "ofi_signed", "regime_ord",
            "is_a_minus", "hour_of_day", "distance_to_t1_pct",
            "vol_oi_ratio", "premium_m",
        ]

        X_df, kept_features, dropped_features = _build_feature_matrix(
            feat_rows, CANDIDATE_FEATURES, missing_threshold=0.40
        )
        y = np.array(labels, dtype=int)
        n_train = len(y)

    else:
        # Primary path: odte_alert_audit
        feat_rows = []
        labels = []
        timestamps = []

        for _, row in odte_df.iterrows():
            feats = _extract_odte_audit_features(row)
            feat_rows.append(feats)
            labels.append(int(row.get("hit_t1") or 0))
            timestamps.append(row.get("detected_at") or 0)

        order = np.argsort(timestamps)
        feat_rows = [feat_rows[i] for i in order]
        labels = [labels[i] for i in order]

        CANDIDATE_FEATURES = [
            "score", "tier_ord", "setup_ord", "gex_tier_ord",
            "gex_magnitude_b", "iv_rv_ratio", "delta", "dte",
            "bid_ask_spread_pct", "ofi_signed", "regime_ord",
            "is_a_minus", "hour_of_day", "distance_to_t1_pct",
        ]

        X_df, kept_features, dropped_features = _build_feature_matrix(
            feat_rows, CANDIDATE_FEATURES, missing_threshold=0.40
        )
        y = np.array(labels, dtype=int)
        n_train = len(y)
        dropped_features = dropped_features

    # ── Fill NaN with column medians ──────────────────────────────────────────
    medians: Dict[str, float] = {}
    for col in kept_features:
        med = X_df[col].median()
        medians[col] = float(med) if not np.isnan(med) else 0.0
        X_df[col] = X_df[col].fillna(medians[col])

    X = X_df[kept_features].values.astype(np.float32)

    # ── Guard: need at least 2 classes ────────────────────────────────────────
    if len(np.unique(y)) < 2:
        return {
            "status": "INSUFFICIENT_DATA",
            "reason": "only_one_class",
            "n_available": n_train,
            "n_required": MIN_ROWS_SCORE_BOOTSTRAP,
        }

    # ── LightGBM + calibration ────────────────────────────────────────────────
    lgb_params = dict(
        n_estimators=200,
        learning_rate=0.05,
        max_depth=6,
        min_child_samples=10,
        num_leaves=31,
        reg_lambda=1.0,
        class_weight="balanced",
        verbose=-1,
        random_state=42,
    )
    base_clf = LGBMClassifier(**lgb_params)

    cal_method = "isotonic" if n_train >= 200 else "sigmoid"
    cal_cv = 5 if n_train >= 200 else 3

    # ── TimeSeriesSplit cross-validation ──────────────────────────────────────
    n_splits = 5
    # Ensure each fold has enough samples
    min_test_size = max(5, n_train // (n_splits + 1))
    tscv = TimeSeriesSplit(n_splits=n_splits, test_size=min_test_size)

    fold_aucs: List[float] = []
    fold_briers: List[float] = []

    for fold_i, (train_idx, test_idx) in enumerate(tscv.split(X)):
        X_tr, X_te = X[train_idx], X[test_idx]
        y_tr, y_te = y[train_idx], y[test_idx]

        # Skip fold if either split has only one class
        if len(np.unique(y_tr)) < 2 or len(np.unique(y_te)) < 2:
            continue

        fold_clf = LGBMClassifier(**lgb_params)

        # Use sigmoid for fold calibration regardless (smaller data per fold)
        fold_n = len(y_tr)
        fold_cal_cv = min(3, max(2, fold_n // 10))
        try:
            cal_fold = CalibratedClassifierCV(fold_clf, method="sigmoid", cv=fold_cal_cv)
            cal_fold.fit(X_tr, y_tr)
            proba = cal_fold.predict_proba(X_te)[:, 1]
            fold_aucs.append(roc_auc_score(y_te, proba))
            fold_briers.append(brier_score_loss(y_te, proba))
        except Exception as e:
            logger.warning("Fold %d failed: %s", fold_i, e)
            continue

    auc_mean = float(np.mean(fold_aucs)) if fold_aucs else None
    auc_std  = float(np.std(fold_aucs))  if fold_aucs else None
    brier_mean = float(np.mean(fold_briers)) if fold_briers else None

    # ── Final fit on all data ─────────────────────────────────────────────────
    final_clf = CalibratedClassifierCV(
        LGBMClassifier(**lgb_params),
        method=cal_method,
        cv=cal_cv,
    )
    final_clf.fit(X, y)

    # ── Save model ────────────────────────────────────────────────────────────
    version = _next_version("score_calibrator")
    trained_at = int(time.time())
    model_path = MODELS_DIR / f"score_calibrator_v{version}.lgb"

    # Write to .tmp then rename (atomic)
    tmp_model = model_path.with_suffix(".lgb.tmp")
    joblib.dump(final_clf, str(tmp_model))
    os.rename(str(tmp_model), str(model_path))

    meta: Dict[str, Any] = {
        "status": training_status,
        "version": version,
        "trained_at": trained_at,
        "n_train": n_train,
        "feature_names": kept_features,
        "medians": medians,
        "dropped_features": dropped_features,
        "auc": auc_mean,          # alias for health endpoint
        "auc_mean": auc_mean,
        "auc_std": auc_std,
        "brier_mean": brier_mean,
        "n_folds_valid": len(fold_aucs),
        "model_path": str(model_path),
        "cal_method": cal_method,
        "cal_cv": cal_cv,
    }
    _write_meta("score_calibrator", version, meta)

    return {
        "status": training_status,
        "version": version,
        "n_train": n_train,
        "auc_mean": auc_mean,
        "auc_std": auc_std,
        "brier_mean": brier_mean,
        "feature_names": kept_features,
        "dropped_features": dropped_features,
        "model_path": str(model_path),
    }


# ─── train_quantile_overlay ───────────────────────────────────────────────────

def train_quantile_overlay() -> Dict[str, Any]:
    """
    Train LightGBM quantile regressors for horizons [5, 15, 30, 60] min.
    Uses spy_1min_history (daily bars) to synthesize intraday features + forward returns.
    Wire 18 Model B implementation via train_quantile_impl.
    """
    try:
        from train_quantile_impl import train_quantile_overlay as _train_impl
        return _train_impl()
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "status": "INSUFFICIENT_DATA",
            "error": str(e),
        }


# ─── train_whale_follow ───────────────────────────────────────────────────────
# ─── train_whale_follow ───────────────────────────────────────────────────────

def train_whale_follow() -> Dict[str, Any]:
    """
    Train a calibrated LightGBM binary classifier for p(follow_through_30min).

    Data: whale_follows JOIN whale_alerts (first alert per OCC by detected_at).
    Uses ALL rows: closing_print_json.mark when available, else current_live_json.mark.
    Label: (close_mark / entry_mark - 1) * (1 if BULLISH else -1) >= 0.003

    Returns INSUFFICIENT_DATA if n_train < 50 or only one class.
    """
    import sqlite3 as _sqlite3
    from lightgbm import LGBMClassifier
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import roc_auc_score, brier_score_loss
    import joblib
    import math

    db_path = Path(__file__).resolve().parent.parent / "data.db"

    # ── Step 1: Load whale_follows ────────────────────────────────────────────
    try:
        conn = _sqlite3.connect(str(db_path))
        df_wf = pd.read_sql_query("SELECT * FROM whale_follows", conn)
        # Earliest alert per OCC (use ORDER BY + groupby)
        df_alerts = pd.read_sql_query(
            "SELECT * FROM whale_alerts ORDER BY detected_at ASC", conn
        )
        conn.close()
    except Exception as e:
        logger.error("whale_follow data load failed: %s", e)
        return {"status": "INSUFFICIENT_DATA", "n_available": 0, "n_required": MIN_ROWS_WHALE_FOLLOW}

    if df_wf.empty:
        return {"status": "INSUFFICIENT_DATA", "n_available": 0, "n_required": MIN_ROWS_WHALE_FOLLOW}

    # First alert per OCC
    first_alerts = df_alerts.groupby("occ", sort=False).first().reset_index()

    # Merge
    merged = df_wf.merge(first_alerts, on="occ", how="left", suffixes=("_wf", "_al"))

    # ── Step 2: Compute labels ────────────────────────────────────────────────
    def _compute_label(row):
        try:
            entry_raw = row["entry_json"]
            entry = json.loads(entry_raw) if isinstance(entry_raw, str) else {}
            entry_mark = float(entry.get("mark") or 0)
            if entry_mark <= 0:
                return None, None

            close_raw = row["closing_print_json"]
            if isinstance(close_raw, str) and close_raw not in ("null", "None", ""):
                close = json.loads(close_raw)
                close_mark = float(close.get("mark") or 0)
            else:
                live_raw = row["current_live_json"]
                live = json.loads(live_raw) if isinstance(live_raw, str) else {}
                close_mark = float(live.get("mark") or 0)

            side_mult = 1.0 if str(row.get("side_wf", row.get("side", ""))).upper() == "BULLISH" else -1.0
            signed_pct = (close_mark / entry_mark - 1.0) * side_mult
            label = int(signed_pct >= 0.003)
            return label, signed_pct
        except Exception:
            return None, None

    labels = []
    signed_pcts = []
    for _, row in merged.iterrows():
        lbl, spct = _compute_label(row)
        labels.append(lbl)
        signed_pcts.append(spct)

    merged["_label"] = labels
    merged["_signed_pct"] = signed_pcts

    # Drop rows where label could not be computed
    merged = merged.dropna(subset=["_label"])
    y = merged["_label"].astype(int).values

    n_train = len(y)
    if n_train < MIN_ROWS_WHALE_FOLLOW:
        return {
            "status": "INSUFFICIENT_DATA",
            "n_available": n_train,
            "n_required": MIN_ROWS_WHALE_FOLLOW,
        }

    if len(np.unique(y)) < 2:
        logger.warning("train_whale_follow: only one class in labels — cannot train")
        return {
            "status": "INSUFFICIENT_DATA",
            "reason": "only_one_class",
            "n_available": n_train,
            "n_required": MIN_ROWS_WHALE_FOLLOW,
        }

    # ── Step 3: Feature engineering ───────────────────────────────────────────
    # Symbol frequency rank for ordinal encoding
    sym_col = "symbol_wf" if "symbol_wf" in merged.columns else "symbol"
    sym_counts = merged[sym_col].value_counts()
    sym_rank: Dict[str, int] = {}
    for rank, sym in enumerate(sym_counts.index[:20]):
        sym_rank[sym] = rank

    feat_rows = []
    timestamps_feat = []

    for _, row in merged.iterrows():
        try:
            entry_raw = row["entry_json"]
            entry = json.loads(entry_raw) if isinstance(entry_raw, str) else {}
        except Exception:
            entry = {}

        # entry_json fields
        entry_mark = float(entry.get("mark") or 0)
        entry_volume = float(entry.get("volume") or 0)
        entry_oi = float(entry.get("openInterest") or 0)
        entry_detected_at = float(entry.get("detectedAt") or 0)  # ms epoch

        # alert fields
        premium_raw = row.get("premium")
        try:
            premium = float(premium_raw) if premium_raw is not None else None
        except Exception:
            premium = None

        vol_oi_raw = row.get("vol_oi_ratio")
        try:
            vol_oi = min(float(vol_oi_raw), 100.0) if vol_oi_raw is not None else None
        except Exception:
            vol_oi = None

        is_new_raw = row.get("is_new_strike")
        try:
            is_new = float(is_new_raw) if is_new_raw is not None else None
        except Exception:
            is_new = None

        delta_raw = row.get("delta")
        try:
            delta = float(delta_raw) if delta_raw is not None else None
            delta_abs = abs(delta) if delta is not None else None
        except Exception:
            delta_abs = None

        dte_raw = row.get("dte")
        try:
            dte = float(dte_raw) if dte_raw is not None else None
        except Exception:
            dte = None

        # Derived
        try:
            premium_log10 = math.log10(max(premium, 1.0)) if premium is not None and premium > 0 else None
        except Exception:
            premium_log10 = None

        type_col = "type_wf" if "type_wf" in row.index else "type"
        is_call = 1.0 if str(row.get(type_col, "")).upper() == "C" or str(row.get(type_col, "")).upper() == "CALL" else 0.0

        side_col = "side_wf" if "side_wf" in row.index else "side"
        side_bullish = 1.0 if str(row.get(side_col, "")).upper() == "BULLISH" else 0.0

        # Time of day from detectedAt
        import datetime as _dt
        try:
            if entry_detected_at > 0:
                ts_sec = entry_detected_at / 1000.0
                dt_et = _dt.datetime.utcfromtimestamp(ts_sec)
                # Approximate ET: UTC-4 (EDT) or UTC-5 (EST); use UTC-4 as default
                dt_et_approx = dt_et - _dt.timedelta(hours=4)
                hour_frac = dt_et_approx.hour + dt_et_approx.minute / 60.0
                # Market open 9:30 ET = 9.5, clamp to 0–15.5
                hour_frac = max(0.0, min(hour_frac, 15.5))
                dow = float(dt_et_approx.weekday())  # 0=Mon
            else:
                hour_frac = None
                dow = None
        except Exception:
            hour_frac = None
            dow = None

        sym = str(row.get(sym_col, ""))
        sym_ord = float(sym_rank.get(sym, 20))  # unknown → 20

        feat = {
            "premium_log10": premium_log10,
            "vol_oi_ratio": vol_oi,
            "is_new_strike": is_new,
            "delta_abs": delta_abs,
            "dte": dte,
            "is_call": is_call,
            "side_bullish": side_bullish,
            "hour_of_day_fired": hour_frac,
            "day_of_week": dow,
            "entry_mark": entry_mark if entry_mark > 0 else None,
            "entry_volume": entry_volume if entry_volume > 0 else None,
            "entry_oi": entry_oi if entry_oi > 0 else None,
            "underlying_symbol_ord": sym_ord,
        }
        feat_rows.append(feat)

        # Timestamp for temporal ordering
        det_at = row.get("detected_at")
        try:
            timestamps_feat.append(float(det_at) if det_at is not None else 0.0)
        except Exception:
            timestamps_feat.append(0.0)

    CANDIDATE_FEATURES = [
        "premium_log10", "vol_oi_ratio", "is_new_strike", "delta_abs",
        "dte", "is_call", "side_bullish", "hour_of_day_fired", "day_of_week",
        "entry_mark", "entry_volume", "entry_oi", "underlying_symbol_ord",
    ]

    X_df, kept_features, dropped_features = _build_feature_matrix(
        feat_rows, CANDIDATE_FEATURES, missing_threshold=0.40
    )

    if dropped_features:
        logger.warning("train_whale_follow: dropped features (>40%% missing): %s", dropped_features)

    # ── Step 4: Temporal sort ─────────────────────────────────────────────────
    order = np.argsort(timestamps_feat)
    feat_rows_sorted = [feat_rows[i] for i in order]
    y_sorted = y[order]

    # Rebuild X in sorted order
    X_df_sorted, _, _ = _build_feature_matrix(feat_rows_sorted, kept_features, missing_threshold=1.0)

    # Fill NaN with medians
    training_medians: Dict[str, float] = {}
    for col in kept_features:
        if col not in X_df_sorted.columns:
            X_df_sorted[col] = 0.0
        med = X_df_sorted[col].median()
        training_medians[col] = float(med) if not np.isnan(med) else 0.0
        X_df_sorted[col] = X_df_sorted[col].fillna(training_medians[col])

    X = X_df_sorted[kept_features].values.astype(np.float32)
    y_final = y_sorted

    # ── Step 5: LightGBM + Platt calibration ─────────────────────────────────
    lgb_params = dict(
        n_estimators=200,
        learning_rate=0.05,
        max_depth=5,
        min_child_samples=8,
        num_leaves=15,
        reg_lambda=1.0,
        class_weight="balanced",
        verbose=-1,
        random_state=42,
    )

    # ── Step 6: TimeSeriesSplit cross-validation (n_splits=4) ─────────────────
    tscv = TimeSeriesSplit(n_splits=4)
    fold_aucs: List[float] = []
    fold_briers: List[float] = []

    for fold_i, (tr_idx, te_idx) in enumerate(tscv.split(X)):
        X_tr, X_te = X[tr_idx], X[te_idx]
        y_tr, y_te = y_final[tr_idx], y_final[te_idx]

        if len(np.unique(y_tr)) < 2 or len(np.unique(y_te)) < 2:
            continue
        try:
            fold_clf = LGBMClassifier(**lgb_params)
            cal_fold = CalibratedClassifierCV(fold_clf, method="sigmoid", cv=3)
            cal_fold.fit(X_tr, y_tr)
            proba = cal_fold.predict_proba(X_te)[:, 1]
            fold_aucs.append(roc_auc_score(y_te, proba))
            fold_briers.append(brier_score_loss(y_te, proba))
        except Exception as fe:
            logger.warning("train_whale_follow fold %d failed: %s", fold_i, fe)

    auc_mean = float(np.mean(fold_aucs)) if fold_aucs else None
    auc_std  = float(np.std(fold_aucs))  if fold_aucs else None
    brier_mean = float(np.mean(fold_briers)) if fold_briers else None
    low_signal = bool(auc_mean is None or auc_mean < 0.55)

    if low_signal:
        logger.warning(
            "train_whale_follow: low_signal=True, auc_mean=%s (n=%d). Publishing anyway.",
            auc_mean, n_train,
        )

    # ── Step 7: Final fit on all data ─────────────────────────────────────────
    final_clf = CalibratedClassifierCV(
        LGBMClassifier(**lgb_params),
        method="sigmoid",
        cv=3,
    )
    final_clf.fit(X, y_final)

    # ── Step 8: Save model ────────────────────────────────────────────────────
    version = _next_version("whale_follow")
    trained_at = int(time.time())
    model_path = MODELS_DIR / f"whale_follow_v{version}.lgb"

    tmp_model = model_path.with_suffix(".lgb.tmp")
    joblib.dump(final_clf, str(tmp_model))
    os.rename(str(tmp_model), str(model_path))

    meta: Dict[str, Any] = {
        "status": "TRAINED" if n_train >= MIN_ROWS_WHALE_FOLLOW else "INSUFFICIENT_DATA",
        "version": version,
        "trained_at": trained_at,
        "n_train": n_train,
        "feature_names": kept_features,
        "training_medians": training_medians,
        "dropped_features": dropped_features,
        "auc_mean": auc_mean,
        "auc_std": auc_std,
        "brier_mean": brier_mean,
        "n_folds_valid": len(fold_aucs),
        "low_signal": low_signal,
        "model_path": str(model_path),
    }
    _write_meta("whale_follow", version, meta)

    return {
        "status": meta["status"],
        "version": version,
        "n_train": n_train,
        "auc_mean": auc_mean,
        "auc_std": auc_std,
        "brier_mean": brier_mean,
        "low_signal": low_signal,
        "feature_names": kept_features,
        "dropped_features": dropped_features,
        "model_path": str(model_path),
    }

