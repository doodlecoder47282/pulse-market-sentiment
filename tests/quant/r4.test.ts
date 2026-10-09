// Round 4: final re-grade fixes.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/r4.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeGammaZone, gammaZoneLabel, gammaZoneTag, gammaZoneEffect, detectGammaFlip,
} from "../../server/gammaZone";
import { dailyCardHeader } from "../../server/dailyCardHeader";
import { predictTransition, _resetPredictorHistory } from "../../server/regimePredictor";
import { oauthErrorCode } from "../../server/oauthError";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

// ── 1. gamma zone "y?" = gamma unknown everywhere ──────────────────────────
test("gammaZone: y? / missing / garbage normalise to unknown, never a regime", () => {
  for (const z of ["y?", null, undefined, "", "y", "NEUTRAL", 0]) {
    assert.equal(normalizeGammaZone(z), "y?");
    assert.equal(gammaZoneEffect(z), "unknown");
    assert.match(gammaZoneLabel(z), /unknown/);
    assert.doesNotMatch(gammaZoneLabel(z), /volatile|dampened/i);
    assert.equal(gammaZoneTag(z), "γ? UNKNOWN");
  }
  assert.equal(gammaZoneLabel("y+"), "γ+ (dampened)");
  assert.equal(gammaZoneLabel("y-"), "γ− (volatile)");
  assert.equal(gammaZoneEffect("y-"), "amplifying");
  assert.equal(gammaZoneEffect("y+"), "dampening");
});

test("gammaZone flip: no alert into or out of unknown; known->known fires once", () => {
  // y+ -> y? : silent, last known kept
  let st = detectGammaFlip("y+", "y?");
  assert.equal(st.flip, false);
  assert.equal(st.nextLastKnown, "y+");
  // y? -> y+ (recovery to the same regime): silent
  st = detectGammaFlip(st.nextLastKnown, "y+");
  assert.equal(st.flip, false);
  // y+ -> y? -> y- : one real flip y+ -> y-
  const a = detectGammaFlip("y+", "y?");
  const b = detectGammaFlip(a.nextLastKnown, "y-");
  assert.equal(b.flip, true);
  assert.equal(b.prev, "y+");
  assert.equal(b.next, "y-");
  // first reading ever: no flip
  assert.equal(detectGammaFlip(null, "y-").flip, false);
  // legacy state value "y?" stored as last: treated as no known zone
  assert.equal(detectGammaFlip("y?", "y-").flip, false);
});

test("gammaZone consumers: discord, scheduler, 0DTE card, auditEnrich use the unknown state", () => {
  const discord = src("server/discord.ts");
  assert.doesNotMatch(discord, /zone === "y\+" \? "γ\+ \(dampened\)" : "γ− \(volatile\)"/);
  assert.match(discord, /if \(p === "y\?" \|\| n === "y\?" \|\| p === n\) return false;/);
  const sched = src("server/discordScheduler.ts");
  assert.match(sched, /detectGammaFlip\(alertState\.gammaZone, newGammaZone\)/);
  const odte = src("server/odteAlertEngine.ts");
  assert.doesNotMatch(odte, /: "NEUTRAL";\n/);
  assert.match(odte, /gammaZoneTag\(args\.audit\.gammaZone\)/);
  assert.match(odte, /γ-zone unknown \(GEX missing\/immaterial\): \+0/);
  const enrich = src("server/auditEnrich.ts");
  assert.match(enrich, /gEffect === "unknown"/);
  const models = src("server/models.ts");
  assert.match(models, /if \(gammaZone === "y\?"\) path = "gamma unknown \(no path claim\)"/);
  assert.doesNotMatch(models, /if \(cur\.gex < 0 && cur\.charm < 0\) path/);
});

test("regimePredictor: unknown gamma makes no trend/chop claim and is degraded", () => {
  _resetPredictorHistory();
  const out = predictTransition({ audit: { dfi: 4, gammaZone: "y?", slope: "UP 0.5° → 1.0" }, nowMs: Date.UTC(2026, 9, 9, 15, 0) });
  assert.equal(out.currentRegime, "NEUTRAL");
  assert.equal(out.status, "degraded");
  _resetPredictorHistory();
  const k = predictTransition({ audit: { dfi: 4, gammaZone: "y-", slope: "UP 0.5° → 1.0" }, nowMs: Date.UTC(2026, 9, 9, 15, 0) });
  assert.equal(k.currentRegime, "TREND_STRONG");
});

// ── 2. Discord daily card: missing is unavailable, source labelled ─────────
test("daily card: missing scenario / gamma / dfi / term render unavailable, not defaults", () => {
  const h = dailyCardHeader({}, null, null);
  assert.equal(h.scen, null);
  assert.equal(h.top, null);
  assert.match(h.description, /γ unavailable/);
  assert.match(h.description, /DFI unavailable/);
  assert.match(h.description, /VIX unavailable/);
  assert.match(h.description, /term unavailable/);
  assert.doesNotMatch(h.description, /dampened|DFI \+0\.00/);
  // all-zero scenario object (the old default) is not a distribution
  assert.equal(dailyCardHeader({ scenarioProb: { bull: 0, base: 0, bear: 0 } }, null, null).scen, null);
});

test("daily card: observed values and the scenario source label are printed", () => {
  const rn = dailyCardHeader(
    { scenarioProb: { bull: 30, base: 50, bear: 20 }, scenarioProbSource: "risk-neutral-implied", gammaZone: "y?", dfi: 0 },
    { termRatio: 1.12, vix: 15.2 }, 15.31,
  );
  assert.deepEqual(rn.scen, { bull: 30, base: 50, bear: 20 });
  assert.equal(rn.top, "base");
  assert.match(rn.scenarioSourceLabel, /risk-neutral, options-implied/);
  assert.equal(rn.scenarioFieldName, "Scenarios (risk-neutral)");
  assert.match(rn.description, /gamma unknown/);
  assert.match(rn.description, /DFI \+0\.00/); // observed zero stays zero
  assert.match(rn.description, /VIX 15\.31/);
  assert.match(rn.description, /term 1\.12 \(contango \(calm\)\)/);
  const hs = dailyCardHeader({ scenarioProb: { bull: 40, base: 35, bear: 25 }, scenarioProbSource: "hand-set-heuristic" }, null, null);
  assert.match(hs.scenarioSourceLabel, /heuristic/);
  assert.equal(hs.scenarioFieldName, "Scenarios (heuristic)");
  assert.doesNotMatch(src("server/discord.ts"), /fetchJSON\(`\/api\/sentiment`\)/);
});

// ── 3. Schwab code exchange never logs or returns the raw token body ───────
test("oauthErrorCode keeps only the RFC 6749 error code", () => {
  const body = JSON.stringify({ error: "invalid_grant", error_description: "code=SECRETCODE123 client_id=abc" });
  assert.equal(oauthErrorCode(body), "invalid_grant");
  assert.equal(oauthErrorCode("<html>access_token=xyz</html>"), "unknown");
  assert.equal(oauthErrorCode(JSON.stringify({ error: "access_token=abc.def" })), "unknown");
  assert.equal(oauthErrorCode(""), "unknown");
  const schwab = src("server/schwab.ts");
  assert.doesNotMatch(schwab, /code exchange failed:", res\.status, txt\)/);
  assert.doesNotMatch(schwab, /Token exchange failed \(\$\{res\.status\}\): \$\{txt\}/);
  assert.match(schwab, /code exchange failed:", res\.status, errCode\)/);
});

// ── 4. Signals walls / total GEX re-priced; DEX missing delta is missing ────
import { buildGammaStructure } from "../../server/sources";
import { computeDEX, type Contract } from "../../server/chainAudit";
import { gexByStrikeFromChain } from "../../server/gammaProfile";

test("Signals gamma: walls bracket spot and come from re-priced GEX, not vendor gamma", () => {
  const S = 670, now = Date.parse("2026-10-09T20:30:00Z");
  const C = (sym: string, x: Record<string, unknown>) => ({ symbol: sym, ...x });
  const chain = {
    underlying: { last: S },
    callExpDateMap: { "2026-10-16:7": {
      // deep ITM call with huge OI and a huge (bogus) vendor gamma: old code
      // made it the "call wall" below spot
      "640.0": [C("SPY   261016C00640000", { openInterest: 90_000, gamma: 0.5, volatility: 20 })],
      "675.0": [C("SPY   261016C00675000", { openInterest: 30_000, gamma: 0.0001, volatility: 15 })],
      "690.0": [C("SPY   261016C00690000", { openInterest: 30_000, gamma: 0.0001, volatility: 15 })],
    } },
    putExpDateMap: { "2026-10-16:7": {
      "665.0": [C("SPY   261016P00665000", { openInterest: 40_000, gamma: -999, volatility: 17 })],
      "700.0": [C("SPY   261016P00700000", { openInterest: 80_000, gamma: 0.9, volatility: 14 })],
    } },
  };
  const g = buildGammaStructure(chain as any, now);
  assert.ok(g.callWall >= S, `call wall ${g.callWall} must be at/above spot`);
  assert.ok(g.putWall < S, `put wall ${g.putWall} must be below spot`);
  assert.equal(g.callWall, 675);   // nearer-the-money call dominates re-priced gamma
  assert.equal(g.putWall, 665);    // vendor gamma -999 irrelevant; the 700 put is above spot
  const ref = gexByStrikeFromChain(chain as any, now);
  const net = ref.profile.reduce((a, p) => a + p.netGex, 0);
  assert.ok(Math.abs(g.totalGex - net) <= 1e-6 * Math.abs(net));
  assert.ok(g.callWallGex > 0 && g.putWallGex < 0);
  // no strike on one side of spot -> unusable (unavailable upstream), not a 0 wall
  const oneSided = { underlying: { last: S }, callExpDateMap: chain.callExpDateMap, putExpDateMap: {} };
  assert.throws(() => buildGammaStructure(oneSided as any, now), /no re-priceable gamma/);
});

test("chain audit DEX: missing delta is excluded and reported, not summed as 0", () => {
  const base = { side: "call" as const, expiry: "2026-10-16", dte: 7, style: "PM" as const, tYears: 7 / 365, gamma: 0, theta: 0, vega: 0, rho: 0, iv: 0.15, theoreticalIV: null, volume: 0, mark: 0, last: 0, bid: 0, ask: 0, inTheMoney: false };
  const mk = (strike: number, delta: number | null, oi: number, side: "call" | "put" = "call"): Contract => ({ ...base, strike, delta, oi, side } as Contract);
  const S = 100;
  const ok = computeDEX([mk(100, 0.5, 10), mk(95, -0.3, 20, "put")], S);
  // hand: 0.5*10*100*100 = 50,000 ; -0.3*20*100*100 = -60,000
  assert.equal(ok.totalCallDex, 50_000);
  assert.equal(ok.totalPutDex, -60_000);
  assert.equal(ok.dexState, "ok");
  const part = computeDEX([mk(100, 0.5, 10), mk(105, null, 30)], S);
  assert.equal(part.totalNetDex, 50_000);
  assert.equal(part.dexState, "partial");
  assert.deepEqual(part.dexCoverage, { contractsWithDelta: 1, contractsMissingDelta: 1, oiMissingShare: 0.75 });
  const none = computeDEX([mk(105, null, 30)], S);
  assert.equal(none.dexState, "unavailable");
  assert.match(src("server/chainAudit.ts"), /Math\.abs\(c\.delta\) <= 1 \? c\.delta : null/);
  assert.doesNotMatch(src("server/chainAudit.ts"), /delta: c\.delta \?\? 0/);
  assert.match(src("client/src/components/Heatseeker.tsx"), /label=\{dexStatLabel\(totals\.dexState, totals\.dexCoverage\)\}/);
});

// ── 5. Edge Lab LLM filter: allow-list, verdict filtered ────────────────────
import { scrubBriefText, scrubBrief, isDescriptiveSentence, scrubVerdict, REMOVED_NOTE, VERDICT_REMOVED } from "../../server/edgeBriefText";

const ORDERS = [
  "Buy 0DTE calls above 5800.", "Sell the 5750 puts.", "Consider buying SPY calls on a dip.",
  "Short SPX into the call wall.", "Take profits at 5820.", "Use a stop at 5790.",
  "Odds favor a pin near 5800.", "There is a 60% chance of a pin.", "60-70% likely to pin.",
  "Go long above the flip.", "Load up on puts.", "Risk 1% of the account.",
  "Hold the 5800 calls into the close.", "You should fade the pop.", "Set a target at 5850.",
  "Stops below 5780 make sense.", "Trade 2 contracts per $10k.",
];
const DESCRIPTIVE = ["The put wall at 5700 held twice.", "IV is above realized by 1.3x.", "A short squeeze is possible.", "watch: price relative to zero-gamma 5800."];

test("edge brief: every order / odds phrasing is dropped in both modes; descriptive sentences kept", () => {
  for (const c of ORDERS) {
    assert.equal(scrubBriefText(c, { strict: true }), REMOVED_NOTE, `strict leaked: ${c}`);
    assert.equal(scrubBriefText(c), REMOVED_NOTE, `deny-list leaked: ${c}`);
  }
  for (const d of DESCRIPTIVE) {
    assert.equal(scrubBriefText(d, { strict: true }), d, `strict dropped: ${d}`);
    assert.equal(scrubBriefText(d), d);
    assert.equal(isDescriptiveSentence(d), true);
  }
  assert.equal(scrubBriefText("IV is above RV. Buy calls above 5800. The flip sits at 5790.", { strict: true }), "IV is above RV. The flip sits at 5790.");
});

test("edge brief: verdict is filtered (SELL PREMIUM never reaches the chip)", () => {
  assert.equal(scrubVerdict("SELL PREMIUM"), VERDICT_REMOVED);
  assert.equal(scrubVerdict("go long"), VERDICT_REMOVED);
  assert.equal(scrubVerdict("IV above RV"), "IV above RV");
  const b = scrubBrief({ verdict: "SELL PREMIUM", verdictColor: "emerald", confidence: 80, summary: "IV is rich.", baseCase: { thesis: "", prob: 0.5 }, bullCase: { thesis: "", prob: 0.2 }, bearCase: { thesis: "", prob: 0.3 }, actionable: "", invalidation: "", counterargument: "", bullets: ["Buy the dip", "ratio: 1.3x"] }, { strict: true });
  assert.equal(b.verdict, VERDICT_REMOVED);
  assert.equal(b.verdictColor, "neutral");
  assert.deepEqual(b.bullets, ["ratio: 1.3x"]);
  assert.match(src("server/edgeLabBrief.ts"), /return scrubBrief\(brief, \{ strict: true \}\);/);
});

// ── 6. News playbook descriptive; daily playbook wording and term state ─────
import { buildNewsPlaybook } from "../../server/playbook";
import { setSnapshotProvider, buildDailyPlaybook } from "../../server/dailyPlaybook";

test("news playbook: levels as context, no BUY/SELL/stop/T1/T2", () => {
  const out = buildNewsPlaybook(
    [{ kind: "FOMC", label: "FOMC", timeLabel: "2pm" }, { kind: "ECON", label: "CPI" }, { kind: "ECON", label: "Treasury auction" }],
    5800, 5850, 5750,
  )!;
  assert.equal(out.length, 3);
  for (const np of out) {
    for (const t of [np.bullScenario, np.bearScenario]) {
      assert.match(t, /Context only, not an entry, stop or target\.$/);
      const body = t.replace(/ Context only, not an entry, stop or target\.$/, "");
      assert.doesNotMatch(body, /\b(BUY|SELL|buy|sell|stop|T1|T2|targets?|entry|R:R)\b/);
    }
    assert.equal(np.kind, "context-levels");
  }
  // hand: call wall 5850 is +50 pts, +0.86% from 5800; put wall 5750 is -50 pts, -0.86%
  assert.match(out[0].bullScenario, /^Dovish read: nearest gamma level above is the call wall 5850 \(\+50 pts, \+0\.86% from spot 5800\)/);
  assert.match(out[0].bearScenario, /^Hawkish read: nearest gamma level below is the put wall 5750 \(-50 pts, -0\.86% from spot 5800\)/);
  assert.match(out[1].bullScenario, /^Cool print/);
  assert.match(out[2].bullScenario, /^Risk-on reaction/);
});

test("daily playbook: headline says '% wt, heuristic'; missing VIX9D/VIX3M is unavailable", async () => {
  const NOWs = Math.floor(Date.UTC(2026, 9, 9, 15, 0) / 1000);
  setSnapshotProvider(async () => ({
    capturedAt: NOWs, spy: { price: 700 },
    gamma: { spot: 700, totalGex: 1e9, callWall: 710, putWall: 690, zeroGamma: 695, maxPain: 700 },
    vol: { vix: { value: 18 } },
    term: { vix9d: null, vix: 18, vix3m: 20, ratio9dOver30d: null, ratio30dOver3m: 0.9 },
  }) as any);
  const pb: any = await buildDailyPlaybook("SPY");
  assert.match(pb.headline, /\(\d+% wt, heuristic\)/);
  assert.doesNotMatch(pb.headline, /(lean up|lean down|pin & chop) \(\d+%\)/);
  const v3 = pb.inputs.find((i: any) => i.key === "vix3m");
  assert.match(v3.calibration, /^unavailable/);
  assert.doesNotMatch(JSON.stringify(pb), /Flat\/backwardation|VIX backwardation/);
  // both ratios present and in contango -> labelled contango
  setSnapshotProvider(async () => ({
    capturedAt: NOWs, spy: { price: 700 },
    gamma: { spot: 700, totalGex: 1e9, callWall: 710, putWall: 690, zeroGamma: 695, maxPain: 700 },
    vol: { vix: { value: 18 } },
    term: { vix9d: 16, vix: 18, vix3m: 20, ratio9dOver30d: 16 / 18, ratio30dOver3m: 0.9 },
  }) as any);
  const pb2: any = await buildDailyPlaybook("SPY");
  assert.equal(pb2.inputs.find((i: any) => i.key === "vix3m").calibration, "Contango (calm)");
});

// ── 7. Quarterly cone: SPX ATM IV term + Student-t(4), no hand-set multipliers
import { buildQuarterlyTrajectory, QuarterlyConeUnavailableError } from "../../server/quarterlyTrajectory";
import { studentTSumQuantileFft } from "../../server/tickerConeMath";

// Seeded RNG (mulberry32) + Box-Muller, for an independent Monte Carlo check.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("quarterly cone: t(4)-sum quantile used by the cone matches a seeded Monte Carlo (n = 6)", () => {
  const u = rng(42);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  // unit-variance t(4): Z / sqrt(chi2_4 / 4) x sqrt((4 - 2) / 4)
  const t4 = () => { let c = 0; for (let i = 0; i < 4; i++) { const g = gauss(); c += g * g; } return (gauss() / Math.sqrt(c / 4)) * Math.SQRT1_2; };
  const N = 200_000, n = 6, xs = new Float64Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < n; j++) s += t4(); xs[i] = s / Math.sqrt(n); }
  xs.sort();
  const mc = xs[Math.floor(0.8413447460685429 * N)];
  const fft = studentTSumQuantileFft(0.8413447460685429, n, 4, 66);
  assert.ok(Math.abs(mc - fft) < 0.01, `MC ${mc} vs FFT ${fft}`);
  assert.ok(fft < 1, "t(4) shoulders: the 84.13% quantile of a unit-variance sum is inside 1 sd");
});

const NOW_FRI = Date.parse("2026-10-09T14:00:00Z"); // Fri 10:00 ET
const BASE_IN = { spot: 6700, vix: 18, vix9d: 15, vix3m: 20, callWall: 6900, putWall: 6500, gammaFlip: 6600, maxPain: 6650, totalGex: 2e9, composite: 50, skew: 130, nowMs: NOW_FRI };

test("quarterly cone: flat 20% ATM IV -> known answer at week 1 and week 13, no damping or event bump", () => {
  const ivTerm = [
    { expiry: "2026-11-20", T: 0.1, atmIv: 0.2, w: 0.004 },
    { expiry: "2027-03-19", T: 0.45, atmIv: 0.2, w: 0.018 },
  ];
  const t = buildQuarterlyTrajectory({ ...BASE_IN, realizedVol20d: 0.10, ivTerm });
  assert.equal(t.sigmaSource, "spx_atm_iv_term");
  const w1 = t.weeks[0];
  // Week 1 ends Fri 2026-10-16 16:00 ET = 20:00Z: T = 7.25 days / 365.
  // Sessions with a close after now through 10-16: Oct 9, 12, 13, 14, 15, 16 = 6.
  assert.equal(w1.weekEndDate, "2026-10-16");
  assert.equal(w1.sessions, 6);
  const T1 = 7.25 / 365;
  assert.ok(Math.abs(w1.tYears! - T1) < 1e-12);
  assert.ok(Math.abs(w1.totalVariance! - 0.04 * T1) < 1e-15);
  const sd1 = 0.2 * Math.sqrt(T1);
  const z = studentTSumQuantileFft(0.8413447460685429, 6, 4, 66);
  assert.ok(Math.abs(w1.bull - 6700 * Math.exp(z * sd1)) <= 0.006, `${w1.bull}`);
  assert.ok(Math.abs(w1.bear - 6700 * Math.exp(-z * sd1)) <= 0.006, `${w1.bear}`);
  assert.equal(w1.base, 6700);
  // Every week: w = 0.04 T exactly, OPEX/FOMC weeks included (tags only, no bump).
  for (const w of t.weeks) assert.ok(Math.abs(w.totalVariance! - 0.04 * w.tYears!) < 1e-15, w.weekLabel);
  assert.ok(t.weeks.some((w) => (w.events ?? []).length > 0), "event weeks still tagged");
  // Week 13: Fri 2027-01-08, 13 weeks out; Thanksgiving / Christmas / New Year holidays skipped.
  const w13 = t.weeks[12];
  assert.equal(w13.weekEndDate, "2027-01-08");
  assert.equal(t.drivers.vrpScale, 1);
  assert.doesNotMatch(t.methodology, /1\.12/);
  const qsrc = src("server/quarterlyTrajectory.ts");
  assert.doesNotMatch(qsrc, /\? 1\.12 : 1\.0|function damp\(|\* vrpScale/);
});

test("quarterly cone: term interpolation is linear in total variance; fallback realized vol labelled; none -> unavailable", () => {
  const ivTerm = [
    { expiry: "2026-11-20", T: 0.1, atmIv: 0.15, w: 0.15 * 0.15 * 0.1 },
    { expiry: "2027-03-19", T: 0.3, atmIv: 0.20, w: 0.2 * 0.2 * 0.3 },
  ];
  const t = buildQuarterlyTrajectory({ ...BASE_IN, ivTerm });
  const w13 = t.weeks[12];
  const T = w13.tYears!;
  assert.ok(T > 0.1 && T < 0.3);
  const expected = 0.00225 + (0.012 - 0.00225) * (T - 0.1) / 0.2;
  assert.ok(Math.abs(w13.totalVariance! - expected) < 1e-15);
  const rv = buildQuarterlyTrajectory({ ...BASE_IN, realizedVol20d: 0.16, ivTerm: [] });
  assert.equal(rv.sigmaSource, "realized_20d");
  assert.match(rv.methodology, /FALLBACK/);
  for (const w of rv.weeks) assert.ok(Math.abs(w.totalVariance! - 0.0256 * w.sessions! / 252) < 1e-15);
  assert.throws(() => buildQuarterlyTrajectory({ ...BASE_IN, realizedVol20d: null, ivTerm: null }), QuarterlyConeUnavailableError);
});

test("models path label does not use the raw GEX sign when gamma is unknown", () => {
  assert.match(src("server/models.ts"), /if \(gammaZone === "y\?"\) path = "gamma unknown \(no path claim\)"/);
});
