// server/protocolReplay.ts
//
// Feeds the protocol replay (shared/protocolReplay.ts): keeps the index's 1-minute regular-session bars in
// SQLite as Schwab serves them (ten sessions per request), so the replayed span grows by a session a day past
// what one request returns, and runs the replay over everything stored. Read-only towards the market: no
// message, no order. The demo edition does not replay: its bars are simulated and a record of them means nothing.

import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";
import { getPriceHistory } from "./schwab";
import { etDate, etClock, sessionCloseMinutes, REGULAR_OPEN_MIN } from "./exchangeCalendar";
import { dailyBarEtDate } from "../shared/macroCalendar";
import { replaySession, combineReplays, sessionsOf, replayAnswer, REPLAY_MIN_COVERAGE, type ReplayResult, type SessionReplay } from "../shared/protocolReplay";
import { PROTOCOL_BOOK_VERSION } from "../shared/protocols";
import type { DayBar, IntraBar } from "../shared/levelBoard";

const SYMBOL = "$SPX";
const CACHE_MS = 30 * 60_000;
const NEG_CACHE_MS = 60_000;
const KEEP_MS = 400 * 86_400_000;
/** A finished session's replay never changes while its bars, the daily bars before it and the book stay the same: kept per date. */
const sessionMemo = new Map<string, { sig: string; out: SessionReplay }>();

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS index_minute_bars (
    symbol TEXT NOT NULL, t INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    PRIMARY KEY (symbol, t)
  );
`);

export interface ProtocolReplayView {
  state: "ok" | "unavailable";
  reason: string | null;
  /** When this replay was computed. */
  asOfMs: number;
  /** Why the newest bars could not be fetched this time, when the replay ran on stored bars alone. */
  refreshNote: string | null;
  answer: string;
  replay: ReplayResult | null;
  limits: string[];
}

const LIMITS = [
  "A replay is not the live record and is not added to it.",
  "The replay uses the close of each completed 1-minute bar as the price; the live desk reads a live price every 60 seconds.",
  "Only prior-day, prior-week, pivot and opening-range levels are replayed. Sweeps of option landmarks (magnet below, straddle low) need past option chains, which are not stored.",
  "The wall rule is not replayed: it needs the option wall, the tech read and the VIX read as they were at each minute.",
  "Arms on the same or neighbouring days are not independent events. Counts only; a replay never makes a rule tested.",
  `A session is replayed only with at least ${Math.round(REPLAY_MIN_COVERAGE * 100)}% of its 1-minute bars, the daily bar of the session before it, and a release calendar that covers it; others are listed as not replayed. An arm with a minute missing before its outcome is not graded.`,
];

let cache: { at: number; view: ProtocolReplayView } | null = null;
let inFlight: Promise<ProtocolReplayView> | null = null;

function regular(t: number): boolean {
  const c = etClock(t);
  const close = sessionCloseMinutes(c.date);
  return close != null && c.minutes >= REGULAR_OPEN_MIN && c.minutes < close;
}

async function compute(nowMs: number): Promise<ProtocolReplayView> {
  const base = { asOfMs: nowMs, limits: LIMITS };
  if (editionFromEnv() === "demo") return { ...base, state: "unavailable", reason: "the replay is off in the demo edition: its bars are simulated", refreshNote: null, answer: "No replay in the demo edition.", replay: null };
  let refreshNote: string | null = null;
  try {
    const ph = await getPriceHistory(SYMBOL, "day", 10, "minute", 1, false);
    if (ph.dataState === "ok" && !ph.stale) {
      const up = sqlite.prepare(`INSERT OR REPLACE INTO index_minute_bars (symbol, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)`);
      const fin = (n: unknown) => typeof n === "number" && Number.isFinite(n);
      sqlite.transaction(() => {
        for (const c of ph.candles) {
          // A bar that may still be forming is left for the next read.
          if (![c.datetime, c.open, c.high, c.low, c.close].every(fin) || !regular(c.datetime) || nowMs - c.datetime < 120_000) continue;
          up.run(SYMBOL, c.datetime, c.open, c.high, c.low, c.close);
        }
      })();
      sqlite.prepare(`DELETE FROM index_minute_bars WHERE symbol = ? AND t < ?`).run(SYMBOL, nowMs - KEEP_MS);
    } else refreshNote = `newest 1-minute bars not fetched (${ph.dataState}${ph.stale ? ", stale" : ""}${ph.reason ? `: ${ph.reason}` : ""}); stored bars are used`;
  } catch (e: any) {
    refreshNote = `newest 1-minute bars not fetched (${String(e?.message ?? e).slice(0, 100)}); stored bars are used`;
  }
  const minute: IntraBar[] = (sqlite.prepare(`SELECT t, o, h, l, c FROM index_minute_bars WHERE symbol = ? ORDER BY t ASC`).all(SYMBOL) as any[])
    .map((r) => ({ t: r.t, open: r.o, high: r.h, low: r.l, close: r.c }));
  if (!minute.length) return { ...base, state: "unavailable", reason: refreshNote ?? "no 1-minute index bars stored yet", refreshNote, answer: "No past session could be replayed yet.", replay: null };
  const dh = await getPriceHistory(SYMBOL, "year", 2, "daily", 1);
  const daily: DayBar[] = (dh.candles ?? []).map((c) => ({ date: dailyBarEtDate(c.datetime, etDate), open: c.open, high: c.high, low: c.low, close: c.close }));
  if (!daily.length) return { ...base, state: "unavailable", reason: `no daily index bars for the levels${dh.reason ? `: ${dh.reason}` : ""}`, refreshNote, answer: "No past session could be replayed: the daily bars the levels come from were not read.", replay: null };
  if (dh.stale || dh.dataState !== "ok") refreshNote = [refreshNote, `daily bars for the levels are ${dh.stale ? "a stale copy" : dh.dataState}${dh.reason ? ` (${dh.reason})` : ""}`].filter(Boolean).join("; ");
  const outs: SessionReplay[] = [];
  for (const [date, bars] of sessionsOf(minute)) {
    // What a session's replay depends on: its own bars, the daily bars before it, and the book.
    const before = daily.filter((b) => b.date < date);
    const lastD = before[before.length - 1];
    const sig = `${PROTOCOL_BOOK_VERSION}|${bars.length}|${bars[bars.length - 1].t}|${before.length}|${lastD ? `${lastD.date}:${lastD.high}:${lastD.low}:${lastD.close}` : "none"}`;
    const hit = sessionMemo.get(date);
    if (hit && hit.sig === sig) { outs.push(hit.out); continue; }
    const out = replaySession(date, bars, daily, nowMs);
    // A session still in progress is not kept: it becomes replayable at the close.
    if (out.skipped !== "session still in progress") sessionMemo.set(date, { sig, out });
    outs.push(out);
    // Yield between sessions: a first run over many stored sessions must not hold the event loop.
    await new Promise<void>((r) => setImmediate(r));
  }
  const replay = combineReplays(outs);
  return { ...base, state: "ok", reason: null, refreshNote, answer: replayAnswer(replay), replay };
}

export async function getProtocolReplay(nowMs: number = Date.now()): Promise<ProtocolReplayView> {
  if (cache && nowMs - cache.at < (cache.view.state === "ok" ? CACHE_MS : NEG_CACHE_MS)) return cache.view;
  if (inFlight) return inFlight;
  inFlight = compute(nowMs).then((view) => { cache = { at: nowMs, view }; return view; }).finally(() => { inFlight = null; });
  return inFlight;
}
