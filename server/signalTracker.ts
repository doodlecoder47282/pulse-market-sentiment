// ─────────────────────────────────────────────────────────────────────────────
// signalTracker.ts — universal manual tracker for any signal source.
//
// User spec (verbatim):
//   "for signals we need to be able to open and close tracking and group per
//    ticker so its in order"
//
// What this does:
//   - Lets the UI manually mark ANY signal (flow alert, unusual flow, whale
//     hit, etc.) as "tracking" without waiting for auto-detection thresholds.
//   - Groups all tracked items by ticker, sorted by symbol then by recency.
//   - Stores entry snapshot at track-time, refreshes live mark on each query.
//   - Supports manual close (status → CLOSED) and untrack (full removal).
//
// In-memory only — survives until process restart. Persistence layer can be
// added later if user requests it.
// ─────────────────────────────────────────────────────────────────────────────

export type TrackedSource = "flow-alert" | "unusual-flow" | "whale" | "manual";
export type TrackedStatus = "OPEN" | "CLOSED" | "EXPIRED";

export interface TrackedSignal {
  /** Unique key. Format: `${source}:${symbol}:${type?}:${strike?}:${expiration?}` */
  id: string;
  source: TrackedSource;
  symbol: string;
  /** Optional option-specific fields */
  type?: "C" | "P";
  strike?: number;
  expiration?: string;
  side?: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Free-text label shown in the UI */
  label?: string;
  /** Entry snapshot — captured at track-time */
  entry: {
    at: number;
    mark?: number | null;
    premium?: number | null;
    delta?: number | null;
    iv?: number | null;
    spot?: number | null;
    note?: string | null;
  };
  /** Live snapshot — refreshed on read */
  live?: {
    mark?: number | null;
    pctChange?: number | null;
    peakMark?: number | null;
    peakPctChange?: number | null;
    asOf: number;
  };
  status: TrackedStatus;
  statusAt: number;
  /** Optional metadata bag — source-specific extras */
  meta?: Record<string, any>;
}

const tracked = new Map<string, TrackedSignal>();

// ──────────────── helpers ─────────────────

function makeId(input: {
  source: TrackedSource;
  symbol: string;
  type?: string;
  strike?: number;
  expiration?: string;
}): string {
  const parts: string[] = [input.source, input.symbol.toUpperCase()];
  if (input.type) parts.push(input.type);
  if (input.strike != null) parts.push(String(input.strike));
  if (input.expiration) parts.push(input.expiration);
  return parts.join(":");
}

// ──────────────── public API ─────────────────

export function track(input: Omit<TrackedSignal, "id" | "status" | "statusAt"> & { id?: string }): TrackedSignal {
  const id = input.id ?? makeId({
    source: input.source,
    symbol: input.symbol,
    type: input.type,
    strike: input.strike,
    expiration: input.expiration,
  });

  // If already tracked, refresh entry without losing peak
  const existing = tracked.get(id);
  if (existing && existing.status === "OPEN") {
    return existing;
  }

  const now = Date.now();
  const sig: TrackedSignal = {
    id,
    source: input.source,
    symbol: input.symbol.toUpperCase(),
    type: input.type,
    strike: input.strike,
    expiration: input.expiration,
    side: input.side,
    label: input.label,
    entry: input.entry ?? { at: now },
    status: "OPEN",
    statusAt: now,
    meta: input.meta,
  };
  tracked.set(id, sig);
  return sig;
}

export function close(id: string): TrackedSignal | null {
  const s = tracked.get(id);
  if (!s) return null;
  s.status = "CLOSED";
  s.statusAt = Date.now();
  return s;
}

export function untrack(id: string): boolean {
  return tracked.delete(id);
}

export function getById(id: string): TrackedSignal | null {
  return tracked.get(id) ?? null;
}

export interface TrackedGroup {
  symbol: string;
  count: number;
  open: number;
  closed: number;
  items: TrackedSignal[];
}

export function getGroupedByTicker(filter?: {
  source?: TrackedSource;
  status?: TrackedStatus;
}): { groups: TrackedGroup[]; total: number; open: number; closed: number } {
  let items = Array.from(tracked.values());
  if (filter?.source) items = items.filter((s) => s.source === filter.source);
  if (filter?.status) items = items.filter((s) => s.status === filter.status);

  // Group by symbol
  const groupMap = new Map<string, TrackedGroup>();
  for (const s of items) {
    let g = groupMap.get(s.symbol);
    if (!g) {
      g = { symbol: s.symbol, count: 0, open: 0, closed: 0, items: [] };
      groupMap.set(s.symbol, g);
    }
    g.items.push(s);
    g.count += 1;
    if (s.status === "OPEN") g.open += 1;
    if (s.status === "CLOSED" || s.status === "EXPIRED") g.closed += 1;
  }

  // Sort items inside each group: OPEN first, then by entry time desc
  for (const g of groupMap.values()) {
    g.items.sort((a, b) => {
      if (a.status === "OPEN" && b.status !== "OPEN") return -1;
      if (a.status !== "OPEN" && b.status === "OPEN") return 1;
      return b.entry.at - a.entry.at;
    });
  }

  // Sort groups: by count desc, then symbol asc
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    if (b.open !== a.open) return b.open - a.open;
    if (b.count !== a.count) return b.count - a.count;
    return a.symbol.localeCompare(b.symbol);
  });

  const total = items.length;
  const open = items.filter((s) => s.status === "OPEN").length;
  const closed = items.filter((s) => s.status === "CLOSED" || s.status === "EXPIRED").length;

  return { groups, total, open, closed };
}

/**
 * Refresh live marks. Called on read so the UI sees fresh data without a
 * background loop. Looks up the latest mark from Schwab options chain when
 * the tracked item is an option contract.
 */
export async function refreshLiveMarks(): Promise<void> {
  const open = Array.from(tracked.values()).filter((s) => s.status === "OPEN");
  if (open.length === 0) return;

  // Group by symbol so we hit Schwab once per ticker for option chains
  const bySymbol = new Map<string, TrackedSignal[]>();
  for (const s of open) {
    if (!s.type || s.strike == null || !s.expiration) continue;
    let arr = bySymbol.get(s.symbol);
    if (!arr) { arr = []; bySymbol.set(s.symbol, arr); }
    arr.push(s);
  }

  const now = Date.now();
  for (const [sym, items] of bySymbol.entries()) {
    try {
      const { buildSchwabFlow } = await import("./schwabFlow");
      const flow = await buildSchwabFlow(sym).catch(() => null);
      const contracts = (flow as any)?.contracts ?? (flow as any)?.rows ?? [];
      for (const it of items) {
        // Find matching contract by strike/type/exp
        const match = contracts.find((c: any) =>
          c.strike === it.strike &&
          (c.type === it.type || c.optionType === it.type) &&
          (c.expiration === it.expiration || c.exp === it.expiration)
        );
        const mark = match ? Number(match.mark ?? match.last ?? 0) : null;
        if (mark != null && it.entry.mark) {
          const pctChange = (mark - it.entry.mark) / it.entry.mark;
          const prevPeak = it.live?.peakMark ?? it.entry.mark;
          const peakMark = Math.max(prevPeak, mark);
          const peakPctChange = (peakMark - it.entry.mark) / it.entry.mark;
          it.live = { mark, pctChange, peakMark, peakPctChange, asOf: now };
        } else if (mark != null) {
          it.live = { mark, pctChange: null, peakMark: mark, peakPctChange: null, asOf: now };
        }

        // Auto-expire if past expiration date
        if (it.expiration) {
          const expDate = new Date(it.expiration + "T16:00:00-05:00");
          if (Date.now() > expDate.getTime()) {
            it.status = "EXPIRED";
            it.statusAt = Date.now();
          }
        }
      }
    } catch {
      // swallow per-symbol errors — keep refreshing the rest
    }
  }
}

export function _clearAll(): void {
  tracked.clear();
}

/** All tracked signals (any status) — for performance rollup. */
export function getAllTracked(): TrackedSignal[] {
  return Array.from(tracked.values());
}

/** Terminal signals only (CLOSED + EXPIRED), filtered by statusAt window. */
export function getTerminalSince(cutoffMs: number): TrackedSignal[] {
  return Array.from(tracked.values()).filter(
    (s) => (s.status === "CLOSED" || s.status === "EXPIRED") && s.statusAt >= cutoffMs,
  );
}
