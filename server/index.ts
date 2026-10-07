import dotenv from "dotenv";
// Load .env.local first (takes precedence), then fall back to .env.
dotenv.config({ path: ".env.local" });
dotenv.config();
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { startMlRetrainCron } from "./mlRetrainCron";

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

// ── Native app + hosted deployment support ─────────────────────────────────
// CORS: the iOS app (Capacitor) serves its bundled UI from capacitor://localhost
// and calls this server cross-origin. Only /api is opened, only to listed origins.
// Extra origins: BATCAVE_ALLOWED_ORIGINS="https://a.example,https://b.example".
const ALLOWED_ORIGINS = new Set(
  [
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
    ...(process.env.BATCAVE_ALLOWED_ORIGINS || "").split(","),
  ]
    .map((o) => o.trim())
    .filter(Boolean),
);
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-batcave-key");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Optional shared access key. When BATCAVE_ACCESS_KEY is set, every /api call
// except /api/health must send it in the x-batcave-key header. Unset = open
// (previous behavior). Set it on any publicly reachable deployment.
const ACCESS_KEY = (process.env.BATCAVE_ACCESS_KEY || "").trim();
function keyMatches(given: unknown): boolean {
  if (!ACCESS_KEY || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}
app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, service: "batcave", authRequired: !!ACCESS_KEY, time: new Date().toISOString() });
});
app.use("/api", (req, res, next) => {
  if (!ACCESS_KEY) return next();
  if (keyMatches(req.headers["x-batcave-key"])) return next();
  return res.status(401).json({ error: "batcave_auth_required" });
});
app.get("/api/health/auth", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

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
