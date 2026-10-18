/**
 * Scheduled last-session capture for the core option chains.
 *
 * Panels only request the chains they draw, so a symbol nobody opened on
 * Friday had nothing saved for the weekend. This job pulls the full 0-60 DTE
 * ladder for the core symbols on every trading day (every 30 minutes from
 * 09:40 to 16:30 ET, plus once at startup inside that window, plus once at
 * startup on a non-trading day when nothing is saved yet). Each pull runs
 * through getOptionChain -> applyOiHold, which saves the real OI; the hold
 * then serves it until the next session posts new OI.
 *
 * Cost: 5 ladder segments per symbol, 4 symbols = ~20 Schwab requests per run,
 * about 0.7 requests/min averaged over the run cadence.
 */
import { etClock, isTradingDay } from "./exchangeCalendar";
import { oiHoldStatus } from "./oiHold";

export const CAPTURE_SYMBOLS = ["$SPX", "SPY", "QQQ", "IWM"] as const;
const DTE_MAX = 60;
const EVERY_MS = 30 * 60_000;
const WINDOW_START_MIN = 9 * 60 + 40;
const WINDOW_END_MIN = 16 * 60 + 30;

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;
let _last: { atMs: number; ok: string[]; failed: Array<{ symbol: string; reason: string }> } | null = null;

export function inCaptureWindow(nowMs: number = Date.now()): boolean {
  const c = etClock(nowMs);
  return isTradingDay(c.date) && c.minutes >= WINDOW_START_MIN && c.minutes <= WINDOW_END_MIN;
}

export async function captureNow(only?: readonly string[]): Promise<NonNullable<typeof _last>> {
  if (_running) return _last ?? { atMs: Date.now(), ok: [], failed: [] };
  _running = true;
  const ok: string[] = [];
  const failed: Array<{ symbol: string; reason: string }> = [];
  try {
    const { getOptionChainLadder } = await import("./schwab");
    for (const [i, sym] of (only ?? CAPTURE_SYMBOLS).entries()) {
      // Spread the ~5 ladder requests per symbol so interactive reads keep budget.
      if (i > 0) await new Promise((r) => setTimeout(r, 4_000));
      try {
        const r = await getOptionChainLadder(sym, DTE_MAX);
        if ("error" in r) failed.push({ symbol: sym, reason: r.reason ?? r.error });
        else ok.push(sym);
      } catch (e: any) {
        failed.push({ symbol: sym, reason: e?.message ?? String(e) });
      }
    }
  } finally {
    _running = false;
  }
  _last = { atMs: Date.now(), ok, failed };
  // One retry for symbols that hit the budget or a Schwab error, 3 minutes later.
  if (failed.length && !only) {
    const retry = failed.map((f) => f.symbol);
    setTimeout(() => { void captureNow(retry); }, 3 * 60_000).unref?.();
  }
  console.log(`[oiCapture] ok=${ok.join(",") || "-"} failed=${failed.map((f) => `${f.symbol}(${f.reason})`).join(",") || "-"}`);
  return _last;
}

export function oiCaptureStatus() {
  return { symbols: CAPTURE_SYMBOLS, everyMs: EVERY_MS, window: "trading days 09:40-16:30 ET", inWindow: inCaptureWindow(), last: _last, held: oiHoldStatus() };
}

export function startOiCapture(): void {
  if (_timer) return;
  const tick = () => { if (inCaptureWindow()) void captureNow(); };
  _timer = setInterval(tick, EVERY_MS);
  (_timer as any).unref?.();
  // Startup: capture in the window; off-window with nothing held, warm the hold
  // (each pull falls back to the Cboe seed when Schwab has no OI).
  setTimeout(() => {
    const held = new Set(oiHoldStatus().map((h) => h.symbol));
    if (inCaptureWindow() || CAPTURE_SYMBOLS.some((s) => !held.has(s))) void captureNow();
  }, 3 * 60_000).unref?.(); // after the startup warm-up burst
}
