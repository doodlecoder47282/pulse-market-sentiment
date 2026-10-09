// server/pcrHistoryStore.ts
//
// Daily put/call volume per symbol, recorded from the Schwab chain snapshots
// the P/C flow panel already pulls (flow.ts). Feeds pcrHistory.ts, which
// z-scores today's ratio against the symbol's own completed sessions.
//
// Rules:
//   - Only provider "schwab" rows are recorded or read (user rule: Schwab
//     only for market data; a CBOE snapshot never becomes history).
//   - One row per (symbol, ET session date); a newer snapshot replaces an
//     older one. A row is "complete" once a snapshot from the final 10
//     minutes of that session (or after its close, same ET date) is stored.
//   - Snapshots before the 09:30 open or on a non-trading day are not
//     recorded: Schwab's day volume then still belongs to the prior session.
//   - Fail-soft: DB errors are logged and swallowed; a failed read returns
//     an empty history, which reads as "insufficient_history", never as a zone.

import { sqlite } from "./storage";
import { etDate, isTradingDay, sessionCloseMs, sessionOpenMs } from "./exchangeCalendar";
import { isCompleteSessionSnapshot, PCR_HISTORY_WINDOW, type PcrDay } from "./pcrHistory";

try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS flow_pcr_daily (
      symbol TEXT NOT NULL,
      session_date TEXT NOT NULL,
      put_vol REAL NOT NULL,
      call_vol REAL NOT NULL,
      provider TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (symbol, session_date)
    );
  `);
} catch (e) {
  console.warn("[pcrHistoryStore] init failed:", (e as Error).message);
}

/** Record one symbol's day volume from a Schwab snapshot. Returns true when stored. */
export function recordPcrSnapshot(args: {
  symbol: string;
  putVol: number;
  callVol: number;
  provider: string;
  capturedAtMs: number;
}): boolean {
  try {
    if (args.provider !== "schwab") return false;
    if (!Number.isFinite(args.putVol) || !Number.isFinite(args.callVol) || args.putVol < 0 || args.callVol < 0) return false;
    if (args.putVol === 0 && args.callVol === 0) return false; // nothing observed (failed or pre-open), not a zero day
    const date = etDate(args.capturedAtMs);
    if (!isTradingDay(date)) return false;
    const open = sessionOpenMs(date);
    if (open == null || args.capturedAtMs < open) return false;
    const complete = isCompleteSessionSnapshot(args.capturedAtMs, sessionCloseMs(date)) ? 1 : 0;
    sqlite.prepare(`
      INSERT INTO flow_pcr_daily (symbol, session_date, put_vol, call_vol, provider, captured_at, complete)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, session_date) DO UPDATE SET
        put_vol = excluded.put_vol, call_vol = excluded.call_vol, provider = excluded.provider,
        captured_at = excluded.captured_at, complete = MAX(flow_pcr_daily.complete, excluded.complete)
      WHERE excluded.captured_at >= flow_pcr_daily.captured_at
    `).run(args.symbol, date, args.putVol, args.callVol, args.provider, args.capturedAtMs, complete);
    return true;
  } catch (e) {
    console.warn("[pcrHistoryStore] record failed:", (e as Error).message);
    return false;
  }
}

/** Completed Schwab sessions strictly before `beforeDate`, oldest first. */
export function loadPcrHistory(symbol: string, beforeDate: string, limit = PCR_HISTORY_WINDOW): PcrDay[] {
  try {
    const rows = sqlite.prepare(`
      SELECT session_date AS date, put_vol AS putVol, call_vol AS callVol
      FROM flow_pcr_daily
      WHERE symbol = ? AND session_date < ? AND complete = 1 AND provider = 'schwab'
      ORDER BY session_date DESC LIMIT ?
    `).all(symbol, beforeDate, limit) as PcrDay[];
    return rows.reverse();
  } catch (e) {
    console.warn("[pcrHistoryStore] load failed:", (e as Error).message);
    return [];
  }
}
