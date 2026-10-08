// server/webhookConfig.ts
//
// Discord webhook URLs come only from environment variables. There is no
// hard-coded fallback: a webhook URL is a write credential for the channel,
// and this repository is public. When a variable is unset the matching card
// is disabled: the post returns false and one warning is logged per
// variable for the life of the process (no crash, no log spam).
//
// Variables (see .env.local.example):
//   PULSE_DISCORD_WEBHOOK        main Batcave channel (calibration card, news, level alerts)
//   PULSE_DISCORD_WHALE_WEBHOOK  heavy-contract (whale) flow cards
//   PULSE_DISCORD_UOA_WEBHOOK    UOA cluster cards (falls back to the whale webhook)
//   PULSE_DISCORD_ODTE_WEBHOOK   SPX 0DTE alerts
//   PULSE_DISCORD_MODEL_WEBHOOK  SPX model cards (9:30 kickoff + 30-min refined card)
//
// Pure module: no network, no DB. Safe to import from tests.

export type EnvLike = Record<string, string | undefined>;

/** Returns the trimmed URL, or "" when the variable is unset or blank. */
export function webhookFromEnv(name: string, env: EnvLike = process.env): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

const warned = new Set<string>();

/**
 * Logs, once per key, that a webhook is not configured. Never logs a URL.
 * Returns true the first time it logs for that key (useful in tests).
 */
export function warnWebhookDisabledOnce(
  key: string,
  envName: string,
  logger: (msg: string) => void = (m) => console.warn(m),
): boolean {
  if (warned.has(key)) return false;
  warned.add(key);
  logger(`[${key}] Discord webhook disabled: set ${envName} to enable this card.`);
  return true;
}

export type DiscordChannel = "main" | "whale" | "uoa" | "odte" | "model";

export const DISCORD_CHANNEL_ENV: Record<DiscordChannel, string> = {
  main: "PULSE_DISCORD_WEBHOOK",
  whale: "PULSE_DISCORD_WHALE_WEBHOOK",
  uoa: "PULSE_DISCORD_UOA_WEBHOOK",
  odte: "PULSE_DISCORD_ODTE_WEBHOOK",
  model: "PULSE_DISCORD_MODEL_WEBHOOK",
};

/**
 * Resolves a channel's webhook at call time (not at import time: the server
 * bundle hoists imports above dotenv.config(), so module-level reads would
 * miss .env.local). UOA falls back to the whale webhook, as before.
 * Returns "" when the channel is disabled.
 */
export function resolveDiscordWebhook(channel: DiscordChannel, env: EnvLike = process.env): string {
  const own = webhookFromEnv(DISCORD_CHANNEL_ENV[channel], env);
  if (own) return own;
  if (channel === "uoa") return webhookFromEnv(DISCORD_CHANNEL_ENV.whale, env);
  return "";
}

/** Test helper: forget which keys already warned. */
export function _resetWebhookWarnings(): void {
  warned.clear();
}
