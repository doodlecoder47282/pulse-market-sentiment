// One contract's volume, in five-minute steps, from successive chain reads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRead, describeBuild, isUnusual, stepStart, STEP_MS, KEEP_MIN_VOLUME, type ContractRead } from "../../shared/contractBuild";
import { etTime } from "../../shared/etTime";

const T0 = Date.parse("2026-11-24T15:00:00Z"); // 10:00 AM ET
const at = (min: number) => T0 + min * 60_000;
const row = (volume: number | null, extra: Partial<ContractRead> = {}): ContractRead =>
  ({ occ: "SPXW261124C07180000", side: "C", expiry: "2026-11-24", strike: 7180, volume, openInterest: 623, last: 4.2, ...extra });
const fmt = (ms: number) => etTime(ms);

test("steps are five minutes and a read lands in the step it was made in", () => {
  assert.equal(STEP_MS, 300_000);
  assert.equal(stepStart(at(7)), at(5));
  assert.equal(stepStart(at(5)), at(5));
});

test("the owner's example: 3,000 a step, then tailing off", () => {
  const seen = new Map<string, number>();
  const out: Array<{ step: number; volume: number }> = [];
  let baseline = 0;
  const reads: Array<[number, number]> = [[0, 300], [4, 3300], [9, 6300], [14, 9300], [19, 11300], [24, 12300], [29, 12800]];
  for (const [min, vol] of reads) {
    for (const s of applyRead(seen, [row(vol)], at(min))) { if (s.baseline) baseline += s.baseline; if (s.volume) out.push({ step: s.step, volume: s.volume }); }
  }
  assert.equal(baseline, 300, "what was on the tape at the first read has no timing");
  assert.deepEqual(out.map((s) => s.volume), [3000, 3000, 3000, 2000, 1000, 500]);
  const b = describeBuild(out, baseline, at(29), fmt);
  assert.equal(b.timed, 12500);
  assert.equal(b.total, 12800);
  assert.equal(b.peak!.volume, 3000);
  // At 10:31 the 10:30 step is still filling, so the comparison is 10:15-10:25 against 10:00-10:10.
  const b31 = describeBuild(out, baseline, at(31), fmt);
  assert.equal(b31.shape, "tailing_off");
  assert.equal(b31.line, "300 traded before the first read (timing not recorded). 12,500 since 10:00 AM, biggest five minutes 3,000 at 10:00 AM. Slowing: 3,500 in the last three full five-minute steps against 9,000 in the three before.");
  void b;
});

test("a contract below the floor is not kept; crossing it stores what came before as baseline", () => {
  const seen = new Map<string, number>();
  assert.deepEqual(applyRead(seen, [row(KEEP_MIN_VOLUME - 1)], at(0)), []);
  assert.equal(seen.size, 0);
  const s = applyRead(seen, [row(900)], at(6));
  assert.equal(s.length, 1);
  assert.equal(s[0].baseline, 900);
  assert.equal(s[0].volume, 0);
});

test("no change adds nothing, a missing volume is skipped, and a lower read between two higher ones is not counted twice", () => {
  const seen = new Map<string, number>([["SPXW261124C07180000", 1000]]);
  assert.deepEqual(applyRead(seen, [row(1000)], at(3)), []);
  assert.deepEqual(applyRead(seen, [row(null)], at(4)), []);
  let added = 0;
  for (const v of [1020, 1000, 1030]) for (const s of applyRead(seen, [row(v)], at(5))) added += s.volume;
  assert.equal(added, 30, "1,000 to 1,030 is 30 contracts, whatever order overlapping reads arrive in");
  assert.equal(seen.get("SPXW261124C07180000"), 1030);
});

test("a steady contract does not read as slowing because the current step has only just begun", () => {
  const steps = [0, 5, 10, 15, 20, 25].map((m) => ({ step: at(m), volume: 1000 })).concat([{ step: at(30), volume: 150 }]);
  const r = describeBuild(steps, 0, at(30) + 30_000, fmt);
  assert.equal(r.shape, "steady");
  assert.match(r.line, /Steady: 3,000 in the last three full five-minute steps against 3,000 in the three before\./);
});

test("shapes: one burst, quiet, building, too early", () => {
  const one = describeBuild([{ step: at(0), volume: 48000 }], 0, at(40), fmt);
  assert.equal(one.shape, "one_burst");
  assert.match(one.line, /All of it came in one five-minute step at 10:00 AM; nothing since\./);
  const quiet = describeBuild([{ step: at(0), volume: 500 }, { step: at(5), volume: 700 }], 0, at(45), fmt);
  assert.equal(quiet.shape, "quiet");
  assert.match(quiet.line, /Last added at 10:05 AM; nothing in the 40 minutes since\./);
  const building = describeBuild([{ step: at(0), volume: 100 }, { step: at(15), volume: 900 }, { step: at(20), volume: 1500 }], 0, at(26), fmt);
  assert.equal(building.shape, "building");
  assert.equal(describeBuild([{ step: at(0), volume: 100 }], 0, at(4), fmt).shape, "too_short");
  assert.equal(describeBuild([], 500, at(4), fmt).line, "500 traded before the first read (timing not recorded). No volume has been added since the terminal started watching this contract.");
});

test("the alert rule is applied to one contract's own numbers", () => {
  assert.equal(isUnusual(48000, 623), true);
  assert.equal(isUnusual(499, 10), false, "under 500 contracts");
  assert.equal(isUnusual(1500, 600), false, "under 3 times open interest");
  assert.equal(isUnusual(1500, 0), false, "no open interest to compare with");
  assert.equal(isUnusual(null, 100), false);
});

test("wiring: every fresh chain is recorded, per contract, without a request of its own", () => {
  const sch = readFileSync("server/schwab.ts", "utf8");
  assert.match(sch, /if \(_chainObserver && !r\.freshness\.servedFromCache && !r\.freshness\.stale\) \{/);
  assert.ok(sch.indexOf("const oiState = applyOiHold(wireSymbol") < sch.indexOf("if (_chainObserver && !r.freshness.servedFromCache"), "the recorder sees open interest after the hold");
  const cv = readFileSync("server/contractVolume.ts", "utf8");
  assert.match(cv, /PRIMARY KEY \(day, occ, step\)/);
  assert.doesNotMatch(cv, /getOptionChain|schwabFetch/, "the recorder makes no request");
  assert.match(readFileSync("server/routes.ts", "utf8"), /sch\.setChainObserver\(cv\.recordChainVolumes\)/);
});
