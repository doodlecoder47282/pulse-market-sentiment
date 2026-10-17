export interface NativeSession {
  origin: string;
  token: string;
}

let session: NativeSession | null = null;

export function normalizeBackendOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error("Enter the HTTPS origin of your Batcave server."); }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an HTTPS origin only, without a path, password, or query.");
  }
  if (url.hostname.endsWith(".pplx.app") || url.hostname === "perplexity.ai" ||
      url.hostname.endsWith(".perplexity.ai")) {
    throw new Error("Use your permanent backend, not a Computer preview address.");
  }
  return url.origin;
}

export function createNativeSession(origin: string, token: string): NativeSession {
  const cleanToken = token.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(cleanToken)) {
    throw new Error("Use the separate mobile access token, at least 32 URL-safe characters.");
  }
  return { origin: normalizeBackendOrigin(origin), token: cleanToken };
}

export function setNativeSession(value: NativeSession | null) {
  session = value;
}

export function getNativeSession(): NativeSession | null { return session; }

export function nativeRequestTarget(path: string, value: NativeSession) {
  // No absolute URLs, traversal, fragments, or credentials to third parties.
  if (!/^\/api\/[A-Za-z0-9/$_-]+(?:\?[^#]*)?$/.test(path) ||
      path.includes("..") || path.startsWith("/api/mobile/")) {
    throw new Error("Unsupported mobile API path.");
  }
  return {
    url: `${value.origin}/api/mobile/${path.slice(5)}`,
    headers: { Authorization: `Bearer ${value.token}` },
  };
}
