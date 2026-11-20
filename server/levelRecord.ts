// server/levelRecord.ts
//
// Feeds the level record (shared/levelRecord.ts) from the same stored 1-minute index bars the protocol replay
// keeps (server/protocolReplay.ts refreshes them; this only reads). Read-only, no message, no order. Off in the
// demo edition: its bars are simulated.

import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";
import { getPriceHistory } from "./schwab";
import { etDate } from "./exchangeCalendar";
import { dailyBarEtDate } from "../shared/macroCalendar";
import { sessionsOf } from "../shared/protocolReplay";
import { sessionTouches, combineLevelRecord, levelRecordAnswer, LEVEL_RECORD_VERSION, type LevelRecord, type SessionTouches, type LevelTouch } from "../shared/levelRecord";
import type { DayBar, IntraBar } from "../shared/levelBoard";
import { getProtocolReplay } from "./protocolReplay";

const SYMBOL = "$SPX";
const CACHE_MS = 30 * 60_000;
const NEG_CACHE_MS = 60_000;

export interface LevelRecordView {
  state: "ok" | "unavailable";
  reason: string | null;
  asOfMs: number;
  answer: string;
  record: LevelRecord | null;
  /** The most recent touches, newest first, so a count can be checked against the tape. */
  recent: LevelTouch[];
  limits: string[];
}

const LIMITS = [
  "A record of what happened, in counts. It does not say a level will hold or break next time.",
  "Sessions next to each other in time are not independent events; a few sessions are far too few to read a tendency from.",
  "Only the first touch of each level in a session is counted. Levels close together are read separately, so one move can count once for each.",
  "The points are hand-set for the index at its current level and are the same for every level kind; a change of any number starts a new version of the record.",
  "Option levels (walls, gamma flip, straddle range) are not included: past option chains are not stored minute by minute.",
  "A session is read only with at least 95% of its 1-minute bars and the daily bar of the session before it; a touch with a minute missing before its outcome, or too near the close, is not graded.",
];

const memo = new Map<string, { sig: string; out: SessionTouches }>();
let cache: { at: number; view: LevelRecordView } | null = null;
let inFlight: Promise<LevelRecordView> | null = null;

async function compute(nowMs: number): Promise<LevelRecordView> {
  const base = { asOfMs: nowMs, limits: LIMITS, recent: [] as LevelTouch[] };
  if (editionFromEnv() === "demo") return { ...base, state: "unavailable", reason: "off in the demo edition: its bars are simulated", answer: "No level record in the demo edition.", record: null };
  // The replay owns the refresh of the stored minute bars; asking for it first means both read the same bars.
  try { await getProtocolReplay(nowMs); } catch { /* stored bars are read below either way */ }
  const minute: IntraBar[] = (sqlite.prepare(`SELECT t, o, h, l, c FROM index_minute_bars WHERE symbol = ? ORDER BY t ASC`).all(SYMBOL) as any[])
    .map((r) => ({ t: r.t, open: r.o, high: r.h, low: r.l, close: r.c }));
  if (!minute.length) return { ...base, state: "unavailable", reason: "no 1-minute index bars stored yet", answer: "No past session could be read yet.", record: null };
  const dh = await getPriceHistory(SYMBOL, "year", 2, "daily", 1);
  const daily: DayBar[] = (dh.candles ?? []).map((c) => ({ date: dailyBarEtDate(c.datetime, etDate), open: c.open, high: c.high, low: c.low, close: c.close }));
  if (!daily.length) return { ...base, state: "unavailable", reason: `no daily index bars for the levels${dh.reason ? `: ${dh.reason}` : ""}`, answer: "No past session could be read: the daily bars the levels come from were not read.", record: null };
  const outs: SessionTouches[] = [];
  for (const [date, bars] of sessionsOf(minute)) {
    const before = daily.filter((b) => b.date < date);
    const lastD = before[before.length - 1];
    const sig = `${LEVEL_RECORD_VERSION}|${bars.length}|${bars[bars.length - 1].t}|${before.length}|${lastD ? `${lastD.date}:${lastD.high}:${lastD.low}:${lastD.close}` : "none"}`;
    const hit = memo.get(date);
    if (hit && hit.sig === sig) { outs.push(hit.out); continue; }
    const out = sessionTouches(date, bars, daily, nowMs);
    if (out.skipped !== "session still in progress") memo.set(date, { sig, out });
    outs.push(out);
    await new Promise<void>((r) => setImmediate(r));
  }
  const record = combineLevelRecord(outs);
  const recent = outs.flatMap((o) => o.touches ?? []).sort((a, b) => b.touchedAt - a.touchedAt).slice(0, 40);
  return { ...base, state: "ok", reason: null, answer: levelRecordAnswer(record), record, recent };
}

export async function getLevelRecord(nowMs: number = Date.now()): Promise<LevelRecordView> {
  if (cache && nowMs - cache.at < (cache.view.state === "ok" ? CACHE_MS : NEG_CACHE_MS)) return cache.view;
  if (inFlight) return inFlight;
  inFlight = compute(nowMs).then((view) => { cache = { at: nowMs, view }; return view; }).finally(() => { inFlight = null; });
  return inFlight;
}
