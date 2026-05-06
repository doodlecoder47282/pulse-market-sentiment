// DB backup cron. Snapshots data.db nightly, keeps last 7.
// Pure file-system; never throws to caller.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = "./data.db";
const BACKUP_DIR = "./backups";
const KEEP = 7;

let started = false;

export function startDbBackup() {
  if (started) return;
  started = true;
  // Run once 5 min after boot, then every 24h.
  setTimeout(() => void runBackup(), 5 * 60 * 1000);
  setInterval(() => void runBackup(), 24 * 60 * 60 * 1000);
  console.log("[dbBackup] started — daily snapshots, retention 7");
}

export function runBackup(): { ok: boolean; path?: string; error?: string } {
  try {
    if (!existsSync(DB_PATH)) {
      return { ok: false, error: "db_not_found" };
    }
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(BACKUP_DIR, `data.${ts}.db`);
    copyFileSync(DB_PATH, dest);
    pruneOldBackups();
    const sizeMb = (statSync(dest).size / 1024 / 1024).toFixed(2);
    console.log(`[dbBackup] snapshot saved: ${dest} (${sizeMb}MB)`);
    return { ok: true, path: dest };
  } catch (e: any) {
    console.error("[dbBackup] failed:", e?.message ?? e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function pruneOldBackups() {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("data.") && f.endsWith(".db"))
      .map((f) => ({ name: f, path: join(BACKUP_DIR, f), mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(KEEP)) {
      unlinkSync(f.path);
    }
  } catch (e: any) {
    console.warn("[dbBackup] prune failed:", e?.message ?? e);
  }
}

export function listBackups(): { name: string; sizeMb: number; capturedAt: number }[] {
  try {
    if (!existsSync(BACKUP_DIR)) return [];
    return readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("data.") && f.endsWith(".db"))
      .map((f) => {
        const s = statSync(join(BACKUP_DIR, f));
        return { name: f, sizeMb: +(s.size / 1024 / 1024).toFixed(2), capturedAt: s.mtimeMs };
      })
      .sort((a, b) => b.capturedAt - a.capturedAt);
  } catch {
    return [];
  }
}
