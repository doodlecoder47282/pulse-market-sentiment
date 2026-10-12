// Product edition. "personal": the owner's own deployment on their own Schwab
// account (individual developer access); every tool, including the trade
// setup builder and Discord trade cards. "investor": the subscriber edition
// for other self-directed Schwab clients; analytics and context only, no trade
// setups, no sizing recommendations (Schwab commercial review + no-advice).
export type Edition = "personal" | "investor";

export function editionFromEnv(env: Record<string, string | undefined> = process.env): Edition {
  return (env.BATCAVE_EDITION ?? "").trim().toLowerCase() === "investor" ? "investor" : "personal";
}

/** Features that exist only in the personal edition. */
export const PERSONAL_ONLY_FEATURES = ["eod-trade-setup", "discord-trade-cards"] as const;

export function featureAllowed(feature: (typeof PERSONAL_ONLY_FEATURES)[number], edition: Edition): boolean {
  return edition === "personal" || !PERSONAL_ONLY_FEATURES.includes(feature);
}
