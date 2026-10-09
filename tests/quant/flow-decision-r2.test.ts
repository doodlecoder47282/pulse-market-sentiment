// Round-2 workstream C: options flow (sector 4) and decision layer (sector 6).
// Every expected value is hand-computed next to the assertion, or comes from
// a closed form / seeded Monte Carlo named in the comment.
import { test } from "node:test";
import assert from "node:assert/strict";

import { logPcr, pcrReadFromHistory, isCompleteSessionSnapshot, type PcrDay } from "../../server/pcrHistory";
import { volumeOverOiShare, directionScore, openingText } from "../../server/flowIntent";
import { scoreAskToBid, buildScoreboardRow, netGroupStats, netReturnOnCost } from "../../server/whaleScoreboard";
import { firstPassage, projectToTarget } from "../../server/t1Projection";
import { bsPrice, delta as bsDelta, gamma as bsGamma } from "../../server/greeks";
import { cdf } from "../../server/stats";
import { modelThetaToClose } from "../../server/chainClock";
import { liquidationReturn, entryFillOf, optionStopHit, spreadExceedsStop, optionStopLevel } from "../../server/exitValuation";
import { feeForProduct } from "../../server/feeConfig";
import { classifyEnvState } from "../../server/tradeEnvState";
import { cumulativeAt, pcrReadAtClock } from "../../server/pcrHistory";
import { contractsFromAsk, atmContractFrom } from "../../server/masterAlphaFit";
import { atmPathSigma, noTouchExpectation } from "../../server/t1Projection";
import { invert, olsClustered, fitConvexityWeights, forwardRange, CONVEXITY_DRIVERS, type ConvexitySample } from "../../server/convexityFit";
import { masterAlphaPromotionGate, promotedForecastBps, resolveMasterAlphaRiskBudget, type MasterAlphaPromotion } from "../../server/masterAlphaFit";

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

// ─── Whale scoreboard and backtest on tradable prices, net of fees ───────────

test("scoreAskToBid: ask in, bid out, $0.65/side (hand-computed dollars)", () => {
  // ask 2.00 -> bid 2.50: gross (2.50 - 2.00) x 100 = $50.00, fees 2 x 0.65 = $1.30,
  // net $48.70 per contract; cash paid 200 + 0.65 = $200.65; return 48.70 / 200.65 = 0.2427112.
  const t = scoreAskToBid({ entryAsk: 2.0, exitBid: 2.5, feePerContract: 0.65 })!;
  assert.equal(t.pnlPerContract, 48.7);
  near(t.netReturn, 48.7 / 200.65, 1e-12, "net return");
  assert.equal(t.win, true);
  // Mid to mid this trade (1.95/2.05 in, 2.15/2.25 out) read +10%; on tradable prices:
  // (2.15 - 2.05) x 100 - 1.30 = $8.70 on $205.65 paid = +4.2305%.
  const m = scoreAskToBid({ entryBid: 1.95, entryAsk: 2.05, exitBid: 2.15, feePerContract: 0.65 })!;
  assert.equal(m.pnlPerContract, 8.7);
  near(m.netReturn, 8.7 / 205.65, 1e-12, "vs +10% mid to mid");
});

test("scoreAskToBid: a gross winner that loses after fees is a LOSS; worthless expiry pays one fee", () => {
  // ask 2.00 -> bid 2.01: gross +$1.00, fees $1.30 -> net -$0.30: loss.
  const t = scoreAskToBid({ entryAsk: 2.0, exitBid: 2.01, feePerContract: 0.65 })!;
  assert.equal(t.pnlPerContract, -0.3);
  assert.equal(t.win, false);
  // bid 0: no closing trade, one fee: -200 - 0.65 = -$200.65 = -100% of cash paid.
  const z = scoreAskToBid({ entryAsk: 2.0, exitBid: 0, feePerContract: 0.65 })!;
  assert.equal(z.pnlPerContract, -200.65);
  near(z.netReturn, -1, 1e-12, "total loss");
  assert.equal(z.settled, true);
  // Missing quotes are not scored (never a 0% result); a crossed entry quote is unusable.
  assert.equal(scoreAskToBid({ entryAsk: null, exitBid: 1, feePerContract: 0.65 }), null);
  assert.equal(scoreAskToBid({ entryAsk: 2, exitBid: null, feePerContract: 0.65 }), null);
  assert.equal(scoreAskToBid({ entryBid: 2.2, entryAsk: 2, exitBid: 1, feePerContract: 0.65 }), null);
  // SF-2: index root without a configured fee -> not scored (no guessed fee).
  assert.equal(scoreAskToBid({ entryAsk: 2, exitBid: 2.5, feePerContract: null }), null);
});

test("buildScoreboardRow / netGroupStats: wins counted net, the same basis as $ P&L", () => {
  const a = scoreAskToBid({ entryAsk: 2.0, exitBid: 2.5, feePerContract: 0.65 })!;   // +48.70
  const b = scoreAskToBid({ entryAsk: 2.0, exitBid: 2.01, feePerContract: 0.65 })!;  // -0.30 (gross winner)
  const c = scoreAskToBid({ entryAsk: 2.0, exitBid: 0, feePerContract: 0.65 })!;     // -200.65
  const row = buildScoreboardRow("whale", [
    { trade: a, peakNetReturn: 0.6 },
    { trade: b, peakNetReturn: 0.55 },   // peak >= +50% then closed <= 0: a burn
    { trade: c, peakNetReturn: null },   // peak bid not logged: not evaluated for burns
  ], 2);
  assert.equal(row.wins, 1);
  assert.equal(row.losses, 2);
  near(row.winRate, 1 / 3, 1e-12, "win rate");
  assert.equal(row.burns, 1);
  assert.equal(row.burnsEvaluated, 2);
  assert.equal(row.excludedNoQuote, 2);
  // mean $ per contract: (48.70 - 0.30 - 200.65) / 3 = -50.75
  assert.equal(row.avgPnlPerContract, -50.75);
  const g = netGroupStats([
    { netPctReturn: a.netReturn, pnlPerContract: a.pnlPerContract, dollarPnl: 97.4 },
    { netPctReturn: b.netReturn, pnlPerContract: b.pnlPerContract, dollarPnl: -0.6 },
    { netPctReturn: c.netReturn, pnlPerContract: c.pnlPerContract, dollarPnl: -401.3 },
  ]);
  assert.equal(g.winners, 1);
  assert.equal(g.losers, 2);
  near(g.medianPctReturn, -0.3 / 200.65, 1e-12, "median net");
  assert.equal(g.totalDollarPnl, -304.5);
  near(netReturnOnCost(48.7, 2.0, 0.65)!, 48.7 / 200.65, 1e-12, "netReturnOnCost");
  assert.equal(netReturnOnCost(null, 2.0, 0.65), null);
});

// ─── 6.7 / R2-C 7: T1 projection by repricing at the target ───────────────────

// Seeded uniform RNG (mulberry32) and Box-Muller normals for reproducible MC.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("firstPassage: closed form = numerical integral of the first-passage density", () => {
  // Density f(t) = a / sqrt(2 pi t^3) exp(-a^2 / 2t) (reflection principle).
  // P(tau <= T) = int_0^T f, E[tau; tau <= T] = int_0^T t f; Simpson with 20,000 panels.
  const sigma = 0.15, T = 240 / 525600, d = Math.log(6715 / 6700);
  const a = d / sigma;
  const f = (t: number) => (t <= 0 ? 0 : (a / Math.sqrt(2 * Math.PI * t ** 3)) * Math.exp(-(a * a) / (2 * t)));
  const N = 20000, h = T / N;
  let p = 0, m = 0;
  for (let i = 0; i <= N; i++) {
    const t = i * h, w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
    p += w * f(t); m += w * t * f(t);
  }
  p *= h / 3; m *= h / 3;
  const fp = firstPassage(d, sigma, T)!;
  // Reference: P = 2 (1 - Phi(a / sqrt T)) = 2 (1 - Phi(0.697701)) = 0.485355
  near(fp.pHit, 2 * (1 - cdf(a / Math.sqrt(T))), 1e-12, "closed form P");
  near(fp.pHit, p, 2e-6, "P vs integral");
  near(fp.condMeanYears, m / p, 1e-6 * T, "E[tau | hit] vs integral");
  near(fp.pHit, 0.485355, 2e-5, "P hand value");
  // Already at the level: touch now.
  assert.deepEqual(firstPassage(0, sigma, T), { pHit: 1, condMeanYears: 0 });
  assert.equal(firstPassage(d, 0, T), null);
});

test("firstPassage: seeded Monte Carlo (Brownian-bridge crossing) agrees within tolerance", () => {
  // 20,000 paths, 400 steps, crossing inside a step detected with the bridge
  // probability exp(-2 (a - x0)(a - x1) / (sigma^2 dt)) (Glasserman, Monte Carlo
  // Methods in Financial Engineering, sec. 6.4); the touch time is taken at the
  // step midpoint, so E[tau] carries O(dt) bias, well inside the tolerance.
  const sigma = 0.15, T = 240 / 525600, d = Math.log(6715 / 6700);
  const rng = mulberry32(20261008);
  const steps = 400, dt = T / steps, sd = sigma * Math.sqrt(dt);
  let hits = 0, sumTau = 0;
  const paths = 20000;
  for (let k = 0; k < paths; k++) {
    let x = 0;
    for (let i = 0; i < steps; i++) {
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      const x1 = x + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const cross = x1 >= d || rng() < Math.exp((-2 * (d - x) * (d - x1)) / (sigma * sigma * dt));
      if (cross) { hits++; sumTau += (i + 0.5) * dt; break; }
      x = x1;
    }
  }
  const fp = firstPassage(d, sigma, T)!;
  const pMc = hits / paths;
  near(pMc, fp.pHit, 4 * Math.sqrt(fp.pHit * (1 - fp.pHit) / paths), "P(hit) MC, 4 se");
  near(sumTau / hits, fp.condMeanYears, 0.05 * fp.condMeanYears, "E[tau | hit] MC within 5%");
});

test("projectToTarget: equals Black-Scholes repricing at T1 averaged over the touch-time density, net of half spread and fees", () => {
  // 2026-07-15 12:00 ET (16:00 UTC), SPXW 6705 call, PM settlement 16:00 ET: T = 240 min.
  const nowMs = Date.UTC(2026, 6, 15, 16, 0);
  const T = 240 / 525600, sigma = 0.15, S = 6700, K = 6705, H = 6715;
  const p = bsPrice(S, K, sigma, T, 0, 0, "C");
  const bid = Math.round((p - 0.05) * 100) / 100, ask = Math.round((p + 0.05) * 100) / 100;
  const r = projectToTarget({ spot: S, strike: K, type: "C", target: H, expiry: "2026-07-15", symbol: "SPXW", bid, ask, vendorIv: 0.2, minutesToClose: 240, nowMs, feePerContract: 0.65 })!;
  // sigma re-solved from the mid on our clock: ~0.15.
  const sig = r.sigma;
  near(sig, sigma, 2e-3, "solved sigma");
  // Independent closed form for E[tau | tau <= T].
  const a = Math.log(H / S) / sig;
  const P = 2 * (1 - cdf(a / Math.sqrt(T)));
  const tau = (a * Math.sqrt(2 * T / Math.PI) * Math.exp(-(a * a) / (2 * T)) - a * a * P) / P;
  // The module adds the risk-neutral log drift -sigma^2/2; over 4 hours it moves E[tau | hit] by < 0.01 min.
  near(r.minutesToTarget, tau * 525600, 0.01, "minutes to T1");
  const mid = (bid + ask) / 2;
  // N-1: E[BS(H, T - t) | touch] by an independent midpoint rule on a plain
  // t grid (200,000 cells) with the first-passage density; the module uses
  // Simpson on t = T u^2.
  // Drifted first-passage density (nu = -sigma^2/2, Shreve II sec. 7.2); its own mass is the touch probability.
  const nu = -0.5 * sig * sig, dd = Math.log(H / S);
  const f = (t: number) => (dd / (sig * Math.sqrt(2 * Math.PI * t ** 3))) * Math.exp(-((dd - nu * t) ** 2) / (2 * sig * sig * t));
  const N = 200000, h = T / N;
  let num = 0, mass = 0;
  for (let i = 0; i < N; i++) { const t = (i + 0.5) * h; num += bsPrice(H, K, sig, T - t, 0, 0, "C") * f(t) * h; mass += f(t) * h; }
  near(r.pHit, mass, 1e-5, "touch probability = density mass");
  const projMid = mid + num / mass - bsPrice(S, K, sig, T, 0, 0, "C");
  const exitBid = projMid - (ask - bid) / 2;
  const want = (exitBid * 100 - 0.65 - (ask * 100 + 0.65)) / (ask * 100 + 0.65);
  near(r.projectedMid, projMid, 2e-4, "projected mid (averaged)");
  near(r.projReturnPct, want, 1e-4, "return vs direct repricing");
  // The plug-in at the mean touch time differs by little here, but it is not what is reported.
  const plug = mid + bsPrice(H, K, sig, T - tau, 0, 0, "C") - bsPrice(S, K, sig, T, 0, 0, "C");
  assert.ok(Math.abs(plug - r.projectedMid) < 0.5, `plug-in ${plug} vs averaged ${r.projectedMid}`);
  assert.equal(r.gateTests, "return_if_t1_reached");
  assert.ok(r.projThetaCost < 0 && r.spreadCost > 0 && r.feesPerContract === 1.3);
  // Decomposition adds up: mid + delta + gamma + theta = projected mid.
  near(mid + r.projDeltaPnl + r.projGammaBoost + r.projThetaCost, r.projectedMid, 2e-3, "decomposition");
});

test("projectToTarget: the old time-now Greeks + full decay to the close read far lower (Gate 3 bias)", () => {
  const nowMs = Date.UTC(2026, 6, 15, 16, 0);
  const T = 240 / 525600, S = 6700, K = 6705, H = 6715;
  const p = bsPrice(S, K, 0.15, T, 0, 0, "C");
  const bid = Math.round((p - 0.05) * 100) / 100, ask = Math.round((p + 0.05) * 100) / 100;
  const r = projectToTarget({ spot: S, strike: K, type: "C", target: H, expiry: "2026-07-15", bid, ask, vendorIv: 0.15, minutesToClose: 240, nowMs, feePerContract: 0.65 })!;
  // Old: |delta| x move + 0.5 gamma move^2 + theta to the close (= minus the extrinsic at spot).
  const sig = r.sigma, move = H - S;
  const theta = modelThetaToClose({ spot: S, strike: K, type: "C", expiry: "2026-07-15", bid, ask, vendorIv: 0.15, minutesToClose: 240, nowMs })!;
  const old = (Math.abs(bsDelta(S, K, sig, T, 0, 0, "C")) * move + 0.5 * bsGamma(S, K, sig, T, 0, 0) * move * move + theta) / ask;
  assert.ok(r.projReturnPct - old > 0.15, `new ${r.projReturnPct.toFixed(3)} vs old ${old.toFixed(3)}`);
});

test("projectToTarget: unavailable without a two-sided quote or after settlement (never a silent pass)", () => {
  const nowMs = Date.UTC(2026, 6, 15, 16, 0);
  const base = { spot: 6700, strike: 6705, type: "C" as const, target: 6715, expiry: "2026-07-15", vendorIv: 0.15, minutesToClose: 240, nowMs };
  assert.equal(projectToTarget({ ...base, bid: null, ask: 10 }), null);
  assert.equal(projectToTarget({ ...base, bid: 11, ask: 10 }), null);
  assert.equal(projectToTarget({ ...base, bid: 9, ask: 10, nowMs: Date.UTC(2026, 6, 15, 21, 0) }), null);
});

// ─── 6.6 exit brain on the bid, net of the exit fee ─────────────────────────

test("liquidationReturn: sold at the bid after the exit fee, on cash paid incl. the entry fee (hand-computed)", () => {
  // Bought at the ask 5.00, fee $0.65/side: cost 500.65. Quote 4.10 x 4.30 (mid 4.20).
  // Mid-based drawdown: (4.20 - 5.00)/5.00 = -16.0% -> the old -20% stop would NOT fire.
  // At the bid: 410 - 0.65 = 409.35; (409.35 - 500.65)/500.65 = -18.236%.
  const l = liquidationReturn({ entryFill: 5.0, bid: 4.1, feePerContract: 0.65 })!;
  assert.equal(l.costBasis, 500.65);
  assert.equal(l.liquidationValue, 409.35);
  near(l.netReturn, (409.35 - 500.65) / 500.65, 1e-12, "net at bid");
  // Bid 3.95 (mid 4.05 = -19% on mid): 395 - 0.65 = 394.35 -> -21.232% net displayed.
  const s2 = liquidationReturn({ entryFill: 5.0, bid: 3.95, feePerContract: 0.65 })!;
  assert.ok(s2.netReturn <= -0.2, `${s2.netReturn}`);
  // Index root without a configured fee: no net figure (the stop still works on the bid).
  assert.equal(liquidationReturn({ entryFill: 5.0, bid: 4.1, feePerContract: null }), null);
  // Zero bid: nothing to sell, no closing fee: -100%.
  near(liquidationReturn({ entryFill: 5.0, bid: 0, feePerContract: 0.65 })!.netReturn, -1, 1e-12, "zero bid");
  // No bid: missing, not 0%.
  assert.equal(liquidationReturn({ entryFill: 5.0, bid: null, feePerContract: 0.65 }), null);
  assert.deepEqual(entryFillOf({ buyPrice: 4.9, buyAsk: 5.0 }), { fill: 5.0, basis: "ask_at_arm" });
  assert.deepEqual(entryFillOf({ buyPrice: 4.9, buyAsk: null }), { fill: 4.9, basis: "last_at_arm" });
});

// ─── R2-C 9: masterAlpha direction and size gated on a promoted fit ────────────

test("masterAlphaPromotionGate: no record, short sample, failing OOS, wrong horizon -> unrated", () => {
  const ok: MasterAlphaPromotion = {
    horizon: "daily", promotedAt: "2027-10-01", reviewer: "desk", sessions: 260, oosR2: 0.012,
    intercept: 0.5, coefficients: [{ component: "charm", multiplier: 0.3 }, { component: "vanna", multiplier: 0.1 }],
  };
  assert.equal(masterAlphaPromotionGate(null, "daily").promoted, false);
  assert.equal(masterAlphaPromotionGate({ ...ok, sessions: 249 }, "daily").promoted, false);
  assert.equal(masterAlphaPromotionGate({ ...ok, oosR2: 0 }, "daily").promoted, false);
  assert.equal(masterAlphaPromotionGate({ ...ok, oosR2: -0.02 }, "daily").promoted, false);
  assert.equal(masterAlphaPromotionGate(ok, "weekly").promoted, false);
  assert.equal(masterAlphaPromotionGate({ ...ok, reviewer: "" }, "daily").promoted, false);
  assert.equal(masterAlphaPromotionGate({ ...ok, coefficients: [{ component: "charm", multiplier: NaN }] }, "daily").promoted, false);
  const g = masterAlphaPromotionGate(ok, "daily");
  assert.equal(g.promoted, true);
  // Forecast = 0.5 + 0.3 x 12 + 0.1 x (-4) = 3.7 bps; a missing used component -> null, never 0.
  if (g.promoted) {
    near(promotedForecastBps(g.model, [{ name: "Charm — daily window", directionBps: 12 }, { name: "Vanna amp", directionBps: -4 }])!, 3.7, 1e-12, "forecast");
    assert.equal(promotedForecastBps(g.model, [{ name: "Charm — daily window", directionBps: 12 }]), null);
  }
});

test("resolveMasterAlphaRiskBudget: from the user's account input only, never a default $1M", () => {
  assert.deepEqual(resolveMasterAlphaRiskBudget({}).dollars, null);
  // $250,000 x 1% default = $2,500; 2% requested = $5,000; 10% requested is capped at 5% = $12,500.
  assert.equal(resolveMasterAlphaRiskBudget({ accountSize: 250000 }).dollars, 2500);
  assert.equal(resolveMasterAlphaRiskBudget({ accountSize: 250000, riskPct: 0.02 }).dollars, 5000);
  assert.equal(resolveMasterAlphaRiskBudget({ accountSize: 250000, riskPct: 0.10 }).dollars, 12500);
  assert.equal(resolveMasterAlphaRiskBudget({ riskBudgetDollars: 1234.567 }).dollars, 1234.56);
  assert.equal(resolveMasterAlphaRiskBudget({ riskBudget_M: 0.5 }).dollars, 500000);
});

// ─── 6.5 / R2-C 8: convexity index fit to forward realized range ───────────────

test("olsClustered: one observation per cluster reduces to White HC1 (closed form, simple regression)", () => {
  // y = 1 + 2x + e on 6 points; HC0 Var(b1) = sum (x - xbar)^2 e^2 / (sum (x - xbar)^2)^2,
  // HC1 = HC0 x n/(n-k); CR1 with G = n gives G/(G-1) x (n-1)/(n-k) = n/(n-k).
  const x = [0, 1, 2, 3, 4, 5], e0 = [0.3, -0.2, 0.1, -0.4, 0.25, -0.05];
  const y = x.map((v, i) => 1 + 2 * v + e0[i]);
  const f = olsClustered(x.map((v) => [1, v]), y, x.map((_, i) => `s${i}`));
  const xbar = 2.5, sxx = x.reduce((a, v) => a + (v - xbar) ** 2, 0);
  const b1 = x.reduce((a, v, i) => a + (v - xbar) * y[i], 0) / sxx;
  const b0 = y.reduce((a, v) => a + v, 0) / 6 - b1 * xbar;
  const e = x.map((v, i) => y[i] - b0 - b1 * v);
  const hc0 = x.reduce((a, v, i) => a + (v - xbar) ** 2 * e[i] ** 2, 0) / sxx ** 2;
  near(f.coef[1], b1, 1e-12, "slope");
  near(f.se[1], Math.sqrt(hc0 * 6 / 4), 1e-12, "CR1 = HC1");
  assert.deepEqual(invert([[2, 1], [1, 1]]), [[1, -1], [-1, 2]]);
  assert.equal(invert([[1, 2], [2, 4]]), null);
});

function synthConvexity(sessions: number, perSession: number, seed: number): ConvexitySample[] {
  const rng = mulberry32(seed);
  const max: Record<string, number> = { gamma: 28, vol: 22, range: 15, ofi: 10, canary: 12, whales: 10, wall: 8 };
  const out: ConvexitySample[] = [];
  for (let d = 0; d < sessions; d++) {
    const day = `2027-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}`;
    const dayEffect = (rng() - 0.5) * 0.4;               // shared within the session -> clustering
    for (let w = 0; w < perSession; w++) {
      const points: Record<string, number | null> = {};
      for (const k of CONVEXITY_DRIVERS) points[k] = Math.round(rng() * max[k]);
      const x = (k: string) => (points[k] as number) / max[k];
      // True model: ln ratio = -0.1 + 0.5 x_gamma + 0.3 x_range + day effect + noise
      const lnr = -0.1 + 0.5 * x("gamma") + 0.3 * x("range") + dayEffect + (rng() - 0.5) * 0.6;
      out.push({ sessionDate: day, ts: d * 86_400_000 + w * 1_800_000, points, max, fwdRatio: Math.exp(lnr) });
    }
  }
  return out;
}

test("fitConvexityWeights: recovers known weights on seeded data; gate counts sessions; missing drivers are dropped, not zero", () => {
  const data = synthConvexity(130, 10, 7);
  const f = fitConvexityWeights(data);
  assert.equal(f.status, "fit-ready");
  assert.equal(f.sessions, 130);
  const b = (k: string) => f.coefficients.find((c) => c.driver === k)!;
  near(b("gamma").b, 0.5, 4 * b("gamma").seCluster, "gamma weight within 4 cluster SE");
  near(b("range").b, 0.3, 4 * b("range").seCluster, "range weight within 4 cluster SE");
  near(b("canary").b, 0, 4 * b("canary").seCluster, "no-information driver near 0");
  assert.ok(f.oosR2! > 0, `oos ${f.oosR2}`);
  const few = fitConvexityWeights(synthConvexity(119, 10, 7));
  assert.equal(few.status, "insufficient-data");
  const withGap = synthConvexity(130, 10, 7);
  withGap[0].points.canary = null;
  assert.equal(fitConvexityWeights(withGap).droppedIncomplete, 1);
});

test("forwardRange: high-low over the next 30 one-minute bars; too few bars -> null, not 0", () => {
  const t0 = Date.UTC(2026, 6, 15, 15, 0);
  const bars = Array.from({ length: 40 }, (_, i) => ({ datetime: t0 + (i + 1) * 60_000, high: 500 + (i === 10 ? 2 : 0.5), low: 500 - (i === 20 ? 1.5 : 0.5) }));
  // window (t0, t0 + 30m] holds bars 1..30: max high 502, min low 498.5 -> 3.5
  assert.equal(forwardRange(bars, t0), 3.5);
  assert.equal(forwardRange(bars.slice(0, 10), t0), null);
});

// ─── Fix round (R2-B review) ─────────────────────────────────────────────────

test("SF-3: one stop rule = the alert's printed rule, bid <= 0.80 x ask fill, before fees", () => {
  // $10.00 fill: stop level $8.00. Bid 8.00 stops, 8.01 does not (the old net-of-fee rule stopped at 8.01).
  assert.equal(optionStopLevel(10), 8);
  assert.equal(optionStopHit(8.0, 10), true);
  assert.equal(optionStopHit(8.01, 10), false);
  assert.equal(optionStopHit(null, 10), null);
  // Displayed net at the stop: (800 - 0.65 - 1000.65) / 1000.65 = -20.13%: the fee, not slippage.
  near(liquidationReturn({ entryFill: 10, bid: 8, feePerContract: 0.65 })!.netReturn, (799.35 - 1000.65) / 1000.65, 1e-12, "net at stop");
  // Entry check: a bid already at/below 0.80 x ask is untradable (SPREAD_EXCEEDS_STOP); no quote -> null.
  assert.equal(spreadExceedsStop(7.99, 10), true);
  assert.equal(spreadExceedsStop(8.0, 10), true);
  assert.equal(spreadExceedsStop(8.01, 10), false);
  assert.equal(spreadExceedsStop(null, 10), null);
  assert.equal(spreadExceedsStop(10.5, 10), null);
});

test("SF-2: fee rule per root: $0.65 equity/ETF, index roots only with a configured all-in fee", () => {
  assert.equal(feeForProduct("SPY", { indexFee: null }).fee, 0.65);
  assert.equal(feeForProduct("QQQ   261016C00500000", { indexFee: null }).fee, 0.65);
  assert.equal(feeForProduct("SPXW  261016C06700000", { indexFee: null }).fee, null);
  assert.equal(feeForProduct("SPXW_7100C_20260423", { indexFee: null }).fee, null);
  assert.equal(feeForProduct("SPXW", { indexFee: 1.25 }).fee, 1.25);
  // Projection without an index fee: returns before fees, no dollar P&L.
  const nowMs = Date.UTC(2026, 6, 15, 16, 0);
  const p = bsPrice(6700, 6705, 0.15, 240 / 525600, 0, 0, "C");
  const r = projectToTarget({ spot: 6700, strike: 6705, type: "C", target: 6715, expiry: "2026-07-15", symbol: "SPXW", bid: p - 0.05, ask: p + 0.05, vendorIv: 0.15, minutesToClose: 240, nowMs, feePerContract: null })!;
  assert.equal(r.feeIncluded, false);
  assert.equal(r.projPnlPerContract, null);
});

test("SF-6: EV under the pricing measure is minus the costs (martingale), and the no-touch density has mass 1 - pHit", () => {
  // Same vol for path and price, 0DTE settling at the close: E[option value at
  // min(touch, close)] = price now (optional stopping; Shreve II sec. 8.2). With
  // no fee, EV of the exit value = mid - pHit x half spread (spread paid only on
  // a touch exit; cash settlement has none), so EV return = (mid - pHit x half - ask) / ask.
  const nowMs = Date.UTC(2026, 6, 15, 16, 0);
  const T = 240 / 525600, S = 6700, K = 6705, H = 6715;
  const p = bsPrice(S, K, 0.15, T, 0, 0, "C");
  const bid = p - 0.05, ask = p + 0.05, half = 0.05;
  const r = projectToTarget({ spot: S, strike: K, type: "C", target: H, expiry: "2026-07-15", symbol: "SPXW", bid, ask, vendorIv: 0.15, minutesToClose: 240, nowMs, feePerContract: 0 })!;
  const want = (p - r.pHit * half - ask) / ask;
  near(r.evReturnPct, want, 2e-4, "EV = -costs");
  assert.ok(r.evReturnPct < 0);
  // Mass of the no-touch density (with the risk-neutral drift -sigma^2/2).
  const d = Math.log(H / S);
  near(noTouchExpectation(() => 1, d, r.pathSigma, T, true, 2000, -0.5 * r.pathSigma ** 2), 1 - r.pHit, 1e-6, "no-touch mass");
  // Put mirror: target below spot.
  const pp = bsPrice(S, 6695, 0.15, T, 0, 0, "P");
  const rp = projectToTarget({ spot: S, strike: 6695, type: "P", target: 6685, expiry: "2026-07-15", symbol: "SPXW", bid: pp - 0.05, ask: pp + 0.05, vendorIv: 0.15, minutesToClose: 240, nowMs, feePerContract: 0 })!;
  near(rp.evReturnPct, (pp - rp.pHit * 0.05 - (pp + 0.05)) / (pp + 0.05), 2e-4, "put EV = -costs");
});

test("N-2: ATM path vol solved from the ATM mid on the app clock; picker reprices with the strike's own vol", () => {
  const nowMs = Date.UTC(2026, 6, 15, 16, 0);
  const T = 240 / 525600;
  const mk = (k: number, v: number) => { const m = bsPrice(6700, k, v, T, 0, 0, "C"); return [{ bid: m - 0.05, ask: m + 0.05, volatility: 99 }]; };
  const strikes = { "6690": mk(6690, 0.18), "6700": mk(6700, 0.14), "6710": mk(6710, 0.12) };
  near(atmPathSigma(strikes, 6700, "C", "2026-07-15", nowMs)!, 0.14, 2e-3, "ATM vol");
  assert.equal(atmPathSigma({}, 6700, "C", "2026-07-15", nowMs), null);
});

test("SF-1: missing gamma/vol/range never reads CHOP or STAND_DOWN", () => {
  const base = { score: 0, shortGamma: false, gammaPts: 0, rangePts: 0, ofiPts: 0, volPts: 0, missing: [] as string[] };
  assert.equal(classifyEnvState(base), "CHOP");
  assert.equal(classifyEnvState({ ...base, missing: ["gamma"] }), "PARTIAL");
  assert.equal(classifyEnvState({ ...base, missing: ["gamma", "vol", "range"] }), "UNAVAILABLE");
  assert.equal(classifyEnvState({ ...base, missing: ["canary"] }), "PARTIAL");
  // A high score with a non-core driver missing stays LOADED (missing points can only raise it).
  assert.equal(classifyEnvState({ ...base, score: 50, shortGamma: true, gammaPts: 20, missing: ["canary"] }), "LOADED");
  assert.equal(classifyEnvState({ ...base, score: 50, shortGamma: true, gammaPts: 20, missing: ["range"] }), "PARTIAL");
});

test("SF-5: P/C vs history at the same clock time (interpolated cumulative volume)", () => {
  // A session with points at minute 30 (P 300 / C 600) and 60 (P 400 / C 1,000):
  // at minute 45, P = 350, C = 800; before the first point it scales from 0 at the open.
  assert.deepEqual(cumulativeAt([{ minute: 30, putVol: 300, callVol: 600 }, { minute: 60, putVol: 400, callVol: 1000 }], 45), { putVol: 350, callVol: 800 });
  assert.deepEqual(cumulativeAt([{ minute: 30, putVol: 300, callVol: 600 }], 15), { putVol: 150, callVol: 300 });
  assert.equal(cumulativeAt([{ minute: 30, putVol: 300, callVol: 600 }], 31), null); // no extrapolation
  // History: morning ratio 2.0 (puts early), full-day 1.0. Today at minute 30 with ratio 2.0 is NORMAL for the
  // clock time; the old full-day comparison would have called it put-heavy.
  const sessions = Array.from({ length: 25 }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}`,
    points: [{ minute: 30, putVol: 2000 * (1 + 0.01 * (i % 5)), callVol: 1000 }, { minute: 390, putVol: 10000, callVol: 10000 * (1 + 0.01 * (i % 3)) }],
  }));
  const r = pcrReadAtClock({ putVol: 2040, callVol: 1000 }, 30, sessions, { today: "2026-07-01" });
  assert.equal(r.n, 25);
  assert.equal(r.zone, "neutral");
  const full = pcrReadAtClock({ putVol: 2040, callVol: 1000 }, 390, sessions, { today: "2026-07-01" });
  assert.equal(full.zone, "bearish");
});

test("SF-7: masterAlpha size = whole contracts of the chosen contract at its Schwab ask + fee", () => {
  // Budget $2,500; ask $12.35, fee $1.25: cost 1,235.00 + 1.25 = $1,236.25 -> 2 contracts, $2,472.50 at risk.
  assert.deepEqual(contractsFromAsk({ budgetDollars: 2500, ask: 12.35, fee: 1.25 }), { contracts: 2, costPerContract: 1236.25, premiumAtRisk: 2472.5, binding: "budget" });
  // Exactly at the budget: 2 x 1,250.00 = 2,500.00 fits.
  assert.equal(contractsFromAsk({ budgetDollars: 2500, ask: 12.4, fee: 10 })!.contracts, 2);
  assert.equal(contractsFromAsk({ budgetDollars: 2500, ask: 12.35, fee: null }), null); // index fee not configured
  assert.equal(contractsFromAsk({ budgetDollars: 2500, ask: null, fee: 0.65 }), null);
  const atm = atmContractFrom({ "6700": [{ bid: 10, ask: 10.4, symbol: "SPXW  261016C06700000" }], "6710": [{ bid: 6, ask: 6.3 }] }, 6702);
  assert.equal(atm!.strike, 6700);
});

test("N-3: empty groups report null rates, never 0%", () => {
  const g = netGroupStats([]);
  assert.equal(g.winRate, null);
  assert.equal(g.avgPctReturn, null);
  assert.equal(g.medianPctReturn, null);
  const row = buildScoreboardRow("whale", [], 3, undefined, 2);
  assert.equal(row.winRate, null);
  assert.equal(row.avgPct, null);
  assert.equal(row.excludedNoQuote, 3);
  assert.equal(row.excludedNoFee, 2);
});

test("merge: r2-b gexSignAtSpot null (no material gamma) never yields CHOP; stop pct is the published plan's", async () => {
  const base = { score: 0, shortGamma: false, gammaPts: 0, rangePts: 0, ofiPts: 0, volPts: 0, missing: [] as string[] };
  assert.equal(classifyEnvState(base), "CHOP");
  assert.equal(classifyEnvState({ ...base, noMaterialGamma: true }), "STAND_DOWN");
  const { ODTE_PLAN_RULES } = await import("../../server/validationMath");
  const { PLAN_OPTION_STOP_PCT } = await import("../../server/exitValuation");
  assert.equal(PLAN_OPTION_STOP_PCT, ODTE_PLAN_RULES.optionStopPct);
});
