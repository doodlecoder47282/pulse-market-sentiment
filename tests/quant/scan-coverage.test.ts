// Whale scan coverage (shared/scanCoverage.ts): a quiet tape is only stated
// when successful scans covered the hour. Driven through the same reducer the
// engine calls each cycle (recordClosedSkip / recordCycle), then read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_SCAN_RECORD, recordClosedSkip, recordCycle, coverage, whaleCoverageLine, type ScanRecord } from "../../shared/scanCoverage";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
/** Run full cycles every 30 s from `from` to `to`. */
function cycles(r: ScanRecord, from: number, to: number, asked = 15, failed = 0): ScanRecord {
  for (let t = from; t <= to; t += 30_000) r = recordCycle(r, { startedAt: t, endedAt: t + 5_000, asked, failed });
  return r;
}
const w = (type: string, at: number) => ({ type, detectedAt: at });

test("1. market closed: no fresh-scan claim, even right after a clean session", () => {
  let r = cycles(EMPTY_SCAN_RECORD, T0, T0 + 90 * MIN);
  r = recordClosedSkip(r, T0 + 91 * MIN);
  const now = T0 + 91 * MIN + 10_000;
  const cov = coverage(r, true, now);
  assert.equal(cov.state, "closed");
  assert.equal(whaleCoverageLine([], now, cov), "Market closed: whale scan paused; no flow read this hour");
  assert.doesNotMatch(whaleCoverageLine([], now, cov), /^No whale flow/);
  // Alerts from before the close are still counted, with the state named.
  assert.equal(whaleCoverageLine([w("C", now - 5 * MIN)], now, cov), "1 whale this hour, calls leading 1-0 (market closed: whale scan paused)");
});

test("2. every chain request failed: unavailable, not quiet", () => {
  let r = cycles(EMPTY_SCAN_RECORD, T0, T0 + 70 * MIN);
  r = recordCycle(r, { startedAt: T0 + 71 * MIN, endedAt: T0 + 71 * MIN + 4000, asked: 15, failed: 15 });
  const now = T0 + 71 * MIN + 5000;
  const cov = coverage(r, true, now);
  assert.equal(cov.state, "failed");
  assert.equal(whaleCoverageLine([], now, cov), "Whale scan failed: no chain was read; no flow read this hour");
  // A cycle that threw before reading anything (asked 0) is failed too.
  assert.equal(coverage(recordCycle(EMPTY_SCAN_RECORD, { startedAt: T0, endedAt: T0 + 1000, asked: 0, failed: 0 }), true, T0 + 2000).state, "failed");
});

test("3. some requests failed: partial coverage, and the covered run is broken", () => {
  let r = cycles(EMPTY_SCAN_RECORD, T0, T0 + 70 * MIN);
  r = recordCycle(r, { startedAt: T0 + 71 * MIN, endedAt: T0 + 71 * MIN + 4000, asked: 15, failed: 3 });
  const now = T0 + 71 * MIN + 5000;
  const cov = coverage(r, true, now);
  assert.equal(cov.state, "partial");
  assert.equal(r.coveredSince, null);
  assert.equal(r.lastSuccessAt, T0 + 71 * MIN + 4000, "a partial cycle still read something");
  assert.equal(whaleCoverageLine([], now, cov), "Whale scan partial: some symbols failed; no complete flow read this hour");
  // The next clean cycle restarts the covered run from its own start, not from before the gap.
  r = recordCycle(r, { startedAt: T0 + 72 * MIN, endedAt: T0 + 72 * MIN + 4000, asked: 15, failed: 0 });
  assert.equal(r.coveredSince, T0 + 72 * MIN);
  const c2 = coverage(r, true, T0 + 80 * MIN);
  assert.equal(c2.state, "stale", "8 minutes without a cycle is stale");
});

test("4. successful covered scans with zero qualifying alerts: an observed zero; a short run states its own window", () => {
  const r = cycles(EMPTY_SCAN_RECORD, T0, T0 + 61 * MIN);
  const now = T0 + 61 * MIN + 10_000;
  const cov = coverage(r, true, now);
  assert.equal(cov.state, "fresh");
  assert.ok((cov.coveredMinutes ?? 0) >= 60);
  assert.equal(whaleCoverageLine([], now, cov), "No whale flow this hour");
  assert.equal(whaleCoverageLine([w("C", now - 1000), w("C", now - 2000), w("P", now - 3000)], now, cov), "3 whales this hour, calls leading 2-1");
  // Restarted 12 minutes ago: the zero only covers 12 minutes.
  const short = cycles(EMPTY_SCAN_RECORD, T0, T0 + 12 * MIN);
  const sNow = T0 + 12 * MIN + 10_000;
  assert.equal(whaleCoverageLine([], sNow, coverage(short, true, sNow)), "No whale flow in the last 12 min (scan running for 12 min)");
});

test("5. old successful scan: stale; stopped, unknown and failed history reads are named", () => {
  const r = cycles(EMPTY_SCAN_RECORD, T0, T0 + 61 * MIN);
  const now = T0 + 61 * MIN + 10 * MIN;
  const cov = coverage(r, true, now);
  assert.equal(cov.state, "stale");
  assert.equal(whaleCoverageLine([], now, cov), "Whale scan stale; no flow read this hour");
  assert.equal(coverage(r, false, now).state, "not_running");
  assert.equal(coverage(null, true, now).state, "unknown");
  assert.equal(coverage(r, null, now).state, "unknown");
  assert.equal(coverage(EMPTY_SCAN_RECORD, true, now).state, "unknown", "never attempted");
  // An old closed skip does not mask a stale scanner.
  assert.equal(coverage(recordClosedSkip(r, T0), true, now).state, "stale");
  assert.equal(whaleCoverageLine(null, now, { state: "fresh", coveredMinutes: 90 }), "Whale alert history unavailable: the read failed");
});

test("counts are clamped and integral", () => {
  const r = recordCycle(EMPTY_SCAN_RECORD, { startedAt: T0, endedAt: T0 + 1, asked: 5, failed: 9 });
  assert.equal(r.lastFailed, 5);
  assert.equal(coverage(r, true, T0 + 2).state, "failed");
  const n = recordCycle(EMPTY_SCAN_RECORD, { startedAt: T0, endedAt: T0 + 1, asked: 5.7, failed: -2 });
  assert.equal(n.lastAsked, 5); assert.equal(n.lastFailed, 0);
});

test("the engine records every cycle, closed skips included, and the headline reads coverage and a nullable history", () => {
  const eng = readFileSync(new URL("../../server/flowAlertEngine.ts", import.meta.url), "utf8");
  const body = eng.slice(eng.indexOf("if (!isRthNow()) {"), eng.indexOf("// ─── Snapshot for /api/flow/snapshot"));
  assert.match(body, /scanRecord = recordClosedSkip\(scanRecord, lastEvalAt\);\n\s+return;/, "the closed skip is recorded before returning");
  assert.match(body, /if \(error\) cycleErrors\+\+; else readOk\+\+;/);
  assert.match(body, /\} finally \{[\s\S]*scanRecord = recordCycle\(scanRecord, \{ startedAt: t0, endedAt: lastEvalAt, asked, failed: asked - readOk \}\);/, "recorded in finally, so a thrown cycle counts unread symbols as failed");
  assert.match(eng, /scan: \{ \.\.\.scanRecord \},/);
  const h = readFileSync(new URL("../../server/headline.ts", import.meta.url), "utf8");
  assert.match(h, /getWhaleAlertHistoryOrNull\(\{ days: 1, limit: 200 \}\)\)\.catch\(\(\) => null\)/);
  assert.match(h, /whaleCoverageLine\(whaleHist as any\[\] \| null, Date\.now\(\), coverage\(\(flowSnap as any\)\?\.scan/);
  const wp = readFileSync(new URL("../../server/whalePersistence.ts", import.meta.url), "utf8");
  assert.match(wp, /historyReadFailed = true;\n\s+return \[\];/);
});
