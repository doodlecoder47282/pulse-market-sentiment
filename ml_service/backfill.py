"""
Pulse Batcave — Backfill Module (Wire 20.5)
Idempotent data backfill from zero-auth public sources.

Sources used:
  SPY 1-min:  Alpha Vantage demo (IBM only — SPY locked to demo key).
              Falls back to CBOE SPX daily history as proxy baseline.
  CBOE GEX:   CBOE public CDN (VIX + SPX daily close, plus snapshot_history).

CLI:
  python -m ml_service.backfill --spy-1min --cboe-gex
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Tuple
import urllib.request
import urllib.error

logger = logging.getLogger("ml.backfill")
logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# ─── DB helpers ───────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _ensure_spy_1min_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS spy_1min_history (
            ts INTEGER PRIMARY KEY,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_spy_1min_ts ON spy_1min_history(ts)"
    )
    conn.commit()


# ─── HTTP helper ──────────────────────────────────────────────────────────────

def _fetch(url: str, timeout: int = 20) -> Optional[bytes]:
    """Fetch URL bytes with browser-like headers. Returns None on any error."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return resp.read()
            logger.warning("HTTP %s for %s", resp.status, url)
            return None
    except Exception as e:
        logger.warning("fetch error %s: %s", url, e)
        return None


# ─── A) backfill_spy_1min ─────────────────────────────────────────────────────

def backfill_spy_1min(years_back: int = 2) -> dict:
    """
    Backfill SPY / SPX price history into spy_1min_history.
    Fallback chain (no Yahoo, no auth):
      1. Alpha Vantage IBM daily (demo key works) — proxy, not SPY but proves pipeline
      2. CBOE SPX daily close — genuine SPX data, 1990-present
      3. Log no_source and skip

    Returns summary dict.
    """
    result = {"source": None, "rows_inserted": 0, "status": "ok"}
    try:
        with _conn() as conn:
            _ensure_spy_1min_table(conn)

            # Check existing row count
            existing = conn.execute("SELECT COUNT(*) FROM spy_1min_history").fetchone()[0]
            if existing > 0:
                logger.info("spy_1min_history already has %d rows — skipping backfill", existing)
                result["rows_inserted"] = 0
                result["source"] = "already_present"
                return result

            # ── Source 2: CBOE SPX daily close (best free public source) ──────
            logger.info("Trying CBOE SPX daily history...")
            spx_url = "https://cdn.cboe.com/api/global/us_indices/daily_prices/SPX_History.csv"
            raw = _fetch(spx_url)

            if raw:
                text = raw.decode("utf-8", errors="replace")
                reader = csv.DictReader(io.StringIO(text))
                rows: List[Tuple] = []
                cutoff = datetime.now() - timedelta(days=365 * years_back)

                for row in reader:
                    try:
                        dt = datetime.strptime(row["DATE"].strip(), "%m/%d/%Y")
                        if dt < cutoff:
                            continue
                        close_val = float(row["SPX"].strip())
                        ts = int(dt.replace(tzinfo=timezone.utc).timestamp())
                        # Store as OHLCV with only close populated (daily bar as 1 row)
                        rows.append((ts, close_val, close_val, close_val, close_val, 0))
                    except (KeyError, ValueError):
                        continue

                if rows:
                    conn.executemany(
                        "INSERT OR IGNORE INTO spy_1min_history (ts, open, high, low, close, volume) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        rows,
                    )
                    conn.commit()
                    result["source"] = "cboe_spx_daily"
                    result["rows_inserted"] = len(rows)
                    logger.info("Inserted %d SPX daily rows (CBOE source)", len(rows))
                    return result

            # ── Source 3: Alpha Vantage demo (IBM daily — proves pipeline) ────
            logger.info("Trying Alpha Vantage demo (IBM daily)...")
            av_url = (
                "https://www.alphavantage.co/query"
                "?function=TIME_SERIES_DAILY_ADJUSTED&symbol=IBM"
                "&apikey=demo&datatype=csv"
            )
            raw = _fetch(av_url)
            if raw:
                text = raw.decode("utf-8", errors="replace")
                if text.startswith("timestamp"):
                    reader = csv.DictReader(io.StringIO(text))
                    rows = []
                    for row in reader:
                        try:
                            dt = datetime.strptime(row["timestamp"].strip(), "%Y-%m-%d")
                            close_val = float(row["adjusted_close"].strip())
                            ts = int(dt.replace(tzinfo=timezone.utc).timestamp())
                            rows.append((ts, float(row["open"]), float(row["high"]),
                                         float(row["low"]), close_val, int(float(row["volume"]))))
                        except (KeyError, ValueError):
                            continue
                    if rows:
                        conn.executemany(
                            "INSERT OR IGNORE INTO spy_1min_history (ts, open, high, low, close, volume) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            rows,
                        )
                        conn.commit()
                        result["source"] = "alphavantage_demo_ibm"
                        result["rows_inserted"] = len(rows)
                        logger.info("Inserted %d IBM daily rows (AV demo)", len(rows))
                        return result

            logger.warning("ml:backfill:spy:no_source — all sources failed")
            result["status"] = "no_source"
            return result

    except Exception as e:
        logger.error("backfill_spy_1min error: %s", e)
        result["status"] = f"error:{e}"
        return result


# ─── B) backfill_cboe_gex_history ─────────────────────────────────────────────

def _derive_gamma_regime(net_gex: float) -> str:
    """Derive gamma regime from net GEX value."""
    if net_gex > 1_000_000:
        return "positive"
    elif net_gex < -1_000_000:
        return "negative"
    else:
        return "neutral"


def _write_snapshot_row(
    conn: sqlite3.Connection,
    date: str,
    captured_at: int,
    spy_close: float,
    vix: float,
    net_gex: float,
    pcr_oi: float,
) -> bool:
    """Write one row to snapshot_history. Returns True if inserted (not duplicate)."""
    gamma_regime = _derive_gamma_regime(net_gex)
    try:
        conn.execute(
            """
            INSERT OR IGNORE INTO snapshot_history
              (date, captured_at, spy_close, composite, vix, gamma_regime, net_gex, pcr_oi)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (date, captured_at, spy_close, 0, vix, gamma_regime, net_gex, pcr_oi),
        )
        conn.commit()
        return conn.execute(
            "SELECT changes()"
        ).fetchone()[0] > 0
    except Exception as e:
        logger.warning("snapshot insert error for %s: %s", date, e)
        return False


def backfill_cboe_gex_history(months_back: int = 12) -> dict:
    """
    Backfill GEX proxy + VIX + SPX close into snapshot_history.

    Strategy (no auth required):
    1. CBOE SPX daily close history (cdn.cboe.com) — SPX close
    2. CBOE VIX daily history (cdn.cboe.com) — VIX
    3. CBOE current snapshot for today's GEX (rate limited — handled gracefully)
    4. For historical GEX: we don't have true greeks historically for free,
       so we set net_gex=0 and derive gamma_regime='neutral' for historical rows.
       Today's row uses the CBOE snapshot if available.

    Returns summary dict.
    """
    result = {"rows_inserted": 0, "status": "ok", "today_gex_fetched": False}

    try:
        with _conn() as conn:
            # ── Check existing ────────────────────────────────────────────────
            existing = conn.execute(
                "SELECT COUNT(*) FROM snapshot_history"
            ).fetchone()[0]
            logger.info("snapshot_history existing rows: %d", existing)

            # ── Fetch SPX close history ───────────────────────────────────────
            logger.info("Fetching CBOE SPX close history...")
            spx_raw = _fetch("https://cdn.cboe.com/api/global/us_indices/daily_prices/SPX_History.csv")
            spx_by_date: dict = {}
            if spx_raw:
                text = spx_raw.decode("utf-8", errors="replace")
                reader = csv.DictReader(io.StringIO(text))
                for row in reader:
                    try:
                        dt = datetime.strptime(row["DATE"].strip(), "%m/%d/%Y")
                        spx_by_date[dt.strftime("%Y-%m-%d")] = float(row["SPX"].strip())
                    except (KeyError, ValueError):
                        pass
                logger.info("SPX history: %d days loaded", len(spx_by_date))
            else:
                logger.warning("Could not fetch SPX history")

            # ── Fetch VIX close history ───────────────────────────────────────
            logger.info("Fetching CBOE VIX history...")
            vix_raw = _fetch("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv")
            vix_by_date: dict = {}
            if vix_raw:
                text = vix_raw.decode("utf-8", errors="replace")
                reader = csv.DictReader(io.StringIO(text))
                for row in reader:
                    try:
                        dt = datetime.strptime(row["DATE"].strip(), "%m/%d/%Y")
                        vix_by_date[dt.strftime("%Y-%m-%d")] = float(row["CLOSE"].strip())
                    except (KeyError, ValueError):
                        pass
                logger.info("VIX history: %d days loaded", len(vix_by_date))
            else:
                logger.warning("Could not fetch VIX history")

            if not spx_by_date and not vix_by_date:
                logger.warning("ml:backfill:gex:no_source — no CBOE data available")
                result["status"] = "no_source"
                return result

            # ── Try current CBOE snapshot for today's GEX ────────────────────
            today_gex = 0.0
            today_pcr_oi = 1.0
            today_str = datetime.now().strftime("%Y-%m-%d")

            cboe_snapshot_url = (
                "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"
            )
            logger.info("Attempting CBOE snapshot for today's GEX...")
            snap_raw = _fetch(cboe_snapshot_url, timeout=15)
            if snap_raw:
                try:
                    snap = json.loads(snap_raw)
                    opts = snap.get("data", {}).get("options", [])
                    spot = float(snap.get("data", {}).get("current_price", 0) or 0)

                    if spot > 0 and opts:
                        call_gex = 0.0
                        put_gex = 0.0
                        call_oi_total = 0
                        put_oi_total = 0

                        for o in opts:
                            try:
                                oi = int(o.get("open_interest", 0) or 0)
                                gamma = float(o.get("gamma", 0) or 0)
                                option_type = str(o.get("option", {}).get("type", "") or
                                                  o.get("type", "") or "").upper()
                                # Matteo-Ferrara formula
                                gex_contrib = spot * gamma * oi * 100 * spot * 0.01
                                if option_type in ("C", "CALL"):
                                    call_gex += gex_contrib
                                    call_oi_total += oi
                                else:
                                    put_gex -= gex_contrib
                                    put_oi_total += oi
                            except (TypeError, ValueError):
                                continue

                        today_gex = call_gex + put_gex
                        today_pcr_oi = (
                            put_oi_total / call_oi_total
                            if call_oi_total > 0
                            else 1.0
                        )
                        result["today_gex_fetched"] = True
                        logger.info(
                            "Today GEX computed: %.0f (calls=%.0f, puts=%.0f, pcr=%.3f)",
                            today_gex, call_gex, put_gex, today_pcr_oi,
                        )
                except Exception as e:
                    logger.warning("GEX snapshot parse error: %s", e)
            else:
                logger.info("CBOE snapshot rate-limited or unavailable — using net_gex=0 for today")

            # ── Build date range and insert rows ──────────────────────────────
            cutoff = datetime.now() - timedelta(days=30 * months_back)
            inserted = 0
            date_iter = cutoff

            all_dates = sorted(set(list(spx_by_date.keys()) + list(vix_by_date.keys())))
            logger.info("Writing up to %d date rows to snapshot_history...", len(all_dates))

            for date_str in all_dates:
                try:
                    dt = datetime.strptime(date_str, "%Y-%m-%d")
                    if dt < cutoff:
                        continue
                    spx_close = spx_by_date.get(date_str, 0.0)
                    vix_close = vix_by_date.get(date_str, 15.0)  # fallback VIX
                    captured_at = int(dt.replace(tzinfo=timezone.utc).timestamp())

                    # Use actual GEX only for today; neutral proxy for history
                    if date_str == today_str:
                        net_gex = today_gex
                        pcr_oi = today_pcr_oi
                    else:
                        net_gex = 0.0
                        pcr_oi = 1.0

                    ok = _write_snapshot_row(
                        conn, date_str, captured_at,
                        spx_close, vix_close, net_gex, pcr_oi,
                    )
                    if ok:
                        inserted += 1
                except Exception as e:
                    logger.debug("Row skip %s: %s", date_str, e)
                    continue

            result["rows_inserted"] = inserted
            logger.info("snapshot_history: inserted %d new rows", inserted)
            return result

    except Exception as e:
        logger.error("backfill_cboe_gex_history error: %s", e)
        result["status"] = f"error:{e}"
        return result


# ─── CLI entry point ──────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pulse Batcave backfill — zero-auth, idempotent",
        prog="python -m ml_service.backfill",
    )
    parser.add_argument("--spy-1min", action="store_true", help="Backfill SPY/SPX 1-min (daily proxy)")
    parser.add_argument("--cboe-gex", action="store_true", help="Backfill CBOE GEX / snapshot_history")
    parser.add_argument("--years-back", type=int, default=2)
    parser.add_argument("--months-back", type=int, default=12)
    args = parser.parse_args()

    if not args.spy_1min and not args.cboe_gex:
        parser.print_help()
        return

    if args.spy_1min:
        logger.info("Starting SPY 1-min backfill...")
        r = backfill_spy_1min(years_back=args.years_back)
        logger.info("SPY 1-min result: %s", r)

    if args.cboe_gex:
        logger.info("Starting CBOE GEX backfill...")
        r = backfill_cboe_gex_history(months_back=args.months_back)
        logger.info("CBOE GEX result: %s", r)


if __name__ == "__main__":
    main()
