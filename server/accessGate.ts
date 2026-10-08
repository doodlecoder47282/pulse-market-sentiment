// server/accessGate.ts
//
// Access control for /api, ported from branch ios-capacitor (server/index.ts,
// incl. the self-call fix in d40db7d) and moved into a pure module so it can
// be unit-tested without express:
//
//   - CORS allowlist for /api (iOS app origins built in, extras via
//     BATCAVE_ALLOWED_ORIGINS). Unlisted origins get no CORS headers, so the
//     browser blocks their reads; same-origin web use needs no CORS at all.
//   - Optional shared access key (BATCAVE_ACCESS_KEY). Unset = open, the
//     previous behavior. Set = every /api call except /api/health must send
//     the x-batcave-key header.
//   - Self-call fetch wrapper: the engines call their own API over
//     http://127.0.0.1:PORT (~25 sites). With the gate on, the key is attached
//     to requests this process sends to its own port, and nothing else.
//   - Request log line: method, path, status, duration only. Response bodies
//     are never logged (they can be large and can carry account or token
//     data; OWASP Logging Cheat Sheet, CWE-532).
//
// No express import: middleware uses minimal structural types.

import { createHash, timingSafeEqual } from "node:crypto";

export const ACCESS_KEY_HEADER = "x-batcave-key";
export const AUTH_REQUIRED_ERROR = "batcave_auth_required";

export const DEFAULT_ALLOWED_ORIGINS = [
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
] as const;

/** Builds the CORS allowlist from the built-in origins plus a comma-separated env value. */
export function parseAllowedOrigins(extra: string | undefined): Set<string> {
  return new Set(
    [...DEFAULT_ALLOWED_ORIGINS, ...(extra || "").split(",")]
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/**
 * Constant-time key comparison. Both sides are hashed first so neither the
 * content nor the length of the configured key leaks through timing.
 * An empty configured key never matches (gate off is handled by the caller).
 */
export function keyMatches(given: unknown, accessKey: string): boolean {
  if (!accessKey || typeof given !== "string" || given.length === 0) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(accessKey).digest();
  return timingSafeEqual(a, b);
}

// ── Minimal request/response shapes (structurally compatible with express) ──
export interface GateReq {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}
export interface GateRes {
  setHeader(name: string, value: string): unknown;
  status(code: number): GateRes;
  json(body: unknown): unknown;
  sendStatus(code: number): unknown;
}
export type Next = () => void;

/** Mounted at app.use("/api", ...): CORS headers for allowlisted origins, 204 on preflight. */
export function makeCorsMiddleware(allowed: Set<string>) {
  return (req: GateReq, res: GateRes, next: Next): void => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${ACCESS_KEY_HEADER}`);
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/**
 * Mounted at app.use("/api", ...) AFTER the public /api/health route.
 * Note: under app.use("/api"), req.path is relative to the mount ("/health").
 */
export function makeAccessGate(accessKey: string) {
  return (req: GateReq, res: GateRes, next: Next): void => {
    if (!accessKey) return next();
    if (keyMatches(req.headers[ACCESS_KEY_HEADER], accessKey)) return next();
    res.status(401).json({ error: AUTH_REQUIRED_ERROR });
  };
}

export function healthPayload(authRequired: boolean, now: Date = new Date()) {
  return { ok: true, service: "batcave", authRequired, time: now.toISOString() };
}

// ── Self-call wrapper ──────────────────────────────────────────────────────
type FetchFn = typeof fetch;

export function selfUrlPrefixes(port: string | number): string[] {
  return [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`];
}

/**
 * Returns a fetch that adds the access key header to requests aimed at this
 * process's own port and passes every other request through untouched.
 */
export function makeSelfCallFetch(baseFetch: FetchFn, accessKey: string, port: string | number): FetchFn {
  const prefixes = selfUrlPrefixes(port);
  const RequestCtor: typeof Request | undefined = (globalThis as { Request?: typeof Request }).Request;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const isRequest = RequestCtor !== undefined && input instanceof RequestCtor;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : isRequest ? (input as Request).url : undefined;
    if (accessKey && typeof url === "string" && prefixes.some((p) => url.startsWith(p))) {
      const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
      headers.set(ACCESS_KEY_HEADER, accessKey);
      return baseFetch(input, { ...(init ?? {}), headers });
    }
    return baseFetch(input, init);
  }) as FetchFn;
}

// ── Request logging ────────────────────────────────────────────────────────
/** One log line per API request. Deliberately has no body parameter. */
export function formatRequestLog(method: string, path: string, status: number, durationMs: number): string {
  return `${method} ${path} ${status} in ${durationMs}ms`;
}
