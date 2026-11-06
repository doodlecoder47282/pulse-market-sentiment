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
  /** Distinct symbols seen (first 6). */
  symbols: string[];
  total: number;
}

const ROW = /^([IB]) (\S+)(?: (\S+))? <- (.+)$/;

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
    if (sym) for (const s of sym.split(",")) if (s) line._syms.add(s);
  }
  const lines = Array.from(map.values()).map(({ _kinds, _syms, ...l }) => ({
    ...l,
    kinds: Array.from(_kinds.entries()).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n),
    symbols: Array.from(_syms).slice(0, 6),
  })).sort((a, b) => b.total - a.total || a.feature.localeCompare(b.feature));
  return { lines, total, unparsed };
}
