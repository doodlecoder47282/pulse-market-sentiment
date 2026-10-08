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

// ─── F6.1 Ticker Outlook: no Kelly size, heuristic scenario weights ────────

test("F6.1: Outlook reports no size and never takes kellyFrac from the composite or an LLM", async () => {
  const M = await import("../../server/outlookVerdictMath.ts");
  assert.deepEqual(M.noOutlookSizing(), { available: false, reason: M.NO_SIZE_REASON });
  assert.match(M.NO_SIZE_REASON, /no fitted win probability/);
  const src = readFileSync(path.join(ROOT, "server/tickerOutlook.ts"), "utf8");
  // Old formulas: |c|/100 x 0.25 and Number(raw.kellyFrac ...) from the model.
  assert.doesNotMatch(src, /Math\.abs\(c\) \/ 100\) \* 0\.25/);
  assert.doesNotMatch(src, /raw\.kellyFrac/);
  assert.equal((src.match(/kellyFrac: 0,/g) ?? []).length, 2, "both verdict paths pin kellyFrac to 0");
  assert.doesNotMatch(src, /"kellyFrac": <0-1 number>/, "LLM prompt no longer asks for a size");
  const card = readFileSync(path.join(ROOT, "client/src/components/TickerOutlookCard.tsx"), "utf8");
  assert.doesNotMatch(card, /label="kelly"|quarter-Kelly|v\.kellyFrac \* 100/);
  const email = readFileSync(path.join(ROOT, "server/alphaEmailComposer.ts"), "utf8");
  assert.doesNotMatch(email, /parts\.push\(`size \$\{t\.sizingKelly\}`\)|max loss \$\{t\.maxLoss\}/);
});

test("F6.1: scenario weights are integers in [0,100] summing to exactly 100", async () => {
  const { normalizeScenarioWeights } = await import("../../server/outlookVerdictMath.ts");
  const fb = { bull: 30, bear: 30 };
  // Hand-computed: 70 + 60 = 130 > 100 -> scale by 100/130: 53.85 -> 54, 46.15 -> 46, base 0.
  assert.deepEqual(normalizeScenarioWeights(70, 60, fb), { bull: 54, base: 0, bear: 46 });
  // Normal case: 50 / 20 -> base 30.
  assert.deepEqual(normalizeScenarioWeights(50, 20, fb), { bull: 50, base: 30, bear: 20 });
  // Non-numeric falls back; negatives clamp to 0.
  assert.deepEqual(normalizeScenarioWeights("abc", undefined, fb), { bull: 30, base: 40, bear: 30 });
  assert.deepEqual(normalizeScenarioWeights(-5, 40, fb), { bull: 0, base: 60, bear: 40 });
  for (const [b, x] of [[33.3, 33.3], [99.6, 0.6], [150, 150], [0.4, 0.4], [100, 0]] as const) {
    const w = normalizeScenarioWeights(b, x, fb);
    assert.equal(w.bull + w.base + w.bear, 100, `${b}/${x}`);
    for (const v of [w.bull, w.base, w.bear]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100);
  }
});

// ─── F5.1 Cosmos: context only, no trade instructions, nothing consumes it ──

// Phrases that would make Cosmos a trading instruction or direction call.
const COSMOS_INSTRUCTION_RE =
  /\b(size (up|down|longs?|normally)|normal sizing|reduce (gross |position |directional )?(exposure|size|risk|leverage)|reduce leverage|tighten stops|put spreads?|iron condors?|hedge via|hedges? on|scale-in|fade (rips|conviction)|load put|lean long|short[- ]bias|long[- ]bias|contrarian longs|favou?red|avoid (initiating|new|confrontational)|entry windows?|strong window for entries|close only|swing-long|rotate toward|trust breakouts|trimming longs|trade your system|bullish|bearish|risk-on bias|contraction bias)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}]/u;

function cosmosTexts(C: any, date: Date): string[] {
  const snap = C.buildCosmosSnapshot(date);
  const out: string[] = [snap.dailyBriefMarkdown];
  for (const s of snap.financialSignals) out.push(s.headline, s.detail, ...s.impacts);
  for (const z of snap.zodiacReadings) out.push(z.headline, z.detail, z.luckyWindow);
  for (const o of [C.buildWeeklyOutlook(date), C.buildMonthlyOutlook(date)]) {
    out.push(o.markdown);
    for (const e of o.events) out.push(e.headline, e.detail);
  }
  for (const v of Object.values(C.taxonomyLiveStates(snap, null)) as any[]) out.push(v.currentValue ?? "", v.badge ?? "");
  return out;
}

test("F5.1: Cosmos output over two years has no trade instruction, direction call or emoji", async () => {
  const C = await import("../../server/cosmos.ts");
  const statics: string[] = [
    C.HONEST_EDGE_ASSESSMENT, C.COSMOS_DISCLAIMER,
    ...C.TAXONOMY.flatMap((t: any) => [t.description, ...t.tags]),
    ...C.BOOKS.map((b: any) => b.summary),
    ...C.ACADEMIC_PAPERS.map((p: any) => p.finding),
    ...C.EDGE_RULES.flatMap((r: any) => [r.title, r.body]),
  ];
  for (const t of statics) {
    assert.doesNotMatch(t, COSMOS_INSTRUCTION_RE, t.slice(0, 80));
    assert.doesNotMatch(t, EMOJI_RE);
  }
  // Every 17 days for two years (43 dates; 17 is not a multiple of the 29.5-day
  // lunar month, so snapshot dates sweep every phase). Each date also scans
  // the next 30 days of events, so every station, ingress and Bradley zone
  // change in the window is covered.
  const start = Date.UTC(2025, 0, 1, 15);
  let n = 0;
  for (let d = 0; d < 730; d += 17) {
    const date = new Date(start + d * 86_400_000);
    for (const t of cosmosTexts(C, date)) {
      const m = t.match(COSMOS_INSTRUCTION_RE);
      assert.equal(m, null, `${date.toISOString()}: "${m?.[0]}" in: ${t.slice(0, 120)}`);
      assert.doesNotMatch(t, EMOJI_RE);
      n++;
    }
    const snap = C.buildCosmosSnapshot(date);
    for (const s of snap.financialSignals) {
      assert.equal(s.severity, "info");
      assert.ok(typeof s.evidence === "string" && s.evidence.length > 0);
    }
    const w = C.buildWeeklyOutlook(date);
    assert.equal(w.netBias, "neutral");
    assert.ok(w.events.every((e: any) => e.bias === "neutral" && typeof e.evidence === "string"));
    assert.match(w.markdown, /not a trading signal/);
    assert.equal(snap.disclaimer, C.COSMOS_DISCLAIMER);
  }
  assert.ok(n > 500);
});

test("F5.1: only lunar, geomagnetic and SAD items claim any study; the LLM prompt forbids trades", async () => {
  const C = await import("../../server/cosmos.ts");
  const studied = C.TAXONOMY.filter((t: any) => t.evidence !== "no peer-reviewed support").map((t: any) => t.id).sort();
  assert.deepEqual(studied, ["full_moon", "geomagnetic_storm", "new_moon", "sad_seasonal"]);
  assert.equal(C.TAXONOMY.find((t: any) => t.id === "sad_seasonal").evidence, "peer-reviewed, disputed");
  // Yuan, Zheng & Zhu (2006, JEF 13(1)): 3-5% a year; 3%/252 to 5%/252 = 1.2 to 2.0 bp a day.
  assert.match(C.LUNAR_EVIDENCE_NOTE, /3-5% a year/);
  assert.match(C.LUNAR_EVIDENCE_NOTE, /1-2 basis points a day/);
  assert.match(C.OUTLOOK_SYSTEM_PROMPT, /For entertainment and context, not a trading signal\./);
  assert.match(C.OUTLOOK_SYSTEM_PROMPT, /Do NOT give trade instructions, position sizes/);
  assert.doesNotMatch(C.OUTLOOK_SYSTEM_PROMPT, /trade playbook|sizing, sector tilts, hedging, specific setups/);
});

test("F5.1: mean lunar node matches Meeus eq. 47.7 (replaces a stale hard-coded sign)", async () => {
  const C = await import("../../server/cosmos.ts");
  // T = 0 at J2000.0 (2000-01-01 12:00 TT ~ UTC here): Omega = 125.0445479 deg (Meeus 47.7).
  assert.ok(Math.abs(C.meanLunarNodeLongitude(new Date(Date.UTC(2000, 0, 1, 12))) - 125.0445479) < 1e-6);
  // One Julian year later: -1934.1362891/100 = -19.3413629 deg per year (plus negligible T^2 terms).
  const a = C.meanLunarNodeLongitude(new Date(Date.UTC(2000, 0, 1, 12)));
  const b = C.meanLunarNodeLongitude(new Date(Date.UTC(2000, 0, 1, 12) + 365.25 * 86_400_000));
  assert.ok(Math.abs(((a - b + 360) % 360) - 19.3413629) < 1e-4);
  const snap = C.buildCosmosSnapshot(new Date(Date.UTC(2026, 9, 8, 15)));
  // 2026-10-08: Omega ~ 327.3 deg = Aquarius 27.3 (hand-computed from 47.7).
  assert.match(C.taxonomyLiveStates(snap, null).node_cycle.currentValue, /Aquarius 27\.\d/);
});

test("F5.1: no engine or other panel consumes Cosmos output", () => {
  const serverImporters = walk(path.join(ROOT, "server"))
    .filter((f) => /\.ts$/.test(f) && !f.endsWith(path.join("server", "cosmos.ts")))
    .filter((f) => /from ["']\.\/cosmos(\.js)?["']/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(serverImporters, ["server/routes.ts"], "only routes.ts (the Cosmos tab endpoints) may import cosmos.ts");
  const routes = readFileSync(path.join(ROOT, "server/routes.ts"), "utf8");
  // Engines call each other over HTTP; none may fetch the Cosmos endpoints.
  const selfCalls = walk(path.join(ROOT, "server")).filter((f) => /\.ts$/.test(f))
    .filter((f) => /fetch\([^)]*\/api\/cosmos/.test(readFileSync(f, "utf8")));
  assert.deepEqual(selfCalls, []);
  assert.ok(routes.includes('app.get("/api/cosmos"'));
  const clientReaders = walk(path.join(ROOT, "client/src"))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /\/api\/cosmos/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(clientReaders, ["client/src/components/CosmosPanel.tsx"]);
});
