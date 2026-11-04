// SQL for server/exitPlanBook.ts, import-free so tests can run it on node:sqlite.
// crypto_signals.id is TEXT ("chain:pair:ts"), so signal_id is TEXT.
export const EXIT_PLAN_TABLE_SQL = `CREATE TABLE IF NOT EXISTS crypto_exit_plans (
    signal_id TEXT PRIMARY KEY,
    token_address TEXT,
    state_json TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
export const EXIT_PLAN_UPSERT_SQL = `INSERT INTO crypto_exit_plans (signal_id, token_address, state_json, closed, created_at, updated_at)
      VALUES (@id, @tok, @json, @closed, @now, @now)
      ON CONFLICT(signal_id) DO UPDATE SET state_json = @json, closed = @closed, updated_at = @now`;
