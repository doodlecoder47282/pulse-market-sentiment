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
  assert.equal(scoreAskToBid({ entryAsk: null, exitBid: 1 }), null);
  assert.equal(scoreAskToBid({ entryAsk: 2, exitBid: null }), null);
  assert.equal(scoreAskToBid({ entryBid: 2.2, entryAsk: 2, exitBid: 1 }), null);
});

test("buildScoreboardRow / netGroupStats: wins counted net, the same basis as $ P&L", () => {
  const a = scoreAskToBid({ entryAsk: 2.0, exitBid: 2.5 })!;   // +48.70
  const b = scoreAskToBid({ entryAsk: 2.0, exitBid: 2.01 })!;  // -0.30 (gross winner)
  const c = scoreAskToBid({ entryAsk: 2.0, exitBid: 0 })!;     // -200.65
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

test("projectToTarget: equals direct Black-Scholes repricing at T1 with E[tau | hit], net of half spread and fees", () => {
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
  near(r.minutesToTarget, tau * 525600, 1e-6, "minutes to T1");
  const mid = (bid + ask) / 2;
  const projMid = mid + bsPrice(H, K, sig, T - tau, 0, 0, "C") - bsPrice(S, K, sig, T, 0, 0, "C");
  const exitBid = projMid - (ask - bid) / 2;
  const want = (exitBid * 100 - 0.65 - (ask * 100 + 0.65)) / (ask * 100 + 0.65);
  near(r.projReturnPct, want, 1e-9, "return vs direct repricing");
  near(r.projectedMid, projMid, 1e-9, "projected mid");
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
