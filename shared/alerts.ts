// shared/alerts.ts
// THE ALERT FEED. The desk already watches the board every minute in session, whether or not anyone has the
// app open: it writes down each board level a ticker crosses and each time one of the owner's rules arms.
// This turns those two logs into one newest-first list the app can show behind a bell and announce as they
// arrive. Nothing is configured by the user and nothing new is measured: every item is a row the desk logged.
// Each item says what happened, in counts and prices; none says what to do. Pure.

export type AlertKind = "rule_armed" | "level_cross";
export interface AlertItem {
  /** Stable across reads, so an item is announced once: repeat crossings of one level keep one id. */
  id: string;
  at: number;
  kind: AlertKind;
  title: string;
  text: string;
  /** Announced when it arrives (a toast, and a device notification if allowed): rule arms and index crossings. The rest are listed only. */
  loud: boolean;
}

export interface AlertArm { id: number; protocol: string; armedAt: number; entry: number | null; levelLabel: string | null; levelPrice: number | null; status: string }
export interface AlertHit { at: number; firstAt: number; count: number; fromBefore: boolean; symbol: string; label: string; levelPrice: number; direction: string; watchedBy: string[] }

const px = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
const hhmm = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const bare = (sym: string) => sym.replace(/^[$/]/, "");
/** What became of an armed rule, in the log's own words. */
export const ARM_STATUS_TEXT: Record<string, string> = {
  open: "still open", expected: "since reached the rule's outcome price", cancelled: "since cancelled", neither: "since ended with neither", ungraded: "could not be graded",
};
/** Tickers whose crossings are announced. The others (SPY and QQQ repeat the index's levels) are listed only. */
export const LOUD_SYMBOLS = ["$SPX", "$VIX"];
export const ALERT_FEED_MAX = 60;

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
      id: `arm-${a.id}`, at: a.armedAt, kind: "rule_armed", loud: true,
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
      id: `hit-${h.symbol}-${h.levelPrice}-${h.fromBefore ? "b" : ""}${h.firstAt}`, at: h.at, kind: "level_cross", loud: LOUD_SYMBOLS.includes(h.symbol),
      title: `${sym} crossed ${px(h.levelPrice)}`,
      text: text + (h.watchedBy.length ? ` Watched by: ${h.watchedBy.join("; ")}.` : ""),
    });
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, ALERT_FEED_MAX);
}

/** Items that arrived after `seenAt`. */
export const unreadCount = (items: AlertItem[], seenAt: number) => items.filter((i) => i.at > seenAt).length;

/**
 * What to announce when a new read arrives: the loud items whose ids were not in the previous read. Null
 * `known` means this is the first read after opening the app: nothing is announced (they are history).
 */
export function newLoud(items: AlertItem[], known: Set<string> | null): AlertItem[] {
  if (!known) return [];
  return items.filter((i) => i.loud && !known.has(i.id));
}

/** One announcement for one or several new items (the app shows one toast at a time). */
export function announcement(fresh: AlertItem[]): { title: string; text: string } | null {
  if (!fresh.length) return null;
  if (fresh.length === 1) return { title: fresh[0].title, text: fresh[0].text };
  return { title: `${fresh.length} new alerts`, text: fresh.slice(0, 3).map((f) => f.title).join(" · ") + (fresh.length > 3 ? ` · and ${fresh.length - 3} more` : "") };
}
