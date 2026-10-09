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


class MorningQuantileRequest(BaseModel):
    features: Dict[str, Optional[float]]
    horizons: List[int] = [30, 60, 120, 180, 240]


class RetrainRequest(BaseModel):
    # score_calibrator is retired (R2-F item 6).
    models: List[str] = ["quantile_overlay", "whale_follow"]


class BackfillRequest(BaseModel):
    sources: List[str] = ["spy_1min", "cboe_gex"]


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
            "whale_follow": _meta("whale_follow"),
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
    try:
        p = registry.predict_whale_follow(req.features)
        meta = registry.get_meta("whale_follow") or {}
        status = meta.get("status", "INSUFFICIENT_DATA")
        version = meta.get("version", 0)
        low_signal = meta.get("low_signal", None)
    except Exception:
        p = None
        status = "INSUFFICIENT_DATA"
        version = 0
        low_signal = None
    return {
        "p_follow_30min": p,
        "status": status,
        "version": version,
        "low_signal": low_signal,
    }


# ─── /quantile/overlay ───────────────────────────────────────────────────────

def _served_quantile(name: str, features: Dict[str, Optional[float]], horizons: List[int], predict) -> Dict[str, Any]:
    """Bands only from a promoted real-data version; otherwise empty bands and NO_PROMOTED_MODEL."""
    try:
        served = registry.promoted_meta(name)
        if served is None:
            latest = registry.get_meta(name) or {}
            return {"bands": {}, "status": "NO_PROMOTED_MODEL", "version": latest.get("version", 0),
                    "training_data": latest.get("training_data"), "promoted": False}
        bands = predict(features, horizons)
        return {"bands": bands, "status": served.get("status", "TRAINED"), "version": served.get("version", 0),
                "training_data": served.get("training_data"), "promoted": True}
    except Exception:
        return {"bands": {}, "status": "INSUFFICIENT_DATA", "version": 0, "training_data": None, "promoted": False}


@app.post("/quantile/overlay")
def quantile_overlay(req: QuantileRequest):
    return _served_quantile("quantile_overlay", req.features, req.horizons, registry.predict_quantile_overlay)


# ─── /quantile/morning — Model D Morning Anchor ───────────────────────

@app.post("/quantile/morning")
def quantile_morning(req: MorningQuantileRequest):
    return _served_quantile("quantile_overlay_morning", req.features, req.horizons, registry.predict_quantile_morning)


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
                r = await asyncio.to_thread(trainer.train_whale_follow)
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


# ─── /backfill ────────────────────────────────────────────────────────────────

@app.post("/backfill")
async def backfill(req: BackfillRequest):
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "running", "type": "backfill", "sources": req.sources, "results": {}}
    asyncio.create_task(_run_backfill(job_id, req.sources))
    return {"started": True, "job_id": job_id}


async def _run_backfill(job_id: str, sources: List[str]):
    results = {}
    for source in sources:
        try:
            # Disabled (user rule 2026-10-08: Schwab only for market data). backfill.py
            # pulls CBOE / Alpha Vantage prices; the quantile trainer no longer reads
            # them (it trains on logged Schwab features and minute bars only).
            if source in ("spy_1min", "cboe_gex"):
                r = {"status": "DISABLED_NON_SCHWAB_SOURCE", "note": "market data must come from Schwab; the real-data logger (server/mlDataLog.ts) replaces this backfill"}
            else:
                r = {"status": "UNKNOWN_SOURCE"}
            results[source] = r
        except Exception as e:
            results[source] = {"status": "ERROR", "error": str(e)}
    _jobs[job_id]["status"] = "done"
    _jobs[job_id]["results"] = results
