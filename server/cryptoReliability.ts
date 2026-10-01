import type Database from "better-sqlite3";

export const CRYPTO_RELIABILITY_VERSION = "2026-10-01.1";
export const OUTCOME_WINDOW_MS = 72 * 3600_000;
export const OBSERVATION_FRESH_MS = 10 * 60_000;

export function finiteNonnegative(value: unknown): number | null {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function ensureCryptoGradeSchema(db: Database.Database) {
  const columns = new Set((db.prepare("PRAGMA table_info(crypto_signals)").all() as Array<{name:string}>).map(r=>r.name));
  for (const [name, type] of Object.entries({
    last_checked_at:"INTEGER", last_observed_at:"INTEGER",
    grade_attempts:"INTEGER NOT NULL DEFAULT 0", observed_samples:"INTEGER NOT NULL DEFAULT 0",
    grade_error:"TEXT",
    grade_retry_at:"INTEGER", grade_failures:"INTEGER NOT NULL DEFAULT 0",
    first_observed_at:"INTEGER", max_observation_gap_ms:"INTEGER",
    last_sample_at:"INTEGER", last_observation_source:"TEXT", last_observation_json:"TEXT",
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE crypto_signals ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_crypto_grade_due ON crypto_signals(outcome, last_checked_at, detected_at)");
}

export interface CryptoObservation { mcap: number | null; liq: number | null; observedAt: number; source?: string }

// One bounded fair batch. Failed attempts advance in the queue too.
// A fetch timestamp means a sampled provider observation, not an exchange timestamp.
export async function gradeCryptoBatch(
  db: Database.Database,
  observe: (row: any) => Promise<CryptoObservation>,
  clock = () => Date.now(),
) {
  const rows = db.prepare(`SELECT * FROM crypto_signals WHERE outcome='OPEN'
    AND (COALESCE(grade_retry_at,0)<=? OR detected_at+${OUTCOME_WINDOW_MS}<?)
    ORDER BY COALESCE(last_checked_at,0), detected_at, id LIMIT 60`).all(clock(), clock()) as any[];
  const deferred = (db.prepare(`SELECT COUNT(*) n FROM crypto_signals WHERE outcome='OPEN'
    AND grade_retry_at>? AND detected_at+${OUTCOME_WINDOW_MS}>=?`).get(clock(), clock()) as {n:number}).n;
  const result = { selected: rows.length, observed: 0, partial: 0, unavailable: 0, closed: 0, unobservable: 0, deferred, duplicate: 0 };
  const attempt = db.prepare("UPDATE crypto_signals SET last_checked_at=?, grade_attempts=grade_attempts+1, grade_error=? WHERE id=?");
  const close = db.prepare("UPDATE crypto_signals SET outcome=?, graded_at=?, grade_error=? WHERE id=?");
  let cursor=0;
  async function worker() {
    while (cursor<rows.length) {
      const row=rows[cursor++];
      const now=clock();
      attempt.run(now,null,row.id);
      const deadline=Number(row.detected_at)+OUTCOME_WINDOW_MS;
      // Never apply today's price retroactively to an expired observation window.
      if (now>deadline) {
        const covered=row.first_observed_at!=null && row.max_observation_gap_ms!=null &&
          Number(row.first_observed_at)>=Number(row.detected_at) &&
          Number(row.first_observed_at)-Number(row.detected_at)<=OBSERVATION_FRESH_MS*2 &&
          Number(row.max_observation_gap_ms)<=OBSERVATION_FRESH_MS*2 &&
          Number(row.last_observed_at)>=deadline-OBSERVATION_FRESH_MS*2 &&
          Number(row.last_observed_at)<=deadline && Number(row.observed_samples)>0;
        const entry=finiteNonnegative(row.mcap_at_signal);
        const outcome=covered && entry!=null && entry>0
          ? Number(row.peak_mcap)>=entry*2 ? "DOUBLED" : "DEAD"
          : "UNOBSERVABLE";
        close.run(outcome,now,outcome==="UNOBSERVABLE" ? "72h window lacks documented sampled coverage (start, gaps or closing); not a win/loss." : null,row.id);
        result.closed++;
        if (outcome==="UNOBSERVABLE") result.unobservable++;
        continue;
      }
      try {
        const obs=await observe(row);
        const mcap=finiteNonnegative(obs.mcap), liq=finiteNonnegative(obs.liq);
        if (!Number.isFinite(obs.observedAt) || obs.observedAt>clock() || obs.observedAt>deadline || clock()-obs.observedAt>OBSERVATION_FRESH_MS ||
            obs.observedAt<Number(row.detected_at) || (mcap==null && liq==null)) throw Error("No fresh usable observation");
        if (row.last_sample_at != null && obs.observedAt <= row.last_sample_at) { result.duplicate++; continue; }
        const previous=finiteNonnegative(row.peak_mcap);
        const peak=mcap==null ? previous : Math.max(previous??0,mcap);
        const entry=finiteNonnegative(row.mcap_at_signal);
        const entryLiq=finiteNonnegative(row.liquidity_at_signal);
        let outcome="OPEN";
        if (mcap!=null && mcap>=5_000_000) outcome="HIT_5M";
        else if ((entryLiq!=null && entryLiq>0 && liq!=null && liq<entryLiq*.15) ||
                 (entry!=null && entry>0 && mcap!=null && mcap<entry*.1)) outcome="RUGGED";
        // Only a complete cap+liquidity observation qualifies as closing coverage.
        const complete = mcap!=null && liq!=null;
        const gap = obs.observedAt - Number(row.last_observed_at ?? row.detected_at);
        db.prepare(`UPDATE crypto_signals SET peak_mcap=?, peak_at=?, last_mcap=?, last_liquidity=?,
          last_observed_at=CASE WHEN ? THEN ? ELSE last_observed_at END,
          first_observed_at=CASE WHEN ? THEN COALESCE(first_observed_at,?) ELSE first_observed_at END,
          max_observation_gap_ms=CASE WHEN ? THEN MAX(COALESCE(max_observation_gap_ms,0),?) ELSE max_observation_gap_ms END,
          last_sample_at=?,last_observation_source=?,last_observation_json=?,
          grade_retry_at=NULL,grade_failures=0,
          observed_samples=observed_samples+1,outcome=?,graded_at=?,grade_error=? WHERE id=?`)
          .run(peak,mcap!=null && (previous==null || mcap>previous) ? obs.observedAt : row.peak_at,
            mcap,liq,complete?1:0,obs.observedAt,complete?1:0,obs.observedAt,complete?1:0,gap,
            obs.observedAt,obs.source??"Unspecified test/legacy observation",
            JSON.stringify({mcap,liq,observedAt:obs.observedAt,source:obs.source??null,timeBasis:"provider receipt/sample, not exchange time"}),
            outcome,outcome==="OPEN"?null:now,
            mcap==null || liq==null ? "Partial observation: cap or liquidity unavailable" : null,row.id);
        result.observed++;
        if (!complete) result.partial++;
        if (outcome!=="OPEN") result.closed++;
      } catch (e:any) {
        const retryAt = Math.min(deadline, clock() + Math.min(3600_000, 600_000 * 2 ** Math.min(Number(row.grade_failures ?? 0), 3)));
        db.prepare("UPDATE crypto_signals SET grade_error=?,grade_retry_at=?,grade_failures=grade_failures+1 WHERE id=?")
          .run(String(e?.message??"Observation unavailable").slice(0,200),retryAt,row.id);
        result.unavailable++;
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,rows.length)},worker));
  return result;
}
