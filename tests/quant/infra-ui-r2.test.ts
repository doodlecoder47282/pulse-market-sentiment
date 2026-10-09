// R2-G tests: security, storage, engineering quality, client UI honesty.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/infra-ui-r2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDataState,
  describeDataState,
  formatAge,
  classifyAge,
  ageFromAsOf,
  effectiveDataState,
} from "../../shared/dataState";
import { ofiApiPayload, type OfiTrendLike } from "../../server/ofiPayload";

// ─── Item 7: data-state vocabulary ─────────────────────────────────────────

test("dataState: known states keep their meaning; unknown/empty fail closed", () => {
  assert.equal(normalizeDataState("ok"), "ok");
  assert.equal(normalizeDataState("partial"), "partial");
  assert.equal(normalizeDataState("no_spot"), "no_spot");
  assert.equal(normalizeDataState("no-data"), "no_data");
  assert.equal(normalizeDataState("live"), "ok");
  // Fail closed: nothing unknown is ever "ok".
  assert.equal(normalizeDataState(undefined), "unavailable");
  assert.equal(normalizeDataState(""), "unavailable");
  assert.equal(normalizeDataState("weird"), "unavailable");
  assert.equal(describeDataState("weird").label, "unknown state");
  assert.equal(describeDataState("weird").tone, "bad");
});

test("dataState: failed, missing, stale, partial and observed-zero are distinct", () => {
  const views = ["failed", "unavailable", "stale", "partial", "observed_zero", "no_data", "no_spot"].map((s) => describeDataState(s));
  const labels = new Set(views.map((v) => v.label));
  assert.equal(labels.size, views.length, "every state has its own label");
  for (const v of views) assert.notEqual(v.label, "ok");
  // Only observed_zero and partial may still be read; failures block the signal.
  assert.equal(describeDataState("observed_zero").blocksSignal, false);
  assert.equal(describeDataState("observed_zero").tone, "neutral");
  assert.equal(describeDataState("unavailable").blocksSignal, true);
  assert.equal(describeDataState("failed").blocksSignal, true);
  assert.equal(describeDataState("stale").blocksSignal, true);
  assert.match(describeDataState("unavailable", "Schwab 503").title, /Reason: Schwab 503/);
});

test("dataState: age formatting never turns unknown into 0s", () => {
  assert.equal(formatAge(null), "age unknown");
  assert.equal(formatAge(NaN), "age unknown");
  assert.equal(formatAge(-5), "~0s");
  assert.equal(formatAge(0), "0s");
  assert.equal(formatAge(59_999), "59s");
  assert.equal(formatAge(60_000), "1m");
  assert.equal(formatAge(3_600_000 + 5 * 60_000), "1h 05m");
  assert.equal(formatAge(26 * 3_600_000), "1d 2h");
});

test("dataState: age classification and as-of parsing (ms, s, ISO)", () => {
  const now = Date.UTC(2026, 9, 8, 15, 0, 0);
  assert.equal(ageFromAsOf(now - 30_000, now), 30_000);
  assert.equal(ageFromAsOf((now - 30_000) / 1000, now), 30_000); // epoch seconds
  assert.equal(ageFromAsOf(new Date(now - 90_000).toISOString(), now), 90_000);
  assert.equal(ageFromAsOf("not a date", now), null);
  assert.equal(ageFromAsOf(0, now), null);
  assert.equal(classifyAge(60_000, 60_000), "fresh");
  assert.equal(classifyAge(60_001, 60_000), "stale");
  assert.equal(classifyAge(null, 60_000), "unknown");
  assert.equal(classifyAge(10, null), "unknown");
  // Age only ever downgrades: ok -> stale, but unavailable never becomes ok.
  assert.equal(effectiveDataState("ok", 120_000, 60_000), "stale");
  assert.equal(effectiveDataState("partial", 120_000, 60_000), "stale");
  assert.equal(effectiveDataState("ok", 10_000, 60_000), "ok");
  assert.equal(effectiveDataState("unavailable", 10, 60_000), "unavailable");
});

// ─── Item 7: /api/ofi payload ───────────────────────────────────────────────

function bars(n: number, missingIdx: number[] = [], t0 = 1_760_000_000_000) {
  let cum = 0;
  return Array.from({ length: n }, (_, i) => {
    const missing = missingIdx.includes(i);
    const sv = missing ? 0 : (i % 2 === 0 ? 100 : -40);
    cum += sv;
    return { ts: t0 + i * 60_000, signedVolume: sv, cumulative: cum, ...(missing ? { volumeMissing: true } : {}) };
  });
}
function trend(b: ReturnType<typeof bars>, dataState: OfiTrendLike["dataState"]): OfiTrendLike {
  return {
    bars: b, cumulativeNow: b.length ? b[b.length - 1].cumulative : 0, slope15m: 0, slope5m: 0,
    trend: "BULLISH", acceleration: "FLAT", dataState,
    volumeMissingBars: b.filter((x) => (x as any).volumeMissing).length,
  };
}

test("ofi payload: complete tape passes dataState ok and a complete trend", () => {
  const b = bars(30);
  const p = ofiApiPayload(trend(b, "ok"), b[29].ts + 5_000);
  assert.equal(p.dataState, "ok");
  assert.equal(p.dataStateReason, null);
  assert.equal(p.trendComplete, true);
  assert.equal(p.bars.length, 30);
  assert.equal(p.asOfMs, b[29].ts, "asOf is the data time of the last bar");
  assert.ok(p.bars.every((x) => x.volumeMissing === false && typeof x.signedVolume === "number"));
});

test("ofi payload: missing-volume bars are gaps (null), not zero, and withhold the trend", () => {
  const b = bars(30, [27]); // inside the last-15 window
  const p = ofiApiPayload(trend(b, "partial"), Date.now());
  assert.equal(p.dataState, "partial");
  assert.match(p.dataStateReason ?? "", /1 of 30 minute bars arrived without volume/);
  const gap = p.bars[27];
  assert.equal(gap.volumeMissing, true);
  assert.equal(gap.signedVolume, null);
  assert.equal(p.trendWindowMissingBars, 1);
  assert.equal(p.trendComplete, false);
  // A gap outside the 15-bar window keeps the trend readable (state still partial).
  const early = ofiApiPayload(trend(bars(30, [2]), "partial"), Date.now());
  assert.equal(early.trendWindowMissingBars, 0);
  assert.equal(early.trendComplete, true);
  assert.equal(early.dataState, "partial");
});

test("ofi payload: unavailable says why and is never a flat read", () => {
  const none = ofiApiPayload(trend([], "unavailable"), Date.now());
  assert.equal(none.dataState, "unavailable");
  assert.match(none.dataStateReason ?? "", /could not be fetched/);
  assert.equal(none.trendComplete, false);
  assert.equal(none.asOfMs, null);
  const allMissing = bars(20, Array.from({ length: 20 }, (_, i) => i));
  const p = ofiApiPayload(trend(allMissing, "unavailable"), Date.now());
  assert.match(p.dataStateReason ?? "", /every SPY minute bar arrived without volume/);
  assert.ok(p.bars.every((x) => x.signedVolume === null));
});

test("ofi payload: fewer than 15 bars is not a 15-minute slope", () => {
  const p = ofiApiPayload(trend(bars(10), "ok"), Date.now());
  assert.equal(p.trendComplete, false);
  assert.equal(p.totalBars, 10);
});

// ─── Item 1 (11.5): Schwab tokens encrypted at rest ─────────────────────────
import {
  parseTokenKey,
  tokenKeyPolicy,
  tokenKeyWarnings,
  gcmSeal,
  encryptValue,
  decryptValue,
  tokenAad,
  decodeStoredRow,
  encodeRowForStorage,
  isEncryptedValue,
  type TokenRow,
} from "../../server/tokenCrypto";

// Test-only keys: fixed filler bytes, not secrets, never used outside this file.
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const TEST_KEY2_B64 = Buffer.alloc(32, 9).toString("base64");
const LOCAL = { HOST: "127.0.0.1" };
const PUBLIC = { RAILWAY_ENVIRONMENT: "production" }; // binds 0.0.0.0

test("tokens: AES-256-GCM known answer (McGrew-Viega GCM spec, Test Case 16)", () => {
  const key = Buffer.from("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308", "hex");
  const iv = Buffer.from("cafebabefacedbaddecaf888", "hex");
  const aad = Buffer.from("feedfacedeadbeeffeedfacedeadbeefabaddad2", "hex");
  const pt = Buffer.from(
    "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
    "hex",
  );
  const { ct, tag } = gcmSeal(pt, key, aad, iv);
  assert.equal(
    ct.toString("hex"),
    "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
  );
  assert.equal(tag.toString("hex"), "76fc6ece0f4e1768cddf8853bb2d551b");
});

test("tokens: key parsing is strict (32 bytes, base64 or base64url) and never echoes the key", () => {
  assert.equal(parseTokenKey(TEST_KEY_B64).ok, true);
  assert.equal(parseTokenKey(TEST_KEY_B64.replace(/\+/g, "-").replace(/\//g, "_")).ok, true);
  assert.deepEqual(parseTokenKey(""), { ok: false, reason: "missing" });
  assert.equal((parseTokenKey("not base64!!") as any).reason, "invalid_base64");
  const short = parseTokenKey(Buffer.alloc(16, 1).toString("base64"));
  assert.equal((short as any).reason, "wrong_length");
  assert.equal((short as any).bytes, 16);
  const w = tokenKeyWarnings({ ...PUBLIC, BATCAVE_TOKEN_KEY: Buffer.alloc(16, 1).toString("base64") });
  assert.ok(w.length > 0 && w.every((m) => !m.includes(Buffer.alloc(16, 1).toString("base64"))));
});

test("tokens: policy fails closed on a reachable bind without a key; local stays usable", () => {
  assert.equal(tokenKeyPolicy({ ...LOCAL }).mode, "plaintext-local");
  assert.equal(tokenKeyPolicy({ ...PUBLIC }).mode, "locked");
  assert.equal(tokenKeyPolicy({ HOST: "0.0.0.0" }).mode, "locked");
  assert.equal(tokenKeyPolicy({ ...PUBLIC, BATCAVE_TOKEN_KEY: TEST_KEY_B64 }).mode, "encrypted");
  // A malformed key never silently downgrades to plaintext, even locally.
  assert.equal(tokenKeyPolicy({ ...LOCAL, BATCAVE_TOKEN_KEY: "abc" }).mode, "locked");
  assert.match(tokenKeyPolicy({ ...PUBLIC }).reason ?? "", /BATCAVE_TOKEN_KEY not set/);
});

test("tokens: encrypt/decrypt round trip; random IV; AAD binds row and column; tamper fails", () => {
  const key = parseTokenKey(TEST_KEY_B64) as { ok: true; key: Buffer };
  const aad = tokenAad(1, "access_token");
  const a = encryptValue("ACCESS-123", key.key, aad);
  const b = encryptValue("ACCESS-123", key.key, aad);
  assert.ok(isEncryptedValue(a));
  assert.notEqual(a, b, "fresh IV per encryption");
  assert.ok(!a.includes("ACCESS-123"));
  assert.equal(decryptValue(a, key.key, aad), "ACCESS-123");
  assert.throws(() => decryptValue(a, key.key, tokenAad(1, "refresh_token")), /token_decrypt_failed/);
  assert.throws(() => decryptValue(a, key.key, tokenAad(2, "access_token")), /token_decrypt_failed/);
  const wrong = parseTokenKey(TEST_KEY2_B64) as { ok: true; key: Buffer };
  assert.throws(() => decryptValue(a, wrong.key, aad), /token_decrypt_failed/);
  const parts = a.split(":");
  const ct = Buffer.from(parts[4], "base64");
  ct[0] ^= 1;
  const tampered = [...parts.slice(0, 4), ct.toString("base64")].join(":");
  assert.throws(() => decryptValue(tampered, key.key, aad), /token_decrypt_failed/);
});

const plainRow: TokenRow = { id: 1, accessToken: "acc-plain", refreshToken: "ref-plain", expiresAt: 111, refreshExpiresAt: 222, updatedAt: 333 };

test("tokens: legacy plaintext row migrates transparently on first read", () => {
  const pol = tokenKeyPolicy({ ...PUBLIC, BATCAVE_TOKEN_KEY: TEST_KEY_B64 });
  const r = decodeStoredRow(plainRow, pol);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.row.accessToken, "acc-plain");
  assert.equal(r.row.refreshToken, "ref-plain");
  assert.ok(r.rewrite, "plaintext row is scheduled for re-encryption");
  const stored = r.rewrite!;
  assert.ok(isEncryptedValue(stored.accessToken) && isEncryptedValue(stored.refreshToken));
  assert.equal(stored.expiresAt, 111);
  assert.equal(stored.refreshExpiresAt, 222);
  // Second read: already encrypted, no rewrite, same tokens.
  const r2 = decodeStoredRow(stored, pol);
  assert.equal(r2.status, "ok");
  if (r2.status === "ok") {
    assert.equal(r2.rewrite, null);
    assert.equal(r2.row.accessToken, "acc-plain");
  }
});

test("tokens: swapped ciphertexts, wrong key, missing key and rotation", () => {
  const pol = tokenKeyPolicy({ ...PUBLIC, BATCAVE_TOKEN_KEY: TEST_KEY_B64 });
  const enc = encodeRowForStorage(plainRow, pol);
  const swapped = { ...enc, accessToken: enc.refreshToken, refreshToken: enc.accessToken };
  assert.equal(decodeStoredRow(swapped, pol).status, "decrypt_failed");
  const otherKey = tokenKeyPolicy({ ...PUBLIC, BATCAVE_TOKEN_KEY: TEST_KEY2_B64 });
  const bad = decodeStoredRow(enc, otherKey);
  assert.equal(bad.status, "decrypt_failed");
  if (bad.status === "decrypt_failed") assert.ok(!bad.reason.includes("acc-plain"));
  // Encrypted row but no key locally: locked, not handed out as gibberish.
  assert.equal(decodeStoredRow(enc, tokenKeyPolicy({ ...LOCAL })).status, "locked");
  // Public bind without key: even a plaintext row is not read.
  assert.equal(decodeStoredRow(plainRow, tokenKeyPolicy({ ...PUBLIC })).status, "locked");
  assert.throws(() => encodeRowForStorage(plainRow, tokenKeyPolicy({ ...PUBLIC })), /token_store_locked/);
  // Rotation: old key as PREVIOUS decrypts and schedules re-encryption under the new key.
  const rotated = tokenKeyPolicy({ ...PUBLIC, BATCAVE_TOKEN_KEY: TEST_KEY2_B64, BATCAVE_TOKEN_KEY_PREVIOUS: TEST_KEY_B64 });
  const r = decodeStoredRow(enc, rotated);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.row.refreshToken, "ref-plain");
    assert.ok(r.rewrite);
    assert.equal(decodeStoredRow(r.rewrite!, otherKey).status, "ok");
  }
});

test("tokens: local plaintext mode keeps previous behaviour (no rewrite, no encryption)", () => {
  const pol = tokenKeyPolicy({ ...LOCAL });
  const r = decodeStoredRow(plainRow, pol);
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.rewrite, null);
  assert.equal(encodeRowForStorage(plainRow, pol).accessToken, "acc-plain");
});

// ─── Item 3: trust proxy only behind a known platform proxy ─────────────────
import { trustProxyHops } from "../../server/accessGate";

test("trust proxy: 1 hop on Railway/Render/Fly, 0 locally, explicit override bounded", () => {
  assert.equal(trustProxyHops({}), 0);
  assert.equal(trustProxyHops({ HOST: "0.0.0.0" }), 0, "a reachable bind alone is not evidence of a proxy");
  assert.equal(trustProxyHops({ RAILWAY_ENVIRONMENT: "production" }), 1);
  assert.equal(trustProxyHops({ RENDER: "true" }), 1);
  assert.equal(trustProxyHops({ FLY_APP_NAME: "batcave" }), 1);
  assert.equal(trustProxyHops({ RAILWAY_ENVIRONMENT: "production", BATCAVE_TRUST_PROXY_HOPS: "0" }), 0);
  assert.equal(trustProxyHops({ BATCAVE_TRUST_PROXY_HOPS: "2" }), 2);
  assert.equal(trustProxyHops({ RAILWAY_ENVIRONMENT: "x", BATCAVE_TRUST_PROXY_HOPS: "true" }), 0, "malformed trusts nothing");
  assert.equal(trustProxyHops({ BATCAVE_TRUST_PROXY_HOPS: "99" }), 0);
});

test("trust proxy: index.ts never sets trust proxy to true", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
  assert.ok(!/set\(\s*["']trust proxy["']\s*,\s*true/.test(src));
  assert.match(src, /app\.set\("trust proxy", TRUST_PROXY_HOPS\)/);
});

// ─── Item 2 (11.7): runtime files untracked and created when missing ────────
import { ensureParentDir, dataFilePath, schedulerStatePath } from "../../server/dbPath";

test("runtime files: data dir and state path are created/resolved on a fresh checkout", async () => {
  const { mkdtempSync, existsSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "batcave-r2g-"));
  try {
    const p = dataFilePath("greek_gradient.db", root);
    assert.equal(p, path.join(root, "data", "greek_gradient.db"));
    assert.ok(existsSync(path.join(root, "data")), "data/ created before SQLite opens the file");
    const nested = ensureParentDir(path.join(root, "a", "b", "state.json"));
    writeFileSync(nested, "{}");
    assert.ok(existsSync(nested));
    assert.equal(schedulerStatePath({}, root), path.join(root, ".discord-scheduler-state.json"));
    assert.equal(schedulerStatePath({ BATCAVE_SCHEDULER_STATE_PATH: "var/s.json" }, root), path.join(root, "var", "s.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime files: not tracked by git and ignored", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const cwd = new URL("../..", import.meta.url).pathname;
  const files = ["data/greek_gradient.db", "data/greek_gradient.db-wal", "data/greek_gradient.db-shm", ".discord-scheduler-state.json"];
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "--", ...files], { cwd, encoding: "utf8" }).trim();
  } catch {
    return; // not a git checkout (e.g. a tarball): nothing to check
  }
  assert.equal(tracked, "", `still tracked: ${tracked}`);
  const gi = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
  for (const f of files) assert.ok(gi.split(/\r?\n/).includes(f), `${f} in .gitignore`);
  const sched = readFileSync(new URL("../../server/discordScheduler.ts", import.meta.url), "utf8");
  assert.ok(!sched.includes("/home/user/workspace"), "no hard-coded sandbox path");
});

// ─── Items 9-10: no trade instruction in the skill banner; heuristic scores
// are not displayed as percentages/probabilities in the swept files ────────
test("wording: MLAccuracyCard banner reports the test, not an abstention or a trade instruction", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../client/src/components/models/MLAccuracyCard.tsx", import.meta.url), "utf8");
  assert.ok(!/model abstaining/i.test(src));
  assert.ok(!/fade or ignore/i.test(src));
  assert.ok(!/Position size from your own thesis/i.test(src));
  assert.match(src, /significantly worse than the base rate/);
});

test("wording: swept panels show heuristic scores as /100 or % wt, never as a bare % confidence/probability", async () => {
  const { readFileSync } = await import("node:fs");
  const swept = [
    "TradeDesk.tsx", "DailyPlaybookChart.tsx", "AlphaNewsOverlay.tsx", "models/PivotProjection.tsx",
    "edgelab/EdgeBriefing.tsx", "edgelab/EdgeBrief.tsx", "TickerOutlookCard.tsx", "edgelab/CrossAssetPanel.tsx",
  ];
  const bad = /\{[^}]*(confidence|probability|\.prob\b|\bprob)[^}]*\}%(?! wt)|% conf\b|conf \{|high-confidence/;
  for (const f of swept) {
    const src = readFileSync(new URL(`../../client/src/components/${f}`, import.meta.url), "utf8");
    // style widths (`${prob}%`) are layout, not labels.
    const hits = src.split("\n").filter((l) => bad.test(l) && !l.trim().startsWith("//") && !/width|style=/.test(l));
    assert.deepEqual(hits, [], `${f}: ${hits.join(" | ")}`);
  }
  const pb = readFileSync(new URL("../../server/playbook.ts", import.meta.url), "utf8");
  assert.ok(!/probability \$\{squeeze\.probability\}%/.test(pb));
  assert.ok(!/\$\{squeeze\.probability\}% conviction/.test(pb));
});

// ─── Item 5 (11.3): in-process engine calls ─────────────────────────────────
import {
  internalRoute,
  callInternal,
  internalJson,
  internalFetch,
  isInternalRoute,
  _resetInternalRoutes,
} from "../../server/internalApi";

test("internal api: handler gets the parsed query and its JSON body comes back as on the wire", async () => {
  _resetInternalRoutes();
  const cached = { spot: 6000, nan: NaN, when: new Date(0), nested: { a: 1 } };
  let seen: any = null;
  internalRoute("/api/heatseeker", async (req: any, res: any) => {
    seen = req.query;
    res.json(cached);
  });
  const r = await callInternal("/api/heatseeker?symbol=$SPX&expiry=2026-10-09");
  assert.deepEqual(seen, { symbol: "$SPX", expiry: "2026-10-09" });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  // Wire semantics: NaN -> null, Date -> ISO string.
  assert.equal(r.body.nan, null);
  assert.equal(r.body.when, "1970-01-01T00:00:00.000Z");
  // Isolation: mutating the result never touches the route's cached object.
  r.body.nested.a = 99;
  assert.equal(cached.nested.a, 1);
});

test("internal api: status codes and error bodies are preserved; internalJson maps non-2xx to null", async () => {
  _resetInternalRoutes();
  internalRoute("/api/models", async (_req: any, res: any) => { res.status(503).json({ message: "Failed to build models" }); });
  const r = await callInternal("/api/models?symbol=^GSPC&experimental=1");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.body.message, "Failed to build models");
  assert.equal(await internalJson("/api/models?symbol=SPX"), null);
  const resp = await internalFetch("/api/models");
  assert.equal(resp.ok, false);
  assert.equal(resp.status, 503);
  assert.equal((await resp.json()).message, "Failed to build models");
});

test("internal api: thrown handler is a 500 with message; unregistered allow-listed route is 503, never HTTP", async () => {
  _resetInternalRoutes();
  internalRoute("/api/quotes", async () => { throw new Error("schwab down"); });
  const r = await callInternal("/api/quotes");
  assert.equal(r.status, 500);
  assert.equal(r.body.message, "schwab down");
  const missing = await callInternal("/api/odte-tracker");
  assert.equal(missing.status, 503);
  assert.equal(missing.error, "internal_route_not_registered");
  assert.equal(isInternalRoute("/api/models?symbol=SPX"), true);
  assert.equal(isInternalRoute("/api/news"), false);
});

test("internal api: timeout behaves like an aborted fetch; sync handlers work", async () => {
  _resetInternalRoutes();
  internalRoute("/api/models", () => new Promise<void>(() => { /* never responds */ }));
  const r = await callInternal("/api/models", { timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout");
  await assert.rejects(internalFetch("/api/models", { timeoutMs: 20 }), (e: any) => e.name === "TimeoutError");
  internalRoute("/api/odte-tracker", (_req: any, res: any) => { res.json({ contracts: [] }); });
  assert.deepEqual(await internalJson("/api/odte-tracker"), { contracts: [] });
  // A handler that resolves without responding is reported, not left hanging.
  internalRoute("/api/quotes", async () => {});
  const nr = await callInternal("/api/quotes");
  assert.equal(nr.error, "no_response");
  _resetInternalRoutes();
});

test("internal api: every allow-listed route is registered in routes.ts; converted engines have no local-HTTP hop", async () => {
  const { readFileSync } = await import("node:fs");
  const { INTERNAL_ROUTES } = await import("../../server/internalApi");
  const read = (f: string) => readFileSync(new URL(`../../server/${f}`, import.meta.url), "utf8");
  const routes = read("routes.ts");
  for (const p of INTERNAL_ROUTES) {
    assert.ok(routes.includes(`app.get("${p}", internalRoute("${p}",`), `${p} registered`);
  }
  for (const f of ["tradeEnvironment.ts", "exitBrain.ts"]) {
    assert.ok(!/127\.0\.0\.1/.test(read(f)), `${f} still calls local HTTP`);
  }
  // In routes.ts the only remaining self-calls to these endpoints are in
  // /api/experimental/bl-pdf (R2-A is rewriting that block for Schwab-only data).
  const selfCalls = routes.split("\n").filter((l) => /127\.0\.0\.1:\$\{\w+\}\/api\/(models|heatseeker|quotes|odte-tracker)/.test(l));
  assert.ok(selfCalls.length <= 2, selfCalls.join("\n"));
});

test("ofi: trend-window completeness rule shared by the panel payload and the trade-environment driver", async () => {
  const { ofiTrendWindowComplete } = await import("../../server/ofiPayload");
  assert.equal(ofiTrendWindowComplete(bars(15)), true);
  assert.equal(ofiTrendWindowComplete(bars(14)), false);
  assert.equal(ofiTrendWindowComplete(bars(30, [29])), false);
  assert.equal(ofiTrendWindowComplete(bars(30, [0])), true);
  const { readFileSync } = await import("node:fs");
  const te = readFileSync(new URL("../../server/tradeEnvironment.ts", import.meta.url), "utf8");
  assert.match(te, /ofiTrendWindowComplete\(ofi\.bars\)/);
});
