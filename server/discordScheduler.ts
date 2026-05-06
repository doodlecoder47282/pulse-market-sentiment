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
  postLevelClusterAlert,
  postGammaFlipAlert,
  postNewsAlert,
  postOdteBangerAlert,
} from "./discord";
import { evaluateOdte, type EvalArgs } from "./odteAlertEngine";
import { postBatcaveDailyCard } from "./discordBatcaveCard";
import { settleDay } from "./calibration";
import { postCalibrationCard } from "./calibrationCard";

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
const preOpenScanFired = new Set<string>(); // YYYY-MM-DD entries — 9:30 ET 0DTE pre-open scan guard

async function maybeFireDaily(): Promise<void> {
  const { date, hh, mm, dow } = etNow();
  if (!isTradingDay(dow, date)) return;
  if (dailyFired.has(date)) return;
  const [tH, tM] = DAILY_HHMM.split(":").map((x) => parseInt(x, 10));
  // Robust to 60s timer drift: fire as soon as the ET clock is at OR past
  // the daily target minute on a trading day, but not after RTH start drift
  // gets too wide (cap at 9:45 — past that, skip and wait for tomorrow).
  const nowMin = hh * 60 + mm;
  const tgtMin = tH * 60 + tM;
  if (nowMin < tgtMin) return;
  if (nowMin > tgtMin + 15) return;
  dailyFired.add(date);
  console.log(`[discordScheduler] firing daily SPX card (Batcave format) at ${date} ${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")} ET (target ${DAILY_HHMM})`);
  await postBatcaveDailyCard();
}

// ─── 1b. 30-min Batcave cadence ────────────────────────────────────────────
//
// Fires postBatcaveDailyCard() every 30 min during RTH (10:00–16:00 ET) on
// trading days. The 9:30 slot is owned by the daily cron — we don't
// double-post. Slots: 10:00, 10:30, ..., 15:30, 16:00 (13 fires/day).
//
// We track the last half-hour SLOT we fired and trigger whenever we land
// in a new slot, instead of requiring the tick to land exactly on :00/:30.
// This is robust to setInterval drift (60s timer can land at :29 then :31
// and miss the boundary entirely with strict integer matching).
const HALFHOUR_FIRED = new Set<string>(); // YYYY-MM-DD HH:MM entries

async function maybeFireHalfHour(): Promise<void> {
  const { date, hh, mm, dow } = etNow();
  if (!isTradingDay(dow, date)) return;
  // Window: 10:00 ≤ t ≤ 16:00 (skip 9:30, owned by daily card)
  const minutes = hh * 60 + mm;
  if (minutes < 10 * 60 || minutes > 16 * 60) return;

  // Snap to the most recent :00 / :30 boundary at-or-before now.
  const slotMM = mm < 30 ? 0 : 30;
  const key = `${date} ${String(hh).padStart(2, "0")}:${String(slotMM).padStart(2, "0")}`;
  if (HALFHOUR_FIRED.has(key)) return;
  HALFHOUR_FIRED.add(key);
  console.log(`[discordScheduler] firing 30-min Batcave card for slot ${key} ET (tick at ${hh}:${String(mm).padStart(2,"0")})`);
  await postBatcaveDailyCard().catch((e) => {
    console.error(`[discordScheduler] half-hour fire failed: ${e}`);
  });
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

  // Level status transitions — collect all meaningful transitions in this tick,
  // then either coalesce (≥2 levels within 5 SPX pts) or fire individually.
  const levels = (daily.levels ?? []) as any[];
  const dfi = audit.dfi ?? daily.dfi ?? null;
  const allLevels = levels.map((l: any) => ({
    name: l.name, kind: l.kind, price: l.price, side: l.side,
    status: l.status, tag: l.tag,
  }));
  const ctx = {
    dfi: typeof dfi === "number" ? dfi : null,
    gammaZone: newGammaZone,
    allLevels,
  };

  type Pending = {
    level: { name: string; kind: string; price: number; side: string };
    prevStatus: string;
    newStatus: string;
  };
  const pending: Pending[] = [];

  for (const lv of levels) {
    if (!lv?.name || !lv.status) continue;
    const prev = alertState.levels[lv.name];
    const newStatus = lv.status as string;
    if (prev && prev.status !== newStatus) {
      const meaningful =
        newStatus === "broken" ||
        (prev.status === "held" && newStatus === "approaching");
      if (meaningful && shouldFire(`level:${lv.name}:${newStatus}`)) {
        pending.push({
          level: { name: lv.name, kind: lv.kind, price: lv.price, side: lv.side },
          prevStatus: prev.status,
          newStatus,
        });
      }
    }
    alertState.levels[lv.name] = { status: newStatus };
  }

  // Cluster pass: group pending by 5-SPX-pt proximity. If a cluster has ≥2
  // members, fire one cluster embed; otherwise fire individual embeds.
  if (pending.length === 0) return;
  const sorted = [...pending].sort((a, b) => a.level.price - b.level.price);
  const clusters: Pending[][] = [];
  let cur: Pending[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = cur[cur.length - 1];
    if (Math.abs(sorted[i].level.price - last.level.price) <= 5) {
      cur.push(sorted[i]);
    } else {
      clusters.push(cur);
      cur = [sorted[i]];
    }
  }
  clusters.push(cur);

  for (const c of clusters) {
    if (c.length >= 2) {
      console.log(`[discordScheduler] cluster of ${c.length} levels firing (${c.map((x) => x.level.name).join(", ")})`);
      await postLevelClusterAlert({ spot, cluster: c, context: ctx });
    } else {
      const one = c[0];
      console.log(`[discordScheduler] level ${one.level.name} ${one.prevStatus} → ${one.newStatus}`);
      await postLevelBreakAlert({
        level: one.level,
        prevStatus: one.prevStatus,
        newStatus: one.newStatus,
        spot,
        context: ctx,
      });
    }
  }
}

// ─── 2c. 0DTE banger alerts (B+ gate, max 3/day) ────────────────────
//
// Polls /api/models (audit + levels) and /api/odte-tracker (live chain) once
// per scheduler tick during RTH. Engine handles all gating internally — we
// just hand it the snapshot and post anything it returns.

async function pollOdteBangerAlerts(): Promise<void> {
  const { dow, date, hh, mm } = etNow();
  if (!isTradingDay(dow, date)) return;
  // Only during RTH — 9:45 ET to 15:45 ET (engine also has a time-of-day score)
  const tod = hh * 60 + mm;
  if (tod < 9 * 60 + 45 || tod > 15 * 60 + 45) return;

  let modelsRes: Response, odteRes: Response;
  try {
    [modelsRes, odteRes] = await Promise.all([
      fetch(`${BASE}/api/models?symbol=^GSPC&experimental=1`),
      fetch(`${BASE}/api/odte-tracker`),
    ]);
  } catch {
    return;
  }
  if (!modelsRes.ok || !odteRes.ok) return;
  const models = await modelsRes.json().catch(() => null);
  const odte = await odteRes.json().catch(() => null);
  if (!models || !odte) return;

  const daily = models.horizons?.daily;
  if (!daily) return;

  const audit = daily.audit ?? {};
  const levels = (daily.levels ?? []) as any[];
  const spot = odte.spot ?? daily.spot ?? 0;
  // EM lives at audit.scenarioTargets.oneDayEM in the live model output;
  // top-level expectedMove / oneDayEM are not populated on the daily horizon.
  const oneDayEM =
    daily.expectedMove ??
    daily.oneDayEM ??
    audit?.scenarioTargets?.oneDayEM ??
    audit?.oneDayEM ??
    0;
  if (!spot || spot <= 0) return;

  const args: EvalArgs = {
    spot,
    asOf: Date.now(),
    hourET: hh,
    minuteET: mm,
    audit: {
      slope: audit.slope, dfi: audit.dfi, gammaZone: audit.gammaZone,
      vannaBias: audit.vannaBias, mainPivot: audit.mainPivot, charmZero: audit.charmZero,
    },
    levels: levels.map((l: any) => ({
      name: l.name, kind: l.kind, price: l.price, side: l.side,
      status: l.status, tag: l.tag,
    })),
    contracts: (odte.contracts ?? []).map((c: any) => ({
      key: c.key, strike: c.strike, side: c.side,
      bid: c.bid, ask: c.ask, mid: c.mid, last: c.last,
      volume: c.volume, openInterest: c.openInterest, expiry: c.expiry,
    })),
    oneDayEM: typeof oneDayEM === "number" ? oneDayEM : 0,
    expiry: odte.expiry ?? null,
  };

  let alerts = [];
  try {
    alerts = evaluateOdte(args);
  } catch (e: any) {
    console.warn(`[discordScheduler] odte engine threw: ${e?.message ?? e}`);
    return;
  }

  for (const a of alerts) {
    console.log(`[discordScheduler] 0DTE banger: ${a.side} ${a.setup} grade=${a.grade.letter} (${a.grade.score})`);
    try {
      await postOdteBangerAlert(a);
    } catch (e: any) {
      console.warn(`[discordScheduler] postOdteBangerAlert failed: ${e?.message ?? e}`);
    }
  }
}

// ─── 2d. 9:30 ET 0DTE pre-open scan ──────────────────────────────
//
// One-shot scan at 9:30 ET on every trading day, BEFORE the live window opens
// at 9:45. Same data sources (live SPX 0DTE chain + daily model), same
// engine (FAILED_BREAK / PIVOT_RECLAIM / WALL_REJECT detection), same gates
// (score ≥ 80, T1 ≥ 30%, Δ 0.20–0.70, max 3/day, 1hr global gap, 45min
// per-setup cooldown). Stays silent if nothing qualifies.
//
// Fires only on the FIRST tick where ET clock is ≥ 09:30 with a 14-min cap
// (we want this BEFORE pollOdteBangerAlerts opens at 9:45). Per-day guard
// via preOpenScanFired Set ensures it can't double-fire even if the tick
// lands twice in the 9:30 minute.

async function maybePreOpenOdteScan(): Promise<void> {
  const { dow, date, hh, mm } = etNow();
  if (!isTradingDay(dow, date)) return;
  if (preOpenScanFired.has(date)) return;
  const nowMin = hh * 60 + mm;
  const tgtMin = 9 * 60 + 30; // 9:30 ET
  if (nowMin < tgtMin) return;
  if (nowMin > tgtMin + 14) return; // cap before live window at 9:45
  preOpenScanFired.add(date);
  console.log(`[discordScheduler] 9:30 pre-open 0DTE scan firing at ${date} ${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")} ET`);

  let modelsRes: Response, odteRes: Response;
  try {
    [modelsRes, odteRes] = await Promise.all([
      fetch(`${BASE}/api/models?symbol=^GSPC&experimental=1`),
      fetch(`${BASE}/api/odte-tracker`),
    ]);
  } catch (e: any) {
    console.warn(`[discordScheduler] pre-open scan fetch failed: ${e?.message ?? e}`);
    return;
  }
  if (!modelsRes.ok || !odteRes.ok) {
    console.warn(`[discordScheduler] pre-open scan: models=${modelsRes.status} odte=${odteRes.status}`);
    return;
  }
  const models = await modelsRes.json().catch(() => null);
  const odte = await odteRes.json().catch(() => null);
  if (!models || !odte) return;

  const daily = models.horizons?.daily;
  if (!daily) return;
  const audit = daily.audit ?? {};
  const levels = (daily.levels ?? []) as any[];
  const spot = odte.spot ?? daily.spot ?? 0;
  const oneDayEM =
    daily.expectedMove ??
    daily.oneDayEM ??
    audit?.scenarioTargets?.oneDayEM ??
    audit?.oneDayEM ??
    0;
  if (!spot || spot <= 0) {
    console.warn(`[discordScheduler] pre-open scan: bad spot ${spot}`);
    return;
  }

  const args: EvalArgs = {
    spot,
    asOf: Date.now(),
    hourET: hh,
    minuteET: mm,
    audit: {
      slope: audit.slope, dfi: audit.dfi, gammaZone: audit.gammaZone,
      vannaBias: audit.vannaBias, mainPivot: audit.mainPivot, charmZero: audit.charmZero,
    },
    levels: levels.map((l: any) => ({
      name: l.name, kind: l.kind, price: l.price, side: l.side,
      status: l.status, tag: l.tag,
    })),
    contracts: (odte.contracts ?? []).map((c: any) => ({
      key: c.key, strike: c.strike, side: c.side,
      bid: c.bid, ask: c.ask, mid: c.mid, last: c.last,
      volume: c.volume, openInterest: c.openInterest, expiry: c.expiry,
    })),
    oneDayEM: typeof oneDayEM === "number" ? oneDayEM : 0,
    expiry: odte.expiry ?? null,
  };

  let alerts: any[] = [];
  try {
    alerts = evaluateOdte(args);
  } catch (e: any) {
    console.warn(`[discordScheduler] pre-open scan engine threw: ${e?.message ?? e}`);
    return;
  }

  if (alerts.length === 0) {
    console.log(`[discordScheduler] 9:30 pre-open 0DTE scan: no qualifying setups (silent)`);
    return;
  }

  for (const a of alerts) {
    console.log(`[discordScheduler] 9:30 pre-open 0DTE banger: ${a.side} ${a.setup} grade=${a.grade.letter} (${a.grade.score})`);
    try {
      await postOdteBangerAlert(a);
    } catch (e: any) {
      console.warn(`[discordScheduler] pre-open postOdteBangerAlert failed: ${e?.message ?? e}`);
    }
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

// ─── 1c. Settle previous trading day @ 16:01 ET ─────────────────────────
//
// Pulls today's SPX close from /api/quotes and runs settleDay() against
// the morning prediction. Idempotent — re-running is safe (INSERT OR
// REPLACE keyed on date).
const SETTLE_FIRED = new Set<string>(); // YYYY-MM-DD

async function maybeSettleDay(): Promise<void> {
  const { date, hh, mm, dow } = etNow();
  if (!isTradingDay(dow, date)) return;
  // Settle at 16:01 ET (one minute past close — gives prints a moment to land)
  if (hh !== 16 || mm !== 1) return;
  if (SETTLE_FIRED.has(date)) return;
  SETTLE_FIRED.add(date);
  try {
    const res = await fetch(`${BASE}/api/quotes`);
    if (!res.ok) {
      console.warn(`[discordScheduler] settle: /api/quotes ${res.status}`);
      return;
    }
    const q = await res.json();
    const spxClose = q?.SPX?.last ?? q?.spx?.last ?? q?.spx?.price ?? null;
    if (spxClose == null || !isFinite(spxClose)) {
      console.warn(`[discordScheduler] settle: no SPX close in quotes`);
      return;
    }
    const result = settleDay(date, spxClose);
    if (result) {
      console.log(`[discordScheduler] settled ${date}: close=${spxClose} outcome=${JSON.stringify(result.outcome)} brier=${result.brier.total.toFixed(3)}`);
    }
  } catch (e: any) {
    console.warn(`[discordScheduler] settle failed: ${e?.message ?? e}`);
  }
}

// ─── 1d. Weekly calibration card @ Sunday 20:00 ET ───────────────────────
//
// Runs on Sundays (dow === 0) at 20:00 ET. Posts a 7-day rolling Brier
// card to Discord. Pure observer — no calc changes.
const WEEKLY_CAL_FIRED = new Set<string>(); // YYYY-MM-DD (Sunday)

async function maybeFireWeeklyCalibration(): Promise<void> {
  const { date, hh, mm, dow } = etNow();
  if (dow !== 0) return; // Sunday only
  if (hh !== 20 || mm !== 0) return;
  if (WEEKLY_CAL_FIRED.has(date)) return;
  WEEKLY_CAL_FIRED.add(date);
  console.log(`[discordScheduler] firing weekly calibration card for ${date}`);
  try {
    await postCalibrationCard(7);
  } catch (e: any) {
    console.warn(`[discordScheduler] weekly calibration card failed: ${e?.message ?? e}`);
  }
}

// ─── Tick ──────────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  await maybeFireDaily();
  await maybePreOpenOdteScan();
  await maybeFireHalfHour();
  await maybeSettleDay();
  await maybeFireWeeklyCalibration();
  await pollLevelAndGammaAlerts();
  await pollNewsAlerts();
  await pollOdteBangerAlerts();

  // GC dailyFired weekly (small set, but keep tidy)
  if (dailyFired.size > 14) {
    const today = etNow().date;
    for (const k of Array.from(dailyFired)) {
      if (k !== today) dailyFired.delete(k);
    }
  }
  // GC preOpenScanFired — keep only today
  if (preOpenScanFired.size > 14) {
    const today = etNow().date;
    for (const k of Array.from(preOpenScanFired)) {
      if (k !== today) preOpenScanFired.delete(k);
    }
  }
  // GC HALFHOUR_FIRED — keep only today's entries
  if (HALFHOUR_FIRED.size > 20) {
    const today = etNow().date;
    for (const k of Array.from(HALFHOUR_FIRED)) {
      if (!k.startsWith(today)) HALFHOUR_FIRED.delete(k);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDiscordScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
  // First tick after 5s so server has a moment to warm
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  console.log(`[discordScheduler] started — daily 9:30 ET + 9:30 0DTE pre-open scan + 30-min cadence (10:00–16:00 ET) + 0DTE bangers (9:45–15:45 ET), alerts on level breaks + gamma flips + macro news`);
}

export function stopDiscordScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
