// server/protocolEngine.ts
//
// PROTOCOL LOG AND LEVEL-HIT LOG. Every minute of the regular session: read the level board
// (server/deskBoard.ts), record which board levels each ticker crossed since the last read, and run the
// protocol book (shared/protocols.ts) on the index. A protocol that arms is logged with the conditions that
// armed it and the book version, then graded after its horizon against 1-minute index bars.
//
// Log and grade only. Nothing here sends a message or an order. The demo edition stores nothing.

import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";
import { getPriceHistory } from "./schwab";
import { buildDeskBoard, intraBars } from "./deskBoard";
import { isRegularSessionOpen, sessionCloseMinutes, REGULAR_OPEN_MIN, etClock } from "./exchangeCalendar";
import { etWallToUtcMs } from "./validationMath";
import { minutesToNextTier1 } from "../shared/macroCalendar";
import {
  PROTOCOL_BOOK_VERSION, PROTOCOL_MIN_GRADED, protocolBook, evalProtocols, gradeProtocol, protocolRecord, levelHits, protocolsWatching,
  type ProtocolCtx, type ProtocolEval, type ProtocolRecord, type ProtocolDef,
} from "../shared/protocols";
import type { IntraBar } from "../shared/levelBoard";

const TICK_MS = 60_000;
const GRADE_MS = 5 * 60_000;
const UNGRADED_AFTER_MS = 2 * 86_400_000;
const HIT_KEEP = 500;

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS protocol_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_version TEXT NOT NULL,
    protocol TEXT NOT NULL,
    armed_at INTEGER NOT NULL,
    direction TEXT,
    entry REAL,
    level_label TEXT,
    level_price REAL,
    expect_price REAL,
    cancel_price REAL,
    horizon_min INTEGER,
    conditions_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at INTEGER,
    grade_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS protocol_events_status ON protocol_events (status, armed_at);
  CREATE TABLE IF NOT EXISTS level_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    level_key TEXT NOT NULL,
    level_label TEXT NOT NULL,
    level_price REAL NOT NULL,
    direction TEXT NOT NULL,
    price REAL NOT NULL
  );
`);

let timer: NodeJS.Timeout | null = null;
let graderTimer: NodeJS.Timeout | null = null;
let ticking = false;
let lastTickAt = 0;
let lastTickError: string | null = null;
let lastEval: { at: number; evals: ProtocolEval[] } | null = null;
const lastPrice = new Map<string, { price: number; date: string }>();

async function contextNow(nowMs: number): Promise<ProtocolCtx> {
  const board = await buildDeskBoard(nowMs);
  const spx = board.tickers.find((t) => t.symbol === "$SPX");
  const c = etClock(nowMs);
  const close = sessionCloseMinutes(c.date);
  const open = isRegularSessionOpen(nowMs);
  const cal = minutesToNextTier1(nowMs, etWallToUtcMs);
  let bars: IntraBar[] = [];
  if (open) { try { bars = (await intraBars("$SPX", nowMs)).bars.filter((b) => etClock(b.t).date === c.date); } catch { bars = []; } }
  return {
    nowMs, sessionOpen: open,
    minutesSinceOpen: open ? c.minutes - REGULAR_OPEN_MIN : null,
    minutesToClose: open && close != null ? close - c.minutes : null,
    // A stale index quote is not a price to arm on.
    spx: spx && spx.quoteState === "ok" ? spx.price : null,
    levels: spx?.levels ?? [],
    tech: board.tech.state, vix: board.vix.state,
    calendarKnown: cal.known, minutesToTier1: cal.minutes, minutesSinceTier1: cal.minutesSinceLast,
    bars,
  };
}

function hasOpenOrRecent(protocol: string, horizonMin: number, nowMs: number): boolean {
  const since = nowMs - Math.max(horizonMin, 30) * 60_000;
  return !!sqlite.prepare(`SELECT 1 FROM protocol_events WHERE protocol = ? AND (status = 'open' OR armed_at >= ?) LIMIT 1`).get(protocol, since);
}

async function tick(): Promise<void> {
  if (ticking) return;
  const now = Date.now();
  if (!isRegularSessionOpen(now)) return;
  ticking = true;
  try {
    const board = await buildDeskBoard(now);
    const today = etClock(now).date;
    // Level hits: every ticker with a live quote, against its own levels, since the last read of the same day.
    const ins = sqlite.prepare(`INSERT INTO level_hits (at, symbol, level_key, level_label, level_price, direction, price) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const t of board.tickers) {
      if (t.quoteState !== "ok" || t.price == null) continue;
      const prev = lastPrice.get(t.symbol);
      if (prev && prev.date === today) {
        for (const h of levelHits(prev.price, t.price, t.levels)) ins.run(now, t.symbol, h.key, h.label, h.price, h.direction, t.price);
      }
      lastPrice.set(t.symbol, { price: t.price, date: today });
    }
    sqlite.prepare(`DELETE FROM level_hits WHERE id <= (SELECT MAX(id) FROM level_hits) - ?`).run(HIT_KEEP);

    const ctx = await contextNow(now);
    const evals = evalProtocols(ctx);
    lastEval = { at: now, evals };
    for (const e of evals) {
      if (!e.armed) continue;
      if (hasOpenOrRecent(e.id, e.horizonMin ?? 30, now)) continue;
      const graded = e.direction != null && e.expectPrice != null && e.cancelPrice != null;
      sqlite.prepare(`INSERT INTO protocol_events (book_version, protocol, armed_at, direction, entry, level_label, level_price, expect_price, cancel_price, horizon_min, conditions_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(PROTOCOL_BOOK_VERSION, e.id, now, e.direction, e.entry, e.level?.label ?? null, e.level?.price ?? null, e.expectPrice, e.cancelPrice, e.horizonMin, JSON.stringify(e.conditions), graded ? "open" : "not_graded");
      console.log(`[protocols] ${e.id} armed at ${e.entry ?? "n/a"} (${PROTOCOL_BOOK_VERSION})`);
    }
    lastTickAt = now;
    lastTickError = null;
  } catch (e: any) {
    lastTickError = String(e?.message ?? e).slice(0, 120);
  } finally {
    ticking = false;
  }
}

let grading = false;
async function gradeTick(): Promise<void> {
  if (grading) return;
  grading = true;
  const now = Date.now();
  try {
    const due = sqlite.prepare(`SELECT * FROM protocol_events WHERE status = 'open' ORDER BY armed_at ASC LIMIT 40`).all() as any[];
    if (!due.length) return;
    const ph = await getPriceHistory("$SPX", "day", 2, "minute", 1, false);
    const usable = ph.dataState === "ok" && !ph.stale;
    const bars: IntraBar[] = usable ? (ph.candles ?? []).map((c) => ({ t: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close })) : [];
    for (const r of due) {
      const giveUp = now - r.armed_at > UNGRADED_AFTER_MS;
      if (!usable) {
        if (giveUp) sqlite.prepare(`UPDATE protocol_events SET status = 'ungraded', grade_reason = ?, resolved_at = ? WHERE id = ?`).run(`minute bars ${ph.dataState}${ph.stale ? " (stale)" : ""}: ${ph.reason ?? "no reason given"}`, now, r.id);
        continue;
      }
      const g = gradeProtocol({ direction: r.direction, expectPrice: r.expect_price, cancelPrice: r.cancel_price, armedAt: r.armed_at, horizonMin: r.horizon_min }, bars, now);
      if (g.status === "open") continue;
      if (g.status === "ungraded" && !giveUp) continue;
      sqlite.prepare(`UPDATE protocol_events SET status = ?, grade_reason = ?, resolved_at = ? WHERE id = ?`).run(g.status, g.reason, g.at ?? now, r.id);
    }
  } catch (e: any) {
    console.warn(`[protocols] grade failed: ${e?.message ?? e}`);
  } finally {
    grading = false;
  }
}

export function startProtocolEngine(): void {
  if (timer) return;
  if (editionFromEnv() === "demo") return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  graderTimer = setInterval(() => { void gradeTick(); }, GRADE_MS);
  (timer as any).unref?.(); (graderTimer as any).unref?.();
  setTimeout(() => { void tick(); void gradeTick(); }, 25_000);
}

export interface ProtocolView extends ProtocolDef {
  armedNow: boolean;
  conditions: ProtocolEval["conditions"];
  entry: number | null; expectPrice: number | null; cancelPrice: number | null;
  record: ProtocolRecord;
}
export interface ProtocolLog {
  bookVersion: string;
  minGraded: number;
  edition: string;
  running: boolean;
  sessionOpen: boolean;
  evaluatedAt: number | null;
  lastTickError: string | null;
  protocols: ProtocolView[];
  recent: Array<{ id: number; protocol: string; armedAt: number; entry: number | null; levelLabel: string | null; levelPrice: number | null; expectPrice: number | null; cancelPrice: number | null; status: string; reason: string | null }>;
  hits: Array<{ at: number; symbol: string; label: string; levelPrice: number; direction: string; price: number; watchedBy: string[] }>;
  note: string;
}

export async function getProtocolLog(nowMs: number = Date.now()): Promise<ProtocolLog> {
  const book = protocolBook();
  // The engine's own evaluation when it is fresh; otherwise evaluate now so the conditions shown are current.
  let evals = lastEval && nowMs - lastEval.at < 2 * TICK_MS ? lastEval.evals : null;
  let evaluatedAt = evals ? lastEval!.at : null;
  if (!evals) { evals = evalProtocols(await contextNow(nowMs)); evaluatedAt = nowMs; }
  const rows = sqlite.prepare(`SELECT protocol, status FROM protocol_events WHERE book_version = ?`).all(PROTOCOL_BOOK_VERSION) as Array<{ protocol: string; status: string }>;
  const protocols: ProtocolView[] = book.map((p) => {
    const e = evals!.find((x) => x.id === p.id)!;
    return {
      ...p, armedNow: e.armed, conditions: e.conditions, entry: e.entry, expectPrice: e.expectPrice, cancelPrice: e.cancelPrice,
      record: protocolRecord(rows.filter((r) => r.protocol === p.id).map((r) => r.status), p.graded),
    };
  });
  const recent = (sqlite.prepare(`SELECT * FROM protocol_events ORDER BY armed_at DESC LIMIT 20`).all() as any[]).map((r) => ({
    id: r.id, protocol: r.protocol, armedAt: r.armed_at, entry: r.entry, levelLabel: r.level_label, levelPrice: r.level_price,
    expectPrice: r.expect_price, cancelPrice: r.cancel_price, status: r.status, reason: r.grade_reason,
  }));
  const hits = (sqlite.prepare(`SELECT * FROM level_hits ORDER BY at DESC, id DESC LIMIT 30`).all() as any[]).map((r) => ({
    at: r.at, symbol: r.symbol, label: r.level_label, levelPrice: r.level_price, direction: r.direction, price: r.price,
    watchedBy: r.symbol === "$SPX" ? protocolsWatching(r.level_key, book) : [],
  }));
  return {
    bookVersion: PROTOCOL_BOOK_VERSION, minGraded: PROTOCOL_MIN_GRADED, edition: editionFromEnv(),
    running: timer != null, sessionOpen: isRegularSessionOpen(nowMs), evaluatedAt, lastTickError,
    protocols, recent, hits,
    note: "Each protocol is a hand-set rule taken from the desk owner's description of his own read. None has been tested: the record starts at zero and shows counts only. A protocol arming is a condition being met, not a forecast. The desk places no orders.",
  };
}
