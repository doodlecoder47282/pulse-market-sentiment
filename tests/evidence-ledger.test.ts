import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { openEvidenceLedger, type EvidenceLedger } from "../server/evidenceLedger";
import { verifyStoredCalculations } from "../server/evidenceReplay";
import { registerEvidenceLedgerRoutes } from "../server/evidenceLedgerRoutes";
import { buildStockTradeBrief, createTradeBriefService } from "../server/tradeBrief";
import { createTradeBriefAiService } from "../server/tradeBriefAi";
import { easternDate, previousSessions } from "../server/equityCalendar";
import { etEpochMs } from "../server/etTime";
import { ArchivedTradeBriefSchema, TRADE_BRIEF_INSTRUMENTS, type TradeBrief } from "../shared/tradeBrief";
import { ArchiveReceiptSchema, LedgerReadResponseSchema } from "../shared/evidenceLedger";
import type { Express } from "express";

const T = Date.parse("2026-10-01T15:00:00Z");
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
function setup(t: TestContext, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "batcave-ledger-"));
  let time = T;
  const handles: EvidenceLedger[] = [];
  const open = (extra = {}) => {
    const ledger = openEvidenceLedger({ directory, now: () => time, ...options, ...extra });
    handles.push(ledger); return ledger;
  };
  t.after(() => { for (const h of handles) try { h.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { directory, open, setTime: (value: number) => { time = value; } };
}
function saved(ledger: EvidenceLedger, b = fixture()) {
  const receipt = ledger.capture(b);
  assert.equal(receipt.status, "saved");
  if (receipt.status !== "saved") throw new Error("not saved");
  return receipt;
}

test("immutable capture survives reopen with original bytes, times, formulas and null known-at", t => {
  const env = setup(t), ledger = env.open(), b = fixture(), receipt = saved(ledger, b);
  const first = ledger.readWithReceipt(receipt.record_id, receipt.read_token)!;
  assert.ok(LedgerReadResponseSchema.safeParse(first).success);
  assert.deepEqual(first.snapshot, b);
  assert.equal(first.replay.status, "matched"); assert.ok(first.replay.checked_count > 20);
  assert.equal(first.point_in_time_safe, false); assert.equal(first.actionable, false);
  const disk = new Database(join(env.directory, "history.sqlite"), { readonly: true });
  const raw = JSON.parse((disk.prepare("SELECT payload FROM records").get() as { payload: string }).payload);
  assert.ok(raw.envelopes.every((e: any) => e.received_at === null && e.first_seen_at === null && e.known_at === null));
  assert.equal(JSON.stringify(raw).includes(receipt.read_token), false);
  assert.equal(raw.snapshot.archive, undefined);
  disk.close(); ledger.close();
  env.setTime(T + 120000);
  const reopened = env.open();
  assert.deepEqual(reopened.readWithReceipt(receipt.record_id, receipt.read_token), first);
  assert.equal((first.snapshot as TradeBrief).expires_at, b.expires_at);
});

test("separate process reads the same archive without network or provider bootstrap", t => {
  const env = setup(t), ledger = env.open(), receipt = saved(ledger);
  ledger.close();
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { openEvidenceLedger } from './server/evidenceLedger.ts';
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0,'utf8'));
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    const ledger = openEvidenceLedger({directory:input.directory,readOnly:true,now:()=>input.now});
    const result = ledger.readWithReceipt(input.id,input.receipt);
    console.log(JSON.stringify({id:result.record_id,hash:result.payload_hash,replay:result.replay.status}));
    ledger.close();
  `], { cwd: resolve("."), input: JSON.stringify({ directory: env.directory, now: T + 60000,
    id: receipt.record_id, receipt: receipt.read_token }), encoding: "utf8", timeout: 15000 });
  assert.deepEqual(JSON.parse(output), { id: receipt.record_id, hash: receipt.payload_hash, replay: "matched" });
});

test("idempotent duplicate creates one record and conflicting reuse cannot overwrite it", t => {
  const env = setup(t), ledger = env.open(), b = fixture(), a = saved(ledger, b), second = saved(ledger, b);
  assert.deepEqual(a, second); assert.equal(ledger.listLocal().length, 1);
  const conflict = structuredClone(b); conflict.thesis = "Different text on an old identifier";
  assert.throws(() => ledger.capture(conflict), /snapshot_id_conflict/);
  assert.deepEqual(ledger.readWithReceipt(a.record_id, a.read_token)!.snapshot, b);
  const withReceipt = { ...b, archive: a };
  assert.deepEqual(saved(ledger, withReceipt), a);
});

test("new captures preserve predecessors and same-observation changes without rewriting history", t => {
  const env = setup(t), ledger = env.open(), b = fixture(), first = saved(ledger, b);
  env.setTime(T + 1000);
  const next = fixture(T + 1000, 106);
  next.evidence.find(e => e.id === "quote-last")!.observed_at = b.evidence.find(e => e.id === "quote-last")!.observed_at;
  const receipt = saved(ledger, next), historical = ledger.readWithReceipt(receipt.record_id, receipt.read_token)!;
  assert.equal(historical.predecessor_record_id, first.record_id);
  assert.ok(historical.changes.same_observation_changed_ids.includes("quote-last"));
  assert.equal(historical.changes.kind, "new_capture_not_provider_correction");
  assert.equal((ledger.readWithReceipt(first.record_id, first.read_token)!.snapshot as TradeBrief).quote?.value, 105);
});

test("writer sessions disclose continuity uncertainty without inventing downtime", t => {
  const env = setup(t), first = env.open(); saved(first); first.close();
  env.setTime(T + 3600000);
  const second = env.open(), receipt = saved(second, fixture(T + 3600000));
  const record = second.readWithReceipt(receipt.record_id, receipt.read_token)!;
  assert.equal(record.writer_session.continuity, "unverified_between_writer_sessions");
  assert.equal(record.writer_session.previous_activity_at, new Date(T).toISOString());
  assert.equal(record.writer_session.opened_at, new Date(T + 3600000).toISOString());
});

test("receipt scope rejects bad, missing, cross-record and unknown capabilities", t => {
  const env = setup(t), ledger = env.open(), a = saved(ledger);
  env.setTime(T + 1000); const b = saved(ledger, fixture(T + 1000));
  assert.equal(ledger.readWithReceipt(a.record_id, "0".repeat(64)), null);
  assert.equal(ledger.readWithReceipt(a.record_id, ""), null);
  assert.equal(ledger.readWithReceipt(a.record_id, b.read_token), null);
  assert.equal(ledger.readWithReceipt("00000000-0000-4000-8000-000000000000", a.read_token), null);
  assert.equal(ledger.readWithReceipt("../receipt.key", a.read_token), null);
});

test("payload corruption and indexed timestamp corruption fail checksum/metadata verification", t => {
  for (const column of ["payload", "recorded_ms"]) {
    const env = setup(t), ledger = env.open(), receipt = saved(ledger);
    const db = new Database(join(env.directory, "history.sqlite"));
    if (column === "payload") db.prepare("UPDATE records SET payload = payload || ' ' WHERE id = ?").run(receipt.record_id);
    else db.prepare("UPDATE records SET recorded_ms = recorded_ms + 1 WHERE id = ?").run(receipt.record_id);
    db.close();
    assert.throws(() => ledger.readWithReceipt(receipt.record_id, receipt.read_token), /ledger_integrity_failure/);
  }
});

test("numerical replay detects mismatches independently of payload integrity", () => {
  const b = fixture();
  assert.equal(verifyStoredCalculations(b).status, "matched");
  b.evidence.find(e => e.id === "atr14")!.value += 1;
  const check = verifyStoredCalculations(b);
  assert.equal(check.status, "mismatch"); assert.ok(check.mismatch_ids.includes("atr14"));
  const altered = fixture(); altered.levels[0].value += 3;
  assert.ok(verifyStoredCalculations(altered).mismatch_ids.includes("level-support"));
  const unsupported = fixture(); unsupported.calculation_version = "future-version";
  assert.equal(verifyStoredCalculations(unsupported).status, "unsupported");
});

test("archived decoder preserves old version stamps without upgrading to current policy", () => {
  const b = fixture();
  const old = { ...b, evidence_review: { ...b.evidence_review, version: "older-policy" },
    session: { ...b.session, schedule: { ...b.session.schedule, version: "older-calendar" } } };
  const parsed = ArchivedTradeBriefSchema.parse(old);
  assert.equal(parsed.evidence_review?.version, "older-policy");
  assert.equal(parsed.session.schedule?.version, "older-calendar");
});

test("count and age retention remove only ledger records and explicitly deny expired receipts", t => {
  const env = setup(t, { maxRecords: 2 }), ledger = env.open(), a = saved(ledger);
  env.setTime(T + 1000); const b = saved(ledger, fixture(T + 1000));
  env.setTime(T + 2000); saved(ledger, fixture(T + 2000));
  assert.equal(ledger.listLocal().length, 2);
  assert.equal(ledger.readWithReceipt(a.record_id, a.read_token), null);
  assert.ok(ledger.readWithReceipt(b.record_id, b.read_token));
  env.setTime(T + 31 * 86400000);
  assert.equal(ledger.readWithReceipt(b.record_id, b.read_token), null);
  assert.equal(ledger.listLocal().length, 0);
});

test("failed insertion rolls back eviction as well as capture", t => {
  const env = setup(t, { maxRecords: 1 }), ledger = env.open(), a = saved(ledger);
  const db = new Database(join(env.directory, "history.sqlite"));
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  db.close(); env.setTime(T + 1000);
  assert.throws(() => ledger.capture(fixture(T + 1000)), /test_failure/);
  assert.equal(ledger.listLocal().length, 1);
  assert.ok(ledger.readWithReceipt(a.record_id, a.read_token));
});

test("payload size bound rejects oversized input without evicting prior capture", t => {
  const env = setup(t), ledger = env.open(), a = saved(ledger), b = fixture(T + 1000);
  b.methodology.push("x".repeat(400000)); env.setTime(T + 1000);
  assert.throws(() => ledger.capture(b), /ledger_payload_limit/);
  assert.ok(ledger.readWithReceipt(a.record_id, a.read_token));
});

test("total payload-byte cap prunes oldest captures independently of count cap", t => {
  const limit = 384 * 1024, env = setup(t, { maxBytes: limit }), ledger = env.open();
  for (let i = 0; i < 8; i++) { env.setTime(T + i * 1000); saved(ledger, fixture(T + i * 1000)); }
  const db = new Database(join(env.directory, "history.sqlite"), { readonly: true });
  const size = db.prepare("SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM records").get() as { n: number; bytes: number };
  assert.ok(size.bytes <= limit); assert.ok(size.n > 0 && size.n < 8);
  db.close();
});

test("cached and concurrent Analyze captures once, not once per reader", async t => {
  const env = setup(t), ledger = env.open();
  let captures = 0;
  const service = createTradeBriefService({ quote: async () => null, history: async () => null,
    macro: async () => [], now: () => T }, brief => { captures++; return ledger.capture(brief); });
  const [a, b] = await Promise.all([service.analyze(instrument.id, "swing"), service.analyze(instrument.id, "swing")]);
  assert.equal(a, b); assert.equal(captures, 1);
  assert.equal((await service.analyze(instrument.id, "swing")).archive?.status, "saved");
  assert.equal(captures, 1); assert.equal(ledger.listLocal().length, 1);
});

test("private filesystem permissions, ignored secrets, logger redaction and missing-key failure", t => {
  const env = setup(t), ledger = env.open(); saved(ledger);
  assert.equal(statSync(env.directory).mode & 0o777, 0o700);
  for (const f of ["receipt.key", "history.sqlite"]) assert.equal(statSync(join(env.directory, f)).mode & 0o777, 0o600);
  assert.ok(readFileSync(".gitignore", "utf8").includes("data/evidence-ledger/"));
  const server = readFileSync("server/index.ts", "utf8");
  // Either trade-brief bodies are excluded from capture, or no response body is captured at all.
  assert.ok((server.includes('path.startsWith("/api/trade-brief")') && server.includes("if (!privateResearchResponse) capturedJsonResponse"))
    || (!server.includes("capturedJsonResponse") && server.includes("Response bodies are not")));
  ledger.close(); unlinkSync(join(env.directory, "receipt.key"));
  assert.throws(() => env.open(), /ledger_key_missing/);
});

test("clock regression and invalid future capture fail closed", t => {
  const env = setup(t), ledger = env.open(); saved(ledger);
  assert.throws(() => ledger.capture(fixture(T + 1000)), /invalid_capture_time/);
  ledger.close(); env.setTime(T - 1000);
  assert.throws(() => env.open(), /ledger_clock_regressed/);
});

test("archive replay never restores a snapshot to a new service's live AI cache", async t => {
  const env = setup(t), ledger = env.open(), receipt = saved(ledger), b = fixture();
  env.setTime(T + 60000);
  assert.ok(ledger.readWithReceipt(receipt.record_id, receipt.read_token));
  const service = createTradeBriefService({ quote: async () => { throw new Error("must not fetch"); },
    history: async () => { throw new Error("must not fetch"); }, macro: async () => [], now: () => T + 60000 });
  let modelCalls = 0;
  const ai = createTradeBriefAiService(id => service.getSnapshot(id), async () => { modelCalls++; return {}; }, () => T + 60000);
  assert.equal(await ai.analyze(b.snapshot_id), null); assert.equal(modelCalls, 0);
});

test("storage failure remains explicit without breaking a live brief", async () => {
  const service = createTradeBriefService({ quote: async () => null, history: async () => null, macro: async () => [], now: () => T },
    () => { throw new Error("private database path must not leak"); });
  const b = await service.analyze(instrument.id, "swing");
  assert.equal(b.archive?.status, "unavailable");
  assert.ok(!JSON.stringify(b.archive).includes("private database"));
  assert.ok(ArchiveReceiptSchema.safeParse(b.archive).success);
});

test("HTTP history route has no listing or writes and requires a strict receipt body", t => {
  const env = setup(t), ledger = env.open(), receipt = saved(ledger);
  const handlers = new Map<string, Function>();
  registerEvidenceLedgerRoutes({ post: (path: string, handler: Function) => handlers.set(path, handler) } as unknown as Express, () => ledger);
  assert.deepEqual([...handlers.keys()], ["/api/trade-brief/history/read"]);
  const run = (body: unknown) => {
    let code = 200, result: any;
    const res: any = { setHeader: () => {}, status: (s: number) => { code = s; return res; }, json: (r: unknown) => { result = r; return res; } };
    handlers.values().next().value!({ body }, res);
    return { code, result };
  };
  assert.equal(run({}).code, 400);
  assert.equal(run({ record_id: receipt.record_id, read_token: receipt.read_token, url: "https://example.com" }).code, 400);
  assert.equal(run({ record_id: receipt.record_id, read_token: "0".repeat(64) }).code, 404);
  const good = run({ record_id: receipt.record_id, read_token: receipt.read_token });
  assert.equal(good.code, 200); assert.equal(good.result.mode, "historical_only");
  assert.equal(JSON.stringify(good.result).includes(receipt.read_token), false);
});
