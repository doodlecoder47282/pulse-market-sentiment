// server/sessionCache.ts
//
// Lightweight disk-backed session cache — persists API payloads across server
// restarts and after-hours so the UI can show the last regular-session snapshot
// instead of blanking out.
//
// Keys are scoped by RTH session date (America/New_York). Example keys:
//   models-^GSPC-2026-04-21
//   trade-desk-1d-2026-04-21
//
// The file layout is simple: data/sessions/<key>.json
// Writes are best-effort (silent on failure) so the cache is never a blocker.
// Reads are strict — return null on miss/parse failure.

import fs from "node:fs/promises";
import path from "node:path";
import { isRegularSessionOpen, isTradingDay as calIsTradingDay, prevTradingDay as calPrevTradingDay } from "./exchangeCalendar";

const CACHE_DIR = path.resolve(process.cwd(), "data", "sessions");

async function ensureDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
}

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    await ensureDir();
    const file = path.join(CACHE_DIR, `${safeKey(key)}.json`);
    await fs.writeFile(file, JSON.stringify({ at: Date.now(), data }), "utf8");
  } catch {
    // best-effort
  }
}

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const file = path.join(CACHE_DIR, `${safeKey(key)}.json`);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.data as T;
  } catch {
    return null;
  }
}

// Return RTH session date (America/New_York) in YYYY-MM-DD form.
// Before 9:30 ET we use the prior trading day — that way the "current session"
// key stays stable until the next open. Weekends roll back to Friday.
export function rthSessionKey(now = new Date()): string {
  // Pull New York date components
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let y = Number(g("year"));
  let mo = Number(g("month"));
  let d = Number(g("day"));
  const hr = Number(g("hour"));
  const min = Number(g("minute"));
  const minOfDay = hr * 60 + min;

  // Build a Date in local NY space (approximate — month is 0-indexed)
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun..6=Sat

  // Pre-market (before 9:30 ET), weekend or exchange holiday -> roll back to
  // the most recent trading day (exchange calendar).
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  void dow;
  if (minOfDay < 9 * 60 + 30 || !calIsTradingDay(iso)) return calPrevTradingDay(iso);
  return iso;
}

// True during the regular session per the exchange calendar (09:30 to 16:00,
// or 13:00 on half days; closed on holidays and weekends).
export function isRthOpen(now = new Date()): boolean {
  return isRegularSessionOpen(now.getTime());
}

