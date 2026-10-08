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

STATUS: the trainer that implemented this simulated every training day
(_synthesize_intraday + random dealer levels, review items 9.1/9.2) and is
removed. The served quantile_overlay_morning_v1 file is marked
training_data = "synthetic_gbm" in its meta. A real-data version would build
the fingerprint from spx_minute_bars and the live features from
ml_feature_log (both logged by server/mlDataLog.ts) behind the same
sufficiency gate as train_quantile_impl.train_quantile_overlay; it is not
built yet, so train_quantile_morning() returns a disabled status.

Output: quantile_overlay_morning_vN.lgb + _meta.json
Inference: predictor.predict_quantile_morning(features, horizons)
Blend: weighted average with v3 quantile_overlay; weight ramps from 0 pre-9:45
to ~0.7 by 10:30, decays through close.
"""
from __future__ import annotations

from typing import Any, Dict

HORIZONS = [30, 60, 120, 180, 240]
QUANTILES = [0.10, 0.25, 0.50, 0.75, 0.90]


def train_quantile_morning() -> Dict[str, Any]:
    """Disabled: the only implementation trained on simulated bars. Never writes a model."""
    return {
        "status": "DISABLED_SYNTHETIC",
        "note": "synthetic morning-anchor training removed; a real-data trainer on ml_feature_log + spx_minute_bars is not built yet",
    }


if __name__ == "__main__":
    import json
    print(json.dumps(train_quantile_morning(), indent=2))
