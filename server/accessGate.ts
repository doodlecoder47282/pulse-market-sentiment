// server/accessGate.ts
//
// Access control for /api, ported from branch ios-capacitor (server/index.ts,
// incl. the self-call fix in d40db7d) and moved into a pure module so it can
// be unit-tested without express:
//
//   - CORS allowlist for /api (iOS app origins built in, extras via
//     BATCAVE_ALLOWED_ORIGINS). Unlisted origins get no CORS headers, so the
//     browser blocks their reads; same-origin web use needs no CORS at all.
//   - Shared access key (BATCAVE_ACCESS_KEY). Set = every /api call except
//     /api/health must send the x-batcave-key header. Unset:
//       * loopback bind (127.0.0.1 / localhost / ::1, the local default): open,
//         as before;
//       * any other bind (0.0.0.0 on Railway etc.): FAIL CLOSED, /api returns
//         503 batcave_access_key_required unless BATCAVE_ALLOW_OPEN=1 is set
//         explicitly. The engines' own self-calls still work through a random
//         per-process internal key that never leaves the process.
//   - Repeated wrong keys from one client IP are slowed down (the 401 is
//     delayed, growing with the failure count; OWASP Authentication Cheat
//     Sheet, "Protect against automated attacks").
//   - Self-call fetch wrapper: the engines call their own API over
//     http://127.0.0.1:PORT (~25 sites). With the gate on, the key is attached
//     to requests this process sends to its own port, and nothing else.
//   - Request log line: method, path, status, duration only. Response bodies
//     are never logged (they can be large and can carry account or token
//     data; OWASP Logging Cheat Sheet, CWE-532).
//
// No express import: middleware uses minimal structural types.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ACCESS_KEY_HEADER = "x-batcave-key";
export const AUTH_REQUIRED_ERROR = "batcave_auth_required";
export const KEY_REQUIRED_ERROR = "batcave_access_key_required";
/** Keys shorter than this get a boot warning (32 chars ~ 128+ bits if random). */
export const MIN_ACCESS_KEY_LENGTH = 32;

// ── Bind host and gate policy ──────────────────────────────────────────────
export type EnvLike = Record<string, string | undefined>;

/** Bind address: HOST, else 0.0.0.0 on Railway/Render/Fly, else 127.0.0.1. */
export function resolveBindHost(env: EnvLike): string {
  const h = (env.HOST || "").trim();
  if (h) return h;
  return env.RAILWAY_ENVIRONMENT || env.RENDER || env.FLY_APP_NAME ? "0.0.0.0" : "127.0.0.1";
}

/** True only for loopback binds, which are unreachable from other machines. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export type GateMode = "key" | "open-loopback" | "open-explicit" | "closed";

/**
 * key           BATCAVE_ACCESS_KEY set: header required.
 * open-loopback no key, loopback bind: open (local use, previous behavior).
 * open-explicit no key, reachable bind, BATCAVE_ALLOW_OPEN=1: open by choice.
 * closed        no key, reachable bind: 503 on /api except /api/health.
 */
export function gateMode(env: EnvLike): GateMode {
  if ((env.BATCAVE_ACCESS_KEY || "").trim()) return "key";
  if (isLoopbackHost(resolveBindHost(env))) return "open-loopback";
  if ((env.BATCAVE_ALLOW_OPEN || "").trim() === "1") return "open-explicit";
  return "closed";
}

/** Boot-time warnings for the configured gate. Never includes the key. */
export function gateWarnings(env: EnvLike): string[] {
  const mode = gateMode(env);
  const host = resolveBindHost(env);
  const out: string[] = [];
  if (mode === "key" && (env.BATCAVE_ACCESS_KEY || "").trim().length < MIN_ACCESS_KEY_LENGTH) {
    out.push(`BATCAVE_ACCESS_KEY is shorter than ${MIN_ACCESS_KEY_LENGTH} characters; use a long random key (e.g. openssl rand -hex 32).`);
  }
  if (mode === "open-loopback") out.push(`BATCAVE_ACCESS_KEY not set: /api is open on loopback ${host} only.`);
  if (mode === "open-explicit") out.push(`BATCAVE_ALLOW_OPEN=1: /api is OPEN to anyone who can reach ${host}. Set BATCAVE_ACCESS_KEY instead.`);
  if (mode === "closed") out.push(`BATCAVE_ACCESS_KEY not set and bind host ${host} is reachable: /api returns 503 until the key is set (or BATCAVE_ALLOW_OPEN=1).`);
  return out;
}

/** Random per-process key used only for the engines' self-calls when no key is configured. */
export function newInternalKey(): string {
  return randomBytes(32).toString("hex");
}

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
  /** Client IP (express req.ip); used only to slow repeated failures. */
  ip?: string;
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

// ── Repeated-failure slowdown (per client IP) ──────────────────────────────
export const FAIL_WINDOW_MS = 10 * 60_000;
export const FAIL_FREE_ATTEMPTS = 5;
export const FAIL_MAX_DELAY_MS = 8_000;
const FAIL_MAX_TRACKED = 10_000;

/** Delay for the n-th failure in the window: 0 for the first 5, then 250 ms doubling, capped at 8 s. */
export function failureDelayMs(failures: number): number {
  if (failures <= FAIL_FREE_ATTEMPTS) return 0;
  return Math.min(FAIL_MAX_DELAY_MS, 250 * 2 ** (failures - FAIL_FREE_ATTEMPTS - 1));
}

export class FailureTracker {
  private m = new Map<string, { n: number; first: number }>();
  /** Records one failure for ip at nowMs; returns the failure count in the window. */
  record(ip: string, nowMs: number): number {
    const cur = this.m.get(ip);
    if (!cur || nowMs - cur.first > FAIL_WINDOW_MS) {
      if (this.m.size >= FAIL_MAX_TRACKED) this.m.clear(); // bounded memory
      this.m.set(ip, { n: 1, first: nowMs });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }
  /** A correct key clears that IP's failures. */
  clear(ip: string): void {
    this.m.delete(ip);
  }
}

export interface AccessGateOptions {
  /** No key configured on a reachable bind: answer 503 instead of passing. */
  failClosed?: boolean;
  /** Per-process key accepted for self-calls (used when no key is configured). */
  internalKey?: string;
  tracker?: FailureTracker;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Mounted at app.use("/api", ...) AFTER the public /api/health route.
 * Note: under app.use("/api"), req.path is relative to the mount ("/health").
 */
export function makeAccessGate(accessKey: string, opts: AccessGateOptions = {}) {
  const tracker = opts.tracker ?? new FailureTracker();
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms); });
  return (req: GateReq, res: GateRes, next: Next): void => {
    const given = req.headers[ACCESS_KEY_HEADER];
    if (opts.internalKey && keyMatches(given, opts.internalKey)) return next();
    if (!accessKey) {
      if (opts.failClosed) {
        res.status(503).json({ error: KEY_REQUIRED_ERROR });
        return;
      }
      return next();
    }
    const ip = req.ip || "unknown";
    if (keyMatches(given, accessKey)) {
      tracker.clear(ip);
      return next();
    }
    const delay = failureDelayMs(tracker.record(ip, now()));
    const deny = () => { res.status(401).json({ error: AUTH_REQUIRED_ERROR }); };
    if (delay > 0) schedule(deny, delay);
    else deny();
  };
}

/** /api/health body. `locked` = the server refuses /api until a key is configured. */
export function healthPayload(authRequired: boolean, now: Date = new Date(), locked: boolean = false) {
  return { ok: true, service: "batcave", authRequired, locked, time: now.toISOString() };
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
