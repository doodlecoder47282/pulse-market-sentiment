// Round-3 workstream R3-2: flow (sector 4) and decision layer (sector 6).
// Every expected value is hand-computed next to the assertion.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pcrReadFromHistory, type PcrDay } from "../../server/pcrHistory";
import { hasPcrBands, pcrBandTone } from "../../shared/pcrBands";
import {
  MIN_SERIES_SAMPLES, LAST_SAMPLE_MAX_AGE_MS, aggressorStateOf, currentVolumes,
  isFreshChain, seriesFrom, shouldAppendSample,
} from "../../server/flowIntradayState";

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

// ─── Item 1: P/C colour bands from the symbol's own history ─────────────────

// calls = 99.5 and puts = 100 r - 0.5 make (P + 0.5)/(C + 0.5) = r exactly.
const day = (date: string, r: number): PcrDay => ({ date, putVol: 100 * r - 0.5, callVol: 99.5 });

test("R3-2.1 bands are exp(mean -+ sd) of the history, not fixed 0.75 / 1.05", () => {
  // 20 sessions alternating r = 0.8 and 1.25: ln r = -+0.223144, mean 0,
  // sample sd = 0.223144 * sqrt(20/19) = 0.228940.
  // bullishBelow = exp(-0.228940) = 0.795376, bearishAbove = exp(0.228940) = 1.257267.
  const hist = Array.from({ length: 20 }, (_, i) => day(`2026-07-${String(i + 1).padStart(2, "0")}`, i % 2 ? 1.25 : 0.8));
  const r = pcrReadFromHistory({ putVol: 99.5, callVol: 99.5 }, hist, { today: "2026-08-01" });
  near(r.bullishBelow!, 0.795376, 1e-6, "bullishBelow");
  near(r.bearishAbove!, 1.257267, 1e-6, "bearishAbove");
  assert.ok(hasPcrBands(r));
  // 0.78 is call-heavy for THIS symbol (below 0.7954) although the old fixed
  // rule (< 0.75) called it neutral; 1.10 is normal here although the old
  // rule (> 1.05) called it bearish.
  assert.equal(pcrBandTone(0.78, r), "bullish");
  assert.equal(pcrBandTone(1.10, r), "neutral");
  assert.equal(pcrBandTone(1.26, r), "bearish");
  // Edges are inclusive, as z <= -1 / z >= +1.
  assert.equal(pcrBandTone(r.bullishBelow, r), "bullish");
  assert.equal(pcrBandTone(r.bearishAbove, r), "bearish");
});

test("R3-2.1 no history -> no bands, the value is not coloured as a zone", () => {
  const r = pcrReadFromHistory({ putVol: 100, callVol: 100 }, [day("2026-07-01", 1)], { today: "2026-08-01" });
  assert.equal(r.zone, "insufficient_history");
  assert.equal(hasPcrBands(r), false);
  assert.equal(pcrBandTone(0.5, r), "no_bands");
  assert.equal(pcrBandTone(2.0, r), "no_bands");
  assert.equal(pcrBandTone(null, { bullishBelow: 0.8, bearishAbove: 1.2 }), "no_bands");
  assert.equal(pcrBandTone(1, undefined), "no_bands");
  // Malformed band (inverted) is treated as no band.
  assert.equal(pcrBandTone(1, { bullishBelow: 1.2, bearishAbove: 0.8 }), "no_bands");
});

// ─── Item 2: observed-only intraday series ──────────────────────────────────

const fresh = { read: true, stale: false, callVol: 1000, putVol: 800 };
const stale = { read: true, stale: true, callVol: 1000, putVol: 800 };
const failed = { read: false, stale: false, callVol: 0, putVol: 0 };

test("R3-2.2 only fresh chains append samples", () => {
  assert.equal(isFreshChain(fresh), true);
  assert.equal(isFreshChain(stale), false);
  assert.equal(isFreshChain(failed), false);
  assert.equal(shouldAppendSample(fresh, null, 1000), true);
  assert.equal(shouldAppendSample(fresh, 1000, 1054), false); // < 55 s spacing
  assert.equal(shouldAppendSample(fresh, 1000, 1055), true);
  assert.equal(shouldAppendSample(stale, null, 1000), false);
  assert.equal(shouldAppendSample(failed, null, 1000), false);
  // An observed zero from a fresh chain is a sample (pre-open: 0 contracts traded).
  assert.equal(shouldAppendSample({ read: true, stale: false, callVol: 0, putVol: 0 }, null, 1000), true);
});

test("R3-2.2 fewer than MIN_SERIES_SAMPLES -> empty series, insufficient_samples (no synthesis)", () => {
  assert.equal(MIN_SERIES_SAMPLES, 2);
  const one = seriesFrom([{ t: 1 }]);
  assert.deepEqual(one.series, []);
  assert.equal(one.seriesState, "insufficient_samples");
  assert.match(one.seriesReason!, /1 of 2/);
  const two = seriesFrom([{ t: 1 }, { t: 2 }]);
  assert.equal(two.series.length, 2);
  assert.equal(two.seriesState, "ok");
  assert.equal(two.seriesReason, null);
});

test("R3-2.2 current volumes: live / last_sample within max age / unavailable as null", () => {
  const live = currentVolumes(fresh, null, 5000);
  assert.deepEqual(live, { callVol: 1000, putVol: 800, pcr: 0.8, volumeState: "live", volumeAsOf: 5000 });
  // Observed zero stays zero, with pcr null (undefined ratio), still live.
  const zero = currentVolumes({ read: true, stale: false, callVol: 0, putVol: 0 }, null, 5000);
  assert.equal(zero.callVol, 0);
  assert.equal(zero.volumeState, "live");
  assert.equal(zero.pcr, null);
  const last = { t: 5000, callVolume: 400, putVolume: 600 };
  const maxS = LAST_SAMPLE_MAX_AGE_MS / 1000; // 300 s
  const reuse = currentVolumes(stale, last, 5000 + maxS);
  assert.deepEqual(reuse, { callVol: 400, putVol: 600, pcr: 1.5, volumeState: "last_sample", volumeAsOf: 5000 });
  const tooOld = currentVolumes(failed, last, 5000 + maxS + 1);
  assert.deepEqual(tooOld, { callVol: null, putVol: null, pcr: null, volumeState: "unavailable", volumeAsOf: null });
  assert.equal(currentVolumes(failed, null, 5000).volumeState, "unavailable");
});

test("R3-2.2 side breakdown re-used only within the same max age", () => {
  assert.equal(aggressorStateOf(true, null, 100), "live");
  assert.equal(aggressorStateOf(false, 100, 400), "cached");
  assert.equal(aggressorStateOf(false, 100, 401), "unavailable");
  assert.equal(aggressorStateOf(false, null, 100), "unavailable");
});
