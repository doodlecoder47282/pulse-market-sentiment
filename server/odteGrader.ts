/**
 * MISSION FIX #0 — 0DTE Alert Grader.
 *
 * The odte_alert_audit table has had outcome columns (outcome_json, pct_return,
 * hit_30, hit_50, hit_t1, graded) since Wire 20, but NOTHING ever graded rows.
 * Without graded fires, grade calibration can never converge — this module
 * closes that loop.
 *
 * Grading method (first-touch, minute bars):
 *   - Fetch SPX minute candles for the fire day via Schwab getPriceHistory.
 *   - Walk bars from detected_at forward to the 16:00 ET close.
 *   - CALL alert: WIN (hit_t1=1) if a bar's high touches t1 BEFORE any bar's
 *     low touches the stop level. PUT alert: mirrored. Same-bar tie is graded
 *     conservatively as a LOSS (stop assumed first).
 *   - pct_return = best favorable underlying excursion in the alert direction,
 *     as % of spot at fire.
 *   - hit_30 / hit_50 = approximate option return milestones, scaling the
 *     projected T1 option gain linearly with underlying progress toward T1.
 *     Approximation is disclosed in outcome_json.method.
 *
 * REJECTED rows are graded too — that's the counterfactual ledger that tells
 * us whether the gates are adding value or just muting alerts.
 *
 * Rows older than MAX_LOOKBACK_DAYS with no minute data available are marked
 * graded with result "insufficient_history" so the loop never spins on them.
 */

import { sqlite } from "./storage";
import { getPriceHistory } from "./schwab";

const MAX_LOOKBACK_DAYS = 9; // Schwab minute history reaches ~10 days back

interface AuditRow {
  id: number;
  alert_id: string;
  detected_at: number;
  score: number;
  tier: string;
  setup: string;
  side: string;
  features_json: string;
  contract_json: string;
  t1_target: number;
  entry_price: number;
}

interface Candle { datetime: number; open: number; high: number; low: number; close: number }

export interface OdteGradingSummary {
  ranAt: number;
  graded: number;
  wins: number;
  losses: number;
  insufficient: number;
  errors: number;
}

function etCloseMs(fireMs: number): number {
  // 16:00 ET on the fire day. Build from the fire timestamp's ET date.
  const et = new Date(new Date(fireMs).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utcOffsetMs = fireMs - Date.parse(
    new Date(fireMs).toLocaleString("en-US", { timeZone: "America/New_York" }) + " UTC",
  );
  const close = new Date(et); close.setHours(16, 0, 0, 0);
  return close.getTime() + utcOffsetMs;
}

function marketClosedFor(fireMs: number, now: number): boolean {
  return now >= etCloseMs(fireMs) + 10 * 60_000; // 16:10 ET buffer
}

/** Minute-candle cache per grading run — one Schwab call per run, not per row. */
let _candleCache: { fetchedAt: number; candles: Candle[] } | null = null;

async function getSpxMinuteCandles(): Promise<Candle[]> {
  const now = Date.now();
  if (_candleCache && now - _candleCache.fetchedAt < 5 * 60_000) return _candleCache.candles;
  const resp = await getPriceHistory("$SPX", "day", 10, "minute", 1);
  const candles: Candle[] = (resp.candles ?? [])
    .filter((c: any) => c.close != null && isFinite(c.close))
    .map((c: any) => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close }));
  _candleCache = { fetchedAt: now, candles };
  return candles;
}

function gradeRow(row: AuditRow, candles: Candle[], now: number): {
  outcome: Record<string, unknown>;
  pctReturn: number | null;
  hit30: number | null;
  hit50: number | null;
  hitT1: number | null;
} | null {
  let features: any = {};
  try { features = JSON.parse(row.features_json || "{}"); } catch { /* noop */ }

  const isCall = String(row.side).toUpperCase().startsWith("C") || String(row.side).toUpperCase() === "CALL";
  const t1 = Number(row.t1_target);
  const spotAtFire = Number(features.spot ?? features.spotAtFire ?? 0);
  const stopLevel = Number(features.stopLevel ?? 0);
  const t1EstPct = Number(features.t1EstPct ?? features.t1Pct ?? 0);

  if (!isFinite(t1) || t1 <= 0) {
    return { outcome: { result: "insufficient_inputs", reason: "no t1_target" }, pctReturn: null, hit30: null, hit50: null, hitT1: null };
  }

  const closeMs = etCloseMs(row.detected_at);
  const bars = candles.filter((c) => c.datetime >= row.detected_at && c.datetime <= closeMs);
  if (bars.length < 3) {
    return { outcome: { result: "insufficient_history", bars: bars.length }, pctReturn: null, hit30: null, hit50: null, hitT1: null };
  }

  const spot0 = spotAtFire > 0 ? spotAtFire : bars[0].open;
  // Legacy rows without stopLevel: synthesize a stop at 0.35% adverse — the
  // engine's typical invalidation distance. Disclosed in outcome_json.
  const stop = stopLevel > 0 ? stopLevel : (isCall ? spot0 * (1 - 0.0035) : spot0 * (1 + 0.0035));
  const stopSynthesized = !(stopLevel > 0);

  let hitT1 = 0;
  let stopped = false;
  let bestFavorable = 0; // favorable excursion in points
  let touchBar: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const t1Touched = isCall ? b.high >= t1 : b.low <= t1;
    const stopTouched = isCall ? b.low <= stop : b.high >= stop;
    const fav = isCall ? b.high - spot0 : spot0 - b.low;
    if (fav > bestFavorable) bestFavorable = fav;
    if (stopTouched) { stopped = true; break; }        // conservative: same-bar tie = loss
    if (t1Touched) { hitT1 = 1; touchBar = i; break; }
  }

  const lastClose = bars[bars.length - 1].close;
  const dirMoveClosePct = ((isCall ? lastClose - spot0 : spot0 - lastClose) / spot0) * 100;
  const bestFavorablePct = (bestFavorable / spot0) * 100;

  // Approximate option-return milestones by scaling the projected T1 option
  // gain with underlying progress toward T1. Linear approximation, disclosed.
  const distToT1 = Math.abs(t1 - spot0);
  let hit30: number | null = null;
  let hit50: number | null = null;
  if (t1EstPct > 0 && distToT1 > 0) {
    const bestOptPct = t1EstPct * (bestFavorable / distToT1) * 100; // t1EstPct may be decimal
    const scale = t1EstPct < 5 ? 100 : 1; // decimal (0.8) vs whole (80)
    const opt = t1EstPct * scale * (bestFavorable / distToT1);
    hit30 = opt >= 30 ? 1 : 0;
    hit50 = opt >= 50 ? 1 : 0;
    void bestOptPct;
  } else if (hitT1) {
    hit30 = 1; hit50 = null;
  }

  return {
    outcome: {
      result: hitT1 ? "t1_first" : stopped ? "stop_first" : "no_touch_eod",
      method: "minute-first-touch v1; option milestones linear-scaled from projected T1 gain",
      stopSynthesized,
      spotAtFire: spot0,
      t1,
      stop,
      bars: bars.length,
      touchBarIdx: touchBar,
      bestFavorablePct: Number(bestFavorablePct.toFixed(3)),
      dirMoveClosePct: Number(dirMoveClosePct.toFixed(3)),
      gradedFrom: now,
    },
    pctReturn: Number(bestFavorablePct.toFixed(3)),
    hit30,
    hit50,
    hitT1,
  };
}

export async function gradeOdteAlerts(now: number = Date.now()): Promise<OdteGradingSummary> {
  const summary: OdteGradingSummary = { ranAt: now, graded: 0, wins: 0, losses: 0, insufficient: 0, errors: 0 };
  try {
    const rows = sqlite
      .prepare(`SELECT * FROM odte_alert_audit WHERE graded = 0 ORDER BY detected_at ASC LIMIT 200`)
      .all() as AuditRow[];
    if (rows.length === 0) return summary;

    const due = rows.filter((r) => marketClosedFor(r.detected_at, now));
    if (due.length === 0) return summary;

    // Rows beyond minute-history reach: mark insufficient without a fetch.
    const tooOld = due.filter((r) => now - r.detected_at > MAX_LOOKBACK_DAYS * 24 * 3600_000);
    const gradeable = due.filter((r) => now - r.detected_at <= MAX_LOOKBACK_DAYS * 24 * 3600_000);

    const mark = sqlite.prepare(`
      UPDATE odte_alert_audit
      SET outcome_json = ?, pct_return = ?, hit_30 = ?, hit_50 = ?, hit_t1 = ?, graded = 1, graded_at = ?
      WHERE id = ?
    `);

    for (const r of tooOld) {
      mark.run(JSON.stringify({ result: "insufficient_history", reason: "beyond minute-history window" }), null, null, null, null, now, r.id);
      summary.insufficient++;
    }

    if (gradeable.length > 0) {
      const candles = await getSpxMinuteCandles();
      for (const r of gradeable) {
        try {
          const g = gradeRow(r, candles, now);
          if (!g) continue;
          mark.run(JSON.stringify(g.outcome), g.pctReturn, g.hit30, g.hit50, g.hitT1, now, r.id);
          summary.graded++;
          if (g.hitT1 === 1) summary.wins++;
          else if (g.hitT1 === 0) summary.losses++;
          else summary.insufficient++;
        } catch (e: any) {
          summary.errors++;
          console.error(`[odteGrader] row ${r.id} failed:`, e?.message ?? e);
        }
      }
    }
  } catch (e: any) {
    summary.errors++;
    console.error("[odteGrader] failed:", e?.message ?? e);
  }
  return summary;
}
