// server/cboeCache.ts
//
// Shared, process-wide cache for CBOE delayed-quote option chains. Multiple
// endpoints (exposures, models, flow future use) need the same chain payload;
// without a shared cache we trip the 429 rate limit within seconds.
//
// 2-minute TTL: chains update slowly (15-min delayed) so 2min is plenty fresh.
// On rate-limit or network error we serve the last good payload up to 30 min.

import fs from "node:fs/promises";
import path from "node:path";

const UA = "Mozilla/5.0 (compatible; PulseDashboard/1.0)";
const FRESH_MS = 2 * 60_000;
// Extended from 30 min → 7 days so the model still renders on weekends and
// holidays when CBOE rate-limits (429s). A stale Friday chain is fine for
// scenario projection — the asOf timestamp and session pill make staleness
// visible to the user.
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
const DISK_DIR = path.resolve(process.cwd(), "data", "cboe");

interface Entry {
  at: number;
  data: any;
}

const mem = new Map<string, Entry>();
const inflight = new Map<string, Promise<any>>();

function fileFor(symbol: string): string {
  return path.join(DISK_DIR, `${symbol.replace(/[^A-Za-z0-9_]/g, "_")}.json`);
}

async function ensureDir() {
  await fs.mkdir(DISK_DIR, { recursive: true }).catch(() => {});
}

async function readDisk(symbol: string): Promise<Entry | null> {
  try {
    const raw = await fs.readFile(fileFor(symbol), "utf8");
    return JSON.parse(raw) as Entry;
  } catch {
    return null;
  }
}

async function writeDisk(symbol: string, entry: Entry) {
  try {
    await ensureDir();
    await fs.writeFile(fileFor(symbol), JSON.stringify(entry), "utf8");
  } catch {}
}

async function fetchFresh(symbol: string, timeoutMs = 10_000, retries = 2): Promise<any> {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.cboe.com/" },
        signal: ctrl.signal,
      });
      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        lastErr = new Error(`CBOE ${r.status}`);
        clearTimeout(to);
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
      if (!r.ok) throw new Error(`CBOE ${r.status}`);
      return await r.json();
    } catch (e: any) {
      if (attempt === retries) throw e;
      lastErr = e;
    } finally {
      clearTimeout(to);
    }
  }
  throw lastErr ?? new Error("CBOE unreachable");
}

export async function getCboeChain(symbol: string): Promise<any> {
  const key = symbol.toUpperCase();

  // In-memory fresh hit
  const m = mem.get(key);
  if (m && Date.now() - m.at < FRESH_MS) return m.data;

  // Coalesce concurrent callers — everyone awaits the same promise
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    // Try disk fresh
    if (!m) {
      const disk = await readDisk(key);
      if (disk && Date.now() - disk.at < FRESH_MS) {
        mem.set(key, disk);
        return disk.data;
      }
    }
    // Fetch
    try {
      const data = await fetchFresh(key);
      const entry: Entry = { at: Date.now(), data };
      mem.set(key, entry);
      await writeDisk(key, entry);
      return data;
    } catch (e) {
      // Stale fallback — either memory or disk, up to STALE_MAX_MS
      const fallback = m ?? (await readDisk(key));
      if (fallback && Date.now() - fallback.at < STALE_MAX_MS) {
        if (!m) mem.set(key, fallback);
        return fallback.data;
      }
      throw e;
    }
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}
