/**
 * regimeHistoryTicker.ts
 *
 * Self-pings /api/regime/predict every 60s during 9:00–16:00 ET (weekdays) so the
 * regime predictor's rolling history fills automatically — without requiring the UI
 * to be open. Without this, the panel sits at "0/5 samples needed" forever when no
 * one's looking at it.
 *
 * Cheap: predict route reads from the snapshot cache, no new Schwab calls.
 */

let _interval: ReturnType<typeof setInterval> | null = null;

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
    const mins = hh * 60 + mm;
    // Only fill history during pre-open warm-up + RTH (9:00–16:00 ET)
    if (mins < 9 * 60 || mins > 16 * 60) return;

    const port = Number(process.env.PORT ?? 5000);
    // Fire-and-forget; the route's side-effect records the raw regime into history.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    await fetch(`http://127.0.0.1:${port}/api/regime/predict?symbol=^GSPC&horizonMinutes=20`, {
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch (e: any) {
    console.warn("[regimeHistoryTicker] tick error:", e?.message);
  }
}

export function startRegimeHistoryTicker() {
  if (_interval) return;
  // First tick after 10s so the server is fully up, then every 60s
  setTimeout(tick, 10_000);
  _interval = setInterval(tick, 60 * 1000);
  console.log("[regimeHistoryTicker] started — 60s cadence during 9:00–16:00 ET");
}
