import type Database from "better-sqlite3";

export function cryptoAuditStats(db: Database.Database) {
  const rows = db.prepare("SELECT outcome, COUNT(*) AS n FROM crypto_signals GROUP BY outcome")
    .all() as Array<{ outcome: string; n: number }>;
  const count = (outcome: string) => rows.find(r => r.outcome === outcome)?.n ?? 0;
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const graded = ["HIT_5M", "DOUBLED", "RUGGED", "DEAD"].reduce((sum, outcome) => sum + count(outcome), 0);
  return {
    total, open: count("OPEN"), hit5m: count("HIT_5M"), doubled: count("DOUBLED"),
    rugged: count("RUGGED"), dead: count("DEAD"), graded,
    sampleThresholdMet: graded >= 50,
    // A sample count is not a calibration/validation procedure.
    calibrated: false,
  };
}
