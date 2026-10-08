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
} from "./accessGate";

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

// Optional shared access key. When BATCAVE_ACCESS_KEY is set, every /api call
// except /api/health must send it in the x-batcave-key header. Unset = open
// (previous behavior). Set it on any publicly reachable deployment.
const ACCESS_KEY = (process.env.BATCAVE_ACCESS_KEY || "").trim();
// The engines call each other over local HTTP (trade environment -> heatseeker,
// Discord cards -> models, exit brain -> quotes, ...; ~25 call sites). When the
// gate is on, attach the key to every request this process sends to its own
// port so those internal calls keep working (ios-capacitor d40db7d).
if (ACCESS_KEY) {
  globalThis.fetch = makeSelfCallFetch(globalThis.fetch.bind(globalThis), ACCESS_KEY, process.env.PORT || "5000");
}

app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(healthPayload(!!ACCESS_KEY));
});
app.use("/api", makeAccessGate(ACCESS_KEY));
app.get("/api/health/auth", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});
if (!ACCESS_KEY) {
  log("BATCAVE_ACCESS_KEY not set: /api is open. Set it on any reachable deployment.", "security");
}

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
  const host =
    process.env.HOST ||
    (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME
      ? "0.0.0.0"
      : "127.0.0.1");
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
