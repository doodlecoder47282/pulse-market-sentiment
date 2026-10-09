// Every server/shared TypeScript file must parse as an ES module after type
// stripping. Catches early errors (e.g. a block-scoped name declared twice)
// that the bundler rejects, in files no other test imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("all server/shared .ts files parse after type stripping", () => {
  const out = execFileSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "tests/quant/loader/parse-check.mjs"], { encoding: "utf8" });
  assert.match(out, /parsed \d{3,} files, 0 failures/, out);
});
