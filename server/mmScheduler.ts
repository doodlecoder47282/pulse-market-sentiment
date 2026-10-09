// server/mmScheduler.ts
//
// ET-aware cron scheduler for MM-matrix prediction logging:
//   • 10:00 ET  → snapshot (daily + weekly)
//   • 13:00 ET  → snapshot (daily + weekly)
//   • 15:30 ET  → snapshot (daily + weekly)
//   • 16:30 ET  → grade any ungraded snapshots whose session has closed
//
// Runs on the server process via setInterval(60s). Checks the current ET time
// each tick; fires within a ±59s window for each target and tracks a per-ET-date
// "fired" set so each slot fires at most once per day.
//
// Tradingday gating: weekends and US equity market holidays are skipped
// (snapshot endpoint itself also skips via market-closed guards, but this avoids
// noisy logs). Holidays list is intentionally conservative — if unsure, we still
// run and let the snapshot/grade endpoints no-op.

// Scheduler hits our own HTTP endpoints to reuse full request-handler logic
// (cache, fallbacks, error handling). This keeps the scheduler decoupled from
// internal implementation details.

import { isTradingDay as calIsTradingDay, sessionCloseMinutes } from "./exchangeCalendar";
import { internalFetch } from "./internalApi";

type Slot = {
  key: string;
  hhmm: string;      // "HH:MM" ET, 24h
  kind: "snapshot" | "grade";
};

// Schedule
const SLOTS: Slot[] = [
  { key: "snap-10-00", hhmm: "10:00", kind: "snapshot" },
  { key: "snap-13-00", hhmm: "13:00", kind: "snapshot" },
  { key: "snap-15-30", hhmm: "15:30", kind: "snapshot" },
  { key: "grade-16-30", hhmm: "16:30", kind: "grade" },
];

function etNow(): { date: string; hh: number; mm: number; dow: number } {
  const now = new Date();
  // Build ET parts via Intl.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = parseInt(get("hour"), 10);
  const mm = parseInt(get("minute"), 10);
  const wd = get("weekday");
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { date, hh, mm, dow };
}

// Weekends and NYSE holidays (2026-2028) via the shared exchange calendar.
function isTradingDay(_dow: number, date: string): boolean {
  return calIsTradingDay(date);
}

// Fired set: "YYYY-MM-DD|slotkey" → true. Keeps memory tiny (~4 entries/day).
const fired = new Set<string>();


async function runSnapshot(): Promise<void> {
  try {
    const res = await internalFetch("/api/mm-snapshot", {
      method: "POST",
      body: { symbol: "^GSPC", horizons: ["daily", "weekly"] },
    });
    if (!res.ok) {
      console.warn(`[mmScheduler] snapshot HTTP ${res.status}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    const n = Array.isArray(data?.snapshots) ? data.snapshots.length : 0;
    console.log(`[mmScheduler] snapshot captured · ${n} horizons logged`);
  } catch (e: any) {
    console.warn(`[mmScheduler] snapshot failed: ${e?.message ?? e}`);
  }
}

async function runGrade(): Promise<void> {
  try {
    const res = await internalFetch("/api/mm-grade", { method: "POST" });
    if (!res.ok) {
      console.warn(`[mmScheduler] grade HTTP ${res.status}`);
      return;
    }
    const data = await res.json().catch(() => ({} as any));
    console.log(`[mmScheduler] grade complete · ${data?.graded ?? 0} graded, ${data?.skipped ?? 0} skipped`);
  } catch (e: any) {
    console.warn(`[mmScheduler] grade failed: ${e?.message ?? e}`);
  }
}

async function tick(): Promise<void> {
  const { date, hh, mm, dow } = etNow();
  if (!isTradingDay(dow, date)) return;

  for (const slot of SLOTS) {
    const [targetH, targetM] = slot.hhmm.split(":").map((x) => parseInt(x, 10));
    // Fire within the first minute of the target. Minute-granularity.
    if (hh !== targetH) continue;
    if (mm !== targetM) continue;
    // Half days close at 13:00 ET: a snapshot taken after the close would be
    // graded against a close it already saw, so skip snapshot slots at/after it.
    if (slot.kind === "snapshot" && targetH * 60 + targetM >= (sessionCloseMinutes(date) ?? 16 * 60)) continue;

    const key = `${date}|${slot.key}`;
    if (fired.has(key)) continue;
    fired.add(key);

    console.log(`[mmScheduler] firing ${slot.key} at ${date} ${hh}:${String(mm).padStart(2, "0")} ET`);
    if (slot.kind === "snapshot") await runSnapshot();
    else await runGrade();
  }

  // Garbage-collect yesterday's keys to keep the set small
  if (fired.size > 50) {
    const keepPrefix = date;
    for (const k of Array.from(fired)) {
      if (!k.startsWith(keepPrefix)) fired.delete(k);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMmScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
  // Also fire once shortly after boot in case we're inside a target minute
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  console.log(`[mmScheduler] started — 10:00/13:00/15:30 ET snapshots, 16:30 ET grading (weekdays only, holidays skipped)`);
}

export function stopMmScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
