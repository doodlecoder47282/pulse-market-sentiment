/**
 * Last-session open-interest hold (weekends, holidays, pre-open).
 *
 * OCC posts open interest once a day, before the open. Over a weekend nobody
 * gets new OI until Monday morning, yet Schwab's chains report
 * openInterest = 0 on every $SPX contract (observed 2026-10-17: 30 expiries,
 * 11,872 contracts, all 0, while SPY kept its OI). Every OI-weighted output
 * (GEX, DEX, vanna, charm, walls, flip, sticky zones, the 3D surface) then
 * reads zero.
 *
 * So the last real OI is kept per contract and used until new OI posts:
 *   - Every chain Schwab returns with real OI is saved per symbol to
 *     <runtime>/data/oi-hold/<symbol>.json (and a scheduled job captures the
 *     full 0-60 DTE ladder for the core symbols each trading day: oiCapture.ts).
 *   - When a chain arrives with no OI at all, on a non-trading day or on a
 *     trading day before that day's OI has posted, the saved OI is copied back
 *     onto the same contracts (matched by OCC symbol: root, expiry, side,
 *     strike) and the chain is labeled "held" with the posting date.
 *   - With nothing saved, OI is unavailable ("none"): Schwab is the only
 *     options source (AGENTS.md, user decision 2026-10-08), so no other feed
 *     fills the gap. Stores written by the removed Cboe seed are discarded.
 * Held OI is never presented as live: oiState says where it came from.
 */
import fs from "node:fs";
import path from "node:path";
import { etDate, isTradingDay, prevTradingDay } from "./exchangeCalendar";

type ExpMap = Record<string, Record<string, any[]>>;
type HoldSource = "schwab";
type Stored = { v: 2; symbol: string; sessionDate: string; savedAtMs: number; source: HoldSource; oi: Record<string, number> };

export type ChainOiState = {
  source: "live" | "held" | "none";
  sessionDate: string | null;
  contractsWithOi: number;
  note: string | null;
  heldFrom?: HoldSource;
};

const DIR = process.env.BATCAVE_OI_HOLD_DIR || path.join(process.cwd(), "data", "oi-hold");
const _mem = new Map<string, Stored>();
const _dirty = new Map<string, ReturnType<typeof setTimeout>>();
const FLUSH_MS = 10_000;
/** Held OI older than this many calendar days is not used (a long holiday is 4). */
const MAX_HOLD_DAYS = 5;

const fileOf = (symbol: string) => path.join(DIR, `${symbol.replace(/[^A-Za-z0-9]/g, "_")}.json`);

/** OCC symbol -> "ROOT|YYMMDD|C|strike". Schwab pads the root ("SPXW  261019C07130000"); Cboe does not. */
export function occKey(sym: unknown): string | null {
  if (typeof sym !== "string") return null;
  const m = /^([A-Z0-9.]{1,6})\s*(\d{6})([CP])(\d{8})$/.exec(sym.trim());
  if (!m) return null;
  return `${m[1]}|${m[2]}|${m[3]}|${parseInt(m[4], 10) / 1000}`;
}

function legacyKey(expKey: string, side: "C" | "P", strike: string): string {
  return `${expKey.split(":")[0]}|${side}|${parseFloat(strike)}`;
}

function load(symbol: string): Stored | null {
  const hit = _mem.get(symbol);
  if (hit) return hit;
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(symbol), "utf8")) as Stored;
    // Schwab-only: a store that ever mixed in another feed is not used.
    if (s && s.v === 2 && s.oi && typeof s.sessionDate === "string" && s.source === "schwab") { _mem.set(symbol, s); return s; }
  } catch { /* none saved yet */ }
  return null;
}

function scheduleFlush(symbol: string) {
  if (_dirty.has(symbol)) return;
  const t = setTimeout(() => {
    _dirty.delete(symbol);
    const s = _mem.get(symbol);
    if (!s) return;
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fileOf(symbol), JSON.stringify(s)); }
    catch (e: any) { console.warn("[oiHold] save failed:", e?.message); }
  }, FLUSH_MS);
  (t as any).unref?.();
  _dirty.set(symbol, t);
}

function forEachContract(calls: ExpMap, puts: ExpMap, fn: (keys: string[], c: any) => void) {
  for (const [m, side] of [[calls, "C"], [puts, "P"]] as const) {
    for (const ek of Object.keys(m ?? {})) for (const sk of Object.keys(m[ek] ?? {})) {
      for (const c of m[ek][sk] ?? []) {
        const k = occKey(c?.symbol);
        fn(k ? [k] : [legacyKey(ek, side, sk)], c);
      }
    }
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** The trading day whose posted OI a chain fetched now carries. */
function postedSession(today: string): string {
  return isTradingDay(today) ? today : prevTradingDay(today);
}

export function oiHoldStatus(): Array<{ symbol: string; sessionDate: string; source: HoldSource; contracts: number; savedAtMs: number }> {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
  let files: string[] = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")); } catch { /* none */ }
  const out: Array<{ symbol: string; sessionDate: string; source: HoldSource; contracts: number; savedAtMs: number }> = [];
  const seen = new Set<string>();
  for (const s of Array.from(_mem.values())) { seen.add(s.symbol); out.push({ symbol: s.symbol, sessionDate: s.sessionDate, source: s.source, contracts: Object.keys(s.oi).length, savedAtMs: s.savedAtMs }); }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Stored;
      if (s?.v === 2 && s.source === "schwab" && !seen.has(s.symbol)) out.push({ symbol: s.symbol, sessionDate: s.sessionDate, source: s.source, contracts: Object.keys(s.oi).length, savedAtMs: s.savedAtMs });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Below this share of contracts carrying OI, a trading-day chain counts as "OI not posted". */
const POSTED_MIN_SHARE = 0.2;

/**
 * Save real OI; fill contracts whose OI has not posted from the last session's
 * saved OI. Mutates the maps.
 *   non-trading day: every 0-OI contract is filled from the last session
 *     (Schwab zeroes most $SPX OI on weekends but keeps a few hundred).
 *   trading day: filled only while today's OI has not posted (< 20% of
 *     contracts carry OI); after it posts, zeros are real and stay zero.
 */
export function applyOiHold(symbol: string, calls: ExpMap, puts: ExpMap, nowMs: number = Date.now(), _opts: { seed?: boolean } = {}): ChainOiState {
  // Filled contracts are tagged (_oiHeldFrom): Schwab's response cache hands the
  // same objects back, and a held value must never be re-read as Schwab's own.
  let total = 0;
  let withOi = 0;
  forEachContract(calls, puts, (_k, c) => {
    total++;
    if (typeof c?.openInterest === "number" && c.openInterest > 0 && !c._oiHeldFrom) withOi++;
  });
  if (total === 0) return { source: "none", sessionDate: null, contractsWithOi: 0, note: null };
  const today = etDate(nowMs);
  const trading = isTradingDay(today);
  const sessionDate = postedSession(today);

  // 1. Save what Schwab has, merged into the same posting session's store.
  if (withOi > 0) {
    const prev = load(symbol);
    const same = prev && prev.sessionDate === sessionDate;
    const oi: Record<string, number> = same ? { ...prev!.oi } : {};
    forEachContract(calls, puts, (keys, c) => {
      if (typeof c?.openInterest === "number" && c.openInterest > 0 && !c._oiHeldFrom) for (const k of keys) oi[k] = c.openInterest;
    });
    _mem.set(symbol, { v: 2, symbol, sessionDate, savedAtMs: nowMs, source: "schwab", oi });
    scheduleFlush(symbol);
  }

  const posted = trading && withOi / total >= POSTED_MIN_SHARE;
  if (posted) return { source: "live", sessionDate: null, contractsWithOi: withOi, note: null };

  // 2. Fill the contracts whose OI has not posted.
  const saved = load(symbol);
  const usable = saved && daysBetween(saved.sessionDate, today) <= MAX_HOLD_DAYS && saved.sessionDate <= today
    && (trading ? saved.sessionDate >= prevTradingDay(today) : true);
  let filled = 0;
  if (usable && saved) {
    forEachContract(calls, puts, (keys, c) => {
      if (!c) return;
      const v = keys.map((k) => saved.oi[k]).find((x) => x != null);
      if (c._oiHeldFrom) { if (v) c.openInterest = v; filled++; return; }
      if (typeof c.openInterest === "number" && c.openInterest > 0) return;
      if (v) { c.openInterest = v; c._oiHeldFrom = saved.sessionDate; filled++; }
    });
  }
  if (filled > 0) {
    return {
      source: "held", sessionDate: saved!.sessionDate, contractsWithOi: withOi + filled, heldFrom: saved!.source,
      note: `${trading ? "Today's open interest has not posted yet" : "No new open interest until the next session posts it"}; ${filled} contracts use the open interest Schwab carried on ${saved!.sessionDate} (last session), held until new figures post.`,
    };
  }
  if (withOi > 0) return { source: "live", sessionDate: null, contractsWithOi: withOi, note: null };
  return {
    source: "none", sessionDate: null, contractsWithOi: 0,
    note: trading
      ? "Schwab returned 0 open interest for every contract and no prior-session Schwab open interest is saved; open interest is unavailable until it posts."
      : "Schwab reports 0 open interest on non-trading days and no prior-session Schwab open interest was saved; open interest is unavailable until the next session posts it.",
  };
}
