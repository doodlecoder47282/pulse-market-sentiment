// Product edition. "personal": the owner's own deployment on their own Schwab
// account (individual developer access); every tool, including the trade
// setup builder and Discord trade cards. "investor": the subscriber edition
// for other self-directed Schwab clients; analytics and context only, no trade
// setups, no sizing recommendations (Schwab commercial review + no-advice).
// "demo": the public preview link. A simulated market stands in for Schwab
// (server/demoMarket.ts), every screen is labelled sample data, Schwab
// sign-in is refused, /api is read-only, and investor-edition limits apply.
export type Edition = "personal" | "investor" | "demo";

export function editionFromEnv(env: Record<string, string | undefined> = process.env): Edition {
  const v = (env.BATCAVE_EDITION ?? "").trim().toLowerCase();
  return v === "investor" ? "investor" : v === "demo" ? "demo" : "personal";
}

/** Parses an edition string from /api/health; anything unknown is null. */
export function parseEdition(v: unknown): Edition | null {
  return v === "personal" || v === "investor" || v === "demo" ? v : null;
}

/** Features that exist only in the personal edition. */
export const PERSONAL_ONLY_FEATURES = ["eod-trade-setup", "discord-trade-cards"] as const;

export function featureAllowed(feature: (typeof PERSONAL_ONLY_FEATURES)[number], edition: Edition): boolean {
  return edition === "personal" || !PERSONAL_ONLY_FEATURES.includes(feature);
}
