"""
Pulse Batcave — ML Service (Wire 20)
FastAPI on port 5001. ML augments — never blocks.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from predictor import ModelRegistry

app = FastAPI(title="Pulse Batcave ML Service", version="0.1.0")
registry = ModelRegistry()

# ─── In-memory retrain job tracker ───────────────────────────────────────────
_jobs: Dict[str, Dict[str, Any]] = {}


# ─── Request / response models ───────────────────────────────────────────────

# Feature values may be null: the server sends a missing input as JSON null
# (it has no NaN), and the predictor turns it into NaN for the model (R2-F 2).
class FeaturesRequest(BaseModel):
    features: Dict[str, Optional[float]]


class QuantileRequest(BaseModel):
    features: Dict[str, Optional[float]]
    horizons: List[int] = [5, 15, 30, 60]
    # Feature schema of `features` (server ML_FEATURE_SCHEMA_VERSION); a model
    # trained on another schema is not served. None = the current schema.
    schema_version: Optional[int] = None


class MorningQuantileRequest(BaseModel):
    features: Dict[str, Optional[float]]
    horizons: List[int] = [30, 60, 120, 180, 240]
    schema_version: Optional[int] = None


class DemoteRequest(BaseModel):
    model: str
    version: int
    reason: str


class RetrainRequest(BaseModel):
    # score_calibrator (R2-F item 6) and whale_follow (round 3) are retired.
    models: List[str] = ["quantile_overlay"]


class BackfillRequest(BaseModel):
    # The CBOE / Alpha Vantage backfill is removed (Schwab only); kept so old
    # clients get a clear answer.
    sources: List[str] = []


# ─── /health ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    def _meta(name: str) -> Dict[str, Any]:
        m = registry.get_meta(name)
        if m:
            return {
                "status": m.get("status", "TRAINED"),
                "version": m.get("version", 1),
                "trained_at": m.get("trained_at"),
                "n_train": m.get("n_train"),
                "auc": m.get("auc_mean", m.get("auc")),
                "low_signal": m.get("low_signal"),
                # "real" | "synthetic_gbm" | None (not recorded)
                "training_data": m.get("training_data"),
            }
        return {"status": "INSUFFICIENT_DATA", "version": 0, "trained_at": None, "n_train": 0, "auc": None, "low_signal": None, "training_data": None}

    return {
        "status": "ok",
        "models": {
            "score_calibrator": {"status": "RETIRED", "version": 0, "trained_at": None, "n_train": 0, "auc": None,
                                 "low_signal": None, "training_data": None,
                                 "note": "retired: no consumer; pooled whale and regime labels; 80-row gate"},
            "quantile_overlay": _quantile_health("quantile_overlay"),
            "quantile_overlay_morning": _quantile_health("quantile_overlay_morning"),
            "whale_follow": {"status": "RETIRED", "version": 0, "trained_at": None, "n_train": 0, "auc": None,
                             "low_signal": None, "training_data": None,
                             "note": "retired: no consumer (server mlWhaleFollow is never called); whale outcomes are graded by the deterministic tracker"},
        },
    }


def _quantile_health(name: str) -> Dict[str, Any]:
    """Served (promoted) version if any, plus the latest trained version and why it is or is not served."""
    latest = registry.get_meta(name) or {}
    served = registry.promoted_meta(name)
    m = served or latest
    return {
        "status": (m.get("status", "TRAINED") if served else ("NO_PROMOTED_MODEL" if latest else "INSUFFICIENT_DATA")),
        "version": m.get("version", 0),
        "trained_at": m.get("trained_at"),
        "n_train": m.get("n_train"),
        "auc": None,
        "low_signal": None,
        "training_data": m.get("training_data"),
        "promoted": served is not None,
        "served_version": served.get("version") if served else None,
        "latest_version": latest.get("version"),
        "latest_status": latest.get("status"),
        "latest_training_data": latest.get("training_data"),
        "latest_promotion": (latest.get("promotion") or {}).get("rule") if latest else None,
        "latest_promoted": latest.get("promoted") is True,
    }


# ─── /score/odte ─────────────────────────────────────────────────────────────

@app.post("/score/odte")
def score_odte(req: FeaturesRequest):
    # Retired (R2-F item 6): no consumer; never a probability.
    return {"p_hit_t1": None, "status": "RETIRED", "version": 0}


# ─── /score/whale_follow ─────────────────────────────────────────────────────

@app.post("/score/whale_follow")
def score_whale_follow(req: FeaturesRequest):
    # Retired (round 3, like the score calibrator): no consumer; never a probability.
    return {"p_follow_30min": None, "status": "RETIRED", "version": 0, "low_signal": None}


# ─── /quantile/overlay ───────────────────────────────────────────────────────

def _served_quantile(name: str, features: Dict[str, Optional[float]], horizons: List[int], predict,
                     schema_version: Optional[int] = None) -> Dict[str, Any]:
    """Bands only from a promoted real-data version of the request's feature schema; otherwise empty bands."""
    try:
        served = registry.promoted_meta(name, schema_version)
        if served is None:
            latest = registry.get_meta(name) or {}
            return {"bands": {}, "status": "NO_PROMOTED_MODEL", "version": latest.get("version", 0),
                    "training_data": latest.get("training_data"), "promoted": False}
        bands = predict(features, horizons, schema_version)
        return {"bands": bands, "status": served.get("status", "TRAINED"), "version": served.get("version", 0),
                "training_data": served.get("training_data"), "promoted": True}
    except Exception:
        return {"bands": {}, "status": "INSUFFICIENT_DATA", "version": 0, "training_data": None, "promoted": False}


@app.post("/quantile/overlay")
def quantile_overlay(req: QuantileRequest):
    return _served_quantile("quantile_overlay", req.features, req.horizons, registry.predict_quantile_overlay, req.schema_version)


# ─── /quantile/morning — Model D Morning Anchor ───────────────────────

@app.post("/quantile/morning")
def quantile_morning(req: MorningQuantileRequest):
    return _served_quantile("quantile_overlay_morning", req.features, req.horizons, registry.predict_quantile_morning, req.schema_version)


# ─── /demote: live-coverage demotion from the server (R2-F) ──────────────────

@app.post("/demote")
def demote(req: DemoteRequest):
    """The server demotes a model whose live 10-90% coverage is rejected (Kupiec p < 0.01 on >= 20 days)."""
    if req.model not in ("quantile_overlay", "quantile_overlay_morning"):
        raise HTTPException(status_code=400, detail="unknown model")
    import train_quantile_impl
    ok = train_quantile_impl.demote_version(req.model, req.version, req.reason)
    registry.reload(req.model)
    return {"demoted": ok, "model": req.model, "version": req.version}


# ─── /retrain ────────────────────────────────────────────────────────────────

@app.post("/retrain")
async def retrain(req: RetrainRequest):
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "running", "started_at": asyncio.get_event_loop().time(), "models": req.models, "results": {}}
    asyncio.create_task(_run_retrain(job_id, req.models))
    return {"started": True, "job_id": job_id}


async def _run_retrain(job_id: str, models: List[str]):
    import trainer
    results = {}
    for name in models:
        try:
            if name == "score_calibrator":
                r = {"status": "RETIRED", "note": "score calibrator retired (R2-F item 6)"}
            elif name == "quantile_overlay":
                r = await asyncio.to_thread(trainer.train_quantile_overlay)
            elif name == "whale_follow":
                r = {"status": "RETIRED", "note": "whale_follow retired (round 3): no consumer"}
            else:
                r = {"status": "UNKNOWN_MODEL"}
            results[name] = r
            # Reload registry after each model trains
            registry.reload(name)
        except Exception as e:
            results[name] = {"status": "ERROR", "error": str(e)}
    _jobs[job_id]["status"] = "done"
    _jobs[job_id]["results"] = results


# ─── /retrain/status/:job_id ─────────────────────────────────────────────────

@app.get("/retrain/status/{job_id}")
def retrain_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


# ─── /backfill (removed) ──────────────────────────────────────────────────────
# The CBOE / Alpha Vantage backfill (backfill.py) is removed: market data is
# Schwab only, and the server's real-data logger (server/mlDataLog.ts) stores
# Schwab $SPX minute bars and the live feature dicts the trainer uses.

@app.post("/backfill")
async def backfill(req: BackfillRequest):
    return {"started": False, "status": "REMOVED",
            "note": "non-Schwab backfill removed; the server logs Schwab $SPX minute bars (server/mlDataLog.ts)"}
