// server/publicGuard.ts
//
// What a server needs before strangers use it, as pure functions with no
// express import (unit-tested like accessGate.ts):
//
//   - Per-client rate limits. Two buckets per client IP: a general one for
//     every /api call, and a tight one for routes that trigger an upstream
//     read on demand (Schwab chains, price history, instrument lookups,
//     DexScreener pools). The engines' own self-calls (internal key) are
//     never limited. A limited call gets 429 with Retry-After and a JSON
//     body in the app's error shape; nothing is queued.
//   - Security headers: nosniff, no framing, a tight referrer policy, a
//     permissions policy that turns off sensors the app never uses, and
//     HSTS only when the request arrived over HTTPS (Railway terminates
//     TLS; the loopback dev server must not pin HTTPS).
//
// Limits are per edition: the personal edition (one owner) keeps generous
// limits so a single reader never hits them; investor and demo editions,
// the ones a public deployment runs, are tighter.

import type { Edition } from "../shared/edition";

export interface RateLimitPolicy {
  /** Requests per minute per client for every /api route. */
  generalPerMin: number;
  /** Requests per minute per client for routes that read upstream on demand. */
  upstreamPerMin: number;
}

export function rateLimitPolicy(edition: Edition): RateLimitPolicy {
  // The dashboard polls a few dozen endpoints per tab; readers behind one office NAT share an IP. General limits are
  // sized for that; the upstream bucket is the one that protects the Schwab and DexScreener budgets.
  return edition === "personal" ? { generalPerMin: 1_200, upstreamPerMin: 60 } : { generalPerMin: 600, upstreamPerMin: 30 };
}

/** Routes whose handler makes an upstream call on demand (prefix match). */
export const UPSTREAM_ROUTE_PREFIXES = ["/api/scan", "/api/research/events", "/api/odte/map", "/api/gamma-levels", "/api/gamma-curve", "/api/heatseeker/levels", "/api/flow/preview", "/api/crypto/community"];

export function isUpstreamRoute(path: string): boolean {
  return UPSTREAM_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(p + "?") || path.startsWith(p + "/"));
}

interface Bucket { tokens: number; refilledAt: number }

/**
 * Token bucket per key, refilled continuously at `perMin` per minute up to
 * a burst of `perMin`. `take` returns the wait in seconds when empty (0 =
 * allowed). Pure apart from the map it keeps.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly perMin: number, private readonly maxKeys = 10_000) {}

  take(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number; remaining: number } {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = { tokens: this.perMin, refilledAt: now };
      this.buckets.set(key, b);
    }
    const refill = ((now - b.refilledAt) / 60_000) * this.perMin;
    b.tokens = Math.min(this.perMin, b.tokens + refill);
    b.refilledAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSec: 0, remaining: Math.floor(b.tokens) };
    }
    const retry = Math.ceil(((1 - b.tokens) / this.perMin) * 60);
    return { allowed: false, retryAfterSec: Math.max(1, retry), remaining: 0 };
  }

  /** Drop buckets that are full again (idle clients). */
  sweep(now = Date.now()): void {
    for (const [k, b] of this.buckets) {
      const refill = ((now - b.refilledAt) / 60_000) * this.perMin;
      if (b.tokens + refill >= this.perMin) this.buckets.delete(k);
    }
  }

  size(): number { return this.buckets.size; }
}

interface ReqLike { ip?: string; path?: string; originalUrl?: string; headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }
interface ResLike { setHeader(name: string, value: string): void; status(code: number): ResLike; json(body: unknown): unknown }

export interface GuardOptions {
  edition: Edition;
  /** Requests carrying this key (the engines' self-calls) are never limited. */
  internalKey?: string;
  keyHeader?: string;
  now?: () => number;
}

export function makeRateLimit(opts: GuardOptions) {
  const policy = rateLimitPolicy(opts.edition);
  const general = new RateLimiter(policy.generalPerMin);
  const upstream = new RateLimiter(policy.upstreamPerMin);
  const header = (opts.keyHeader ?? "x-batcave-key").toLowerCase();
  return function rateLimit(req: ReqLike, res: ResLike, next: () => void): void {
    const given = req.headers[header];
    if (opts.internalKey && typeof given === "string" && given === opts.internalKey) return next();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = opts.now ? opts.now() : Date.now();
    const path = (req.originalUrl ?? req.path ?? "").split("?")[0];
    const g = general.take(ip, now);
    if (!g.allowed) return reject(res, g.retryAfterSec, "general", policy.generalPerMin);
    if (isUpstreamRoute(path)) {
      const u = upstream.take(ip, now);
      if (!u.allowed) return reject(res, u.retryAfterSec, "upstream", policy.upstreamPerMin);
      res.setHeader("X-RateLimit-Remaining", String(u.remaining));
    } else {
      res.setHeader("X-RateLimit-Remaining", String(g.remaining));
    }
    next();
  };
}

function reject(res: ResLike, retryAfterSec: number, bucket: "general" | "upstream", perMin: number): void {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({
    error: "rate_limited",
    dataState: "unavailable",
    message: bucket === "upstream"
      ? `this route reads live data on demand and is limited to ${perMin} calls a minute per client; retry in ${retryAfterSec}s`
      : `limited to ${perMin} calls a minute per client; retry in ${retryAfterSec}s`,
    retryAfterSec,
  });
}

/** Headers every response carries; HSTS only on a request that came in over HTTPS. */
export function securityHeaders(secure: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (secure) h["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  return h;
}

export function makeSecurityHeaders() {
  return function headers(req: { secure?: boolean; headers: Record<string, string | string[] | undefined> }, res: ResLike, next: () => void): void {
    const proto = req.headers["x-forwarded-proto"];
    const secure = !!req.secure || (typeof proto === "string" && proto.split(",")[0].trim() === "https");
    for (const [k, v] of Object.entries(securityHeaders(secure))) res.setHeader(k, v);
    next();
  };
}
