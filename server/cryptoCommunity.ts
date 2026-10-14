// server/cryptoCommunity.ts
//
// COMMUNITY WATCH — the settled end of the meme universe, which the discovery
// desk (cryptoEngine.ts, sub-$1M new pools) never sees. The owner lists token
// addresses; for each one this engine resolves the deepest Solana pool
// (DexScreener), pulls daily candles (GeckoTerminal, keyless, 30 rpm shared
// with the scanner) and computes, with shared/memeStructure.ts:
//   - range position, drawdown, deep dips reclaimed, realized vol
//   - execution cost of a $1,000 round trip against the pool's depth
//   - the three-category structural read (community / meta / speculative)
//
// Every figure is descriptive. Nothing here is a verdict, a target or a size.
// Data states are kept apart: a token that did not resolve, a history call
// that failed, and a history that is simply short are three different
// things and are shown as such.
//
// Writes (add / remove) are personal-edition only (shared/edition.ts); the
// demo edition serves a deterministic sample set labelled as such.

import { sqlite } from "./storage";
import { editionFromEnv } from "../shared/edition";

import {
  applyHistory, applyPool, blankEntry, deriveEntry, parseOhlcv, sampleBars,
  type CommunityEntry, type CommunityWatch,
} from "./cryptoCommunityCore";
export type { CommunityEntry, CommunityWatch, QuoteState, HistoryState } from "./cryptoCommunityCore";

// ─── Config ─────────────────────────────────────────────────────────────

const MAX_TOKENS = 24;
const QUOTE_REFRESH_MS = 5 * 60_000;
const HISTORY_REFRESH_MS = 6 * 3600_000;
const HISTORY_PER_TICK = 4;            // GeckoTerminal budget: 30 rpm shared with the scanner
const HISTORY_SPACING_MS = 2_500;
const HISTORY_BARS = 120;              // 90-day window plus slack for missing days
const TICK_MS = 60_000;
const DS_BASE = "https://api.dexscreener.com";
const GT_BASE = "https://api.geckoterminal.com/api/v2";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─── Storage ────────────────────────────────────────────────────────────

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS crypto_watchlist (
    token_address TEXT PRIMARY KEY,
    label TEXT,
    added_at INTEGER NOT NULL
  );
`);

const entries = new Map<string, CommunityEntry>();
let started = false;
let timer: NodeJS.Timeout | null = null;
let lastQuoteRun = 0;

function loadFromDb(): void {
  const rows = sqlite.prepare("SELECT token_address, label, added_at FROM crypto_watchlist ORDER BY added_at ASC").all() as Array<{ token_address: string; label: string | null; added_at: number }>;
  for (const r of rows) if (!entries.has(r.token_address)) entries.set(r.token_address, blankEntry(r.token_address, r.label, r.added_at));
}

// ─── HTTP (keyless) ─────────────────────────────────────────────────────

async function getJson(url: string, timeoutMs = 12_000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json", "user-agent": "batcave-terminal/1.0" } });
    if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 90)}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ─── Refresh ────────────────────────────────────────────────────────────

async function refreshQuotes(now: number): Promise<void> {
  const addrs = Array.from(entries.keys());
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    let pairs: any[] = [];
    try {
      const resp = await getJson(`${DS_BASE}/latest/dex/tokens/${chunk.join(",")}`);
      pairs = resp?.pairs ?? [];
    } catch (err: any) {
      for (const a of chunk) {
        const e = entries.get(a);
        if (!e) continue;
        e.quoteState = "unavailable";
        e.quoteError = `dexscreener: ${String(err?.message ?? err).slice(0, 100)}`;
        e.quoteAt = now;
      }
      continue;
    }
    for (const a of chunk) {
      const e = entries.get(a);
      if (e) applyPool(e, pickPool(pairs, a), now);
    }
  }
}

async function refreshHistory(now: number): Promise<void> {
  const due = Array.from(entries.values())
    .filter((e) => e.pairAddress && e.quoteState === "ok" && (e.historyAt == null || now - e.historyAt > HISTORY_REFRESH_MS))
    .sort((a, b) => (a.historyAt ?? 0) - (b.historyAt ?? 0))
    .slice(0, HISTORY_PER_TICK);
  for (let i = 0; i < due.length; i++) {
    const e = due[i];
    try {
      const payload = await getJson(`${GT_BASE}/networks/solana/pools/${e.pairAddress}/ohlcv/day?aggregate=1&limit=${HISTORY_BARS}&currency=usd`);
      applyHistory(e, parseOhlcv(payload), now);
    } catch (err: any) {
      e.historyState = "unavailable";
      e.historyError = `geckoterminal: ${String(err?.message ?? err).slice(0, 100)}`;
      e.historyAt = now; // back off the full interval after a failure
      deriveEntry(e, now);
    }
    if (i < due.length - 1) await new Promise((r) => setTimeout(r, HISTORY_SPACING_MS));
  }
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking || entries.size === 0) return;
  ticking = true;
  const now = Date.now();
  try {
    if (now - lastQuoteRun >= QUOTE_REFRESH_MS || Array.from(entries.values()).some((e) => e.quoteState === "pending")) {
      lastQuoteRun = now;
      await refreshQuotes(now);
    }
    await refreshHistory(now);
  } catch (err: any) {
    console.warn(`[community] tick failed: ${err?.message ?? err}`);
  } finally {
    ticking = false;
  }
}

export function startCommunityEngine(): void {
  if (started) return;
  started = true;
  if (editionFromEnv() === "demo") { seedDemo(); return; }
  loadFromDb();
  timer = setInterval(() => { void tick(); }, TICK_MS);
  (timer as any).unref?.();
  void tick();
}

export function stopCommunityEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

// ─── Writes (personal edition only; the route enforces the edition) ─────

export function addCommunityToken(tokenAddress: string, label?: string | null): { ok: true; entry: CommunityEntry } | { ok: false; error: string } {
  const addr = String(tokenAddress ?? "").trim();
  if (!BASE58.test(addr)) return { ok: false, error: "token address must be a base58 Solana mint (32-44 characters)" };
  if (entries.size >= MAX_TOKENS && !entries.has(addr)) return { ok: false, error: `watchlist is full (${MAX_TOKENS} tokens)` };
  const lbl = label == null ? null : String(label).trim().slice(0, 40) || null;
  const now = Date.now();
  sqlite.prepare("INSERT INTO crypto_watchlist (token_address, label, added_at) VALUES (@a, @l, @t) ON CONFLICT(token_address) DO UPDATE SET label = excluded.label")
    .run({ a: addr, l: lbl, t: now });
  const existing = entries.get(addr);
  const entry = existing ?? blankEntry(addr, lbl, now);
  entry.label = lbl;
  entries.set(addr, entry);
  if (!existing) { lastQuoteRun = 0; void tick(); }
  return { ok: true, entry };
}

export function removeCommunityToken(tokenAddress: string): boolean {
  const addr = String(tokenAddress ?? "").trim();
  sqlite.prepare("DELETE FROM crypto_watchlist WHERE token_address = @a").run({ a: addr });
  return entries.delete(addr);
}

// ─── Read ───────────────────────────────────────────────────────────────

export function getCommunityWatch(): CommunityWatch {
  const edition = editionFromEnv();
  const list = Array.from(entries.values()).sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
  return {
    entries: list,
    asOf: Date.now(),
    source: edition === "demo" ? "Sample (simulated history and pools)" : "DexScreener (deepest Solana pool), GeckoTerminal daily candles; keyless public APIs",
    edition,
    writable: edition === "personal",
    limits: { maxTokens: MAX_TOKENS, historyRefreshMs: HISTORY_REFRESH_MS, quoteRefreshMs: QUOTE_REFRESH_MS },
    note: "Descriptive only: range position, survival counts and execution cost against the pool's depth. Holder concentration and mint authority are not read for watch tokens, so the structural read stays tentative.",
  };
}

// ─── Demo sample ────────────────────────────────────────────────────────

function seedDemo(): void {
  const now = Date.now();
  const samples = [
    { addr: "SampLe1111111111111111111111111111111111111", symbol: "PLAZA", name: "Plaza (sample)", liq: 2_400_000, mcap: 48_000_000, age: 410 },
    { addr: "SampLe2222222222222222222222222222222222222", symbol: "QUILL", name: "Quill (sample)", liq: 650_000, mcap: 9_500_000, age: 96 },
    { addr: "SampLe3333333333333333333333333333333333333", symbol: "GRIT", name: "Grit 2.0 (sample)", liq: 140_000, mcap: 1_900_000, age: 21 },
  ];
  for (const s of samples) {
    const e = blankEntry(s.addr, "sample", now - s.age * 86_400_000);
    e.symbol = s.symbol; e.name = s.name; e.pairAddress = `pool-${s.symbol.toLowerCase()}`; e.dexId = "raydium";
    e.pairCreatedAt = now - s.age * 86_400_000;
    e.liquidityUsd = s.liq; e.marketCap = s.mcap; e.fdv = s.mcap;
    const bars = sampleBars(s.symbol, Math.min(120, Math.floor(s.age)), 0.01, now - 86_400_000);
    e.priceUsd = bars.length ? bars[bars.length - 1].c : null;
    e.vol24h = bars.length ? bars[bars.length - 1].v : null;
    e.chg24h = bars.length > 1 ? 100 * (bars[bars.length - 1].c / bars[bars.length - 2].c - 1) : null;
    e.buys24h = 1400; e.sells24h = 1250;
    e.quoteState = "ok"; e.quoteAt = now;
    applyHistory(e, bars, now);
    entries.set(s.addr, e);
  }
}
