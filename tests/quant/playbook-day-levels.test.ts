// The daily playbook describes the day on levels inside its reach, not on all-expiry walls many percent
// away (owner report: put wall 700 and call wall 775 with SPY at 709, "chase the break", R:R 14.67).
import test from "node:test";
import assert from "node:assert/strict";
import { playbookDayBounds, buildDailyPlaybook, DAY_REACH_SIGMAS } from "../../server/playbook";

const piv = { h4: 729.2, l4: 702.5, r1: 721, s1: 704 };
const pivots: any = {
  classic: { pp: 715, r1: 721, r2: 730, r3: 740, s1: 704, s2: 699.6, s3: 690 },
  camarilla: { h3: 722.5, h4: 729.2, h5: 736, l3: 709.2, l4: 702.5, l5: 689.2 },
  fibonacci: {}, priorOhlc: { open: 0, high: 0, low: 0, close: 0 },
};
const gam = (o: any = {}) => ({ callWall: 775, putWall: 700, callWallGex: 1e9, putWallGex: -1e9, zeroGamma: 737.7, regime: "negative", totalGex: -1e10, maxPain: 720, pcrOi: 2, profile: [], gammaProfile: [], gexCrossoverStrike: null, ...o }) as any;
const pbOf = ({ gamma, ...o }: any = {}) => buildDailyPlaybook({
  symbol: "SPY", spot: 709.22, pivots, gamma: gam(gamma),
  squeeze: { score: -60, probability: 60, direction: "down", label: "", triggers: [], riskFactors: [], timeHorizon: "" } as any,
  vix: { value: 28, changePct: 0 } as any, term: { ratio9dOver30d: 1.03 } as any, marketScore: 31, ...o, 
} as any);
const BANNED = /\b(chase|take direction|fast trip|fade|expect|roll to|trade the|buy|sell|wait for|stops? beyond|drift to|cascade)\b/i;

test("bounds: a wall inside the reach is used; one outside gives way to the nearest pivot inside it, else one sigma", () => {
  const b = playbookDayBounds(709.22, 775, 700, 28, piv, 0.5);
  assert.ok(b.sigma! > 12 && b.sigma! < 13);
  assert.deepEqual([b.lower.price, b.lower.label], [700, "put wall"]);
  assert.deepEqual([b.upper.price, b.upper.label], [721, "classic R1"]);
  const calm = playbookDayBounds(709.22, 775, 700, 12, piv, 0.5);
  assert.deepEqual([calm.lower.price, calm.lower.label], [704, "classic S1"]);
  assert.equal(calm.upper.label, "one-sigma daily move up, from VIX");
  assert.equal(calm.upper.price % 0.5, 0, "a sigma bound sits on the tick");
  assert.equal(DAY_REACH_SIGMAS, 1.5);
});

test("bounds: a wall on the wrong side of the price is never a bound", () => {
  const b = playbookDayBounds(709.22, 705, 712, 28, piv, 0.5);
  assert.ok(b.upper.price > 709.22 && b.lower.price < 709.22);
  assert.notEqual(b.upper.label, "call wall");
  assert.notEqual(b.lower.label, "put wall");
});

test("bounds without VIX: the nearest pivot on each side; a wall only when there is no pivot, marked far", () => {
  const a = playbookDayBounds(709.22, 775, 700, null, piv, 0.5);
  assert.deepEqual([a.upper.price, a.upper.label, a.upper.far, a.lower.price, a.lower.label], [721, "classic R1", false, 704, "classic S1"]);
  const none = playbookDayBounds(709.22, 775, 700, null, null, 0.5);
  assert.deepEqual([none.upper.price, none.upper.far, none.lower.price, none.lower.far, none.sigma], [775, true, 700, true, null]);
});

test("the owner's case: no scenario names 775 or 737.7, nothing instructs, and the far levels are named for what they are", () => {
  const pb = pbOf();
  const scen = JSON.stringify(pb.scenarios.map((x) => [x.name, x.trigger, x.target, x.invalidation]));
  assert.doesNotMatch(scen, /775|737/);
  assert.doesNotMatch(scen, BANNED);
  assert.equal(pb.scenarios.length, 3);
  const below = pb.scenarios.find((x) => /^Below/.test(x.name))!;
  assert.equal(below.trigger, "A 15-min close below 700.0 (put wall)");
  assert.equal(pb.scenarios[0], below, "bearish inputs in a short-gamma tape: the break below is listed first");
  const above = pb.scenarios.find((x) => /^Above/.test(x.name))!;
  assert.equal(above.trigger, "A 15-min close above 721.0 (classic R1)");
  assert.match(above.target, /The next levels above are 729\.2 \(Camarilla H4\) and 730\.0 \(classic R2\)/);
  for (const x of [above, below]) assert.ok(x.levels.rr1 == null || x.levels.rr1 < 5, `reward/risk ${x.levels.rr1} is not inflated by a far target`);
  const far = pb.gameplan.find((g) => /not scenario levels today/.test(g))!;
  assert.match(far, /call wall 775\.0 \(9\.3% above; beyond 1\.5 one-sigma daily moves\)/);
  assert.match(far, /zero-gamma 737\.7 \(4\.0% above; beyond 1\.5 one-sigma daily moves\)/);
  assert.doesNotMatch(far, /put wall/, "the put wall is a scenario level here, so it is not listed as unused");
  assert.ok(pb.gameplan.some((g) => /VIX-implied one-sigma daily move \(VIX \/ sqrt\(252\)\): about 12\.5 either way\. An implied figure, not a forecast/.test(g)));
});

test("every regime, with and without VIX and pivots: no instruction wording anywhere on the card, and levels on the right side", () => {
  for (const regime of ["positive", "negative", "neutral"]) for (const vix of [28, 12, null]) for (const pv of [pivots, null]) for (const walls of [[775, 700], [715, 705], [705, 712], [775, 650]]) {
    const pb = pbOf({ pivots: pv, vix: { value: vix, changePct: 0 }, gamma: { regime, callWall: walls[0], putWall: walls[1] } });
    const text = [pb.summary, ...pb.gameplan, ...pb.scenarios.flatMap((x) => [x.name, x.trigger, x.target, x.invalidation])].join(" | ");
    const tag = `${regime}/${vix}/${pv ? "piv" : "nopiv"}/${walls}`;
    assert.doesNotMatch(text, BANNED, tag);
    assert.doesNotMatch(text, /\(unavailable\)/, tag);
    for (const x of pb.scenarios) {
      const lv = x.levels;
      if (lv.entry == null) continue;
      if (lv.side === "long") assert.ok(lv.stop! < lv.entry && (lv.target1 == null || lv.target1 > lv.entry), tag);
      if (lv.side === "short") assert.ok(lv.stop! > lv.entry && (lv.target1 == null || lv.target1 < lv.entry), tag);
    }
  }
});

test("a wall that is close but on the other side of the price is described as that, not as far", () => {
  const pb = pbOf({ gamma: { regime: "positive", callWall: 705, putWall: 690 } });
  const far = pb.gameplan.find((g) => /not scenario levels today/.test(g))!;
  assert.match(far, /call wall 705\.0 \(0\.6% below; on the other side of the price\)/);
});

test("near-zero gamma with a far flip says where the flip is; the key levels keep the walls' own names", () => {
  const pb = pbOf({ gamma: { regime: "neutral" } });
  assert.ok(pb.gameplan.some((g) => /Zero-gamma 737\.7 lies beyond the day's reach\./.test(g)));
  const res = pb.keyLevels.resistance.map((r) => `${r.label} ${r.level}`);
  assert.ok(res.includes("Call Wall 775"));
  assert.ok(!res.some((r) => /^Call Wall 721/.test(r)), "a pivot is not relabelled as the call wall");
  assert.equal(res.filter((r) => /721/.test(r)).length, 1, "no duplicate row for the level");
});

test("the news playbook is given the gamma walls it names", () => {
  const pb = pbOf({ todaysEvents: [{ kind: "CPI", label: "CPI" }] });
  const txt = JSON.stringify(pb.newsPlaybook);
  assert.match(txt, /call wall 775/);
  assert.doesNotMatch(txt, /call wall 721/);
});
