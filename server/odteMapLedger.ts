// server/odteMapLedger.ts
//
// Stores the day's 0DTE map (the first map taken in the regular session is
// the morning plan; the latest is kept too) and, after the close, the settle
// evaluation against the morning plan (shared/odteSettle.ts). A one-minute
// timer runs the settle between 16:06 and 16:45 ET on session days. The
// demo edition stores nothing (read-only) and reports an empty ledger.

import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";
import { etDate, REGULAR_OPEN_MIN, sessionCloseMinutes } from "./exchangeCalendar";
import { composeOdteMap, type OdteMap, type ForwardLike } from "../shared/odteMap";
import { evaluateSettle, tallySettles, type SettleEvaluation } from "../shared/odteSettle";
import { settleFromCandles } from "./odteSettleInputs";

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS odte_map_days (
    date_et TEXT NOT NULL,
    symbol TEXT NOT NULL,
    first_at INTEGER,
    first_json TEXT,
    last_at INTEGER,
    last_json TEXT,
    settled_at INTEGER,
    settle_json TEXT,
    PRIMARY KEY (date_et, symbol)
  );
`);

const SETTLE_WINDOW_MIN: [number, number] = [16 * 60 + 6, 16 * 60 + 45];

export interface MapDayRow {
  dateEt: string;
  symbol: string;
  firstAt: number | null;
  first: OdteMap | null;
  lastAt: number | null;
  last: OdteMap | null;
  settledAt: number | null;
  settle: SettleEvaluation | null;
}

function parse<T>(s: unknown): T | null {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function rowOf(r: any): MapDayRow {
  return {
    dateEt: r.date_et, symbol: r.symbol,
    firstAt: r.first_at ?? null, first: parse<OdteMap>(r.first_json),
    lastAt: r.last_at ?? null, last: parse<OdteMap>(r.last_json),
    settledAt: r.settled_at ?? null, settle: parse<SettleEvaluation>(r.settle_json),
  };
}

function etMinutes(ms: number): number {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/**
 * Keep the day's map: the first one taken during the regular session is the
 * morning plan and never overwritten; the latest replaces the previous latest.
 * Maps composed outside the session or without a priced gamma are not kept.
 */
export function rememberMap(map: OdteMap, nowMs = Date.now()): { kept: boolean; why: string } {
  if (editionFromEnv() === "demo") return { kept: false, why: "demo edition keeps no ledger" };
  if (map.dataState !== "ok") return { kept: false, why: `map not kept: ${map.dataState}` };
  const date = etDate(nowMs);
  if (map.dateEt !== date) return { kept: false, why: "map is not for today" };
  const close = sessionCloseMinutes(date);
  const m = etMinutes(nowMs);
  if (close == null || m < REGULAR_OPEN_MIN || m >= close) return { kept: false, why: "outside the regular session" };
  const json = JSON.stringify(map);
  sqlite.prepare(`
    INSERT INTO odte_map_days (date_et, symbol, first_at, first_json, last_at, last_json)
    VALUES (@d, @s, @t, @j, @t, @j)
    ON CONFLICT(date_et, symbol) DO UPDATE SET last_at = excluded.last_at, last_json = excluded.last_json
  `).run({ d: date, s: map.symbol, t: nowMs, j: json });
  return { kept: true, why: "kept" };
}

export function getMapDay(dateEt: string, symbol: string): MapDayRow | null {
  const r = sqlite.prepare("SELECT * FROM odte_map_days WHERE date_et = @d AND symbol = @s").get({ d: dateEt, s: symbol });
  return r ? rowOf(r) : null;
}

export function listSettled(symbol: string, limit = 60): MapDayRow[] {
  const rows = sqlite.prepare("SELECT * FROM odte_map_days WHERE symbol = @s AND settle_json IS NOT NULL ORDER BY date_et DESC LIMIT @n").all({ s: symbol, n: limit }) as any[];
  return rows.map(rowOf);
}

/** Record the settle for a day against its morning plan. Idempotent: a settled day is left alone. */
export function recordSettle(dateEt: string, symbol: string, inputs: { settle: number; sessionHigh: number; sessionLow: number }, nowMs = Date.now()): { ok: boolean; why: string; evaluation?: SettleEvaluation } {
  const day = getMapDay(dateEt, symbol);
  if (!day || !day.first) return { ok: false, why: "no morning map for that day" };
  if (day.settle) return { ok: false, why: "already settled" };
  if (!(inputs.settle > 0) || !(inputs.sessionHigh >= inputs.sessionLow)) return { ok: false, why: "settle inputs incomplete" };
  const evaluation = evaluateSettle(day.first, inputs);
  sqlite.prepare("UPDATE odte_map_days SET settled_at = @t, settle_json = @j WHERE date_et = @d AND symbol = @s").run({ t: nowMs, j: JSON.stringify(evaluation), d: dateEt, s: symbol });
  return { ok: true, why: "settled", evaluation };
}

/** The ledger for the caller's edition: zone outcomes and zone tallies only in the personal edition. */
export function ledgerSummary(symbol: string, edition = editionFromEnv()) {
  const rows = listSettled(symbol, 250);
  const evals = rows.map((r) => r.settle!).filter(Boolean);
  const personal = edition === "personal";
  return {
    symbol,
    tally: tallySettles(evals, personal),
    recent: rows.slice(0, 10).map((r) => ({
      dateEt: r.dateEt, settle: r.settle!.settle,
      lesson: personal ? r.settle!.lesson : (r.settle!.lessonLevels ?? r.settle!.lesson.split("; dip zone")[0]),
      pin: r.first?.landmarks.pin ?? null, range: r.first ? [r.first.range.low, r.first.range.high] : null,
    })),
    edition,
    note: edition === "demo" ? "the demo keeps no ledger" : "settle is the last regular-session print; the morning plan is the map taken at 09:35 ET (or the first one after the open)",
  };
}

// ─── Settle job ─────────────────────────────────────────────────────────

export interface SettleDeps {
  /** Today's regular-session candles (Schwab price history, minute bars). */
  getPriceHistory: (symbol: string, periodType: string, period: number, frequencyType: string, frequency: number, extended: boolean) => Promise<any>;
}

export async function settleToday(symbol: string, deps: SettleDeps, nowMs = Date.now()): Promise<{ ok: boolean; why: string }> {
  const date = etDate(nowMs);
  const day = getMapDay(date, symbol);
  if (!day || !day.first) return { ok: false, why: "no morning map today" };
  if (day.settle) return { ok: false, why: "already settled" };
  const hist = await deps.getPriceHistory(symbol, "day", 1, "minute", 1, false).catch(() => null);
  const s = settleFromCandles(hist?.candles ?? [], nowMs);
  if (!s) return { ok: false, why: "no regular-session candles for today" };
  const out = recordSettle(date, symbol, s, nowMs);
  return { ok: out.ok, why: out.why };
}

const MORNING_WINDOW_MIN: [number, number] = [9 * 60 + 35, 9 * 60 + 50];

/** Take the morning plan at 09:35 ET if nothing was kept yet (the route also keeps the first map requested after the open). */
export async function takeMorningMap(symbol: string, nowMs = Date.now()): Promise<{ ok: boolean; why: string }> {
  const date = etDate(nowMs);
  const day = getMapDay(date, symbol);
  if (day?.first) return { ok: false, why: "already have the morning map" };
  const { buildOdteForward } = await import("./odteForward");
  const fwd = await buildOdteForward(symbol, nowMs);
  if (fwd.status !== 200) return { ok: false, why: `forward ${fwd.status}: ${fwd.body?.reason ?? fwd.body?.error ?? ""}` };
  const map = composeOdteMap(fwd.body, { edition: "personal" });
  const kept = rememberMap(map, nowMs);
  return { ok: kept.kept, why: kept.why };
}

let timer: NodeJS.Timeout | null = null;
export function startOdteMapLedger(symbols: string[] = ["$SPX"]): void {
  if (timer || editionFromEnv() === "demo") return;
  timer = setInterval(async () => {
    const now = Date.now();
    const m = etMinutes(now);
    if (sessionCloseMinutes(etDate(now)) == null) return;
    try {
      if (m >= MORNING_WINDOW_MIN[0] && m <= MORNING_WINDOW_MIN[1]) {
        for (const s of symbols) {
          const r = await takeMorningMap(s, now);
          if (r.ok) console.log(`[odte-map] morning map kept ${s} ${etDate(now)}`);
        }
      }
      if (m >= SETTLE_WINDOW_MIN[0] && m <= SETTLE_WINDOW_MIN[1]) {
        const deps = await import("./schwab");
        for (const s of symbols) {
          const r = await settleToday(s, deps, now);
          if (r.ok) console.log(`[odte-map] settled ${s} ${etDate(now)}`);
        }
      }
    } catch (e: any) {
      console.warn(`[odte-map] tick failed: ${e?.message ?? e}`);
    }
  }, 60_000);
  (timer as any).unref?.();
}

/** Compose and remember in one step (the route). */
export function composeAndRemember(forward: ForwardLike, edition: "personal" | "investor" | "demo", nowMs = Date.now()): { map: OdteMap; kept: boolean; why: string } {
  // The ledger always evaluates the full map (zones included) so the owner's
  // personal zones are graded; the served map follows the caller's edition.
  const full = composeOdteMap(forward, { edition: "personal" });
  const kept = rememberMap(full, nowMs);
  const map = edition === "personal" ? full : composeOdteMap(forward, { edition });
  return { map, kept: kept.kept, why: kept.why };
}
