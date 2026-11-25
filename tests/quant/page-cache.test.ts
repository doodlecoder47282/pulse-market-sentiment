// After a deploy the browser must load the new page, not a kept copy of the old one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the page is revalidated on every load; hashed files are kept", () => {
  const src = readFileSync("server/static.ts", "utf8");
  // The rule, evaluated without loading express.
  const body = /export function pageCacheControl\(filePath: string\): string \{([\s\S]*?)\n\}/.exec(src)![1];
  const fn = new Function("filePath", body.replace(/: string/g, "")) as (p: string) => string;
  assert.equal(fn("/app/dist/public/index.html"), "no-cache");
  assert.equal(fn("/app/dist/public/manifest.json"), "no-cache");
  assert.equal(fn("/app/dist/public/assets/index-DbMJohRv.js"), "public, max-age=31536000, immutable");
  assert.equal(fn("/app/dist/public/assets/index-Cf13jV0_.css"), "public, max-age=31536000, immutable");
  assert.equal(fn("C:\\app\\public\\assets\\vendor-B89mKzOF.js"), "public, max-age=31536000, immutable");
  assert.equal(fn("/app/dist/public/assets/logo.png"), "no-cache", "a file without a content hash is not kept");
  assert.match(src, /res\.setHeader\("Cache-Control", "no-cache"\);\s*res\.sendFile\(path\.resolve\(distPath, "index\.html"\)\);/);
});
