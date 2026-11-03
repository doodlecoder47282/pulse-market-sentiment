// server/dbPath.ts
//
// Paths for runtime files that are NOT tracked in git (finding 11.7):
// data/greek_gradient.db (+ -wal, -shm) and .discord-scheduler-state.json.
// A fresh clone or a container without them must create them on first use,
// so callers resolve the path here and the parent directory is created
// before SQLite or writeFileSync opens the file (better-sqlite3 throws
// "directory does not exist" otherwise; SQLite creates the file itself).

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Creates the parent directory of `filePath` if missing; returns filePath. */
export function ensureParentDir(filePath: string): string {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return filePath;
}

/** Absolute path under <cwd>/data, parent directory created. */
export function dataFilePath(name: string, cwd: string = process.cwd()): string {
  return ensureParentDir(path.join(cwd, "data", name));
}

/**
 * Discord scheduler dedup state. It was a hard-coded absolute path from the
 * original sandbox (/home/user/workspace/sentiment-app/...), which on any
 * other machine wrote outside the app. Now <cwd>/.discord-scheduler-state.json
 * unless BATCAVE_SCHEDULER_STATE_PATH is set.
 */
export function schedulerStatePath(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const override = (env.BATCAVE_SCHEDULER_STATE_PATH ?? "").trim();
  return override ? path.resolve(cwd, override) : path.join(cwd, ".discord-scheduler-state.json");
}

/**
 * The main SQLite database (Schwab tokens, alerts, graded records).
 *
 * Railway mounts the persistent volume at RAILWAY_VOLUME_MOUNT_PATH (the
 * deploy guide uses /app/data). The database used to open as <cwd>/data.db,
 * i.e. /app/data.db, OUTSIDE the volume, so every redeploy started empty and
 * the Schwab login had to be redone. Order:
 *   1. BATCAVE_DB_PATH, if set.
 *   2. <RAILWAY_VOLUME_MOUNT_PATH>/data.db when a volume is attached; a
 *      <cwd>/data.db left by an older build is copied there once.
 *   3. <cwd>/data.db (local runs, unchanged).
 */
export function resolveMainDbPath(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const override = (env.BATCAVE_DB_PATH ?? "").trim();
  if (override) return ensureParentDir(path.resolve(cwd, override));
  const vol = (env.RAILWAY_VOLUME_MOUNT_PATH ?? "").trim();
  if (vol) {
    const target = ensureParentDir(path.join(path.resolve(cwd, vol), "data.db"));
    const legacy = path.join(cwd, "data.db");
    if (!existsSync(target) && existsSync(legacy) && path.resolve(legacy) !== path.resolve(target)) {
      copyFileSync(legacy, target);
      for (const ext of ["-wal", "-shm"]) if (existsSync(legacy + ext)) copyFileSync(legacy + ext, target + ext);
      console.log(`[db] moved data.db onto the volume: ${target}`);
    }
    return target;
  }
  return path.join(cwd, "data.db");
}

let _mainDb: string | null = null;
/** Resolved once per process; every module opens the same file. */
export function mainDbPath(): string {
  if (!_mainDb) _mainDb = resolveMainDbPath();
  return _mainDb;
}

/** Backups sit next to the database (on the volume when there is one). */
export function backupDirPath(): string {
  return path.join(path.dirname(mainDbPath()), "backups");
}
