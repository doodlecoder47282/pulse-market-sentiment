// WS5 tests: honest labels, Cosmos, UI wording, server security.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/labels-security.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(name)) out.push(p);
  }
  return out;
}

// ─── F11.1 webhooks come from the environment only ─────────────────────────

test("F11.1: no Discord webhook URL is hard-coded in server, client, shared or docs", () => {
  const files = [
    ...walk(path.join(ROOT, "server")),
    ...walk(path.join(ROOT, "client")),
    ...walk(path.join(ROOT, "shared")),
    ...walk(path.join(ROOT, "docs")),
  ];
  // Pattern assembled at runtime so this test file never contains one.
  const re = new RegExp(["discord", "(app)?\\.com/api/", "webhooks/\\d+/"].join(""));
  const hits = files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test("F11.1: webhook resolution is env-only, blank = disabled, UOA falls back to whale", async () => {
  const { resolveDiscordWebhook, webhookFromEnv } = await import("../../server/webhookConfig.ts");
  const url = "https://example.invalid/hook"; // placeholder, not a webhook
  assert.equal(resolveDiscordWebhook("main", {}), "");
  assert.equal(resolveDiscordWebhook("main", { PULSE_DISCORD_WEBHOOK: "   " }), "");
  assert.equal(resolveDiscordWebhook("main", { PULSE_DISCORD_WEBHOOK: ` ${url} ` }), url);
  assert.equal(resolveDiscordWebhook("model", { PULSE_DISCORD_WEBHOOK: url }), "", "model must not borrow main");
  assert.equal(resolveDiscordWebhook("uoa", { PULSE_DISCORD_WHALE_WEBHOOK: url }), url);
  assert.equal(resolveDiscordWebhook("uoa", { PULSE_DISCORD_UOA_WEBHOOK: url + "2", PULSE_DISCORD_WHALE_WEBHOOK: url }), url + "2");
  assert.equal(webhookFromEnv("X", { X: undefined }), "");
});

test("F11.1: disabled-webhook warning is logged once per card and never contains a URL", async () => {
  const { warnWebhookDisabledOnce, _resetWebhookWarnings } = await import("../../server/webhookConfig.ts");
  _resetWebhookWarnings();
  const logs: string[] = [];
  assert.equal(warnWebhookDisabledOnce("discord:whale", "PULSE_DISCORD_WHALE_WEBHOOK", (m) => logs.push(m)), true);
  assert.equal(warnWebhookDisabledOnce("discord:whale", "PULSE_DISCORD_WHALE_WEBHOOK", (m) => logs.push(m)), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /PULSE_DISCORD_WHALE_WEBHOOK/);
  assert.doesNotMatch(logs[0], /https?:/);
});

test("F11.1: .env.local.example lists every webhook and gate variable with an empty value", () => {
  const env = readFileSync(path.join(ROOT, ".env.local.example"), "utf8");
  for (const name of [
    "PULSE_DISCORD_WEBHOOK", "PULSE_DISCORD_WHALE_WEBHOOK", "PULSE_DISCORD_UOA_WEBHOOK",
    "PULSE_DISCORD_ODTE_WEBHOOK", "PULSE_DISCORD_MODEL_WEBHOOK", "BATCAVE_ACCESS_KEY",
    "SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET",
  ]) {
    assert.match(env, new RegExp(`^${name}=$`, "m"), `${name} must be present and empty`);
  }
});

// ─── F11.2 access-key gate, CORS, self-call wrapper; F11.3 log line ────────

type Captured = { status?: number; body?: unknown; headers: Record<string, string>; sent?: number };
function fakeRes(c: Captured) {
  const res = {
    setHeader(n: string, v: string) { c.headers[n] = v; return res; },
    status(code: number) { c.status = code; return res; },
    json(b: unknown) { c.body = b; return res; },
    sendStatus(code: number) { c.sent = code; return res; },
  };
  return res;
}

test("F11.2: gate is open when no key is configured (previous behavior)", async () => {
  const { makeAccessGate } = await import("../../server/accessGate.ts");
  let passed = false;
  const c: Captured = { headers: {} };
  makeAccessGate("")({ method: "GET", path: "/models", headers: {} }, fakeRes(c), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(c.status, undefined);
});

test("F11.2: with a key, missing or wrong header gets 401 batcave_auth_required; right header passes", async () => {
  const { makeAccessGate, keyMatches } = await import("../../server/accessGate.ts");
  const key = "test-key-not-a-secret";
  const gate = makeAccessGate(key);
  for (const hdr of [undefined, "", "wrong", key + "x", ["a", "b"]]) {
    const c: Captured = { headers: {} };
    let passed = false;
    gate({ method: "POST", path: "/discord/test", headers: { "x-batcave-key": hdr } }, fakeRes(c), () => { passed = true; });
    assert.equal(passed, false, `header ${JSON.stringify(hdr)} must not pass`);
    assert.equal(c.status, 401);
    assert.deepEqual(c.body, { error: "batcave_auth_required" });
  }
  const c: Captured = { headers: {} };
  let passed = false;
  gate({ method: "GET", path: "/models", headers: { "x-batcave-key": key } }, fakeRes(c), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(keyMatches(key, ""), false, "empty configured key never matches");
});

test("F11.2: CORS headers only for allowlisted origins; preflight answered 204", async () => {
  const { makeCorsMiddleware, parseAllowedOrigins } = await import("../../server/accessGate.ts");
  const allowed = parseAllowedOrigins(" https://ui.example.com/ , ,https://b.example.com");
  assert.ok(allowed.has("capacitor://localhost"));
  assert.ok(allowed.has("https://ui.example.com"));
  assert.ok(!allowed.has(""));
  const mw = makeCorsMiddleware(allowed);

  const ok: Captured = { headers: {} };
  let n1 = false;
  mw({ method: "GET", path: "/models", headers: { origin: "capacitor://localhost" } }, fakeRes(ok), () => { n1 = true; });
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "capacitor://localhost");
  assert.match(ok.headers["Access-Control-Allow-Headers"], /x-batcave-key/);
  assert.equal(n1, true);

  const evil: Captured = { headers: {} };
  mw({ method: "GET", path: "/models", headers: { origin: "https://evil.example" } }, fakeRes(evil), () => {});
  assert.equal(evil.headers["Access-Control-Allow-Origin"], undefined);

  const pre: Captured = { headers: {} };
  let n2 = false;
  mw({ method: "OPTIONS", path: "/models", headers: { origin: "capacitor://localhost" } }, fakeRes(pre), () => { n2 = true; });
  assert.equal(pre.sent, 204);
  assert.equal(n2, false);
});

test("F11.2 (d40db7d): self-calls to own port carry the key; other hosts never see it", async () => {
  const { makeSelfCallFetch } = await import("../../server/accessGate.ts");
  const seen: Array<{ url: string; key: string | null }> = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    seen.push({ url, key: h.get("x-batcave-key") });
    return new Response("{}");
  }) as typeof fetch;
  const f = makeSelfCallFetch(base, "k1", 5000);
  await f("http://127.0.0.1:5000/api/heatseeker", { headers: { Accept: "application/json" } });
  await f(new URL("http://localhost:5000/api/models"));
  await f(new Request("http://127.0.0.1:5000/api/quotes", { headers: { "X-Other": "1" } }));
  await f("http://127.0.0.1:5001/health"); // ML service on another port
  await f("https://api.schwabapi.com/marketdata/v1/quotes");
  await f("http://127.0.0.1:50000/api/models"); // prefix must include the trailing slash
  assert.deepEqual(seen.map((s) => s.key), ["k1", "k1", "k1", null, null, null]);
});

test("F11.3: request log line has method, path, status, duration and no body", async () => {
  const { formatRequestLog } = await import("../../server/accessGate.ts");
  assert.equal(formatRequestLog("GET", "/api/schwab/status", 200, 12), "GET /api/schwab/status 200 in 12ms");
  assert.equal(formatRequestLog.length, 4, "no body parameter");
  const idx = readFileSync(path.join(ROOT, "server/index.ts"), "utf8");
  assert.doesNotMatch(idx, /JSON\.stringify\(captured/);
  assert.doesNotMatch(idx, /res\.json = function/);
});

test("F11.2: every client fetch goes through queryClient and carries the key header", () => {
  const files = walk(path.join(ROOT, "client/src")).filter((f) => /\.(ts|tsx)$/.test(f));
  const offenders = files.filter((f) => {
    if (f.endsWith(path.join("lib", "queryClient.ts")) || f.endsWith("ConnectionGate.tsx")) return false;
    return /(^|[^.\w])fetch\(/.test(readFileSync(f, "utf8"));
  });
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
  const qc = readFileSync(path.join(ROOT, "client/src/lib/queryClient.ts"), "utf8");
  assert.equal((qc.match(/authHeaders\(\)/g) ?? []).length >= 2, true);
});
