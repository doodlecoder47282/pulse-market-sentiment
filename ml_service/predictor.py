"""
Pulse Batcave — Model Predictor (Wire 17)
ModelRegistry caches loaded models, watches mtime, reloads on file change.
All predictions return None on any error (ML never blocks).

score_calibrator: RETIRED (R2-F item 6). It had no consumer (mlScoreOdte is
never called), pooled whale and regime rows and was gated at 80 rows; it is no
longer trained or served.

Quantile models (quantile_overlay, quantile_overlay_morning), R2-F items 2/3/5:
  - Served version = the highest version whose meta says promoted = true AND
    training_data = "real" (it passed the walk-forward promotion gate against
    the baseline volatility cone, forecast_eval.py). Unpromoted or synthetic
    versions (v1-v4, morning v1) are never served; the server then draws the
    baseline cone, labeled.
  - Missing features: models trained with missing_policy = "native_nan" get
    NaN for a missing or null feature, exactly as in training (LightGBM routes
    NaN natively); they are never filled with medians or 0.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

MODELS_DIR = Path(__file__).resolve().parent / "models"
# Feature schema the live server sends (server/mlFeatureMath.ts ML_FEATURE_SCHEMA_VERSION);
# kept equal to train_quantile_impl.FEATURE_SCHEMA_VERSION (tested).
CURRENT_FEATURE_SCHEMA = 2


class _CachedModel:
    __slots__ = ("model", "mtime", "meta")

    def __init__(self, model: Any, mtime: float, meta: Dict[str, Any]):
        self.model = model
        self.mtime = mtime
        self.meta = meta


class ModelRegistry:
    """
    Loads models on demand, caches them, reloads when file mtime changes.
    All methods are safe — return None / empty dict on any failure.
    """

    def __init__(self):
        self._cache: Dict[str, Optional[_CachedModel]] = {}

    # ─── Internal helpers ─────────────────────────────────────────────────────

    def _latest_model_path(self, name: str) -> Optional[Path]:
        """Return the highest-versioned .lgb file for a given model name."""
        candidates = list(MODELS_DIR.glob(f"{name}_v*.lgb"))
        if not candidates:
            return None
        def _ver(p: Path) -> int:
            try:
                return int(p.stem.split("_v")[1])
            except (IndexError, ValueError):
                return 0
        candidates.sort(key=_ver, reverse=True)
        return candidates[0]

    def _latest_meta_path(self, name: str) -> Optional[Path]:
        """Return the highest-versioned _meta.json file for a given model name."""
        candidates = list(MODELS_DIR.glob(f"{name}_v*_meta.json"))
        if not candidates:
            return None
        def _ver(p: Path) -> int:
            try:
                return int(p.stem.split("_v")[1].split("_meta")[0])
            except (IndexError, ValueError):
                return 0
        candidates.sort(key=_ver, reverse=True)
        return candidates[0]

    def _load_meta(self, name: str) -> Dict[str, Any]:
        path = self._latest_meta_path(name)
        if path is None or not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _maybe_load_sklearn(self, name: str) -> Optional[_CachedModel]:
        """Load a joblib-serialized sklearn model (CalibratedClassifierCV wrapper)."""
        path = self._latest_model_path(name)
        if path is None or not path.exists():
            self._cache[name] = None
            return None

        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None

        cached = self._cache.get(name)
        if cached is not None and cached.mtime == mtime:
            return cached

        # Load (or reload)
        try:
            import joblib
            model = joblib.load(str(path))
            # Verify it has predict_proba (sklearn interface)
            if not hasattr(model, "predict_proba"):
                raise ValueError("Not a sklearn classifier")
        except Exception:
            # Fall back: placeholder or corrupted
            self._cache[name] = None
            return None

        meta = self._load_meta(name)
        entry = _CachedModel(model=model, mtime=mtime, meta=meta)
        self._cache[name] = entry
        return entry

    def _maybe_load_lgb(self, name: str) -> Optional[_CachedModel]:
        """Load a native LightGBM booster file."""
        path = self._latest_model_path(name)
        if path is None or not path.exists():
            self._cache[name] = None
            return None

        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None

        cached = self._cache.get(name)
        if cached is not None and cached.mtime == mtime:
            return cached

        try:
            import lightgbm as lgb
            model = lgb.Booster(model_file=str(path))
        except Exception:
            self._cache[name] = None
            return None

        meta = self._load_meta(name)
        entry = _CachedModel(model=model, mtime=mtime, meta=meta)
        self._cache[name] = entry
        return entry

    def reload(self, name: str) -> None:
        """Force evict cache entry so next access reloads from disk."""
        self._cache.pop(name, None)

    # ─── Public: metadata ────────────────────────────────────────────────────

    def get_meta(self, name: str) -> Dict[str, Any]:
        """Return meta dict for a model (from _meta.json). Empty dict if missing."""
        return self._load_meta(name)

    # ─── Public: predictions ─────────────────────────────────────────────────

    def predict_score_calibrator(self, features: Dict[str, float]) -> Optional[float]:
        """Retired (R2-F item 6): no consumer, pooled whale + regime labels, 80-row gate. Always None."""
        return None

    def predict_whale_follow(self, features: Dict[str, float]) -> Optional[float]:
        """
        Returns float probability p(follow_30min) or None on any failure.
        Uses sklearn CalibratedClassifierCV (joblib format).
        Feature alignment: fill missing with training_medians from meta.
        """
        try:
            entry = self._maybe_load_sklearn("whale_follow")
            if entry is None:
                return None
            meta = entry.meta
            feature_names: List[str] = meta.get("feature_names", [])
            if not feature_names:
                return None

            training_medians: Dict[str, float] = meta.get("training_medians", {})

            import numpy as np
            x_row = []
            for f in feature_names:
                if f in features and features[f] is not None:
                    x_row.append(float(features[f]))
                else:
                    x_row.append(float(training_medians.get(f, 0.0)))

            x = np.array([x_row], dtype=np.float32)
            proba = entry.model.predict_proba(x)
            return float(proba[0, 1])
        except Exception:
            return None

    # ─── Quantile models: promoted-only serving ──────────────────────────────

    def promoted_meta(self, name: str, schema_version: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """
        Meta of the highest promoted real-data version of `name` whose model
        file exists AND whose feature_schema_version equals `schema_version`
        (default: the trainer's current FEATURE_SCHEMA_VERSION), else None. A
        model trained on another feature schema is never fed this dict.
        """
        want = int(schema_version) if schema_version is not None else CURRENT_FEATURE_SCHEMA
        best = None
        for p in MODELS_DIR.glob(f"{name}_v*_meta.json"):
            try:
                v = int(p.stem.split("_v")[1].split("_meta")[0])
                m = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if m.get("promoted") is not True or m.get("training_data") != "real":
                continue
            if m.get("feature_schema_version") != want:
                continue
            if not (MODELS_DIR / f"{name}_v{v}.lgb").exists():
                continue
            if best is None or v > best[0]:
                best = (v, m)
        if best is None:
            return None
        meta = dict(best[1])
        meta["version"] = best[0]
        return meta

    def _load_joblib_version(self, name: str, version: int, meta: Dict[str, Any]) -> Optional[_CachedModel]:
        """Load one specific version of a joblib dict {(horizon, quantile): regressor}."""
        path = MODELS_DIR / f"{name}_v{version}.lgb"
        key = f"{name}@v{version}"
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
        cached = self._cache.get(key)
        if cached is not None and cached.mtime == mtime:
            return cached
        try:
            import joblib
            model = joblib.load(str(path))
            if not isinstance(model, dict):
                raise ValueError("Not a dict model")
        except Exception:
            self._cache[key] = None
            return None
        entry = _CachedModel(model=model, mtime=mtime, meta=meta)
        self._cache[key] = entry
        return entry

    def predict_quantile_overlay(
        self,
        features: Dict[str, Optional[float]],
        horizons: List[int],
        schema_version: Optional[int] = None,
    ) -> Dict[str, Dict[str, Optional[float]]]:
        return self._predict_quantile_named("quantile_overlay", features, horizons, schema_version)

    def predict_quantile_morning(
        self,
        features: Dict[str, Optional[float]],
        horizons: List[int],
        schema_version: Optional[int] = None,
    ) -> Dict[str, Dict[str, Optional[float]]]:
        """Morning Anchor (Model D). Same contract; served only if promoted on real data."""
        return self._predict_quantile_named("quantile_overlay_morning", features, horizons, schema_version)

    def _predict_quantile_named(
        self,
        model_name: str,
        features: Dict[str, Optional[float]],
        horizons: List[int],
        schema_version: Optional[int] = None,
    ) -> Dict[str, Dict[str, Optional[float]]]:
        """
        Returns { "5": {q10, q25, q50, q75, q90}, ... } from the promoted
        version, or {} when no version is promoted (or on any failure).
        Quantile crossing fix: the five values are sorted ascending.
        """
        try:
            meta = self.promoted_meta(model_name, schema_version)
            if meta is None:
                return {}
            entry = self._load_joblib_version(model_name, int(meta["version"]), meta)
            if entry is None or not isinstance(entry.model, dict):
                return {}
            feature_names: List[str] = meta.get("feature_names", [])
            if not feature_names:
                return {}
            x = feature_vector(features, feature_names, meta)

            QUANTILE_KEYS = [0.10, 0.25, 0.50, 0.75, 0.90]
            Q_NAMES = ["q10", "q25", "q50", "q75", "q90"]
            bands: Dict[str, Any] = {}
            for h in horizons:
                raw_preds = []
                for q in QUANTILE_KEYS:
                    model = entry.model.get((h, q))
                    if model is None:
                        raw_preds = []
                        break  # a horizon the model was not trained for is not served
                    raw_preds.append(float(model.predict(x)[0]))
                if not raw_preds:
                    continue
                sorted_preds = sorted(raw_preds)
                bands[str(h)] = {name: round(val, 8) for name, val in zip(Q_NAMES, sorted_preds)}
            return bands
        except Exception:
            return {}


def feature_vector(features: Dict[str, Optional[float]], feature_names: List[str], meta: Dict[str, Any]):
    """
    (1, n) float array in training column order. missing_policy "native_nan"
    (every real-data model): missing / null / non-finite -> NaN, as in
    training. Legacy metas without it: training median (old behavior).
    """
    import numpy as np
    native = meta.get("missing_policy") == "native_nan"
    medians: Dict[str, Any] = meta.get("training_medians", {}) or {}
    row = []
    for f in feature_names:
        v = features.get(f)
        try:
            v = float(v) if v is not None else float("nan")
        except (TypeError, ValueError):
            v = float("nan")
        if v != v or v in (float("inf"), float("-inf")):
            v = float("nan") if native else float(medians.get(f) or 0.0)
        row.append(v)
    return np.array([row], dtype=np.float32)


# ─── Module-level convenience functions ───────────────────────────────────────
_default_registry = ModelRegistry()


def predict_score_calibrator(features: Dict[str, float]) -> Optional[float]:
    return _default_registry.predict_score_calibrator(features)


def predict_quantile_overlay(
    features: Dict[str, float],
    horizons: List[int],
) -> Dict[str, Dict[str, Optional[float]]]:
    return _default_registry.predict_quantile_overlay(features, horizons)


def predict_quantile_morning(
    features: Dict[str, float],
    horizons: List[int],
) -> Dict[str, Dict[str, Optional[float]]]:
    return _default_registry.predict_quantile_morning(features, horizons)


def predict_whale_follow(features: Dict[str, float]) -> Optional[float]:
    return _default_registry.predict_whale_follow(features)
