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

// ─── F4.2 signed tick volume (tick rule) and bulk volume classification ────

test("F4.2: normalCdf matches standard normal table values", async () => {
  const { normalCdf } = await import("../../server/signedVolume.ts");
  // Reference: scipy.stats.norm.cdf; Abramowitz & Stegun 7.1.26 error < 1.5e-7.
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 2e-7);
  assert.ok(Math.abs(normalCdf(1) - 0.8413447461) < 2e-7);
  assert.ok(Math.abs(normalCdf(1.96) - 0.9750021048) < 2e-7);
  assert.ok(Math.abs(normalCdf(-1) - 0.1586552539) < 2e-7);
});

test("F4.2: tick rule on bars signs whole-bar volume, zero tick keeps the last sign", async () => {
  const { signedTickVolumeBars } = await import("../../server/signedVolume.ts");
  const closes = [100, 101, 101, 100, 100, 102];
  const vols = [5, 10, 20, 30, 40, 50];
  const bars = signedTickVolumeBars(closes.map((c, i) => ({ datetime: i, close: c, volume: vols[i] })));
  // Hand-computed: up, zero(keep up), down, zero(keep down), up.
  assert.deepEqual(bars.map((b) => b.direction), [1, 1, -1, -1, 1]);
  assert.deepEqual(bars.map((b) => b.signedVolume), [10, 20, -30, -40, 50]);
  assert.deepEqual(bars.map((b) => b.cumulative), [10, 30, 0, -40, 10]);
  // Leading zero ticks have no prior sign: volume is left unsigned (0).
  const flatStart = signedTickVolumeBars([100, 100, 101].map((c, i) => ({ datetime: i, close: c, volume: 7 })));
  assert.deepEqual(flatStart.map((b) => b.signedVolume), [0, 7]);
});

test("F4.2: bulk volume classification matches Easley-Lopez de Prado-O'Hara (2012) eq. 7", async () => {
  const { bulkVolumeClassify } = await import("../../server/signedVolume.ts");
  // dP = [+1,+2,-1], sample sd = 1.527525; buy fraction = Phi(dP/sd).
  // Reference values from scipy.stats.norm.cdf: 0.743655, 0.904785, 0.256345;
  // signed = sum V*(2f-1) with V = [10,20,30] -> 6.445210.
  const r = bulkVolumeClassify([100, 101, 103, 102].map((c, i) => ({ datetime: i, close: c, volume: [0, 10, 20, 30][i] })));
  assert.ok(Math.abs(r.sigma - 1.5275252317) < 1e-9);
  const ref = [0.7436546, 0.9047849, 0.2563454];
  r.buyFraction.forEach((f, i) => assert.ok(Math.abs(f - ref[i]) < 1e-6, `bar ${i}: ${f}`));
  assert.ok(Math.abs(r.cumulativeSigned - 6.44521) < 1e-4);
  // Symmetric moves with equal volume net to zero; no price change splits 50/50.
  const sym = bulkVolumeClassify([100, 101, 100, 101, 100].map((c, i) => ({ datetime: i, close: c, volume: 10 })));
  assert.ok(Math.abs(sym.cumulativeSigned) < 1e-9);
  const flat = bulkVolumeClassify([100, 100, 100].map((c, i) => ({ datetime: i, close: c, volume: 10 })));
  assert.deepEqual(flat.buyFraction, [0.5, 0.5]);
  assert.equal(flat.cumulativeSigned, 0);
});

// ─── F4.1 / F4.2 / F12.3 wording scans ─────────────────────────────────────

// Scans code lines that can reach a screen, API or alert. Pure comment lines
// (//, *, {/* ... */}) are skipped: some engine comments in files owned by
// other workstreams still say "Lee-Ready" and are not user-visible.
function scan(dirs: string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    for (const f of walk(path.join(ROOT, d)).filter((p) => /\.(ts|tsx)$/.test(p))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return;
        if (re.test(line)) out.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
  }
  return out;
}

test("F4.1: no UI or API text calls heavy contracts 'blocks' or the last-print side 'aggressor flow'", () => {
  const re = /Aggressor Flow|who paid up|BLOCK TRADE|Block-level activity|surgical options? blocks|whale print\(s\)|block trades,|\$\{c\.tag\} aggressor|>aggressor tag</;
  assert.deepEqual(scan(["client/src", "server", "shared"], re), []);
});

test("F4.2/F12.3: no component or alert text calls the tick-rule read Lee-Ready or OFI", () => {
  const re = /Lee-Ready (OFI|classifier|order-flow|classification|1-min)|\(Lee-Ready\)|OFI trend \(Lee-Ready\)|Order Flow · 1m signed volume|`OFI: |`OFI \$\{/;
  assert.deepEqual(scan(["client/src", "server"], re), []);
});

test("F4.1: shared labels say what the data is", async () => {
  const L = await import("../../shared/flowLabels.ts");
  assert.equal(L.HEAVY_CONTRACTS, "heavy contracts");
  assert.equal(L.LAST_PRINT_SIDE, "last-print side");
  assert.equal(L.SIGNED_TICK_VOLUME, "signed tick volume");
  assert.match(L.HEAVY_CONTRACT_NOTE, /not a block print/);
  assert.match(L.LAST_PRINT_SIDE_NOTE, /Not trade-by-trade/);
  assert.match(L.SIGNED_TICK_VOLUME_NOTE, /Not Lee-Ready/);
});

// ─── F9.2 / F12.1 Projected Path relabel ───────────────────────────────────

test("F9.2/F12.1: Projected Path is labeled a volatility cone (simulated training), no confidence claims", () => {
  const panel = readFileSync(path.join(ROOT, "client/src/components/MLProjectionPanel.tsx"), "utf8");
  const info = readFileSync(path.join(ROOT, "client/src/components/EdgeInfo.tsx"), "utf8");
  const sched = readFileSync(path.join(ROOT, "server/discordScheduler.ts"), "utf8");
  assert.match(panel, /volatility cone \(simulated training\)/);
  assert.match(panel, /SIM-TRAINED/);
  // Default is simulated unless the service explicitly reports real training data.
  assert.match(panel, /training_data \?\? "synthetic"\) !== "real"/);
  for (const banned of [/where the model thinks price goes/, /high conviction/, /the model is confident/, /higher confidence in the path/]) {
    assert.doesNotMatch(panel, banned);
  }
  const ml = info.slice(info.indexOf('"ml-forecast"'), info.indexOf('"trade-desk"'));
  assert.match(ml, /volatility cone \(simulated training\)/);
  assert.doesNotMatch(ml, /machine-learned forecast|model is confident/);
  assert.doesNotMatch(sched, /`ML 30m:|consider passing/);
});
