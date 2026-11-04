import { after, before, mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  chmodSync, closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import {
  createEvidenceBackup, EVIDENCE_BACKUP_LIMITS, initializeEvidenceRecoveryKey, restoreEvidenceBackup,
} from "../server/evidenceBackup";
import { openEvidenceLedger, type EvidenceLedger } from "../server/evidenceLedger";
import { buildStockTradeBrief } from "../server/tradeBrief";
import { TRADE_BRIEF_INSTRUMENTS } from "../shared/tradeBrief";
import { makeEvidenceAcquisition, reuseEvidenceAcquisition } from "../shared/evidenceAcquisition";
import { easternDate, previousSessions } from "../server/equityCalendar";
import { etEpochMs } from "../server/etTime";

const T = Date.parse("2026-10-01T15:00:00Z");
const DAY = 86400_000;
const MAGIC_BYTES = Buffer.byteLength("BATCAVE-EVIDENCE-BACKUP\n");
const HEADER_BYTES = MAGIC_BYTES + 4 + 12;
const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const forbidden = () => { throw new Error("network forbidden by recovery test"); };
before(() => {
  mock.method(globalThis, "fetch", forbidden);
  mock.method(net.Socket.prototype, "connect", forbidden);
  mock.method(http, "request", forbidden); mock.method(https, "request", forbidden);
  mock.method(dgram, "createSocket", forbidden);
});
after(() => mock.restoreAll());
const childBlocker = `
  import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dgram from 'node:dgram';
  const forbidden=()=>{throw new Error('network forbidden by recovery test');};
  globalThis.fetch=forbidden; net.Socket.prototype.connect=forbidden;
  http.request=forbidden; https.request=forbidden; dgram.createSocket=forbidden;
`;
const instrument = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "INTC")!;
const ok = (value: unknown) => ({ state: "ok" as const, value });
function fixture(now = T, price = 105) {
  const date = easternDate(now);
  return buildStockTradeBrief(instrument, "swing", {
    quote: ok({ INTC: { symbol: "INTC", assetMainType: "EQUITY", realtime: true,
      quote: { lastPrice: price, tradeTime: now - 1000, quoteTime: now - 500, totalVolume: 0 } } }),
    history: ok({ symbol: "INTC", candles: (previousSessions(date, 30) ?? []).map(d => ({
      datetime: etEpochMs(d, 0, 0), open: 100, high: 110, low: 90, close: 100, volume: 2000,
    })) }),
    macro: ok([{ seriesId: "DGS2", latest: 3.5, latestDate: date }, { seriesId: "DGS10", latest: 4, latestDate: date }]),
  }, now);
}
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "batcave-recovery-test-"));
  const directory = join(root, "ledger"), keys = join(root, "keys"), copies = join(root, "copies");
  mkdirSync(keys, { mode: 0o700 }); mkdirSync(copies, { mode: 0o700 });
  const recoveryKeyFile = join(keys, "recovery.key"), backupFile = join(copies, "fixture.enc"), restored = join(root, "restored");
  let time = T;
  const ledger = openEvidenceLedger({ directory, now: () => time });
  const handles: EvidenceLedger[] = [ledger];
  t.after(() => {
    for (const handle of handles) try { handle.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  });
  const capture = (now = T, price = 105) => {
    time = now; const brief = fixture(now, price), receipt = ledger.capture(brief);
    if (receipt.status !== "saved") throw new Error("fixture not saved");
    return { receipt, brief };
  };
  const init = () => initializeEvidenceRecoveryKey({ recoveryKeyFile });
  const backup = () => createEvidenceBackup({ directory, recoveryKeyFile, backupFile });
  const restore = (file = backupFile, target = restored, key = recoveryKeyFile) =>
    restoreEvidenceBackup({ directory: target, recoveryKeyFile: key, backupFile: file });
  const read = (now = T) => {
    const handle = openEvidenceLedger({ directory: restored, now: () => now, readOnly: true });
    handles.push(handle); return handle;
  };
  return { root, directory, keys, copies, recoveryKeyFile, backupFile, restored, ledger, capture, init, backup, restore, read };
}
type Env = ReturnType<typeof setup>;
function noStages(env: Env) {
  for (const directory of [env.root, env.copies]) {
    assert.equal(readdirSync(directory).some(n => n.startsWith(".evidence-")), false);
  }
}
function packageParts(env: Env) {
  const encrypted = readFileSync(env.backupFile), key = readFileSync(env.recoveryKeyFile);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(MAGIC_BYTES + 4, HEADER_BYTES));
  decipher.setAAD(encrypted.subarray(0, HEADER_BYTES));
  decipher.setAuthTag(encrypted.subarray(HEADER_BYTES, HEADER_BYTES + 16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(HEADER_BYTES + 16)), decipher.final()]);
  const length = plaintext.readUInt32BE(0);
  return { manifest: JSON.parse(plaintext.subarray(4, 4 + length).toString()), receipt: plaintext.subarray(4 + length, 4 + length + 64),
    database: plaintext.subarray(4 + length + 64), plaintext };
}
function reseal(env: Env, edit: (parts: ReturnType<typeof packageParts>) => void) {
  const parts = packageParts(env); edit(parts);
  const manifest = Buffer.from(JSON.stringify(parts.manifest)), length = Buffer.alloc(4);
  length.writeUInt32BE(manifest.length);
  const plaintext = Buffer.concat([length, manifest, parts.receipt, parts.database]);
  const header = readFileSync(env.backupFile).subarray(0, HEADER_BYTES);
  randomBytes(12).copy(header, MAGIC_BYTES + 4);
  const cipher = createCipheriv("aes-256-gcm", readFileSync(env.recoveryKeyFile), header.subarray(MAGIC_BYTES + 4));
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const path = join(env.copies, `changed-${randomBytes(4).toString("hex")}.enc`);
  writeFileSync(path, Buffer.concat([header, cipher.getAuthTag(), ciphertext]), { mode: 0o600, flag: "wx" });
  return path;
}
function cli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childBlocker + `
    process.argv=[process.execPath,'scripts/evidence-backup.ts',...JSON.parse(process.env.FIXTURE_ARGS)];
    await import('./scripts/evidence-backup.ts');
  `], { cwd: resolve("."), env: { ...process.env, FIXTURE_ARGS: JSON.stringify(args) }, encoding: "utf8", timeout: 20_000 });
}

test("explicit recovery-key initialization is local, owner-only, exclusive and never prints bytes", t => {
  const env = setup(t);
  const result = cli(["init-key", "--key-file", env.recoveryKeyFile]);
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { status: "recovery_key_created" });
  assert.equal(readFileSync(env.recoveryKeyFile).length, 32);
  assert.equal(statSync(env.recoveryKeyFile).mode & 0o777, 0o600);
  const before = sha(readFileSync(env.recoveryKeyFile));
  assert.throws(env.init, /path_exists/);
  assert.equal(sha(readFileSync(env.recoveryKeyFile)), before);
  assert.throws(() => initializeEvidenceRecoveryKey({ recoveryKeyFile: join(env.root, "missing", "key") }));
  assert.equal(existsSync(join(env.root, "missing")), false);
  assert.throws(() => initializeEvidenceRecoveryKey({ recoveryKeyFile: "relative.key" }), /unsafe_path/);
  assert.throws(() => fetch("https://example.invalid"), /network forbidden/);
  assert.throws(() => net.connect(443, "example.invalid"), /network forbidden/);
});

test("online encrypted roundtrip preserves exact receipts, snapshots and replay in a separate network-blocked process", async t => {
  const env = setup(t), { receipt, brief } = env.capture();
  env.init();
  const sourceHash = sha(readFileSync(join(env.directory, "history.sqlite")));
  const sourceKeyHash = sha(readFileSync(join(env.directory, "receipt.key")));
  const backup = await env.backup();
  assert.equal(backup.status, "backup_created"); assert.equal(backup.records, 1);
  assert.equal(backup.replay.matched, 1); assert.ok(backup.payload_bytes > 1000);
  assert.equal(sha(readFileSync(join(env.directory, "history.sqlite"))), sourceHash);
  assert.equal(sha(readFileSync(join(env.directory, "receipt.key"))), sourceKeyHash);
  const encrypted = readFileSync(env.backupFile);
  for (const secret of [readFileSync(env.recoveryKeyFile), readFileSync(join(env.directory, "receipt.key")),
    Buffer.from(receipt.read_token), Buffer.from("SQLite format 3"), Buffer.from(brief.thesis)]) {
    assert.equal(encrypted.includes(secret), false, "encrypted package must not expose fixture contents");
  }
  const parts = packageParts(env);
  assert.equal(parts.plaintext.includes(readFileSync(env.recoveryKeyFile)), false, "recovery key excluded from plaintext package");
  assert.equal(parts.plaintext.includes(Buffer.from(receipt.read_token)), false, "manifest uses a separate pairing proof, not receipt tokens");
  assert.equal(parts.manifest.version, 1); assert.equal(parts.manifest.database.sha256, sha(parts.database));
  const restored = env.restore();
  assert.equal(restored.status, "restored_to_new_directory");
  assert.equal(statSync(env.backupFile).mode & 0o777, 0o600);
  assert.equal(statSync(env.restored).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(env.restored).sort(), ["history.sqlite", "receipt.key"]);
  for (const name of readdirSync(env.restored)) assert.equal(statSync(join(env.restored, name)).mode & 0o777, 0o600);
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childBlocker + `
    import {readFileSync} from 'node:fs';
    const input=JSON.parse(readFileSync(0,'utf8'));
    const {openEvidenceLedger}=await import('./server/evidenceLedger.ts');
    const ledger=openEvidenceLedger({directory:input.directory,readOnly:true,now:()=>input.now});
    const record=ledger.readWithReceipt(input.receipt.record_id,input.receipt.read_token);
    if(!record) throw new Error('original receipt did not survive');
    console.log(JSON.stringify({id:record.record_id,hash:record.payload_hash,snapshot:record.snapshot,replay:record.replay.status,
      historical:record.mode,actionable:record.actionable}));
    ledger.close();
  `], { cwd: resolve("."), input: JSON.stringify({ directory: env.restored, now: T + 60000, receipt }),
    encoding: "utf8", timeout: 15_000 });
  assert.deepEqual(JSON.parse(output), { id: receipt.record_id, hash: receipt.payload_hash, snapshot: brief,
    replay: "matched", historical: "historical_only", actionable: false });
  assert.equal(output.includes(receipt.read_token), false);
  noStages(env);
});

test("annotated acquisition survives recovery byte-for-byte without restamping old or calculated evidence", async t => {
  const env = setup(t), brief = fixture();
  const direct = makeEvidenceAcquisition("transport_response", T - 400, T - 300);
  const reused = reuseEvidenceAcquisition(direct, T - 100);
  assert.ok(direct); assert.ok(reused);
  brief.evidence.find(e => e.id === "quote-last")!.acquisition = reused;
  brief.evidence.find(e => e.id === "quote-volume")!.acquisition = direct;
  const receipt = env.ledger.capture(brief);
  if (receipt.status !== "saved") throw new Error("fixture not saved");
  const historical = env.ledger.readWithReceipt(receipt.record_id, receipt.read_token)!;
  env.init(); await env.backup(); env.restore();
  assert.deepEqual(env.read(T + 60_000).readWithReceipt(receipt.record_id, receipt.read_token), historical);
  const restored = new Database(join(env.restored, "history.sqlite"), { readonly: true });
  try {
    const raw = JSON.parse((restored.prepare("SELECT payload FROM records WHERE id = ?")
      .get(receipt.record_id) as { payload: string }).payload);
    assert.deepEqual(raw.snapshot, brief);
    const quote = raw.envelopes.find((e: { evidence_id: string }) => e.evidence_id === "quote-last");
    assert.equal(quote.received_at, new Date(T - 400).toISOString());
    assert.equal(quote.captured_at, brief.created_at);
    assert.equal(quote.first_seen_at, null); assert.equal(quote.known_at, null);
    const other = raw.envelopes.filter((e: { evidence_id: string }) => !["quote-last", "quote-volume"].includes(e.evidence_id));
    assert.ok(other.length > 0);
    assert.ok(other.every((e: { received_at: string | null }) => e.received_at === null));
    assert.equal(JSON.stringify(raw).includes(receipt.read_token), false);
  } finally { restored.close(); }
  noStages(env);
});

test("SQLite online backup includes committed WAL pages but excludes an open uncommitted transaction", async t => {
  const env = setup(t); env.capture(); env.init();
  const writer = new Database(join(env.directory, "history.sqlite"));
  try {
    writer.pragma("journal_mode = WAL"); writer.pragma("wal_autocheckpoint = 0");
    const { receipt } = env.capture(T + 1000, 106);
    assert.ok(statSync(join(env.directory, "history.sqlite-wal")).size > 0);
    writer.exec("BEGIN IMMEDIATE; UPDATE records SET payload = payload || 'corrupt-uncommitted'");
    const backup = await env.backup();
    assert.equal(backup.records, 2);
    env.restore();
    const row = env.read(T + 2000).readWithReceipt(receipt.record_id, receipt.read_token);
    assert.equal(row?.replay.status, "matched");
    assert.equal(row?.payload_hash, receipt.payload_hash);
    assert.equal(writer.inTransaction, true);
    writer.exec("ROLLBACK");
  } finally { if (writer.inTransaction) writer.exec("ROLLBACK"); writer.close(); }
  noStages(env);
});

test("empty ledgers roundtrip without inventing a record or requiring a receipt token", async t => {
  const env = setup(t); env.init();
  assert.equal((await env.backup()).records, 0);
  assert.equal(env.restore().records, 0);
  assert.deepEqual(env.read().listLocal(), []);
});

test("every physical row is verified, including expired rows and rows beyond the newest twenty; retention is not revived", async t => {
  const env = setup(t); env.init();
  const first = env.capture().receipt;
  for (let i = 1; i < 23; i++) env.capture(T + i * 1000);
  assert.equal((await env.backup()).records, 23);
  assert.equal(env.restore().replay.matched, 23);
  assert.equal(env.read(T + 31 * DAY).readWithReceipt(first.record_id, first.read_token), null);
  assert.deepEqual(env.read(T + 31 * DAY).listLocal(), []);
  const disk = new Database(join(env.restored, "history.sqlite"), { readonly: true });
  assert.equal((disk.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n, 23); disk.close();
  const source = new Database(join(env.directory, "history.sqlite"));
  source.prepare("UPDATE records SET payload = payload || ' ' WHERE id = ?").run(first.record_id); source.close();
  await assert.rejects(createEvidenceBackup({ directory: env.directory, recoveryKeyFile: env.recoveryKeyFile,
    backupFile: join(env.copies, "must-not-exist.enc") }), /integrity_failed/);
  assert.equal(existsSync(join(env.copies, "must-not-exist.enc")), false);
  noStages(env);
});

test("missing/wrong/malformed recovery keys fail closed without automatic initialization or partial restore", async t => {
  const env = setup(t); env.capture();
  await assert.rejects(env.backup(), /key_unavailable/);
  assert.equal(existsSync(env.recoveryKeyFile), false);
  env.init(); await env.backup();
  const wrongKey = join(env.keys, "wrong.key");
  initializeEvidenceRecoveryKey({ recoveryKeyFile: wrongKey });
  assert.throws(() => env.restore(env.backupFile, env.restored, wrongKey), /authentication_failed/);
  writeFileSync(wrongKey, Buffer.alloc(12));
  assert.throws(() => env.restore(env.backupFile, env.restored, wrongKey), /invalid_key/);
  unlinkSync(wrongKey);
  assert.throws(() => env.restore(env.backupFile, env.restored, wrongKey), /key_unavailable/);
  assert.equal(existsSync(env.restored), false); noStages(env);
});

test("missing receipt key never rotates access or creates a backup", async t => {
  const env = setup(t); env.capture(); env.init();
  unlinkSync(join(env.directory, "receipt.key"));
  await assert.rejects(env.backup());
  assert.equal(existsSync(join(env.directory, "receipt.key")), false);
  assert.equal(existsSync(env.backupFile), false); noStages(env);
});

test("preexisting replacement of an uncommitted source receipt key cannot be inferred from bundle pairing", async t => {
  const env = setup(t), { receipt } = env.capture(); env.init(); env.ledger.close();
  // The v1 source DB has no independent key commitment. This is a disclosed limitation,
  // not a successful continuity assertion: only a separately retained receipt can expose it.
  writeFileSync(join(env.directory, "receipt.key"), randomBytes(32).toString("hex"));
  assert.equal((await env.backup()).records, 1);
  assert.equal(env.restore().records, 1);
  const ledger = env.read();
  assert.equal(ledger.readWithReceipt(receipt.record_id, receipt.read_token), null);
  assert.equal(ledger.inspectLocal(receipt.record_id)?.payload_hash, receipt.payload_hash);
  noStages(env);
});

test("ciphertext, nonce, tag, format version, truncation and appended bytes are rejected before staging", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  const bytes = readFileSync(env.backupFile);
  const changes = [
    (b: Buffer) => { b[HEADER_BYTES + 24] ^= 1; return b; },
    (b: Buffer) => { b[MAGIC_BYTES + 4] ^= 1; return b; },
    (b: Buffer) => { b[HEADER_BYTES] ^= 1; return b; },
    (b: Buffer) => { b.writeUInt32BE(2, MAGIC_BYTES); return b; },
    (b: Buffer) => b.subarray(0, b.length - 1),
    (b: Buffer) => Buffer.concat([b, Buffer.from("extra")]),
    (b: Buffer) => b.subarray(0, 3),
  ];
  for (let i = 0; i < changes.length; i++) {
    const path = join(env.copies, `tampered-${i}.enc`);
    writeFileSync(path, changes[i](Buffer.from(bytes)), { mode: 0o600 });
    assert.throws(() => env.restore(path), /authentication_failed|unsupported_format/);
    assert.equal(existsSync(env.restored), false); noStages(env);
  }
});

test("authenticated manifest bounds, hashes, exact fixed members and receipt-key pairing are enforced", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  for (const edit of [
    (p: ReturnType<typeof packageParts>) => { p.manifest.database.sha256 = "0".repeat(64); },
    (p: ReturnType<typeof packageParts>) => { p.manifest.database.bytes--; },
    (p: ReturnType<typeof packageParts>) => { p.manifest.ledger_version = "future-ledger"; },
    (p: ReturnType<typeof packageParts>) => { p.manifest.database_schema = 2; },
    (p: ReturnType<typeof packageParts>) => { p.manifest.database.path = "../../unexpected"; },
    (p: ReturnType<typeof packageParts>) => { p.manifest.records = 501; },
    (p: ReturnType<typeof packageParts>) => { p.manifest.extra = "x".repeat(EVIDENCE_BACKUP_LIMITS.manifestBytes); },
    (p: ReturnType<typeof packageParts>) => { p.receipt = Buffer.from("f".repeat(64)); p.manifest.receipt_key.sha256 = sha(p.receipt); },
  ]) {
    assert.throws(() => env.restore(reseal(env, edit)), /integrity_failed|unsupported_format|size_limit/);
    assert.equal(existsSync(env.restored), false); noStages(env);
  }
});

test("authenticated but inconsistent row totals fail validation after staging and remove partial plaintext", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  const changed = reseal(env, p => { p.manifest.records = 2; });
  assert.throws(() => env.restore(changed), /integrity_failed/);
  assert.equal(existsSync(env.restored), false); noStages(env);
});

test("unsupported SQLite versions, extra schema objects and corrupt indexed payload identity fail closed", async t => {
  for (const change of [
    "PRAGMA user_version = 2",
    "CREATE VIEW unexpected AS SELECT * FROM records",
    "UPDATE records SET recorded_ms = recorded_ms + 1",
    "UPDATE records SET bytes = 1",
  ]) {
    const env = setup(t); env.capture(); env.init();
    const source = new Database(join(env.directory, "history.sqlite"));
    source.exec(change); source.close();
    await assert.rejects(env.backup(), /unsupported_schema|integrity_failed/);
    assert.equal(existsSync(env.backupFile), false); noStages(env);
  }
});

test("restore verifies actual SQLite integrity and every stored payload even under a valid AEAD envelope", async t => {
  for (const sql of [
    "PRAGMA user_version = 2",
    "UPDATE records SET payload = payload || ' '",
    "UPDATE records SET source_digest = '" + "0".repeat(64) + "'",
  ]) {
    const env = setup(t); env.capture(); env.init(); await env.backup();
    const path = reseal(env, p => {
      const databasePath = join(env.root, "mutation.sqlite");
      writeFileSync(databasePath, p.database, { mode: 0o600, flag: "wx" });
      const db = new Database(databasePath); db.exec(sql); db.close();
      p.database = readFileSync(databasePath);
      p.manifest.database.bytes = p.database.length; p.manifest.database.sha256 = sha(p.database);
      // Possession of the fixture recovery key allows resealing. Use the matching receipt
      // pairing proof so the test reaches DB validation, not merely the envelope gate.
      p.manifest.pairing_proof = createHmacForFixture(p.receipt, p.manifest.database.sha256);
    });
    assert.throws(() => env.restore(path), /unsupported_schema|integrity_failed/);
    assert.equal(existsSync(env.restored), false); noStages(env);
  }
});

test("truncated SQLite page data in an otherwise authenticated package fails before promotion", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  const path = reseal(env, p => {
    p.database = p.database.subarray(0, 4096);
    p.manifest.database.bytes = p.database.length; p.manifest.database.sha256 = sha(p.database);
    p.manifest.pairing_proof = createHmacForFixture(p.receipt, p.manifest.database.sha256);
  });
  assert.throws(() => env.restore(path), /integrity_failed/);
  assert.equal(existsSync(env.restored), false); noStages(env);
});

test("physical record and total-payload limits apply even to authenticated SQLite contents", async t => {
  for (const change of [
    "UPDATE records SET bytes = 50331649",
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<501)
     INSERT INTO records SELECT 'id-'||x,'snapshot-'||x,'TEST','swing',0,'x','x','{}',2 FROM n`,
  ]) {
    const env = setup(t); env.capture(); env.init();
    const db = new Database(join(env.directory, "history.sqlite")); db.exec(change); db.close();
    await assert.rejects(env.backup(), /size_limit/);
    assert.equal(existsSync(env.backupFile), false); noStages(env);
  }
});

test("online backup growth is bounded by its progress callback, with private partial snapshots cleaned", async t => {
  const env = setup(t); env.capture(); env.init();
  t.mock.method(Database.prototype, "backup", async (_path: string, options: Database.BackupOptions) => {
    options.progress({ totalPages: EVIDENCE_BACKUP_LIMITS.databaseBytes, remainingPages: 1 });
    throw new Error("progress bound was not enforced");
  });
  await assert.rejects(env.backup(), /size_limit/);
  assert.equal(existsSync(env.backupFile), false); noStages(env);
});

test("maximum encrypted input and source file size are checked before allocation; no partial output", async t => {
  const env = setup(t); env.capture(); env.init();
  const huge = join(env.copies, "oversize.enc");
  const fd = openSync(huge, "wx", 0o600);
  ftruncateSync(fd, EVIDENCE_BACKUP_LIMITS.packageBytes + 1); closeSync(fd);
  assert.throws(() => env.restore(huge), /size_limit/);
  assert.equal(existsSync(env.restored), false);
  env.ledger.close();
  const db = openSync(join(env.directory, "history.sqlite"), "r+");
  ftruncateSync(db, EVIDENCE_BACKUP_LIMITS.databaseBytes + 1); closeSync(db);
  await assert.rejects(env.backup(), /size_limit/); noStages(env);
});

test("all existing restore destinations and backup outputs are refused, including empty dirs and dangling symlinks", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  const original = sha(readFileSync(env.backupFile));
  await assert.rejects(env.backup(), /path_exists/);
  assert.equal(sha(readFileSync(env.backupFile)), original);
  for (const kind of ["directory", "file", "symlink"]) {
    const target = join(env.root, kind);
    if (kind === "directory") mkdirSync(target, { mode: 0o700 });
    else if (kind === "file") writeFileSync(target, "do not replace", { mode: 0o600 });
    else symlinkSync(join(env.root, "absent"), target);
    assert.throws(() => env.restore(env.backupFile, target), /path_exists/);
  }
  assert.equal(readFileSync(join(env.root, "file"), "utf8"), "do not replace");
  assert.deepEqual(readdirSync(join(env.root, "directory")), []);
  assert.throws(() => env.restore(env.backupFile, env.directory), /path_exists/);
  noStages(env);
});

test("a destination created during verification is preserved; verified staging is not promoted over it", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  const original = Database.prototype.pragma;
  t.mock.method(Database.prototype, "pragma", function (this: Database.Database, value: string, options: unknown) {
    if (value === "integrity_check") {
      mkdirSync(env.restored, { mode: 0o700 });
      writeFileSync(join(env.restored, "operator-marker"), "preserve", { mode: 0o600 });
    }
    return original.call(this, value, options as Parameters<typeof original>[1]);
  });
  assert.throws(env.restore, /path_exists/);
  assert.equal(readFileSync(join(env.restored, "operator-marker"), "utf8"), "preserve");
  assert.deepEqual(readdirSync(env.restored), ["operator-marker"]); noStages(env);
});

test("unsafe permissions, hardlinks and symlinks are rejected for keys, package, database and ancestors", async t => {
  const env = setup(t); env.capture(); env.init(); await env.backup();
  const symlinkKey = join(env.keys, "alias.key"); symlinkSync(env.recoveryKeyFile, symlinkKey);
  assert.throws(() => env.restore(env.backupFile, env.restored, symlinkKey), /unsafe_path/);
  const hardKey = join(env.keys, "hard.key"); linkSync(env.recoveryKeyFile, hardKey);
  assert.throws(env.restore, /unsafe_path/); unlinkSync(hardKey);
  chmodSync(env.recoveryKeyFile, 0o644);
  assert.throws(env.restore, /unsafe_path/); chmodSync(env.recoveryKeyFile, 0o600);
  chmodSync(env.copies, 0o755);
  assert.throws(env.restore, /unsafe_path/); chmodSync(env.copies, 0o700);
  const aliased = join(env.root, "alias-copies"); symlinkSync(env.copies, aliased);
  assert.throws(() => env.restore(join(aliased, "fixture.enc")), /unsafe_path/);
  chmodSync(env.root, 0o777);
  assert.throws(env.restore, /unsafe_path/); chmodSync(env.root, 0o700);
  const aliasedLedger = join(env.root, "alias-ledger"); symlinkSync(env.directory, aliasedLedger);
  await assert.rejects(createEvidenceBackup({ directory: aliasedLedger, recoveryKeyFile: env.recoveryKeyFile,
    backupFile: join(env.copies, "alias.enc") }), /unsafe_path/);
  const dbAlias = join(env.root, "db-hardlink"); linkSync(join(env.directory, "history.sqlite"), dbAlias);
  await assert.rejects(createEvidenceBackup({ directory: env.directory, recoveryKeyFile: env.recoveryKeyFile,
    backupFile: join(env.copies, "hard.enc") }), /unsafe_path/); unlinkSync(dbAlias);
  symlinkSync(join(env.root, "absent"), join(env.directory, "history.sqlite-wal"));
  await assert.rejects(createEvidenceBackup({ directory: env.directory, recoveryKeyFile: env.recoveryKeyFile,
    backupFile: join(env.copies, "wal.enc") }), /unsafe_path/);
  noStages(env);
});

test("recovery keys and outputs cannot be nested in the source/restored ledger; paths never come from the manifest", async t => {
  const env = setup(t); env.capture(); env.init();
  await assert.rejects(createEvidenceBackup({ directory: env.directory, recoveryKeyFile: env.recoveryKeyFile,
    backupFile: join(env.directory, "backup.enc") }), /unsafe_path/);
  const inside = join(env.directory, "backup.key"); initializeEvidenceRecoveryKey({ recoveryKeyFile: inside });
  await assert.rejects(createEvidenceBackup({ directory: env.directory, recoveryKeyFile: inside, backupFile: env.backupFile }), /unsafe_path/);
  await env.backup();
  assert.throws(() => env.restore(env.backupFile, env.keys), /unsafe_path/);
  assert.throws(() => env.restore(env.backupFile, env.restored + "/../restored"), /unsafe_path/);
  noStages(env);
});

test("CLI backup/restore returns bounded safe status; invalid arguments and wrong keys never echo secrets or paths", t => {
  const env = setup(t), { receipt } = env.capture(); env.init();
  const args = ["backup", "--ledger-dir", env.directory, "--key-file", env.recoveryKeyFile, "--backup-file", env.backupFile];
  const backup = cli(args);
  assert.equal(backup.status, 0); assert.equal(JSON.parse(backup.stdout).records, 1);
  const restore = cli(["restore", "--backup-file", env.backupFile, "--key-file", env.recoveryKeyFile, "--restore-dir", env.restored]);
  assert.equal(restore.status, 0); assert.equal(JSON.parse(restore.stdout).status, "restored_to_new_directory");
  const invalid = cli(["init-key", "--key", receipt.read_token]);
  assert.equal(invalid.status, 1); assert.ok(invalid.stderr.startsWith("Usage"));
  const failure = cli(["restore", "--backup-file", env.backupFile, "--key-file", join(env.keys, "missing"),
    "--restore-dir", join(env.root, "another")]);
  assert.equal(failure.status, 1); assert.ok(failure.stderr.includes("key_unavailable"));
  const allOutput = [backup, restore, invalid, failure].map(r => r.stdout + r.stderr).join("");
  for (const secret of [receipt.read_token, readFileSync(join(env.directory, "receipt.key"), "utf8"),
    readFileSync(env.recoveryKeyFile).toString("hex"), env.root]) assert.equal(allOutput.includes(secret), false);
  noStages(env);
});

// Kept separate from production helpers so resealed bad packages test production verification.
function createHmacForFixture(key: Buffer, databaseHash: string) {
  return createHmac("sha256", key).update(`batcave-evidence-backup-v1:${databaseHash}`).digest("hex");
}
