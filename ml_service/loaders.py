"""
Pulse Batcave — DB Loaders (Wire 20)
Reads from /home/user/workspace/sentiment-app/data.db (sqlite3).
All functions return pandas DataFrames. On any error returns empty DataFrame.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Optional

import pandas as pd

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"


def _conn() -> sqlite3.Connection:
    return sqlite3.connect(str(DB_PATH))


# ─── load_prediction_outcomes ─────────────────────────────────────────────────

def load_prediction_outcomes(
    kind: Optional[str] = None,
    since_ts: Optional[int] = None,
) -> pd.DataFrame:
    """
    Returns DataFrame with parsed inputs_json + prediction_json + labels.
    Columns: all columns from prediction_outcomes + hit_30, hit_50, pct_return
    (these may already exist as raw columns — expose them directly).
    On error / missing table: returns empty DataFrame.
    """
    try:
        with _conn() as conn:
            query = "SELECT * FROM prediction_outcomes WHERE 1=1"
            params: list = []
            if kind is not None:
                query += " AND kind = ?"
                params.append(kind)
            if since_ts is not None:
                query += " AND created_at >= ?"
                params.append(since_ts)
            df = pd.read_sql_query(query, conn, params=params)

        if df.empty:
            return df

        # Parse inputs_json if present
        if "inputs_json" in df.columns:
            def _parse_inputs(v):
                try:
                    return json.loads(v) if isinstance(v, str) else {}
                except Exception:
                    return {}
            parsed = df["inputs_json"].apply(_parse_inputs).apply(pd.Series)
            df = pd.concat([df, parsed.add_prefix("input_")], axis=1)

        # Parse prediction_json if present
        if "prediction_json" in df.columns:
            def _parse_pred(v):
                try:
                    return json.loads(v) if isinstance(v, str) else {}
                except Exception:
                    return {}
            parsed_pred = df["prediction_json"].apply(_parse_pred).apply(pd.Series)
            df = pd.concat([df, parsed_pred.add_prefix("pred_")], axis=1)

        # Ensure label columns exist (may be raw columns already)
        for col in ["hit_30", "hit_50", "pct_return"]:
            if col not in df.columns:
                df[col] = None

        return df

    except Exception:
        return pd.DataFrame()


# ─── load_whale_follows ────────────────────────────────────────────────────────

def load_whale_follows() -> pd.DataFrame:
    """
    Returns DataFrame from whale_follows with parsed entry_json +
    closing_print_json + computed labels: followed_through (bool), follow_pct (float).
    On error / missing table: returns empty DataFrame.
    """
    try:
        with _conn() as conn:
            df = pd.read_sql_query("SELECT * FROM whale_follows", conn)

        if df.empty:
            return df

        # Parse entry_json
        if "entry_json" in df.columns:
            def _pe(v):
                try:
                    return json.loads(v) if isinstance(v, str) else {}
                except Exception:
                    return {}
            parsed_entry = df["entry_json"].apply(_pe).apply(pd.Series)
            df = pd.concat([df, parsed_entry.add_prefix("entry_")], axis=1)

        # Parse closing_print_json
        if "closing_print_json" in df.columns:
            def _pc(v):
                try:
                    return json.loads(v) if isinstance(v, str) else {}
                except Exception:
                    return {}
            parsed_close = df["closing_print_json"].apply(_pc).apply(pd.Series)
            df = pd.concat([df, parsed_close.add_prefix("close_")], axis=1)

        # Compute labels
        # followed_through: True if the whale alert hit the profit target
        if "followed_through" not in df.columns:
            # Try to infer from existing columns
            if "close_pnl_pct" in df.columns:
                df["followed_through"] = df["close_pnl_pct"] > 0
            elif "outcome" in df.columns:
                df["followed_through"] = df["outcome"].astype(str).str.upper().isin(["WIN", "HIT", "TRUE", "1"])
            else:
                df["followed_through"] = False

        # follow_pct: percentage move
        if "follow_pct" not in df.columns:
            if "close_pnl_pct" in df.columns:
                df["follow_pct"] = pd.to_numeric(df["close_pnl_pct"], errors="coerce").fillna(0.0)
            else:
                df["follow_pct"] = 0.0

        return df

    except Exception:
        return pd.DataFrame()


# ─── load_backtest_observations ───────────────────────────────────────────────

def load_backtest_observations(
    horizon: int,
    level_kind: str,
    since_date: Optional[str] = None,
) -> pd.DataFrame:
    """
    Returns DataFrame from backtest_observations for given horizon + level_kind.
    On error / missing table: returns empty DataFrame.
    """
    try:
        with _conn() as conn:
            query = (
                "SELECT * FROM backtest_observations "
                "WHERE horizon = ? AND level_kind = ?"
            )
            params: list = [horizon, level_kind]
            if since_date is not None:
                query += " AND date >= ?"
                params.append(since_date)
            df = pd.read_sql_query(query, conn, params=params)
        return df
    except Exception:
        return pd.DataFrame()
