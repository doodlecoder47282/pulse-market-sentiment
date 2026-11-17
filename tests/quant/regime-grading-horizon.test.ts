// A regime call is graded on the event it forecast: the realised $SPX path over
// the called horizon, from stored 1-minute bars. Missing inputs make the
// predictor say so instead of reading a zero as neutral.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gradeRegimeCallOnPath, horizonThreshold, bucketOf, DAILY_PROXY_PCT } from "../../shared/regimeGrade";
import { predictTransition, _resetPredictorHistory } from "../../server/regimePredictor";

const OPEN = Date.parse("2026-11-06T14:30:00Z"); // 09:30 ET
const CLOSE = OPEN + 390 * 60_000;
const bars = (f: (m: number) => number) => Array.from({ length: 390 }, (_, m) => ({ t: OPEN + m * 60_000, close: f(m) }));

test("threshold scales the daily 0.5% proxy by the square-root rule", () => {
  assert.ok(Math.abs(horizonThreshold(390) - DAILY_PROXY_PCT) < 1e-12);
  assert.ok(Math.abs(horizonThreshold(20) - 0.005 * Math.sqrt(20 / 390)) < 1e-12);
  assert.equal(bucketOf("TREND_STRONG"), "trend");
  assert.equal(bucketOf("CHOP_WEAK"), "chop");
  assert.equal(bucketOf(null), "neutral");
});

test("grades over the called horizon, not a day later; trend hits on a net move, chop hits when it stays inside", () => {
  // Drift of 0.02%/min: 20 min -> 0.4% net move (threshold 0.113%).
  const trending = bars((m) => 6000 * (1 + 0.0002 * m));
  const t0 = OPEN + 60 * 60_000;
  const g = gradeRegimeCallOnPath(trending, t0, 20, "TREND_WEAK", CLOSE);
  assert.equal(g.result, "ok");
  assert.equal(g.coveredMinutes, 20, "exit bar is the horizon end, not the next session");
  // No look-ahead: the entry bar closed at or before the call, the exit bar at or before the horizon end.
  assert.ok(g.entryT! + 60_000 <= t0 && g.exitT! + 60_000 <= t0 + 20 * 60_000);
  assert.ok(g.absMovePct! > g.threshold!);
  assert.equal(g.regimeMatch, 1);
  assert.equal(gradeRegimeCallOnPath(trending, t0, 20, "CHOP_STRONG", CLOSE).regimeMatch, 0);
  // Oscillation that nets to nothing: chop hits, trend misses.
  const choppy = bars((m) => 6000 + 3 * Math.sin(m / 2));
  assert.equal(gradeRegimeCallOnPath(choppy, t0, 20, "CHOP_STRONG", CLOSE).regimeMatch, 1);
  assert.equal(gradeRegimeCallOnPath(choppy, t0, 20, "TREND_STRONG", CLOSE).regimeMatch, 0);
  assert.equal(gradeRegimeCallOnPath(choppy, t0, 20, "NEUTRAL", CLOSE).regimeMatch, 1);
});

test("a horizon past the close is truncated to the last bar and marked; missing bars are insufficient, never a 0% move", () => {
  const b = bars((m) => 6000 + m * 0.5);
  const late = OPEN + 380 * 60_000; // 15:50 ET, 20-min horizon runs past the close
  const g = gradeRegimeCallOnPath(b, late, 20, "TREND_WEAK", CLOSE);
  assert.equal(g.result, "ok");
  assert.equal(g.truncatedAtClose, true);
  assert.equal(g.exitT, CLOSE - 60_000);
  assert.equal(g.coveredMinutes, 10, "last completed bar before the call (15:49) to the last bar of the session (15:59)");
  // No bars near the call: insufficient.
  const sparse = b.filter((x) => x.t < OPEN + 30 * 60_000);
  const miss = gradeRegimeCallOnPath(sparse, OPEN + 60 * 60_000, 20, "TREND_WEAK", CLOSE);
  assert.equal(miss.result, "insufficient_history");
  assert.equal(miss.movePct, null);
  assert.equal(miss.regimeMatch, null);
  // Bars present at entry but not at the horizon end: insufficient.
  const half = b.filter((x) => x.t < OPEN + 70 * 60_000);
  assert.equal(gradeRegimeCallOnPath(half, OPEN + 60 * 60_000, 20, "TREND_WEAK", CLOSE).result, "insufficient_history");
  assert.equal(gradeRegimeCallOnPath([], OPEN, 20, "TREND_WEAK", CLOSE).result, "insufficient_history");
});

test("wiring: the logger grades on minute bars over the horizon; edge stats exclude the old proxy and label the axis", () => {
  const o = readFileSync(new URL("../../server/outcomeLogger.ts", import.meta.url), "utf8");
  assert.match(o, /gradingDueAt = p\.capturedAt \+ Math\.max\(5, Math\.min\(120, p\.horizonMinutes \|\| 20\)\) \* 60_000 \+ 5 \* 60_000;/);
  assert.match(o, /SELECT t, close FROM spx_minute_bars WHERE t >= \? AND t <= \? ORDER BY t/);
  assert.match(o, /gradeRegimeCallOnPath\(bars, capturedAt, horizonMinutes, pred\.topCandidate \?\? pred\.regime, sessionCloseMs\)/);
  assert.doesNotMatch(o, /26 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(o, /function closeOnOrBefore/);
  const e = readFileSync(new URL("../../server/edgeStats.ts", import.meta.url), "utf8");
  assert.match(e, /const graded = gradedAll\.filter\(isHorizonGraded\);/);
  assert.match(e, /legacyProxyGraded/);
  assert.match(e, /the plotted x-axis is the predictor's heuristic score, not a probability/);
  const c = readFileSync(new URL("../../client/src/components/EdgeStatsPanel.tsx", import.meta.url), "utf8");
  assert.match(c, /heuristic score \(not a probability\)/);
  assert.match(c, /graded under the earlier close-to-close proxy, excluded/);
});

test("predictor: a missing pivot or EM is degraded with no candidates, no confidence, no proximity driver; the DEX slope sign is not a regime input", () => {
  const base = { spot: 6000, horizonMinutes: 20, nowMs: Date.parse("2026-11-06T16:00:00Z") };
  _resetPredictorHistory();
  // The DEX slope could not be read (dfiState unavailable). DFI is retired: the regime is keyed on the
  // gamma zone, so there is still a reading, and the sign is reported as unavailable, not as a zero.
  const a = predictTransition({ ...base, audit: { dfi: 0, dfiState: "unavailable", gammaZone: "y+", slope: "UP 0.2 -> 0.3", mainPivot: 6010, gammaFlip: 6010, scenarioTargets: { oneDayEM: 40 } } } as any);
  assert.equal(a.currentRegime, "CHOP_WEAK");
  assert.equal(a.drivers.dexSlopeSign, "unavailable");
  assert.equal(a.drivers.dfi, null);
  assert.equal(a.drivers.dfiSlopePerMin, null);
  assert.ok(a.candidates.length > 0);
  assert.doesNotMatch(a.headline, /DFI/);
  // No gamma zone in the audit at all: inputs unavailable, no candidates, nothing for the logger.
  const none = predictTransition({ ...base, audit: { mainPivot: 6010, scenarioTargets: { oneDayEM: 40 } } } as any);
  assert.equal(none.currentRegime, "INPUTS_UNAVAILABLE");
  assert.equal(none.status, "degraded");
  assert.deepEqual(none.candidates, []);
  assert.equal(none.confidence, 0, "below the logger's 0.3 floor: nothing is recorded");
  // No pivot and no EM: degraded, and no pivot-distance note from nothing.
  const b = predictTransition({ ...base, audit: { dfi: 1, dfiState: "ok", gammaZone: "y+", slope: "UP 0.2 -> 0.3" } } as any);
  assert.equal(b.status, "degraded");
  assert.deepEqual(b.candidates, []);
  assert.equal(b.confidence, 0);
  assert.match(b.headline, /main pivot, 1-day expected move not available/);
  assert.ok(!b.driverNotes.some((n) => /main pivot|charm zero/.test(n)), b.driverNotes.join(" | "));
  // The callers that feed the history pass the regime only, never a DFI number (and no spot series:
  // no flip-distance projection is made).
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(r, /recordRawRegime\(out\.diag\.regimeRaw as any\);/);
  assert.match(r, /if \(rawNow\) recordRawRegime\(rawNow\);/);
  assert.doesNotMatch(r, /Number\(daily\.audit\?\.dfi \?\? 0\)|Number\(daily\.audit\.dfi\)/);
  assert.match(readFileSync(new URL("../../shared/gammaRegime.ts", import.meta.url), "utf8"), /if \(gammaZone == null\) return "INPUTS_UNAVAILABLE";/);
  assert.match(readFileSync(new URL("../../server/headline.ts", import.meta.url), "utf8"), /currentRegime === "INPUTS_UNAVAILABLE" && typeof \(models as any\)\?\.headline === "string"/);
  assert.ok(Number.isNaN(b.drivers.gammaFlipProxFrac));
  // All inputs present: a reading as before.
  const c = predictTransition({ ...base, audit: { dfi: 1, dfiState: "ok", gammaZone: "y+", slope: "UP 0.2 -> 0.3", mainPivot: 6010, gammaFlip: 6010, scenarioTargets: { oneDayEM: 40 } } } as any);
  assert.equal(c.currentRegime, "CHOP_WEAK");
  assert.ok(c.candidates.length > 0);
});
