"""
Pulse Batcave — Model Predictor (Wire 17)
ModelRegistry caches loaded models, watches mtime, reloads on file change.
All predictions return None on any error (ML never blocks).

score_calibrator: CalibratedClassifierCV (sklearn/joblib) wrapping LGBMClassifier.
Other models: lgb.Booster (native format).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

MODELS_DIR = Path(__file__).resolve().parent / "models"


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
        """
        Returns float probability p(hit_t1) or None on any failure.
        Uses sklearn CalibratedClassifierCV (joblib format).
        Feature alignment: fill missing with stored medians from training.
        """
        try:
            entry = self._maybe_load_sklearn("score_calibrator")
            if entry is None:
                return None
            meta = entry.meta
            feature_names: List[str] = meta.get("feature_names", [])
            if not feature_names:
                return None

            medians: Dict[str, float] = meta.get("medians", {})

            import numpy as np
            # Build feature vector: use input value if present, else training median, else 0
            x_row = []
            for f in feature_names:
                if f in features and features[f] is not None:
                    x_row.append(float(features[f]))
                else:
                    x_row.append(float(medians.get(f, 0.0)))

            x = np.array([x_row], dtype=np.float32)
            proba = entry.model.predict_proba(x)
            return float(proba[0, 1])
        except Exception:
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

    def _maybe_load_joblib_dict(self, name: str) -> Optional[_CachedModel]:
        """Load a joblib dict of {(horizon, quantile): LGBMRegressor} model file."""
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
            import joblib
            model = joblib.load(str(path))
            if not isinstance(model, dict):
                raise ValueError("Not a dict model")
        except Exception:
            self._cache[name] = None
            return None
        meta = self._load_meta(name)
        entry = _CachedModel(model=model, mtime=mtime, meta=meta)
        self._cache[name] = entry
        return entry

    def predict_quantile_overlay(
        self,
        features: Dict[str, float],
        horizons: List[int],
    ) -> Dict[str, Dict[str, Optional[float]]]:
        """
        Returns { "5": {q10, q25, q50, q75, q90}, "15": {...}, ... }.
        Model is a joblib dict keyed by (horizon, quantile) -> LGBMRegressor.
        Quantile crossing fix: sort 5 values ascending before returning.
        Returns empty dict on any failure.
        """
        try:
            import numpy as np

            entry = self._maybe_load_joblib_dict("quantile_overlay")
            if entry is None:
                return {}
            meta = entry.meta
            feature_names: List[str] = meta.get("feature_names", [])
            training_medians: Dict[str, float] = meta.get("training_medians", {})

            if not feature_names or not isinstance(entry.model, dict):
                return {}

            # Build feature vector: reorder/fill missing with training_medians
            x_vals = []
            for f in feature_names:
                val = features.get(f)
                if val is None or (isinstance(val, float) and val != val):  # NaN check
                    val = float(training_medians.get(f, 0.0))
                x_vals.append(float(val))
            x = np.array([x_vals], dtype=np.float32)

            QUANTILE_KEYS = [0.10, 0.25, 0.50, 0.75, 0.90]
            Q_NAMES = ["q10", "q25", "q50", "q75", "q90"]

            bands: Dict[str, Any] = {}
            for h in horizons:
                raw_preds = []
                for q in QUANTILE_KEYS:
                    model = entry.model.get((h, q))
                    if model is None:
                        raw_preds.append(0.0)
                    else:
                        pred = float(model.predict(x)[0])
                        raw_preds.append(pred)
                # Quantile crossing fix: sort ascending
                sorted_preds = sorted(raw_preds)
                bands[str(h)] = {name: round(val, 8) for name, val in zip(Q_NAMES, sorted_preds)}

            return bands
        except Exception:
            return {}


# ─── Module-level convenience functions ───────────────────────────────────────
_default_registry = ModelRegistry()


def predict_score_calibrator(features: Dict[str, float]) -> Optional[float]:
    return _default_registry.predict_score_calibrator(features)


def predict_quantile_overlay(
    features: Dict[str, float],
    horizons: List[int],
) -> Dict[str, Dict[str, Optional[float]]]:
    return _default_registry.predict_quantile_overlay(features, horizons)


def predict_whale_follow(features: Dict[str, float]) -> Optional[float]:
    return _default_registry.predict_whale_follow(features)
