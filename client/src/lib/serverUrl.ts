// client/src/lib/serverUrl.ts
//
// Pure helpers (no React, no imports) for validating the Batcave server URL
// the iOS app / ConnectionGate saves. Unit-tested in tests/quant.

/**
 * http:// is allowed only for loopback and private-network hosts (RFC 1918
 * IPv4, IPv6 unique-local/link-local, *.local); anything else must use https
 * so the access key is never sent in clear text over the internet.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** Error text for a server URL, or null when it is acceptable. */
export function serverUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Server URL is not a valid URL.";
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isPrivateOrLoopbackHost(u.hostname)) return null;
  if (u.protocol === "http:") return "http:// is allowed only for localhost or a private-network address. Use https://.";
  return "Server URL must start with https://.";
}
