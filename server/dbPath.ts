// server/dbPath.ts
//
// Paths for runtime files that are NOT tracked in git (finding 11.7):
// data/greek_gradient.db (+ -wal, -shm) and .discord-scheduler-state.json.
// A fresh clone or a container without them must create them on first use,
// so callers resolve the path here and the parent directory is created
// before SQLite or writeFileSync opens the file (better-sqlite3 throws
// "directory does not exist" otherwise; SQLite creates the file itself).

import { existsSync, mkdirSync } from "node:fs";
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
