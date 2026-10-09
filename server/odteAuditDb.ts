/**
 * Pulse Batcave — 0DTE Alert Audit Logger (Wire 20)
 *
 * Creates odte_alert_audit table and provides persistOdteAuditOnFire().
 * Uses same sqlite instance as storage.ts. Better-sqlite3 is synchronous.
 */

import { sqlite } from "./storage";
import { randomUUID } from "node:crypto";

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS odte_alert_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT UNIQUE NOT NULL,
    detected_at INTEGER NOT NULL,
    score INTEGER NOT NULL,
    tier TEXT NOT NULL,
    setup TEXT NOT NULL,
    side TEXT NOT NULL,
    features_json TEXT NOT NULL,
    contract_json TEXT NOT NULL,
    t1_target REAL NOT NULL,
    entry_price REAL NOT NULL,
    outcome_json TEXT,
    pct_return REAL,
    hit_30 INTEGER,
    hit_50 INTEGER,
    hit_t1 INTEGER,
    graded INTEGER NOT NULL DEFAULT 0,
    graded_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_odte_audit_detected ON odte_alert_audit(detected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_odte_audit_graded ON odte_alert_audit(graded, detected_at DESC);

  -- Wire 21 (Bug Fix Night 6/3): odte_evaluation_log captures EVERY engine
  -- invocation, even when spotHistory is cold or no candidates are produced.
  -- This is the visibility layer that solves "why no alerts?" mystery —
  -- distinguishes silence-due-to-bug vs silence-due-to-no-setup.
  CREATE TABLE IF NOT EXISTS odte_evaluation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    spot REAL,
    spot_history_len INTEGER,
    candidates_seen INTEGER NOT NULL DEFAULT 0,
    fireable_count INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    bail_reason TEXT,
    reject_breakdown_json TEXT,
    near_miss_top_score INTEGER,
    near_miss_setup TEXT,
    near_miss_side TEXT,
    gex REAL,
    regime TEXT,
    pcr_oi REAL
  );
  CREATE INDEX IF NOT EXISTS idx_odte_eval_log_ts ON odte_evaluation_log(ts DESC);

  -- Option-mark ledger (review items 7.2/7.3): the live bid/ask of each FIRED
  -- alert's contract, logged by the 0DTE tracker on every chain poll until the
  -- close. The grader replays the trade plan on these real quotes. Prices are
  -- $ per share as quoted by Schwab (one contract = 100x). source is always
  -- 'schwab' here: delayed CBOE quotes are never logged as marks.
  CREATE TABLE IF NOT EXISTS odte_option_marks (
    alert_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    bid REAL,
    ask REAL,
    mid REAL,
    underlying REAL,
    source TEXT NOT NULL,
    PRIMARY KEY (alert_id, ts)
  );
`);

// Additive ledger columns on odte_alert_audit (idempotent: ALTER fails if the
// column already exists, which is fine).
//   option_status   'graded' | 'ungraded' (NULL = graded before option marks existed)
//   option_reason   exit reason or why ungraded
//   option_entry    $/share paid (the ask at fire)
//   option_exit     $/share received (bid at exit, or settlement value)
//   option_exit_at  epoch ms of the exit quote / settlement
//   option_return   realized (exit - entry) / entry, fraction of premium
//   option_mfe      best bid-based return before exit (diagnostic only)
//   realized_pct    underlying close-out return % for the first-touch plan
//                   (pct_return keeps the best favorable excursion as a diagnostic)
for (const col of [
  "option_status TEXT",
  "option_reason TEXT",
  "option_entry REAL",
  "option_exit REAL",
  "option_exit_at INTEGER",
  "option_return REAL",
  "option_mfe REAL",
  "realized_pct REAL",
]) {
  try { sqlite.exec(`ALTER TABLE odte_alert_audit ADD COLUMN ${col}`); } catch { /* column exists */ }
}

// ─── Option-mark logging (called by odteTracker on every Schwab chain poll) ──

export interface TrackerQuote {
  strike: number;
  side: "call" | "put";
  bid: number | null;
  ask: number | null;
  quoteTime: number | null;   // Schwab quoteTimeInLong when present
}

let _watch: { at: number; day: string; rows: Array<{ alertId: string; strike: number; isCall: boolean; expiry: string }> } | null = null;

function etYmd(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function watchedAlerts(now: number): Array<{ alertId: string; strike: number; isCall: boolean; expiry: string }> {
  const day = etYmd(now);
  if (_watch && _watch.day === day && now - _watch.at < 30_000) return _watch.rows;
  const rows: Array<{ alertId: string; strike: number; isCall: boolean; expiry: string }> = [];
  try {
    const recs = sqlite
      .prepare(`SELECT alert_id, side, contract_json FROM odte_alert_audit
                WHERE detected_at >= ? AND tier != 'REJECTED'`)
      .all(now - 18 * 3600_000) as Array<{ alert_id: string; side: string; contract_json: string }>;
    for (const r of recs) {
      let c: any = {};
      try { c = JSON.parse(r.contract_json || "{}"); } catch { continue; }
      const strike = Number(c.strike);
      const expiry = String(c.expiry ?? "").slice(0, 10);
      if (!(strike > 0)) continue;
      const t = String(c.optionType ?? r.side ?? "").toUpperCase();
      rows.push({ alertId: r.alert_id, strike, isCall: t.startsWith("C"), expiry });
    }
  } catch { /* table missing: nothing to watch */ }
  _watch = { at: now, day, rows };
  return rows;
}

/**
 * Log the current Schwab quote of every fired alert's contract. The alert's
 * logged expiry must equal the tracker chain's expiry; alerts without one are
 * never matched (their grade stays "no_marks_logged"). Fail-soft.
 */
export function recordOdteOptionMarks(args: {
  expiryISO: string;
  source: "schwab";
  underlying: number | null;
  quotes: TrackerQuote[];
  now?: number;
}): number {
  if (args.source !== "schwab") return 0; // only Schwab quotes are logged as marks
  const now = args.now ?? Date.now();
  let written = 0;
  try {
    const watch = watchedAlerts(now);
    if (watch.length === 0) return 0;
    const stmt = sqlite.prepare(`INSERT OR IGNORE INTO odte_option_marks (alert_id, ts, bid, ask, mid, underlying, source)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const w of watch) {
      // Expiry is required: a strike/side match on a different expiry is a different contract.
      if (!w.expiry || !args.expiryISO || w.expiry !== args.expiryISO) continue;
      const q = args.quotes.find((x) => Math.abs(x.strike - w.strike) < 1e-6 && (x.side === "call") === w.isCall);
      if (!q) continue;
      const bid = q.bid != null && Number.isFinite(q.bid) && q.bid >= 0 ? q.bid : null;
      const ask = q.ask != null && Number.isFinite(q.ask) && q.ask > 0 ? q.ask : null;
      if (bid == null && ask == null) continue;
      const ts = q.quoteTime != null && q.quoteTime > 0 && q.quoteTime <= now + 5_000 ? q.quoteTime : now;
      const mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : null;
      stmt.run(w.alertId, ts, bid, ask, mid, args.underlying, args.source);
      written++;
    }
  } catch (err: any) {
    console.warn(`[odte:audit] recordOdteOptionMarks error: ${err?.message ?? err}`);
  }
  return written;
}

/** Logged marks for one alert, oldest first. */
export function loadOdteOptionMarks(alertId: string): Array<{ ts: number; bid: number | null; ask: number | null; mid: number | null }> {
  try {
    return sqlite
      .prepare(`SELECT ts, bid, ask, mid FROM odte_option_marks WHERE alert_id = ? ORDER BY ts ASC`)
      .all(alertId) as Array<{ ts: number; bid: number | null; ask: number | null; mid: number | null }>;
  } catch { return []; }
}

// ─── Tier classifier ──────────────────────────────────────────────────────────

function _scoreTier(score: number): "STANDARD" | "BANGER" | "MOONSHOT" {
  if (score >= 95) return "MOONSHOT";
  if (score >= 85) return "BANGER";
  return "STANDARD";
}

// ─── Persist function ─────────────────────────────────────────────────────────

/**
 * Persist an 0DTE alert to audit log at the moment it PASSES all gates,
 * right before postOdteBangerAlert.
 *
 * Call site: server/discordScheduler.ts, inside the `for (const a of alerts)` loops.
 *
 * Silently swallows all errors — ML/audit never blocks alert dispatch.
 */
export function persistOdteAuditOnFire(alert: any): void {
  try {
    const now = Date.now();
    const alertId: string =
      alert?.id ??
      alert?.alertId ??
      `${alert?.setup ?? "unknown"}-${alert?.side ?? "x"}-${now}-${randomUUID().slice(0, 8)}`;

    const score: number = alert?.grade?.score ?? alert?.score ?? 0;
    const tier: string = _scoreTier(score);
    const setup: string = alert?.setup ?? "UNKNOWN";
    const side: string = alert?.side ?? "unknown";

    // Wire 15/16 audit fields — pull everything available
    const features: Record<string, unknown> = {
      // MISSION FIX — grading + conditional-edge context (spot/stop for the
      // first-touch grader; regime/time context for the regime-conditioned
      // edge database). All additive, all optional.
      spot: alert?.spot ?? null,
      stopLevel: alert?.stopLevel ?? null,
      stopPct: alert?.stopPct ?? null,
      t1Price: alert?.t1?.price ?? null,
      t1EstPct: alert?.t1?.estPctGain ?? null,
      t2Price: alert?.t2?.price ?? null,
      t2TriggerLevel: alert?.t2TriggerLevel ?? null,
      regimeText: alert?.regime ?? null,
      greekSignals: alert?.greekSignals ?? null,
      fireHourEt: Number(new Date(now).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })),
      // Grade fields
      score,
      letter: alert?.grade?.letter,
      reasoning: alert?.grade?.reasoning,
      // Wire audit fields
      trendScore: alert?.grade?.trendScore,
      momentumScore: alert?.grade?.momentumScore,
      structureScore: alert?.grade?.structureScore,
      regimeScore: alert?.grade?.regimeScore,
      wire8VwapExhaustionPenalty: alert?.grade?.wire8VwapExhaustionPenalty,
      envVetoReason: alert?.envVetoReason,
      coldBootOverride: alert?.coldBootOverride,
      spotHistory: alert?.spotHistory,
      // Level info
      levelKind: alert?.level?.kind,
      levelValue: alert?.level?.value,
      levelDistance: alert?.levelDistance,
      // Market context
      netGex: alert?.netGex,
      gammaRegime: alert?.gammaRegime,
      vix: alert?.vix,
      ivRank: alert?.ivRank,
      // Projection
      t1Pct: alert?.t1Pct,
      t2Pct: alert?.t2Pct,
      projectionT1: alert?.projectionT1,
      projectionT2: alert?.projectionT2,
      // Regime gate
      regimeVeto: alert?.regimeVeto,
      regimeWant: alert?.regimeWant,
      // Event gate
      eventDayKind: alert?.eventDayKind,
      eventGateActions: alert?.eventGateActions,
      // Flow
      flowAligned: alert?.flowAligned,
      flowScore: alert?.flowScore,
      // Any extra audit keys
      ...(alert?.auditFields ?? {}),
    };

    const contract: Record<string, unknown> = {
      strike: alert?.contract?.strike,
      expiry: alert?.contract?.expiry,
      delta: alert?.contract?.delta,
      iv: alert?.contract?.iv,
      optionType: alert?.contract?.optionType ?? side,
      bid: alert?.contract?.bid,
      ask: alert?.contract?.ask,
      midpoint: alert?.contract?.midpoint,
      oi: alert?.contract?.openInterest,
      volume: alert?.contract?.volume,
    };

    // BUG FIX (T1/T2 derivation build): engine alerts carry `t1: {name, price}`,
    // NOT `t1Target`/`projectionT1` — the old chain always fell through to 0,
    // so every fire graded "insufficient_inputs — no t1_target". Fall back to
    // the level price the engine actually selected.
    const t1Target: number =
      alert?.t1Target ?? alert?.projectionT1 ?? alert?.t1?.price ?? 0;
    const entryPrice: number =
      alert?.entryPrice ??
      alert?.contract?.midpoint ??
      alert?.contract?.ask ??
      0;

    const stmt = sqlite.prepare(`
      INSERT OR IGNORE INTO odte_alert_audit
        (alert_id, detected_at, score, tier, setup, side, features_json, contract_json, t1_target, entry_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      alertId,
      now,
      score,
      tier,
      setup,
      side,
      JSON.stringify(features),
      JSON.stringify(contract),
      t1Target,
      entryPrice,
    );
  } catch (err: any) {
    // Silent — audit never blocks
    console.warn(`[odte:audit] persistOdteAuditOnFire error: ${err?.message ?? err}`);
  }
}

/**
 * Persist a rejected 0DTE setup to audit log with the gate reason.
 *
 * Lets us debug WHY trades aren't firing in production. Without this, an empty
 * audit table is ambiguous (no setups detected vs all rejected). With it, we
 * can see exact reject distribution per setup type.
 *
 * Tier is forced to "REJECTED" so dashboards can split fires from rejects.
 */
export function persistOdteAuditOnReject(alert: any, reason: string): void {
  try {
    const now = Date.now();
    const score: number = alert?.grade?.score ?? 0;
    const setup: string = alert?.setup ?? "UNKNOWN";
    const side: string = alert?.side ?? "unknown";
    const alertId: string =
      alert?.id ?? alert?.alertId ?? `REJ-${setup}-${side}-${now}-${randomUUID().slice(0, 8)}`;

    const features: Record<string, unknown> = {
      rejectReason: reason,
      score,
      letter: alert?.grade?.letter,
      reasoning: alert?.grade?.reasoning,
      trendScore: alert?.grade?.trendScore,
      momentumScore: alert?.grade?.momentumScore,
      structureScore: alert?.grade?.structureScore,
      regimeScore: alert?.grade?.regimeScore,
      envVetoReason: alert?.envVetoReason,
      t1EstPct: alert?.t1?.estPctGain,
      t2EstPct: alert?.t2?.estPctGain,
      projReturnPctT1: alert?.projReturnPctT1,
      gateRejectReason: alert?.gateRejectReason,
      coldBootProjOverride: alert?.coldBootProjOverride,
      gexTier: alert?.gexTier,
      projTier: alert?.projTier,
    };

    const contract: Record<string, unknown> = {
      strike: alert?.contract?.strike,
      expiry: alert?.contract?.expiry,
      delta: alert?.contract?.delta,
      iv: alert?.contract?.iv,
      optionType: side,
      bid: alert?.contract?.bid,
      ask: alert?.contract?.ask,
      midpoint: alert?.contract?.midpoint,
    };

    const stmt = sqlite.prepare(`
      INSERT OR IGNORE INTO odte_alert_audit
        (alert_id, detected_at, score, tier, setup, side, features_json, contract_json, t1_target, entry_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      alertId,
      now,
      score,
      "REJECTED",
      setup,
      side,
      JSON.stringify(features),
      JSON.stringify(contract),
      0,
      alert?.contract?.midpoint ?? 0,
    );
  } catch (err: any) {
    console.warn(`[odte:audit] persistOdteAuditOnReject error: ${err?.message ?? err}`);
  }
}

// ─── Wire 21: Evaluation log persist ─────────────────────────────────────────
//
// Called from discordScheduler after every diagnoseOdte invocation, regardless
// of result. Captures engine state for postmortem visibility.

export interface EvalLogInput {
  ts: number;
  spot?: number | null;
  spotHistoryLen?: number;
  candidatesSeen?: number;
  fireableCount?: number;
  rejectedCount?: number;
  bailReason?: string | null;
  rejectBreakdown?: Record<string, number>;
  nearMiss?: { score: number; setup: string; side: string } | null;
  gex?: number | null;
  regime?: string | null;
  pcrOi?: number | null;
}

export function persistOdteEvaluationLog(input: EvalLogInput): void {
  try {
    const stmt = sqlite.prepare(`
      INSERT INTO odte_evaluation_log
        (ts, spot, spot_history_len, candidates_seen, fireable_count, rejected_count,
         bail_reason, reject_breakdown_json, near_miss_top_score, near_miss_setup,
         near_miss_side, gex, regime, pcr_oi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      input.ts,
      input.spot ?? null,
      input.spotHistoryLen ?? null,
      input.candidatesSeen ?? 0,
      input.fireableCount ?? 0,
      input.rejectedCount ?? 0,
      input.bailReason ?? null,
      input.rejectBreakdown ? JSON.stringify(input.rejectBreakdown) : null,
      input.nearMiss?.score ?? null,
      input.nearMiss?.setup ?? null,
      input.nearMiss?.side ?? null,
      input.gex ?? null,
      input.regime ?? null,
      input.pcrOi ?? null,
    );
  } catch (err: any) {
    console.warn(`[odte:audit] persistOdteEvaluationLog error: ${err?.message ?? err}`);
  }
}

/** Trim eval log to last 30 days to keep DB lean. Called once at startup. */
export function trimOdteEvaluationLog(): void {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    sqlite.prepare(`DELETE FROM odte_evaluation_log WHERE ts < ?`).run(cutoff);
  } catch {}
}

trimOdteEvaluationLog();
