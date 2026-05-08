/**
 * playbookScheduler.ts
 *
 * 9:00 ET (pre-open) — locks daily playbook for the day.
 * Every 5 min during 9:30–16:00 ET — recomputes (cached) so /api/playbook/daily/drift
 * can serve fresh drift without slow rebuild.
 *
 * Designed to be cheap: just calls into dailyPlaybook.ts which re-uses the
 * existing snapshot pipeline (no new Schwab calls).
 */

import { lockPlaybookAtOpen, buildDailyPlaybook } from "./dailyPlaybook";

let _interval: ReturnType<typeof setInterval> | null = null;
let _lockedToday: string = "";

function _todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function _hhmmET(): { hh: number; mm: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, weekday: "short",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  return {
    hh: parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10),
    mm: parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10),
    weekday: parts.find(p => p.type === "weekday")?.value ?? "",
  };
}

async function tick() {
  try {
    const { hh, mm, weekday } = _hhmmET();
    if (weekday === "Sat" || weekday === "Sun") return;

    const today = _todayET();

    const mins = hh * 60 + mm;

    // Primary lock window: 9:00–9:14 ET (pre-open)
    if (hh === 9 && mm >= 0 && mm < 15 && _lockedToday !== today) {
      await lockPlaybookAtOpen("SPY");
      _lockedToday = today;
    }

    // Catch-up lock: if server boots after 9:14 ET on a weekday and we have no
    // lock for today yet, lock now using current snapshot. Drift then anchors
    // to the moment we caught the day, not 9:00 — which is honest and useful.
    // Only catches up during 9:15–16:00 ET.
    if (mins >= 9 * 60 + 15 && mins <= 16 * 60 && _lockedToday !== today) {
      await lockPlaybookAtOpen("SPY");
      _lockedToday = today;
      console.log("[playbookScheduler] catch-up lock fired (server booted post-9:00 ET)");
    }

    // 9:30–16:00 ET → keep snapshot warm (cheap, uses existing snapshot cache)
    if (mins >= 9 * 60 + 30 && mins <= 16 * 60) {
      // Pre-warm so /drift returns instantly
      await buildDailyPlaybook("SPY");
    }
  } catch (e: any) {
    console.warn("[playbookScheduler] tick error:", e?.message);
  }
}

export function startPlaybookScheduler() {
  if (_interval) return;
  // First tick after 5s, then every 5 min
  setTimeout(tick, 5_000);
  _interval = setInterval(tick, 5 * 60 * 1000);
  console.log("[playbookScheduler] started — 9:00 ET lock + 5min drift refresh");
}
