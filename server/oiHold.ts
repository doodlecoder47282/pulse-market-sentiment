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
 *   - With nothing saved, the last session's OI is seeded from Cboe's public
 *     delayed quotes (cdn.cboe.com delayed_quotes/options), the exchange's own
 *     end-of-session file, and labeled with that source.
 * Held OI is never presented as live: oiState says where it came from.
 */
import fs from "node:fs";
import path from "node:path";
import { etDate, isTradingDay, prevTradingDay } from "./exchangeCalendar";

type ExpMap = Record<string, Record<string, any[]>>;
type HoldSource = "schwab" | "cboe" | "schwab+cboe";
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
    if (s && s.v === 2 && s.oi && typeof s.sessionDate === "string") { _mem.set(symbol, s); return s; }
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

// ── Cboe seed ────────────────────────────────────────────────────────────────
const _seedInFlight = new Map<string, Promise<void>>();
const _seedFailedAt = new Map<string, number>();
const SEED_RETRY_MS = 30 * 60_000;
const _seededAt = new Map<string, number>();
const SEED_EVERY_MS = 6 * 3600_000;

function cboeUrl(symbol: string): string {
  const s = symbol.replace(/^\$/, "").toUpperCase();
  const isIndex = symbol.startsWith("$");
  return `https://cdn.cboe.com/api/global/delayed_quotes/options/${isIndex ? "_" : ""}${s}.json`;
}

/** Parse Cboe's delayed-quotes payload into an OI map. Pure, tested. */
export function parseCboeOi(payload: any): { sessionDate: string | null; oi: Record<string, number> } {
  const oi: Record<string, number> = {};
  const opts = payload?.data?.options;
  if (Array.isArray(opts)) {
    for (const o of opts) {
      const k = occKey(o?.option);
      const v = Number(o?.open_interest);
      if (k && Number.isFinite(v) && v > 0) oi[k] = Math.round(v);
    }
  }
  const lt = String(payload?.data?.last_trade_time ?? "");
  const sessionDate = /^\d{4}-\d{2}-\d{2}/.test(lt) ? lt.slice(0, 10) : null;
  return { sessionDate, oi };
}

function seedFromCboe(symbol: string, nowMs: number): void {
  if (_seedInFlight.has(symbol)) return;
  if (nowMs - (_seedFailedAt.get(symbol) ?? 0) < SEED_RETRY_MS) return;
  if (nowMs - (_seededAt.get(symbol) ?? 0) < SEED_EVERY_MS) return;
  const p = (async () => {
    try {
      const r = await fetch(cboeUrl(symbol), { headers: { "User-Agent": "Mozilla/5.0 Batcave" }, signal: AbortSignal.timeout(45_000) });
      if (!r.ok) throw new Error(`Cboe HTTP ${r.status}`);
      const { sessionDate, oi } = parseCboeOi(await r.json());
      const n = Object.keys(oi).length;
      if (!sessionDate || n === 0) throw new Error("Cboe payload had no open interest");
      // Merge: Schwab values from the same session win over Cboe's.
      const prev = load(symbol);
      const same = prev && prev.sessionDate === sessionDate;
      const merged = same ? { ...oi, ...prev!.oi } : oi;
      if (prev && !same && prev.sessionDate > sessionDate) return; // newer Schwab session already saved
      _mem.set(symbol, { v: 2, symbol, sessionDate, savedAtMs: Date.now(), source: same ? "schwab+cboe" : "cboe", oi: merged });
      scheduleFlush(symbol);
      _seededAt.set(symbol, Date.now());
      console.log(`[oiHold] seeded ${symbol} from Cboe delayed quotes: ${n} contracts, session ${sessionDate}`);
    } catch (e: any) {
      _seedFailedAt.set(symbol, Date.now());
      console.warn(`[oiHold] Cboe seed failed for ${symbol}: ${e?.message ?? e}`);
    } finally {
      _seedInFlight.delete(symbol);
    }
  })();
  _seedInFlight.set(symbol, p);
}

/** Test/ops hook: wait for any in-flight Cboe seed. */
export async function awaitSeeds(): Promise<void> { await Promise.all(Array.from(_seedInFlight.values())); }

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
      if (s?.v === 2 && !seen.has(s.symbol)) out.push({ symbol: s.symbol, sessionDate: s.sessionDate, source: s.source, contracts: Object.keys(s.oi).length, savedAtMs: s.savedAtMs });
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
export function applyOiHold(symbol: string, calls: ExpMap, puts: ExpMap, nowMs: number = Date.now(), opts: { seed?: boolean } = {}): ChainOiState {
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
    const source: HoldSource = same && prev!.source !== "schwab" ? "schwab+cboe" : "schwab";
    _mem.set(symbol, { v: 2, symbol, sessionDate, savedAtMs: nowMs, source, oi });
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
  // Thin store (e.g. only Schwab's weekend leftovers): top it up from Cboe once.
  const thin = !saved || Object.keys(saved.oi).length < Math.max(50, total * 0.5);
  if (thin && opts.seed !== false) seedFromCboe(symbol, nowMs);

  if (filled > 0) {
    const from = saved!.source === "cboe" ? "Cboe delayed quotes" : saved!.source === "schwab+cboe" ? "Schwab and Cboe delayed quotes" : "Schwab";
    return {
      source: "held", sessionDate: saved!.sessionDate, contractsWithOi: withOi + filled, heldFrom: saved!.source,
      note: `${trading ? "Today's open interest has not posted yet" : "No new open interest until the next session posts it"}; ${filled} contracts use the open interest ${from} carried on ${saved!.sessionDate} (last session), held until new figures post.`,
    };
  }
  if (withOi > 0) return { source: "live", sessionDate: null, contractsWithOi: withOi, note: null };
  return {
    source: "none", sessionDate: null, contractsWithOi: 0,
    note: trading
      ? "Schwab returned 0 open interest for every contract and no prior-session open interest is saved; fetching the last session's from Cboe."
      : "Schwab reports 0 open interest on non-trading days and no prior-session open interest was saved; fetching the last session's from Cboe (refresh in a minute).",
  };
}
