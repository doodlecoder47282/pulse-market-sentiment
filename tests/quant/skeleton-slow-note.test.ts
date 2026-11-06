// A loading skeleton states what it is waiting on after SLOW_AFTER_MS, and
// the heavy Schwab-backed panels name the read. Never an endless grey wait.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("skeleton: slow note after 6 s, under the 25 s query deadline, states the deadline honestly", () => {
  const sk = src("client/src/components/ui/panel-skeleton.tsx");
  assert.match(sk, /export const SLOW_AFTER_MS = 6_000;/);
  assert.match(sk, /setTimeout\(\(\) => setSlow\(true\), SLOW_AFTER_MS\)/);
  assert.match(sk, /A cold read can take up to 25 s; after that the panel says what failed\./);
  assert.match(src("client/src/lib/queryClient.ts"), /\}, 25_000, signal\);/, "the query deadline the note refers to");
  // Every variant carries the note.
  assert.equal((sk.match(/<SlowNote waitingOn=\{waitingOn\} \/>/g) ?? []).length, 3);
});

test("heavy Schwab panels name the read they wait on", () => {
  assert.match(src("client/src/components/TradeDesk.tsx"), /<SlowNote waitingOn="the Schwab SPY chain and quotes \(a cold models build\)" \/>/);
  assert.match(src("client/src/components/Heatseeker.tsx"), /<SlowNote waitingOn="the Schwab option chain" \/>/);
  assert.match(src("client/src/components/ChainAudit.tsx"), /<SlowNote waitingOn="the Schwab option chain" \/>/);
});
