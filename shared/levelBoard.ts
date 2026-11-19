// shared/levelBoard.ts
//
// The cross-ticker level board on the Trade Desk: for each ticker, the prices a chart reader marks by hand
// (prior day, prior week, prior month, today's open and opening range, classic pivots) plus, for the index,
// the day's option landmarks. Then two descriptive "cases" for the index: which levels sit above and below
// the price, in order. Pure functions; the server feeds them bars and quotes (server/deskBoard.ts).
//
// Nothing here is a forecast or an instruction. A case lists levels in the order price would meet them and
// names the first level on the other side. No odds are attached because none are measured.

import { etClock, REGULAR_OPEN_MIN, nextTradingDay, sessionCloseMinutes, isTradingDay } from "./exchangeCalendar";

export interface DayBar { date: string; open: number; high: number; low: number; close: number }
export interface IntraBar { t: number; open: number; high: number; low: number; close: number }
export type LevelGroup = "today" | "prior day" | "week" | "month" | "pivot" | "options";
export interface BoardLevel { key: string; label: string; price: number; group: LevelGroup }

/** Minutes of the opening range (09:30 to 10:00 ET). */
export const OPENING_RANGE_MIN = 30;
/** Price counts as "at" a level within this fraction of the price (0.1%). */
export const AT_LEVEL_PCT = 0.001;
/** Levels closer together than this fraction of the price are shown as one line (0.05%). */
export const MERGE_PCT = 0.0005;
/** QQQ's day change minus SPY's, in percentage points, beyond which tech is called leading or lagging. Hand-set. */
export const TECH_LEAD_PTS = 0.25;
/** VIX day change, percent, beyond which it is called firm or soft. Hand-set. */
export const VIX_FIRM_PCT = 1;

const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const barOk = (b: { open: number; high: number; low: number; close: number }) => ok(b.open) && ok(b.high) && ok(b.low) && ok(b.close);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parse = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** Monday of the week holding an ISO date. */
export function weekStart(date: string): string {
  const ms = parse(date);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  return iso(ms - ((dow + 6) % 7) * 86_400_000);
}
/** "YYYY-MM" of the month before an ISO date's month. */
export function priorMonth(date: string): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * Levels from completed daily bars: the session before `todayEt`, the week before this one, the month before
 * this one, this week's and this month's first open, and the classic floor pivots of the prior session.
 * A bar dated `todayEt` (a session in progress) never counts as "prior".
 */
export function calendarLevels(daily: DayBar[], todayEt: string, opts: { pivots?: boolean } = {}): BoardLevel[] {
  const bars = daily.filter(barOk).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const done = bars.filter((b) => b.date < todayEt);
  const out: BoardLevel[] = [];
  const prior = done[done.length - 1];
  if (prior) {
    out.push({ key: "pdh", label: "prior-day high", price: prior.high, group: "prior day" });
    out.push({ key: "pdl", label: "prior-day low", price: prior.low, group: "prior day" });
    out.push({ key: "pdc", label: "prior-day close", price: prior.close, group: "prior day" });
    if (opts.pivots !== false) {
      const p = (prior.high + prior.low + prior.close) / 3;
      out.push({ key: "pp", label: "pivot", price: p, group: "pivot" });
      out.push({ key: "r1", label: "pivot R1", price: 2 * p - prior.low, group: "pivot" });
      out.push({ key: "s1", label: "pivot S1", price: 2 * p - prior.high, group: "pivot" });
    }
  }
  const ws = weekStart(todayEt);
  const pws = iso(parse(ws) - 7 * 86_400_000);
  const pw = done.filter((b) => b.date >= pws && b.date < ws);
  if (pw.length) {
    out.push({ key: "pwh", label: "prior-week high", price: Math.max(...pw.map((b) => b.high)), group: "week" });
    out.push({ key: "pwl", label: "prior-week low", price: Math.min(...pw.map((b) => b.low)), group: "week" });
    out.push({ key: "pwc", label: "prior-week close", price: pw[pw.length - 1].close, group: "week" });
  }
  const wk = bars.find((b) => b.date >= ws && b.date <= todayEt);
  if (wk) out.push({ key: "wo", label: "week open", price: wk.open, group: "week" });
  const pm = priorMonth(todayEt);
  const pmBars = done.filter((b) => b.date.slice(0, 7) === pm);
  if (pmBars.length) {
    out.push({ key: "pmh", label: "prior-month high", price: Math.max(...pmBars.map((b) => b.high)), group: "month" });
    out.push({ key: "pml", label: "prior-month low", price: Math.min(...pmBars.map((b) => b.low)), group: "month" });
    out.push({ key: "pmc", label: "prior-month close", price: pmBars[pmBars.length - 1].close, group: "month" });
  }
  const mo = bars.find((b) => b.date.slice(0, 7) === todayEt.slice(0, 7) && b.date <= todayEt);
  if (mo) out.push({ key: "mo", label: "month open", price: mo.open, group: "month" });
  return out;
}

/**
 * Levels from today's regular-session bars: the open, and the opening range once its 30 minutes are over.
 * Bars from another day or before 09:30 are ignored. The open is only read from a bar that starts at 09:30
 * (a feed that begins later would show a later price as the open), and the range only once a bar at or
 * after 10:00 exists, which shows the last bar inside the range is complete.
 */
export function sessionLevels(intra: IntraBar[], todayEt: string, nowMs: number): BoardLevel[] {
  const today = intra.filter(barOk).map((b) => ({ b, c: etClock(b.t) })).filter((x) => x.c.date === todayEt && x.c.minutes >= REGULAR_OPEN_MIN)
    .sort((a, b) => a.b.t - b.b.t);
  if (!today.length || today[0].c.minutes !== REGULAR_OPEN_MIN) return [];
  const out: BoardLevel[] = [{ key: "open", label: "today's open", price: today[0].b.open, group: "today" }];
  const orEnd = REGULAR_OPEN_MIN + OPENING_RANGE_MIN;
  const now = etClock(nowMs);
  const rangeOver = (now.date > todayEt || (now.date === todayEt && now.minutes >= orEnd)) && today.some((x) => x.c.minutes >= orEnd);
  const or = today.filter((x) => x.c.minutes < orEnd);
  if (rangeOver && or.length) {
    out.push({ key: "orh", label: "opening-range high", price: Math.max(...or.map((x) => x.b.high)), group: "today" });
    out.push({ key: "orl", label: "opening-range low", price: Math.min(...or.map((x) => x.b.low)), group: "today" });
  }
  return out;
}

/**
 * Levels closer together than MERGE_PCT of the price become one line. The line sits at the highest of them
 * and its label carries each level with its own price, so no level is shown at a price that is not its own.
 * Sorted high to low.
 */
export function mergeLevels(levels: BoardLevel[], price: number | null | undefined): BoardLevel[] {
  const sorted = levels.filter((l) => ok(l.price)).slice().sort((a, b) => b.price - a.price);
  const tol = ok(price) ? price * MERGE_PCT : 0;
  const groups: BoardLevel[][] = [];
  for (const l of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[g.length - 1].price - l.price) <= tol) g.push(l); else groups.push([l]);
  }
  return groups.map((g) => g.length === 1 ? { ...g[0] } : {
    ...g[0], key: g.map((l) => l.key).join("+"),
    label: g.every((l) => l.price === g[0].price) ? g.map((l) => l.label).join(" + ") : g.map((l) => `${l.label} ${fmt(l.price)}`).join(" + "),
  });
}

export interface Nearest { at: BoardLevel[]; above: BoardLevel[]; below: BoardLevel[] }
/** Levels at the price (within AT_LEVEL_PCT), above it nearest first, below it nearest first. */
export function nearestLevels(levels: BoardLevel[], price: number | null | undefined): Nearest {
  if (!ok(price)) return { at: [], above: [], below: [] };
  const tol = price * AT_LEVEL_PCT;
  const m = mergeLevels(levels, price);
  return {
    at: m.filter((l) => Math.abs(l.price - price) <= tol),
    above: m.filter((l) => l.price > price + tol).sort((a, b) => a.price - b.price),
    below: m.filter((l) => l.price < price - tol).sort((a, b) => b.price - a.price),
  };
}

const fmt = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
const named = (l: BoardLevel) => `${fmt(l.price)} (${l.label})`;

export interface DeskCase {
  side: "bull" | "bear";
  /** The first level on this side of the price. */
  trigger: BoardLevel | null;
  /** The next two levels beyond the trigger. */
  next: BoardLevel[];
  /** The first level on the other side of the price. */
  off: BoardLevel | null;
  text: string;
}

/** The levels above (bull) or below (bear) the price in the order price would meet them. Descriptive only. */
export function deskCase(levels: BoardLevel[], price: number | null | undefined, side: "bull" | "bear"): DeskCase {
  const n = nearestLevels(levels, price);
  const mine = side === "bull" ? n.above : n.below;
  const other = side === "bull" ? n.below : n.above;
  const trigger = mine[0] ?? null;
  const next = mine.slice(1, 3);
  const off = other[0] ?? null;
  const name = side === "bull" ? "Bull case" : "Bear case";
  if (!ok(price)) return { side, trigger: null, next: [], off: null, text: `${name}: no price read.` };
  if (!trigger) return { side, trigger, next, off, text: `${name}: no mapped level ${side === "bull" ? "above" : "below"} the price.` };
  const dir = side === "bull" ? "above" : "below";
  const nextTxt = next.length ? ` the next level${next.length > 1 ? "s" : ""} ${side === "bull" ? "up" : "down"} ${next.length > 1 ? "are" : "is"} ${next.map(named).join(" and ")}.` : ` no further mapped level ${side === "bull" ? "above" : "below"}.`;
  const offTxt = off ? ` The first level ${side === "bull" ? "under" : "over"} the price is ${named(off)}.` : "";
  return { side, trigger, next, off, text: `${name}: ${dir} ${named(trigger)}${nextTxt}${offTxt}` };
}

export interface RelRead { state: "leading" | "lagging" | "in line" | "unknown"; diffPts: number | null; text: string }
/** Tech against the broad market: QQQ's day change minus SPY's. */
export function techRead(qqqPct: number | null | undefined, spyPct: number | null | undefined): RelRead {
  if (typeof qqqPct !== "number" || typeof spyPct !== "number" || !Number.isFinite(qqqPct) || !Number.isFinite(spyPct)) {
    return { state: "unknown", diffPts: null, text: "Tech against the market: not read (a QQQ or SPY day change is missing)." };
  }
  const d = qqqPct - spyPct;
  const state = d >= TECH_LEAD_PTS ? "leading" : d <= -TECH_LEAD_PTS ? "lagging" : "in line";
  const s = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  return { state, diffPts: d, text: `QQQ ${s(qqqPct)} against SPY ${s(spyPct)}: tech ${state === "in line" ? "in line" : `${state} by ${Math.abs(d).toFixed(2)} percentage points`} (hand-set line: ${TECH_LEAD_PTS.toFixed(2)}).` };
}

export interface VixRead { state: "firm" | "soft" | "flat" | "unknown"; text: string }
/** VIX on the day: firm when up at least VIX_FIRM_PCT percent, soft when down at least that. */
export function vixRead(vixPct: number | null | undefined): VixRead {
  if (typeof vixPct !== "number" || !Number.isFinite(vixPct)) return { state: "unknown", text: "VIX on the day: not read." };
  const state = vixPct >= VIX_FIRM_PCT ? "firm" : vixPct <= -VIX_FIRM_PCT ? "soft" : "flat";
  return { state, text: `VIX ${vixPct >= 0 ? "+" : ""}${vixPct.toFixed(2)}% on the day: ${state} (hand-set line: ${VIX_FIRM_PCT}%).` };
}

/** One sentence for the top of the board: where the index sits between its nearest levels. */
export function boardAnswer(label: string, price: number | null | undefined, n: { at: BoardLevel[]; above: BoardLevel | null; below: BoardLevel | null }): string {
  if (!ok(price)) return `${label}: no price read, so no levels are placed.`;
  if (n.at.length) return `${label} ${fmt(price)} is at ${named(n.at[0])}.`;
  if (n.above && n.below) return `${label} ${fmt(price)} sits between ${named(n.below)} below and ${named(n.above)} above.`;
  if (n.above) return `${label} ${fmt(price)} is under every mapped level; the nearest is ${named(n.above)}.`;
  if (n.below) return `${label} ${fmt(price)} is over every mapped level; the nearest is ${named(n.below)}.`;
  return `${label} ${fmt(price)}: no levels were read.`;
}

/** The session the board is for: today until its close, else the next trading day. */
export function boardSession(nowMs: number): { forSession: string; sessionOpen: boolean; today: string } {
  const c = etClock(nowMs);
  const close = sessionCloseMinutes(c.date);
  const todayLive = isTradingDay(c.date) && close != null && c.minutes < close;
  return { forSession: todayLive ? c.date : nextTradingDay(c.date), sessionOpen: todayLive && c.minutes >= REGULAR_OPEN_MIN, today: c.date };
}
