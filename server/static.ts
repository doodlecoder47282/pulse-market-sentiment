import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // The page itself must be asked for again on every load: it names the current script files. Without a
  // cache header a browser may keep showing an old page (and with it the old app) after a deploy, as seen
  // on 2026-11-24. The script and style files carry a content hash in their names, so they can be kept.
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      res.setHeader("Cache-Control", pageCacheControl(filePath));
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

/** Cache rule for a built file: hashed files under assets/ are kept for a year, everything else is revalidated. */
export function pageCacheControl(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpg|webp)$/.test(p) ? "public, max-age=31536000, immutable" : "no-cache";
}
