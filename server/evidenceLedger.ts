import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ArchivedTradeBriefSchema, TradeBriefSchema, type TradeBrief } from "../shared/tradeBrief";
import { tradeBriefEnvelopes } from "../shared/tradeBriefEvidence";
import {
  ArchiveReceiptSchema, LEDGER_RETENTION_DAYS, LEDGER_VERSION, LedgerReadResponseSchema,
  type ArchiveReceipt, type LedgerReadResponse,
} from "../shared/evidenceLedger";
import { verifyStoredCalculations } from "./evidenceReplay";

const DAY = 86400_000;
const MAX_PAYLOAD = 384 * 1024;
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
const PayloadSchema = z.object({
  record_id: z.string().uuid(), recorded_at: z.string().datetime(),
  schema_version: z.literal(LEDGER_VERSION), snapshot: z.unknown(), envelopes: z.array(z.unknown()).max(512),
  predecessor_record_id: z.string().uuid().nullable(),
  changes: LedgerReadResponseSchema.shape.changes, writer_session: LedgerReadResponseSchema.shape.writer_session,
}).strict();
type Stored = { id: string; snapshot_id: string; instrument: string; horizon: string;
  recorded_ms: number; source_digest: string; payload_hash: string; payload: string; bytes: number };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (t: number) => new Date(t).toISOString();
const unavailable: ArchiveReceipt = { status: "unavailable", detail: "Local evidence archive unavailable. This brief is not confirmed saved; no historical record was substituted." };
export const unavailableArchiveReceipt = () => ({ ...unavailable });

export function openEvidenceLedger(options: {
  directory?: string; now?: () => number; maxRecords?: number; maxBytes?: number; readOnly?: boolean;
} = {}) {
  const directory = resolve(options.directory ?? "data/evidence-ledger");
  const now = options.now ?? Date.now;
  const maxRecords = Math.max(1, Math.min(500, options.maxRecords ?? 500));
  const maxBytes = Math.max(MAX_PAYLOAD, Math.min(DEFAULT_MAX_BYTES, options.maxBytes ?? DEFAULT_MAX_BYTES));
  const path = resolve(directory, "history.sqlite"), keyPath = resolve(directory, "receipt.key");
  if (!options.readOnly) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    // Never silently regenerate a missing receipt key for an existing archive.
    if (!existsSync(keyPath)) {
      if (existsSync(path)) throw new Error("ledger_key_missing");
      try { writeFileSync(keyPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
      catch (error) { if (!existsSync(keyPath)) throw error; }
    }
    chmodSync(keyPath, 0o600);
  }
  const key = readFileSync(keyPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid_ledger_key");
  const db = new Database(path, { readonly: options.readOnly === true, fileMustExist: options.readOnly === true, timeout: 1500 });
  let writer: z.infer<typeof LedgerReadResponseSchema.shape.writer_session> | null = null;
  try {
    if (!options.readOnly) {
      chmodSync(path, 0o600);
      db.pragma("journal_mode = DELETE"); db.pragma("synchronous = FULL");
      db.pragma("secure_delete = ON"); db.pragma("max_page_count = 16384");
      const version = db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1) throw new Error("unsupported_ledger_schema");
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE, instrument TEXT NOT NULL,
          horizon TEXT NOT NULL, recorded_ms INTEGER NOT NULL, source_digest TEXT NOT NULL,
          payload_hash TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS records_identity ON records(instrument, horizon, recorded_ms);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
      db.transaction(() => {
        const previous = db.prepare("SELECT value FROM metadata WHERE key = 'last_activity'").get() as { value: string } | undefined;
        if (previous && (!Number.isFinite(Date.parse(previous.value)) || Date.parse(previous.value) > now())) throw new Error("ledger_clock_regressed");
        writer = { id: randomUUID(), opened_at: iso(now()), previous_activity_at: previous?.value ?? null,
          continuity: previous ? "unverified_between_writer_sessions" : "first_session" };
        db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('last_activity',?)").run(iso(now()));
      })();
    } else if (db.pragma("user_version", { simple: true }) !== 1) throw new Error("unsupported_ledger_schema");
  } catch (error) { db.close(); throw error; }

  const token = (r: Pick<Stored, "id" | "payload_hash">) => createHmac("sha256", key).update(`${r.id}:${r.payload_hash}`).digest("hex");
  function decode(r: Stored) {
    if (Buffer.byteLength(r.payload) > MAX_PAYLOAD || Buffer.byteLength(r.payload) !== r.bytes
      || digest(r.payload) !== r.payload_hash) throw new Error("ledger_integrity_failure");
    const payload = PayloadSchema.parse(JSON.parse(r.payload));
    const snapshot = ArchivedTradeBriefSchema.parse(payload.snapshot);
    if (payload.record_id !== r.id || payload.recorded_at !== iso(r.recorded_ms)
      || snapshot.archive || snapshot.snapshot_id !== r.snapshot_id || snapshot.instrument_id !== r.instrument
      || snapshot.horizon !== r.horizon || digest(canonical(payload.snapshot)) !== r.source_digest) throw new Error("ledger_integrity_failure");
    return { payload, snapshot };
  }
  function prune(incoming: number) {
    db.prepare("DELETE FROM records WHERE recorded_ms <= ?").run(now() - LEDGER_RETENTION_DAYS * DAY);
    for (;;) {
      const size = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM records").get() as { n: number; bytes: number };
      if (size.n < maxRecords && size.bytes + incoming <= maxBytes) break;
      if (!size.n) throw new Error("ledger_size_limit");
      db.prepare("DELETE FROM records WHERE id = (SELECT id FROM records ORDER BY recorded_ms, rowid LIMIT 1)").run();
    }
  }
  function capture(input: TradeBrief): ArchiveReceipt {
    if (options.readOnly || !writer) throw new Error("read_only_ledger");
    // Receipt tokens never enter persistent snapshot content.
    const { archive: _receipt, ...bare } = input;
    const snapshot = TradeBriefSchema.parse(bare);
    const captured = Date.parse(snapshot.created_at), expires = Date.parse(snapshot.expires_at);
    if (!Number.isFinite(captured) || !Number.isFinite(expires) || captured > now() || expires <= captured
      || now() - captured >= DAY) throw new Error("invalid_capture_time");
    const sourceDigest = digest(canonical(snapshot));
    return db.transaction(() => {
      const existing = db.prepare("SELECT * FROM records WHERE snapshot_id = ?").get(snapshot.snapshot_id) as Stored | undefined;
      if (existing) {
        decode(existing);
        if (existing.source_digest !== sourceDigest) throw new Error("snapshot_id_conflict");
        return receipt(existing);
      }
      const previous = db.prepare("SELECT * FROM records WHERE instrument = ? AND horizon = ? AND recorded_ms > ? ORDER BY recorded_ms DESC, rowid DESC LIMIT 1")
        .get(snapshot.instrument_id, snapshot.horizon, now() - LEDGER_RETENTION_DAYS * DAY) as Stored | undefined;
      const prior = previous ? decode(previous).snapshot : undefined;
      if (prior && Date.parse(prior.created_at) > captured) throw new Error("capture_clock_regressed");
      const currentRows = [...snapshot.evidence, ...(snapshot.context_items ?? [])];
      const oldRows = new Map([...(prior?.evidence ?? []), ...(prior?.context_items ?? [])].map(e => [e.id, e]));
      const changed: string[] = [], revised: string[] = [];
      for (const e of currentRows) {
        const old = oldRows.get(e.id);
        if (!old || canonical(old) !== canonical(e)) {
          changed.push(e.id);
          if (old && old.observed_at === e.observed_at && old.source_id === e.source_id
            && canonical("value" in old ? old.value : old.text) !== canonical("value" in e ? e.value : e.text)) revised.push(e.id);
        }
        oldRows.delete(e.id);
      }
      changed.push(...oldRows.keys());
      const recordId = randomUUID(), recordedMs = now();
      const payload = canonical({
        record_id: recordId, recorded_at: iso(recordedMs),
        schema_version: LEDGER_VERSION, snapshot, envelopes: tradeBriefEnvelopes(snapshot).rows,
        predecessor_record_id: previous?.id ?? null,
        changes: { kind: "new_capture_not_provider_correction", changed_ids: prior ? changed : [],
          same_observation_changed_ids: revised, calculation_version_changed: !!prior && prior.calculation_version !== snapshot.calculation_version },
        writer_session: writer,
      });
      const bytes = Buffer.byteLength(payload);
      if (bytes > MAX_PAYLOAD) throw new Error("ledger_payload_limit");
      // All eviction and insertion are one transaction; failures roll back both.
      prune(bytes);
      const r: Stored = { id: recordId, snapshot_id: snapshot.snapshot_id, instrument: snapshot.instrument_id,
        horizon: snapshot.horizon, recorded_ms: recordedMs, source_digest: sourceDigest,
        payload_hash: digest(payload), payload, bytes };
      db.prepare("INSERT INTO records VALUES (@id,@snapshot_id,@instrument,@horizon,@recorded_ms,@source_digest,@payload_hash,@payload,@bytes)").run(r);
      db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('last_activity',?)").run(iso(now()));
      return receipt(r);
    })();
  }
  function receipt(r: Stored): ArchiveReceipt {
    return ArchiveReceiptSchema.parse({ status: "saved", record_id: r.id, stored_at: iso(r.recorded_ms),
      payload_hash: r.payload_hash, read_token: token(r), retention_days: LEDGER_RETENTION_DAYS });
  }
  function find(id: string) {
    if (!z.string().uuid().safeParse(id).success) return undefined;
    return db.prepare("SELECT * FROM records WHERE id = ? AND recorded_ms > ?").get(id, now() - LEDGER_RETENTION_DAYS * DAY) as Stored | undefined;
  }
  function historical(r: Stored): LedgerReadResponse {
    const { payload, snapshot } = decode(r);
    return LedgerReadResponseSchema.parse({
      schema_version: LEDGER_VERSION, record_id: r.id, recorded_at: iso(r.recorded_ms), payload_hash: r.payload_hash,
      integrity: "checksum_verified", mode: "historical_only", actionable: false, point_in_time_safe: false,
      predecessor_record_id: payload.predecessor_record_id, changes: payload.changes,
      writer_session: payload.writer_session, snapshot, evidence_count: payload.envelopes.length,
      replay: verifyStoredCalculations(snapshot),
      limitations: [
        "Historical capture only. No live quote, provider refresh, model call, trading action or restoration into the live AI cache.",
        "Checksum detects accidental changes, not malicious rewriting by someone controlling the database and key.",
        "Recorded time proves local storage time only. Provider receipt/first-seen/known-at fields remain unknown when not collected.",
        "Writer-session boundaries mark unverified continuity, not measured downtime or continuous collection.",
        "Records are readable for at most 30 days, with limits of 500 records and 48 MiB of payloads. Expired rows are purged on subsequent successful capture, not while the archive is inactive. This is not a backup.",
        "Same-observation changes are detected differences, not authenticated provider corrections. Source rights and multi-user security remain unverified.",
      ],
    });
  }
  function readWithReceipt(id: string, supplied: string): LedgerReadResponse | null {
    const r = find(id);
    const expected = r ? token(r) : createHmac("sha256", key).update("unknown-record").digest("hex");
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) || !r) return null;
    return historical(r);
  }
  // Local operator only. These functions are never exposed as HTTP list/bypass routes.
  function inspectLocal(id: string) { const r = find(id); return r ? historical(r) : null; }
  function listLocal() {
    return db.prepare("SELECT id, snapshot_id, instrument, horizon, recorded_ms, payload_hash FROM records WHERE recorded_ms > ? ORDER BY recorded_ms DESC, rowid DESC LIMIT 20")
      .all(now() - LEDGER_RETENTION_DAYS * DAY);
  }
  return { capture, readWithReceipt, inspectLocal, listLocal, close: () => db.close() };
}
export type EvidenceLedger = ReturnType<typeof openEvidenceLedger>;
