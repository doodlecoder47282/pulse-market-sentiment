// server/security.ts
// Additive security layer for Batcave. Do not modify locked files
// (signals.ts, regime.ts, dfi.ts, models.ts, composite.ts, PreMarketGate.tsx).
//
// - helmet for hardened HTTP headers
// - express-rate-limit on /api/* (loose default, tighter on auth routes)
// - /api/health JSON endpoint matching SELF_HEAL.md contract
//
// System name: Batcave (never "Selz").

import type { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export function applySecurity(app: Express): void {
  // 1. Hardened headers. CSP off by default because the client is a Vite build
  //    with inline module preloads + Google Fonts — flipping strict CSP would
  //    break the SPA. Keep the other 15+ header protections.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // 2. Global API rate limit. 300 req / 60s / IP. Trading UI polls hard,
  //    so this is deliberately loose. Bump if the terminal hits it.
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });
  app.use("/api/", apiLimiter);

  // 3. Tight limiter for Schwab auth surfaces — brute-force / abuse guard.
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "auth_rate_limited" },
  });
  app.use("/api/schwab/auth-url", authLimiter);
  app.use("/api/schwab/callback", authLimiter);

  // 4. /api/health — JSON contract from SELF_HEAL.md §1.
  app.get("/api/health", async (_req: Request, res: Response, _next: NextFunction) => {
    const envPath = path.resolve(process.cwd(), ".env.local");
    let envPresent = false;
    let envMode = "";
    let envSize = 0;
    try {
      const st = fs.statSync(envPath);
      envPresent = true;
      envMode = (st.mode & 0o777).toString(8);
      envSize = st.size;
    } catch { /* missing is fine — reported */ }

    let gitSha = process.env.GIT_SHA || "";
    if (!gitSha) {
      try {
        gitSha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
          .toString().trim();
      } catch { gitSha = "unknown"; }
    }

    // Pull Schwab status via the internal module if available; fall back to a
    // conservative shape so /api/health never throws.
    let schwab = {
      connected: false,
      needsReauth: true,
      expiresIn: 0,
      lastRefreshError: null as string | null,
    };
    try {
      // Lazy import so this file has no hard dep on a Schwab module name.
      const mod: any = await import("./schwabAuth").catch(() => null)
        || await import("./schwab").catch(() => null);
      if (mod && typeof mod.getSchwabStatus === "function") {
        const s = await mod.getSchwabStatus();
        schwab = {
          connected: !!s.connected,
          needsReauth: !!s.needsReauth,
          expiresIn: Number(s.expiresIn || 0),
          lastRefreshError: s.lastRefreshError ?? null,
        };
      }
    } catch { /* leave defaults */ }

    res.json({
      serverUp: true,
      schwab,
      backups: { envPresent, envMode, envSize },
      build: { gitSha, builtAt: process.env.BUILT_AT || new Date().toISOString() },
    });
  });
}
