// server/tokenCrypto.ts
//
// At-rest encryption for the Schwab OAuth tokens (finding 11.5). Pure: only
// node:crypto, no DB, so every rule below is unit-tested
// (tests/quant/infra-ui-r2.test.ts). The DB adapter is schwabTokenStore.ts.
//
// Method
//   AES-256-GCM (authenticated encryption), 32-byte key from env
//   BATCAVE_TOKEN_KEY (standard or URL-safe base64), a fresh random 96-bit IV
//   for every encryption, 128-bit tag. GCM must never reuse an IV under one
//   key; random 96-bit IVs are the construction NIST SP 800-38D sec. 8.2.2
//   allows, and this table sees a few writes per hour, far below the 2^32
//   invocation limit. The associated data binds each ciphertext to its table,
//   row and column, so swapping the access and refresh ciphertexts (or moving
//   a row) fails authentication instead of decrypting.
//   Sources:
//   - NIST SP 800-38D, "Recommendation for Block Cipher Modes of Operation:
//     Galois/Counter Mode (GCM) and GMAC",
//     https://csrc.nist.gov/pubs/sp/800/38/d/final
//   - Node.js crypto docs, createCipheriv / getAuthTag / setAAD,
//     https://nodejs.org/api/crypto.html
//   - OWASP Cryptographic Storage Cheat Sheet (authenticated modes, keys
//     outside the data store),
//     https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
//
// Stored format: "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>". Anything
// without the prefix is a legacy plaintext token and is migrated on first
// read when a key is configured.
//
// Policy (tokenKeyPolicy)
//   key valid                         -> "encrypted"
//   key set but not 32 bytes base64   -> "locked" (a typo never silently
//                                        downgrades to plaintext)
//   key unset, loopback bind (local)  -> "plaintext-local" (previous behaviour,
//                                        boot warning)
//   key unset, reachable bind         -> "locked": tokens are neither read nor
//                                        written; Schwab shows not connected
//                                        with the reason
// Rotation: BATCAVE_TOKEN_KEY_PREVIOUS (optional) is tried for decryption
// only; a row read with it is re-encrypted under the current key.
//
// Nothing here logs or returns token values in errors.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isLoopbackHost, resolveBindHost, type EnvLike } from "./accessGate";

export const TOKEN_KEY_ENV = "BATCAVE_TOKEN_KEY";
export const TOKEN_KEY_PREVIOUS_ENV = "BATCAVE_TOKEN_KEY_PREVIOUS";
export const ENC_PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type KeyParse =
  | { ok: true; key: Buffer }
  | { ok: false; reason: "missing" | "invalid_base64" | "wrong_length"; bytes?: number };

/** Strict base64 / base64url decode of a 32-byte key. Never echoes the value. */
export function parseTokenKey(raw: string | undefined | null): KeyParse {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "missing" };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return { ok: false, reason: "invalid_base64" };
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const key = Buffer.from(norm, "base64");
  // Buffer.from ignores trailing garbage bits; re-encode to confirm a clean decode.
  if (key.toString("base64").replace(/=+$/, "") !== norm.replace(/=+$/, "")) return { ok: false, reason: "invalid_base64" };
  if (key.length !== KEY_BYTES) return { ok: false, reason: "wrong_length", bytes: key.length };
  return { ok: true, key };
}

export type TokenStoreMode = "encrypted" | "plaintext-local" | "locked";

export interface TokenKeyPolicy {
  mode: TokenStoreMode;
  /** Current key (encrypted mode only). */
  key?: Buffer;
  /** Decrypt-only keys tried after the current one (rotation). */
  previousKeys: Buffer[];
  /** Plain-language reason for plaintext-local / locked; null when encrypted. */
  reason: string | null;
}

function keyProblem(p: Exclude<KeyParse, { ok: true }>): string {
  if (p.reason === "wrong_length") return `${TOKEN_KEY_ENV} decodes to ${p.bytes} bytes; it must be exactly 32 bytes (openssl rand -base64 32)`;
  return `${TOKEN_KEY_ENV} is not valid base64 (openssl rand -base64 32)`;
}

export function tokenKeyPolicy(env: EnvLike): TokenKeyPolicy {
  const cur = parseTokenKey(env[TOKEN_KEY_ENV]);
  const prev = parseTokenKey(env[TOKEN_KEY_PREVIOUS_ENV]);
  const previousKeys = prev.ok ? [prev.key] : [];
  if (cur.ok) return { mode: "encrypted", key: cur.key, previousKeys, reason: null };
  if (cur.reason !== "missing") return { mode: "locked", previousKeys, reason: keyProblem(cur) };
  const host = resolveBindHost(env);
  if (isLoopbackHost(host)) {
    return {
      mode: "plaintext-local",
      previousKeys,
      reason: `${TOKEN_KEY_ENV} not set: Schwab tokens are stored unencrypted (loopback ${host} only)`,
    };
  }
  return {
    mode: "locked",
    previousKeys,
    reason: `${TOKEN_KEY_ENV} not set and bind host ${host} is reachable: Schwab token storage is locked until the key is set`,
  };
}

/** Boot-time warnings. Never includes key material. */
export function tokenKeyWarnings(env: EnvLike): string[] {
  const p = tokenKeyPolicy(env);
  const out: string[] = [];
  if (p.reason) out.push(p.reason);
  const prevRaw = (env[TOKEN_KEY_PREVIOUS_ENV] ?? "").trim();
  if (prevRaw && !parseTokenKey(prevRaw).ok) out.push(`${TOKEN_KEY_PREVIOUS_ENV} is set but is not a 32-byte base64 key; it is ignored`);
  return out;
}

export function isEncryptedValue(v: string): boolean {
  return typeof v === "string" && v.startsWith(ENC_PREFIX);
}

export function tokenAad(rowId: number, column: string): Buffer {
  return Buffer.from(`batcave:schwab_tokens:${rowId}:${column}`, "utf8");
}

/**
 * AES-256-GCM seal with explicit IV (the primitive under encryptValue).
 * Known-answer tested against McGrew & Viega, "The Galois/Counter Mode of
 * Operation (GCM)", Test Case 16 (256-bit key, 96-bit IV, AAD);
 * IACR ePrint 2004/193, https://eprint.iacr.org/2004/193
 */
export function gcmSeal(plain: Buffer, key: Buffer, aad: Buffer, iv: Buffer): { ct: Buffer; tag: Buffer } {
  if (key.length !== KEY_BYTES) throw new Error("token key must be 32 bytes");
  if (iv.length !== IV_BYTES) throw new Error("GCM IV must be 12 bytes");
  const c = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { ct, tag: c.getAuthTag() };
}

export function encryptValue(plain: string, key: Buffer, aad: Buffer, iv: Buffer = randomBytes(IV_BYTES)): string {
  const { ct, tag } = gcmSeal(Buffer.from(plain, "utf8"), key, aad, iv);
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Throws "token_decrypt_failed" on a wrong key, tampering or a malformed value. */
export function decryptValue(stored: string, key: Buffer, aad: Buffer): string {
  if (!isEncryptedValue(stored)) throw new Error("token_not_encrypted");
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("token_decrypt_failed");
  const [ivB, tagB, ctB] = parts.map((p) => Buffer.from(p, "base64"));
  if (ivB.length !== IV_BYTES || tagB.length !== TAG_BYTES) throw new Error("token_decrypt_failed");
  try {
    const d = createDecipheriv(ALGO, key, ivB, { authTagLength: TAG_BYTES });
    d.setAAD(aad);
    d.setAuthTag(tagB);
    return Buffer.concat([d.update(ctB), d.final()]).toString("utf8");
  } catch {
    throw new Error("token_decrypt_failed");
  }
}

// ── Row-level rules (the DB adapter only moves these rows in and out) ──────

export interface TokenRow {
  id: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  updatedAt: number;
}

export type DecodeResult =
  | { status: "ok"; row: TokenRow; rewrite: TokenRow | null }
  | { status: "locked"; reason: string }
  | { status: "decrypt_failed"; reason: string };

function decryptWithAny(stored: string, keys: Buffer[], aad: Buffer): { value: string; keyIndex: number } | null {
  for (let i = 0; i < keys.length; i++) {
    try {
      return { value: decryptValue(stored, keys[i], aad), keyIndex: i };
    } catch { /* try next key */ }
  }
  return null;
}

/**
 * Turns a stored row into usable tokens under the policy.
 * `rewrite` is non-null when the row must be written back encrypted under the
 * current key: a legacy plaintext row (migration) or a row read with the
 * previous key (rotation).
 */
export function decodeStoredRow(stored: TokenRow, policy: TokenKeyPolicy): DecodeResult {
  const accEnc = isEncryptedValue(stored.accessToken);
  const refEnc = isEncryptedValue(stored.refreshToken);
  if (policy.mode === "locked") return { status: "locked", reason: policy.reason ?? "token storage locked" };
  if (policy.mode === "plaintext-local") {
    if (accEnc || refEnc) {
      return { status: "locked", reason: `stored Schwab tokens are encrypted but ${TOKEN_KEY_ENV} is not set` };
    }
    return { status: "ok", row: { ...stored }, rewrite: null };
  }
  const keys = [policy.key as Buffer, ...policy.previousKeys];
  let rotated = false;
  const open = (v: string, col: string, enc: boolean): string | null => {
    if (!enc) return v; // legacy plaintext: migrate below
    const r = decryptWithAny(v, keys, tokenAad(stored.id, col));
    if (!r) return null;
    if (r.keyIndex > 0) rotated = true;
    return r.value;
  };
  const accessToken = open(stored.accessToken, "access_token", accEnc);
  const refreshToken = open(stored.refreshToken, "refresh_token", refEnc);
  if (accessToken == null || refreshToken == null) {
    return {
      status: "decrypt_failed",
      reason: `stored Schwab tokens could not be decrypted with ${TOKEN_KEY_ENV} (wrong key or altered row); reconnect Schwab or restore the key`,
    };
  }
  const row: TokenRow = { ...stored, accessToken, refreshToken };
  const needsRewrite = !accEnc || !refEnc || rotated;
  return { status: "ok", row, rewrite: needsRewrite ? encodeRowForStorage(row, policy) : null };
}

/** Row as it must be written under the policy; throws when storage is locked. */
export function encodeRowForStorage(row: TokenRow, policy: TokenKeyPolicy): TokenRow {
  if (policy.mode === "locked") throw new Error("token_store_locked");
  if (policy.mode === "plaintext-local") return { ...row };
  const key = policy.key as Buffer;
  return {
    ...row,
    accessToken: encryptValue(row.accessToken, key, tokenAad(row.id, "access_token")),
    refreshToken: encryptValue(row.refreshToken, key, tokenAad(row.id, "refresh_token")),
  };
}
