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
