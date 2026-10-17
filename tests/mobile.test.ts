import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { createMobileGateway } from "../server/mobileGateway";
import { createNativeSession, nativeRequestTarget, normalizeBackendOrigin } from "../client/src/lib/nativeSession";

const token = "test-token-not-a-secret-12345678901234567890";

test("origin and routing keep the token on the intended HTTPS backend", () => {
  assert.equal(normalizeBackendOrigin("https://batcave.example/"), "https://batcave.example");
  for (const input of ["http://batcave.example", "https://x:pass@batcave.example", "https://batcave.example/path", "https://batcave.example?token=x", "https://sites.pplx.app", "https://www.perplexity.ai"]) {
    assert.throws(() => normalizeBackendOrigin(input));
  }
  assert.throws(() => createNativeSession("https://batcave.example", "short"));
  const session = createNativeSession("https://batcave.example", token);
  assert.equal(nativeRequestTarget("/api/crypto/feed?x=1", session).url, "https://batcave.example/api/mobile/crypto/feed?x=1");
  for (const path of ["https://evil.example", "//evil.example", "/api/../admin", "/api/mobile/health", "/api/%2e%2e/admin"]) {
    assert.throws(() => nativeRequestTarget(path, session));
  }
});

test("mobile gateway fails closed, restricts origin and writes, preserves web requests", async () => {
  let configured: string | undefined = token;
  const app = express();
  app.use(createMobileGateway(() => configured, () => ({
    connected: true, needsReauth: false, staleAccessToken: false, expiresIn: 100,
    refreshExpiresIn: 200, lastRefreshError: "do not forward",
  })));
  app.get("/api/crypto/feed", (_req, res) => res.json({ candidates: [], fixture: true }));
  app.get("/api/ordinary-web", (_req, res) => res.json({ web: true }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, Origin: "capacitor://localhost" };
  try {
    const request = (path: string, init: RequestInit = {}) => fetch(origin + path, init);
    assert.equal((await request("/api/mobile/health")).status, 401);
    assert.equal((await request("/api/mobile/health", { headers: { Authorization: token } })).status, 401);
    assert.equal((await request("/api/mobile/health", { headers: { ...headers, Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await request("/api/mobile/health", { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
    const preflight = await request("/api/mobile/crypto/feed", { method: "OPTIONS", headers });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "capacitor://localhost");
    const health = await request("/api/mobile/health", { headers });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "batcave-mobile");
    assert.equal(health.headers.get("cache-control"), "no-store");
    const status = await request("/api/mobile/schwab/status", { headers });
    assert.equal((await status.json()).lastRefreshError, undefined);
    const feed = await request("/api/mobile/crypto/feed", { headers });
    assert.equal(feed.status, 200);
    assert.equal((await feed.json()).fixture, true);
    for (const path of ["schwab/diag", "schwab/auth-url", "edge/backups", "discord/batcave/preview", "unknown"]) {
      assert.equal((await request(`/api/mobile/${path}`, { headers })).status, 403);
    }
    assert.equal((await request("/api/mobile/snapshot", { method: "POST", headers })).status, 405);
    assert.equal((await request("/api/ordinary-web")).status, 200);
    configured = undefined;
    assert.equal((await request("/api/mobile/health", { headers })).status, 503);
    configured = "rotated-token-123456789012345678901234567890";
    assert.equal((await request("/api/mobile/health", { headers })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("mobile gateway rate limit is bounded and enforced", async () => {
  const app = express();
  app.use(createMobileGateway(() => token));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    let response: Response | undefined;
    for (let i = 0; i < 181; i++) {
      response = await fetch(`http://127.0.0.1:${port}/api/mobile/health`, { headers: { Authorization: `Bearer ${token}` } });
    }
    assert.equal(response?.status, 429);
    assert.equal(response?.headers.get("retry-after"), "60");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
