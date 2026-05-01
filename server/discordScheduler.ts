// server/discordScheduler.ts
//
// Two responsibilities, one ticker (60s setInterval):
//
//   1. CRON  — fires postDailyModelCard() at 9:30 ET on weekdays (skip holidays).
//   2. ALERTS — polls /api/models every 60s + /api/news every 5min, detects:
//        • level status flip (held → approaching, anything → broken)
//        • gammaZone flip (y+ ↔ y−)
//        • new high-impact macro event entering the next-30min window
//      Fires the corresponding Discord card via discord.ts.
//
// State is in-memory (lives with the server process). Re-fire suppression is
// per-ET-date for the daily card and per-(level-name + new-status) for level
// alerts. Restarts will re-evaluate cleanly because the alert engine only
// fires on TRANSITIONS, not on absolute states.

import {
  postLevelBreakAlert,
  postGammaFlipAlert,
  postNewsAlert,
} from "./discord";
import { postSelzDailyCard } from "./discordSelzCard";

const PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${PORT}`;

// Match mmScheduler holiday list
const HOLIDAYS_2026 = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
  "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
  "2026-11-26", "2026-12-25",
]);

function etNow(): { date: string; hh: number; mm: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hh = parseInt(get("hour"), 10);
  const mm = parseInt(get("minute"), 10);
  const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday"));
  return { date, hh, mm, dow };
}

function isTradingDay(dow: number, date: string): boolean {
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAYS_2026.has(date)) return false;
  return true;
}

// ─── 1. Daily card cron ─────────────────────────────────────────────────
const DAILY_HHMM = "09:30";
const dailyFired = new Set<string>(); // YYYY-MM-DD entries

async function maybeFireDaily(): Promise<void> {
  const { date, hh, mm, dow } = etNow();
  if (!isTradingDay(dow, date)) return;
  const [tH, tM] = DAILY_HHMM.split(":").map((x) => parseInt(x, 10));
  if (hh !== tH || mm !== tM) return;
  if (dailyFired.has(date)) return;
  dailyFired.add(date);
  console.log(`[discordScheduler] firing daily SPX card (Selz format) at ${date} ${DAILY_HHMM} ET`);
  await postSelzDailyCard();
}

// ─── 2. Level / gamma flip alerts ───────────────────────────────────────
//
// Compare current /api/models response to the last seen one. Fire on:
//   • level.status transition (e.g. "held" → "broken")
//   • audit.gammaZone change
//
// Suppress re-fires within 5 min to avoid chatter on noisy ticks.

type LevelSnap = { status: string };
type AlertState = {
  levels: Record<string, LevelSnap>;       // keyed by level.name
  gammaZone: string | null;
  lastFiredAt: Record<string, number>;     // suppression by alertKey
};

const alertState: AlertState = {
  levels: {},
  gammaZone: null,
  lastFiredAt: {},
};

const SUPPRESS_MS = 5 * 60_000;

function shouldFire(key: string): boolean {
  const last = alertState.lastFiredAt[key] ?? 0;
  const now = Date.now();
  if (now - last < SUPPRESS_MS) return false;
  alertState.lastFiredAt[key] = now;
  return true;
}

async function pollLevelAndGammaAlerts(): Promise<void> {
  const { dow, date, hh } = etNow();
  if (!isTradingDay(dow, date)) return;
  // Only poll during RTH-ish window (9:30–16:00 ET) to avoid wasting cycles
  if (hh < 9 || hh >= 16) return;

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/models?symbol=SPX`);
  } catch {
    return;
  }
  if (!res.ok) return;
  const data = await res.json().catch(() => null);
  if (!data) return;

  const daily = data.horizons?.daily;
  if (!daily) return;

  const spot = daily.spot ?? 0;
  const audit = daily.audit ?? {};
  const newGammaZone = audit.gammaZone ?? null;
  const gammaZero = audit.gammaZero ?? null;

  // Gamma zone flip
  if (
    alertState.gammaZone &&
    newGammaZone &&
    alertState.gammaZone !== newGammaZone &&
    shouldFire(`gamma:${newGammaZone}`)
  ) {
    console.log(`[discordScheduler] gamma flip ${alertState.gammaZone} → ${newGammaZone}`);
    await postGammaFlipAlert({
      prevZone: alertState.gammaZone,
      newZone: newGammaZone,
      spot,
      gammaZero,
    });
  }
  alertState.gammaZone = newGammaZone;

  // Level status transitions
  const levels = (daily.levels ?? []) as any[];
  for (const lv of levels) {
    if (!lv?.name || !lv.status) continue;
    const prev = alertState.levels[lv.name];
    const newStatus = lv.status as string;
    if (prev && prev.status !== newStatus) {
      // Only post on meaningful transitions: anything → broken, or held → approaching
      const meaningful =
        newStatus === "broken" ||
        (prev.status === "held" && newStatus === "approaching");
      if (meaningful && shouldFire(`level:${lv.name}:${newStatus}`)) {
        console.log(`[discordScheduler] level ${lv.name} ${prev.status} → ${newStatus}`);
        await postLevelBreakAlert({
          level: { name: lv.name, kind: lv.kind, price: lv.price, side: lv.side },
          prevStatus: prev.status,
          newStatus,
          spot,
        });
      }
    }
    alertState.levels[lv.name] = { status: newStatus };
  }
}

// ─── 3. News alerts ─────────────────────────────────────────────────────
//
// Poll /api/news every 5 min. Fire when a high-impact macro event (FOMC, CPI,
// NFP, jobless, etc.) enters the next-30min window for the first time.

const KIND_HIGH_IMPACT = new Set(["fomc", "cpi", "nfp", "ppi", "fomcMinutes"]);
const newsFired = new Set<string>();      // event id
let lastNewsPoll = 0;
const NEWS_POLL_MS = 5 * 60_000;
const NEWS_WINDOW_MS = 30 * 60_000;       // 30min look-ahead

async function pollNewsAlerts(): Promise<void> {
  const now = Date.now();
  if (now - lastNewsPoll < NEWS_POLL_MS) return;
  lastNewsPoll = now;

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/news`);
  } catch {
    return;
  }
  if (!res.ok) return;
  const data = await res.json().catch(() => null);
  if (!data) return;

  const calendar = (data.calendar ?? []) as any[];
  for (const ev of calendar) {
    if (!ev?.id || !ev.kind) continue;
    if (!KIND_HIGH_IMPACT.has(String(ev.kind).toLowerCase())) continue;

    const whenMs = typeof ev.when === "number"
      ? (ev.when < 1e12 ? ev.when * 1000 : ev.when)
      : Date.parse(ev.when);
    if (!isFinite(whenMs)) continue;

    const dt = whenMs - now;
    // Within next 30min, not yet fired, not already in past
    if (dt > 0 && dt <= NEWS_WINDOW_MS && !newsFired.has(ev.id)) {
      newsFired.add(ev.id);
      console.log(`[discordScheduler] news ${ev.kind} ${ev.id} firing (T-${Math.round(dt/60_000)}min)`);
      await postNewsAlert({
        kind: String(ev.kind).toUpperCase(),
        title: ev.title,
        whenLabel: ev.whenLabel ?? new Date(whenMs).toISOString(),
        forecast: ev.forecast ?? null,
        previous: ev.previous ?? null,
      });
    }
  }

  // GC newsFired daily so Set doesn't grow unbounded
  if (newsFired.size > 200) newsFired.clear();
}

// ─── Tick ───────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  await maybeFireDaily();
  await pollLevelAndGammaAlerts();
  await pollNewsAlerts();

  // GC dailyFired weekly (small set, but keep tidy)
  if (dailyFired.size > 14) {
    const today = etNow().date;
    for (const k of Array.from(dailyFired)) {
      if (k !== today) dailyFired.delete(k);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDiscordScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
  // First tick after 5s so server has a moment to warm
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  console.log(`[discordScheduler] started — daily card 9:30 ET, alerts on level breaks + gamma flips + macro news`);
}

export function stopDiscordScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
