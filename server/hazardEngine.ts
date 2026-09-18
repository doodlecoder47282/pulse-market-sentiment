// server/hazardEngine.ts
//
// 0DTE Hazard Engine — time-varying survival model for intraday SPX moves.
//
// Question it answers: given an entry at minute M with a target T points away
// and a stop S points away, what is p(target hits BEFORE stop), and how does
// that probability decay conditional on still being alive N minutes later?
//
// v1 fits on SYNTHETIC entries walked through real SPX minute candles
// (~6 months of Schwab minute history). Every historical RTH minute becomes a
// candidate entry; paths are replayed bar by bar until target, stop, or close.
// This is a defensible baseline — NOT fitted on real alert fires. Once ≥50
// graded 0DTE fires exist in odte_alert_audit the status endpoint flags
// refit-ready and the empirical ledger takes over in a later pass.
//
// Honesty rules baked in:
//   - if target AND stop print inside the same minute bar → counted as STOP
//     (worst case; we cannot know intra-bar ordering)
//   - vol normalization: thresholds are scaled per historical day by that
//     day's realized 1-min unit vs the recent reference unit, so a 3-pt
//     target on a dead tape isn't pooled with a 3-pt target on CPI day
//   - sample counts always reported; verdicts refuse below MIN_SAMPLES

import { sqlite } from "./storage";
import { schwabFetch } from "./schwab";

// ─── Minute bar store ─────────────────────────────────────────────────

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS spx_minute_bars (
    ts INTEGER PRIMARY KEY,      -- epoch ms (bar open)
    date TEXT NOT NULL,          -- ET yyyy-mm-dd
    mod INTEGER NOT NULL,        -- minutes since 9:30 ET (0..389)
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    v INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_spx_minute_date ON spx_minute_bars(date, mod);
`);

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function etParts(ts: number): { date: string; mod: number } {
  const parts = etFmt.formatToParts(ts);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const mod = (Number(get("hour")) - 9) * 60 + Number(get("minute")) - 30;
  return { date, mod };
}

const insertBar = sqlite.prepare(
  `INSERT OR IGNORE INTO spx_minute_bars (ts, date, mod, o, h, l, c, v)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

function storeCandles(candles: any[]): number {
  let added = 0;
  const txn = sqlite.transaction((rows: any[]) => {
    for (const cd of rows) {
      const ts = Number(cd.datetime);
      if (!Number.isFinite(ts)) continue;
      const { date, mod } = etParts(ts);
      if (mod < 0 || mod > 389) continue; // RTH only
      const r = insertBar.run(ts, date, mod, cd.open, cd.high, cd.low, cd.close, cd.volume ?? 0);
      added += r.changes;
    }
  });
  txn(candles);
  return added;
}

// ─── Backfill ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
let backfillRunning = false;
let lastBackfill: { at: number; added: number; chunksOk: number; chunksEmpty: number } | null = null;

/** Chunked backfill: walks back ~185 days in 10-day windows. Schwab minute
 *  history reaches ~6 months back; empty chunks past the horizon are normal. */
export async function backfillSpxMinuteBars(maxDaysBack = 185): Promise<typeof lastBackfill> {
  if (backfillRunning) return lastBackfill;
  backfillRunning = true;
  let added = 0, chunksOk = 0, chunksEmpty = 0;
  try {
    const now = Date.now();
    for (let back = 0; back < maxDaysBack; back += 10) {
      const endDate = now - back * DAY_MS;
      const startDate = endDate - 10 * DAY_MS;
      try {
        const data: any = await schwabFetch("marketdata/v1/pricehistory", {
          symbol: "$SPX",
          periodType: "day",
          period: 10,
          frequencyType: "minute",
          frequency: 1,
          needExtendedHoursData: "false",
          startDate,
          endDate,
        });
        const candles = data?.candles ?? [];
        if (candles.length > 0) {
          added += storeCandles(candles);
          chunksOk++;
        } else {
          chunksEmpty++;
          if (chunksEmpty >= 3 && chunksOk > 0) break; // past the history horizon
        }
      } catch (e: any) {
        console.warn(`[hazard] backfill chunk ${back}d failed: ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, 400)); // rate-friendly spacing
    }
    lastBackfill = { at: Date.now(), added, chunksOk, chunksEmpty };
    invalidateCaches();
    console.log(`[hazard] backfill — added=${added} chunksOk=${chunksOk} empty=${chunksEmpty} coverage=${coverageDays()}d`);
  } finally {
    backfillRunning = false;
  }
  return lastBackfill;
}

let refresherStarted = false;
export function startHazardBackfill(): void {
  if (refresherStarted) return;
  refresherStarted = true;
  // Full backfill once at boot (idempotent — INSERT OR IGNORE), then keep the
  // last few days fresh every 6h.
  void backfillSpxMinuteBars();
  setInterval(() => void backfillSpxMinuteBars(6), 6 * 60 * 60 * 1000);
  console.log("[hazard] backfiller started — full sweep at boot, 6h freshness ticks");
}

function coverageDays(): number {
  const r = sqlite.prepare("SELECT COUNT(DISTINCT date) AS n FROM spx_minute_bars").get() as any;
  return r?.n ?? 0;
}

// ─── Day cache ────────────────────────────────────────────────────────

interface DayPath {
  date: string;
  bars: Array<{ mod: number; h: number; l: number; c: number }>; // sorted by mod
  byMod: Map<number, number>; // mod → index into bars
  unit: number;               // mean abs 1-min close move (points) — vol unit
}

let dayCache: DayPath[] | null = null;
let refUnitCache: number | null = null;

function invalidateCaches(): void {
  dayCache = null;
  refUnitCache = null;
  simCache.clear();
}

function loadDays(): DayPath[] {
  if (dayCache) return dayCache;
  const rows = sqlite
    .prepare("SELECT date, mod, h, l, c FROM spx_minute_bars ORDER BY date, mod")
    .all() as Array<{ date: string; mod: number; h: number; l: number; c: number }>;
  const map = new Map<string, DayPath>();
  for (const r of rows) {
    let d = map.get(r.date);
    if (!d) {
      d = { date: r.date, bars: [], byMod: new Map(), unit: 0 };
      map.set(r.date, d);
    }
    d.byMod.set(r.mod, d.bars.length);
    d.bars.push({ mod: r.mod, h: r.h, l: r.l, c: r.c });
  }
  const days: DayPath[] = [];
  for (const d of map.values()) {
    if (d.bars.length < 200) continue; // partial days (holidays, gaps) excluded
    let sum = 0, n = 0;
    for (let i = 1; i < d.bars.length; i++) {
      sum += Math.abs(d.bars[i].c - d.bars[i - 1].c);
      n++;
    }
    d.unit = n > 0 ? sum / n : 0;
    if (d.unit > 0) days.push(d);
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  dayCache = days;
  return days;
}

/** Reference vol unit = median 1-min unit over the most recent 20 sessions.
 *  Requested thresholds are assumed to be sized for THIS tape; each
 *  historical day's thresholds get scaled by (dayUnit / refUnit). */
function refUnit(): number {
  if (refUnitCache != null) return refUnitCache;
  const days = loadDays();
  const recent = days.slice(-20).map((d) => d.unit).sort((a, b) => a - b);
  refUnitCache = recent.length > 0 ? recent[Math.floor(recent.length / 2)] : 1;
  return refUnitCache;
}

// ─── Path simulation ──────────────────────────────────────────────────

export interface HazardCurvePoint {
  minute: number;        // minutes since entry
  alive: number;         // paths still undecided at this minute
  condPWin: number | null; // p(target before stop | alive at this minute)
}

export interface HazardResult {
  source: "synthetic";
  sampleSize: number;
  daysCovered: number;
  pTarget: number;
  pStop: number;
  pExpire: number;       // neither hit by close
  medianMinToTarget: number | null;
  curve: HazardCurvePoint[];
  breakevenP: number;
  volScaled: boolean;
  note: string;
}

const MIN_SAMPLES = 300;
const simCache = new Map<string, HazardResult>();

/** Simulate: entries at every historical minute within ±window of entryMod,
 *  walk forward until target/stop/close. Direction 'up' = long calls (target
 *  above, stop below); 'down' mirrors. */
export function computeHazard(opts: {
  entryMod: number;       // minutes since 9:30 ET at entry (0..389)
  targetPts: number;      // SPX points to target (positive)
  stopPts: number;        // SPX points to stop (positive)
  direction: "up" | "down";
  windowMin?: number;     // entry-time matching window (default ±20)
}): HazardResult | { error: string; sampleSize?: number } {
  const { entryMod, direction } = opts;
  const windowMin = opts.windowMin ?? 20;
  const targetPts = Math.abs(opts.targetPts);
  const stopPts = Math.abs(opts.stopPts);
  if (!Number.isFinite(targetPts) || !Number.isFinite(stopPts) || targetPts <= 0 || stopPts <= 0) {
    return { error: "targetPts and stopPts must be positive numbers" };
  }
  const key = `${Math.round(entryMod / 5) * 5}|${targetPts.toFixed(1)}|${stopPts.toFixed(1)}|${direction}|${windowMin}`;
  const hit = simCache.get(key);
  if (hit) return hit;

  const days = loadDays();
  if (days.length < 20) {
    return { error: `insufficient minute history — ${days.length} days cached (need 20+)`, sampleSize: 0 };
  }
  const ref = refUnit();

  type Sample = { outcome: "target" | "stop" | "expire"; minutes: number };
  const samples: Sample[] = [];

  const lo = Math.max(0, entryMod - windowMin);
  const hi = Math.min(374, entryMod + windowMin); // ≥15 min must remain

  for (const day of days) {
    const scale = ref > 0 ? day.unit / ref : 1;
    const tgt = targetPts * scale;
    const stp = stopPts * scale;
    for (let m = lo; m <= hi; m += 3) { // every 3rd minute — thins path overlap
      const idx = day.byMod.get(m);
      if (idx == null) continue;
      const entryPx = day.bars[idx].c;
      const tgtPx = direction === "up" ? entryPx + tgt : entryPx - tgt;
      const stpPx = direction === "up" ? entryPx - stp : entryPx + stp;
      let outcome: Sample["outcome"] = "expire";
      let minutes = 0;
      for (let j = idx + 1; j < day.bars.length; j++) {
        const b = day.bars[j];
        minutes = b.mod - m;
        const hitTgt = direction === "up" ? b.h >= tgtPx : b.l <= tgtPx;
        const hitStp = direction === "up" ? b.l <= stpPx : b.h >= stpPx;
        if (hitStp) { outcome = "stop"; break; }   // both-in-bar → stop (worst case)
        if (hitTgt) { outcome = "target"; break; }
      }
      samples.push({ outcome, minutes });
    }
  }

  if (samples.length < MIN_SAMPLES) {
    return { error: `only ${samples.length} matched samples (need ${MIN_SAMPLES}+)`, sampleSize: samples.length };
  }

  const n = samples.length;
  const nT = samples.filter((s) => s.outcome === "target").length;
  const nS = samples.filter((s) => s.outcome === "stop").length;
  const nE = n - nT - nS;
  const tgtTimes = samples.filter((s) => s.outcome === "target").map((s) => s.minutes).sort((a, b) => a - b);

  // Conditional survival curve at 5-min steps
  const curve: HazardCurvePoint[] = [];
  const maxHorizon = Math.min(390 - entryMod, 240);
  for (let m = 0; m <= maxHorizon; m += 5) {
    const alivePaths = samples.filter((s) => s.minutes > m || (s.outcome === "expire" && s.minutes >= m));
    const wins = alivePaths.filter((s) => s.outcome === "target").length;
    curve.push({
      minute: m,
      alive: alivePaths.length,
      condPWin: alivePaths.length >= 50 ? wins / alivePaths.length : null,
    });
  }

  const result: HazardResult = {
    source: "synthetic",
    sampleSize: n,
    daysCovered: days.length,
    pTarget: nT / n,
    pStop: nS / n,
    pExpire: nE / n,
    medianMinToTarget: tgtTimes.length > 0 ? tgtTimes[Math.floor(tgtTimes.length / 2)] : null,
    curve,
    breakevenP: 0, // filled by caller (needs option-space target/stop pcts)
    volScaled: true,
    note: "synthetic paths on real SPX minute candles — both-in-bar counted as stop (worst case); thresholds vol-scaled per day",
  };
  simCache.set(key, result);
  return result;
}

// ─── Option-space helpers ─────────────────────────────────────────────

function normCdf(x: number): number {
  // Abramowitz-Stegun erf approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

/** Rough 0DTE delta from moneyness + remaining time. Good enough to map
 *  option % targets into underlying points — NOT for pricing. */
export function estimateOdteDelta(opts: {
  spot: number; strike: number; side: "C" | "P"; minutesRemaining: number; dayUnitPts: number;
}): number {
  const { spot, strike, side, minutesRemaining, dayUnitPts } = opts;
  const sigmaRem = Math.max(0.5, (dayUnitPts / 0.7979) * Math.sqrt(Math.max(1, minutesRemaining)));
  const d = (spot - strike) / sigmaRem;
  const callDelta = normCdf(d);
  const delta = side === "C" ? callDelta : callDelta - 1;
  return Math.min(0.9, Math.max(0.1, Math.abs(delta)));
}

/** Convert option-space target/stop (% of premium) into underlying points. */
export function optionPctToPoints(pct: number, entryPrice: number, absDelta: number): number {
  return (Math.abs(pct) / 100) * entryPrice / Math.max(0.1, absDelta);
}

/** Current day's vol unit — falls back to reference unit before enough bars print. */
export function currentDayUnit(): number {
  const days = loadDays();
  const today = etParts(Date.now()).date;
  const d = days.find((x) => x.date === today);
  return d?.unit ?? refUnit();
}

// ─── Status / empirical refit hook ────────────────────────────────────

export function hazardStatus() {
  let gradedFires = 0;
  try {
    const r = sqlite
      .prepare("SELECT COUNT(*) AS n FROM odte_alert_audit WHERE graded = 1 AND outcome_json LIKE '%\"result\":\"w%'")
      .get() as any;
    const r2 = sqlite
      .prepare("SELECT COUNT(*) AS n FROM odte_alert_audit WHERE graded = 1 AND (outcome_json LIKE '%\"result\":\"w%' OR outcome_json LIKE '%\"result\":\"l%')")
      .get() as any;
    gradedFires = r2?.n ?? r?.n ?? 0;
  } catch { /* table may not exist in fresh installs */ }
  return {
    coverageDays: coverageDays(),
    barsStored: (sqlite.prepare("SELECT COUNT(*) AS n FROM spx_minute_bars").get() as any)?.n ?? 0,
    lastBackfill,
    backfillRunning,
    gradedFires,
    refitReady: gradedFires >= 50,
    refUnitPts: refUnit(),
    source: "synthetic" as const,
  };
}
