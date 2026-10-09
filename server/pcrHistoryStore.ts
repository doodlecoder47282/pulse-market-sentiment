// server/pcrHistoryStore.ts
//
// Cumulative put/call volume per symbol per 30-minute bucket of each session,
// recorded from the Schwab chain snapshots the P/C flow panel already pulls
// (flow.ts). Feeds pcrHistory.pcrReadAtClock, which z-scores today's ratio
// against the symbol's own history AT THE SAME CLOCK TIME (SF-5).
//
// Rules:
//   - Only provider "schwab" rows are recorded or read (user rule: Schwab
//     only for market data; a CBOE snapshot never becomes history).
//   - One row per (symbol, ET session date, bucket); the latest snapshot in
//     the bucket replaces older ones, with its minute after the open. A
//     snapshot after the close (same ET date) is stored at the session
//     length: the full-session value.
//   - Snapshots before the 09:30 open or on a non-trading day are not
//     recorded: Schwab's day volume then still belongs to the prior session.
//   - Fail-soft: DB errors are logged and swallowed; a failed read returns an
//     empty history, which reads as "insufficient_history", never as a zone.

import { sqlite } from "./storage";
import { etDate, isTradingDay, sessionCloseMs, sessionOpenMs } from "./exchangeCalendar";
import { PCR_HISTORY_WINDOW, type PcrPoint } from "./pcrHistory";

const BUCKET_MIN = 30;

try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS flow_pcr_bucket (
      symbol TEXT NOT NULL,
      session_date TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      minute REAL NOT NULL,
      put_vol REAL NOT NULL,
      call_vol REAL NOT NULL,
      provider TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, session_date, bucket)
    );
  `);
} catch (e) {
  console.warn("[pcrHistoryStore] init failed:", (e as Error).message);
}

/** Minute of the session for a timestamp (null before the open / non-trading day); after the close = session length. */
export function sessionMinuteOf(ms: number): { date: string; minute: number; bucket: number } | null {
  const date = etDate(ms);
  if (!isTradingDay(date)) return null;
  const open = sessionOpenMs(date), close = sessionCloseMs(date);
  if (open == null || close == null || ms < open) return null;
  const len = (close - open) / 60_000;
  const minute = Math.min(len, (ms - open) / 60_000);
  const bucket = Math.min(Math.floor(minute / BUCKET_MIN), Math.max(0, Math.ceil(len / BUCKET_MIN) - 1));
  return { date, minute, bucket };
}

/** Record one symbol's cumulative day volume from a Schwab snapshot. Returns true when stored. */
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
    const at = sessionMinuteOf(args.capturedAtMs);
    if (!at) return false;
    sqlite.prepare(`
      INSERT INTO flow_pcr_bucket (symbol, session_date, bucket, minute, put_vol, call_vol, provider, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, session_date, bucket) DO UPDATE SET
        minute = excluded.minute, put_vol = excluded.put_vol, call_vol = excluded.call_vol,
        provider = excluded.provider, captured_at = excluded.captured_at
      WHERE excluded.captured_at >= flow_pcr_bucket.captured_at
    `).run(args.symbol, at.date, at.bucket, at.minute, args.putVol, args.callVol, args.provider, args.capturedAtMs);
    return true;
  } catch (e) {
    console.warn("[pcrHistoryStore] record failed:", (e as Error).message);
    return false;
  }
}

/** Stored points of the last `limit` Schwab sessions strictly before `beforeDate`. */
export function loadPcrSessions(symbol: string, beforeDate: string, limit = PCR_HISTORY_WINDOW): Array<{ date: string; points: PcrPoint[] }> {
  try {
    const dates = (sqlite.prepare(`
      SELECT DISTINCT session_date AS d FROM flow_pcr_bucket
      WHERE symbol = ? AND session_date < ? AND provider = 'schwab'
      ORDER BY session_date DESC LIMIT ?
    `).all(symbol, beforeDate, limit) as Array<{ d: string }>).map((r) => r.d);
    if (dates.length === 0) return [];
    const rows = sqlite.prepare(`
      SELECT session_date AS date, minute, put_vol AS putVol, call_vol AS callVol FROM flow_pcr_bucket
      WHERE symbol = ? AND provider = 'schwab' AND session_date >= ? AND session_date < ?
      ORDER BY session_date, minute
    `).all(symbol, dates[dates.length - 1], beforeDate) as Array<{ date: string } & PcrPoint>;
    const by = new Map<string, PcrPoint[]>();
    for (const r of rows) {
      const a = by.get(r.date) ?? [];
      a.push({ minute: r.minute, putVol: r.putVol, callVol: r.callVol });
      by.set(r.date, a);
    }
    return Array.from(by.entries()).map(([date, points]) => ({ date, points }));
  } catch (e) {
    console.warn("[pcrHistoryStore] load failed:", (e as Error).message);
    return [];
  }
}
