"""
Known-answer checks for the real-data quantile pipeline (ml_service/train_quantile_impl.py).
Runs without lightgbm. Invoked by tests/quant/validation.test.ts; also runnable alone:
    python3 tests/quant/ml_quantile_data.py
The fixtures below are TEST INPUTS with hand-checkable answers, not training data.
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml_service"))
import train_quantile_impl as tq  # noqa: E402

# 2026-07-15 13:30:00 UTC = 09:30 EDT
OPEN_MS = 1784122200000


def _db_with(bars, feats):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE spx_minute_bars (t INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL, source TEXT)")
    conn.execute("CREATE TABLE ml_feature_log (ts INTEGER PRIMARY KEY, spot REAL, features_json TEXT, missing_json TEXT, live_chain INTEGER)")
    conn.executemany("INSERT INTO spx_minute_bars VALUES (?,?,?,?,?,NULL,'test')", [(t, c, c, c, c) for t, c in bars])
    conn.executemany("INSERT INTO ml_feature_log VALUES (?,?,?,?,1)", feats)
    conn.commit()
    return conn, path


class PipelineTests(unittest.TestCase):
    def test_label_is_bar_close_return_and_missing_is_nan(self):
        # Bars 09:30..10:39, close = 100 + minute index. Feature at 10:00 (t = open + 30 min).
        bars = [(OPEN_MS + i * 60_000, 100.0 + i) for i in range(70)]
        t = OPEN_MS + 30 * 60_000
        f = {n: 1.0 for n in tq.FEATURE_NAMES}
        conn, path = _db_with(bars, [(t, 6000.0, json.dumps(f), json.dumps(["dist_to_callwall_atr"]))])
        df = tq.build_frame(conn)
        conn.close(); os.unlink(path)
        # Price at 10:00 = close of the 09:59 bar (index 29) = 129. At 10:05: index 34 = 134.
        self.assertAlmostEqual(df.loc[0, "ret_5"], 134 / 129 - 1, places=12)
        self.assertAlmostEqual(df.loc[0, "ret_30"], 159 / 129 - 1, places=12)
        # 10:60 = 11:00 needs bar index 89, which does not exist: stale -> NaN, never filled
        self.assertTrue(np.isnan(df.loc[0, "ret_60"]))
        self.assertTrue(np.isnan(df.loc[0, "dist_to_callwall_atr"]))
        self.assertEqual(df.loc[0, "dist_to_putwall_atr"], 1.0)

    def test_gate_counts_days_not_rows(self):
        df_rows = []
        import pandas as pd
        for d in range(59):
            for i in range(50):
                df_rows.append({"day": f"2026-01-{d:03d}", **{f"ret_{h}": 0.0 for h in tq.HORIZONS}})
        g = tq.data_sufficiency(pd.DataFrame(df_rows))
        self.assertFalse(g["sufficient"])  # 59 days < 60, despite 2,950 rows
        self.assertEqual(g["qualifying_days"], 59)
        df_rows += [{"day": "2026-02-999", **{f"ret_{h}": 0.0 for h in tq.HORIZONS}}] * 40
        self.assertTrue(tq.data_sufficiency(pd.DataFrame(df_rows))["sufficient"])

    def test_walk_forward_folds_never_train_on_or_after_test_days(self):
        days = [f"d{i:03d}" for i in range(40)]
        folds = tq.walk_forward_day_folds(days, n_splits=5, embargo_days=1, min_train_days=20)
        self.assertEqual(len(folds), 5)
        for train, test in folds:
            self.assertLess(max(train), min(test))
            # embargo: the day right before the test block is excluded
            self.assertNotIn(days[days.index(min(test)) - 1], train)
        self.assertEqual(sorted(sum((t for _, t in folds), [])), days[21:])
        self.assertEqual(tq.walk_forward_day_folds(days[:10]), [])

    def test_pinball_known_value(self):
        # y = [0, 1], q = 0.5 prediction 0.5 -> mean(0.25, 0.25) = 0.25
        self.assertAlmostEqual(tq.pinball(np.array([0.0, 1.0]), np.array([0.5, 0.5]), 0.5), 0.25)

    def test_trainer_refuses_without_real_data(self):
        conn, path = _db_with([], [])
        conn.close()
        r = tq.train_quantile_overlay(Path(path))
        os.unlink(path)
        self.assertEqual(r["status"], "INSUFFICIENT_REAL_DATA")
        self.assertEqual(tq.train_quantile_v3()["status"], "DISABLED_SYNTHETIC")


if __name__ == "__main__":
    unittest.main(verbosity=1)
