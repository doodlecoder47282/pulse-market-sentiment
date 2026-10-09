// server/schwabTokenStore.ts
//
// The only code that reads or writes the schwab_tokens row (id = 1). Thin
// DB adapter over the tested rules in tokenCrypto.ts: AES-256-GCM at rest
// with BATCAVE_TOKEN_KEY, transparent migration of a legacy plaintext row on
// first read, fail closed on a reachable bind without a key.
//
// Migration hygiene: the plaintext row is overwritten with secure_delete on
// (SQLite zeroes the freed content) and the WAL is checkpointed and truncated
// so the old plaintext page does not linger in data.db-wal. Backups taken
// before the migration (backups/) still hold plaintext tokens; the deploy doc
// says to reconnect Schwab (new tokens) and prune old backups after enabling.
// SQLite PRAGMA secure_delete / wal_checkpoint:
//   https://www.sqlite.org/pragma.html#pragma_secure_delete
//   https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
//
// Never logs token values.

import { eq } from "drizzle-orm";
import { db, sqlite, schwabTokens } from "./storage";
import {
  decodeStoredRow,
  encodeRowForStorage,
  tokenKeyPolicy,
  type TokenRow,
  type TokenStoreMode,
} from "./tokenCrypto";

const ROW_ID = 1;

export type TokenRead =
  | { status: "ok"; row: TokenRow }
  | { status: "none" }
  | { status: "locked"; reason: string }
  | { status: "decrypt_failed"; reason: string };

let _lastProblem: string | null = null;
let _migrated = false;

function writeRaw(row: TokenRow): void {
  const existing = db.select({ id: schwabTokens.id }).from(schwabTokens).where(eq(schwabTokens.id, ROW_ID)).get();
  const values = {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    updatedAt: row.updatedAt,
  };
  if (existing) db.update(schwabTokens).set(values).where(eq(schwabTokens.id, ROW_ID)).run();
  else db.insert(schwabTokens).values({ id: ROW_ID, ...values }).run();
}

function migrateInPlace(encrypted: TokenRow): void {
  try {
    sqlite.pragma("secure_delete = ON");
    writeRaw(encrypted);
  } finally {
    sqlite.pragma("secure_delete = OFF");
  }
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch { /* a busy reader can block the truncate; the next checkpoint clears it */ }
  _migrated = true;
  console.log("[schwab-tokens] stored tokens re-encrypted at rest (AES-256-GCM)");
}

/** Reads and decrypts the token row; migrates a plaintext or old-key row. */
export function readSchwabTokens(env: Record<string, string | undefined> = process.env): TokenRead {
  const policy = tokenKeyPolicy(env);
  const raw = db.select().from(schwabTokens).where(eq(schwabTokens.id, ROW_ID)).get() as TokenRow | undefined;
  if (!raw) {
    if (policy.mode === "locked") {
      _lastProblem = policy.reason;
      return { status: "locked", reason: policy.reason ?? "token storage locked" };
    }
    _lastProblem = null;
    return { status: "none" };
  }
  const r = decodeStoredRow(raw, policy);
  if (r.status !== "ok") {
    _lastProblem = r.reason;
    return r;
  }
  _lastProblem = null;
  if (r.rewrite) {
    try {
      migrateInPlace(r.rewrite);
    } catch (e: any) {
      console.warn("[schwab-tokens] re-encryption failed (tokens still usable this read):", e?.message ?? "unknown");
    }
  }
  return { status: "ok", row: r.row };
}

/** Encrypts (per policy) and upserts the token row. */
export function writeSchwabTokens(
  row: Omit<TokenRow, "id">,
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; reason: string } {
  const policy = tokenKeyPolicy(env);
  if (policy.mode === "locked") {
    _lastProblem = policy.reason;
    return { ok: false, reason: policy.reason ?? "token storage locked" };
  }
  writeRaw(encodeRowForStorage({ id: ROW_ID, ...row }, policy));
  return { ok: true };
}

export function deleteSchwabTokens(): void {
  try {
    sqlite.pragma("secure_delete = ON");
    db.delete(schwabTokens).where(eq(schwabTokens.id, ROW_ID)).run();
  } finally {
    sqlite.pragma("secure_delete = OFF");
  }
}

export interface TokenStoreStatus {
  mode: TokenStoreMode;
  encryptedAtRest: boolean;
  /** Why tokens are not usable or not encrypted; null when all is well. */
  reason: string | null;
  migratedThisProcess: boolean;
}

export function tokenStoreStatus(env: Record<string, string | undefined> = process.env): TokenStoreStatus {
  const p = tokenKeyPolicy(env);
  return {
    mode: p.mode,
    encryptedAtRest: p.mode === "encrypted",
    reason: _lastProblem ?? p.reason,
    migratedThisProcess: _migrated,
  };
}
