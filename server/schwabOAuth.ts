// Schwab sign-in helpers: config check, one-time `state` values for the
// automatic callback, and the callback URL shape. Pure, so it is unit-tested.
import { randomBytes } from "node:crypto";

export const OAUTH_CALLBACK_PATH = "/api/schwab/oauth/callback";
const STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING = 50;
const pending = new Map<string, number>(); // state -> expiresAt

type Env = Record<string, string | undefined>;

/** Which required Schwab settings are missing, in words; null when complete. */
export function schwabConfigProblem(env: Env = process.env): string | null {
  const missing = [
    !(env.SCHWAB_CLIENT_ID ?? "").trim() && "SCHWAB_CLIENT_ID (App Key)",
    !(env.SCHWAB_CLIENT_SECRET ?? "").trim() && "SCHWAB_CLIENT_SECRET (Secret)",
    !(env.SCHWAB_REDIRECT_URI ?? "").trim() && "SCHWAB_REDIRECT_URI (Callback URL)",
  ].filter(Boolean) as string[];
  return missing.length ? `The server is missing ${missing.join(", ")}. Set it in the host's environment variables and redeploy.` : null;
}

/** True when the registered callback is this app's own callback route, so
 *  Schwab returns the user here and sign-in finishes without pasting. */
export function isAutomaticCallback(redirectUri: string): boolean {
  try {
    return new URL(redirectUri).pathname.replace(/\/+$/, "") === OAUTH_CALLBACK_PATH;
  } catch {
    return false;
  }
}

function prune(now: number) {
  pending.forEach((exp, s) => { if (exp <= now) pending.delete(s); });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
}

/** A fresh one-time state value, valid for 15 minutes. */
export function newOAuthState(now: number = Date.now()): string {
  prune(now);
  const s = randomBytes(16).toString("hex");
  pending.set(s, now + STATE_TTL_MS);
  return s;
}

/** Accepts each issued state once, before it expires. */
export function consumeOAuthState(state: string | null | undefined, now: number = Date.now()): boolean {
  prune(now);
  if (!state || !pending.has(state)) return false;
  pending.delete(state);
  return true;
}
