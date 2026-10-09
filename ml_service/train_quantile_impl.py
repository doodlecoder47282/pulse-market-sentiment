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

Feature schema (R2-F item 1): only ml_feature_log rows with schema_version ==
FEATURE_SCHEMA_VERSION are used. Schema-1 rows (logged before the column
existed) measured CBOE SPY-point dealer levels against SPX spot and are never
trained on. Missing cells (JSON null / listed in missing_json) stay NaN, and
the meta records missing_policy = "native_nan" so the predictor passes NaN at
serve time exactly as in training (LightGBM docs, Missing Value Handle:
https://lightgbm.readthedocs.io/en/stable/Advanced-Topics.html).

Promotion gate (R2-F item 3, forecast_eval.py): the same walk-forward folds
score the model against the baseline volatility cone; the model file is
always written for audit, but meta.promoted is true only if every horizon
passes (pinball margin, Diebold-Mariano, coverage). The predictor serves only
promoted real-data models; otherwise the server draws the baseline cone. The
baseline's fitted standardized quantiles are written to
baseline_cone_meta.json for the server.
"""
from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

import forecast_eval as fe

logger = logging.getLogger("ml.quantile_overlay")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"
FEATURE_SCHEMA_VERSION = 2
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
    "net_gex_sign", "net_gex_magnitude", "rv_session_5m",
]

LGBM_PARAMS = dict(
    n_estimators=300, learning_rate=0.05, max_depth=5, min_child_samples=50,
    num_leaves=24, reg_lambda=1.0, n_jobs=-1, verbose=-1,
)


# ─── Data ────────────────────────────────────────────────────────────────────

def _et_day(ms: np.ndarray) -> np.ndarray:
    """ET calendar date per epoch-ms timestamp (same as forecast_eval._et_day_minute)."""
    return fe._et_day_minute(np.asarray(ms, dtype=np.int64))[0]


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


def build_frame(conn: sqlite3.Connection, schema_version: int = FEATURE_SCHEMA_VERSION) -> pd.DataFrame:
    """Feature rows of ONE schema version from ml_feature_log with real forward-return labels from spx_minute_bars."""
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(ml_feature_log)").fetchall()}
        if "schema_version" not in cols:
            logger.info("ml_feature_log has no schema_version column: every row is schema 1, none usable")
            return pd.DataFrame()
        feats = pd.read_sql_query("SELECT ts, features_json, missing_json FROM ml_feature_log WHERE schema_version = ? ORDER BY ts",
                                  conn, params=(int(schema_version),))
        bars = read_minute_bars(conn)
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
        # Baseline-cone inputs, kept even if the model drops the feature.
        for src, dst in (("rv_session_5m", "_base_rv"), ("vix_level", "_base_vix"), ("hour_of_day", "_base_hour")):
            v = f.get(src)
            row[dst] = np.nan if (src in missing or v is None) else float(v)
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


def bars_for_periodicity(conn: sqlite3.Connection) -> Dict[str, np.ndarray]:
    """1-minute bars (t, open, close, ET day) for the baseline's intraday periodicity profile (fitted per fold)."""
    b = read_minute_bars(conn)
    t = b["t"].to_numpy(dtype=np.int64)
    return {"t": t, "open": b["open"].to_numpy(dtype=float), "close": b["close"].to_numpy(dtype=float), "day": _et_day(t)}


def read_minute_bars(conn: sqlite3.Connection) -> pd.DataFrame:
    """
    spx_minute_bars in either layout: canonical (t, open, high, low, close,
    volume, source; mlDataLog / R2-D's spxMinuteBars.ts) or the legacy
    hazardEngine one (ts, date, mod, o, h, l, c, v). Returns t, open, close.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(spx_minute_bars)").fetchall()}
    if {"t", "open", "close"} <= cols:
        return pd.read_sql_query("SELECT t, open, close FROM spx_minute_bars ORDER BY t", conn)
    if {"ts", "o", "c"} <= cols:
        return pd.read_sql_query("SELECT ts AS t, o AS open, c AS close FROM spx_minute_bars ORDER BY ts", conn)
    raise RuntimeError("spx_minute_bars has an unknown layout")


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

def _lgbm_factory(alpha: float):
    from lightgbm import LGBMRegressor  # imported here so the gate and tests run without lightgbm
    return LGBMRegressor(objective="quantile", alpha=alpha, **LGBM_PARAMS)


def _atomic_json(path: Path, obj: Dict[str, Any]) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, default=str), encoding="utf-8")
    os.rename(str(tmp), str(path))


def _active_features(frame: pd.DataFrame) -> Tuple[List[str], List[str]]:
    """Features with at most MISSING_THRESH missing cells in `frame` (a training set)."""
    active, dropped = [], []
    for f in FEATURE_NAMES:
        (dropped if frame[f].isna().mean() > MISSING_THRESH else active).append(f)
    return active, dropped


def _promoted_incumbent(out_dir: Path) -> Optional[Tuple[int, Dict[str, Any]]]:
    """Highest promoted real-data quantile_overlay version of the current feature schema, with its meta."""
    best = None
    for p in out_dir.glob("quantile_overlay_v*_meta.json"):
        try:
            v = int(p.stem.split("_v")[1].split("_meta")[0])
            m = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if m.get("promoted") is not True or m.get("training_data") != "real":
            continue
        if m.get("feature_schema_version") != FEATURE_SCHEMA_VERSION or not (out_dir / f"quantile_overlay_v{v}.lgb").exists():
            continue
        if best is None or v > best[0]:
            best = (v, m)
    return best


def demote_version(name: str, version: int, reason: str, models_dir: Optional[Path] = None) -> bool:
    """Marks a model version not promoted (status DEMOTED) with the reason; the predictor stops serving it."""
    out_dir = Path(models_dir) if models_dir else MODELS_DIR
    path = out_dir / f"{name}_v{int(version)}_meta.json"
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    meta["promoted"] = False
    meta["status"] = "DEMOTED"
    meta["demoted"] = {"at": int(time.time()), "reason": reason}
    _atomic_json(path, meta)
    return True


def _qmatrix(models: Dict[Tuple[int, float], Any], h: int, X: np.ndarray) -> Optional[np.ndarray]:
    cols = []
    for q in QUANTILES:
        m = models.get((h, q))
        if m is None:
            return None
        cols.append(m.predict(X))
    return np.sort(np.column_stack(cols), axis=1)


def train_quantile_overlay(db_path: Optional[Path] = None, make_regressor=None, models_dir: Optional[Path] = None) -> Dict[str, Any]:
    """
    Train on real logged data only (schema-v2 feature rows). Writes nothing
    below the sufficiency gate. `make_regressor(alpha)` builds one quantile
    regressor (default LightGBM; tests inject another NaN-native learner).

    Per walk-forward fold, everything is fitted on that fold's training days
    only: the feature set (missing-share rule), the model, the baseline's
    intraday periodicity profile and its standardized quantiles. Then the
    candidate is gated against the baseline, and the current promoted model
    (the incumbent) is re-scored on the out-of-sample days after its own
    training window: it is demoted if it now fails the same rule, and a
    passing candidate replaces it only if its pinball loss on those days is
    lower (otherwise the incumbent is kept).
    """
    t0 = time.time()
    path = Path(db_path) if db_path else DB_PATH
    out_dir = Path(models_dir) if models_dir else MODELS_DIR
    out_dir.mkdir(exist_ok=True)
    try:
        with closing(sqlite3.connect(str(path))) as conn:
            df = build_frame(conn)
            bars = bars_for_periodicity(conn) if not df.empty else None
    except Exception as e:
        return {"status": "INSUFFICIENT_REAL_DATA", "error": str(e)}

    gate = data_sufficiency(df)
    if not gate["sufficient"]:
        logger.info("real-data gate not met: %s", gate)
        return {"status": "INSUFFICIENT_REAL_DATA", "gate": gate,
                "note": "no synthetic fallback: the model is trained only on logged live features (schema v2) and real SPX minute bars"}

    factory = make_regressor or _lgbm_factory
    import joblib

    lab = df.dropna(subset=[f"ret_{h}" for h in HORIZONS]).sort_values("ts").reset_index(drop=True)
    days = lab["day"].to_numpy()
    rv, vix, hour = (lab[c].to_numpy(dtype=float) for c in ("_base_rv", "_base_vix", "_base_hour"))
    folds = walk_forward_day_folds(list(days))

    fold_info = []
    for train_days, test_days in folds:
        tr = np.isin(days, train_days)
        te = np.isin(days, test_days)
        act, _ = _active_features(lab.loc[tr])
        bm = np.isin(bars["day"], train_days)
        prof = fe.periodicity_profile(bars["t"][bm], bars["open"][bm], bars["close"][bm])
        fold_info.append((tr, te, act, prof["f"] if prof else None))

    active, dropped = _active_features(lab)
    X_all = lab[active].to_numpy(dtype=np.float32)  # NaN kept: LightGBM routes missing values natively
    prof_all = fe.periodicity_profile(bars["t"], bars["open"], bars["close"])
    f_all = prof_all["f"] if prof_all else None

    models: Dict[Tuple[int, float], Any] = {}
    cv: Dict[str, Any] = {}
    verdicts: Dict[str, Any] = {}
    fhs: Dict[str, Any] = {}
    oos: Dict[int, Dict[str, np.ndarray]] = {}
    for h in HORIZONS:
        y = lab[f"ret_{h}"].to_numpy(dtype=np.float64)
        losses = {q: [] for q in QUANTILES}
        idx_l, qm_l, qb_l = [], [], []
        for tr, te, act, prof in fold_info:
            Xtr = lab.loc[tr, act].to_numpy(dtype=np.float32)
            Xte = lab.loc[te, act].to_numpy(dtype=np.float32)
            preds = {}
            for q in QUANTILES:
                m = factory(q)
                m.fit(Xtr, y[tr])
                preds[q] = m.predict(Xte)
                losses[q].append(pinball(y[te], preds[q], q))
            qm = np.sort(np.column_stack([preds[q] for q in QUANTILES]), axis=1)
            s_tr, _ = fe.baseline_scale(rv[tr], vix[tr], hour[tr], h, prof)
            s_te, _ = fe.baseline_scale(rv[te], vix[te], hour[te], h, prof)
            qb = fe.baseline_quantiles_from_scale(s_te, fe.fit_fhs_z(y[tr], s_tr))
            idx_l.append(np.flatnonzero(te)); qm_l.append(qm); qb_l.append(qb)
        if idx_l:
            idx = np.concatenate(idx_l)
            oos[h] = {"idx": idx, "qm": np.vstack(qm_l), "qb": np.vstack(qb_l)}
            verdicts[str(h)] = fe.horizon_verdict(y[idx], oos[h]["qm"], oos[h]["qb"], days[idx])
        else:
            verdicts[str(h)] = {"pass": False, "reasons": ["no walk-forward folds"]}
        qm_all = oos.get(h, {}).get("qm")
        cv[str(h)] = {
            "pinball": {str(q): (float(np.mean(v)) if v else None) for q, v in losses.items()},
            "coverage_10_90": fe.coverage_10_90(y[oos[h]["idx"]], qm_all) if h in oos else None,
            "n_test": int(oos[h]["idx"].size) if h in oos else 0,
        }
        for q in QUANTILES:
            m = factory(q)
            m.fit(X_all, y)
            models[(h, q)] = m
        s_all, _ = fe.baseline_scale(rv, vix, hour, h, f_all)
        zall = fe.fit_fhs_z(y, s_all)
        if zall is not None:
            fhs[str(h)] = dict(zip(fe.Q_NAMES, zall))

    promotion = fe.promotion_decision(verdicts)
    promoted = bool(promotion["promoted"])

    # ── Incumbent: re-score on the newest out-of-sample days, keep the winner ──
    incumbent_report: Optional[Dict[str, Any]] = None
    inc = _promoted_incumbent(out_dir)
    if inc is not None and oos:
        v_inc, meta_inc = inc
        try:
            models_inc = joblib.load(out_dir / f"quantile_overlay_v{v_inc}.lgb")
        except Exception as e:
            models_inc = None
            incumbent_report = {"version": v_inc, "error": f"could not load: {e}"}
        if models_inc is not None:
            last = str(meta_inc.get("last_day") or "")
            inc_verdicts, h2h = {}, {}
            new_days: List[str] = []
            for h in HORIZONS:
                if h not in oos:
                    continue
                o = oos[h]
                sel = np.array([str(d) > last for d in days[o["idx"]]])
                if not sel.any():
                    continue
                rows = o["idx"][sel]
                new_days = sorted(set(days[rows].tolist()))
                Xi = lab.reindex(columns=meta_inc.get("feature_names", [])).loc[rows].to_numpy(dtype=np.float32)
                qi = _qmatrix(models_inc, h, Xi)
                if qi is None:
                    continue
                y = lab[f"ret_{h}"].to_numpy(dtype=np.float64)[rows]
                inc_verdicts[str(h)] = fe.horizon_verdict(y, qi, o["qb"][sel], days[rows])
                h2h[str(h)] = {"pinball_candidate": float(fe.pinball_rows(y, o["qm"][sel]).mean()),
                               "pinball_incumbent": float(fe.pinball_rows(y, qi).mean()), "n": int(rows.size)}
            incumbent_report = {"version": v_inc, "new_days": len(new_days), "rescore": inc_verdicts, "head_to_head": h2h}
            demoted = False
            if len(new_days) >= fe.MIN_DM_DAYS and inc_verdicts and not fe.promotion_decision(inc_verdicts)["promoted"]:
                reason = f"re-scored on {len(new_days)} out-of-sample days after its training window: fails the promotion rule vs the baseline cone"
                demoted = demote_version("quantile_overlay", v_inc, reason, out_dir)
                incumbent_report["demoted"] = reason
            if promoted and not demoted:
                if not h2h:
                    promoted = False
                    promotion["kept_incumbent"] = f"no out-of-sample days after incumbent v{v_inc}'s training window; incumbent kept"
                else:
                    cand = sum(v["pinball_candidate"] for v in h2h.values())
                    incl = sum(v["pinball_incumbent"] for v in h2h.values())
                    if not cand < incl:
                        promoted = False
                        promotion["kept_incumbent"] = f"incumbent v{v_inc} has lower pinball on the newest out-of-sample days ({incl:.6g} <= {cand:.6g})"
    promotion["promoted"] = promoted

    versions = []
    for p in out_dir.glob("quantile_overlay_v*_meta.json"):
        try:
            versions.append(int(p.stem.split("_v")[1].split("_meta")[0]))
        except (IndexError, ValueError):
            pass
    version = max(versions) + 1 if versions else 1
    model_path = out_dir / f"quantile_overlay_v{version}.lgb"
    tmp = model_path.with_suffix(".lgb.tmp")
    joblib.dump(models, tmp)
    os.rename(str(tmp), str(model_path))
    meta = {
        # TRAINED = passed the promotion gate and is served; NOT_PROMOTED = kept for audit, never served.
        "status": "TRAINED" if promoted else "NOT_PROMOTED",
        "promoted": promoted,
        "promotion": promotion,
        "incumbent": incumbent_report,
        "version": version,
        "trained_at": int(time.time()),
        "training_data": "real",
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "missing_policy": "native_nan",
        "n_train": int(len(lab)),
        "n_days": gate["qualifying_days"],
        "first_day": str(days.min()) if len(days) else gate["first_day"],
        "last_day": str(days.max()) if len(days) else gate["last_day"],
        "feature_names": active,
        "dropped_features": dropped,
        "training_medians": {f: (float(lab[f].median()) if lab[f].notna().any() else None) for f in active},
        "cv": cv,
        "cv_scheme": f"walk-forward on whole ET days, {len(folds)} folds, embargo {EMBARGO_DAYS} day(s); features, model, periodicity and baseline quantiles fitted per fold on training days only",
        "horizons": HORIZONS,
        "quantiles": QUANTILES,
        "label": "SPX simple return over [t, t+h] from Schwab 1-minute bar closes, same session",
        "model_path": str(model_path),
        "elapsed_sec": round(time.time() - t0, 1),
    }
    _atomic_json(out_dir / f"quantile_overlay_v{version}_meta.json", meta)
    # Baseline cone parameters for the server (only from real data that met the gate).
    if fhs:
        _atomic_json(out_dir / "baseline_cone_meta.json", {
            "method": "fhs", "by_horizon": fhs, "n_days": gate["qualifying_days"], "fitted_at": int(time.time()),
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "periodicity": prof_all,
            "oos_coverage_10_90": {h: v.get("coverage_baseline") for h, v in verdicts.items()},
            "note": "standardized-return quantiles log(1+r_h)/s_h per horizon; s_h from rv_session_5m (deseasonalized) or VIX-implied sigma and the intraday periodicity profile",
        })
    return {"status": meta["status"], "promoted": promoted, "version": version, "n_train": meta["n_train"],
            "n_days": meta["n_days"], "cv": cv, "promotion": promotion, "incumbent": incumbent_report}


def train_quantile_v3() -> Dict[str, Any]:
    """Removed: v3 trained on random dealer-level offsets. Kept as a stub so old callers get a clear status."""
    return {"status": "DISABLED_SYNTHETIC", "note": "synthetic Greek-level training removed; use train_quantile_overlay (real data only)"}
