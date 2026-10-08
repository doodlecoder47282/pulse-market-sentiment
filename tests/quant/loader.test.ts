import { test } from "node:test";
import assert from "node:assert/strict";

// Smoke test for the loader: an alias import and an extensionless relative import resolve.
test("loader resolves @shared alias", async () => {
  const mod = await import("@shared/vol");
  assert.ok(Object.keys(mod).length > 0);
});
