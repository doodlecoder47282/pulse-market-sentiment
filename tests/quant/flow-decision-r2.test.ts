// Round-2 workstream C: options flow (sector 4) and decision layer (sector 6).
// Every expected value is hand-computed next to the assertion, or comes from
// a closed form / seeded Monte Carlo named in the comment.
import { test } from "node:test";
import assert from "node:assert/strict";

import { logPcr, pcrReadFromHistory, isCompleteSessionSnapshot, type PcrDay } from "../../server/pcrHistory";
import { volumeOverOiShare, directionScore, openingText } from "../../server/flowIntent";

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);

// ─── 4.5 P/C vs the symbol's own history ─────────────────────────────────────

// calls = 99.5 and puts = 100 r - 0.5 make (P + 0.5)/(C + 0.5) = r exactly.
const day = (date: string, r: number): PcrDay => ({ date, putVol: 100 * r - 0.5, callVol: 99.5 });
const dates = (n: number) => Array.from({ length: n }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`);

test("logPcr: Haldane-Anscombe corrected log ratio; observed zero stays finite, nothing observed is null", () => {
  near(logPcr(0, 1000)!, Math.log(0.5 / 1000.5), 1e-12, "0 puts / 1000 calls");
  near(logPcr(149.5, 99.5)!, Math.log(1.5), 1e-12, "ratio 1.5");
  assert.equal(logPcr(0, 0), null);
  assert.equal(logPcr(null, 10), null);
  assert.equal(logPcr(-1, 10), null);
});

test("pcrReadFromHistory: z-score against own history (hand-computed)", () => {
  // 20 sessions alternating ln r = +0.1 / -0.1: mean 0,
  // sample sd = sqrt(20 x 0.01 / 19) = 0.1025978.
  // Today ln r = 0.2 -> z = 0.2 / 0.1025978 = 1.949359 -> "bearish" (put-heavy for this symbol).
  const hist = dates(20).map((d, i) => day(d, Math.exp(i % 2 === 0 ? 0.1 : -0.1)));
  const r = pcrReadFromHistory({ putVol: 100 * Math.exp(0.2) - 0.5, callVol: 99.5 }, hist, { today: "2026-08-01" });
  assert.equal(r.zone, "bearish");
  assert.equal(r.n, 20);
  near(r.meanLog!, 0, 1e-12, "mean");
  near(r.sdLog!, 0.1025978, 1e-6, "sd");
  near(r.z!, 1.949359, 1e-5, "z");
  near(r.bearishAbove!, Math.exp(0.1025978), 1e-6, "+1 sd edge in ratio units");
  near(r.bullishBelow!, Math.exp(-0.1025978), 1e-6, "-1 sd edge");
  near(r.percentile!, 100, 1e-12, "above every history value");
});

test("pcrReadFromHistory: SPY normally near 1.3 reads NORMAL, where the old fixed 1.05 cut-off said bearish", () => {
  const hist = dates(30).map((d, i) => day(d, 1.3 * Math.exp(((i % 5) - 2) * 0.05)));
  const r = pcrReadFromHistory({ putVol: 129.5, callVol: 99.5 }, hist, { today: "2026-08-01" }); // ratio 1.30
  assert.equal(r.zone, "neutral");
  assert.ok(Math.abs(r.z!) < 0.01, `z ${r.z}`);
});

test("pcrReadFromHistory: below 20 completed sessions -> insufficient_history, never a fixed cut-off", () => {
  const hist = dates(19).map((d) => day(d, 2.0));
  const r = pcrReadFromHistory({ putVol: 399.5, callVol: 99.5 }, hist, { today: "2026-08-01" }); // ratio 4
  assert.equal(r.zone, "insufficient_history");
  assert.equal(r.n, 19);
  assert.equal(r.z, null);
});

test("pcrReadFromHistory: today and later sessions are excluded (no look-ahead); missing volume is unavailable", () => {
  const hist = [...dates(19).map((d) => day(d, 1)), day("2026-08-01", 5), day("2026-08-02", 5)];
  const r = pcrReadFromHistory({ putVol: 99.5, callVol: 99.5 }, hist, { today: "2026-08-01" });
  assert.equal(r.zone, "insufficient_history");
  assert.equal(r.n, 19);
  const u = pcrReadFromHistory(null, dates(30).map((d) => day(d, 1)), { today: "2026-08-01" });
  assert.equal(u.zone, "unavailable");
});

test("pcrReadFromHistory: an observed-zero put day is a real reading (call-heavy), not missing", () => {
  const hist = dates(20).map((d, i) => day(d, Math.exp(i % 2 === 0 ? 0.1 : -0.1)));
  const r = pcrReadFromHistory({ putVol: 0, callVol: 5000 }, hist, { today: "2026-08-01" });
  assert.equal(r.zone, "bullish");
  assert.ok(r.z! < -40);
});

test("isCompleteSessionSnapshot: last 10 minutes of the session or after the close", () => {
  const close = Date.UTC(2026, 6, 1, 20, 0); // 16:00 EDT
  assert.equal(isCompleteSessionSnapshot(close - 11 * 60_000, close), false);
  assert.equal(isCompleteSessionSnapshot(close - 10 * 60_000, close), true);
  assert.equal(isCompleteSessionSnapshot(close + 3600_000, close), true);
  assert.equal(isCompleteSessionSnapshot(close, null), false);
});

// ─── 4.6 opening share from volume vs prior-day OI ──────────────────────────

test("volumeOverOiShare: lower bound on opening share = 1 - OI_prev / V (hand-computed)", () => {
  // 1,500 traded vs 100 open yesterday: at most 100 can be closes of old
  // contracts, so >= 1,400 / 1,500 = 0.93333 are opening (no same-day round trips).
  near(volumeOverOiShare(1500, 100)!, 1400 / 1500, 1e-12, "15x");
  assert.equal(volumeOverOiShare(300, 0), 1);         // new strike: nothing to close
  assert.equal(volumeOverOiShare(50, 100), 0);        // volume within OI: no bound
  assert.equal(volumeOverOiShare(0, 100), null);      // no volume: nothing to say
  assert.equal(volumeOverOiShare(100, NaN), null);    // OI unknown: missing, not 0
});

test("directionScore: hand-set heuristic, reported as a 0-1 score", () => {
  // 0.93333 x 0.9 (ask-side last print) = 0.84; x 0.5 spread-leg discount = 0.42
  assert.equal(directionScore(1400 / 1500, "AT_ASK", false), 0.84);
  assert.equal(directionScore(1400 / 1500, "AT_ASK", true), 0.42);
  assert.equal(directionScore(1, "MID", false), 0.55);
  assert.equal(directionScore(null, "AT_ASK", false), null);
  assert.ok(!openingText(0.9333)!.includes("probab"));
  assert.match(openingText(0.9333)!, /opening >= 93% of vol/);
});
