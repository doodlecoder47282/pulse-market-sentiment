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
import backfill as _backfill_mod

app = FastAPI(title="Pulse Batcave ML Service", version="0.1.0")
registry = ModelRegistry()

# ─── In-memory retrain job tracker ───────────────────────────────────────────
_jobs: Dict[str, Dict[str, Any]] = {}


# ─── Request / response models ───────────────────────────────────────────────

class FeaturesRequest(BaseModel):
    features: Dict[str, float]


class QuantileRequest(BaseModel):
    features: Dict[str, float]
    horizons: List[int] = [5, 15, 30, 60]


class MorningQuantileRequest(BaseModel):
    features: Dict[str, float]
    horizons: List[int] = [30, 60, 120, 180, 240]


class RetrainRequest(BaseModel):
    models: List[str] = ["score_calibrator", "quantile_overlay", "whale_follow"]


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
            }
        return {"status": "INSUFFICIENT_DATA", "version": 0, "trained_at": None, "n_train": 0, "auc": None, "low_signal": None}

    return {
        "status": "ok",
        "models": {
            "score_calibrator": _meta("score_calibrator"),
            "quantile_overlay": _meta("quantile_overlay"),
            "whale_follow": _meta("whale_follow"),
        },
    }


# ─── /score/odte ─────────────────────────────────────────────────────────────

@app.post("/score/odte")
def score_odte(req: FeaturesRequest):
    try:
        p = registry.predict_score_calibrator(req.features)
        meta = registry.get_meta("score_calibrator") or {}
        status = meta.get("status", "INSUFFICIENT_DATA")
        version = meta.get("version", 0)
    except Exception:
        p = None
        status = "INSUFFICIENT_DATA"
        version = 0
    return {"p_hit_t1": p, "status": status, "version": version}


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

@app.post("/quantile/overlay")
def quantile_overlay(req: QuantileRequest):
    try:
        bands = registry.predict_quantile_overlay(req.features, req.horizons)
        meta = registry.get_meta("quantile_overlay") or {}
        status = meta.get("status", "INSUFFICIENT_DATA")
        version = meta.get("version", 0)
    except Exception:
        bands = {}
        status = "INSUFFICIENT_DATA"
        version = 0
    return {"bands": bands, "status": status, "version": version}


# ─── /quantile/morning — Model D Morning Anchor ───────────────────────

@app.post("/quantile/morning")
def quantile_morning(req: MorningQuantileRequest):
    try:
        bands = registry.predict_quantile_morning(req.features, req.horizons)
        meta = registry.get_meta("quantile_overlay_morning") or {}
        status = meta.get("status", "INSUFFICIENT_DATA")
        version = meta.get("version", 0)
    except Exception:
        bands = {}
        status = "INSUFFICIENT_DATA"
        version = 0
    return {"bands": bands, "status": status, "version": version}


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
                r = await asyncio.to_thread(trainer.train_score_calibrator)
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
            if source == "spy_1min":
                r = await asyncio.to_thread(_backfill_mod.backfill_spy_1min)
            elif source == "cboe_gex":
                r = await asyncio.to_thread(_backfill_mod.backfill_cboe_gex_history)
            else:
                r = {"status": "UNKNOWN_SOURCE"}
            results[source] = r
        except Exception as e:
            results[source] = {"status": "ERROR", "error": str(e)}
    _jobs[job_id]["status"] = "done"
    _jobs[job_id]["results"] = results
