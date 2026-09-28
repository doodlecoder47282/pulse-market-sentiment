import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

// Explicit read-only surface. New endpoints are denied until reviewed.
const readPaths = new Set([
  "snapshot", "trade-desk", "macro", "ohlc", "flow", "flow-intraday", "models",
  "exposures", "flow/unusual", "news", "alpha-news", "econ-week", "ofi", "mag7",
  "gamma-levels", "ticker-outlook", "ticker-projection", "ticker-calendar",
  "regime", "sector-web", "underperformers", "pivot-projection", "wef-themes",
  "quotes", "seasonality", "jpm-collar", "vol-calendar", "earnings", "heatseeker/levels",
  "earnings-iv", "iv-rv", "gamma-curve", "cross-asset", "skew", "fred", "cot",
  "anomaly", "gamma-levels-enhanced", "headline", "market/quotes", "chain-audit",
  "killbox/third-order", "killbox/gradient", "regime/headline", "heatmap/thermal",
  "odte/forward", "killbox/forward", "killbox/stats", "trade-environment", "heatseeker",
  "backtest/levels", "odte-tracker", "odte-tracker/sparkline", "odte-tracker/tracked",
  "odte-tracker/chart", "mtf-stack", "rev-ext", "realtime-targets",
  "edge/stats", "edge/hazard/status", "edge/calibration", "crypto/feed", "crypto/health",
  "crypto/signals", "edge/walkforward", "edge/orthogonality", "breadth", "regime/predict",
  "cosmos/outlook", "cosmos", "canary", "flow/snapshot", "flow/preview",
  "uoa/preview", "whales/performance", "flow/history", "calibration/rolling",
  "quote-shield", "decision-support", "ml/projection-spx", "ml/projection-spy",
  "ml/health", "projection/multiday", "ml/accuracy-history",
]);
const hash = (value: string) => createHash("sha256").update(value).digest();

type ConnectionStatus = { connected: boolean; needsReauth: boolean; staleAccessToken: boolean; expiresIn: number; refreshExpiresIn: number };

export function createMobileGateway(
  getToken = () => process.env.BATCAVE_MOBILE_TOKEN,
  getStatus?: () => ConnectionStatus,
): RequestHandler {
  const attempts = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    if (!(req.path === "/api/mobile" || req.path.startsWith("/api/mobile/"))) return next();
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && origin !== "capacitor://localhost") {
      res.status(403).json({ message: "Origin not allowed." }); return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    }
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    const expected = getToken();
    if (!expected || !/^[A-Za-z0-9_-]{32,256}$/.test(expected)) {
      res.status(503).json({ message: "Mobile gateway is not configured." }); return;
    }
    const now = Date.now();
    // Bound memory even if directly exposed. A production proxy must separately
    // limit requests/connections and expose ONLY /api/mobile/*.
    attempts.forEach((item, key) => { if (item.until < now) attempts.delete(key); });
    const key = req.ip || "unknown";
    const slot = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    slot.count++;
    if (!attempts.has(key) && attempts.size >= 1000) {
      res.status(429).json({ message: "Gateway busy. Try again later." }); return;
    }
    attempts.set(key, slot);
    if (slot.count > 180) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ message: "Mobile request limit reached. Retry in a minute." }); return;
    }
    const authorization = req.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!timingSafeEqual(hash(supplied), hash(expected))) {
      res.status(401).json({ message: "Invalid mobile access token." }); return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ message: "Mobile v1 is read-only. Use the web terminal for this action." }); return;
    }
    const path = req.path.slice("/api/mobile/".length);
    if (path === "health") {
      res.json({ service: "batcave-mobile", version: 1, mode: "read-only" }); return;
    }
    if (path === "schwab/status" && getStatus) {
      const status = getStatus();
      // Deliberately exclude diagnostic strings and all credential material.
      res.json({
        connected: Boolean(status.connected), needsReauth: Boolean(status.needsReauth),
        staleAccessToken: Boolean(status.staleAccessToken),
        expiresIn: status.expiresIn, refreshExpiresIn: status.refreshExpiresIn,
      }); return;
    }
    const dynamicRead = /^(layout\/[a-z-]+|seasonality\/[A-Za-z0-9_$.-]+|market\/(price-history|option-chain)\/[A-Za-z0-9_$.-]+)$/.test(path);
    if (!readPaths.has(path) && !dynamicRead) {
      res.status(403).json({ message: "This endpoint is not available in the read-only iPhone build." }); return;
    }
    // Reuse existing handlers in-process, not an open HTTP proxy.
    req.url = req.url.replace(/^\/api\/mobile\//, "/api/");
    next();
  };
}
