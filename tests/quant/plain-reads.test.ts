// "In plain words" lines (shared/plainReads.ts): what a panel is saying, without the vocabulary; unread is said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainDex, plainGexLadder, plainKeyLevels, plainPinning, plainSkew, plainTermStructure, plainUnusualVolume, plainVixTerm, plainVrp } from "../../shared/plainReads";

test("term structure: which end is dearer, by how much, and nothing claimed when it was not read", () => {
  assert.equal(plainTermStructure({ contango: false, steepness: -0.11 }), "Options that expire soon are priced for more movement than later ones by 11.0 volatility points. The market is paying up for the next few days in particular.");
  assert.match(plainTermStructure({ contango: true, steepness: 0.021 }), /priced for less movement than later ones by 2\.1 volatility points\. That is the usual shape/);
  assert.match(plainTermStructure({ contango: null, steepness: null }), /Not enough expiries were read/);
  assert.match(plainTermStructure(undefined), /Not enough expiries were read/);
});

test("skew: the nearest expiry that was read, and how many are flagged", () => {
  const t = plainSkew([{ dte: 1, skew: null, elevatedFear: false }, { dte: 2, skew: 0.011, elevatedFear: false }, { dte: 5, skew: 0.031, elevatedFear: true }]);
  assert.match(t, /on the nearest expiry read \(2 days out\), puts are 1\.1 volatility points dearer than equally distant calls\./);
  assert.match(t, /1 of 2 expiries are marked as an elevated gap \(over 3 volatility points\)\./);
  assert.match(plainSkew([{ dte: 1, skew: -0.02, elevatedFear: false }]), /Upside costs more than downside protection .* by 2\.0 volatility points\. That is unusual for an index\./);
  assert.match(plainSkew([]), /was not read on any expiry/);
});

const b = (totalGex: number, contractCount: number, callWall: number | null = null, putWall: number | null = null) => ({ callWall, putWall, zeroGamma: null, totalGex, contractCount });

test("gamma ladder: where the exposure sits, the model's sign in words, and an empty same-day bucket is empty, not zero", () => {
  const t = plainGexLadder({ zerodte: b(0, 0), short: b(-36.36e9, 1756, 7400, 7300), weekly: b(-8.01e9, 1600), monthly: b(-44.34e9, 10528) }, 7324);
  assert.match(t, /^The largest dealer hedging exposure is in options expiring in 8 days or more\./);
  assert.match(t, /Net gamma is negative in every bucket read: under the model's assumption about who holds what, dealer hedging adds to moves instead of damping them\./);
  assert.match(t, /In the nearest bucket read \(options expiring in 1 to 2 days\), the largest call position is at 7,400 and the largest put position at 7,300; price is 7,324\./);
  assert.match(t, /Nothing expiring today was read, so the same-day bucket is empty, not zero\.$/);
  assert.match(plainGexLadder({ zerodte: b(5e9, 10), short: b(-1e9, 10), weekly: b(1e9, 10), monthly: b(2e9, 10) }, null), /negative in 1 of 4 buckets read and positive in the rest/);
  assert.match(plainGexLadder({ zerodte: b(0, 0), short: b(0, 0), weekly: b(0, 0), monthly: b(0, 0) }, 1), /No bucket had contracts to read/);
  assert.match(plainGexLadder(null, 1), /was not read/);
});

test("key levels: side and distance, the scale stated, and a fallback strike is not called a change of side", () => {
  const t = plainKeyLevels({ spot: 7324, flipStrike: 7460, flipMethod: "sign_change", score: -47.1 });
  assert.match(t, /Price is 136 points below 7,460, the strike where open positions tip from put-heavy to call-heavy\./);
  assert.match(t, /more put exposure is held than call exposure \(-47 on a scale from −100, all puts, to \+100, all calls\)\. This counts positions; it does not say who is long or short them\./);
  assert.match(plainKeyLevels({ spot: 7324, flipStrike: 7000, flipMethod: "peak_fallback", score: 3 }), /^No strike where open positions change from put-heavy to call-heavy was found; 7,000 is shown because it carries the largest exposure\. .*about equal weight/);
  assert.match(plainKeyLevels({ spot: null, flipStrike: null, score: null }), /was not found on this read\. The balance of calls against puts near the price was not read\./);
});

test("delta exposure: which side outweighs, in money, with missing deltas stated", () => {
  assert.match(plainDex({ totalNetDex: -1208.17e9, totalCallDex: 847e9, totalPutDex: -2055e9 }), /puts outweigh calls: a net −\$1\.21 trillion\./);
  assert.match(plainDex({ totalNetDex: 5e9, totalCallDex: 9e9, totalPutDex: -4e9, dexState: "partial", dexCoverage: { oiMissingShare: 0.12 } }), /calls outweigh puts: a net \$5\.0 billion\..*Some contracts had no delta \(12% of open interest\), so this covers only the rest\./);
  assert.match(plainDex({ totalNetDex: 0, totalCallDex: 0, totalPutDex: 0, dexState: "unavailable" }), /was not read/);
});

test("settlement odds: the top strike with its slice, flat odds called flat, never a forecast", () => {
  const flat = plainPinning([{ strike: 7335, prob: 2.1 }, { strike: 7340, prob: 2.1 }, { strike: 7330, prob: 2.0 }], { state: "ok", reason: null });
  assert.match(flat, /most likely settle near 7,335, at 2\.1% for that strike's slice\. The strikes beside it are priced almost the same, so no one strike stands out\. These are odds implied by prices, not a forecast/);
  assert.match(plainPinning([{ strike: 100, prob: 9 }, { strike: 101, prob: 3 }], { state: "ok", reason: null }), /That is the highest of the strikes shown\./);
  assert.match(plainPinning([], { state: "unavailable", reason: "too few quotes" }), /could not be read: too few quotes\./);
});

test("unusual volume: counts by side, the largest by dollars, and no claim about buyer or seller", () => {
  const t = plainUnusualVolume([{ strike: 7335, side: "call", expiry: "2026-12-18", dollarVolume: 67.6e6 }, { strike: 7230, side: "put", expiry: "2026-12-14", dollarVolume: 6.9e6 }]);
  assert.match(t, /^2 contracts traded more than twice the positions already open in them \(1 call, 1 put\)\. The largest by dollars is the 7,335 call expiring 2026-12-18, about \$67\.6 million\./);
  assert.match(t, /it does not show whether they were bought or sold\.$/);
  assert.match(plainUnusualVolume([]), /No contract traded more than twice its open interest/);
  assert.match(plainUnusualVolume(null), /was not read/);
});

test("volatility premium: a model figure that is the same on every expiry is called a default, not read as cheap", () => {
  const flat = plainVrp([{ marketIV: 0.277, theoreticalIV: 0.29, signal: "fair" }, { marketIV: 0.259, theoreticalIV: 0.29, signal: "iv_cheap" }, { marketIV: 0.203, theoreticalIV: 0.29, signal: "iv_cheap" }]);
  assert.match(flat, /reads 29\.0% on every expiry, which looks like one default value .* should not be relied on\./);
  assert.match(plainVrp([{ marketIV: 0.2, theoreticalIV: 0.17, signal: "iv_rich" }, { marketIV: 0.2, theoreticalIV: 0.21, signal: "fair" }, { marketIV: 0.2, theoreticalIV: 0.24, signal: "iv_cheap" }]), /above it on 1 expiry, below it on 1, and within 2 volatility points on 1\./);
  assert.match(plainVrp([{ marketIV: 0.2, theoreticalIV: null, signal: "no_model" }]), /was not available/);
});

test("the VIX line: level in words and which horizon is dearer", () => {
  assert.equal(plainVixTerm(24.56, 0.989), "The VIX is 24.6: options are pricing bigger daily swings than usual. Volatility over the next month is priced above the next three months: concern is concentrated in the near term.");
  assert.match(plainVixTerm(13, 1.1), /small daily swings\. .*the usual shape\./);
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
  assert.match(readFileSync(new URL("../../client/src/components/ModelsPanel.tsx", import.meta.url), "utf8"), /data-testid="models-vix-plain"[\s\S]{0,200}plainVixTerm\(horizon\.vol\.vix, horizon\.vol\.termRatio\)/);
});
