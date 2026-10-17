import Database from "better-sqlite3";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { LEDGER_VERSION } from "../shared/evidenceLedger";
import { openEvidenceLedger } from "./evidenceLedger";

// Local filesystem-owner tool only. No runtime bootstrap, HTTP, provider, AI or export dependency.
export const EVIDENCE_BACKUP_LIMITS = Object.freeze({
  databaseBytes: 64 * 1024 * 1024, packageBytes: 65 * 1024 * 1024,
  manifestBytes: 16 * 1024, records: 500, payloadBytes: 48 * 1024 * 1024,
  recordBytes: 384 * 1024, backupMilliseconds: 15_000,
});
const MAGIC = Buffer.from("BATCAVE-EVIDENCE-BACKUP\n", "ascii");
const VERSION = 1;
const HEADER_BYTES = MAGIC.length + 4 + 12;
const TAG_BYTES = 16;
const NOFOLLOW = constants.O_NOFOLLOW;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const replaySchema = z.object({
  matched: z.number().int().nonnegative(), mismatch: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(), no_calculations: z.number().int().nonnegative(),
}).strict();
const ManifestSchema = z.object({
  format: z.literal("batcave-evidence-backup"), version: z.literal(VERSION),
  cipher: z.literal("AES-256-GCM"), created_at: z.string().datetime(),
  ledger_version: z.literal(LEDGER_VERSION), database_schema: z.literal(1),
  database: z.object({ bytes: z.number().int().min(512).max(EVIDENCE_BACKUP_LIMITS.databaseBytes), sha256: hex }).strict(),
  receipt_key: z.object({ bytes: z.literal(64), sha256: hex }).strict(),
  pairing_proof: hex,
  records: z.number().int().min(0).max(EVIDENCE_BACKUP_LIMITS.records),
  payload_bytes: z.number().int().min(0).max(EVIDENCE_BACKUP_LIMITS.payloadBytes),
  replay: replaySchema,
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;
export type EvidenceBackupSummary = {
  status: "backup_created" | "restored_to_new_directory"; format_version: 1;
  records: number; payload_bytes: number; database_bytes: number; replay: Manifest["replay"];
};
type SafeCode = "unsafe_path" | "path_exists" | "key_unavailable" | "invalid_key"
  | "size_limit" | "unsupported_format" | "unsupported_schema" | "authentication_failed"
  | "integrity_failed" | "source_key_changed" | "backup_timeout" | "local_operation_failed";
export class EvidenceBackupError extends Error {
  constructor(readonly code: SafeCode) { super(code); this.name = "EvidenceBackupError"; }
}
function fail(code: SafeCode): never { throw new EvidenceBackupError(code); }
function safeError(error: unknown): EvidenceBackupError {
  return error instanceof EvidenceBackupError ? error : new EvidenceBackupError("local_operation_failed");
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const proof = (key: Buffer, databaseHash: string) =>
  createHmac("sha256", key).update(`batcave-evidence-backup-v1:${databaseHash}`).digest("hex");
const currentUid = () => {
  if (!process.getuid || NOFOLLOW === undefined) fail("unsafe_path");
  return process.getuid();
};

// POSIX only: reject symlinks at every component, writable ancestors, hardlinked files,
// and non-owner files. Root-owned sticky ancestors (e.g. /tmp) are safe above private dirs.
function absolutePath(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root
    || path.trim() !== path || path.includes("\0")) fail("unsafe_path");
  return path;
}
function maybeStat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function ancestry(directory: string) {
  const uid = currentUid(), root = parse(directory).root;
  let part = root;
  for (const component of ["", ...directory.slice(root.length).split(sep).filter(Boolean)]) {
    if (component) part = join(part, component);
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0)
      || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) fail("unsafe_path");
  }
}
function privateDirectory(path: string) {
  absolutePath(path); ancestry(path);
  const stat = lstatSync(path);
  if (stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o700) fail("unsafe_path");
  return stat;
}
function privateFile(path: string, max: number) {
  absolutePath(path); privateDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid()
    || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail("unsafe_path");
  if (stat.size > max) fail("size_limit");
  return stat;
}
function nonexistent(path: string) {
  absolutePath(path); privateDirectory(dirname(path));
  if (maybeStat(path)) fail("path_exists"); // Includes empty directories and dangling symlinks.
}
function inside(path: string, directory: string) { return path === directory || path.startsWith(directory + sep); }
function separate(paths: { directory: string; recoveryKeyFile: string; backupFile: string }) {
  for (const path of Object.values(paths)) absolutePath(path);
  if (inside(paths.recoveryKeyFile, paths.directory) || inside(paths.backupFile, paths.directory)
    || paths.recoveryKeyFile === paths.backupFile) fail("unsafe_path");
}
function readBounded(path: string, max: number): Buffer {
  const before = privateFile(path, max);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) fail("unsafe_path");
    // Never use readFile on a potentially growing file: allocation is fixed before reading.
    const value = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < value.length) {
      const n = readSync(fd, value, offset, value.length - offset, offset);
      if (!n) fail("integrity_failed");
      offset += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) || fstatSync(fd).size !== stat.size) fail("size_limit");
    return value;
  } finally { closeSync(fd); }
}
function readRecoveryKey(path: string): Buffer {
  let key: Buffer;
  try { key = readBounded(path, 32); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("key_unavailable");
    throw error;
  }
  if (key.length !== 32) { key.fill(0); fail("invalid_key"); }
  return key;
}
function readReceiptKey(path: string): Buffer {
  const value = readBounded(path, 64);
  if (value.length !== 64 || !/^[a-f0-9]{64}$/.test(value.toString("ascii"))) {
    value.fill(0); fail("invalid_key");
  }
  return value;
}
function writePrivate(path: string, bytes: Buffer) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sidecars(directory: string) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const path = join(directory, `history.sqlite${suffix}`);
    if (maybeStat(path)) privateFile(path, EVIDENCE_BACKUP_LIMITS.packageBytes);
  }
}
function openDatabase(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1500 });
  try {
    db.pragma("trusted_schema = OFF"); db.pragma("query_only = ON"); db.pragma("cell_size_check = ON");
    return db;
  } catch (error) { db.close(); throw error; }
}
function databaseBound(db: Database.Database) {
  const size = db.pragma("page_size", { simple: true }) as number;
  const pages = db.pragma("page_count", { simple: true }) as number;
  if (!Number.isSafeInteger(size) || size < 512 || size > 65536 || (size & (size - 1))
    || !Number.isSafeInteger(pages) || pages < 1 || pages * size > EVIDENCE_BACKUP_LIMITS.databaseBytes) fail("size_limit");
  return size;
}
const normalizedSql = (sql: string) => sql.replace(/\s+/g, "").toLowerCase();
const EXPECTED_SCHEMA = new Map([
  ["records", normalizedSql(`CREATE TABLE records (
    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE, instrument TEXT NOT NULL,
    horizon TEXT NOT NULL, recorded_ms INTEGER NOT NULL, source_digest TEXT NOT NULL,
    payload_hash TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL)`)],
  ["metadata", normalizedSql("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")],
  ["records_identity", normalizedSql("CREATE INDEX records_identity ON records(instrument, horizon, recorded_ms)")],
]);
function schema(db: Database.Database) {
  if (db.pragma("user_version", { simple: true }) !== 1) fail("unsupported_schema");
  const objects = db.prepare("SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL").all() as { name: string; sql: string }[];
  if (objects.length !== EXPECTED_SCHEMA.size
    || objects.some(o => EXPECTED_SCHEMA.get(o.name) !== normalizedSql(o.sql))) fail("unsupported_schema");
}
type Verification = Pick<Manifest, "records" | "payload_bytes" | "replay">;
function verifyDirectory(directory: string): Verification {
  privateDirectory(directory); sidecars(directory);
  const path = join(directory, "history.sqlite");
  privateFile(path, EVIDENCE_BACKUP_LIMITS.databaseBytes);
  const receiptKey = readReceiptKey(join(directory, "receipt.key"));
  let ledger: ReturnType<typeof openEvidenceLedger> | undefined, db: Database.Database | undefined;
  try {
    db = openDatabase(path);
    databaseBound(db); schema(db);
    if (db.pragma("journal_mode", { simple: true }) !== "delete") fail("integrity_failed");
    const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("integrity_failed");
    const size = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, MIN(recorded_ms) AS oldest FROM records")
      .get() as { n: number; bytes: number; oldest: number | null };
    if (size.n > EVIDENCE_BACKUP_LIMITS.records || !Number.isSafeInteger(size.bytes)
      || size.bytes < 0 || size.bytes > EVIDENCE_BACKUP_LIMITS.payloadBytes) fail("size_limit");
    const metadata = db.prepare("SELECT key, value FROM metadata LIMIT 2").all() as { key: string; value: string }[];
    if (metadata.length !== 1 || metadata[0].key !== "last_activity"
      || !z.string().datetime().safeParse(metadata[0].value).success) fail("integrity_failed");
    // Use the oldest stored time, NOT today's retention-filtered listing: every row, including
    // inactive/expired rows and records beyond the 20-item owner listing, must be decoded.
    ledger = openEvidenceLedger({ directory, readOnly: true, now: () => size.oldest ?? 0 });
    const replay: Manifest["replay"] = { matched: 0, mismatch: 0, unsupported: 0, no_calculations: 0 };
    let payloadBytes = 0;
    const rows = db.prepare("SELECT id, payload_hash, recorded_ms, bytes, length(CAST(payload AS BLOB)) AS actual_bytes FROM records");
    for (const row of rows.iterate() as Iterable<{ id: string; payload_hash: string; recorded_ms: number; bytes: number; actual_bytes: number }>) {
      if (!z.string().uuid().safeParse(row.id).success || !hex.safeParse(row.payload_hash).success
        || !Number.isSafeInteger(row.recorded_ms) || !Number.isFinite(new Date(row.recorded_ms).getTime())
        || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes !== row.actual_bytes
        || row.bytes > EVIDENCE_BACKUP_LIMITS.recordBytes) fail("integrity_failed");
      // Match the ledger's ASCII-hex signing-key convention, not hex-decoded key bytes.
      const token = createHmac("sha256", receiptKey).update(`${row.id}:${row.payload_hash}`).digest("hex");
      const record = ledger.readWithReceipt(row.id, token);
      if (!record || record.payload_hash !== row.payload_hash) fail("integrity_failed");
      replay[record.replay.status]++;
      payloadBytes += row.bytes;
    }
    if (payloadBytes !== size.bytes || Object.values(replay).reduce((a, b) => a + b, 0) !== size.n) fail("integrity_failed");
    return { records: size.n, payload_bytes: payloadBytes, replay };
  } catch (error) {
    if (error instanceof EvidenceBackupError) throw error;
    return fail("integrity_failed");
  } finally { ledger?.close(); db?.close(); receiptKey.fill(0); }
}
function summary(manifest: Manifest, status: EvidenceBackupSummary["status"]): EvidenceBackupSummary {
  return { status, format_version: 1, records: manifest.records, payload_bytes: manifest.payload_bytes,
    database_bytes: manifest.database.bytes, replay: manifest.replay };
}

/** Explicit one-time local initialization. Never reads a key from argv/env or prints key bytes. */
export function initializeEvidenceRecoveryKey(options: { recoveryKeyFile: string }) {
  let key: Buffer | undefined;
  try {
    nonexistent(options.recoveryKeyFile);
    key = randomBytes(32);
    writePrivate(options.recoveryKeyFile, key);
    syncDirectory(dirname(options.recoveryKeyFile));
    return { status: "recovery_key_created" as const };
  } catch (error) { throw safeError(error); }
  finally { key?.fill(0); }
}

/** SQLite online backup API, never a raw copy of the active database. */
export async function createEvidenceBackup(options: { directory: string; backupFile: string; recoveryKeyFile: string }): Promise<EvidenceBackupSummary> {
  let recoveryKey: Buffer | undefined, receiptKey: Buffer | undefined, plaintext: Buffer | undefined;
  let stage: string | undefined, db: Database.Database | undefined;
  try {
    separate(options); privateDirectory(options.directory); nonexistent(options.backupFile);
    recoveryKey = readRecoveryKey(options.recoveryKeyFile);
    receiptKey = readReceiptKey(join(options.directory, "receipt.key"));
    const sourcePath = join(options.directory, "history.sqlite");
    privateFile(sourcePath, EVIDENCE_BACKUP_LIMITS.databaseBytes); sidecars(options.directory);
    db = openDatabase(sourcePath);
    const pageSize = databaseBound(db);
    schema(db);
    stage = mkdtempSync(join(dirname(options.backupFile), ".evidence-backup-"));
    const snapshotPath = join(stage, "history.sqlite");
    // Precreate at 0600 rather than relying on SQLite/process umask.
    writePrivate(snapshotPath, Buffer.alloc(0));
    const started = performance.now();
    await db.backup(snapshotPath, { progress: info => {
      if (info.totalPages * pageSize > EVIDENCE_BACKUP_LIMITS.databaseBytes) fail("size_limit");
      if (performance.now() - started > EVIDENCE_BACKUP_LIMITS.backupMilliseconds) fail("backup_timeout");
      return 256;
    } });
    db.close(); db = undefined;
    if (performance.now() - started > EVIDENCE_BACKUP_LIMITS.backupMilliseconds) fail("backup_timeout");
    const afterKey = readReceiptKey(join(options.directory, "receipt.key"));
    try { if (!same(receiptKey, afterKey)) fail("source_key_changed"); } finally { afterKey.fill(0); }
    // The private online snapshot may inherit WAL mode. Normalize only the snapshot to a
    // standalone DELETE-journal database; never checkpoint/mutate the source.
    const snapshot = new Database(snapshotPath, { fileMustExist: true, timeout: 1500 });
    try { snapshot.pragma("trusted_schema = OFF"); snapshot.pragma("journal_mode = DELETE"); }
    finally { snapshot.close(); }
    writePrivate(join(stage, "receipt.key"), receiptKey);
    const verified = verifyDirectory(stage);
    const database = readBounded(snapshotPath, EVIDENCE_BACKUP_LIMITS.databaseBytes);
    const databaseHash = hash(database);
    const manifest = ManifestSchema.parse({
      format: "batcave-evidence-backup", version: VERSION, cipher: "AES-256-GCM",
      created_at: new Date().toISOString(), ledger_version: LEDGER_VERSION, database_schema: 1,
      database: { bytes: database.length, sha256: databaseHash },
      receipt_key: { bytes: 64, sha256: hash(receiptKey) }, pairing_proof: proof(receiptKey, databaseHash),
      ...verified,
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4);
    if (manifestBytes.length > EVIDENCE_BACKUP_LIMITS.manifestBytes) fail("size_limit");
    length.writeUInt32BE(manifestBytes.length);
    plaintext = Buffer.concat([length, manifestBytes, receiptKey, database]);
    database.fill(0);
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header); header.writeUInt32BE(VERSION, MAGIC.length); randomBytes(12).copy(header, MAGIC.length + 4);
    const cipher = createCipheriv("aes-256-gcm", recoveryKey, header.subarray(MAGIC.length + 4), { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encrypted = Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
    if (encrypted.length > EVIDENCE_BACKUP_LIMITS.packageBytes) fail("size_limit");
    const encryptedPath = join(stage, "package.enc");
    writePrivate(encryptedPath, encrypted);
    nonexistent(options.backupFile);
    // A hardlink publishes the complete encrypted file without ever replacing an existing path.
    linkSync(encryptedPath, options.backupFile);
    rmSync(encryptedPath);
    syncDirectory(dirname(options.backupFile));
    return summary(manifest, "backup_created");
  } catch (error) { throw safeError(error); }
  finally {
    db?.close(); recoveryKey?.fill(0); receiptKey?.fill(0); plaintext?.fill(0);
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

/** Authenticated restore to a NEW directory only; never selects it as a live ledger. */
export function restoreEvidenceBackup(options: { directory: string; backupFile: string; recoveryKeyFile: string }): EvidenceBackupSummary {
  let recoveryKey: Buffer | undefined, plaintext: Buffer | undefined;
  let stage: string | undefined, reservation: ReturnType<typeof lstatSync> | undefined;
  try {
    separate(options); nonexistent(options.directory);
    recoveryKey = readRecoveryKey(options.recoveryKeyFile);
    const encrypted = readBounded(options.backupFile, EVIDENCE_BACKUP_LIMITS.packageBytes);
    if (encrypted.length < HEADER_BYTES + TAG_BYTES + 4 || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)
      || encrypted.readUInt32BE(MAGIC.length) !== VERSION) fail("unsupported_format");
    const header = encrypted.subarray(0, HEADER_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", recoveryKey, header.subarray(MAGIC.length + 4), { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(encrypted.subarray(HEADER_BYTES, HEADER_BYTES + TAG_BYTES));
    let pending: Buffer | undefined;
    try {
      pending = decipher.update(encrypted.subarray(HEADER_BYTES + TAG_BYTES));
      // Nothing is parsed or written until authentication succeeds.
      plaintext = Buffer.concat([pending, decipher.final()]);
    } catch { fail("authentication_failed"); }
    finally { pending?.fill(0); }
    const manifestSize = plaintext.readUInt32BE(0);
    if (!manifestSize || manifestSize > EVIDENCE_BACKUP_LIMITS.manifestBytes
      || manifestSize + 4 + 64 >= plaintext.length) fail("size_limit");
    const parsed = ManifestSchema.safeParse(JSON.parse(plaintext.subarray(4, 4 + manifestSize).toString("utf8")));
    if (!parsed.success) fail("unsupported_format");
    const manifest = parsed.data;
    const receiptKey = plaintext.subarray(4 + manifestSize, 4 + manifestSize + 64);
    const database = plaintext.subarray(4 + manifestSize + 64);
    if (database.length !== manifest.database.bytes || hash(database) !== manifest.database.sha256
      || !/^[a-f0-9]{64}$/.test(receiptKey.toString("ascii")) || hash(receiptKey) !== manifest.receipt_key.sha256
      || !same(Buffer.from(proof(receiptKey, manifest.database.sha256), "hex"), Buffer.from(manifest.pairing_proof, "hex"))) fail("integrity_failed");
    stage = mkdtempSync(join(dirname(options.directory), ".evidence-restore-"));
    writePrivate(join(stage, "history.sqlite"), database);
    writePrivate(join(stage, "receipt.key"), receiptKey);
    const verified = verifyDirectory(stage);
    if (verified.records !== manifest.records || verified.payload_bytes !== manifest.payload_bytes
      || Object.keys(verified.replay).some(k => verified.replay[k as keyof Manifest["replay"]] !== manifest.replay[k as keyof Manifest["replay"]])) fail("integrity_failed");
    syncDirectory(stage);
    nonexistent(options.directory);
    // Atomically reserve a previously absent name (mkdir fails on any existing path).
    // Rename replaces ONLY our own fresh empty reservation, not an operator's directory.
    mkdirSync(options.directory, { mode: 0o700 });
    reservation = lstatSync(options.directory);
    privateDirectory(options.directory);
    renameSync(stage, options.directory);
    stage = undefined; reservation = undefined;
    syncDirectory(dirname(options.directory));
    return summary(manifest, "restored_to_new_directory");
  } catch (error) { throw safeError(error); }
  finally {
    recoveryKey?.fill(0); plaintext?.fill(0);
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (reservation) {
      const current = maybeStat(options.directory);
      if (current?.ino === reservation.ino && current.dev === reservation.dev) rmSync(options.directory, { recursive: true, force: true });
    }
  }
}
