// Where runtime SQLite files live.
// Default (unset): current working directory, exactly as before.
// Hosted (Railway etc.): set BATCAVE_DATA_DIR to a mounted volume, e.g. /app/persist,
// so Schwab tokens, graded history and backups survive redeploys.
// Do not point it at the repo's data/ folder: a volume mounted there hides the
// tracked seed files (analogs, sessions).
import path from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const DATA_DIR = (process.env.BATCAVE_DATA_DIR || "").trim();
if (DATA_DIR) mkdirSync(DATA_DIR, { recursive: true });

export const MAIN_DB_PATH = DATA_DIR ? path.join(DATA_DIR, "data.db") : "data.db";
export const BACKUP_DIR = DATA_DIR ? path.join(DATA_DIR, "backups") : "./backups";

const REPO_GREEK_DB = path.join(process.cwd(), "data", "greek_gradient.db");
export const GREEK_DB_PATH = DATA_DIR ? path.join(DATA_DIR, "greek_gradient.db") : REPO_GREEK_DB;

// First boot on a fresh volume: seed the greek-gradient history from the repo copy.
if (DATA_DIR && !existsSync(GREEK_DB_PATH) && existsSync(REPO_GREEK_DB)) {
  try {
    copyFileSync(REPO_GREEK_DB, GREEK_DB_PATH);
  } catch (e: any) {
    console.warn("[dbPath] greek_gradient seed copy failed:", e?.message ?? e);
  }
}
