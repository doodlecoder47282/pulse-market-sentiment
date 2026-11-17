// DFI retired as a magnitude (2026-11-17). The "Delta Flow Indicator" was
// (dDEX/dS) / |GEX| * 1e9 clamped to [-5, 5]: always +5 or -5, i.e. the sign
// of the dealer delta-exposure slope. These tests pin the replacement: the
// sign stated as a sign, the regime bucket keyed on the gamma zone and the
// flip distance, and no consumer treating the sign as a magnitude.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FLIP_DISTANCE_STRONG_EM, dexSlopeSignAt, dexSlopeSignValue, dexSlopeLegacyLabel, dexSlopeSignFromAudit,
  flipDistanceEM, regimeBucketFor, regimeBucketFromAudit, flipDistanceText,
} from "../../shared/gammaRegime";
import { predictTransition, recordRawRegime, _resetPredictorHistory } from "../../server/regimePredictor";
import { dailyCardHeader } from "../../server/dailyCardHeader";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${f}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(rel);
  }
  return out;
}

test("DEX slope sign: positive / negative / flat / unavailable, and the legacy fields carry the sign only", () => {
  const up = [{ spot: 5990, dex: -2e9 }, { spot: 6000, dex: 0 }, { spot: 6010, dex: 3e9 }];
  const dn = up.map((p) => ({ spot: p.spot, dex: -p.dex }));
  const flat = up.map((p) => ({ spot: p.spot, dex: 7 }));
  assert.equal(dexSlopeSignAt(up, 6001), "positive");
  assert.equal(dexSlopeSignAt(dn, 6001), "negative");
  assert.equal(dexSlopeSignAt(flat, 6001), "flat");
  // A tiny slope is still its sign: there is no scaling and no dead band.
  assert.equal(dexSlopeSignAt([{ spot: 1, dex: 0 }, { spot: 2, dex: 1e-12 }, { spot: 3, dex: 2e-12 }], 2), "positive");
  // Fewer than 3 points, no curve, or a zero spot step: no slope exists.
  assert.equal(dexSlopeSignAt(up.slice(0, 2), 6000), "unavailable");
  assert.equal(dexSlopeSignAt(null, 6000), "unavailable");
  assert.equal(dexSlopeSignAt([{ spot: 6000, dex: 1 }, { spot: 6000, dex: 2 }, { spot: 6000, dex: 3 }], 6000), "unavailable");
  // Edge of the curve: one-sided difference, still a sign.
  assert.equal(dexSlopeSignAt(up, 5000), "positive");

  assert.deepEqual(["positive", "negative", "flat", "unavailable"].map((s) => dexSlopeSignValue(s as any)), [1, -1, 0, 0]);
  assert.deepEqual(
    ["positive", "negative", "flat", "unavailable"].map((s) => dexSlopeLegacyLabel(s as any)),
    ["POSITIVE SLOPE", "NEGATIVE SLOPE", "FLAT", "UNAVAILABLE"],
  );
  // Reading a payload: the new field wins; a legacy number of any size is its sign; dfiState gates it.
  assert.equal(dexSlopeSignFromAudit({ dexSlopeSign: "negative", dfi: 5 }), "negative");
  assert.equal(dexSlopeSignFromAudit({ dfi: 5, dfiState: "ok" }), "positive");
  assert.equal(dexSlopeSignFromAudit({ dfi: -1 }), "negative");
  assert.equal(dexSlopeSignFromAudit({ dfi: 0, dfiState: "ok" }), "flat");
  assert.equal(dexSlopeSignFromAudit({ dfi: 0, dfiState: "unavailable" }), "unavailable");
  assert.equal(dexSlopeSignFromAudit({}), "unavailable");
  assert.equal(dexSlopeSignFromAudit(null), "unavailable");

  // models.ts: the scaling and the clamp are gone, the labels are slope words, the payload carries the sign.
  const m = src("server/models.ts");
  assert.doesNotMatch(m, /gexAbs \* 1e9|Math\.max\(-5, Math\.min\(5/);
  assert.doesNotMatch(m, /"BULLISH"|"BEARISH"/);
  assert.match(m, /const dexSlopeSign = dexSlopeSignAt\(profile\.curve, spot\);/);
  assert.match(m, /const dfi = dexSlopeSignValue\(dexSlopeSign\);/);
  assert.match(m, /const dfiLabel = dexSlopeLegacyLabel\(dexSlopeSign\);/);
  assert.match(m, /dexSlopeSign: DexSlopeSign;/);
  assert.match(m, /@deprecated A SIGN ONLY/);
  // The database column keeps its name.
  assert.match(src("server/storage.ts"), /dfi REAL NOT NULL/);
});

test("regime bucket: gamma zone picks CHOP / TREND, flip distance picks STRONG / WEAK", () => {
  assert.equal(FLIP_DISTANCE_STRONG_EM, 0.5);
  // flip distance: signed, in 1-day expected moves
  assert.equal(flipDistanceEM(6020, 6000, 40), 0.5);
  assert.equal(flipDistanceEM(5990, 6000, 40), -0.25);
  for (const [s, f, em] of [[6000, null, 40], [6000, 6000, null], [6000, 6000, 0], [null, 6000, 40], [6000, NaN, 40], [6000, 0, 40]] as const) {
    assert.equal(flipDistanceEM(s, f, em), null);
  }
  // positive gamma -> CHOP, negative gamma -> TREND; at least 0.5 EM from the flip -> STRONG
  assert.equal(regimeBucketFor("y+", 0.5), "CHOP_STRONG");
  assert.equal(regimeBucketFor("y+", -1.2), "CHOP_STRONG");
  assert.equal(regimeBucketFor("y+", 0.49), "CHOP_WEAK");
  assert.equal(regimeBucketFor("y", 0.1), "CHOP_WEAK"); // legacy "pocket" value
  assert.equal(regimeBucketFor("y-", -0.5), "TREND_STRONG");
  assert.equal(regimeBucketFor("y-", 2), "TREND_STRONG");
  assert.equal(regimeBucketFor("y-", -0.2), "TREND_WEAK");
  // missing flip or missing expected move -> WEAK
  assert.equal(regimeBucketFor("y+", flipDistanceEM(6000, null, 40)), "CHOP_WEAK");
  assert.equal(regimeBucketFor("y-", flipDistanceEM(6000, 5900, null)), "TREND_WEAK");
  assert.equal(regimeBucketFor("y-", NaN), "TREND_WEAK");
  // unknown gamma sign makes no trend / chop claim; no gamma zone at all is missing inputs
  assert.equal(regimeBucketFor("y?", 2), "GAMMA_UNKNOWN");
  assert.equal(regimeBucketFor("", 2), "GAMMA_UNKNOWN");
  assert.equal(regimeBucketFor(null, 2), "INPUTS_UNAVAILABLE");
  assert.equal(regimeBucketFor(undefined, null), "INPUTS_UNAVAILABLE");
  // The slope sign plays no part.
  assert.equal(regimeBucketFor.length, 2);

  assert.equal(flipDistanceText(0.62), "0.62 expected moves above the gamma flip");
  assert.equal(flipDistanceText(-0.3), "0.30 expected moves below the gamma flip");
  assert.equal(flipDistanceText(null), "gamma flip distance unavailable");
});

test("realtimeTargets.detectRegime and the predictor read the same bucket; the slope sign does not move it", () => {
  // detectRegime is this shared function (realtimeTargets itself imports the Schwab client, not loadable here).
  const rt = src("server/realtimeTargets.ts");
  assert.match(rt, /export function detectRegime\(audit: any, liveSpot\?: number\): RegimeBucket \{\s*return regimeBucketFromAudit\(audit, liveSpot\);\s*\}/);
  assert.match(rt, /const rawRegime = detectRegime\(input\.audit \?\? \{\}, input\.spot\);/);
  assert.doesNotMatch(rt, /dfi >= |Math\.abs\(Number\(audit\.dfi\)\)/);
  const detectRegime = regimeBucketFromAudit;
  const mk = (gz: unknown, spot: number, dfi: number) => ({ gammaZone: gz, spot, gammaFlip: 6000, mainPivot: 6000, dfi, dfiState: "ok", scenarioTargets: { oneDayEM: 40 } });
  for (const dfi of [1, -1, 0, 5, -5]) {
    assert.equal(detectRegime(mk("y-", 5970, dfi)), "TREND_STRONG");
    assert.equal(detectRegime(mk("y-", 5990, dfi)), "TREND_WEAK");
    assert.equal(detectRegime(mk("y+", 6030, dfi)), "CHOP_STRONG");
    assert.equal(detectRegime(mk("y+", 6010, dfi)), "CHOP_WEAK");
    assert.equal(detectRegime(mk("y?", 6030, dfi)), "GAMMA_UNKNOWN");
  }
  // live spot overrides the audit spot
  assert.equal(detectRegime(mk("y+", 6010, 1), 6030), "CHOP_STRONG");
  assert.equal(detectRegime({}), "INPUTS_UNAVAILABLE");
  assert.equal(detectRegime(null), "INPUTS_UNAVAILABLE");
  assert.equal(detectRegime({ gammaZone: "y-" }), "TREND_WEAK"); // no flip, no EM

  const nowMs = Date.parse("2026-11-06T16:00:00Z");
  for (const dfi of [1, -1]) {
    _resetPredictorHistory();
    const o = predictTransition({ audit: mk("y-", 5970, dfi), spot: 5970, nowMs } as any);
    assert.equal(o.currentRegime, "TREND_STRONG");
    assert.equal(o.drivers.flipDistanceEM, -0.75);
    assert.equal(o.drivers.dexSlopeSign, dfi > 0 ? "positive" : "negative");
  }
  // Same inputs, opposite slope sign: identical candidate scores.
  _resetPredictorHistory();
  const p = predictTransition({ audit: mk("y+", 6010, 1), spot: 6010, nowMs } as any);
  _resetPredictorHistory();
  const n = predictTransition({ audit: mk("y+", 6010, -1), spot: 6010, nowMs } as any);
  assert.deepEqual(p.candidates, n.candidates);
});

test("predictor: no flip-distance projection; the current regime is carried forward and a note says so", () => {
  const nowMs = Date.parse("2026-11-06T16:00:00Z");
  const audit = (spot: number) => ({ gammaZone: "y-", spot, gammaFlip: 6000, mainPivot: 6000, dfi: -1, dfiState: "ok", scenarioTargets: { oneDayEM: 40 } });
  _resetPredictorHistory();
  const a = predictTransition({ audit: audit(5970), spot: 5970, nowMs, horizonMinutes: 20 } as any);
  assert.equal(a.drivers.dfiSlopePerMin, null);
  assert.equal(a.drivers.flipDistanceEM, -0.75);
  assert.ok(a.driverNotes.some((x) => /no flip-distance projection is made: the current regime is carried forward/.test(x)), a.driverNotes.join(" | "));
  assert.ok(!a.driverNotes.some((x) => /DFI/.test(x)));
  for (const k of ["boundaryDistance", "nextBoundary", "flipDistanceSlopePerMin", "projectedFlipDistanceEM"]) assert.ok(!(k in a.drivers), k);

  // Review must-fix: y-, flip 6000, EM 40, spot 5990 (TREND_WEAK), and a noisy short history in which
  // spot moved 2 points over 60 s. A slope extrapolated from that once produced "heavy chop scores
  // highest next ... would flip from weak trend". Now the history cannot move the call at all.
  _resetPredictorHistory();
  const base = predictTransition({ audit: audit(5990), spot: 5990, nowMs, horizonMinutes: 20 } as any);
  _resetPredictorHistory();
  const spots = [5988, 5988.6, 5987.9, 5989.2, 5988.4, 5990];
  spots.forEach((_s, i) => recordRawRegime("TREND_WEAK", nowMs - (spots.length - i) * 10_000));
  const noisy = predictTransition({ audit: audit(5990), spot: 5990, nowMs, horizonMinutes: 20 } as any);
  assert.equal(noisy.currentRegime, "TREND_WEAK");
  assert.match(noisy.candidates[0].regime, /^TREND_/);
  assert.doesNotMatch(noisy.headline, /would flip/);
  assert.ok(!noisy.driverNotes.some((x) => /would flip|moving toward|at this rate/.test(x)), noisy.driverNotes.join(" | "));
  // Same inputs with and without the history: the same candidate scores (history only sets sample quality).
  assert.deepEqual(noisy.candidates, base.candidates);
  _resetPredictorHistory();

  const rp = src("server/regimePredictor.ts");
  assert.doesNotMatch(rp, /DFI_BOUNDARIES|projectedDfi|dfiSlopeFromHistory|rawRegimeFor\(|flipDistSlope|projectedFlipDist|projectedRegimeFor|projectedRaw/);
  assert.match(rp, /export function recordRawRegime\(raw: RegimeBucket, ts: number = Date\.now\(\)\): void/);
});

test("predictor: candidate weights sum to 1 with no NaN across missing flip, missing expected move and empty history", () => {
  const nowMs = Date.parse("2026-11-06T16:00:00Z");
  const full = { gammaZone: "y-", spot: 5990, gammaFlip: 6000, mainPivot: 6000, charmZero: 5995, dfi: -1, dfiState: "ok", scenarioTargets: { oneDayEM: 40 } };
  const cases: Array<[string, any, boolean]> = [
    ["complete, empty history", full, false],
    ["complete, with history", full, true],
    ["missing flip", { ...full, gammaFlip: null }, false],
    ["missing flip, positive gamma", { ...full, gammaFlip: undefined, gammaZone: "y+" }, true],
    ["missing expected move", { ...full, scenarioTargets: {} }, false],
    ["missing flip and expected move", { gammaZone: "y+", spot: 5990, mainPivot: 6000 }, false],
    ["unknown gamma", { ...full, gammaZone: "y?" }, false],
    ["no audit fields", {}, false],
  ];
  for (const [name, audit, withHistory] of cases) {
    _resetPredictorHistory();
    if (withHistory) for (let i = 0; i < 6; i++) recordRawRegime("TREND_WEAK", nowMs - (6 - i) * 10_000);
    const o = predictTransition({ audit, spot: 5990, nowMs, horizonMinutes: 20 } as any);
    assert.ok(Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1, name);
    assert.ok(Number.isFinite(o.confidenceScore), name);
    if (o.candidates.length === 0) {
      // no read (missing expected move / pivot, unknown gamma): no candidates and nothing for the logger
      assert.equal(o.confidence, 0, name);
      continue;
    }
    let sum = 0;
    for (const c of o.candidates) {
      assert.ok(Number.isFinite(c.probability) && Number.isFinite(c.score), `${name}: ${c.regime}`);
      sum += c.probability;
    }
    assert.ok(Math.abs(sum - 1) < 1e-9, `${name}: sums to ${sum}`);
    assert.equal(o.candidates[0].regime, o.currentRegime, `${name}: nothing here outweighs the carried regime`);
  }
  _resetPredictorHistory();
});

test("computeScenarioProb: no slope-sign input, and the fallback is only used when implied odds are missing", async () => {
  const m = src("server/models.ts");
  const fn = m.slice(m.indexOf("export function computeScenarioProb("), m.indexOf("// Normalise", m.indexOf("export function computeScenarioProb(")));
  assert.doesNotMatch(fn, /dfi|bullBoost|bearBoost|tanh|dexSlope/);
  assert.match(m, /computeScenarioProb\(gammaZone, \{/);
  // The heuristic is a fallback: the implied odds overwrite it whenever they exist.
  assert.match(m, /let scenarioProb = extras\.scenarioProbIn \?\? computeScenarioProb\(/);
  assert.match(m, /if \(g\) \{\s*scenarioProb = toPercentTriple\(g\);\s*scenarioProbSource = "risk-neutral-implied";/);
  // The removed boost was a constant: 0.10 * tanh(5 / 3) = 0.093 before normalisation.
  assert.ok(Math.abs(0.10 * Math.tanh(5 / 3) - 0.0931) < 1e-4);
});

test("mmMatrix: no DFI tilt; the matrix does not read the slope sign", () => {
  const mm = src("server/mmMatrix.ts");
  assert.doesNotMatch(mm, /inp\.dfi|dfi: a\.dfi|dfi: number/);
});

test("no user-facing string says Delta Flow or prints the slope as a magnitude", () => {
  const files = [...walk("server"), ...walk("client/src"), ...walk("shared")];
  const offenders: string[] = [];
  for (const f of files) {
    const lines = src(f).split("\n");
    lines.forEach((line, i) => {
      // comments may record the history: drop // tails, /* ... */ spans and block-comment body lines
      const code = /^\s*(\*|\/\*)/.test(line) ? "" : line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
      const where = `${f}:${i + 1}`;
      if (/delta flow/i.test(code)) offenders.push(`${where} says Delta Flow`);
      // the slope printed as a number: dfi.toFixed / fmt0(dfi) / Math.round(dfi) / ${dfi}
      if (/dfi(Raw|ForSnap)?\s*\)?\.toFixed|fmt0\(dfi\)|Math\.round\((context\.)?dfi\)|\$\{[^}]*\bdfi\b\s*\}/.test(code)) offenders.push(`${where} prints the slope sign as a number`);
      // a DFI label inside a string or JSX text
      if (/(["'`>]|\s)DFI[ :]/.test(code) && !f.endsWith("particleFilterDFI.ts")) offenders.push(`${where} shows a DFI label`);
      if (/dfi.*(BULLISH|BEARISH)|(BULLISH|BEARISH).*dfi/i.test(code)) offenders.push(`${where} labels the slope sign bullish / bearish`);
    });
  }
  assert.deepEqual(offenders, []);

  // The surfaces say the sign in words.
  assert.match(dailyCardHeader({ dexSlopeSign: "negative", dfi: -1 }, null, null).description, /DEX slope negative/);
  assert.match(src("server/discordBatcaveCard.ts"), /DEX slope: \$\{dexSlope\}/);
  assert.match(src("server/discord.ts"), /DEX slope \\`\$\{dexSlopeWord\(context\.dfi\)\}\\`/);
  const mp = src("client/src/components/ModelsPanel.tsx");
  assert.match(mp, /DEX slope: \{dexSlopeSignFromAudit\(a\)\}/);
  assert.match(mp, /A sign only: it has no magnitude and it is not a flow measure\./);
  assert.match(mp, /flipDistanceText\(d\)/);
  const rp = src("client/src/components/RegimePredictPanel.tsx");
  assert.match(rp, /label="DEX slope"/);
  assert.match(rp, /label="flip distance"/);
  assert.doesNotMatch(rp, /dfi\.toFixed|dfiSlopePerMin\.toFixed/);
  // Regime copy says only what is measured: the gamma sign and the half-expected-move line.
  assert.doesNotMatch(rp, /delta-flow|Direction is set|Direction soft|pin strike|Pin pressure|pulled toward|TrendingUp|TrendingDown|Range-bound/);
  assert.match(rp, /the gamma zone, pivot or expected move is missing in this build/);
  assert.equal((rp.match(/play: "Negative gamma, and spot is /g) ?? []).length, 2);
  assert.equal((rp.match(/play: "Positive gamma, and spot is /g) ?? []).length, 2);
  assert.equal((rp.match(/No direction is implied\./g) ?? []).length, 2);
  // 0DTE reason text: the sign is aligned or not; no rounded-to-zero bonus printed as a reading.
  const od = src("server/odteAlertEngine.ts");
  assert.match(od, /DEX slope sign \$\{dfi > 0 \? "positive" : "negative"\}, aligned`\)/);
  assert.doesNotMatch(od, /aligned: \+\$\{mag\.toFixed/);
  assert.match(od, /const mag = Math\.min\(15, Math\.abs\(dfi\) \/ 30\);/); // arithmetic untouched
});

test("the 0.5 flip-distance line is defined once, as a named exported constant", () => {
  const files = [...walk("server"), ...walk("client/src"), ...walk("shared")];
  const defs = files.filter((f) => /(const|let|var)\s+FLIP_DISTANCE_STRONG_EM\b/.test(src(f)));
  assert.deepEqual(defs, ["shared/gammaRegime.ts"]);
  const g = src("shared/gammaRegime.ts");
  assert.equal((g.match(/FLIP_DISTANCE_STRONG_EM\s*=/g) ?? []).length, 1);
  assert.match(g, /Hand-set, not fit to outcomes\.\s*\*\/\s*export const FLIP_DISTANCE_STRONG_EM = 0\.5;/);
  // The regime code uses the constant, not a second literal.
  assert.match(g, /Math\.abs\(flipDistEM\) >= FLIP_DISTANCE_STRONG_EM/);
  for (const f of ["server/realtimeTargets.ts", "server/regimePredictor.ts"]) {
    assert.doesNotMatch(src(f), /flipDist\w*\)?\s*>=\s*0\.5/, f);
  }
});

test("regime read copy: describes the current read, never a forecast, a pin or a direction", () => {
  const banned = /What's Next|What&apos;s Next|transition forecast|next 20 ?min|next \$\{[^}]*\}min|would flip|pin pressure|trend has room|no transition indicated|forecast is reliable|scores highest next|forward-looking|bullish|bearish|herding|direction-setting|second pin|room to trend/i;
  for (const f of ["server/regimePredictor.ts", "client/src/components/RegimePredictPanel.tsx"]) {
    const hits = src(f).split("\n").map((l, i) => (banned.test(l) ? `${f}:${i + 1} ${l.trim().slice(0, 90)}` : null)).filter(Boolean);
    assert.deepEqual(hits, [], f);
  }
  const h = src("server/headline.ts");
  assert.doesNotMatch(h, /strong transition reading|20-minute regime outlook|Regime outlook for the next 20 minutes|the 20-minute outlook/);
  assert.match(h, /the drivers agree strongly with the current read/);
  assert.doesNotMatch(src("server/routes.ts"), /Forward-looking regime transition/);
  assert.doesNotMatch(src("client/src/components/TradeDesk.tsx"), /Regime transition forecast/);

  const ui = src("client/src/components/RegimePredictPanel.tsx");
  assert.match(ui, />Regime now</);
  assert.match(ui, /current read, not a forecast/);
  assert.match(ui, /How the drivers score each regime for the current read/);
  assert.doesNotMatch(ui, /#\{rank\}/);
  // The carried-forward note sits above the collapsed "Why", not inside it.
  const note = ui.indexOf("No flip-distance projection is made; this is the current regime carried forward.");
  assert.ok(note > 0 && note < ui.indexOf("{showWhy && ("), "note is outside the collapsed section");
  assert.match(ui, /hand-set heuristic weights, not probabilities/);

  // Live output across every driver branch: the top bucket is the current regime and the text says so.
  const nowLate = Date.parse("2026-11-06T20:30:00Z"); // under 1.5 h to the close
  const nowEarly = Date.parse("2026-11-06T15:00:00Z"); // first 1.5 h
  const mkAudit = (o: any) => ({ gammaZone: "y-", spot: 5990, gammaFlip: 6000, mainPivot: 6000, dfi: -1, dfiState: "ok", scenarioTargets: { oneDayEM: 40 }, ...o });
  const runs = [
    { audit: mkAudit({ charmZero: 5992, vannaBias: "negative", termStructureDoD: { vixDeltaPts: -1.4, label: "Vol Offered" } }), spot: 5990, nowMs: nowLate, macro: { vixTermRatio: 0.9 }, whalePressure: -0.8 },
    { audit: mkAudit({ spot: 5940, vannaBias: "positive", termStructureDoD: { vixDeltaPts: 2.1, label: "Vol Bid Up" } }), spot: 5940, nowMs: nowEarly, macro: { vixTermRatio: 1.2 }, whalePressure: 0.9 },
    { audit: mkAudit({ gammaZone: "y+", spot: 6003 }), spot: 6003, nowMs: nowLate, macro: null, whalePressure: null },
  ];
  for (const r of runs) {
    _resetPredictorHistory();
    for (let i = 0; i < 6; i++) recordRawRegime(i % 2 ? "TREND_WEAK" : "CHOP_WEAK", r.nowMs - (6 - i) * 10_000); // high flip rate
    const o = predictTransition({ ...r, horizonMinutes: 20 } as any);
    assert.equal(o.status, "ready");
    assert.equal(o.candidates[0].regime, o.currentRegime);
    assert.match(o.headline, /is the regime read now \(heuristic \d+\/100, a hand-set score, not a probability\)\. This is the current read carried forward, not a forecast\./);
    const text = [o.headline, ...o.driverNotes].join(" | ");
    assert.doesNotMatch(text, banned, text);
    assert.match(text, /no flip-distance projection is made/);
  }
  // The pivot note names the pivot and states the distance; the large-print note states its basis.
  _resetPredictorHistory();
  for (let i = 0; i < 6; i++) recordRawRegime("TREND_WEAK", nowLate - (6 - i) * 10_000);
  const o = predictTransition({ ...runs[0], horizonMinutes: 20 } as any);
  assert.ok(o.driverNotes.some((n) => /^spot is 0\.25 expected moves from the main pivot|^spot is 0\.\d\d expected moves from the main pivot \(under 0\.25\)/.test(n)) || o.drivers.gammaFlipProxFrac >= 0.25);
  assert.ok(o.driverNotes.some((n) => /large SPY option prints, last 30 minutes: 80% net premium on the put side \(calls counted \+, puts -, by premium; the buyer or seller side is not known\)/.test(n)), o.driverNotes.join(" | "));
  assert.ok(o.driverNotes.some((n) => /from the charm zero \(under 0\.20\)/.test(n)));
  _resetPredictorHistory();
});

test("third review: session notes are true outside the session window, and the badge is not labelled as the same figure as the headline score", async () => {
  const { readFileSync } = await import("node:fs");
  const p = readFileSync(new URL("../../server/regimePredictor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(p, /under 1\.5 hours to the close|first 1\.5 hours of the session/);
  assert.match(p, /if \(sessionFrac <= 0\) driverNotes\.push\(`the regular session is over:/);
  assert.match(p, /else if \(sessionFrac >= 1\) driverNotes\.push\(`the regular session has not opened:/);
  // The in-session notes print minutes computed from the fraction, not a fixed "1.5 hours" (the windows are 97.5 minutes).
  assert.match(p, /\$\{Math\.round\(sessionFrac \* 390\)\} minutes to 16:00 ET/);
  assert.match(p, /\$\{Math\.round\(\(1 - sessionFrac\) \* 390\)\} minutes since 09:30 ET/);
  // The "under 0.25" pivot note floors, so it cannot print "0.25 ... (under 0.25)".
  assert.match(p, /\(Math\.floor\(gammaFlipProxFrac \* 100\) \/ 100\)\.toFixed\(2\)\} expected moves from the main pivot \(under 0\.25\)/);
  const ui = readFileSync(new URL("../../client/src/components/RegimePredictPanel.tsx", import.meta.url), "utf8");
  assert.match(ui, /read strength \{conf\}\/100/);
  assert.doesNotMatch(readFileSync(new URL("../../server/headline.ts", import.meta.url), "utf8"), /pin pressure/);
});

