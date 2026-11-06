// shared/requestBreakdown.ts
//
// Turns /api/schwab/diag requestsByCaller rows ("I chains SPY <- api /headline")
// into a per-feature breakdown for the Settings panel. Pure.
//
// Each row counts ADMITTED Schwab request attempts in the last minute (a
// request that passed the cache and took a slot under the 100/min cap; a retry
// is another attempt). Cache hits and requests refused by the self-throttle
// are not in these rows (refusals are in diag.degraded).

export interface CallerRow { n: number; k: string }

export interface FeatureLine {
  /** "api /macro", "background task", ... */
  feature: string;
  /** "interactive" = a screen asked; "background" = a timer or engine. */
  priority: "interactive" | "background";
  /** Request kinds with counts: chains 6, quotes 2, pricehistory 34. */
  kinds: Array<{ kind: string; n: number }>;
  /** Distinct symbols seen (first 6). The server cuts each row's symbol list at
   *  24 characters, so a symbol ending a 24-character list may be cut short: it carries a trailing "…". */
  symbols: string[];
  total: number;
}

const ROW = /^([IB]) (\S+)(?: (\S+))? <- (.+)$/;
/** server/schwab.ts records at most this many characters of a request's symbol list. */
export const SYMBOL_LIST_CUT = 24;
/** server/schwab.ts reports at most this many caller rows (busiest first). */
export const CALLER_ROWS_REPORTED = 60;

/**
 * Header for the breakdown: the minute's real admitted count comes from
 * requestsLastMinute; the rows can cover less (only the busiest 60 caller rows
 * are reported), and the gap is stated, never hidden.
 */
export function breakdownHeader(rowsTotal: number, unparsed: number, requestsLastMinute: number | null | undefined, maxPerMinute: number): string {
  // rowsTotal: every reported row's count (unparsed included); unparsed is a subset of it.
  const total = Number.isFinite(requestsLastMinute) ? Number(requestsLastMinute) : null;
  const head = total == null ? `last minute: ${rowsTotal} in reported rows (total not reported)` : `last minute: ${total} admitted of ${maxPerMinute}`;
  const gaps: string[] = [];
  if (total != null && rowsTotal < total) gaps.push(`${total - rowsTotal} not itemised (only the busiest ${CALLER_ROWS_REPORTED} caller rows are reported)`);
  if (unparsed > 0) gaps.push(`${unparsed} in rows this panel could not read`);
  return gaps.length ? `${head} · ${gaps.join(" · ")}` : head;
}

/** Normalise the caller: routes stay, stack frames (file paths) become "background task". */
export function featureOf(who: string): string {
  const w = who.trim();
  if (w.startsWith("api ")) return w.replace(/\?.*$/, "");
  return "background task";
}

export function requestBreakdown(rows: CallerRow[] | null | undefined): { lines: FeatureLine[]; total: number; unparsed: number } {
  const map = new Map<string, FeatureLine & { _kinds: Map<string, number>; _syms: Set<string> }>();
  let total = 0, unparsed = 0;
  for (const r of rows ?? []) {
    const n = Number.isFinite(r?.n) && r.n > 0 ? Math.floor(r.n) : 0;
    if (!n) continue;
    total += n;
    const m = ROW.exec(String(r?.k ?? ""));
    if (!m) { unparsed += n; continue; }
    const [, pr, kind, sym, who] = m;
    const feature = featureOf(who);
    const priority = pr === "I" ? "interactive" as const : "background" as const;
    const key = `${priority}|${feature}`;
    let line = map.get(key);
    if (!line) { line = { feature, priority, kinds: [], symbols: [], total: 0, _kinds: new Map(), _syms: new Set() }; map.set(key, line); }
    line.total += n;
    line._kinds.set(kind, (line._kinds.get(kind) ?? 0) + n);
    if (sym) {
      const parts = sym.split(",").filter(Boolean);
      // A 24-character list was cut by the server (schwab.ts): its last symbol may be partial.
      if (sym.length >= SYMBOL_LIST_CUT && parts.length) parts[parts.length - 1] += "…";
      for (const s of parts) line._syms.add(s);
    }
  }
  const lines = Array.from(map.values()).map(({ _kinds, _syms, ...l }) => ({
    ...l,
    kinds: Array.from(_kinds.entries()).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n),
    symbols: Array.from(_syms).slice(0, 6),
  })).sort((a, b) => b.total - a.total || a.feature.localeCompare(b.feature));
  return { lines, total, unparsed };
}
