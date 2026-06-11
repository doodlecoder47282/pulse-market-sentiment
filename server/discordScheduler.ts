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
import { evaluateOdte, diagnoseOdte, setTenAmRegime, seedSpotHistory, type EvalArgs } from "./odteAlertEngine";
import { postBatcaveDailyCard } from "./discordBatcaveCard";
import { settleDay } from "./calibration";
import { postCalibrationCard } from "./calibrationCard";
import { getTodayEventContext } from "./volCalendar";
import { persistOdteAuditOnFire, persistOdteAuditOnReject, persistOdteEvaluationLog } from "./odteAuditDb";
import { mlQuantileOverlay } from "./mlBridge";

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${PORT}`;

// ─── Persisted dedup state (Bug fix: stop boot-spam on server restart) ───
//
// All four "X_FIRED" sets used to live in-memory only. On restart they reset
// to empty, so the next tick thought the most-recent 30-min slot hadn't fired
// yet and re-posted it. Persisting to a JSON file inside workspace fixes that
// without adding a DB table.
const SCHEDULER_STATE_PATH = "/home/user/workspace/sentiment-app/.discord-scheduler-state.json";

interface SchedulerPersistedState {
  dailyFired: string[];
  preOpenScanFired: string[];
  tenAmFired: string[];
  HALFHOUR_FIRED: string[];
  savedAt: number;
}

function loadSchedulerState(): Partial<SchedulerPersistedState> {
  try {
    if (!existsSync(SCHEDULER_STATE_PATH)) return {};
    const raw = readFileSync(SCHEDULER_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as SchedulerPersistedState;
    // Ignore state older than 48h to avoid resurrecting stale entries
    if (parsed.savedAt && Date.now() - parsed.savedAt > 48 * 3600_000) return {};
    return parsed;
  } catch (e) {
    console.warn(`[scheduler] loadSchedulerState failed (non-fatal): ${e}`);
    return {};
  }
}

function saveSchedulerState(): void {
  try {
    const dir = dirname(SCHEDULER_STATE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: SchedulerPersistedState = {
      dailyFired: Array.from(dailyFired),
      preOpenScanFired: Array.from(preOpenScanFired),
      tenAmFired: Array.from(tenAmFired),
      HALFHOUR_FIRED: Array.from(HALFHOUR_FIRED),
      savedAt: Date.now(),
    };
    writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify(payload, null, 2));
  } catch (e) {
    // Non-fatal — worst case we re-fire on next restart (same as before this fix)
    console.warn(`[scheduler] saveSchedulerState failed (non-fatal): ${e}`);
  }
}

// ─── ML helpers (Wires 17–20) ─────────────────────────────────────────
// GEX tier ordinal map: THIN=-1, LIGHT=0, SOFT=1, FULL=2
const GEX_TIER_ORD: Record<string, number> = {
  THIN: -1, LIGHT: 0, SOFT: 1, FULL: 2,
};

/**
 * Build the ML feature dict from an OdteAlert + NY time context.
 * Features that require live 1-min bars (realized_vol_5min, realized_vol_30min,
 * bar_return_1min, momentum_15min) are approximated from available alert data.
 * Features we cannot compute (vix_level, vix_pct_of_5d_avg) are omitted —
 * the predictor fills them from training_medians.
 */
function _buildMlFeatures(
  a: { asOf: number; side: string; spot: number; wire15?: any; grade?: any },
  audit: { gexTier?: string | null; gex?: number | null; sessionOpen?: number | null },
  hh: number,
  mm: number,
  dow: number,
): Record<string, number> {
  const isBull = a.side === "call";

  // Time features
  const hour_of_day = hh + mm / 60;
  const minute_of_hour = mm;
  const day_of_week = dow;

  // GEX features
  const gexTierStr = (a.wire15?.gexTier ?? audit?.gexTier ?? "").toUpperCase();
  const gex_regime_ord = GEX_TIER_ORD[gexTierStr] ?? 0;
  // net_gex_b: signed billions. Use raw GEX from audit (in $M), convert to $B.
  // Negative = dealers short gamma.
  const rawGexM = audit?.gex ?? null;
  const net_gex_b = rawGexM != null ? rawGexM / 1000 : 0;

  // Volatility proxies — best-effort from available fields.
  // wire15.rv5d is 5-day realized vol (annualized decimal). Use as a proxy for
  // realized_vol_30min. realized_vol_5min ≋ realized_vol_30min (no 1-min bars).
  const rv5d = a.wire15?.rv5d ?? null;
  const realized_vol_30min = rv5d != null ? rv5d / Math.sqrt(252 * 6.5 * 2) : 0;
  const realized_vol_5min = realized_vol_30min; // best proxy available without bars

  // Return / momentum — no 1-min bar buffer here; default to 0
  const bar_return_1min = 0;
  const momentum_15min = 0;

  // Distance from open
  const sessionOpen = audit?.sessionOpen ?? null;
  const distance_from_open_pct =
    sessionOpen != null && sessionOpen > 0
      ? (a.spot - sessionOpen) / sessionOpen
      : 0;

  // Time-of-day flags
  const todMin = hh * 60 + mm;
  const is_first_30min = todMin < 10 * 60 ? 1 : 0; // before 10:00
  const is_post_lunch = todMin >= 13 * 60 ? 1 : 0; // 13:00+ ET
  const is_last_30min = todMin >= 15 * 60 + 30 ? 1 : 0; // 15:30+ ET

  return {
    hour_of_day,
    minute_of_hour,
    day_of_week,
    gex_regime_ord,
    net_gex_b,
    realized_vol_5min,
    realized_vol_30min,
    bar_return_1min,
    momentum_15min,
    distance_from_open_pct,
    is_post_lunch,
    is_first_30min,
    is_last_30min,
  };
}

/**
 * Build an ML augmentation line for the Discord card.
 * - Calls mlQuantileOverlay (30min horizon only for 0DTE).
 * - Returns null on any ML failure — never throws.
 * - Models A (score_calibrator=BOOTSTRAP) and C (whale_follow=low_signal) are
 *   gated off — only Model B (quantile_overlay, status=TRAINED) is surfaced.
 */
async function _buildMlLine(
  a: { asOf: number; side: string; spot: number; wire15?: any; grade?: any },
  audit: { gexTier?: string | null; gex?: number | null; sessionOpen?: number | null },
  hh: number,
  mm: number,
  dow: number,
): Promise<string | undefined> {
  try {
    const features = _buildMlFeatures(a, audit, hh, mm, dow);
    const overlay = await mlQuantileOverlay(features, [30]);
    // Null or non-TRAINED → no line
    if (!overlay || overlay.status !== "TRAINED") return undefined;
    const band30 = overlay.bands["30"];
    if (!band30) return undefined;

    const q50 = band30.q50;
    const q90 = band30.q90;
    const q10 = band30.q10;

    const isCallSide = a.side === "call";
    // Directional sign check: BULLISH alert expects positive q50, BEARISH expects negative q50
    const counter = isCallSide ? q50 < 0 : q50 > 0;

    const fmt = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
    const q50Sign = q50 >= 0 ? "+" : "";
    const q50Pct = `${q50Sign}${(q50 * 100).toFixed(2)}%`;

    if (counter) {
      return `ML 30m: median move ${q50Pct} (counter-trend — consider passing)`;
    } else {
      const q90Pct = `+${(q90 * 100).toFixed(2)}%`;
      const q10Pct = `${(q10 * 100).toFixed(2)}%`;
      return `ML 30m: q50 ${q50Pct} · q90 ${q90Pct} / q10 ${q10Pct}`;
    }
  } catch {
    return undefined;
  }
}

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
const tenAmFired = new Set<string>(); // YYYY-MM-DD entries — 10:00 ET regime snapshot guard

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
  saveSchedulerState();
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
  saveSchedulerState();
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

  const { eventDayKind: evDayKind, eventGateActions: evGateActions } = getTodayEventContext();

  const args: EvalArgs = {
    spot,
    asOf: Date.now(),
    hourET: hh,
    minuteET: mm,
    audit: {
      slope: audit.slope, dfi: audit.dfi, gammaZone: audit.gammaZone,
      vannaBias: audit.vannaBias, mainPivot: audit.mainPivot, charmZero: audit.charmZero,
      vannaM: audit.vannaM, vommaPockets: audit.vommaPockets,
      realizedSigma20d: audit.realizedSigma20d,
      intradayPivot: audit.intradayPivot, wickZones: audit.wickZones,
      gex: audit.gex ?? null,
      sessionOpen: audit.sessionOpen ?? null,
      atmIV: audit.atmIV ?? null,
      vwapProfile: audit.vwapProfile ?? null,
    },
    levels: levels.map((l: any) => ({
      name: l.name, kind: l.kind, price: l.price, side: l.side,
      status: l.status, tag: l.tag,
    })),
    contracts: (odte.contracts ?? []).map((c: any) => ({
      key: c.key, strike: c.strike, side: c.side,
      bid: c.bid, ask: c.ask, mid: c.mid, last: c.last,
      volume: c.volume, openInterest: c.openInterest, expiry: c.expiry,
      iv: c.iv ?? c.impliedVolatility ?? null,
    })),
    oneDayEM: typeof oneDayEM === "number" ? oneDayEM : 0,
    expiry: odte.expiry ?? null,
    // Papers I+J: event-day gate
    eventDayKind: evDayKind,
    eventGateActions: evGateActions,
  };

  // Use diagnoseOdte so we get BOTH fireable + rejected lists.
  // Audit-on-reject lets us debug why no trades fired in production — without
  // this, an empty audit table is ambiguous (no setups detected vs all gated out).
  let diag: { fireable: any[]; rejected: Array<{ alert: any; reason: string }> };
  try {
    diag = await diagnoseOdte(args);
  } catch (e: any) {
    console.warn(`[discordScheduler] odte engine threw: ${e?.message ?? e}`);
    return;
  }

  // Persist rejects for postmortem analysis (cheap — sqlite local)
  for (const { alert, reason } of diag.rejected) {
    persistOdteAuditOnReject(alert, reason);
  }
  const byReason: Record<string, number> = diag.rejected.length
    ? diag.rejected.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {} as Record<string, number>)
    : {};
  if (diag.rejected.length > 0) {
    console.log(`[discordScheduler] 0DTE rejects: ${JSON.stringify(byReason)}`);
  }
  // Wire 21 (Bug Fix Night 6/3): persist evaluation telemetry on EVERY run
  // even when fireable=0 and rejected=0 (i.e. cold boot bail). This is the
  // visibility layer that answers "is the engine working?" honestly.
  try {
    const topReject = diag.rejected
      .slice()
      .sort((a, b) => (b.alert?.grade?.score ?? 0) - (a.alert?.grade?.score ?? 0))[0];
    persistOdteEvaluationLog({
      ts: Date.now(),
      spot: args.spot,
      spotHistoryLen: (diag as any).spotHistoryLen,
      candidatesSeen: diag.fireable.length + diag.rejected.length,
      fireableCount: diag.fireable.length,
      rejectedCount: diag.rejected.length,
      bailReason: (diag as any).bailReason ?? null,
      rejectBreakdown: byReason,
      nearMiss: topReject ? {
        score: topReject.alert?.grade?.score ?? 0,
        setup: topReject.alert?.setup ?? "?",
        side: topReject.alert?.side ?? "?",
      } : null,
      gex: audit?.gex?.totalGex ?? null,
      regime: audit?.gex?.regime ?? null,
      pcrOi: audit?.pcr?.oi ?? null,
    });
  } catch (e: any) {
    console.warn(`[discordScheduler] eval log persist failed: ${e?.message ?? e}`);
  }

  // Fire only the ones that passed all gates
  for (const a of diag.fireable) {
    console.log(`[discordScheduler] 0DTE banger: ${a.side} ${a.setup} grade=${a.grade.letter} (${a.grade.score})`);
    persistOdteAuditOnFire(a);
    // Wires 17–20: compute ML quantile overlay line (null on any failure — never blocks)
    const mlLine = await _buildMlLine(a, audit, hh, mm, dow).catch(() => undefined);
    try {
      await postOdteBangerAlert(a, mlLine);
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
  saveSchedulerState();
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

  const { eventDayKind: preEvDayKind, eventGateActions: preEvGateActions } = getTodayEventContext();

  const args: EvalArgs = {
    spot,
    asOf: Date.now(),
    hourET: hh,
    minuteET: mm,
    audit: {
      slope: audit.slope, dfi: audit.dfi, gammaZone: audit.gammaZone,
      vannaBias: audit.vannaBias, mainPivot: audit.mainPivot, charmZero: audit.charmZero,
      vannaM: audit.vannaM, vommaPockets: audit.vommaPockets,
      realizedSigma20d: audit.realizedSigma20d,
      intradayPivot: audit.intradayPivot, wickZones: audit.wickZones,
      gex: audit.gex ?? null,
      sessionOpen: audit.sessionOpen ?? null,
      atmIV: audit.atmIV ?? null,
      vwapProfile: audit.vwapProfile ?? null,
    },
    levels: levels.map((l: any) => ({
      name: l.name, kind: l.kind, price: l.price, side: l.side,
      status: l.status, tag: l.tag,
    })),
    contracts: (odte.contracts ?? []).map((c: any) => ({
      key: c.key, strike: c.strike, side: c.side,
      bid: c.bid, ask: c.ask, mid: c.mid, last: c.last,
      volume: c.volume, openInterest: c.openInterest, expiry: c.expiry,
      iv: c.iv ?? c.impliedVolatility ?? null,
    })),
    oneDayEM: typeof oneDayEM === "number" ? oneDayEM : 0,
    expiry: odte.expiry ?? null,
    // Papers I+J: event-day gate
    eventDayKind: preEvDayKind,
    eventGateActions: preEvGateActions,
  };

  let alerts: any[] = [];
  try {
    alerts = await evaluateOdte(args);
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
    persistOdteAuditOnFire(a);
    // Wires 17–20: compute ML quantile overlay line (null on any failure — never blocks)
    const mlLine = await _buildMlLine(a, audit, hh, mm, dow).catch(() => undefined);
    try {
      await postOdteBangerAlert(a, mlLine);
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
  // Gate: only fire macro news alerts on actual trading days (weekday + non-holiday)
  const { dow, date } = etNow();
  if (!isTradingDay(dow, date)) return;

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

// ─── 2e. 10:00 ET regime snapshot ───────────────────────────────────────────
//
// Once-per-trading-day at 10:00 ET, capture the model's DFI / gammaZone /
// vannaBias / spot / mainPivot from /api/models and hand it to the 0DTE
// engine via setTenAmRegime(). The engine's Upgrade 3 (Vilkov tilt) consumes
// this from 10:00–11:30 ET to bias scoreSetup ±5/±7 based on alignment.
// Cap at 10:14 ET so we don't fire late if the tick drifts.

async function maybeFireTenAmRegime(): Promise<void> {
  const { dow, date, hh, mm } = etNow();
  if (!isTradingDay(dow, date)) return;
  if (tenAmFired.has(date)) return;
  const nowMin = hh * 60 + mm;
  const tgtMin = 10 * 60; // 10:00 ET
  if (nowMin < tgtMin) return;
  if (nowMin > tgtMin + 14) return;
  tenAmFired.add(date);
  saveSchedulerState();

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/models?symbol=^GSPC&experimental=1`);
  } catch (e: any) {
    console.warn(`[discordScheduler] 10AM regime fetch failed: ${e?.message ?? e}`);
    return;
  }
  if (!res.ok) {
    console.warn(`[discordScheduler] 10AM regime: models=${res.status}`);
    return;
  }
  const models = await res.json().catch(() => null);
  const daily = models?.horizons?.daily;
  if (!daily) return;
  const audit = daily.audit ?? {};
  const spot = daily.spot ?? 0;
  const mainPivot = audit.mainPivot ?? daily.mainPivot ?? 0;
  if (!spot || !mainPivot) {
    console.warn(`[discordScheduler] 10AM regime: bad spot=${spot} mainPivot=${mainPivot}`);
    return;
  }
  try {
    setTenAmRegime({
      date,
      dfi: Number(audit.dfi ?? 0),
      gammaZone: String(audit.gammaZone ?? ""),
      vannaBias: String(audit.vannaBias ?? ""),
      spot: Number(spot),
      mainPivot: Number(mainPivot),
    });
    console.log(`[discordScheduler] 10AM regime snapshot set: dfi=${audit.dfi} gammaZone=${audit.gammaZone} vannaBias=${audit.vannaBias} spot=${spot} pivot=${mainPivot}`);
  } catch (e: any) {
    console.warn(`[discordScheduler] 10AM regime setTenAmRegime threw: ${e?.message ?? e}`);
  }
}

// ─── Tick ──────────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  await maybeFireDaily();
  await maybePreOpenOdteScan();
  await maybeFireTenAmRegime();
  await maybeFireHalfHour();
  await maybeSettleDay();
  await maybeFireWeeklyCalibration();
  await pollLevelAndGammaAlerts();
  await pollNewsAlerts();
  await pollOdteBangerAlerts();

  // GC dailyFired weekly (small set, but keep tidy)
  let gcDirty = false;
  if (dailyFired.size > 14) {
    const today = etNow().date;
    for (const k of Array.from(dailyFired)) {
      if (k !== today) { dailyFired.delete(k); gcDirty = true; }
    }
  }
  // GC preOpenScanFired — keep only today
  if (preOpenScanFired.size > 14) {
    const today = etNow().date;
    for (const k of Array.from(preOpenScanFired)) {
      if (k !== today) { preOpenScanFired.delete(k); gcDirty = true; }
    }
  }
  // GC tenAmFired — keep only today
  if (tenAmFired.size > 14) {
    const today = etNow().date;
    for (const k of Array.from(tenAmFired)) {
      if (k !== today) { tenAmFired.delete(k); gcDirty = true; }
    }
  }
  // GC HALFHOUR_FIRED — keep only today's entries
  if (HALFHOUR_FIRED.size > 20) {
    const today = etNow().date;
    for (const k of Array.from(HALFHOUR_FIRED)) {
      if (!k.startsWith(today)) { HALFHOUR_FIRED.delete(k); gcDirty = true; }
    }
  }
  if (gcDirty) saveSchedulerState();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDiscordScheduler(): void {
  if (timer) return;

  // ── Restore dedup state from disk so we don't re-fire on restart ──
  const persisted = loadSchedulerState();
  if (persisted.dailyFired)       for (const k of persisted.dailyFired)       dailyFired.add(k);
  if (persisted.preOpenScanFired) for (const k of persisted.preOpenScanFired) preOpenScanFired.add(k);
  if (persisted.tenAmFired)       for (const k of persisted.tenAmFired)       tenAmFired.add(k);
  if (persisted.HALFHOUR_FIRED)   for (const k of persisted.HALFHOUR_FIRED)   HALFHOUR_FIRED.add(k);
  if (persisted.savedAt) {
    console.log(`[scheduler] restored dedup state from disk — daily=${dailyFired.size} preOpen=${preOpenScanFired.size} tenAm=${tenAmFired.size} halfHour=${HALFHOUR_FIRED.size}`);
  }

  // Seed spotHistory from Yahoo 1-min bars before starting the poll loop.
  // This prevents the engine from being blind on cold boot / redeployment.
  // Errors are swallowed — don't block scheduler startup.
  seedSpotHistory()
    .then((result) => {
      console.log(
        `[scheduler] seedSpotHistory: seeded=${result.seeded} oldestTs=${result.oldestTs} newestTs=${result.newestTs}`,
      );
    })
    .catch((e) => {
      console.warn(`[scheduler] seedSpotHistory failed (non-fatal): ${e?.message ?? e}`);
    });

  timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
  // First tick after 5s so server has a moment to warm.
  // Dedup state was just restored from disk above, so any slot that already
  // fired in the last 48h is suppressed here — no more boot-spam on restart.
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  console.log(`[discordScheduler] started — daily 9:30 ET + 9:30 0DTE pre-open scan + 10:00 regime snapshot + 30-min cadence (10:00–16:00 ET) + 0DTE bangers (9:45–15:45 ET), alerts on level breaks + gamma flips + macro news`);
}

export function stopDiscordScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
