// 2026-11-16 tab audit, Models / Heatseeker / Regime batch (items M2, M5-M9, M11-M13, M15, M17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vixToAtmPct } from "../../shared/vol";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("VIX day-over-day is read in VIX points, not as a daily sigma in percent", () => {
  // iv1d = vixToAtmPct(vix) / sqrt(252). A 4-point VIX day moves it by about 0.22, far under the old 0.25 / 1.0 tests.
  const iv1d = (vix: number) => vixToAtmPct(vix) / Math.sqrt(252);
  const d = iv1d(21) - iv1d(17);
  assert.ok(d < 0.25, `a 4-point VIX day is ${d.toFixed(3)} in daily-sigma percent`);
  const ptsPer = Math.sqrt(252) / vixToAtmPct(1);
  assert.ok(Math.abs(d * ptsPer - 4) < 1e-9, "the conversion recovers the VIX points");
  const m = read("server/models.ts");
  assert.match(m, /if \(vixDeltaPts != null && Math\.abs\(vixDeltaPts\) >= 1\.0\) \{\s*dodLabel = vixDeltaPts > 0 \? "Vol Bid Up" : "Vol Offered";/);
  assert.match(read("server/mmMatrix.ts"), /vixDelta: a\.termStructureDoD\?\.vixDeltaPts \?\? null,/);
  assert.match(read("client/src/components/ModelsPanel.tsx"), /1D σ \(from VIX\)/);
});

test("states: models session is live only in the session and never on a last-session chain; Heatseeker and Thermal carry lastSession; a missing VIX is no magnitude, not zero", () => {
  const m = read("server/models.ts");
  assert.match(m, /if \(!isRegularSessionOpen\(Date\.now\(\)\) \|\| built\.some\(\(h\) => h\.chainLastSession === true\)\) out\.session = "last-close";/);
  const r = read("server/routes.ts");
  assert.match(r, /result\.chainLastSession = chain\.lastSession === true;/);
  assert.match(r, /staleReason: chain\.staleReason \?\? null, lastSession: chain\.lastSession === true, maxAgeMs: chain\.maxAgeMs \?\? null \}/);
  assert.match(read("client/src/components/ThermalHeatmap.tsx"), /state=\{data\.chain\.lastSession \? "last_session" : data\.chain\.stale \? "stale" : "ok"\}/);
  const mm = read("server/mmMatrix.ts");
  assert.match(mm, /\): number \| null \{\s*if \(!vix\) return null;/);
  const p = read("client/src/components/ModelsPanel.tsx");
  assert.match(p, /c\.magnitude != null \? `±\$\{c\.magnitude\}` : "—"/);
  assert.doesNotMatch(p, />LIVE \{/, "no hard-coded LIVE beside a spot value");
  assert.match(p, /stale \? "STORED BUILD" : session === "live" \? "LIVE" : "LAST SESSION"/);
});

test("labels: unknown gamma is not shown as positive, no knife edge without a zone, no advice words, near-charm-zero is called that, regimes carry no direction tone", () => {
  const p = read("client/src/components/ModelsPanel.tsx");
  assert.doesNotMatch(p, /a\.gammaAtSpot >= 0\s*\?\s*\{ text: "POS/);
  assert.match(p, /Γ sign unknown|\\u0393 sign unknown/);
  assert.doesNotMatch(p, /KNIFE EDGE|Sell zone|Buy zone|FIRST FLIP|NEG-Γ ENTRY/);
  assert.match(p, /NO DOUBLE-ZERO ZONE \(charm zero not found\)/);
  assert.match(p, /near charm zero/);
  const h = read("server/headline.ts");
  assert.match(h, /function regimeTone\(_r: string\): "bull" \| "bear" \| "neutral" \| "warning" \{\s*return "neutral";/);
  assert.doesNotMatch(h, /price has been pinning around strikes|ATM ±20 strikes, refreshed every 4s/);
});

test("scenario targets are spot +- 1 EM, as they always were, and the code now says so; canary compares a closed market with a full day's sigma", () => {
  const m = read("server/models.ts");
  assert.match(m, /const bullTarget = spot \+ horizonEM;\s*const baseTarget = spot;\s*const bearTarget = spot - horizonEM;/);
  assert.match(m, /\/\/ bull = spot \+ EM, base = spot, bear = spot - EM,/);
  const c = read("server/canary.ts");
  assert.match(c, /if \(!len0 \|\| c\.minutes >= REGULAR_OPEN_MIN \+ len0\) return 1;/);
});

test("review follow-ups: regime predictor and the logged MM feature read VIX points; a cached live build is not live after the close", () => {
  const rp = readFileSync(new URL("../../server/regimePredictor.ts", import.meta.url), "utf8");
  assert.match(rp, /const ivTermDelta = Number\(term\.vixDeltaPts \?\? 0\);/);
  assert.match(rp, /const IV_TERM_MOVE_PTS = 1\.0;/);
  assert.doesNotMatch(rp, /ivTermDelta [<>] -?0\.(25|02)/);
  const mp = readFileSync(new URL("../../server/mmPredictions.ts", import.meta.url), "utf8");
  assert.match(mp, /vixDelta: a\.termStructureDoD\?\.vixDeltaPts \?\? null,/);
  const r = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(r, /d\.session === "live" && !isRegularSessionOpen\(Date\.now\(\)\) \? \{ \.\.\.d, session: "last-close" \} : d;/);
  assert.match(r, /if \(gate\.serve && cached\) return atServeSession\(cached\.data\);/);
});
