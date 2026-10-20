// server/researchStore.ts
//
// THE RESEARCH FOUNDATION the desk did not have: its own history.
//
// 1. Chain snapshots. Once per session after the close, every scanned
//    name's option chain (45 DTE) is flattened to compact rows and stored
//    gzipped in SQLite. In a few months the setup rules can be replayed and
//    swept on real stored chains instead of trusted on a walk-forward alone.
//    Point-in-time by construction: what Schwab served at that close.
// 2. Event replay. What the index did on each tier-1 release day, from the
//    daily bars Schwab serves, beside the calendar's coverage note. Reads
//    history; does not forecast.
//
// Personal and investor editions store snapshots; the demo stores nothing
// and serves the sample chain's replay. Budget: one chain call per symbol
// per day, after the close.

import { gzipSync, gunzipSync } from "node:zlib";
import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";
import { getOptionChain, getPriceHistory } from "./schwab";
import { flattenSchwabChain } from "./schwabChainRows";
import { getFlowConfig } from "./flowConfig";
import { etParts } from "./validationMath";
import { isRegularSessionOpen } from "./exchangeCalendar";
import { MACRO_EVENTS, MACRO_COVERAGE, MACRO_CALENDAR_VALID_THROUGH } from "../shared/macroCalendar";
import { eventReactions, summarizeReactions, type EventReaction, type EventSummary } from "../shared/eventReplay";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS chain_snapshots (
    symbol TEXT NOT NULL,
    date_et TEXT NOT NULL,
    as_of INTEGER NOT NULL,
    spot REAL,
    contracts INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    rows_gz BLOB NOT NULL,
    PRIMARY KEY (symbol, date_et)
  );
`);

const SNAPSHOT_DTE = 45;
const CHECK_MS = 5 * 60_000;
const SNAPSHOT_AFTER_MIN = 16 * 60 + 10; // 16:10 ET
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRunAt = 0;
let lastError: string | null = null;

/** Compact row: [side, expiry, dte, strike, bid, ask, last, volume, oi, iv, delta, gamma]. */
type Row = [string, string, number, number, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null];

function universe(): string[] {
  const cfg = getFlowConfig();
  return Array.from(new Set(["$SPX", ...cfg.priority, ...cfg.watchlist].map((s) => (s === "SPX" ? "$SPX" : s))));
}

async function snapshotOne(symbol: string, dateEt: string): Promise<void> {
  const have = sqlite.prepare(`SELECT 1 FROM chain_snapshots WHERE symbol = ? AND date_et = ?`).get(symbol, dateEt);
  if (have) return;
  const chain = await getOptionChain(symbol, SNAPSHOT_DTE);
  if ("error" in chain) throw new Error(`${symbol}: ${chain.error}${chain.reason ? ` (${chain.reason})` : ""}`);
  const rows: Row[] = flattenSchwabChain(chain).map((c) => [c.side, c.expiry, c.dte, c.strike, c.bid, c.ask, c.last, c.volume, c.openInterest, c.iv, c.delta, c.gamma]);
  const json = JSON.stringify(rows);
  const gz = gzipSync(Buffer.from(json));
  sqlite.prepare(`INSERT OR REPLACE INTO chain_snapshots (symbol, date_et, as_of, spot, contracts, bytes, rows_gz) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(symbol, dateEt, chain.asOfMs ?? Date.now(), chain.underlying?.last ?? null, rows.length, gz.length, gz);
}

async function tick(): Promise<void> {
  if (running) return;
  const now = Date.now();
  const p = etParts(now);
  const mins = p.h * 60 + p.mi;
  // After the close on a session day only (the exchange calendar says which days had a session).
  if (mins < SNAPSHOT_AFTER_MIN || isRegularSessionOpen(now) || !isRegularSessionOpen(now - (mins - 12 * 60) * 60_000)) return;
  running = true;
  try {
    for (const sym of universe()) {
      try { await snapshotOne(sym, p.ymd); }
      catch (e: any) { lastError = String(e?.message ?? e).slice(0, 120); }
    }
    lastRunAt = now;
  } finally { running = false; }
}

export function startResearchStore(): void {
  if (timer || editionFromEnv() === "demo") return;
  timer = setInterval(() => { void tick(); }, CHECK_MS);
  (timer as any).unref?.();
  setTimeout(() => { void tick(); }, 30_000);
}

export function getSnapshotIndex(): { dataState: "ok" | "no_data"; edition: string; days: number; symbols: number; contracts: number; bytes: number; latest: string | null; earliest: string | null; lastRunAt: number | null; lastError: string | null; note: string } {
  const t = sqlite.prepare(`SELECT COUNT(DISTINCT date_et) AS days, COUNT(DISTINCT symbol) AS symbols, COALESCE(SUM(contracts), 0) AS contracts, COALESCE(SUM(bytes), 0) AS bytes, MAX(date_et) AS latest, MIN(date_et) AS earliest FROM chain_snapshots`).get() as any;
  const edition = editionFromEnv();
  return {
    dataState: t.days > 0 ? "ok" : "no_data", edition, days: t.days, symbols: t.symbols, contracts: t.contracts, bytes: t.bytes, latest: t.latest, earliest: t.earliest,
    lastRunAt: lastRunAt || null, lastError,
    note: edition === "demo" ? "Sample edition: no chains are stored." : `One 45-DTE chain per scanned name after each close, stored as it was served (point-in-time). ${t.days} session${t.days === 1 ? "" : "s"} so far; rule replays and sweeps become possible as this grows.`,
  };
}

/** Decoded rows for one stored chain (for a later replay engine). */
export function readSnapshot(symbol: string, dateEt: string): { rows: Row[]; asOf: number; spot: number | null } | null {
  const r = sqlite.prepare(`SELECT as_of, spot, rows_gz FROM chain_snapshots WHERE symbol = ? AND date_et = ?`).get(symbol, dateEt) as any;
  if (!r) return null;
  return { rows: JSON.parse(gunzipSync(r.rows_gz).toString()), asOf: r.as_of, spot: r.spot };
}

// ─── Event replay ───────────────────────────────────────────────────────

const replayCache = new Map<string, { at: number; data: EventReplay }>();
const REPLAY_CACHE_MS = 6 * 3600_000;

export interface EventReplay {
  symbol: string;
  asOf: number;
  dataState: "ok" | "partial" | "unavailable" | "no_data";
  reason: string | null;
  bars: number;
  earliestBar: string | null;
  coverage: Record<string, string>;
  validThrough: string;
  rows: EventReaction[];
  summary: EventSummary[];
  note: string;
}

export async function getEventReplay(symbol = "$SPX"): Promise<EventReplay> {
  const key = symbol.toUpperCase();
  const hit = replayCache.get(key);
  if (hit && Date.now() - hit.at < REPLAY_CACHE_MS) return hit.data;
  const now = Date.now();
  const today = etParts(now).ymd;
  let bars: Array<{ date: string; open: number; high: number; low: number; close: number }> = [];
  let state: EventReplay["dataState"] = "ok", reason: string | null = null;
  try {
    const ph = await getPriceHistory(key, "year", 1, "daily", 1, false);
    bars = (ph.candles ?? []).map((c) => ({ date: etParts(c.datetime).ymd, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (!bars.length) { state = ph.dataState === "unavailable" ? "unavailable" : "no_data"; reason = ph.reason ?? "no daily bars"; }
  } catch (e: any) { state = "unavailable"; reason = String(e?.message ?? e).slice(0, 120); }
  const rows = eventReactions(bars, MACRO_EVENTS, today);
  const priced = rows.filter((r) => r.state === "ok" || r.state === "partial").length;
  const past = rows.filter((r) => r.state !== "future").length;
  if (state === "ok" && past > 0 && priced < past) state = "partial";
  const out: EventReplay = {
    symbol: key, asOf: now, dataState: state, reason: reason ?? (state === "partial" ? `${past - priced} past event${past - priced === 1 ? "" : "s"} without a bar in the one-year history` : null),
    bars: bars.length, earliestBar: bars[0]?.date ?? null, coverage: MACRO_COVERAGE, validThrough: MACRO_CALENDAR_VALID_THROUGH,
    rows, summary: summarizeReactions(rows),
    note: "What the index did on each tier-1 release session, from daily bars: close over the prior close, the opening gap, the session range, and the next session. Reads the record; does not forecast. Coverage is stated per release; a release not loaded is absent, not zero.",
  };
  replayCache.set(key, { at: now, data: out });
  return out;
}
