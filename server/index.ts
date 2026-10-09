import dotenv from "dotenv";
// Load .env.local first (takes precedence), then fall back to .env.
dotenv.config({ path: ".env.local" });
dotenv.config();
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { startMlRetrainCron } from "./mlRetrainCron";
import {
  parseAllowedOrigins,
  makeCorsMiddleware,
  makeAccessGate,
  makeSelfCallFetch,
  healthPayload,
  formatRequestLog,
  resolveBindHost,
  gateMode,
  gateWarnings,
  newInternalKey,
  trustProxyHops,
} from "./accessGate";
import { tokenKeyWarnings } from "./tokenCrypto";

// Global safety nets — do NOT let a stray promise reject or exception kill the
// long-running server process. Crashes here previously took down /api/* during
// background scheduler hiccups.
process.on("unhandledRejection", (reason: any) => {
  console.error("[fatal-guard] unhandledRejection:", reason?.message ?? reason);
});
process.on("uncaughtException", (err: any) => {
  console.error("[fatal-guard] uncaughtException:", err?.message ?? err, err?.stack);
});

const app = express();
const httpServer = createServer(app);

// Client IP behind a platform proxy (Railway/Render/Fly): trust exactly the
// configured hop count so req.ip, and with it the wrong-key slowdown bucket in
// accessGate.ts, is per client. Never `true`: see trustProxyHops for the
// spoofing trade-off. Local/unknown hosts trust nothing (socket address).
const TRUST_PROXY_HOPS = trustProxyHops(process.env);
if (TRUST_PROXY_HOPS > 0) app.set("trust proxy", TRUST_PROXY_HOPS);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Request log: method, path, status, duration. Response bodies are not
// logged: chain/model payloads are large, and status payloads can carry
// account or token data (OWASP Logging Cheat Sheet; CWE-532).
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    if (path.startsWith("/api")) {
      log(formatRequestLog(req.method, path, res.statusCode, Date.now() - start));
    }
  });
  next();
});

// ── Native app + hosted deployment support (from branch ios-capacitor) ─────
// CORS: the iOS app (Capacitor) serves its bundled UI from capacitor://localhost
// and calls this server cross-origin. Only /api is opened, only to listed origins.
// Extra origins: BATCAVE_ALLOWED_ORIGINS="https://a.example,https://b.example".
app.use("/api", makeCorsMiddleware(parseAllowedOrigins(process.env.BATCAVE_ALLOWED_ORIGINS)));

// Shared access key. When BATCAVE_ACCESS_KEY is set, every /api call except
// /api/health must send it in the x-batcave-key header. Unset: open on a
// loopback bind (local use, as before); on a reachable bind (0.0.0.0, Railway)
// the gate FAILS CLOSED with 503 unless BATCAVE_ALLOW_OPEN=1 (accessGate.ts).
const ACCESS_KEY = (process.env.BATCAVE_ACCESS_KEY || "").trim();
const BIND_HOST = resolveBindHost(process.env);
const GATE_MODE = gateMode(process.env);
// Fail closed still lets the engines' own self-calls through, using a random
// per-process key that never leaves this process.
const INTERNAL_KEY = GATE_MODE === "closed" ? newInternalKey() : "";
// The trading-critical engine calls (trade environment -> heatseeker, exit
// brain -> quotes/models, Discord cards and decision support -> models) now
// run in-process (internalApi.ts). The remaining local-HTTP self-calls (news,
// regime ticker, mm scheduler, alpha brief, ...) still need the key: when the
// gate is on, attach it to every request this process sends to its own port
// (ios-capacitor d40db7d).
const SELF_CALL_KEY = ACCESS_KEY || INTERNAL_KEY;
if (SELF_CALL_KEY) {
  globalThis.fetch = makeSelfCallFetch(globalThis.fetch.bind(globalThis), SELF_CALL_KEY, process.env.PORT || "5000");
}

app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(healthPayload(!!ACCESS_KEY, new Date(), GATE_MODE === "closed"));
});
app.use("/api", makeAccessGate(ACCESS_KEY, { failClosed: GATE_MODE === "closed", internalKey: INTERNAL_KEY || undefined }));
app.get("/api/health/auth", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});
for (const w of gateWarnings(process.env)) log(w, "security");
// Schwab token storage at rest (tokenCrypto.ts): plaintext-local / locked reasons.
for (const w of tokenKeyWarnings(process.env)) log(w, "security");

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // host: 127.0.0.1 (not 0.0.0.0) — sandbox forwarder owns 169.254.0.21:5000
  // and 0.0.0.0 conflicts with it. Forwarder routes external traffic to localhost.
  // Hosted platforms (Railway etc.) route traffic to the container's external
  // interface, so bind 0.0.0.0 there. HOST overrides either default.
  // Same resolution the access gate uses (accessGate.resolveBindHost).
  const host = BIND_HOST;
  httpServer.listen(
    {
      port,
      host,
      reusePort: true,
    },
    () => {
      log(`serving on ${host}:${port}`);
      startMlRetrainCron();
    },
  );
})();
