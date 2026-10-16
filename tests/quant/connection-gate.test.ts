import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const gate = read("client/src/components/ConnectionGate.tsx");
const app = read("client/src/App.tsx");
const qc = read("client/src/lib/queryClient.ts");

test("connection gate owns the dashboard subtree, not an overlay sibling", () => {
  const ast = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let ownsDashboard = false;
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "ConnectionGate") {
      ownsDashboard = /<TickerProvider>/.test(node.getText(ast)) && /<AppRouter/.test(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(ownsDashboard, true);
  assert.match(gate, /useState<Mode>\("checking"\)/);
  assert.match(gate, /mode === "hidden"\) return <>\{children\}<\/>/);
});

test("both connection probes are bounded and release their timers", () => {
  assert.equal((gate.match(/controller\.abort\(\), 10_000/g) || []).length, 2);
  assert.equal((gate.match(/window\.clearTimeout\(timeout\)/g) || []).length, 2);
  assert.equal((gate.match(/signal: controller\.signal/g) || []).length, 2);
});

test("a failed connection is not reported as a rejected key", () => {
  assert.match(gate, /res\.status === 401 \|\| res\.status === 403/);
  assert.match(gate, /your key has not been rejected/);
  assert.match(gate, /typeof body\?\.authRequired !== "boolean"/);
  assert.match(gate, /readConnectionSetting\(ACCESS_KEY_STORAGE_KEY\)[\s\S]*?: ""/);
});

test("storage-blocked connection has an in-memory fallback without reload", () => {
  assert.match(qc, /connectionSession\.set\(name, value\)/);
  assert.match(qc, /connectionSession\.has\(key\)/);
  assert.match(gate, /saveConnectionSettings\(base, accessKey\.trim\(\)\)/);
  assert.doesNotMatch(gate, /window\.location\.reload/);
  assert.match(gate, /queryClient\.clear\(\)/);
});

test("mobile zoom is permitted for the viewport and wide-table scroller", () => {
  const html = read("client/index.html");
  assert.doesNotMatch(html, /maximum-scale|user-scalable\s*=\s*no/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(read("client/src/index.css"), /touch-action: pan-x pan-y pinch-zoom/);
});

test("gate controls retain accessible labels, status and touch-size minimum", () => {
  assert.match(gate, /role="status" aria-live="polite"/);
  assert.match(gate, /autoComplete="current-password"/);
  assert.equal((gate.match(/min-h-11/g) || []).length, 4);
  assert.match(gate, /m-auto w-full max-w-sm shrink-0/);
  assert.doesNotMatch(gate, /BATCAVE_ALLOW_OPEN=1/);
});

test("Crypto lazy initializer follows the React import for the development transform", () => {
  const dashboard = read("client/src/pages/dashboard.tsx");
  assert.ok(dashboard.indexOf('from "react"') < dashboard.indexOf("const CryptoPanel = lazy"));
});
