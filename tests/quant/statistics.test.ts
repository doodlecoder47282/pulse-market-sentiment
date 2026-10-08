// WS3 statistics: unit-root gate on the OU band, zero-skill CUSUM watchdog,
// one climatology baseline, reliability test, seasonal data-snooping test,
// masterAlpha fit gate, crypto data-state helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adfCriticalValue, adfTest, ar1BiasCorrected, fitOUBand } from "../../server/ouBand";
import {
  olsFit, climatologyBaseline, brierSkillScore, skillWatchdog, cusum,
  wilsonInterval, reliabilityCurve, dieboldMariano, firstPerSession,
} from "../../server/stats";
import { findOptimalWindow, isFullCalendarYear, computeSeasonality } from "../../server/seasonality";
import { independentDailyRows } from "../../server/mlAccuracy";
import { fitMasterAlphaWeights, componentKey, MASTER_ALPHA_MIN_SESSIONS, type MasterAlphaFitSample } from "../../server/masterAlphaFit";
import {
  resolveSocialCollection, expireSocial, summarizeSignalCounts, computeSocialScore, SOCIAL_TTL_MS,
} from "../../server/cryptoStats";

// ─── seeded RNG ──────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
function randomWalkCloses(r: () => number, n: number): number[] {
  let x = Math.log(5000);
  const out = [5000];
  for (let i = 1; i < n; i++) { x += 0.01 * gauss(r); out.push(Math.exp(x)); }
  return out;
}
function ouCloses(r: () => number, n: number, halfLife: number): number[] {
  const b = Math.pow(0.5, 1 / halfLife);
  let x = 0;
  for (let i = 0; i < 300; i++) x = b * x + 0.01 * gauss(r); // burn-in to stationarity
  const out: number[] = [];
  for (let i = 0; i < n; i++) { x = b * x + 0.01 * gauss(r); out.push(5000 * Math.exp(x)); }
  return out;
}

// ─── F3.1 OU band unit-root gate ─────────────────────────────────────────

test("ADF 5% critical value matches MacKinnon (2010) response surface", () => {
  // MacKinnon (2010) QED WP 1227, Table 2, tau_c N=1: -2.86154 - 2.8903/T - 4.234/T^2 - 40.040/T^3
  assert.ok(Math.abs(adfCriticalValue("5%", 1e9) - -2.86154) < 1e-6);
  // T=100: -2.86154 - 0.028903 - 0.0004234 - 0.0000400 = -2.890906 (Fuller's table: -2.89)
  assert.ok(Math.abs(adfCriticalValue("5%", 100) - -2.890906) < 1e-5);
  assert.ok(Math.abs(adfCriticalValue("1%", 100) - (-3.43035 - 0.065393 - 0.0016786 - 0.000079433)) < 1e-9);
  assert.ok(adfCriticalValue("1%", 120) < adfCriticalValue("5%", 120));
  assert.ok(adfCriticalValue("5%", 120) < adfCriticalValue("10%", 120));
});

test("OU band false-positive rate on seeded random walks is near the 5% test size", () => {
  // Review evidence: the ungated fit reported mean reversion on ~95% of random walks.
  const r = mulberry32(20261008);
  const M = 600;
  let fp = 0;
  for (let m = 0; m < M; m++) if (fitOUBand(randomWalkCloses(r, 120)).ok) fp++;
  const rate = fp / M;
  // Nominal size 5%; binomial sd at M=600 is ~0.9pp, so [2.5%, 8.5%] is ~±3.5 sd.
  assert.ok(rate >= 0.025 && rate <= 0.085, `random-walk false-positive rate ${rate}`);
});

test("OU gate keeps its size on a drifting, higher-vol random walk (SPX-like)", () => {
  // 10 bp/day drift (~25%/yr) and 2% daily vol: the constant-only ADF stays near or below 5%.
  const r = mulberry32(4242);
  const M = 400;
  let fp = 0;
  for (let m = 0; m < M; m++) {
    let x = Math.log(5000);
    const c = [5000];
    for (let i = 1; i < 120; i++) { x += 0.001 + 0.02 * gauss(r); c.push(Math.exp(x)); }
    if (fitOUBand(c).ok) fp++;
  }
  assert.ok(fp / M <= 0.085, `drifting random-walk false-positive rate ${fp / M}`);
});

test("random walk returns 'not mean-reverting' with no half-life or target", () => {
  const r = mulberry32(7);
  let checked = 0;
  for (let m = 0; m < 50 && checked < 5; m++) {
    const fit = fitOUBand(randomWalkCloses(r, 120));
    if (fit.ok) continue;
    checked++;
    assert.equal(fit.meanReverting, false);
    assert.equal(fit.halfLife, 0);
    assert.equal(fit.mu, 0);
    assert.equal(fit.bandLower, 0);
    assert.ok(fit.adf != null && fit.adf.rejectUnitRoot5 === false);
    assert.match(fit.reason, /not mean-reverting/);
  }
  assert.equal(checked, 5);
});

test("OU band detects a true OU process and recovers its half-life", () => {
  const r = mulberry32(99);
  const M = 300;
  let det = 0;
  const hl: number[] = [];
  for (let m = 0; m < M; m++) {
    const fit = fitOUBand(ouCloses(r, 120, 3));
    if (fit.ok) { det++; hl.push(fit.halfLife); }
  }
  // DF power at T=120, b=0.794 (half-life 3d) is ~0.95 (simulated 0.965 with 1,000 paths).
  assert.ok(det / M >= 0.88, `power ${det / M}`);
  hl.sort((a, b) => a - b);
  const med = hl[Math.floor(hl.length / 2)];
  assert.ok(Math.abs(med - 3) < 0.6, `median half-life ${med}`);
});

test("Kendall / Marriott-Pope AR(1) bias correction removes most of the small-sample bias", () => {
  // E[b_hat] ~ b - (1+3b)/T with an intercept; b_c = (T b_hat + 1)/(T - 3).
  const r = mulberry32(1954);
  const b = 0.9, T = 60, M = 4000;
  let sRaw = 0, sCor = 0;
  for (let m = 0; m < M; m++) {
    let x = 0;
    for (let i = 0; i < 200; i++) x = b * x + gauss(r);
    const xs = [x];
    for (let i = 0; i < T; i++) { x = b * x + gauss(r); xs.push(x); }
    let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
    for (let i = 0; i < T; i++) { Sx += xs[i]; Sy += xs[i + 1]; Sxx += xs[i] * xs[i]; Sxy += xs[i] * xs[i + 1]; }
    const mx = Sx / T, my = Sy / T;
    const bh = (Sxy / T - mx * my) / (Sxx / T - mx * mx);
    sRaw += bh; sCor += ar1BiasCorrected(bh, T);
  }
  const raw = sRaw / M, cor = sCor / M;
  // Kendall approximation: 0.9 - 3.7/60 = 0.838
  assert.ok(Math.abs(raw - 0.838) < 0.012, `raw mean ${raw}`);
  assert.ok(Math.abs(cor - b) < 0.012, `corrected mean ${cor}`);
  assert.ok(Math.abs(cor - b) < Math.abs(raw - b) / 4);
});

test("adfTest rejects a strongly stationary series and returns its sample size", () => {
  const r = mulberry32(5);
  const x: number[] = [];
  let v = 0;
  for (let i = 0; i < 200; i++) { v = 0.3 * v + gauss(r); x.push(v); }
  const a = adfTest(x);
  assert.ok(a != null);
  assert.ok(a.rejectUnitRoot5);
  assert.ok(a.stat < a.crit["1%"]);
  assert.ok(a.nobs >= 180 && a.nobs <= 199);
});

// ─── OLS ────────────────────────────────────────────────────────────────

test("olsFit reproduces a hand-computed simple regression", () => {
  // x = 1..5, y = 2,4,5,4,5 → slope 0.6, intercept 2.2, SSR 2.4, s^2 = 0.8, se(slope) = sqrt(0.8/10)
  const f = olsFit([1, 2, 3, 4, 5].map((x) => [1, x]), [2, 4, 5, 4, 5]);
  assert.ok(f.ok);
  assert.ok(Math.abs(f.coef[0] - 2.2) < 1e-12);
  assert.ok(Math.abs(f.coef[1] - 0.6) < 1e-12);
  assert.ok(Math.abs(f.ssr - 2.4) < 1e-12);
  assert.ok(Math.abs(f.se[1] - Math.sqrt(0.08)) < 1e-12);
  assert.ok(Math.abs(f.r2 - 0.6) < 1e-12); // SST = 6, 1 - 2.4/6
  assert.equal(olsFit([[1, 1], [1, 1], [1, 1]], [1, 2, 3]).ok, false); // singular
});

// ─── F5.2 one climatology baseline + zero-skill CUSUM ───────────────────

test("climatology baseline: Brier of the base-rate forecaster is 1 - sum f^2", () => {
  const c = climatologyBaseline([[1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1]]);
  assert.deepEqual(c.freqs, [0.25, 0.5, 0.25]);
  // per class p(1-p): 0.1875, 0.25, 0.1875; total 1 - (0.0625 + 0.25 + 0.0625) = 0.625
  assert.ok(Math.abs(c.perClass[0] - 0.1875) < 1e-12);
  assert.ok(Math.abs(c.perClass[1] - 0.25) < 1e-12);
  assert.ok(Math.abs(c.total - 0.625) < 1e-12);
  assert.equal(c.perRow.length, 4);
  assert.ok(Math.abs(c.perRow.reduce((s, v) => s + v, 0) / 4 - c.total) < 1e-12);
  // BSS = 1 - BS/BS_ref (AMS Glossary "skill"; perfect Brier = 0): 1 - 0.5/0.625 = 0.2
  assert.ok(Math.abs((brierSkillScore(0.5, 0.625) as number) - 0.2) < 1e-12);
  assert.equal(brierSkillScore(0.5, 0), null);
});

function multinomialDays(r: () => number, n: number, probs: [number, number, number]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const u = r();
    const k = u < probs[0] ? 0 : u < probs[0] + probs[1] ? 1 : 2;
    out.push([0, 1, 2].map((j) => (j === k ? 1 : 0)));
  }
  return out;
}
const brier3 = (p: number[], o: number[]) => p.reduce((s, v, j) => s + (v - o[j]) ** 2, 0);

test("watchdog flags a model that is always worse than climatology (old CUSUM read HEALTHY)", () => {
  // Base bucket realizes 60% of days; the model always says 1/3-1/3-1/3.
  const r = mulberry32(42);
  const outs = multinomialDays(r, 60, [0.2, 0.6, 0.2]);
  const rows = outs.map((o) => ({ modelBrier: brier3([1 / 3, 1 / 3, 1 / 3], o), outcome: o }));
  const w = skillWatchdog(rows);
  assert.notEqual(w.status, "HEALTHY");
  assert.ok(w.meanDiff > 0);
  assert.ok(w.bss != null && w.bss < 0);
  // The old design (target = series' own mean) cannot see a constant offset.
  const d = rows.map((x, i) => x.modelBrier - climatologyBaseline(outs).perRow[i]);
  assert.equal(cusum(d).status, "HEALTHY");
  // A model that is worse by a lot every day trips BROKEN.
  const bad = outs.map((o) => ({ modelBrier: brier3([0.8, 0.1, 0.1], o), outcome: o }));
  assert.equal(skillWatchdog(bad).status, "BROKEN");
});

test("watchdog reads HEALTHY for a model with real skill over climatology", () => {
  // Each day the true probabilities vary; the model forecasts them exactly.
  const r = mulberry32(11);
  const rows: Array<{ modelBrier: number; outcome: number[] }> = [];
  for (let i = 0; i < 60; i++) {
    const p: [number, number, number] = r() < 0.5 ? [0.7, 0.2, 0.1] : [0.1, 0.2, 0.7];
    const o = multinomialDays(r, 1, p)[0];
    rows.push({ modelBrier: brier3(p, o), outcome: o });
  }
  const w = skillWatchdog(rows);
  assert.equal(w.status, "HEALTHY");
  assert.ok(w.bss != null && w.bss > 0);
});

test("Diebold-Mariano: hand-computed values (h = 1 is the one-sample t; h = 2 Bartlett + HLN)", () => {
  // h = 1: d = [-0.1,-0.2,0.05,-0.15,-0.1], mean -0.1, SS 0.035, sd sqrt(0.035/4) = 0.0935414,
  // t = -0.1 / (0.0935414/sqrt 5) = -2.390457
  const a = dieboldMariano([-0.1, -0.2, 0.05, -0.15, -0.1], 1);
  assert.ok(Math.abs((a.stat as number) - -2.390457) < 1e-5, `h=1 ${a.stat}`);
  // h = 2: d = [2,0,2,0]: gamma0 = 1, gamma1 = -3/4; LRV = 1 + 2(1 - 1/2)(-0.75) = 0.25;
  // DM = 1/sqrt(0.25/4) = 4; HLN factor sqrt((4 + 1 - 4 + 2/4)/4) = sqrt(0.375) -> 2.449490
  const b = dieboldMariano([2, 0, 2, 0], 2);
  assert.ok(Math.abs(b.lrv - 0.25) < 1e-12);
  assert.ok(Math.abs((b.stat as number) - 4 * Math.sqrt(0.375)) < 1e-9);
});

test("Diebold-Mariano size: ~5% on iid nulls, and the HAC variance fixes overlapping (MA(1)) differentials", () => {
  const r = mulberry32(1995);
  const M = 2000, T = 120;
  let rejIid = 0, rejNaive = 0, rejHac = 0;
  for (let m = 0; m < M; m++) {
    const e = Array.from({ length: T + 1 }, () => gauss(r));
    const iid = e.slice(1);
    const ma1 = iid.map((v, t) => v + e[t]); // 2-step overlap: d_t = e_t + e_{t-1}
    if (Math.abs(dieboldMariano(iid, 1).stat as number) >= 1.96) rejIid++;
    if (Math.abs(dieboldMariano(ma1, 1).stat as number) >= 1.96) rejNaive++;
    if (Math.abs(dieboldMariano(ma1, 2).stat as number) >= 1.96) rejHac++;
  }
  assert.ok(rejIid / M > 0.035 && rejIid / M < 0.07, `iid size ${rejIid / M}`);
  assert.ok(rejNaive / M > 0.12, `ignoring overlap over-rejects: ${rejNaive / M}`);
  assert.ok(rejHac / M < 0.09, `Newey-West h=2 size ${rejHac / M}`);
});

test("watchdog: a model no better than climatology is NO_SKILL, never HEALTHY", () => {
  const r = mulberry32(8);
  const outs = multinomialDays(r, 60, [0.3, 0.4, 0.3]);
  // forecasts the true base rates every day: zero skill by construction
  const rows = outs.map((o) => ({ modelBrier: brier3([0.3, 0.4, 0.3], o), outcome: o }));
  const w = skillWatchdog(rows);
  assert.equal(w.status, "NO_SKILL");
  assert.match(w.reason, /no demonstrated skill/);
});

test("cusum anchored to a target accumulates a persistent offset", () => {
  const series = Array.from({ length: 40 }, (_, i) => 1 + (i % 2 ? 0.1 : -0.1));
  assert.equal(cusum(series).status, "HEALTHY"); // own mean: blind
  assert.equal(cusum(series, { target: 0 }).status, "BROKEN");
});

// ─── F12.2 reliability curve + stated calibration test ──────────────────

test("Wilson interval matches the textbook value for 8/10", () => {
  // Wilson (1927) 95% for 8/10: (0.490, 0.943) (Brown, Cai & DasGupta 2001)
  const w = wilsonInterval(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 5e-4);
  assert.ok(Math.abs(w.hi - 0.9433) < 5e-4);
});

test("reliability test: calibrated forecasts pass, miscalibrated fail, small samples are untested", () => {
  const r = mulberry32(314);
  // Calibrated: o ~ Bernoulli(p). Pass rate across 60 seeds should be near
  // 1 - (Spiegelhalter 5% + Bonferroni bins 5%) ≈ 0.9.
  let pass = 0;
  for (let s = 0; s < 60; s++) {
    const p = Array.from({ length: 500 }, () => r());
    const o = p.map((v) => (r() < v ? 1 : 0));
    if (reliabilityCurve(p, o).verdict === "calibrated") pass++;
  }
  assert.ok(pass / 60 >= 0.8, `calibrated pass rate ${pass / 60}`);
  // Overconfident: true probability is shrunk halfway to 0.5.
  const p = Array.from({ length: 2000 }, () => r());
  const o = p.map((v) => (r() < 0.5 + (v - 0.5) / 2 ? 1 : 0));
  const rep = reliabilityCurve(p, o);
  assert.equal(rep.verdict, "not calibrated");
  assert.ok(rep.bins.some((b) => b.inInterval === false));
  // A low Brier alone does not earn the label: 40 forecasts are "insufficient data".
  const small = reliabilityCurve(p.slice(0, 40), o.slice(0, 40));
  assert.equal(small.verdict, "insufficient data");
  // Bins carry counts and Wilson intervals.
  const b = rep.bins.find((x) => x.n > 0)!;
  assert.ok(b.wilsonLo != null && b.wilsonHi != null && b.wilsonLo <= b.observed! && b.observed! <= b.wilsonHi);
  assert.equal(rep.bins.reduce((s, x) => s + x.n, 0), 2000);
});

test("calibration evidence: one call per ET session, and the test names its event", () => {
  // 78 five-minute calls on each of 3 sessions share 3 outcomes: 3 observations, not 234.
  const rows: Array<{ ts: number; p: number; o: number }> = [];
  for (const day of [Date.UTC(2026, 9, 5, 13, 35), Date.UTC(2026, 9, 6, 13, 35), Date.UTC(2026, 9, 7, 13, 35)]) {
    for (let k = 0; k < 78; k++) rows.push({ ts: day + k * 300_000, p: 0.6, o: 1 });
  }
  const one = firstPerSession(rows, (r) => r.ts);
  assert.equal(one.length, 3);
  assert.equal(one[0].ts, Date.UTC(2026, 9, 5, 13, 35)); // earliest call of the session kept
  // 23:30 ET on Oct 5 is Oct 6 03:30 UTC: still the Oct 5 session
  assert.equal(firstPerSession([{ ts: Date.UTC(2026, 9, 6, 3, 30) }, { ts: Date.UTC(2026, 9, 5, 14, 0) }], (r) => r.ts).length, 1);
  // with 3 independent observations the n >= 100 gate is not met
  const rep = reliabilityCurve(one.map((r) => r.p), one.map((r) => r.o), { event: "SPY |move| >= 0.5% proxy" });
  assert.equal(rep.verdict, "insufficient data");
  assert.match(rep.test.name, /^event: SPY \|move\| >= 0\.5% proxy; /);
});

// ─── F5.3 seasonal window data-snooping test ────────────────────────────

function seasonalMarket(r: () => number, years: number, seasonal: (d: number) => number): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let y = 0; y < years; y++) {
    let L = 0;
    const p = [0];
    for (let d = 1; d < 252; d++) { L += seasonal(d) + 0.01 * gauss(r); p.push((Math.exp(L) - 1) * 100); }
    m.set(2000 + y, p);
  }
  return m;
}

test("seasonal window on zero-drift noise is rarely rated Good/Excellent (review: 32 of 40)", () => {
  const r = mulberry32(2026);
  let good = 0, sig = 0;
  for (let t = 0; t < 40; t++) {
    const w = findOptimalWindow(seasonalMarket(r, 20, () => 0), { permutations: 49 });
    if (w && (w.confidenceLabel === "Good" || w.confidenceLabel === "Excellent")) good++;
    if (w?.significance?.significant) sig++;
  }
  // Nominal 5% → expect ~2 of 40; allow up to 5 (P(X≥6 | n=40, p=0.05) ≈ 1.4%).
  assert.ok(good <= 5, `noise rated Good/Excellent ${good}/40`);
  assert.ok(sig <= 5, `noise significant ${sig}/40`);
});

test("seasonal window detects a real calendar effect and reports the hold-out", () => {
  const r = mulberry32(77);
  let det = 0;
  let last = null as ReturnType<typeof findOptimalWindow>;
  for (let t = 0; t < 6; t++) {
    // +0.3%/day between trading days 100 and 160 every year (~+18% window), zero drift otherwise.
    const w = findOptimalWindow(seasonalMarket(r, 10, (d) => (d >= 100 && d < 160 ? 0.003 : 0)), { permutations: 49 });
    if (w?.significance?.significant) det++;
    last = w;
  }
  assert.ok(det >= 4, `detected ${det}/6`);
  assert.ok(last?.significance?.outOfSample != null);
  assert.equal(last!.significance!.outOfSample!.heldOutYears, 3);
  assert.ok(last!.significance!.windowsSearched > 6000);
});

test("seasonality uses only full calendar years (a partial first year is not stretched over 252 days)", () => {
  const day = 86400;
  const yearBars = (y: number, fromMonth: number) => {
    const out: Array<{ t: number; c: number }> = [];
    for (let t = Date.UTC(y, fromMonth, 2) / 1000; t < Date.UTC(y, 11, 31) / 1000 + day; t += day) {
      const wd = new Date(t * 1000).getUTCDay();
      if (wd !== 0 && wd !== 6) out.push({ t, c: 100 + out.length * 0.01 });
    }
    return out;
  };
  assert.equal(isFullCalendarYear(yearBars(2019, 0)), true);
  assert.equal(isFullCalendarYear(yearBars(2016, 9)), false); // Schwab 10y window starts in October
  // computeSeasonality drops the partial year from the day-of-year paths
  const bars = [...yearBars(2016, 9), ...yearBars(2017, 0), ...yearBars(2018, 0)];
  const out = computeSeasonality(bars as any);
  assert.deepEqual(out.yearly.yearsCovered, ["2017", "2018"]);
});

// ─── F6.3 masterAlpha fit + sample-size gate ────────────────────────────

function maSamples(r: () => number, sessions: number, perSession = 1): MasterAlphaFitSample[] {
  const out: MasterAlphaFitSample[] = [];
  for (let s = 0; s < sessions; s++) {
    const charm = 10 * gauss(r);
    const vanna = 5 * gauss(r);
    const realized = 0.5 * charm + 0 * vanna + 20 * gauss(r);
    for (let k = 0; k < perSession; k++) {
      out.push({
        ts: 1_700_000_000 + s * 86400 + k * 1800,
        sessionDate: `S${String(s).padStart(4, "0")}`,
        horizon: "daily",
        components: [
          { name: "Charm — daily window", directionBps: charm, weight: 0.45 },
          { name: "Vanna — IV-confluent delta amplifier", directionBps: vanna, weight: 0.2 },
          { name: "GEX regime — neutral", directionBps: 0, weight: 0.15 },
        ],
        realizedBps: realized + (k ? 1000 : 0), // later same-day snapshots must be ignored
      });
    }
  }
  return out;
}

test("masterAlpha fit recovers known multipliers once the sample gate is met", () => {
  assert.equal(componentKey("Charm — daily window"), "charm");
  assert.equal(componentKey("GTBR — gamma-theta momentum trigger"), "gtbr");
  const r = mulberry32(318);
  const fit = fitMasterAlphaWeights(maSamples(r, 400, 2));
  assert.equal(fit.status, "fit-ready");
  assert.equal(fit.sessions, 400); // deduped to one row per session
  const charm = fit.coefficients.find((c) => c.component === "charm")!;
  const vanna = fit.coefficients.find((c) => c.component === "vanna")!;
  // True multipliers: charm 0.5, vanna 0; noise sd 20 → se(charm) ≈ 20/(10·√400) = 0.1
  assert.ok(Math.abs(charm.multiplier - 0.5) < 3 * charm.se, `charm ${charm.multiplier} ± ${charm.se}`);
  assert.ok(Math.abs(vanna.multiplier) < 3 * vanna.se);
  assert.equal(charm.handSetWeight, 0.45);
  assert.deepEqual(fit.droppedComponents, ["gex"]); // constant column
  assert.ok(fit.oosR2 != null);
});

test("masterAlpha sample gate is the 80%-power size for R^2 = 3.2%", () => {
  // n = (z_.975 + z_.80)^2 (1 - R^2)/R^2 = (1.95996 + 0.84162)^2 * 0.968 / 0.032 = 237.4, + regressors -> 250
  const n = (1.959964 + 0.841621) ** 2 * (1 - 0.032) / 0.032;
  assert.ok(Math.abs(n - 237.43) < 0.05);
  assert.ok(MASTER_ALPHA_MIN_SESSIONS >= Math.ceil(n) + 5);
});

test("masterAlpha fit: a missing component drops the session (never 0 bps) and is counted", () => {
  const r = mulberry32(77);
  const samples = maSamples(r, 400, 1);
  // 30 sessions never logged vanna: complete-case fit uses 370 and reports 30 dropped
  for (let i = 0; i < 30; i++) samples[i * 10].components = samples[i * 10].components.filter((c) => !c.name.startsWith("Vanna"));
  const fit = fitMasterAlphaWeights(samples);
  assert.equal(fit.status, "fit-ready");
  assert.equal(fit.sessionsDroppedMissing, 30);
  assert.equal(fit.sessions, 370);
  // below the gate after dropping -> stays hand-set, with the count in the note
  const few = fitMasterAlphaWeights(maSamples(mulberry32(3), 260, 1).map((s, i) => (i < 20 ? { ...s, components: s.components.slice(0, 1) } : s)));
  assert.equal(few.status, "insufficient-data");
  assert.equal(few.sessionsDroppedMissing, 20);
  assert.match(few.note, /20 dropped for a missing component/);
});

test("masterAlpha fit stays 'hand-set' below the sample gate", () => {
  const r = mulberry32(5);
  const fit = fitMasterAlphaWeights(maSamples(r, 100, 3));
  assert.equal(fit.status, "insufficient-data");
  assert.equal(fit.sessions, 100);
  assert.equal(fit.coefficients.length, 0);
  assert.match(fit.note, /hand-set weights/);
});

// ─── F10.1-F10.3 crypto data states ─────────────────────────────────────

test("crypto social: failed collection is never zero; stale scores expire", () => {
  const now = 1_000_000_000;
  const prev = { socialScore: 62, socialCheckedAt: now - 60_000, socialStatus: "ok" as const };
  // all attempted sources failed → keep last complete score (within TTL), status failed
  const f = resolveSocialCollection(prev, { bsky: "failed", pump: "failed" }, 0, now);
  assert.equal(f.socialStatus, "failed");
  assert.equal(f.socialScore, 62);
  assert.equal(f.socialCheckedAt, prev.socialCheckedAt); // not stamped fresh
  // failure after the TTL → null, never 0
  const old = { ...prev, socialCheckedAt: now - SOCIAL_TTL_MS - 1 };
  const g = resolveSocialCollection(old, { bsky: "failed", pump: "skipped" }, 0, now);
  assert.equal(g.socialScore, null);
  assert.equal(g.socialStatus, "failed");
  // partial: one ok, one failed → not a complete collection
  const h = resolveSocialCollection({ socialScore: null, socialCheckedAt: null, socialStatus: null }, { bsky: "ok", pump: "failed" }, 30, now);
  assert.equal(h.socialStatus, "partial");
  assert.equal(h.socialScore, null);
  // complete collection → fresh score
  const k = resolveSocialCollection(old, { bsky: "ok", pump: "skipped" }, 30, now);
  assert.deepEqual(k, { socialScore: 30, socialCheckedAt: now, socialStatus: "ok" });
  // nothing attempted → unavailable, not zero
  assert.equal(resolveSocialCollection(prev, { bsky: "skipped", pump: "skipped" }, 0, now).socialScore, null);
  // TTL expiry
  const e = expireSocial({ socialScore: 50, socialCheckedAt: now - SOCIAL_TTL_MS - 1, socialStatus: "ok" }, now);
  assert.equal(e.socialScore, null);
  assert.equal(e.socialStatus, "stale");
  assert.equal(expireSocial(prev, now).socialScore, 62);
  // score weights unchanged: 1 fresh mention (12) + 3/hr (7.5) + live (10) + links (5) → 34.5 → 35
  assert.equal(computeSocialScore({ bskyMentions10m: 1, bskyMentions1h: 3, pumpReplyPerHr: null, pumpLive: true, hasSocialLinks: true }), 35);
});

test("crypto signal stats come from one window and sampleReady is a count flag", () => {
  const s = summarizeSignalCounts({ total: 130, open: 40, hit5m: 10, doubled: 20, rugged: 30, dead: 30 });
  assert.equal(s.graded, 90);
  assert.equal(s.total, s.open + s.graded + s.other);
  assert.equal(s.other, 0);
  assert.equal(s.sampleReady, true);
  assert.equal((s as Record<string, unknown>).calibrated, undefined);
  const t = summarizeSignalCounts({ total: 60, open: 11, hit5m: 1, doubled: 2, rugged: 40, dead: 5 });
  assert.equal(t.graded, 48);
  assert.equal(t.sampleReady, false);
  assert.equal(t.other, 1);
  assert.equal(summarizeSignalCounts(null).total, 0);
  // NO_DATA (past the horizon, unpriceable) is missing, not graded and not dead
  const u = summarizeSignalCounts({ total: 100, open: 20, hit5m: 5, doubled: 5, rugged: 10, dead: 20, noData: 40 });
  assert.equal(u.graded, 40);
  assert.equal(u.noData, 40);
  assert.equal(u.other, 0);
  assert.equal(u.sampleReady, false);
});

test("ML reliability uses one daily forecast per session (first snapshot), no weekly overlap", () => {
  const rows = [
    { horizon: "daily", sessionDate: "2026-10-01", ts: 300, realizedReturnPct: 0.2, id: "a" },
    { horizon: "daily", sessionDate: "2026-10-01", ts: 100, realizedReturnPct: 0.2, id: "b" },
    { horizon: "weekly", sessionDate: "2026-10-01", ts: 50, realizedReturnPct: 0.9, id: "c" },
    { horizon: "daily", sessionDate: "2026-10-02", ts: 400, realizedReturnPct: null, id: "d" },
    { horizon: "daily", sessionDate: "2026-10-05", ts: 500, realizedReturnPct: -0.1, id: "e" },
  ];
  assert.deepEqual(independentDailyRows(rows).map((r) => r.id), ["b", "e"]);
});
