// Market closed: the Flow tab never says "live" or "stale" for the settled
// last-session chain and tape, and never dates an alert by the poll time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ofiApiPayload } from "../../server/ofiPayload";

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("OFI payload: closed session is the last-session tape, not stale; open session keeps the 5-min rule", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ ts: Date.UTC(2026, 10, 6, 20, 40 + i), signedVolume: 100, cumulative: 100 * (i + 1), volumeMissing: false }));
  const trend = { bars, cumulativeNow: 2000, slope15m: 10, slope5m: 5, trend: "BULLISH" as const, acceleration: "FLAT" as const, dataState: "ok" as const };
  const sat = Date.UTC(2026, 10, 7, 17, 0); // Saturday noon ET
  const closed = ofiApiPayload(trend, sat, false);
  assert.equal(closed.sessionOpen, false);
  assert.equal(closed.lastSession, true);
  assert.equal(closed.asOfMs, bars[19].ts, "data time stays the last bar, not the request");
  const open = ofiApiPayload(trend, Date.UTC(2026, 10, 6, 20, 59), true);
  assert.equal(open.lastSession, false);
  // No bars: nothing to call a last session.
  assert.equal(ofiApiPayload({ ...trend, bars: [] }, sat, false).lastSession, false);
});

test("wiring: histogram, Put/Call badge and flow alerts read the closed state", () => {
  const h = src("client/src/components/OfiHistogram.tsx");
  assert.match(h, /const closed = data\.lastSession === true;/);
  assert.match(h, /const tapeStale = !closed && effectiveDataState/);
  assert.match(h, /maxAgeMs=\{closed \? null : OFI_MAX_AGE_MS\}/);
  assert.match(h, /last session's tape: closed \$\{data\.trend\.toLowerCase\(\)\}/);
  const f = src("client/src/components/FlowPanel.tsx");
  assert.match(f, /<LivenessBadge feedName="flow" value=\{agg\.combinedPcr\} stale=\{data\.indexGroup\.some\(\(t\) => t\.chainStale === true\)\} lastSession=\{data\.indexGroup\.some\(\(t\) => t\.chainLastSession === true\)\}/);
  assert.match(src("server/flow.ts"), /chainLastSession = chain\.lastSession === true;/);
  const a = src("client/src/components/FlowAlertsPanel.tsx");
  assert.match(a, /chainAsOfMs: number = Date\.now\(\),\s*\): FlowAlert\[\] \{\s*const alerts: FlowAlert\[\] = \[\];\s*const now = chainAsOfMs;/);
  assert.match(a, /Number\.isFinite\(chainData\.asOfMs\) \? chainData\.asOfMs : Date\.now\(\),/);
  assert.match(a, /CLOSED · LAST SESSION/);
  assert.match(a, /refetchInterval: chainClosed \? 10 \* 60_000 : 30_000,/);
});
