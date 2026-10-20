// tests/quant/public-guard.test.ts
//
// Rate limits and security headers for a public deployment: per-client
// buckets, a tighter bucket for routes that read upstream on demand, the
// engines' self-calls exempt, 429 with Retry-After, HSTS only over HTTPS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, makeRateLimit, makeSecurityHeaders, rateLimitPolicy, isUpstreamRoute, isScanRoute, securityHeaders } from "../../server/publicGuard";

function fakeRes() {
  const headers: Record<string, string> = {};
  let code = 200; let body: any = null;
  const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; }, status: (c: number) => { code = c; return res; }, json: (b: unknown) => { body = b; return b; } };
  return { res, headers, get code() { return code; }, get body() { return body; } };
}

test("RateLimiter: burst of perMin, then empty with a retry time, refills with time, sweeps idle keys", () => {
  const rl = new RateLimiter(3);
  const t0 = 1_000_000;
  assert.equal(rl.take("a", t0).allowed, true);
  assert.equal(rl.take("a", t0).allowed, true);
  assert.equal(rl.take("a", t0).allowed, true);
  const r = rl.take("a", t0);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterSec, 20, "3 per minute: one token every 20 s");
  assert.equal(rl.take("b", t0).allowed, true, "another client has its own bucket");
  assert.equal(rl.take("a", t0 + 20_000).allowed, true, "refilled one token");
  rl.sweep(t0 + 120_000);
  assert.equal(rl.size(), 0);
});

test("policy: personal edition generous, public editions tight; upstream routes matched by prefix", () => {
  assert.equal(rateLimitPolicy("personal").scanPerMin, 30);
  assert.equal(rateLimitPolicy("demo").scanPerMin, 10);
  assert.equal(rateLimitPolicy("investor").generalPerMin, 3_000);
  assert.equal(isScanRoute("/api/scan"), true);
  assert.equal(isScanRoute("/api/scan?symbol=SPY"), true);
  assert.equal(isScanRoute("/api/scanner"), false);
  assert.equal(isUpstreamRoute("/api/scan"), false, "the scan has its own bucket");
  assert.equal(isUpstreamRoute("/api/odte/map/ledger"), true);
  assert.equal(isUpstreamRoute("/api/setups"), false);
  assert.equal(isUpstreamRoute("/api/scanner"), false, "prefix match stops at the segment");
});

test("makeRateLimit: 429 with Retry-After in the app's error shape; self-calls exempt; remaining header set", () => {
  let now = 5_000_000;
  const mw = makeRateLimit({ edition: "demo", internalKey: "secret-internal", now: () => now });
  const call = (path: string, key?: string) => {
    const f = fakeRes(); let passed = false;
    mw({ ip: "1.2.3.4", originalUrl: path, headers: key ? { "x-batcave-key": key } : {} } as any, f.res, () => { passed = true; });
    return { passed, ...f };
  };
  for (let i = 0; i < 10; i++) assert.equal(call("/api/scan?symbol=SPY").passed, true, `scan call ${i + 1} of 10 passes`);
  const limited = call("/api/scan?symbol=QQQ");
  assert.equal(limited.passed, false);
  assert.equal(limited.code, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal(limited.body.dataState, "unavailable");
  assert.match(limited.body.message, /reads a fresh chain for any symbol/);
  assert.equal(call("/api/odte/map?symbol=%24SPX").passed, true, "the upstream bucket is separate from the scan bucket");
  assert.ok(Number(limited.headers["Retry-After"]) >= 1);
  assert.equal(call("/api/setups").passed, true, "the general bucket is separate and not exhausted");
  assert.equal(call("/api/scan?symbol=IWM", "secret-internal").passed, true, "the engines' self-calls are never limited");
  now += 60_000;
  assert.equal(call("/api/scan?symbol=DIA").passed, true, "a minute later the bucket refilled");
  const tight = makeRateLimit({ edition: "demo", now: () => now });
  let upstreamOk = 0;
  for (let i = 0; i < 121; i++) { const f = fakeRes(); tight({ ip: "9.9.9.9", originalUrl: "/api/gamma-levels?symbol=NVDA", headers: {} } as any, f.res, () => { upstreamOk++; }); }
  assert.equal(upstreamOk, 120, "upstream bucket is 120 a minute in the public editions");
  const ok = call("/api/setups");
  assert.ok(ok.headers["X-RateLimit-Remaining"] != null);
});

test("security headers: always nosniff/DENY/referrer/permissions; HSTS only over HTTPS (direct or forwarded)", () => {
  const plain = securityHeaders(false);
  assert.equal(plain["X-Content-Type-Options"], "nosniff");
  assert.equal(plain["X-Frame-Options"], "DENY");
  assert.equal(plain["Strict-Transport-Security"], undefined);
  assert.match(securityHeaders(true)["Strict-Transport-Security"], /max-age=/);
  const mw = makeSecurityHeaders();
  const a = fakeRes(); mw({ secure: false, headers: {} }, a.res, () => {});
  assert.equal(a.headers["Strict-Transport-Security"], undefined);
  const b = fakeRes(); mw({ secure: false, headers: { "x-forwarded-proto": "https" } }, b.res, () => {});
  assert.match(b.headers["Strict-Transport-Security"], /includeSubDomains/);
  assert.equal(b.headers["Referrer-Policy"], "strict-origin-when-cross-origin");
});
