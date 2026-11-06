// Running commit on /api/health, and the Settings request breakdown.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deployInfo } from "../../server/deployInfo.ts";
import { requestBreakdown, featureOf } from "../../shared/requestBreakdown.ts";

test("deploy info: Railway's commit variable, shortened; unknown stays null", () => {
  assert.deepEqual(deployInfo({ RAILWAY_GIT_COMMIT_SHA: "6074C73BEEF0123456789ABCDEF0123456789ABC", RAILWAY_GIT_BRANCH: "main" }),
    { commit: "6074c73beef0", commitSource: "RAILWAY_GIT_COMMIT_SHA", branch: "main" });
  assert.deepEqual(deployInfo({}), { commit: null, commitSource: null, branch: null });
  assert.equal(deployInfo({ RAILWAY_GIT_COMMIT_SHA: "not-a-sha" }).commit, null, "never a made-up value");
  assert.equal(deployInfo({ SOURCE_VERSION: "abcdef1" }).commitSource, "SOURCE_VERSION");
});

test("health payload carries the commit fields (null when the host did not say)", async () => {
  const G = await import("../../server/accessGate.ts");
  const h = G.healthPayload(true, new Date(0), false, "personal", { commit: "abc1234", commitSource: "RAILWAY_GIT_COMMIT_SHA", branch: "main" });
  assert.equal(h.commit, "abc1234");
  assert.equal(G.healthPayload(true, new Date(0)).commit, null);
});

test("request breakdown: groups the live diag rows by feature and priority, kinds and symbols kept", () => {
  // Rows as the live /api/schwab/diag returned them on 2026-11-05 (subset).
  const rows = [
    { n: 6, k: "I chains SPY <- api /headline" },
    { n: 3, k: "I chains $SPX <- api /headline" },
    { n: 2, k: "I pricehistory SPY <- api /macro" },
    { n: 2, k: "I pricehistory GLD <- api /macro" },
    { n: 1, k: "I quotes $VIX,GOOGL <- api /flow" },
    { n: 1, k: "I chains AAPL <- api /flow" },
    { n: 1, k: "B chains $SPX <- async qt (/app/dist/index.cjs:390:8470)" },
    { n: 2, k: "garbage" },
  ];
  const b = requestBreakdown(rows);
  assert.equal(b.total, 18);
  assert.equal(b.unparsed, 2);
  assert.deepEqual(b.lines.map((l) => [l.feature, l.priority, l.total]), [
    ["api /headline", "interactive", 9],
    ["api /macro", "interactive", 4],
    ["api /flow", "interactive", 2],
    ["background task", "background", 1],
  ]);
  const flow = b.lines.find((l) => l.feature === "api /flow")!;
  assert.deepEqual(flow.kinds.map((k) => k.kind).sort(), ["chains", "quotes"]);
  assert.deepEqual(flow.symbols.sort(), ["$VIX", "AAPL", "GOOGL"]);
  assert.equal(featureOf("async qt (/app/dist/index.cjs:390:8470)"), "background task", "no file paths shown");
  assert.deepEqual(requestBreakdown(null), { lines: [], total: 0, unparsed: 0 });
});

test("breakdown header: the total is requestsLastMinute; rows that cover less, and unreadable rows, are stated", async () => {
  const { breakdownHeader, requestBreakdown: rb } = await import("../../shared/requestBreakdown.ts");
  assert.equal(breakdownHeader(80, 0, 80, 100), "last minute: 80 admitted of 100");
  assert.equal(breakdownHeader(55, 0, 92, 100), "last minute: 92 admitted of 100 · 37 not itemised (only the busiest 60 caller rows are reported)");
  // Unparsed rows are part of the row total: stated once, not also as "not itemised".
  assert.equal(breakdownHeader(53, 3, 53, 100), "last minute: 53 admitted of 100 · 3 in rows this panel could not read");
  assert.equal(breakdownHeader(10, 0, null, 100), "last minute: 10 in reported rows (total not reported)");
  // A 24-character symbol list was cut by the server: its last symbol is marked partial.
  const b = rb([{ n: 2, k: "I quotes AAPL,AMZN,GOOGL,META,MS <- api /mag7" }]);
  assert.equal("AAPL,AMZN,GOOGL,META,MS".length, 23);
  assert.deepEqual(b.lines[0].symbols, ["AAPL", "AMZN", "GOOGL", "META", "MS"]);
  const cut = rb([{ n: 2, k: "I quotes AAPL,AMZN,GOOGL,META,MSF <- api /mag7" }]);
  assert.deepEqual(cut.lines[0].symbols.slice(-1), ["MSF…"]);
});

test("Settings breakdown: header from requestsLastMinute, more-not-shown note, degraded window wording, health states", () => {
  const s = readFileSync(new URL("../../client/src/components/SchwabSettings.tsx", import.meta.url), "utf8");
  assert.match(s, /breakdownHeader\(breakdown\.total, breakdown\.unparsed, diag\.requestsLastMinute, diag\.maxPerMinute\)/);
  assert.match(s, /more features not shown/);
  assert.doesNotMatch(s, /Last 5 min, not fetched/);
  assert.match(s, /health check did not answer/);
});
