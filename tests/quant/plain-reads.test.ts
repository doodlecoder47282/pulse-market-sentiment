// "In plain words" lines (shared/plainReads.ts): what a panel is saying, without the vocabulary; unread is said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainDex, plainGexLadder, plainKeyLevels, plainPinning, plainSkew, plainTermStructure, plainUnusualVolume, plainVixTerm, plainVrp } from "../../shared/plainReads";

test("term structure: nearest against farthest, by how much, with a flat case and nothing claimed when unread", () => {
  assert.equal(plainTermStructure({ contango: false, steepness: -0.11 }), "The nearest expiry is priced for more movement than the farthest one read, by 11.0 volatility points. Near-term movement is being priced above later movement.");
  assert.match(plainTermStructure({ contango: true, steepness: 0.021 }), /less movement than the farthest one read, by 2\.1 volatility points\. That is the usual shape\./);
  assert.match(plainTermStructure({ contango: false, steepness: 0 }), /priced for about the same movement/);
  assert.match(plainTermStructure({ contango: null, steepness: null }), /Not enough expiries were read/);
  assert.match(plainTermStructure(undefined), /Not enough expiries were read/);
});

test("skew: the nearest expiry that was read, and how many are flagged", () => {
  const t = plainSkew([{ dte: 1, skew: null, elevatedFear: false }, { dte: 2, skew: 0.011, elevatedFear: false }, { dte: 5, skew: 0.031, elevatedFear: true }]);
  assert.match(t, /on the nearest expiry read \(2 days out\), puts are 1\.1 volatility points dearer than calls comparably far from the price\./);
  assert.match(t, /1 of 2 expiries is marked as an elevated gap \(over 3 volatility points\)\./);
  assert.match(plainSkew([{ dte: 0, skew: -0.02, elevatedFear: false }]), /on the nearest expiry read \(expiring today\), by 2\.0 volatility points\. That is unusual for an index\./);
  assert.match(plainSkew([]), /was not read on any expiry/);
});

const b = (totalGex: number, contractCount: number, callWall: number | null = null, putWall: number | null = null) => ({ callWall, putWall, zeroGamma: null, totalGex, contractCount });

test("gamma ladder: where the exposure sits, the model's sign in words, walls as hedging pressure, and unread open interest", () => {
  const g = { zerodte: b(0, 0), short: b(-36.36e9, 1756, 7400, 7300), weekly: b(-8.01e9, 1600), monthly: b(-44.34e9, 10528) };
  const t = plainGexLadder(g, 7324);
  assert.match(t, /^The largest dealer hedging exposure is in options expiring in 8 days or more\./);
  assert.match(t, /Net gamma is negative in every bucket read: under the model's assumption about who holds what, dealer hedging adds to moves instead of damping them\./);
  assert.match(t, /the strike above the price where call hedging pressure is largest is 7,400, and the strike below it where put hedging pressure is largest is 7,300; price is 7,324\./);
  assert.doesNotMatch(t, /largest (call|put) position/, "a wall is the largest gamma, not the largest open interest");
  assert.match(t, /No unsettled options expiring today are in this read\.$/);
  assert.match(plainGexLadder(g, 7324, { source: "held", sessionDate: "2026-11-18" }), /Open interest is held from 2026-11-18\.$/);
  assert.equal(plainGexLadder(g, 7324, { source: "none" }), "Open interest was not available on this read, so dealer gamma by expiry cannot be read.");
  assert.match(plainGexLadder({ zerodte: b(5e9, 10), short: b(-1e9, 10), weekly: b(1e9, 10), monthly: b(2e9, 10) }, null), /negative in 1 of 4 buckets read and positive in the rest/);
  assert.match(plainGexLadder({ zerodte: b(0, 0), short: b(0, 0), weekly: b(0, 0), monthly: b(0, 0) }, 1), /No bucket had contracts to read/);
  assert.match(plainGexLadder(null, 1), /was not read/);
});

test("key levels: a running balance that changes side, with no direction claimed; a zero score from unread data is not 'balanced'", () => {
  const t = plainKeyLevels({ spot: 7324, flipStrike: 7460, flipMethod: "sign_change", score: -47.1 });
  assert.match(t, /^Adding up call and put exposure strike by strike from the lowest, the running balance changes side at 7,460, 136 points above the price\./);
  assert.doesNotMatch(t, /put-heavy to call-heavy|call-heavy to put-heavy/, "the server does not send the direction of the crossing");
  assert.match(t, /more put exposure is held than call exposure \(−47 on a scale from −100, all puts, to \+100, all calls\)\. This counts positions; it does not say who is long or short them\./);
  assert.match(plainKeyLevels({ spot: 7324, flipStrike: 7650, flipMethod: "peak_fallback", score: -0.2 }), /^No strike where the running balance of call and put exposure changes side was found; 7,650 is shown because it has the largest net exposure of the strikes above the price\. .*about equal weight \(0 on a scale/);
  const unread = "The balance of calls against puts, and the strike where it changes side, were not read (no deltas or no open interest on this read).";
  assert.equal(plainKeyLevels({ spot: 7324, flipStrike: 7325, flipMethod: "peak_fallback", score: 0, dexState: "unavailable" }), unread);
  assert.equal(plainKeyLevels({ spot: 7324, flipStrike: 7325, flipMethod: "peak_fallback", score: 0, oi: { source: "none" } }), unread);
  assert.match(plainKeyLevels({ spot: null, flipStrike: null, score: null }), /No strike .* was found on this read\. The balance of calls against puts near the price was not read\./);
});

test("delta exposure: which side outweighs, in money, with missing deltas and missing open interest stated", () => {
  assert.match(plainDex({ totalNetDex: -1208.17e9, totalCallDex: 847e9, totalPutDex: -2055e9 }), /puts outweigh calls: a net −\$1\.21 trillion\./);
  assert.match(plainDex({ totalNetDex: 5e9, totalCallDex: 9e9, totalPutDex: -4e9, dexState: "partial", dexCoverage: { oiMissingShare: 0.12 } }), /calls outweigh puts: a net \$5\.0 billion\..*Some contracts had no delta \(12% of open interest\), so this covers only the rest\./);
  const unread = "Delta exposure was not read: no contract had both open interest and a delta.";
  assert.equal(plainDex({ totalNetDex: 0, totalCallDex: 0, totalPutDex: 0, dexState: "unavailable" }), unread);
  assert.equal(plainDex({ totalNetDex: 0, totalCallDex: 0, totalPutDex: 0 }, { source: "none" }), unread);
});

test("settlement odds: the server's top-ranked strike, near-equal odds called so, never a forecast, no internal reason pasted", () => {
  const flat = plainPinning([{ strike: 7335, prob: 2.1 }, { strike: 7340, prob: 2.1 }, { strike: 7330, prob: 2.0 }], { state: "ok", reason: null });
  assert.match(flat, /most likely settle near 7,335, at 2\.1% for that strike's slice\. The next strike is priced almost the same, so no one strike stands out\. These are odds implied by prices, not a forecast/);
  assert.match(plainPinning([{ strike: 100, prob: 9 }, { strike: 101, prob: 3 }], { state: "ok", reason: null }), /That is clearly above the next strike shown\./);
  assert.match(plainPinning([{ strike: 7000, prob: 1.0, probPerPoint: 0.2 }, { strike: 7100, prob: 4.0, probPerPoint: 0.04 }], { state: "ok", reason: null }), /settle near 7,000/, "the server's ranking (odds per point) is kept; a wide strike is not promoted");
  assert.equal(plainPinning([], { state: "unavailable", reason: "implied distribution fit failed" }), "Where the nearest expiry is priced to settle could not be read; the reason is shown below.");
});

test("unusual volume: counts by side, the 20-row cap stated, unread open interest is not 'none', and no claim about buyer or seller", () => {
  const t = plainUnusualVolume([{ strike: 7335, side: "call", expiry: "2026-12-18", dollarVolume: 67.6e6 }, { strike: 7230, side: "put", expiry: "2026-12-14", dollarVolume: 6.9e6 }]);
  assert.match(t, /^2 contracts traded at least twice the positions already open in them \(1 call, 1 put\)\. The largest by dollars is the 7,335 call expiring 2026-12-18, about \$67\.6 million\./);
  assert.match(t, /it does not show whether they were bought or sold\.$/);
  const capped = plainUnusualVolume(Array.from({ length: 20 }, (_, k) => ({ strike: 7000 + k, side: "call" as const, expiry: "2026-12-18", dollarVolume: 1e6 + k })));
  assert.match(capped, /^At least 20 contracts traded at least twice the positions already open in them; of the 20 shown, 20 calls, 0 puts\. The largest by dollars among those shown/);
  assert.match(plainUnusualVolume([]), /No contract traded at least twice its open interest/);
  assert.equal(plainUnusualVolume([], { source: "none" }), "Open interest was not available on this read, so unusual volume cannot be judged.");
  assert.match(plainUnusualVolume(null), /was not read/);
});

test("volatility premium: a default or a mirror of the market figure is named as such, never read as cheap or as 'zero expiries'", () => {
  const flat = plainVrp([{ marketIV: 0.277, theoreticalIV: 0.29, signal: "fair" }, { marketIV: 0.259, theoreticalIV: 0.29, signal: "iv_cheap" }, { marketIV: 0.203, theoreticalIV: 0.29, signal: "iv_cheap" }]);
  assert.match(flat, /reads 29\.0% on every expiry, which looks like one default value .* should not be relied on\./);
  const mirror = plainVrp([{ marketIV: 0.2, theoreticalIV: 0.2, signal: "no_model" }, { marketIV: 0.21, theoreticalIV: 0.21, signal: "no_model" }]);
  assert.equal(mirror, "Schwab's model volatility is the same as the market figure on every expiry read, so it is not a separate estimate and no rich-or-cheap reading can be made.");
  assert.match(plainVrp([{ marketIV: 0.2, theoreticalIV: 0.17, signal: "iv_rich" }, { marketIV: 0.2, theoreticalIV: 0.21, signal: "fair" }, { marketIV: 0.2, theoreticalIV: 0.24, signal: "iv_cheap" }, { marketIV: 0.2, theoreticalIV: 0.2, signal: "no_model" }]), /above it on 1 expiry, below it on 1, and within 2 volatility points on 1 \(1 expiry had no separate model figure\)\./);
  assert.match(plainVrp([{ marketIV: 0.2, theoreticalIV: null, signal: "no_model" }]), /was not available/);
});

test("the VIX line: level in words and which horizon is dearer", () => {
  assert.equal(plainVixTerm(24.56, 0.989), "The VIX is 24.6: options are pricing bigger daily swings than usual. Volatility over the next month is priced above the next three months: concern is concentrated in the near term.");
  assert.match(plainVixTerm(13, 1.1), /small daily swings\. .*the usual shape\./);
  assert.match(plainVixTerm(20, 1), /priced the same as the next three months\./);
  assert.match(plainVixTerm(null, null), /The VIX was not read\. The three-month VIX was not read/);
});

test("the reads describe and never instruct, and each audit section carries one above its table", () => {
  const all = [plainTermStructure({ contango: false, steepness: -0.1 }), plainSkew([{ dte: 1, skew: 0.05, elevatedFear: true }]), plainVixTerm(31, 0.9), plainVrp([{ marketIV: 0.2, theoreticalIV: 0.1, signal: "iv_rich" }]),
    plainGexLadder({ zerodte: b(-1, 1, 10, 9), short: b(-1, 1), weekly: b(-1, 1), monthly: b(-1, 1) }, 9.5), plainDex({ totalNetDex: -1, totalCallDex: 1, totalPutDex: -2 })].join(" ");
  assert.doesNotMatch(all, /\b(buy|sell|should|recommend|bullish|bearish|will (rise|fall|drop|rally)|expect a|likely to)\b/i);
  const audit = readFileSync(new URL("../../client/src/components/ChainAudit.tsx", import.meta.url), "utf8");
  for (const id of ["section-kpi", "section-gex-decay", "section-vol-surface", "section-dex", "section-pinning", "section-unusual-vol", "section-vrp", "section-greeks2"]) {
    assert.match(audit, new RegExp(`testId="${id}" plain=`), id);
  }
  assert.match(audit, /\{plain && <Plain text=\{plain\}/);
  for (const call of ["plainGexLadder(audit.gexDecay, data.spot, audit.oiState)", "plainDex(audit.dex, audit.oiState)", "plainUnusualVolume(audit.unusualVolume, audit.oiState)", "dexState: audit.dex.dexState, oi: audit.oiState"]) assert.ok(audit.includes(call), `open-interest state is passed: ${call}`);
  assert.match(readFileSync(new URL("../../client/src/components/ModelsPanel.tsx", import.meta.url), "utf8"), /data-testid="models-vix-plain"[\s\S]{0,200}plainVixTerm\(horizon\.vol\.vix, horizon\.vol\.termRatio\)/);
});
