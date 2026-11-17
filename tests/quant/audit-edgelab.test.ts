// 2026-11-16 tab audit, Edge Lab / Trade Desk batch: the Anomaly crash, the
// drift units and gate, the doubled backtest cost, the ignored side selector,
// the gamma-curve null crash and inverted names, playbook targets on the wrong
// side of the entry and pivots filed by name instead of by side of spot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLevels } from "../../server/playbook";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("playbook levels: a target on the wrong side of the entry is dropped and R:R is signed", () => {
  // Short below the put wall at 589.5 with the flip (595) as the first level: 595 is above the entry.
  const short = buildLevels("short", 589.5, 590.5, 595, 585, 600);
  assert.equal(short.target1, 585, "the wrong-side level is dropped and the next one takes its place");
  assert.equal(short.target2, null);
  assert.equal(short.rr1, 4.5);
  // Long through the flip at 607.5 with a first level of 602 (below the entry) and a second of 612.
  const long = buildLevels("long", 607.5, 606.5, 602, 612, 600);
  assert.equal(long.target1, 612); assert.equal(long.rr1, 4.5);
  // Both levels on the wrong side: no target, no R:R (it used to print a positive ratio).
  const none = buildLevels("short", 589.5, 590.5, 595, 592, 600);
  assert.equal(none.target1, null); assert.equal(none.rr1, null);
  // A stop on the wrong side gives no ratio either.
  assert.equal(buildLevels("long", 600, 601, 605, null, 600).rr1, null);
  // Unchanged when the levels are where they should be.
  const ok = buildLevels("long", 600, 598, 604, 608, 600);
  assert.equal(ok.target1, 604); assert.equal(ok.target2, 608); assert.equal(ok.rr1, 2);
});

test("wiring: anomaly value never undefined, drift gate first and in fractions, cost once, side honoured, gamma ratio nullable and names say what the gamma is, pivots by side of spot", () => {
  const an = read("server/anomalyDetector.ts");
  assert.match(an, /const raw = n === "spy_ret_5d_z" \? spy5dRet\(rows, 0\) :/);
  assert.match(an, /value: typeof raw === "number" && Number\.isFinite\(raw\) \? raw : null/);
  assert.match(an, /if \(prior\.length < 30\) \{ status = "n\/a";/, "the sample gate comes before any verdict");
  assert.doesNotMatch(an, /model degrading, retrain or distrust|degrade signal confidence/);
  const ap = read("client/src/components/edgelab/AnomalyPanel.tsx");
  assert.match(ap, /f\.value == null \? "—"/);
  assert.match(ap, /\(d\.recent30\.meanAbsPctReturn \* 100\)\.toFixed\(0\)/, "fractions are shown as percent");
  assert.doesNotMatch(ap, /MAE \$\{/);
  const bt = read("server/signalBacktest.ts");
  assert.match(bt, /const DEFAULT_COST_BPS = 6;/);
  assert.match(bt, /const netBps = grossBps - costBps; \/\/ costBps is the round trip/);
  assert.doesNotMatch(bt, /costBps \* 2/);
  assert.doesNotMatch(bt, /sideArr\[i\] = "long";/, "no kind ignores the selected side");
  assert.equal((bt.match(/sideArr\[i\] = sideFor\("long"\)/g) ?? []).length, 4);
  assert.equal((bt.match(/sideArr\[i\] = sideFor\("short"\)/g) ?? []).length, 4);
  const gc = read("server/gammaCurve.ts");
  assert.match(gc, /const asymmetryRatio: number \| null = denom > 0 \? netAbove \/ denom : null;/);
  assert.match(gc, /bias = "amplifying-below";\s*biasNote = "heavy negative gamma below spot/);
  assert.match(gc, /bias = "damping-below";\s*biasNote = "positive gamma below spot/);
  assert.match(read("client/src/components/edgelab/GammaCurvePanel.tsx"), /asymmetryRatio == null \? "—"/);
  const pb = read("server/playbook.ts");
  assert.match(pb, /\(level > spot \? resistance : support\)\.push\(\{ level, label \}\);/);
});
