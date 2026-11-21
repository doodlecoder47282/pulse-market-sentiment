// shared/alerts.ts
// THE ALERT FEED. The desk already watches the board every minute in session, whether or not anyone has the
// app open: it writes down each board level a ticker crosses and each time one of the owner's rules arms.
// This turns those two logs into one newest-first list the app can show behind a bell and announce as they
// arrive. Nothing is configured by the user and nothing new is measured: every item is a row the desk logged.
// Each item says what happened, in counts and prices; none says what to do. Pure.
//
// WHAT COUNTS AS NEW is decided by storage row ids, never by anything derived from how far back the log was
// read. A joined line's first time and its "from before" mark both move as old rows slide out of the read
// window, so an identity built on them made one long run of crossings look new every minute.

export type AlertKind = "rule_armed" | "level_cross";
export interface AlertItem {
  /** For list rendering only. */
  id: string;
  at: number;
  kind: AlertKind;
  /** Storage id of the row behind the item: the arm's id, or the id of the newest crossing in the line. Rises as things happen. */
  seq: number;
  /** What the item is about, the same across reads: the arm, or the ticker and level. Used to space out announcements of one level. */
  subject: string;
  title: string;
  text: string;
  /** Announced when it arrives (a toast, and a device notification if allowed): rule arms and index crossings. The rest are listed only. */
  loud: boolean;
}

export interface AlertArm { id: number; protocol: string; armedAt: number; entry: number | null; levelLabel: string | null; levelPrice: number | null; status: string }
export interface AlertHit { at: number; firstAt: number; count: number; fromBefore: boolean; symbol: string; levelKey: string; lastRowId: number; label: string; levelPrice: number; direction: string; watchedBy: string[] }
/** The highest row id seen of each kind. */
export interface AlertSeen { arm: number; hit: number }

const px = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
const hhmm = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const bare = (sym: string) => sym.replace(/^[$/]/, "");
/** What became of an armed rule, in the log's own words. */
export const ARM_STATUS_TEXT: Record<string, string> = {
  open: "still open", expected: "since reached the rule's outcome price", cancelled: "since cancelled", neither: "since ended with neither", ungraded: "could not be graded",
};
/** Tickers whose crossings are announced. The others (SPY and QQQ repeat the index's levels) are listed only. */
export const LOUD_SYMBOLS = ["$SPX", "$VIX"];
/** One level is announced at most once in this long, however often the price crosses it. */
export const ALERT_QUIET_MS = 30 * 60_000;

export function buildAlerts(input: { arms: AlertArm[]; hits: AlertHit[]; names: Record<string, string> }): AlertItem[] {
  const out: AlertItem[] = [];
  for (const a of input.arms) {
    if (!Number.isFinite(a.armedAt)) continue;
    const name = input.names[a.protocol] ?? a.protocol;
    const where = a.entry != null && Number.isFinite(a.entry)
      ? ` with the index at ${px(a.entry)}${a.levelLabel && a.levelPrice != null ? `, at ${px(a.levelPrice)} (${a.levelLabel})` : ""}`
      : "";
    const then = ARM_STATUS_TEXT[a.status];
    out.push({
      id: `arm-${a.id}`, at: a.armedAt, kind: "rule_armed", seq: a.id, subject: `arm|${a.id}`, loud: true,
      title: `Rule armed: ${name}`,
      text: `All of its conditions were met at ${hhmm(a.armedAt)} ET${where}.${then ? ` Status: ${then}.` : ""}`,
    });
  }
  for (const h of input.hits) {
    if (!Number.isFinite(h.at) || !Number.isFinite(h.levelPrice)) continue;
    const sym = bare(h.symbol);
    const many = (h.count ?? 1) > 1;
    const text = many
      ? `Crossed ${px(h.levelPrice)} (${h.label}) ${h.fromBefore ? `at least ${h.count} times, from before ${hhmm(h.firstAt)}` : `${h.count} times from ${hhmm(h.firstAt)}`}, last ${h.direction}.`
      : `Crossed ${h.direction} through ${px(h.levelPrice)} (${h.label})${h.fromBefore ? "; earlier crossings may precede the log" : ""}.`;
    out.push({
      id: `hit-${h.symbol}-${h.levelKey}-${h.levelPrice}-${h.lastRowId}`, at: h.at, kind: "level_cross", seq: h.lastRowId,
      subject: `hit|${h.symbol}|${h.levelKey}|${h.levelPrice}`, loud: LOUD_SYMBOLS.includes(h.symbol),
      title: `${sym} crossed ${px(h.levelPrice)}`,
      text: text + (h.watchedBy.length ? ` Watched by: ${h.watchedBy.join("; ")}.` : ""),
    });
  }
  return out.sort((a, b) => b.at - a.at || b.seq - a.seq);
}

const kindKey = (k: AlertKind): keyof AlertSeen => (k === "rule_armed" ? "arm" : "hit");

/** The highest row id of each kind in a read. */
export function seenOf(items: AlertItem[]): AlertSeen {
  const s: AlertSeen = { arm: 0, hit: 0 };
  for (const i of items) { const k = kindKey(i.kind); if (i.seq > s[k]) s[k] = i.seq; }
  return s;
}

/** The later of two marks, kind by kind: a mark never moves back. */
export const laterSeen = (a: AlertSeen, b: AlertSeen): AlertSeen => ({ arm: Math.max(a.arm, b.arm), hit: Math.max(a.hit, b.hit) });

/**
 * A stored mark that lies beyond every row in the log belongs to a log that has since been reset (ids start
 * again from 1): it is dropped, or nothing would ever count as new again.
 */
export function validSeen(stored: AlertSeen, items: AlertItem[]): AlertSeen {
  const now = seenOf(items);
  return { arm: stored.arm > now.arm && items.some((i) => i.kind === "rule_armed") ? 0 : stored.arm, hit: stored.hit > now.hit && items.some((i) => i.kind === "level_cross") ? 0 : stored.hit };
}

/** Items with activity after the mark. A line whose level was crossed again since counts again. */
export const unreadCount = (items: AlertItem[], seen: AlertSeen) => items.filter((i) => i.seq > seen[kindKey(i.kind)]).length;

/**
 * What to announce when a read arrives: loud items with a row newer than the previous read's mark. A level
 * already announced within ALERT_QUIET_MS is not announced again (`said`: subject to the time it was last
 * announced). Null `prev` means the first read after opening the app: nothing is announced, it is history.
 */
export function newLoud(items: AlertItem[], prev: AlertSeen | null, said: Record<string, number> = {}, quietMs: number = ALERT_QUIET_MS): AlertItem[] {
  if (!prev) return [];
  return items.filter((i) => {
    if (!i.loud || i.seq <= prev[kindKey(i.kind)]) return false;
    const last = said[i.subject];
    return last == null || i.at - last >= quietMs;
  });
}

/** One announcement for one or several new items (the app shows one toast at a time). */
export function announcement(fresh: AlertItem[]): { title: string; text: string } | null {
  if (!fresh.length) return null;
  if (fresh.length === 1) return { title: fresh[0].title, text: fresh[0].text };
  return { title: `${fresh.length} new alerts`, text: fresh.slice(0, 3).map((f) => f.title).join(" · ") + (fresh.length > 3 ? ` · and ${fresh.length - 3} more` : "") };
}
