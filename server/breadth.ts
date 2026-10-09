/**
 * MISSION FIX #6 — sampled breadth engine.
 *
 * The composite reads VIX, gamma, put/call, sentiment surveys — all price-of-
 * insurance or positioning measures. None of them answer "how many soldiers
 * are marching with the generals?" A cap-weighted index can grind higher on
 * 5 megacaps while the median stock rolls over; that divergence historically
 * precedes air pockets.
 *
 * This is SAMPLED breadth: 36 hand-picked large caps (watchlist names plus
 * 20 large caps across sectors) from the daily-bars cache (Schwab-only), not
 * a random or constituent sample and not full NYSE breadth: it reads
 * large-cap participation, not the median stock (finding 5.7). Disclosed
 * as such, with sector-ETF participation beside it. Math lives in
 * breadthMath.ts (pure). Signals:
 *   - % of sample above 20dma / 50dma (participation)
 *   - advancers % today (daily pulse)
 *   - RSP/SPY 20d ratio z-score (equal-weight vs cap-weight divergence)
 *   - % of the 11 SPDR sector ETFs above 20dma / 50dma (each sector once)
 *   - divergence flag: SPY near 20d high while participation is thin
 *
 * All computed from cached daily closes — zero extra API calls at read time.
 */

import { sqlite } from "./storage";
import { BREADTH_STOCKS } from "./stockBarsCache";
import { computeBreadth, SECTOR_ETFS, breadthInternalsFromQuotes, INTERNALS_SYMBOLS, type BarRow, type BreadthSnapshot, type BreadthInternals } from "./breadthMath";
import { getQuotes } from "./schwab";

// NYSE internals ($ADVN/$DECN/$UVOL/$DVOL) from Schwab, refreshed in the
// background at most every 60 s; the snapshot carries the latest validated
// read (or "unavailable" with the reason) and names which read is primary.
let _internals: { at: number; data: BreadthInternals } | null = null;
let _internalsInflight = false;
function refreshInternals(): void {
  if (_internalsInflight || (_internals && Date.now() - _internals.at < 60_000)) return;
  _internalsInflight = true;
  getQuotes(Object.values(INTERNALS_SYMBOLS))
    .then((qs) => { _internals = { at: Date.now(), data: breadthInternalsFromQuotes(qs.length ? qs : null, qs.length ? null : "empty response (not authenticated or symbols unknown)") }; })
    .catch((e) => { _internals = { at: Date.now(), data: breadthInternalsFromQuotes(null, String(e?.message ?? e).slice(0, 80)) }; })
    .finally(() => { _internalsInflight = false; });
}
function withInternals(snap: BreadthSnapshot): BreadthSnapshot {
  refreshInternals();
  const internals = _internals?.data ?? breadthInternalsFromQuotes(null, "first Schwab internals request pending");
  const primary = internals.state === "ok" || internals.state === "partial" ? "nyse_internals" : "large_cap_sample";
  const lead = primary === "nyse_internals"
    ? `NYSE internals (Schwab): ${internals.advanceShare != null ? `${Math.round(internals.advanceShare * 100)}% of issues advancing` : "advance/decline unavailable"}${internals.upVolumeShare != null ? `, ${Math.round(internals.upVolumeShare * 100)}% of volume in advancers` : ""}. Large-cap sample: `
    : "";
  return { ...snap, internals, primary, read: lead + snap.read };
}

export type { BreadthSnapshot } from "./breadthMath";

let _cache: { at: number; snap: BreadthSnapshot } | null = null;

export function getBreadthSnapshot(force = false): BreadthSnapshot {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < 10 * 60_000) return withInternals(_cache.snap);
  try {
    const placeholders = BREADTH_STOCKS.map(() => "?").join(",");
    const rows = sqlite
      .prepare(`SELECT symbol, date, close FROM daily_bars
                WHERE symbol IN (${placeholders}) ORDER BY symbol, date ASC`)
      .all(...BREADTH_STOCKS) as BarRow[];
    const etfs = ["SPY", "RSP", ...SECTOR_ETFS];
    const etfRows = sqlite
      .prepare(`SELECT symbol, date, close FROM daily_bars WHERE symbol IN (${etfs.map(() => "?").join(",")}) ORDER BY symbol, date ASC`)
      .all(...etfs) as BarRow[];
    const snap = computeBreadth({ rows, etfRows, stockSymbols: BREADTH_STOCKS, nowMs: now });
    _cache = { at: now, snap };
    return withInternals(snap);
  } catch (e: any) {
    console.warn("[breadth] snapshot failed:", e?.message ?? e);
    // A failed read is not "insufficient history": say it failed.
    const snap = computeBreadth({ rows: [], etfRows: [], stockSymbols: BREADTH_STOCKS, nowMs: now });
    return withInternals({ ...snap, dataState: "unavailable", read: "large-cap sample unavailable (cache read failed)", note: `breadth sample unavailable: ${String(e?.message ?? e).slice(0, 120)}` });
  }
}
