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

import { readCone, readDex, readEdgeWhale, readFlowAlerts, readGexLadder, readKeyLevels, readModel, readPinning, readSkew, readTermStructure, readUnusualVolume, readVixTerm, readVolSurface, readVrp, readWhalePerformance, READ_HEATSEEKER, READ_MM_MATRIX, READ_PIVOT_PROJECTION, READ_VOL_BAND_BACKTEST } from "../../shared/plainReads";

const words = (t: string) => t.trim().split(/\s+/).length;

test("answer first: every read has a short answer that stands alone, with the longer text behind it", () => {
  const g = { zerodte: b(0, 0), short: b(-36.36e9, 1756, 7400, 7300), weekly: b(-8.01e9, 1600), monthly: b(-44.34e9, 10528) };
  const reads = [
    readTermStructure({ contango: false, steepness: -0.11 }), readSkew([{ dte: 1, skew: 0.037, elevatedFear: true }]),
    readGexLadder(g, 7324, { source: "held", sessionDate: "2026-11-18" }), readKeyLevels({ spot: 7324, flipStrike: 7525, flipMethod: "sign_change", score: -40 }),
    readDex({ totalNetDex: -1e12, totalCallDex: 1, totalPutDex: -2 }), readPinning([{ strike: 7335, prob: 2.1 }, { strike: 7340, prob: 2.1 }], { state: "ok", reason: null }),
    readUnusualVolume([{ strike: 1, side: "call", expiry: "2026-12-18", dollarVolume: 1 }]), readVrp([{ marketIV: 0.2, theoreticalIV: 0.17, signal: "iv_rich" }]),
    readVixTerm(24.56, 0.989), readModel({ spot: 7324, zeroGamma: 7572, callWall: 7522, putWall: 7271, gammaZone: "y-" }),
    readCone({ spot: 7340, days: 10, q10: 6965, q90: 7737 }), readWhalePerformance({ count: 49, wins: 4, losses: 45, winRate: 4 / 49, avgPct: -0.62 }, 7),
    readEdgeWhale({ graded: 99, pending: 57, hit30Rate: 0.0505 }, 30), readFlowAlerts({ total: 15, high: 1, connected: true }),
    READ_HEATSEEKER, READ_MM_MATRIX, READ_PIVOT_PROJECTION, READ_VOL_BAND_BACKTEST,
  ];
  for (const r of reads) {
    assert.ok(words(r.answer) <= 26, `answer too long for a phone (${words(r.answer)} words): ${r.answer}`);
    assert.match(r.answer, /[.]$/);
    assert.ok(r.detail && r.detail.length > r.answer.length / 2, `detail present: ${r.answer}`);
    assert.doesNotMatch(`${r.answer} ${r.detail}`, /\b(buy|sell|should|recommend|bullish|bearish|will (rise|fall|drop|rally)|expect a|likely to)\b/i);
  }
});

test("the short answers say the same thing as the sentences behind them", () => {
  assert.equal(readTermStructure({ contango: false, steepness: -0.11 }).answer, "Near-dated options are priced for more movement than later ones.");
  assert.equal(readTermStructure({ contango: true, steepness: 0.02 }).answer, "Near-dated options are priced for less movement than later ones: the usual shape.");
  assert.equal(readTermStructure(null).answer, "Near-dated and later options could not be compared.");
  assert.equal(readSkew([{ dte: 1, skew: 0.037, elevatedFear: true }]).answer, "Downside protection costs more than upside.");
  assert.equal(readVolSurface({ contango: true, steepness: 0.02 }, []).answer, "Near-dated options are priced for less movement than later ones: the usual shape. The cost of downside protection against upside was not read.");
  const g = { zerodte: b(0, 0), short: b(-1, 5), weekly: b(-1, 5), monthly: b(-1, 5) };
  assert.equal(readGexLadder(g, 1).answer, "Model read: dealer hedging adds to moves at every expiry read.");
  assert.equal(readGexLadder(g, 1, { source: "none" }).answer, "Dealer hedging by expiry was not read.");
  assert.equal(readKeyLevels({ spot: 7324, flipStrike: 7525, flipMethod: "sign_change", score: -40 }).answer, "Positioning changes side at 7,525 (201 points above the price); more puts than calls are held near the price.");
  assert.equal(readKeyLevels({ spot: 7324, flipStrike: 7650, flipMethod: "peak_fallback", score: 2 }).answer, "Calls and puts are held in about equal weight near the price.", "a fallback strike is not offered as a change of side");
  assert.equal(readKeyLevels({ spot: 1, flipStrike: 1, score: 0, dexState: "unavailable" }).answer, "The balance of calls against puts was not read.");
  assert.equal(readDex({ totalNetDex: 0, totalCallDex: 0, totalPutDex: 0, dexState: "unavailable" }).answer, "Delta exposure was not read.");
  assert.equal(readPinning([{ strike: 7335, prob: 2.1 }, { strike: 7340, prob: 2.1 }], { state: "ok", reason: null }).answer, "No single strike stands out as the priced settle.");
  assert.match(readPinning([{ strike: 100, prob: 9 }, { strike: 101, prob: 3 }], { state: "ok", reason: null }).answer, /lean toward a settle near 100; odds from prices, not a forecast\./);
  assert.equal(readUnusualVolume([], { source: "none" }).answer, "Unusual volume could not be judged on this read.");
  assert.equal(readVrp([{ marketIV: 0.2, theoreticalIV: 0.29, signal: "fair" }, { marketIV: 0.2, theoreticalIV: 0.29, signal: "iv_cheap" }, { marketIV: 0.2, theoreticalIV: 0.29, signal: "iv_cheap" }]).answer, "The rich and cheap labels below are not reliable on this read.");
  assert.equal(readVixTerm(24.56, 0.989).answer, "VIX 24.6: bigger daily swings than usual are priced, more so in the near term than further out.");
  assert.equal(readVixTerm(null, 1.1).answer, "The VIX was not read.");
});

test("the model box: the model's read in words, the flip and walls placed against price, and an unread regime is not guessed", () => {
  const r = readModel({ spot: 7324, zeroGamma: 7572, callWall: 7522, putWall: 7271, gammaZone: "y-" });
  assert.equal(r.answer, "Model read: dealer hedging adds to moves here.");
  assert.match(r.detail!, /\(the gamma flip\) is 7,572, 248 points above the price\./);
  assert.match(r.detail!, /The largest call hedging level is 7,522 \(198 points above the price\) and the largest put hedging level is 7,271 \(53 points below the price\)\./);
  assert.match(r.detail!, /assumption about who holds what, not a measurement, and it says nothing about direction\.$/);
  assert.equal(readModel({ spot: 7324, zeroGamma: 7300, callWall: null, putWall: null, gammaZone: "y+" }).answer, "Model read: dealer hedging damps moves here.");
  const unread = readModel({ spot: 7324, zeroGamma: null, callWall: null, putWall: null, gammaZone: "y?" });
  assert.match(unread.answer, /could not read whether dealer hedging adds to moves or damps them/);
  assert.match(unread.detail!, /gamma flip\) was not found\. The call and put hedging levels were not read\./);
});

test("the cone, whale follow-through, graded alerts and flow alerts: counts with their n, and unread said", () => {
  assert.equal(readCone({ spot: 7340, days: 10, q10: 6964.68, q90: 7736.66 }).answer, "From recent volatility alone, 8 in 10 outcomes 10 sessions out fall between 6,965 and 7,737. No direction is assumed.");
  assert.equal(readCone(null).answer, "The forward range was not read.");
  assert.equal(readWhalePerformance({ count: 49, wins: 4, losses: 45, winRate: 4 / 49, avgPct: -0.62 }, 7).answer, "Following whale trades over the last 7 days: 4 of 49 closed positions made money after costs; the average result was −62%.");
  assert.equal(readWhalePerformance({ count: 0, wins: 0, losses: 0, winRate: null, avgPct: null, excludedNoFee: 22 }, 7).answer, "No whale position closed with a scoreable result in the last 7 days (22 left out for a missing quote or fee).");
  assert.equal(readWhalePerformance(null, 30).answer, "Whale follow-through was not read.");
  assert.equal(readEdgeWhale({ graded: 99, pending: 57, hit30Rate: 0.0505 }, 30).answer, "Of 99 graded whale alerts in the last 30 days, 5 reached +30% (5%).");
  assert.equal(readEdgeWhale({ graded: 0, pending: 12, hit30Rate: 0 }, 14).answer, "No whale alert has been graded in the last 14 days (12 pending).");
  assert.equal(readFlowAlerts({ total: 15, high: 1, connected: true }).answer, "15 flow alerts showing, 1 marked high. Each flags size on the options chain, not direction.");
  assert.equal(readFlowAlerts({ total: 0, high: 0, connected: true }).answer, "No flow alert is showing right now.");
  assert.equal(readFlowAlerts({ total: 3, high: 0, connected: false }).answer, "Flow alerts are not updating: the chain feed is not connected.");
});

test("every wired panel shows its read through the shared component, answer first with the rest behind a tap", () => {
  const read = (f: string) => readFileSync(new URL(`../../client/src/${f}`, import.meta.url), "utf8");
  const cmp = read("components/PlainRead.tsx");
  assert.match(cmp, /\{read\.answer\}/);
  assert.match(cmp, /\{open && <p[^>]*>\{read\.detail\}<\/p>\}/, "the detail is hidden until asked for");
  assert.match(cmp, /min-h-\[44px\][^"]*lg:min-h-0/, "a phone-sized tap target");
  const audit = read("components/ChainAudit.tsx");
  for (const id of ["section-kpi", "section-gex-decay", "section-vol-surface", "section-dex", "section-pinning", "section-unusual-vol", "section-vrp", "section-greeks2"]) assert.match(audit, new RegExp(`testId="${id}" plain=`), id);
  assert.match(audit, /\{plain && <PlainRead read=\{plain\}/);
  for (const call of ["readGexLadder(audit.gexDecay, data.spot, audit.oiState)", "readDex(audit.dex, audit.oiState)", "readUnusualVolume(audit.unusualVolume, audit.oiState)", "dexState: audit.dex.dexState, oi: audit.oiState"]) assert.ok(audit.includes(call), call);
  const wired: Array<[string, string]> = [
    ["components/ModelsPanel.tsx", 'testId="models-model-plain"'], ["components/ModelsPanel.tsx", 'testId="models-vix-plain"'], ["components/ModelsPanel.tsx", "READ_MM_MATRIX"],
    ["components/BacktestOverlay.tsx", "READ_VOL_BAND_BACKTEST"], ["components/models/MultiDayCone.tsx", "readCone({"], ["components/models/PivotProjection.tsx", "READ_PIVOT_PROJECTION"],
    ["components/WhaleFlowPanel.tsx", 'readWhalePerformance(rows.find((r) => r.source === "whale") ?? null, snap.windowDays)'], ["components/EdgeStatsPanel.tsx", "readEdgeWhale(data.whaleAlerts, data.windowDays)"],
    ["components/FlowAlertsPanel.tsx", "readFlowAlerts({ total: totalCount, high: highCount, connected: isConnected })"], ["pages/dashboard.tsx", "READ_HEATSEEKER"],
  ];
  for (const [f, needle] of wired) assert.ok(read(f).includes(needle), `${f}: ${needle}`);
  assert.match(read("components/BacktestOverlay.tsx"), /\{!data\?\.dealerLevelsFromChains && <PlainRead read=\{READ_VOL_BAND_BACKTEST\}/, "not shown once real dealer levels are tested");
});
