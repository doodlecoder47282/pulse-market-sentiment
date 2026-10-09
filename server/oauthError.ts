// OAuth token-endpoint error reduction (pure; unit-testable).
//
// A failed token response body can echo request data (an authorization code,
// client id) and is not safe to log or return. Keep only the HTTP status and
// the RFC 6749 s5.2 "error" code, a short ASCII token such as
// "invalid_grant". RFC 6749 "The OAuth 2.0 Authorization Framework" s5.2,
// https://datatracker.ietf.org/doc/html/rfc6749#section-5.2
export function oauthErrorCode(bodyText: string): string {
  try {
    const c = JSON.parse(bodyText)?.error;
    if (typeof c === "string" && /^[a-z_]{1,40}$/.test(c)) return c;
  } catch { /* non-JSON body */ }
  return "unknown";
}
