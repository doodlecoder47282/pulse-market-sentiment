// Stock daily-bars populator — extends daily_bars coverage beyond the regime ETF
// universe so the closed-loop grader can score whale alerts on individual names.
// Pure read-only writer to daily_bars (same shape regime.ts uses). Never touches
// the locked regime engine.
//
// Target universe = whale watchlist + priority symbols from flowConfig.

import { storage } from "./storage";
import { refreshSettledDailyBars, settledEndDateMs, type FetchedBars } from "./dailyBarsSettled";

interface DailyRow { date: string; close: number; t: number }

// Stocks the closed-loop grader needs coverage for. Mirrors flowConfig defaults
// plus a small buffer for symbols the user has historically traded.
export const STOCK_BARS_UNIVERSE = [
  "TSLA", "NVDA", "AAPL", "MSFT", "META", "GOOGL", "AMZN",
  "AMD", "AVGO", "PLTR", "COIN", "MSTR",
  // Optional: a few more high-flow names that show up in alerts
  "NFLX", "BAC", "JPM", "F",
  // Canary module proxies (AUDJPY = FXA/FXY, copper/gold = CPER/GLD, crude, DXY)
  // GLD/TLT/HYG/UUP/SPY already covered by the regime ETF universe.
  "CPER", "USO", "FXA", "FXY",
  // Cross-asset matrix legs no other list fetched: without them the pattern was never read.
  "UUP", "TIP",
  // MISSION FIX #6 — breadth sample widening: mega/large caps across sectors so
  // the breadth engine isn't just a tech-flow echo. Daily-cached, cheap.
  "LLY", "XOM", "UNH", "WMT", "JNJ", "V", "MA", "PG", "HD", "CVX",
  "KO", "MRK", "ORCL", "CRM", "COST", "ABBV", "PEP", "MCD", "CAT", "GE",
  // Equal-weight vs cap-weight ratio input
  "RSP",
];

/** MISSION FIX #6 — symbols the breadth engine treats as single stocks
 *  (excludes ETFs / FX / commodity proxies in the universe above). */
export const BREADTH_STOCKS = [
  "TSLA", "NVDA", "AAPL", "MSFT", "META", "GOOGL", "AMZN",
  "AMD", "AVGO", "PLTR", "COIN", "MSTR", "NFLX", "BAC", "JPM", "F",
  "LLY", "XOM", "UNH", "WMT", "JNJ", "V", "MA", "PG", "HD", "CVX",
  "KO", "MRK", "ORCL", "CRM", "COST", "ABBV", "PEP", "MCD", "CAT", "GE",
];

function etDateString(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const dd = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Fetch 2Y of daily closes for one symbol via Schwab.
 * Mirrors the shape produced by regime.ts so daily_bars stays homogeneous.
 * // TODO: Schwab-only mode — Yahoo source removed, using Schwab getPriceHistory.
 */
const NO_BARS: FetchedBars = { rows: [], asOfMs: null };
export async function fetchStockSymbol2Y(symbol: string, retry = false): Promise<FetchedBars> {
  try {
    const { getPriceHistory } = await import("./schwab");
    const resp = await getPriceHistory(symbol, "year", 2, "daily", 1, false, { endDateMs: settledEndDateMs(Date.now()), skipCache: retry });
    if (!resp.candles.length) return NO_BARS;
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
    return { rows: dedup, asOfMs: resp.asOfMs ?? null, stale: resp.stale === true };
  } catch (e: any) {
    // Was a silent catch: a symbol could stop backfilling forever with no trace.
    console.warn(`[stockBars] daily-bar fetch failed: ${e?.message ?? e}`);
    return NO_BARS;
  }
}

export interface StockBarsBackfillResult {
  fetched: string[];
  cached: string[];
  failed: string[];
  /** Answered without the last completed session: older bars kept, tried again shortly. */
  behind: string[];
  expected: string;
  ranAt: number;
}

/**
 * Populate daily_bars for the stock universe with completed sessions. Skips symbols a post-close fetch
 * already brought to the last completed session. 6-symbol parallel batches.
 */
export async function ensureStockBarsCached(): Promise<StockBarsBackfillResult> {
  const r = await refreshSettledDailyBars(STOCK_BARS_UNIVERSE, fetchStockSymbol2Y, storage, Date.now());
  return { ...r, ranAt: Date.now() };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/** A pass costs no request when every symbol is current, so it runs often: a symbol that failed or came
 *  back without the last session is asked again within two passes, and the evening's close is picked up
 *  soon after it settles instead of up to six hours later. */
export const STOCK_BARS_TICK_MS = 15 * 60 * 1000;
let started = false;
let running = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Start the refresher. Runs immediately, then every 15 minutes. Idempotent. */
export function startStockBarsRefresher(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await ensureStockBarsCached();
      if (r.fetched.length > 0 || r.failed.length > 0) {
        console.log(
          `[stockBars] refresh, expected ${r.expected}: fetched=${r.fetched.length} cached=${r.cached.length} failed=${r.failed.length} behind=${r.behind.length}` +
          (r.failed.length > 0 ? ` (failed: ${r.failed.join(",")})` : "") +
          (r.behind.length > 0 ? ` (no ${r.expected} bar yet: ${r.behind.join(",")})` : ""),
        );
      }
    } catch (e: any) {
      console.warn(`[stockBars] tick failed: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };

  void tick();
  intervalHandle = setInterval(tick, STOCK_BARS_TICK_MS);
  console.log(`[stockBars] started: 15 min passes, ${STOCK_BARS_UNIVERSE.length} symbols`);
}

export function stopStockBarsRefresher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
