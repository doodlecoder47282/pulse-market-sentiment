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
`);

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

    const t1Target: number = alert?.t1Target ?? alert?.projectionT1 ?? 0;
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
