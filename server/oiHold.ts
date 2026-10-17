/**
 * Weekend / holiday open-interest hold.
 *
 * Schwab's option chains report openInterest = 0 on every $SPX contract over
 * the weekend (observed 2026-10-17: 30 expiries, 11,872 contracts, all OI 0,
 * while SPY kept its OI). Every OI-weighted model (GEX, DEX, vanna, charm,
 * sticky zones, 3D surface) then reads zero.
 *
 * On trading days the last chain with real OI is saved per symbol to
 * <runtime>/data/oi-hold/<symbol>.json. On a non-trading day, when Schwab's
 * chain has no OI at all, the saved per-contract OI is copied back onto the
 * same contracts and the chain is labeled with the session it came from.
 * OI is an end-of-session figure (OCC posts it once overnight), so the last
 * session's number IS the current number until Monday's update; it is still
 * labeled, never presented as live.
 */
import fs from "node:fs";
import path from "node:path";
import { etDate, isTradingDay, prevTradingDay } from "./exchangeCalendar";

type ExpMap = Record<string, Record<string, any[]>>;
type Stored = { symbol: string; sessionDate: string; savedAtMs: number; oi: Record<string, number> };

export type ChainOiState = {
  source: "live" | "held" | "none";
  sessionDate: string | null;
  contractsWithOi: number;
  note: string | null;
};

const DIR = process.env.BATCAVE_OI_HOLD_DIR || path.join(process.cwd(), "data", "oi-hold");
const _mem = new Map<string, Stored>();
const _lastWrite = new Map<string, number>();
const WRITE_EVERY_MS = 5 * 60_000;

const keyOf = (expKey: string, side: "C" | "P", strike: string) => `${expKey.split(":")[0]}|${side}|${strike}`;
const fileOf = (symbol: string) => path.join(DIR, `${symbol.replace(/[^A-Za-z0-9]/g, "_")}.json`);

function load(symbol: string): Stored | null {
  const hit = _mem.get(symbol);
  if (hit) return hit;
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(symbol), "utf8")) as Stored;
    if (s && s.oi && typeof s.sessionDate === "string") { _mem.set(symbol, s); return s; }
  } catch { /* none saved yet */ }
  return null;
}

function forEachContract(calls: ExpMap, puts: ExpMap, fn: (k: string, c: any) => void) {
  for (const [m, side] of [[calls, "C"], [puts, "P"]] as const) {
    for (const ek of Object.keys(m ?? {})) for (const sk of Object.keys(m[ek] ?? {})) {
      for (const c of m[ek][sk] ?? []) fn(keyOf(ek, side, sk), c);
    }
  }
}


/** Save real OI on trading days; on non-trading days fill an all-zero chain from the save. Mutates the maps. */
export function applyOiHold(symbol: string, calls: ExpMap, puts: ExpMap, nowMs: number = Date.now()): ChainOiState {
  let total = 0;
  let withOi = 0;
  forEachContract(calls, puts, (_k, c) => {
    total++;
    if (typeof c?.openInterest === "number" && c.openInterest > 0) withOi++;
  });
  const today = etDate(nowMs);
  const trading = isTradingDay(today);

  if (withOi > 0) {
    {
      const prev = load(symbol);
      // The ET trading day the OI was posted (OCC publishes it overnight, before that
      // open); on a weekend/holiday that is the last trading day.
      const sessionDate = trading ? today : prevTradingDay(today);
      const oi: Record<string, number> = prev && prev.sessionDate === sessionDate ? { ...prev.oi } : {};
      forEachContract(calls, puts, (k, c) => {
        if (typeof c?.openInterest === "number" && c.openInterest > 0) oi[k] = c.openInterest;
      });
      const s: Stored = { symbol, sessionDate, savedAtMs: nowMs, oi };
      _mem.set(symbol, s);
      if (nowMs - (_lastWrite.get(symbol) ?? 0) > WRITE_EVERY_MS) {
        _lastWrite.set(symbol, nowMs);
        try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fileOf(symbol), JSON.stringify(s)); }
        catch (e: any) { console.warn("[oiHold] save failed:", e?.message); }
      }
    }
    return { source: "live", sessionDate: null, contractsWithOi: withOi, note: null };
  }

  if (total === 0) return { source: "none", sessionDate: null, contractsWithOi: 0, note: null };
  const saved = !trading ? load(symbol) : null;
  if (saved) {
    let filled = 0;
    forEachContract(calls, puts, (k, c) => {
      const v = saved.oi[k];
      if (v && c) { c.openInterest = v; filled++; }
    });
    if (filled > 0) {
      return {
        source: "held", sessionDate: saved.sessionDate, contractsWithOi: filled,
        note: `Schwab reports 0 open interest on non-trading days; showing the open interest posted ${saved.sessionDate}, held until the next session posts new figures.`,
      };
    }
  }
  return {
    source: "none", sessionDate: null, contractsWithOi: 0,
    note: trading
      ? "Schwab returned 0 open interest for every contract."
      : "Schwab reports 0 open interest on non-trading days and no prior-session open interest was saved for this symbol (it is saved automatically each trading day).",
  };
}
