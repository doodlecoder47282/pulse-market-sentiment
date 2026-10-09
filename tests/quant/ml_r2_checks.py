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

    def test_periodic_scale_matches_ts(self):
        # Same profile and values as tests/quant/ml-r2.test.ts (Andersen-Bollerslev periodicity).
        f = [2.0] * 6 + [11 / 12] * 72
        s, src = fe.baseline_scale(0.001, np.nan, 10.5, 30, f)
        self.assertAlmostEqual(s[0], 0.001942016624910449, places=15)
        self.assertEqual(src[0], "rv_session")
        self.assertAlmostEqual(fe.baseline_quantiles_from_scale(s)[0, 4], 0.0024918940657702128, places=15)
        self.assertAlmostEqual(fe.baseline_scale(0.001, np.nan, 15.75, 30, f)[0][0], 0.0016555554316830998, places=15)
        s, src = fe.baseline_scale(np.nan, 20.0, 15.75, 30, None)
        self.assertAlmostEqual(s[0], 0.002470831055537004, places=15)
        self.assertEqual(src[0], "vix_implied")
        # After the close: no cone; no time of day: no cone.
        self.assertTrue(np.isnan(fe.baseline_scale(0.001, np.nan, 16.0, 5, f)[0][0]))
        self.assertTrue(np.isnan(fe.baseline_scale(0.001, np.nan, np.nan, 5, f)[0][0]))
        # Flat profile inside the session = square-root-of-time.
        self.assertAlmostEqual(fe.baseline_scale(0.001, np.nan, 10.5, 20, None)[0][0], 0.002, places=15)

    def test_periodicity_profile_known_answer(self):
        # 25 sessions; bucket b's 5-minute log return is +-a_b with a_b = 0.002 for b < 6 and 0.001 after,
        # so f_b = a_b^2 / mean(a^2) exactly, whatever the day's level.
        a = np.array([0.002] * 6 + [0.001] * 72)
        want = a ** 2 / np.mean(a ** 2)
        t, o, c = [], [], []
        for d in range(25):
            day0 = OPEN_MS + d * DAY_MS
            px = 6000.0 * (1 + 0.01 * d)
            for b in range(78):
                for k in range(5):
                    o.append(px)
                    if k == 4:
                        px *= math.exp(a[b] * (1 if (b + d) % 2 else -1))
                    c.append(px)
                    t.append(day0 + (5 * b + k) * 60_000)
        p = fe.periodicity_profile(np.array(t), np.array(o), np.array(c))
        self.assertEqual(p["n_days"], 25)
        np.testing.assert_allclose(p["f"], want, rtol=1e-9)
        self.assertIsNone(fe.periodicity_profile(np.array(t), np.array(o), np.array(c), min_days=26))

    def test_clustered_coverage_ci(self):
        # Two days: day A 3/4 inside, day B 1/4 inside -> p = 0.5; cluster sums of (x - p): 3 - 2 = +1, 1 - 2 = -1;
        # var = (1 + 1) * G/(G-1) / N^2 = 2 * 2 / 64 -> se = 0.25 (iid binomial would say sqrt(.25/8) = 0.177).
        y = np.array([0, 0, 0, 5, 0, 5, 5, 5], dtype=float)
        q = np.tile(np.array([[-1, -0.5, 0, 0.5, 1.0]]), (8, 1))
        days = np.array(["A"] * 4 + ["B"] * 4)
        ci = fe.clustered_coverage_ci(y, q, days)
        self.assertAlmostEqual(ci["rate"], 0.5)
        self.assertAlmostEqual(ci["se"], 0.25, places=15)
        self.assertEqual(ci["clusters"], 2)

    def test_live_coverage_demotion_rule(self):
        self.assertTrue(fe.live_coverage_demotion({"60": {"kupiec_p": 0.004, "n_days": 20}})["demote"])
        self.assertFalse(fe.live_coverage_demotion({"60": {"kupiec_p": 0.004, "n_days": 19}})["demote"])
        self.assertFalse(fe.live_coverage_demotion({"60": {"kupiec_p": 0.02, "n_days": 40}})["demote"])

    def test_fhs_z_recovers_gaussian(self):
        rng = np.random.default_rng(7)
        sig = np.full(200_000, 0.001)
        y = np.expm1(rng.standard_normal(200_000) * 0.001 * math.sqrt(3))  # h = 15 -> sqrt(3)
        z = fe.fit_fhs_z(y, sig * math.sqrt(3))
        for got, want in zip(z, fe.GAUSS_Z):
            self.assertAlmostEqual(got, want, delta=0.02)


class DieboldMariano(unittest.TestCase):
    def test_closed_form_no_lags(self):
        d = np.array([-1.0, -2.0, 0.0, -3.0, 1.0, -1.0])
        T = d.size
        mean = d.mean()
        var0 = np.mean((d - mean) ** 2)  # gamma_0 with divisor T
        want = mean / math.sqrt(var0 / T)
        r = fe.diebold_mariano(d, method="nw", lags=0, harvey=False)
        self.assertAlmostEqual(r["stat"], want, places=12)
        # HLN factor for h = 1: sqrt((T + 1 - 2) / T) = sqrt(5/6)
        r2 = fe.diebold_mariano(d, method="nw", lags=0, harvey=True)
        self.assertAlmostEqual(r2["stat"], want * math.sqrt(5 / 6), places=12)

    def test_bartlett_lag1_closed_form(self):
        d = np.array([0.5, -1.0, 2.0, 0.0, -0.5, 1.5, -2.0, 0.25])
        T = d.size
        e = d - d.mean()
        g0 = np.dot(e, e) / T
        g1 = np.dot(e[1:], e[:-1]) / T
        lrv = g0 + 2 * 0.5 * g1  # Bartlett weight 1 - 1/(L+1) with L = 1
        r = fe.diebold_mariano(d, method="nw", lags=1, harvey=False)
        self.assertAlmostEqual(r["stat"], d.mean() / math.sqrt(lrv / T), places=12)

    def test_wpe_closed_form(self):
        # T = 8 -> m = floor(8^(1/3)) = 2. Daniell WPE: sigma^2 = (1/m) sum_{j=1..m} |sum_t d_t e^{-i 2 pi j t / T}|^2 / T,
        # statistic sqrt(T) dbar / sigma ~ t(2m) (Coroneo & Iacone 2020, eq. 8-9).
        d = np.array([0.5, -1.0, 2.0, 0.0, -0.5, 1.5, -2.0, 0.25])
        T = d.size
        I = []
        for j in (1, 2):
            re = sum(d[t - 1] * math.cos(2 * math.pi * j * t / T) for t in range(1, T + 1))
            im = sum(d[t - 1] * math.sin(2 * math.pi * j * t / T) for t in range(1, T + 1))
            I.append((re * re + im * im) / T)
        stat = math.sqrt(T) * d.mean() / math.sqrt(sum(I) / 2)
        r = fe.diebold_mariano(d)
        self.assertEqual((r["method"], r["m"], r["df"]), ("wpe", 2, 4))
        self.assertAlmostEqual(r["stat"], stat, places=12)
        from scipy.stats import t as tdist
        self.assertAlmostEqual(r["p_less"], float(tdist.cdf(stat, 4)), places=12)

    def test_size_and_power_seeded(self):
        # Size at T = 39 and 40 daily differentials (the gate's regime), iid and AR(1) phi = 0.3 nulls.
        # Coroneo & Iacone (2020) show the Newey-West/HLN DM test over-rejects at this T with
        # autocorrelated differentials; the fixed-smoothing WPE test keeps its size.
        rng = np.random.default_rng(20261008)
        n_sim = 4000

        def ar1(T, phi):
            e = rng.standard_normal(T + 50)
            x = np.zeros_like(e)
            for i in range(1, e.size):
                x[i] = phi * x[i - 1] + e[i]
            return x[50:]

        res = {}
        for T in (39, 40):
            for phi in (0.0, 0.3):
                sims = [ar1(T, phi) for _ in range(n_sim)]
                wpe = np.mean([fe.diebold_mariano(x)["p_less"] < 0.05 for x in sims])
                nw = np.mean([fe.diebold_mariano(x, method="nw")["p_less"] < 0.05 for x in sims])
                res[(T, phi)] = (wpe, nw)
                # Monte Carlo s.e. at 5% with 4000 draws = 0.0034: [0.035, 0.065] is about +-4.4 s.e.
                self.assertGreater(wpe, 0.035, res)
                self.assertLess(wpe, 0.065, res)
        # The NW/HLN variant over-rejects under AR(1) dependence (the reason it is not the gate's test).
        self.assertGreater(res[(39, 0.3)][1], res[(39, 0.3)][0], res)
        # Power against a mean shift of 0.6 sd (iid, T = 40).
        rej1 = np.mean([fe.diebold_mariano(rng.standard_normal(40) - 0.6)["p_less"] < 0.05 for _ in range(2000)])
        self.assertGreater(rej1, 0.80, rej1)


def _make_db(path, n_days, rows_per_day, sig_of_day, feature_of_day, schema_version=2, with_column=True, rv_const=0.0007, noise=True, seed=11):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE spx_minute_bars (t INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL, source TEXT)")
    cols = "ts INTEGER PRIMARY KEY, spot REAL, features_json TEXT, missing_json TEXT, live_chain INTEGER"
    if with_column:
        cols += ", schema_version INTEGER, reasons_json TEXT"
    conn.execute(f"CREATE TABLE ml_feature_log ({cols})")
    rng = np.random.default_rng(seed)
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
            f["hour_of_day"] = 9.5 + (5 + 5 * k) / 60.0  # the baseline needs the real time of day
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
        self.assertTrue(r["promoted"], json.dumps({h: v for h, v in r["promotion"]["per_horizon"].items() if not v["pass"]}, default=str)[:3000])
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

    def test_incumbent_is_demoted_when_it_fails_on_newer_days(self):
        # v1 learns "realized_vol_30m carries the day's scale" on 61 days and is promoted. Then 25 new
        # days arrive on which the feature is inverted (it reports the OTHER regime). At the retrain the
        # incumbent is re-scored on those out-of-sample days, fails the rule against the baseline and is
        # demoted; the predictor then serves nothing and the server draws the baseline cone.
        sig = lambda d: 0.0003 if d % 2 == 0 else 0.0012
        out = self.tmp / "models"
        db1 = self.tmp / "a.db"
        _make_db(str(db1), n_days=61, rows_per_day=40, sig_of_day=sig, feature_of_day=sig, noise=False)
        r1 = tq.train_quantile_overlay(db1, make_regressor=_hgb, models_dir=out)
        self.assertTrue(r1["promoted"])
        # Retrain on the same days only: the candidate passes the gate, but there is no out-of-sample day
        # after the incumbent's window to compare them on, so the incumbent is kept.
        r_same = tq.train_quantile_overlay(db1, make_regressor=_hgb, models_dir=out)
        self.assertFalse(r_same["promoted"])
        self.assertIn("kept_incumbent", r_same["promotion"])
        self.assertEqual(self._registry(out).promoted_meta("quantile_overlay")["version"], r1["version"])
        inv = lambda d: sig(d) if d < 61 else sig(d + 1)
        db2 = self.tmp / "b.db"
        _make_db(str(db2), n_days=86, rows_per_day=40, sig_of_day=sig, feature_of_day=inv, noise=False)
        r2 = tq.train_quantile_overlay(db2, make_regressor=_hgb, models_dir=out)
        inc = r2["incumbent"]
        self.assertEqual(inc["version"], r1["version"])
        self.assertGreaterEqual(inc["new_days"], fe.MIN_DM_DAYS)
        self.assertIn("demoted", inc, json.dumps(inc, default=str)[:1500])
        m1 = json.loads((out / f"quantile_overlay_v{r1['version']}_meta.json").read_text())
        self.assertFalse(m1["promoted"])
        self.assertEqual(m1["status"], "DEMOTED")
        self.assertFalse(r2["promoted"])  # the candidate cannot learn an inverted relationship either
        self.assertIsNone(self._registry(out).promoted_meta("quantile_overlay"))

    def _registry(self, out):
        pr.MODELS_DIR = out
        return pr.ModelRegistry()


def _hgb_light(alpha):
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(loss="quantile", quantile=alpha, max_iter=15, learning_rate=0.2, max_depth=3, max_bins=32, random_state=0)


def _noise_run(seed):
    tmp = Path(tempfile.mkdtemp())
    try:
        _make_db(str(tmp / "n.db"), n_days=61, rows_per_day=40, sig_of_day=lambda d: 0.0007, feature_of_day=lambda d: 0.0, seed=seed)
        r = tq.train_quantile_overlay(tmp / "n.db", make_regressor=_hgb_light, models_dir=tmp / "m")
        return bool(r.get("promoted"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class FalsePromotion(unittest.TestCase):
    def test_noise_models_are_rarely_promoted_over_20_seeds(self):
        # 20 independent noise datasets (features unrelated to returns): the gate needs all 4 horizons to pass
        # a 2% pinball margin and a one-sided 5% DM test, so promotions must stay rare: <= 2 of 20.
        # About 11 s per training; run in fresh (spawned) single-threaded workers. ML_R2_SKIP_SLOW=1 skips.
        if os.environ.get("ML_R2_SKIP_SLOW") == "1":
            self.skipTest("ML_R2_SKIP_SLOW=1")
        import multiprocessing as mp
        from concurrent.futures import ProcessPoolExecutor
        os.environ["OMP_NUM_THREADS"] = "1"  # inherited by the spawned workers (no OpenMP oversubscription)
        with ProcessPoolExecutor(max_workers=max(1, min(4, os.cpu_count() or 1)), mp_context=mp.get_context("spawn")) as ex:
            promoted = list(ex.map(_noise_run, range(100, 120)))
        print(f"\n[false-promotion check] {sum(promoted)} of 20 noise datasets promoted", file=sys.stderr)
        self.assertLessEqual(sum(promoted), 2, promoted)


class PredictorServing(unittest.TestCase):
    def test_unpromoted_and_synthetic_versions_are_never_served(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            import joblib
            for v, meta in [(4, {"training_data": "synthetic_gbm", "status": "TRAINED"}),
                            (5, {"training_data": "real", "promoted": True, "status": "TRAINED"}),
                            (6, {"training_data": "real", "promoted": False, "status": "NOT_PROMOTED"}),
                            (7, {"training_data": "synthetic_gbm", "promoted": True}),
                            # promoted on real data but trained on feature schema 1: never fed a schema-2 dict
                            (8, {"training_data": "real", "promoted": True, "status": "TRAINED", "feature_schema_version": 1})]:
                (tmp / f"quantile_overlay_v{v}_meta.json").write_text(json.dumps({"feature_schema_version": 2, **meta, "version": v, "feature_names": ["a"]}))
                joblib.dump({}, tmp / f"quantile_overlay_v{v}.lgb")
            pr.MODELS_DIR = tmp
            reg = pr.ModelRegistry()
            self.assertEqual(reg.promoted_meta("quantile_overlay")["version"], 5)
            self.assertEqual(reg.promoted_meta("quantile_overlay", 1)["version"], 8)
            self.assertEqual(pr.CURRENT_FEATURE_SCHEMA, tq.FEATURE_SCHEMA_VERSION)
            self.assertIsNone(reg.promoted_meta("quantile_overlay_morning"))
            # legacy policy (no missing_policy): median fill; native: NaN
            self.assertEqual(pr.feature_vector({}, ["a"], {"training_medians": {"a": 2.5}})[0, 0], 2.5)
            self.assertTrue(np.isnan(pr.feature_vector({"a": None}, ["a"], {"missing_policy": "native_nan"})[0, 0]))
            self.assertIsNone(reg.predict_score_calibrator({"score": 1.0}))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=1)
