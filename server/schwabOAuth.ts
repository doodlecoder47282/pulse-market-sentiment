// Schwab sign-in helpers: config check, one-time `state` values for the
// automatic callback, where each sign-in returns to (website or the iOS
// app), and the callback URL shape. Pure, so it is unit-tested.
import { randomBytes } from "node:crypto";

export const OAUTH_CALLBACK_PATH = "/api/schwab/oauth/callback";
/** Custom URL scheme the iOS app registers (ios/App/App/Info.plist). The
 *  callback redirects here when the sign-in was started from the app, so
 *  the in-app Safari sheet closes and the app itself shows the result. */
export const APP_RETURN_URL = "batcave://schwab";
const STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING = 50;

export type OAuthReturnTo = "web" | "app";
const pending = new Map<string, { expiresAt: number; returnTo: OAuthReturnTo }>();

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

/** "app" only when the client said so explicitly; anything else is the website. */
export function parseReturnTo(v: unknown): OAuthReturnTo {
  return v === "app" ? "app" : "web";
}

/** Where the callback sends the browser after a sign-in result. The website
 *  gets its own dashboard with the result in the query; the app gets its
 *  custom scheme, which iOS hands to the app (Browser sheet closes). */
export function oauthReturnUrl(returnTo: OAuthReturnTo, result: "connected" | "error", reason?: string): string {
  const q = result === "error" && reason ? `schwab=error&reason=${encodeURIComponent(reason)}` : `schwab=${result}`;
  return returnTo === "app" ? `${APP_RETURN_URL}?${q}` : `/?${q}#/`;
}

function prune(now: number) {
  pending.forEach((v, s) => { if (v.expiresAt <= now) pending.delete(s); });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
}

/** A fresh one-time state value, valid for 15 minutes, remembering where
 *  the sign-in should return to. */
export function newOAuthState(now: number = Date.now(), returnTo: OAuthReturnTo = "web"): string {
  prune(now);
  const s = randomBytes(16).toString("hex");
  pending.set(s, { expiresAt: now + STATE_TTL_MS, returnTo });
  return s;
}

/** Accepts each issued state once, before it expires, and says where that
 *  sign-in returns to. An unknown or reused state is refused and returns to
 *  the website (there is no app to return to for a state nobody issued). */
export function consumeOAuthStateFor(state: string | null | undefined, now: number = Date.now()): { ok: boolean; returnTo: OAuthReturnTo } {
  prune(now);
  if (!state) return { ok: false, returnTo: "web" };
  const entry = pending.get(state);
  if (!entry) return { ok: false, returnTo: "web" };
  pending.delete(state);
  return { ok: true, returnTo: entry.returnTo };
}

/** Accepts each issued state once, before it expires. */
export function consumeOAuthState(state: string | null | undefined, now: number = Date.now()): boolean {
  return consumeOAuthStateFor(state, now).ok;
}
