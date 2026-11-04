import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync("client/src/components/TradeBriefSearch.tsx", "utf8");

test("lookup never relies on native forms, which are blocked in embedded previews", () => {
  assert.doesNotMatch(component, /<form\b|type="submit"/);
  assert.match(component, /role="search"/);
  assert.match(component, /type="button" onClick=\{\(\) => void search\(\)\}/);
});

test("keyboard lookup is explicit, composition-safe, and has a mobile search key", () => {
  assert.match(component, /enterKeyHint="search"/);
  assert.match(component, /e\.key === "Enter" && !e\.nativeEvent\.isComposing/);
  assert.match(component, /e\.preventDefault\(\);\s+void search\(\);/);
});

test("lookup exposes loading, results and error, with duplicate in-flight guard", () => {
  assert.match(component, /data-testid="trade-brief-search-status" role="status"/);
  assert.match(component, /data-testid="trade-brief-error" role="alert"/);
  assert.match(component, /offline \|\| busy === "search"/);
  assert.match(component, /No supported listing found/);
});
