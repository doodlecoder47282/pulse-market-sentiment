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

// US equity market full-day holidays (conservative; expand as needed).
// Format YYYY-MM-DD. The app is best-effort — snapshot endpoints also guard.
const HOLIDAYS_2026 = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // July 4th observed
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

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

function isTradingDay(dow: number, date: string): boolean {
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAYS_2026.has(date)) return false;
  return true;
}

// Fired set: "YYYY-MM-DD|slotkey" → true. Keeps memory tiny (~4 entries/day).
const fired = new Set<string>();

const PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${PORT}`;

async function runSnapshot(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/mm-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "^GSPC", horizons: ["daily", "weekly"] }),
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
    const res = await fetch(`${BASE}/api/mm-grade`, { method: "POST" });
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
