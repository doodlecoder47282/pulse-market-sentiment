// server/webhookConfig.ts
//
// Discord webhook URLs come only from environment variables. There is no
// hard-coded fallback: a webhook URL is a write credential for the channel,
// and this repository is public. When a variable is unset the matching card
// is disabled: the post returns false and one warning is logged per
// variable for the life of the process (no crash, no log spam).
//
// A set value must parse with new URL(), use https, have host discord.com or
// discordapp.com and a /api/webhooks/ path; anything else disables the card
// with a one-time warning that names the variable but never its value.
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

/** Returns the trimmed value, or "" when the variable is unset or blank. */
export function webhookFromEnv(name: string, env: EnvLike = process.env): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);

/**
 * True for an https URL on discord.com / discordapp.com under /api/webhooks/.
 * Never throws and never echoes the value.
 */
export function isValidDiscordWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    DISCORD_WEBHOOK_HOSTS.has(u.hostname.toLowerCase()) &&
    u.username === "" && u.password === "" &&
    (u.port === "" || u.port === "443") &&
    u.pathname.startsWith("/api/webhooks/")
  );
}

export type WebhookState = "ok" | "unset" | "invalid";

const warned = new Set<string>();

/**
 * Logs, once per key, that a webhook is disabled (unset or invalid). Names the
 * variable, never the value. Returns true the first time it logs for that key.
 */
export function warnWebhookDisabledOnce(
  key: string,
  envName: string,
  logger: (msg: string) => void = (m) => console.warn(m),
  reason: Exclude<WebhookState, "ok"> = "unset",
): boolean {
  if (warned.has(key)) return false;
  warned.add(key);
  logger(
    reason === "invalid"
      ? `[${key}] Discord webhook disabled: ${envName} is not a valid https://discord.com/api/webhooks/... URL (value not logged).`
      : `[${key}] Discord webhook disabled: set ${envName} to enable this card.`,
  );
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
 * miss .env.local). UOA falls back to the whale webhook only when its own
 * variable is unset (an invalid UOA value disables the card, it does not
 * silently reroute).
 */
export function webhookStatus(
  channel: DiscordChannel,
  env: EnvLike = process.env,
): { url: string; state: WebhookState; envName: string } {
  const envName = DISCORD_CHANNEL_ENV[channel];
  const own = webhookFromEnv(envName, env);
  if (own) {
    return isValidDiscordWebhookUrl(own) ? { url: own, state: "ok", envName } : { url: "", state: "invalid", envName };
  }
  if (channel === "uoa") return webhookStatus("whale", env);
  return { url: "", state: "unset", envName };
}

/** The channel's webhook URL, or "" when it is unset or invalid (disabled). */
export function resolveDiscordWebhook(channel: DiscordChannel, env: EnvLike = process.env): string {
  return webhookStatus(channel, env).url;
}

/**
 * URL to post to, or "" after logging (once per key) why the card is disabled.
 * Use this at every send site.
 */
export function webhookOrWarn(
  channel: DiscordChannel,
  key: string,
  env: EnvLike = process.env,
  logger?: (msg: string) => void,
): string {
  const st = webhookStatus(channel, env);
  if (st.state === "ok") return st.url;
  warnWebhookDisabledOnce(key, st.envName, logger, st.state);
  return "";
}

/**
 * Loggable description of a thrown error WITHOUT its message: Node's fetch
 * errors can include the request URL (here a webhook credential) in the
 * message or stack. Only the error name and a cause code are kept.
 */
export function safeErrorSummary(e: unknown): string {
  const err = e as { name?: unknown; cause?: { code?: unknown } } | null | undefined;
  const name = typeof err?.name === "string" ? err.name : "Error";
  const code = err?.cause && typeof err.cause.code === "string" ? err.cause.code : null;
  return code ? `${name} (${code})` : name;
}

/** Test helper: forget which keys already warned. */
export function _resetWebhookWarnings(): void {
  warned.clear();
}
