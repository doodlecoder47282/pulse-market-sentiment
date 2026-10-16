/** Pure parsing only. Never log or persist the returned one-time code. */
export function parseSchwabCallback(raw: string, expectedState: string, redirectUri: string): { code: string; state: string } {
  const input = raw.trim();
  if (!input || input.length > 8192) throw new Error("Paste the fresh callback from this sign-in.");
  if (!expectedState) throw new Error("Start a new Schwab sign-in before completing the connection.");
  let code: string | null;
  let state: string | null = null;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    const expected = new URL(redirectUri);
    if (url.origin !== expected.origin || url.pathname.replace(/\/+$/, "") !== expected.pathname.replace(/\/+$/, "") || url.username || url.password) {
      throw new Error("This is not the configured callback address. Copy the address from your latest Schwab sign-in.");
    }
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
    if (url.searchParams.has("error")) throw new Error("Schwab authorization was not completed. Start a new sign-in.");
  } else if (/^[?&]?code=/.test(input)) {
    const params = new URLSearchParams(input.replace(/^[?&]/, ""));
    code = params.get("code");
    state = params.get("state");
  } else {
    code = input;
  }
  if (!code || code.length > 4096 || /[\s<>]/.test(code)) throw new Error("No valid authorization code was found. Use the fresh callback, not your password or access key.");
  if (state && state !== expectedState) throw new Error("This callback belongs to a different sign-in. Use the newest login link.");
  return { code, state: expectedState };
}
