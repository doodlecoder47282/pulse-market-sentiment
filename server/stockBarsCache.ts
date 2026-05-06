// Stock daily-bars populator — extends daily_bars coverage beyond the regime ETF
// universe so the closed-loop grader can score whale alerts on individual names.
// Pure read-only writer to daily_bars (same shape regime.ts uses). Never touches
// the locked regime engine.
//
// Target universe = whale watchlist + priority symbols from flowConfig.

import { storage } from "./storage";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";

interface DailyRow { date: string; close: number; t: number }

// Stocks the closed-loop grader needs coverage for. Mirrors flowConfig defaults
// plus a small buffer for symbols the user has historically traded.
export const STOCK_BARS_UNIVERSE = [
  "TSLA", "NVDA", "AAPL", "MSFT", "META", "GOOGL", "AMZN",
  "AMD", "AVGO", "PLTR", "COIN", "MSTR",
  // Optional: a few more high-flow names that show up in alerts
  "NFLX", "BAC", "JPM", "F",
];

function etDateString(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const dd = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function yFetch(url: string, timeoutMs = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

/**
 * Fetch 2Y of daily closes for one symbol via Schwab.
 * Mirrors the shape produced by regime.ts so daily_bars stays homogeneous.
 * // TODO: Schwab-only mode — Yahoo source removed, using Schwab getPriceHistory.
 */
export async function fetchStockSymbol2Y(symbol: string): Promise<DailyRow[]> {
  try {
    const { getPriceHistory } = await import("./schwab");
    const resp = await getPriceHistory(symbol, "year", 2, "daily", 1);
    if (!resp.candles.length) return [];
    const rows: DailyRow[] = resp.candles
      .filter((c) => c.close != null && isFinite(c.close))
      .map((c) => ({ date: etDateString(Math.floor(c.datetime / 1000)), close: c.close, t: Math.floor(c.datetime / 1000) }));
    const seen = new Set<string>();
    const dedup: DailyRow[] = [];
    for (const r of rows) {
      if (seen.has(r.date)) continue;
      seen.add(r.date);
      dedup.push(r);
    }
    return dedup;
  } catch {
    return [];
  }
}

export interface StockBarsBackfillResult {
  fetched: string[];
  cached: string[];
  failed: string[];
  ranAt: number;
}

/**
 * Populate daily_bars for the stock universe. Skips symbols already current
 * (latest bar date >= today). Uses 6-symbol parallel batches to be polite.
 */
export async function ensureStockBarsCached(): Promise<StockBarsBackfillResult> {
  const today = etDateString(Math.floor(Date.now() / 1000));
  const needFetch: string[] = [];
  const stillCached: string[] = [];

  for (const sym of STOCK_BARS_UNIVERSE) {
    const latest = storage.getLatestBarDate(sym);
    if (latest && latest >= today) {
      stillCached.push(sym);
    } else {
      needFetch.push(sym);
    }
  }

  const failed: string[] = [];
  const BATCH = 6;
  for (let i = 0; i < needFetch.length; i += BATCH) {
    const slice = needFetch.slice(i, i + BATCH);
    await Promise.all(slice.map(async (sym) => {
      try {
        const rows = await fetchStockSymbol2Y(sym);
        if (rows.length < 30) { failed.push(sym); return; }
        storage.upsertDailyBars(sym, rows);
      } catch {
        failed.push(sym);
      }
    }));
  }

  return {
    fetched: needFetch.filter((s) => !failed.includes(s)),
    cached: stillCached,
    failed,
    ranAt: Date.now(),
  };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let started = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the daily refresher. Runs immediately, then once every 6 hours.
 * Idempotent: silently skips symbols that already have today's bar.
 */
export function startStockBarsRefresher(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      const r = await ensureStockBarsCached();
      if (r.fetched.length > 0 || r.failed.length > 0) {
        console.log(
          `[stockBars] refresh — fetched=${r.fetched.length} cached=${r.cached.length} failed=${r.failed.length}` +
          (r.failed.length > 0 ? ` (failed: ${r.failed.join(",")})` : ""),
        );
      }
    } catch (e: any) {
      console.warn(`[stockBars] tick failed: ${e?.message ?? e}`);
    }
  };

  // Kick immediately so first-time install gets coverage right away
  void tick();

  // 6h cadence — daily bars don't change intraday
  intervalHandle = setInterval(tick, 6 * 60 * 60 * 1000);
  console.log("[stockBars] started — 6h cadence, 16 stock symbols");
}

export function stopStockBarsRefresher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
