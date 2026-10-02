import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import {
  EVIDENCE_ACQUISITION_VERSION, EvidenceAcquisitionSchema, reviewEvidenceAcquisition,
  makeEvidenceAcquisition, reuseEvidenceAcquisition,
  type EvidenceAcquisition, type EvidenceAcquisitionContext,
} from "../shared/evidenceAcquisition";
import {
  ArchivedTradeBriefSchema, TRADE_BRIEF_INSTRUMENTS, TradeBriefSchema, tradeBriefExpired,
} from "../shared/tradeBrief";
import { tradeBriefEnvelopes, reviewTradeBriefEvidence } from "../shared/tradeBriefEvidence";
import { buildStockTradeBrief, createTradeBriefService } from "../server/tradeBrief";
import { etEpochMs } from "../server/etTime";

const now = Date.parse("2026-09-30T15:00:30.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const context: EvidenceAcquisitionContext = {
  observed_at: iso(now - 10_000), time_precision: "instant", captured_at: iso(now), now,
};
function acquisition(patch: Partial<EvidenceAcquisition> = {}): unknown {
  return {
    schema_version: EVIDENCE_ACQUISITION_VERSION, read_provenance: "transport_response",
    received_at: iso(now - 2_000), read_at: iso(now - 1_000), ...patch,
  };
}
function review(raw: unknown, patch: Partial<EvidenceAcquisitionContext> = {}) {
  return reviewEvidenceAcquisition(raw, { ...context, ...patch });
}
function assertUnknown(value: ReturnType<typeof review>) {
  assert.equal(value.received_at, null);
  assert.equal(value.first_seen_at, null);
  assert.equal(value.known_at, null);
}

test("instrumented response fixture preserves distinct observation, receipt, adapter read and capture", () => {
  // Fixture represents the successful response-body branch, not a call to a cache-hiding helper.
  const raw = acquisition(), result = review(raw);
  assert.equal(result.status, "accepted");
  assert.equal(result.received_at, iso(now - 2_000));
  assert.equal(result.read_at, iso(now - 1_000));
  assert.equal(result.captured_at, context.captured_at);
  assert.equal(result.read_provenance, "transport_response");
  assert.equal(result.capture_provenance, "snapshot_assembly");
  assert.equal(result.first_seen_at, null);
  assert.equal(result.known_at, null);
  assert.equal(context.observed_at, iso(now - 10_000));
  assert.deepEqual(raw, acquisition());
  assert.deepEqual(result.issues, []);
});

test("instrumented fixture adapter distinguishes actual response, cache hit and failed-fetch stale fallback", async () => {
  // Test-only adapter with an explicit, controllable transport branch. It is NOT schwabFetch.
  let clock = now - 2_000, requests = 0, offline = false;
  let cached: { value: { observed_at: string }; received_at: string } | undefined;
  async function body() {
    requests++;
    if (offline) throw new Error("fixture_transport_unavailable");
    return { observed_at: context.observed_at };
  }
  async function read(useCache: boolean) {
    let read_provenance: EvidenceAcquisition["read_provenance"];
    if (useCache && cached) read_provenance = "cache_hit";
    else {
      try {
        const value = await body();
        cached = { value, received_at: iso(clock) }; // Only the successful transport-body branch stamps receipt.
        read_provenance = "transport_response";
      } catch {
        if (!cached) throw new Error("fixture_no_data");
        read_provenance = "stale_cache_fallback";
      }
    }
    return { value: cached!.value, acquisition: {
      schema_version: EVIDENCE_ACQUISITION_VERSION, read_provenance,
      received_at: cached!.received_at, read_at: iso(clock),
    } };
  }
  const network = await read(false);
  clock = now;
  const hit = await read(true);
  assert.equal(requests, 1);
  offline = true;
  const fallback = await read(false);
  assert.equal(requests, 2);
  for (const result of [network, hit, fallback]) {
    assert.equal(review(result.acquisition).status, "accepted");
    assert.equal(result.value.observed_at, context.observed_at);
    assert.equal(result.acquisition.received_at, iso(now - 2_000));
  }
  assert.equal(network.acquisition.read_provenance, "transport_response");
  assert.equal(hit.acquisition.read_provenance, "cache_hit");
  assert.equal(fallback.acquisition.read_provenance, "stale_cache_fallback");
  assert.equal(fallback.acquisition.read_at, iso(now));
});

test("cache and stale fallback retain an original receipt only when actually supplied; old caches stay null", () => {
  for (const read_provenance of ["cache_hit", "stale_cache_fallback"] as const) {
    const retained = acquisition({ read_provenance, received_at: iso(now - 9_000) });
    const first = review(retained);
    const later = review({ ...retained as object, read_at: iso(now + 20_000) },
      { captured_at: iso(now + 30_000), now: now + 30_000 });
    assert.equal(first.status, "accepted");
    assert.equal(later.status, "accepted");
    assert.equal(later.received_at, first.received_at);
    assert.notEqual(later.read_at, first.read_at);
    assert.equal(later.read_provenance, read_provenance);
    const missing = review(acquisition({ read_provenance, received_at: null }));
    assert.equal(missing.status, "accepted");
    assertUnknown(missing);
  }
});

test("legacy adapter returns and absent annotations do not imply fetches, known-at or first-seen", () => {
  const unknown = review(acquisition({ read_provenance: "unverified_adapter_return", received_at: null }));
  assert.equal(unknown.status, "accepted");
  assert.equal(unknown.read_at, iso(now - 1_000));
  assertUnknown(unknown);
  const absent = review(undefined);
  assert.equal(absent.status, "absent");
  assert.equal(absent.read_at, null);
  assert.equal(absent.read_provenance, null);
  assert.equal(absent.capture_provenance, "snapshot_assembly");
  assertUnknown(absent);
  assert.equal(review(null).status, "rejected");
});

test("strict contract rejects guessed receipts, missing fields, extra timing claims, invalid versions and times", () => {
  const fixtures = [
    null, [], "network", {},
    acquisition({ read_provenance: "unverified_adapter_return" }),
    acquisition({ received_at: null }), // transport_response must supply a measured receipt
    acquisition({ read_at: "2026-09-30" }),
    acquisition({ received_at: "2026-02-30T15:00:00.000Z" }),
    acquisition({ received_at: "not a timestamp" }),
    { ...acquisition() as object, received_at: now - 2_000 },
    { ...acquisition() as object, read_at: undefined },
    { ...acquisition() as object, received_at: undefined },
    { ...acquisition() as object, schema_version: "evidence-acquisition-future" },
    { ...acquisition() as object, first_seen_at: iso(now - 2_000) },
    { ...acquisition() as object, known_at: iso(now - 2_000) },
    { ...acquisition() as object, cache_expires_at: iso(now + 30_000) },
    { ...acquisition() as object, provider_token: "DO_NOT_RETURN" },
    { ...acquisition() as object, read_provenance: "provider_observation" },
  ];
  for (const fixture of fixtures) {
    assert.equal(EvidenceAcquisitionSchema.safeParse(fixture).success, false);
    const result = review(fixture);
    assert.equal(result.status, "rejected");
    assertUnknown(result);
    assert.ok(result.issues.includes("invalid_acquisition"));
    assert.equal(JSON.stringify(result).includes("DO_NOT_RETURN"), false);
  }
});

test("time ordering fails closed without clock-skew allowances or replacement timestamps", () => {
  const fixtures: [unknown, Partial<EvidenceAcquisitionContext>, string][] = [
    [acquisition({ received_at: iso(now) }), {}, "invalid_acquisition"], // receipt after read
    [acquisition({ read_at: iso(now + 1) }), {}, "read_after_capture"],
    [acquisition({ received_at: iso(now - 11_000) }), {}, "observation_after_receipt"],
    [acquisition({ read_provenance: "cache_hit", received_at: null, read_at: iso(now - 11_000) }), {}, "observation_after_read"],
    [acquisition(), { captured_at: iso(now - 20_000) }, "observation_after_capture"],
    [acquisition(), { observed_at: iso(now + 1) }, "future_observation"],
    [acquisition(), { captured_at: iso(now + 1) }, "future_capture"],
    [acquisition({ read_at: iso(now + 1) }), {}, "future_read"],
    [acquisition({ received_at: iso(now + 1), read_at: iso(now + 2) }), {}, "future_receipt"],
  ];
  for (const [raw, c, issue] of fixtures) {
    const result = review(raw, c);
    assert.equal(result.status, "rejected");
    assert.ok(result.issues.includes(issue as typeof result.issues[number]));
    assertUnknown(result);
    assert.equal(result.read_at, null);
  }
  // Exact equality at the measured boundary is allowed; no artificial millisecond shifts.
  assert.equal(review(acquisition({ received_at: context.observed_at, read_at: context.observed_at })).status, "accepted");
});

test("calendar-date and period precision never becomes a release time or point-in-time availability", () => {
  for (const time_precision of ["date", "period"] as const) {
    const result = review(acquisition(), { observed_at: "2026-09-30", time_precision });
    assert.equal(result.status, "accepted");
    assert.equal(result.received_at, iso(now - 2_000));
    assert.equal(result.known_at, null);
    assert.equal(result.first_seen_at, null);
    const impossible = review(acquisition(), { observed_at: "2026-02-30", time_precision });
    assert.equal(impossible.status, "rejected");
    assert.ok(impossible.issues.includes("invalid_observation_time"));
    const future = review(acquisition(), { observed_at: "2026-10-01", time_precision });
    assert.equal(future.status, "rejected");
    assert.ok(future.issues.includes("future_observation"));
    const late = review(acquisition({ received_at: "2026-09-29T23:59:59.999Z" }),
      { observed_at: "2026-09-30", time_precision });
    assert.equal(late.status, "rejected");
    assert.ok(late.issues.includes("observation_after_receipt"));
  }
  assert.equal(review(acquisition(), { observed_at: "2026-09-30" }).status, "rejected");
  assert.equal(review(acquisition(), { observed_at: iso(now), time_precision: "date" }).status, "rejected");
  assert.equal(review(acquisition(), { observed_at: "2026-09-30T11:00:20-04:00" }).status, "accepted");
});

test("malformed or missing capture context is not repaired from receipt or current wall clock", () => {
  for (const patch of [
    { now: NaN }, { now: Infinity }, { now: -1 }, { now: 0.5 },
    { captured_at: "not a date" }, { captured_at: undefined }, { observed_at: "" },
    { captured_at: "2026-02-30T00:00:00.000Z" },
  ]) {
    const result = review(acquisition(), patch);
    assert.equal(result.status, "rejected");
    assertUnknown(result);
    assert.equal(result.captured_at, null);
    assert.deepEqual(result.issues, ["invalid_context"]);
  }
});

const stock = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "AAPL")!;
function quote(age = 10_000) {
  return { AAPL: { symbol: "AAPL", assetMainType: "EQUITY", realtime: true,
    quote: { lastPrice: 105, tradeTime: now - age, quoteTime: now - age, totalVolume: 0 } } };
}
function history() {
  return { symbol: "AAPL", candles: ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24",
    "2026-09-25", "2026-09-28", "2026-09-29"]
    .map(date => ({ datetime: etEpochMs(date, 0, 0), open: 100, high: 110, low: 90, close: 100, volume: 100 })) };
}
const ok = (value: unknown) => ({ state: "ok" as const, value });
const build = (q: unknown = quote(), h: unknown = history()) =>
  buildStockTradeBrief(stock, "swing", { quote: ok(q), history: ok(h), macro: ok([]) }, now);

test("legacy uninstrumented builder inputs and archived snapshots preserve existing schemas and hashes", () => {
  const old = build(), wire = JSON.parse(JSON.stringify(old));
  assert.deepEqual(TradeBriefSchema.parse(wire), old);
  assert.deepEqual(ArchivedTradeBriefSchema.parse(wire), old);
  const frozen = Object.freeze(wire);
  const before = JSON.stringify(frozen), reviewBefore = reviewTradeBriefEvidence(old, now);
  review(acquisition());
  const newer = build();
  assert.equal(newer.snapshot_id, old.snapshot_id);
  assert.equal(newer.brief_id, old.brief_id);
  assert.equal(JSON.stringify(newer), before);
  assert.equal(JSON.stringify(frozen), before);
  assert.deepEqual(reviewTradeBriefEvidence(newer, now), reviewBefore);
  // An old archived calendar/policy version remains decodable without relabelling it as current.
  const archived = JSON.parse(before);
  archived.evidence_review.version = "old-evidence-policy";
  archived.session.schedule.version = "old-calendar";
  const decoded = ArchivedTradeBriefSchema.parse(archived);
  assert.equal(decoded.evidence_review?.version, "old-evidence-policy");
  assert.equal(decoded.session.schedule?.version, "old-calendar");
  assert.equal(TradeBriefSchema.safeParse(archived).success, false);
  for (const row of tradeBriefEnvelopes(old).rows) {
    assert.equal(row.captured_at, old.created_at);
    assert.equal(row.received_at, null);
    assert.equal(row.first_seen_at, null);
    assert.equal(row.known_at, null);
  }
});

test("untrusted annotations inside provider payloads are ignored, never promoted to adapter metadata", () => {
  for (const raw of [quote(), quote(301_000), quote(-1),
    { AAPL: { ...quote().AAPL, realtime: false } },
    { AAPL: { ...quote().AAPL, quote: { ...quote().AAPL.quote, tradeTime: undefined } } }]) {
    const original = build(raw);
    const annotated = build({ ...raw, acquisition: acquisition() }, { ...history(), acquisition: acquisition() });
    assert.deepEqual(annotated, original);
    assert.equal(annotated.mode, "research_only");
    assert.equal(annotated.model_version, "none");
    assert.equal(annotated.risk.planned_loss, null);
    assert.equal(annotated.risk.scenario_reward_risk, null);
  }
  const stale = build(quote(301_000));
  assert.equal(stale.quote, null);
  assert.equal(stale.levels.length, 0);
  assert.equal(stale.verdict, "INSUFFICIENT DATA");
  const soonExpired = build(quote(299_000));
  assert.equal(Date.parse(soonExpired.expires_at), now + 1_000);
  assert.equal(tradeBriefExpired(soonExpired, now + 1_000), true);
  const wrapped = build({ value: quote(), acquisition: acquisition() });
  assert.equal(wrapped.quote, null); // an unadopted proposed wrapper is not a provider payload
  assert.equal(wrapped.verdict, "INSUFFICIENT DATA");
});

test("existing snapshot cache and recent-read reuse preserve null receipts without new reads or restamping", async () => {
  let time = now, quoteCalls = 0, historyCalls = 0;
  const service = createTradeBriefService({
    now: () => time,
    quote: async () => { quoteCalls++; return quote(299_000); },
    history: async () => { historyCalls++; return history(); },
    macro: async () => [],
  });
  const first = await service.analyze(stock.id, "swing");
  const firstJson = JSON.stringify(first);
  time += 500;
  assert.equal(await service.analyze(stock.id, "swing"), first);
  time += 501; // snapshot expired but local successful-read cache has not
  const reused = await service.analyze(stock.id, "swing");
  assert.notEqual(reused.snapshot_id, first.snapshot_id);
  assert.deepEqual([quoteCalls, historyCalls], [1, 1]);
  assert.equal(reused.quote, null);
  assert.equal(reused.verdict, "INSUFFICIENT DATA");
  const rows = tradeBriefEnvelopes(reused).rows;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.received_at, null);
    assert.equal(row.first_seen_at, null);
    assert.equal(row.known_at, null);
    assert.equal(row.captured_at, iso(time));
  }
  assert.equal(rows.find(r => r.evidence_id === "quote-last")?.observed_at, iso(now - 299_000));
  assert.equal(JSON.stringify(first), firstJson);
  assert.ok(Object.isFrozen(first));
  assert.equal(first.evidence.find(e => e.id === "quote-last")?.acquisition?.read_provenance, "unverified_adapter_return");
  assert.equal(reused.evidence.find(e => e.id === "quote-last")?.acquisition?.read_provenance, "brief_read_cache");
});

// Execute the ACTUAL Schwab module with an allowlisted, isolated import boundary.
// Its storage module, environment, OAuth state, quote observer, timers and fetch never load
// from production. No source extraction/copy of the function under test; all branches run.
const schwabCode = transpileModule(readFileSync(new URL("../server/schwab.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
type TransportReply = { status?: number; payload?: unknown; throws?: boolean; badJson?: boolean };
function transportHarness() {
  let clock = now, calls = 0, authorized = true;
  const replies: TransportReply[] = [];
  const exported: Record<string, Function> = {};
  const chain = { from: () => chain, where: () => chain, get: () => authorized ? {
    accessToken: "fixture-not-a-real-token", refreshExpiresAt: now + 86400_000, expiresAt: now + 86400_000,
  } : undefined };
  const sandbox = createContext({
    exports: exported, Buffer, URL, URLSearchParams,
    process: { env: { SCHWAB_CLIENT_ID: "fixture-only", SCHWAB_CLIENT_SECRET: "fixture-only" } },
    Date: class extends Date { static now() { return clock; } },
    console: { warn() {}, log() {}, error() {} },
    setTimeout: (fn: () => void, ms: number) => { clock += ms; queueMicrotask(fn); return 0; },
    require: (name: string) => {
      if (name === "./storage") return { db: { select: () => chain }, schwabTokens: { id: "id" } };
      if (name === "drizzle-orm") return { eq: () => true };
      if (name === "./quoteShield") return { observeQuote() {} };
      if (name === "../shared/evidenceAcquisition") return { makeEvidenceAcquisition };
      if (name === "node:crypto") return { createHash };
      if (name === "node:v8") return { serialize, deserialize };
      throw new Error(`Unapproved fixture import: ${name}`);
    },
    fetch: async (url: string) => {
      assert.ok(url.startsWith("https://api.schwabapi.com/marketdata/"), "OAuth/model/network calls forbidden");
      calls++;
      const reply = replies.shift();
      assert.ok(reply, "Unexpected transport request");
      if (reply.throws) throw new Error("fixture_transport_error");
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300, status, headers: { get: () => null },
        json: async () => { clock += 10; if (reply.badJson) throw new Error("fixture_bad_json"); return reply.payload; },
      };
    },
  });
  runInContext(schwabCode, sandbox);
  return {
    fetch: (path = "marketdata/v1/quotes", params: Record<string, string | number> = { symbols: "AAPL" },
      options?: { skipCache?: boolean; onAcquisition?: (a: EvidenceAcquisition) => void;
        priority?: "interactive"; onBudgetBlocked?: () => void }) =>
      exported.schwabFetch(path, params, options) as Promise<unknown>,
    replies, eval: (script: string) => runInContext(script, sandbox),
    get clock() { return clock; }, set clock(v: number) { clock = v; },
    get calls() { return calls; }, set authorized(v: boolean) { authorized = v; },
  };
}

test("actual transport: successful body receipt, legacy raw outputs, quote/history/options TTL and observer isolation", async () => {
  for (const [path, ttl] of [
    ["marketdata/v1/quotes", 30_000], ["marketdata/v1/pricehistory", 300_000], ["marketdata/v1/chains", 60_000],
  ] as const) {
    const h = transportHarness(), value = { original: path }, captured: EvidenceAcquisition[] = [];
    h.replies.push({ payload: value });
    assert.equal(await h.fetch(path), value); // even a legacy caller records the actual receipt with its cache entry
    const receipt = iso(h.clock);
    h.clock += 100;
    const observer = { onAcquisition: (a: EvidenceAcquisition) => captured.push(a) };
    assert.deepEqual(await h.fetch(path, { symbols: "AAPL" }, observer), value);
    assert.equal(h.calls, 1);
    assert.equal(captured[0].read_provenance, "cache_hit");
    assert.equal(captured[0].received_at, receipt);
    assert.equal(captured[0].read_at, iso(h.clock));
    h.clock = Date.parse(receipt) + ttl;
    const next = { replacement: path };
    h.replies.push({ payload: next });
    assert.deepEqual(await h.fetch(path, { symbols: "AAPL" }, observer), next);
    assert.equal(h.calls, 2);
    assert.equal(captured[1].read_provenance, "transport_response");
    assert.equal(captured[1].received_at, iso(h.clock));
    assert.notEqual(captured[1].received_at, receipt);
    // Observer failures must not cause a transport retry, fallback, or changed raw return.
    assert.deepEqual(await h.fetch(path, { symbols: "AAPL" }, { onAcquisition: () => { throw Error("observer"); } }), next);
    assert.equal(h.calls, 2);
  }
});

test("actual transport: every error fallback retains the original receipt; 401 remains null without metadata", async () => {
  for (const scenario of [
    { reply: { status: 403 }, attempts: 1, cooldown: true },
    { reply: { status: 429 }, attempts: 3, cooldown: true },
    { reply: { status: 500 }, attempts: 3 },
    { reply: { status: 404 }, attempts: 1 },
    { reply: { throws: true }, attempts: 3 },
    { reply: { badJson: true }, attempts: 3 },
    { reply: { status: 401 }, attempts: 1, unavailable: true },
  ]) {
    const h = transportHarness(), original = { original: true }, seen: EvidenceAcquisition[] = [];
    h.replies.push({ payload: original });
    await h.fetch();
    const receipt = iso(h.clock);
    h.clock += 30_001;
    h.replies.push(...Array.from({ length: scenario.attempts }, () => scenario.reply));
    const result = await h.fetch(undefined, undefined, { onAcquisition: a => seen.push(a) });
    assert.equal(h.calls, 1 + scenario.attempts);
    assert.deepEqual(result, scenario.unavailable ? null : original);
    if (scenario.unavailable) assert.equal(seen.length, 0);
    else {
      assert.equal(seen.length, 1);
      assert.equal(seen[0].read_provenance, "stale_cache_fallback");
      assert.equal(seen[0].received_at, receipt);
    }
    if (scenario.cooldown) {
      h.clock += 1;
      assert.deepEqual(await h.fetch(undefined, undefined, { skipCache: true, onAcquisition: a => seen.push(a) }), original);
      assert.equal(h.calls, 1 + scenario.attempts);
      assert.equal(seen[1].read_provenance, "stale_cache_fallback");
      assert.equal(seen[1].received_at, receipt);
    }
  }
});

test("actual transport: self-throttle, empty cooldown, no authentication and old caches never fabricate receipts", async () => {
  const h = transportHarness(), seen: EvidenceAcquisition[] = [];
  h.replies.push({ payload: { original: true } });
  const original = await h.fetch(), receipt = iso(h.clock);
  h.clock += 30_001;
  h.eval("_reqLog.splice(0, _reqLog.length, ...Array(100).fill(Date.now()))");
  assert.deepEqual(await h.fetch(undefined, undefined, { onAcquisition: a => seen.push(a) }), original);
  assert.equal(h.calls, 1);
  assert.equal(seen[0].read_provenance, "stale_cache_fallback");
  assert.equal(seen[0].received_at, receipt);
  assert.equal(await h.fetch(undefined, { symbols: "MSFT" }, { onAcquisition: a => seen.push(a) }), null);
  assert.equal(h.calls, 1);
  h.eval("_cooldown.set('marketdata/v1/quotes', Date.now() + 60000)");
  assert.equal(await h.fetch(undefined, { symbols: "MSFT" }, { onAcquisition: a => seen.push(a) }), null);
  h.authorized = false;
  assert.equal(await h.fetch(undefined, undefined, { onAcquisition: a => seen.push(a) }), null);
  assert.equal(seen.length, 1);
  h.authorized = true;
  // A legacy entry may be valid as raw data but has no recorded original receipt.
  h.eval("_cooldown.clear(); _reqLog.length = 0; _cache.set('marketdata/v1/quotes|symbols=AAPL', {data:{legacy:true},expiresAt:Date.now()+1000})");
  await h.fetch(undefined, undefined, { onAcquisition: a => seen.push(a) });
  assert.equal(seen[1].read_provenance, "cache_hit");
  assert.equal(seen[1].received_at, null);
  h.clock += 1001;
  h.replies.push({ status: 403 });
  await h.fetch(undefined, undefined, { onAcquisition: a => seen.push(a) });
  assert.equal(seen[2].read_provenance, "stale_cache_fallback");
  assert.equal(seen[2].received_at, null);
});

test("actual transport: manual research reservation stays inside the cap and cannot bypass cooldown/auth", async () => {
  const h = transportHarness();
  let blocked = 0;
  h.eval("_reqLog.splice(0, _reqLog.length, ...Array(85).fill(Date.now()))");
  assert.equal(await h.fetch(undefined, { symbols: "BACKGROUND" }, { onBudgetBlocked: () => blocked++ }), null);
  assert.equal(h.calls, 0);
  h.replies.push({ payload: { observed: true } });
  assert.deepEqual(await h.fetch(undefined, { symbols: "INTC" }, { priority: "interactive" }), { observed: true });
  assert.equal(h.calls, 1);
  h.eval("_reqLog.splice(0, _reqLog.length, ...Array(100).fill(Date.now()))");
  assert.equal(await h.fetch(undefined, { symbols: "AAPL" }, { priority: "interactive", onBudgetBlocked: () => blocked++ }), null);
  assert.equal(h.calls, 1); assert.equal(blocked, 2);
  h.eval("_reqLog.length=0; _cooldown.set('marketdata/v1/quotes', Date.now()+60000)");
  assert.equal(await h.fetch(undefined, { symbols: "AAPL" }, { priority: "interactive" }), null);
  h.eval("_cooldown.clear()"); h.authorized = false;
  assert.equal(await h.fetch(undefined, { symbols: "AAPL" }, { priority: "interactive" }), null);
  assert.equal(h.calls, 1);
});

test("actual transport: retries cannot exceed background or interactive capacity", async () => {
  for (const [count, priority] of [[84, undefined], [99, "interactive"]] as const) {
    const h = transportHarness();
    h.eval(`_reqLog.splice(0, _reqLog.length, ...Array(${count}).fill(Date.now()))`);
    h.replies.push({ status: 500 });
    assert.equal(await h.fetch(undefined, { symbols: "NEW" }, { priority }), null);
    assert.equal(h.calls, 1);
    assert.equal(h.eval("_reqLog.length"), count + 1);
  }
});

test("actual transport: minute-history cache-key omission and skip-cache behavior are unchanged", async () => {
  const h = transportHarness(), one = { candles: [1] }, two = { candles: [2] };
  h.replies.push({ payload: one });
  const first = await h.fetch("marketdata/v1/pricehistory", { frequencyType: "minute", endDate: now });
  assert.equal(first, one);
  assert.equal(await h.fetch("marketdata/v1/pricehistory", { frequencyType: "minute", endDate: now + 10_000 }), one);
  assert.equal(h.calls, 1);
  h.replies.push({ payload: two });
  assert.equal(await h.fetch("marketdata/v1/pricehistory", { frequencyType: "minute", endDate: now + 11_000 }, { skipCache: true }), two);
  assert.equal(h.calls, 2);
  h.clock += 20_000;
  h.replies.push({ payload: one });
  assert.equal(await h.fetch("marketdata/v1/pricehistory", { frequencyType: "minute", endDate: h.clock }), one);
  assert.equal(h.calls, 3);
});

test("brief-read-cache provenance retains adapter path/time, rejects regression, and never fills unknown receipts", () => {
  const original = EvidenceAcquisitionSchema.parse(acquisition());
  const reused = reuseEvidenceAcquisition(original, now);
  assert.equal(reused?.read_provenance, "brief_read_cache");
  assert.equal(reused?.received_at, original.received_at);
  assert.equal(reused?.read_at, iso(now));
  assert.equal(review(reused).status, "accepted");
  if (reused?.read_provenance !== "brief_read_cache") assert.fail("Expected service cache provenance");
  assert.equal(reused.adapter_read_provenance, "transport_response");
  assert.equal(reused.adapter_read_at, original.read_at);
  assert.equal(reuseEvidenceAcquisition(original, now - 20_000), undefined);
  assert.equal(makeEvidenceAcquisition("transport_response", null, now), undefined);
  assert.equal(makeEvidenceAcquisition("transport_response", now + 1, now), undefined);
  assert.equal(makeEvidenceAcquisition("transport_response", NaN, now), undefined);
  const unknown = makeEvidenceAcquisition("unverified_adapter_return", null, now - 1000);
  assert.equal(reuseEvidenceAcquisition(unknown, now)?.received_at, null);
  assert.equal(reuseEvidenceAcquisition(null, now), undefined);
  assert.equal(EvidenceAcquisitionSchema.safeParse({ ...reused, received_at: null }).success, false);
  assert.equal(EvidenceAcquisitionSchema.safeParse({ ...reused, adapter_read_provenance: "unverified_adapter_return" }).success, false);
});

test("actual transport: mutable legacy payloads cannot inherit old receipt; opt-in values and callbacks are isolated", async () => {
  const h = transportHarness(), payload = { quote: { lastPrice: 105 } }, seen: EvidenceAcquisition[] = [];
  h.replies.push({ payload });
  const legacy = await h.fetch() as typeof payload, receipt = iso(h.clock);
  assert.equal(legacy, payload); // preserve legacy reference semantics
  const opts = { onAcquisition: (a: EvidenceAcquisition) => { assert.ok(Object.isFrozen(a)); seen.push(a); } };
  const isolated = await h.fetch(undefined, undefined, opts) as typeof payload;
  assert.notEqual(isolated, legacy);
  assert.notEqual(isolated.quote, legacy.quote);
  assert.equal(seen[0].received_at, receipt);
  legacy.quote.lastPrice = 999;
  assert.equal(isolated.quote.lastPrice, 105); // mutation after delivery cannot rewrite stock evidence
  const changed = await h.fetch(undefined, undefined, opts) as typeof payload;
  assert.equal(changed.quote.lastPrice, 999); // no mutation/repair of raw provider-helper output
  assert.equal(seen[1].read_provenance, "cache_hit");
  assert.equal(seen[1].received_at, null); // no original receipt for the changed content
  changed.quote.lastPrice = 7;
  assert.equal(legacy.quote.lastPrice, 999);
  h.clock += 30_001;
  h.replies.push({ status: 403 });
  await h.fetch(undefined, undefined, opts);
  assert.equal(seen[2].read_provenance, "stale_cache_fallback");
  assert.equal(seen[2].received_at, null);
  assert.equal(h.calls, 2);
});

function optionChain() {
  return { symbol: "AAPL", status: "SUCCESS", isDelayed: false,
    underlying: { symbol: "AAPL", quoteTime: now - 20_000 },
    callExpDateMap: { "2026-10-02:2": { "105": [{ symbol: "AAPL  261002C00105000", putCall: "CALL",
      strikePrice: 105, quoteTimeInLong: now - 15_000, bid: 2, ask: 2.1, multiplier: 100, totalVolume: 25 }] } },
    putExpDateMap: {} };
}
function acquiredBrief(metadata: unknown = acquisition(), q: unknown = quote()) {
  return buildStockTradeBrief(stock, "swing", {
    quote: { ...ok(q), acquisition: metadata }, history: { ...ok(history()), acquisition: metadata },
    options: { ...ok(optionChain()), acquisition: metadata },
    macro: ok([{ seriesId: "DGS2", latest: 3.5, latestDate: "2026-09-29" }]),
  }, now);
}

test("optional adapter acquisition is source-bound, independently archived, hashed, and never attached to calculations", () => {
  const b = acquiredBrief();
  const direct = b.evidence.filter(e => ["schwab.quote", "schwab.history", "schwab.options"].includes(e.source_id ?? ""));
  assert.ok(direct.some(e => e.source_id === "schwab.options"));
  assert.ok(direct.some(e => e.source_id === "schwab.history"));
  for (const e of direct) assert.equal(e.acquisition?.received_at, iso(now - 2_000));
  for (const e of b.evidence.filter(e => e.source_id === "batcave.calculation" || e.source_id === "fred.observations")) {
    assert.equal(e.acquisition, undefined);
  }
  const rows = tradeBriefEnvelopes(b).rows;
  assert.equal(rows.find(e => e.evidence_id === "quote-last")?.received_at, iso(now - 2_000));
  assert.equal(rows.find(e => e.evidence_id === "quote-last")?.observed_at, iso(now - 10_000));
  assert.ok(rows.every(e => e.first_seen_at === null && e.known_at === null));
  assert.deepEqual(ArchivedTradeBriefSchema.parse(JSON.parse(JSON.stringify(b))), b);
  const changed = acquiredBrief(acquisition({ received_at: iso(now - 3_000) }));
  assert.notEqual(changed.snapshot_id, b.snapshot_id);
  assert.notEqual(changed.brief_id, b.brief_id);
  assert.equal(changed.expires_at, b.expires_at);
  assert.deepEqual(changed.source_statuses, b.source_statuses);
  assert.deepEqual(changed.evidence_review, b.evidence_review);
  assert.deepEqual(changed.levels, b.levels);
  assert.deepEqual(changed.quote, b.quote);
  assert.equal(changed.verdict, b.verdict);
  assert.equal(changed.mode, "research_only");
  assert.equal(changed.model_version, "none");
});

test("invalid metadata is omitted, not repaired; strict live/archive schemas reject poisoned annotations", () => {
  for (const metadata of [null, {}, acquisition({ read_at: iso(now + 1) }),
    acquisition({ received_at: iso(now - 100_000) }),
    { ...acquisition() as object, known_at: iso(now - 2000) }]) {
    const b = acquiredBrief(metadata);
    // Validate per datum: a receipt too early for this quote may still be valid for older history.
    assert.equal(b.evidence.find(e => e.id === "quote-last")?.acquisition, undefined);
    assert.equal(tradeBriefEnvelopes(b).rows.find(e => e.evidence_id === "quote-last")?.received_at, null);
    const poisoned = JSON.parse(JSON.stringify(acquiredBrief()));
    poisoned.evidence.find((e: { id: string }) => e.id === "quote-last").acquisition = metadata;
    assert.equal(TradeBriefSchema.safeParse(poisoned).success, false);
    assert.equal(ArchivedTradeBriefSchema.safeParse(poisoned).success, false);
    assert.equal(tradeBriefEnvelopes(poisoned).rows.find(e => e.evidence_id === "quote-last")?.received_at, null);
  }
  const unsupported = JSON.parse(JSON.stringify(acquiredBrief()));
  unsupported.evidence.find((e: { source_id: string }) => e.source_id === "fred.observations").acquisition = acquisition();
  assert.equal(TradeBriefSchema.safeParse(unsupported).success, false);
});

test("receipt metadata never refreshes stale/future/delayed/missing quotes or original source deadlines", () => {
  const freshReceipt = acquisition({ received_at: iso(now), read_at: iso(now) });
  for (const q of [quote(301_000), quote(-1), { AAPL: { ...quote().AAPL, realtime: false } },
    { AAPL: { ...quote().AAPL, quote: { ...quote().AAPL.quote, tradeTime: undefined } } }]) {
    const b = acquiredBrief(freshReceipt, q);
    assert.equal(b.verdict, "INSUFFICIENT DATA");
    assert.equal(b.quote, null);
    assert.equal(b.levels.length, 0);
    assert.equal(b.risk.planned_loss, null);
    assert.equal(b.model_version, "none");
  }
  const b = acquiredBrief(freshReceipt, quote(299_000));
  assert.equal(Date.parse(b.expires_at), now + 1_000);
  assert.equal(tradeBriefExpired(b, now + 1_000), true);
  assert.equal(b.evidence.find(e => e.id === "quote-last")?.observed_at, iso(now - 299_000));
});

test("actual transport to stock-service integration preserves original receipt through snapshot and read-cache reuse", async () => {
  const h = transportHarness();
  h.replies.push({ payload: quote(299_000) }, { payload: history() });
  const service = createTradeBriefService({
    now: () => h.clock,
    quote: (symbol, onAcquisition) => h.fetch("marketdata/v1/quotes", { symbols: symbol }, { onAcquisition }),
    history: (symbol, onAcquisition) => h.fetch("marketdata/v1/pricehistory", { symbol }, { onAcquisition }),
    macro: async () => [],
  });
  const first = await service.analyze(stock.id, "swing"), originalJson = JSON.stringify(first);
  const original = first.evidence.find(e => e.id === "quote-last")!.acquisition!;
  assert.equal(original.read_provenance, "transport_response");
  assert.ok(original.received_at !== null);
  assert.equal(await service.analyze(stock.id, "swing"), first);
  h.clock = now + 1001; // expire snapshot, not the source-read cache
  const next = await service.analyze(stock.id, "swing");
  assert.equal(h.calls, 2);
  assert.equal(next.quote, null);
  assert.equal(next.verdict, "INSUFFICIENT DATA");
  const reused = next.evidence.find(e => e.id === "quote-last")!.acquisition!;
  assert.equal(reused.read_provenance, "brief_read_cache");
  assert.equal(reused.received_at, original.received_at);
  assert.equal(reused.read_at, iso(h.clock));
  if (reused.read_provenance !== "brief_read_cache") assert.fail("Expected service cache provenance");
  assert.equal(reused.adapter_read_at, original.read_at);
  assert.equal(reused.adapter_read_provenance, "transport_response");
  assert.equal(tradeBriefEnvelopes(next).rows.find(e => e.evidence_id === "quote-last")?.received_at, original.received_at);
  assert.equal(JSON.stringify(first), originalJson);
  assert.ok(Object.isFrozen(first.evidence[0].acquisition));
});

test("callback annotations are copied on arrival and malformed producer callbacks cannot invent a receipt", async () => {
  for (const bad of [false, true]) {
    const metadata = acquisition() as Record<string, unknown>;
    if (bad) metadata.known_at = iso(now);
    const service = createTradeBriefService({
      now: () => now,
      quote: async (_symbol, observer) => {
        observer?.(metadata as EvidenceAcquisition);
        metadata.received_at = iso(now); // later producer mutation does not rewrite the callback copy
        return quote();
      }, history: async () => history(), macro: async () => [],
    });
    const b = await service.analyze(stock.id, "swing");
    const q = b.evidence.find(e => e.id === "quote-last")!;
    assert.equal(q.acquisition?.received_at, bad ? undefined : iso(now - 2_000));
    assert.equal(tradeBriefEnvelopes(b).rows.find(e => e.evidence_id === "quote-last")?.received_at, bad ? null : iso(now - 2_000));
  }
});

test("completed-read cache owns a nested payload copy, including originally stale-fallback receipts", async () => {
  for (const read_provenance of ["transport_response", "stale_cache_fallback"] as const) {
    let time = now, calls = 0;
    const raw = quote(299_000), rawHistory = history();
    const metadata = EvidenceAcquisitionSchema.parse(acquisition({ read_provenance }));
    const service = createTradeBriefService({
      now: () => time,
      quote: async (_symbol, observer) => { calls++; observer?.(metadata); return raw; },
      history: async () => rawHistory, macro: async () => [],
    });
    const first = await service.analyze(stock.id, "swing"), firstJson = JSON.stringify(first);
    // Simulate a retained dependency reference being edited after a successful read.
    raw.AAPL.quote.lastPrice = 999;
    raw.AAPL.quote.tradeTime = now + 500;
    raw.AAPL.quote.quoteTime = now + 500;
    rawHistory.candles[0].high = 1;
    time += 1001;
    const next = await service.analyze(stock.id, "swing");
    assert.equal(calls, 1);
    assert.equal(next.quote, null); // changed nested raw timestamps cannot promote stale cached data
    assert.equal(next.verdict, "INSUFFICIENT DATA");
    const e = next.evidence.find(e => e.id === "quote-last")!;
    assert.equal(e.value, 105);
    assert.equal(e.observed_at, iso(now - 299_000));
    assert.equal(e.acquisition?.received_at, metadata.received_at);
    assert.equal(e.acquisition?.read_provenance, "brief_read_cache");
    if (e.acquisition?.read_provenance !== "brief_read_cache") assert.fail("Expected read-cache provenance");
    assert.equal(e.acquisition.adapter_read_provenance, read_provenance);
    assert.equal(JSON.stringify(first), firstJson);
  }
});

test("actual transport: successful retries and bounded throttle-wait stamp only the successful parsed response", async () => {
  const h = transportHarness(), seen: EvidenceAcquisition[] = [];
  h.replies.push({ status: 503 }, { status: 429 }, { payload: quote() });
  await h.fetch(undefined, undefined, { onAcquisition: a => seen.push(a) });
  assert.equal(h.calls, 3);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].read_provenance, "transport_response");
  assert.equal(seen[0].received_at, iso(h.clock));
  assert.ok(h.clock > now);
  const waiting = transportHarness(), waited: EvidenceAcquisition[] = [];
  waiting.eval("_reqLog.splice(0, _reqLog.length, ...Array(100).fill(Date.now()-59000))");
  waiting.replies.push({ payload: quote() });
  await waiting.fetch(undefined, undefined, { onAcquisition: a => waited.push(a) });
  assert.equal(waiting.calls, 1);
  assert.equal(waited[0].received_at, iso(waiting.clock));
  assert.ok(waiting.clock > now + 1000);
});
