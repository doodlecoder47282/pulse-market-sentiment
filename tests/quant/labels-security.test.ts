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
