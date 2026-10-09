"""
R2-F known-answer checks for the ML sidecar (no lightgbm, no fastapi needed):
  - baseline cone values (same hand-computed numbers as tests/quant/ml-r2.test.ts: TS/Python parity);
  - Diebold-Mariano: closed form on a small series, and seeded Monte Carlo size/power;
  - promotion gate end to end on seeded data (a NaN-native sklearn quantile learner
    stands in for LightGBM): noise features -> NOT_PROMOTED; a real scale signal -> promoted;
  - only schema-v2 feature rows are trained on; a log without the column trains nothing;
  - the predictor serves only promoted real-data versions and passes missing as NaN.
Invoked by tests/quant/ml-r2.test.ts; also runnable alone: python3 -I tests/quant/ml_r2_checks.py
Fixtures are TEST INPUTS with known answers, not training data.
"""
import json
import math
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml_service"))
import forecast_eval as fe  # noqa: E402
import train_quantile_impl as tq  # noqa: E402
import predictor as pr  # noqa: E402

OPEN_MS = 1784122200000  # 2026-07-15 13:30 UTC = 09:30 EDT (a Wednesday)
DAY_MS = 24 * 3600_000


class BaselineCone(unittest.TestCase):
    def test_known_values_match_ts(self):
        # sigma 0.001/bar, h = 20 min: s = 0.001 * sqrt(4) = 0.002; q90 = expm1(1.2815516 * 0.002)
        q = fe.baseline_quantiles(np.array([0.001]), 20)
        self.assertAlmostEqual(q[0, 4], 0.0025663906881020224, places=15)
        self.assertAlmostEqual(q[0, 0], -0.0025598211868448975, places=15)
        self.assertAlmostEqual(q[0, 3], 0.0013498897825096905, places=15)
        self.assertEqual(q[0, 2], 0.0)
        # VIX 20, no session RV: sigma = 0.20 / sqrt(252 * 78) = 0.00142653; h = 30 -> q90 = 0.0044881453
        s = fe.baseline_sigma_per_bar(np.array([np.nan]), np.array([20.0]))
        self.assertAlmostEqual(s[0], 0.0014265349750363764, places=15)
        self.assertAlmostEqual(fe.baseline_quantiles(s, 30)[0, 4], 0.004488145268269908, places=15)
        # neither input -> NaN, never a default
        self.assertTrue(np.isnan(fe.baseline_sigma_per_bar(np.array([np.nan]), np.array([np.nan]))[0]))

    def test_fhs_z_recovers_gaussian(self):
        rng = np.random.default_rng(7)
        sig = np.full(200_000, 0.001)
        y = np.expm1(rng.standard_normal(200_000) * 0.001 * math.sqrt(3))  # h = 15 -> sqrt(3)
        z = fe.fit_fhs_z(y, sig, 15)
        for got, want in zip(z, fe.GAUSS_Z):
            self.assertAlmostEqual(got, want, delta=0.02)


class DieboldMariano(unittest.TestCase):
    def test_closed_form_no_lags(self):
        d = np.array([-1.0, -2.0, 0.0, -3.0, 1.0, -1.0])
        T = d.size
        mean = d.mean()
        var0 = np.mean((d - mean) ** 2)  # gamma_0 with divisor T
        want = mean / math.sqrt(var0 / T)
        r = fe.diebold_mariano(d, lags=0, harvey=False)
        self.assertAlmostEqual(r["stat"], want, places=12)
        # HLN factor for h = 1: sqrt((T + 1 - 2) / T) = sqrt(5/6)
        r2 = fe.diebold_mariano(d, lags=0, harvey=True)
        self.assertAlmostEqual(r2["stat"], want * math.sqrt(5 / 6), places=12)

    def test_bartlett_lag1_closed_form(self):
        d = np.array([0.5, -1.0, 2.0, 0.0, -0.5, 1.5, -2.0, 0.25])
        T = d.size
        e = d - d.mean()
        g0 = np.dot(e, e) / T
        g1 = np.dot(e[1:], e[:-1]) / T
        lrv = g0 + 2 * 0.5 * g1  # Bartlett weight 1 - 1/(L+1) with L = 1
        r = fe.diebold_mariano(d, lags=1, harvey=False)
        self.assertAlmostEqual(r["stat"], d.mean() / math.sqrt(lrv / T), places=12)

    def test_size_and_power_seeded(self):
        rng = np.random.default_rng(20261008)
        n_sim, T = 2000, 40
        rej0 = sum(fe.diebold_mariano(rng.standard_normal(T))["p_less"] < 0.05 for _ in range(n_sim)) / n_sim
        rej1 = sum(fe.diebold_mariano(rng.standard_normal(T) - 0.6)["p_less"] < 0.05 for _ in range(n_sim)) / n_sim
        # Nominal 5%; with T = 40 and ceil(40^(1/3)) = 4 Bartlett lags the HLN-t test is close to size.
        self.assertGreater(rej0, 0.025)
        self.assertLess(rej0, 0.085)
        self.assertGreater(rej1, 0.90)


def _make_db(path, n_days, rows_per_day, sig_of_day, feature_of_day, schema_version=2, with_column=True, rv_const=0.0007, noise=True):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE spx_minute_bars (t INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL, source TEXT)")
    cols = "ts INTEGER PRIMARY KEY, spot REAL, features_json TEXT, missing_json TEXT, live_chain INTEGER"
    if with_column:
        cols += ", schema_version INTEGER, reasons_json TEXT"
    conn.execute(f"CREATE TABLE ml_feature_log ({cols})")
    rng = np.random.default_rng(11)
    bars, feats = [], []
    for d in range(n_days):
        day0 = OPEN_MS + d * DAY_MS
        sig = sig_of_day(d)
        px = 6000.0
        for i in range(390):
            px *= math.exp(rng.standard_normal() * sig)
            bars.append((day0 + i * 60_000, px, px, px, px))
        for k in range(rows_per_day):
            ts = day0 + (5 + 5 * k) * 60_000
            f = {n: (float(rng.standard_normal()) if noise else 0.0) for n in tq.FEATURE_NAMES}
            f["realized_vol_30m"] = feature_of_day(d)
            f["rv_session_5m"] = rv_const      # deliberately the same every day (the baseline's sigma)
            f["dist_to_callwall_atr"] = None   # missing every row -> dropped by the 40% rule
            missing = ["dist_to_callwall_atr"]
            row = (ts, px, json.dumps(f), json.dumps(missing), 1)
            if with_column:
                row = row + (schema_version, "{}")
            feats.append(row)
    conn.executemany("INSERT INTO spx_minute_bars VALUES (?,?,?,?,?,NULL,'test')", bars)
    q = "INSERT INTO ml_feature_log VALUES (" + ",".join("?" * len(feats[0])) + ")"
    conn.executemany(q, feats)
    conn.commit()
    conn.close()


def _hgb(alpha):
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(loss="quantile", quantile=alpha, max_iter=30, learning_rate=0.15, max_depth=3, random_state=0)


class PromotionGate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _train(self, **kw):
        db = self.tmp / "t.db"
        _make_db(str(db), **kw)
        out = self.tmp / "models"
        return tq.train_quantile_overlay(db, make_regressor=_hgb, models_dir=out), out

    def test_noise_model_is_not_promoted_and_not_served(self):
        # Constant volatility; features are noise. The model cannot beat the FHS baseline cone.
        r, out = self._train(n_days=61, rows_per_day=40, sig_of_day=lambda d: 0.0007, feature_of_day=lambda d: 0.0)
        self.assertEqual(r["status"], "NOT_PROMOTED", r.get("promotion"))
        meta = json.loads((out / f"quantile_overlay_v{r['version']}_meta.json").read_text())
        self.assertFalse(meta["promoted"])
        self.assertEqual(meta["missing_policy"], "native_nan")
        self.assertIn("dist_to_callwall_atr", meta["dropped_features"])
        reg = self._registry(out)
        self.assertIsNone(reg.promoted_meta("quantile_overlay"))
        self.assertEqual(reg.predict_quantile_overlay({"hour_of_day": 10.0}, [5]), {})
        self.assertTrue((out / "baseline_cone_meta.json").exists())

    def test_scale_signal_is_promoted_and_served_with_nan(self):
        # Day volatility alternates 0.0003 / 0.0012 per minute; realized_vol_30m carries it, the
        # baseline's sigma (rv_session_5m) does not. Other features are constant (no noise to
        # overfit), so a conditional-scale model must win on pinball, DM and coverage.
        sig = lambda d: 0.0003 if d % 2 == 0 else 0.0012
        r, out = self._train(n_days=61, rows_per_day=40, sig_of_day=sig, feature_of_day=sig, noise=False)
        self.assertTrue(r["promoted"], json.dumps(r["promotion"], default=str)[:2000])
        for h, v in r["promotion"]["per_horizon"].items():
            self.assertGreaterEqual(v["rel_improvement"], fe.MARGIN)
            self.assertLess(v["dm"]["p_less"], fe.DM_ALPHA)
        reg = self._registry(out)
        meta = reg.promoted_meta("quantile_overlay")
        self.assertEqual(meta["version"], r["version"])
        # Missing feature -> NaN in the served vector (never a median or 0).
        x = pr.feature_vector({"realized_vol_30m": None, "hour_of_day": 10.0}, meta["feature_names"], meta)
        idx = meta["feature_names"].index("realized_vol_30m")
        self.assertTrue(np.isnan(x[0, idx]))
        bands = reg.predict_quantile_overlay({"realized_vol_30m": 0.0012, "hour_of_day": 10.0}, [5, 15, 30, 60])
        self.assertEqual(sorted(bands.keys(), key=int), ["5", "15", "30", "60"])
        self.assertLess(bands["60"]["q10"], bands["60"]["q90"])

    def test_only_current_schema_rows_are_used(self):
        db = self.tmp / "v1.db"
        _make_db(str(db), n_days=61, rows_per_day=40, sig_of_day=lambda d: 0.0007, feature_of_day=lambda d: 0.0, schema_version=1)
        with closing(sqlite3.connect(str(db))) as c:
            self.assertTrue(tq.build_frame(c).empty)
        r = tq.train_quantile_overlay(db, make_regressor=_hgb, models_dir=self.tmp / "m1")
        self.assertEqual(r["status"], "INSUFFICIENT_REAL_DATA")
        db2 = self.tmp / "nocol.db"
        _make_db(str(db2), n_days=3, rows_per_day=42, sig_of_day=lambda d: 0.0007, feature_of_day=lambda d: 0.0, with_column=False)
        with closing(sqlite3.connect(str(db2))) as c:
            self.assertTrue(tq.build_frame(c).empty)

    def _registry(self, out):
        pr.MODELS_DIR = out
        return pr.ModelRegistry()


class PredictorServing(unittest.TestCase):
    def test_unpromoted_and_synthetic_versions_are_never_served(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            import joblib
            for v, meta in [(4, {"training_data": "synthetic_gbm", "status": "TRAINED"}),
                            (5, {"training_data": "real", "promoted": True, "status": "TRAINED"}),
                            (6, {"training_data": "real", "promoted": False, "status": "NOT_PROMOTED"}),
                            (7, {"training_data": "synthetic_gbm", "promoted": True})]:
                (tmp / f"quantile_overlay_v{v}_meta.json").write_text(json.dumps({**meta, "version": v, "feature_names": ["a"]}))
                joblib.dump({}, tmp / f"quantile_overlay_v{v}.lgb")
            pr.MODELS_DIR = tmp
            reg = pr.ModelRegistry()
            self.assertEqual(reg.promoted_meta("quantile_overlay")["version"], 5)
            self.assertIsNone(reg.promoted_meta("quantile_overlay_morning"))
            # legacy policy (no missing_policy): median fill; native: NaN
            self.assertEqual(pr.feature_vector({}, ["a"], {"training_medians": {"a": 2.5}})[0, 0], 2.5)
            self.assertTrue(np.isnan(pr.feature_vector({"a": None}, ["a"], {"missing_policy": "native_nan"})[0, 0]))
            self.assertIsNone(reg.predict_score_calibrator({"score": 1.0}))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=1)
