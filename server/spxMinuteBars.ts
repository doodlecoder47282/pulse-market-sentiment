// server/spxMinuteBars.ts
//
// ONE schema for the persisted Schwab $SPX 1-minute bars (spx_minute_bars).
//
// Two modules used to create this table with different columns:
//   mlDataLog:    t, open, high, low, close, volume, source   (canonical)
//   hazardEngine: ts, date, mod, o, h, l, c, v                (legacy)
// whichever ran first owned the schema and the other one's inserts failed.
// The canonical layout is mlDataLog's (it already names its source and keeps
// every bar Schwab returns); the ET date and minute-of-session are derived on
// read (etDayMod) instead of stored. ensureSpxMinuteBarsTable() creates the
// canonical table, or migrates a legacy table in place inside one
// transaction (rows copied with source 'schwab': hazardEngine only ever
// stored Schwab $SPX candles), and is idempotent. It takes the database
// handle as an argument so it is testable on node:sqlite.

export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

export const SPX_MINUTE_BARS_DDL = `
  CREATE TABLE IF NOT EXISTS spx_minute_bars (
    t INTEGER PRIMARY KEY,          -- bar open, epoch ms
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL,
    source TEXT NOT NULL
  );`;

/** Create the canonical table, or migrate the legacy hazardEngine layout. Returns what it did. */
export function ensureSpxMinuteBarsTable(db: SqlDb): "created_or_present" | "migrated_legacy" {
  const cols = (db.prepare("PRAGMA table_info(spx_minute_bars)").all() as Array<{ name: string }>).map((c) => c.name);
  const legacy = cols.includes("ts") && cols.includes("o") && !cols.includes("t");
  if (!legacy) {
    db.exec(SPX_MINUTE_BARS_DDL);
    return "created_or_present";
  }
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE spx_minute_bars RENAME TO spx_minute_bars_legacy_hazard");
    db.exec("DROP INDEX IF EXISTS idx_spx_minute_date");
    db.exec(SPX_MINUTE_BARS_DDL);
    db.exec(`INSERT OR IGNORE INTO spx_minute_bars (t, open, high, low, close, volume, source)
             SELECT ts, o, h, l, c, v, 'schwab' FROM spx_minute_bars_legacy_hazard`);
    db.exec("DROP TABLE spx_minute_bars_legacy_hazard");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return "migrated_legacy";
}

const ET_DAY_MOD = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** ET calendar date and minutes since 09:30 ET of a bar-open instant (what the legacy table stored). */
export function etDayMod(ms: number): { date: string; mod: number } {
  const parts = ET_DAY_MOD.formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, mod: (Number(g("hour")) % 24 - 9) * 60 + Number(g("minute")) - 30 };
}
