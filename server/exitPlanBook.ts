// server/exitPlanBook.ts
//
// The rule-book exit plan (shared/exitPlan.ts), walked on every ENTER signal's
// sampled path. One row per ENTER signal: the plan state as JSON, advanced at
// each price sample the desk already takes (momentum refresh, grader pass),
// so no extra API call. Signals logged before this existed get a plan from
// their first sample after it, with that limitation on the record (entry is
// still the signal's own cap and liquidity; earlier samples are not replayed).

import { sqlite } from "./storage";
import { EXIT_PLAN_TABLE_SQL, EXIT_PLAN_UPSERT_SQL } from "./exitPlanSql";
import { CRYPTO_RULES_VERSION } from "../shared/cryptoRules";
import { advancePlan, newPlanState, planSummary, type PlanState, type PlanSummary } from "../shared/exitPlan";

let ready = false;
// Plans start only on a sample within this long of the signal: an older
// signal's path before now was not walked, so it is not graded at all.
const START_WITHIN_MS = 15 * 60_000;
function ensure(): void {
  if (ready) return;
  // A first build declared signal_id INTEGER; every write failed, so the table is empty. Recreate it.
  const col = (sqlite.prepare(`SELECT type FROM pragma_table_info('crypto_exit_plans') WHERE name = 'signal_id'`).get() as any)?.type;
  if (col && String(col).toUpperCase() !== "TEXT") sqlite.exec(`DROP TABLE crypto_exit_plans`);
  sqlite.exec(EXIT_PLAN_TABLE_SQL);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS crypto_exit_plans_open ON crypto_exit_plans (closed)`);
  ready = true;
}

/** Advance every open plan on this pair with one sample (creates plans for new ENTER rows). */
export function samplePlans(chain: string, pair: string, mcap: number | null, liq: number | null, at: number): void {
  try {
    ensure();
    const rows = sqlite.prepare(`
      SELECT s.id, s.token_address, s.mcap_at_signal, s.liquidity_at_signal, s.detected_at,
             COALESCE(json_extract(s.features_json, '$.rulesVersion'), 'unversioned') AS rules_version,
             p.state_json, p.closed
      FROM crypto_signals s LEFT JOIN crypto_exit_plans p ON p.signal_id = s.id
      WHERE s.verdict = 'ENTER' AND s.chain = ? AND s.pair_address = ? AND COALESCE(p.closed, 0) = 0
        AND s.detected_at > ?
    `).all(chain, pair, at - 7 * 24 * 3600_000) as any[];
    if (!rows.length) return;
    const up = sqlite.prepare(EXIT_PLAN_UPSERT_SQL);
    for (const r of rows) {
      if (!r.state_json && at - Number(r.detected_at) > START_WITHIN_MS) continue;
      const st: PlanState | null = r.state_json ? JSON.parse(r.state_json) : newPlanState(Number(r.mcap_at_signal), Number(r.liquidity_at_signal), Number(r.detected_at), String(r.rules_version));
      if (!st) continue;
      const next = advancePlan(st, { at, mcap, liquidity: liq });
      if (next === st && r.state_json) continue;
      up.run({ id: r.id, tok: r.token_address ?? null, json: JSON.stringify(next), closed: next.closedAt != null ? 1 : 0, now: Date.now() });
    }
  } catch (e: any) {
    console.warn(`[crypto:plan] ${e?.message ?? e}`);
  }
}

/** The plan record over the first ENTER per coin (same identity as the expectancy sample). */
export function exitPlanRecord(): PlanSummary & { currentVersion: string; basis: string } {
  ensure();
  const rows = sqlite.prepare(`
    WITH firsts AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(token_address, ''), pair_address) ORDER BY detected_at ASC, id ASC) AS rn
      FROM crypto_signals WHERE verdict = 'ENTER'
    )
    SELECT p.state_json FROM firsts f JOIN crypto_exit_plans p ON p.signal_id = f.id WHERE f.rn = 1
  `).all() as any[];
  // Current rule version only: a plan graded under other levels is a different rule.
  const states = rows.map((r) => JSON.parse(r.state_json) as PlanState).filter((s) => s.rulesVersion === CRYPTO_RULES_VERSION);
  return {
    ...planSummary(states, Date.now()), currentVersion: CRYPTO_RULES_VERSION,
    basis: "first ENTER per coin; the rule-book plan walked on the desk's own price samples: trims and the target fill at their level when a sample reaches it, stops at the sample that breached them, the time stop at the first sample past the hold horizon; net of pool fees, priority fees and constant-product impact on every leg, per $100. Spikes between samples are missed. Plans start only on a sample within 15 min of the signal; a plan still open a day past its time stop counts as no data, and over a 20% no-data share the record reads INSUFFICIENT DATA. Bookkeeping, not a forecast.",
  };
}
