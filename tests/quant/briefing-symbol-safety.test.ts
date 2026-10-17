import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLevels, buildModels, ownsBriefingSymbol, scopedBriefingVerdict } from "../../server/edgeBriefing";

test("a request for AAPL cannot borrow SPY spot or playbook walls", () => {
  const result = buildLevels("AAPL", null, {
    symbol: "SPY", spot: 699,
    paths: { bull: { trigger: { level: 700 } }, bear: { trigger: { level: 670 } } },
  }, { symbol: "AAPL", spot: 281, zeroGamma: 279 });
  assert.equal(result.spot, 281);
  assert.equal(result.zeroGamma, 279);
  assert.equal(result.callWall, null);
  assert.equal(result.putWall, null);
});

test("unidentified or mismatched gamma data is withheld, not a fallback", () => {
  for (const gamma of [{ spot: 699, zeroGamma: 690 }, { symbol: "SPY", spot: 699, zeroGamma: 690 }]) {
    const result = buildLevels("NVDA", null, null, gamma);
    assert.equal(result.spot, null);
    assert.equal(result.zeroGamma, null);
  }
});

test("SPX aliases match, but SPY, AAPL and conflicting payload identities do not", () => {
  assert.equal(ownsBriefingSymbol(" spx ", { symbol: "^GSPC", displaySymbol: "SPX" }), true);
  assert.equal(ownsBriefingSymbol("SPY", { symbol: "^GSPC" }), false);
  assert.equal(ownsBriefingSymbol("AAPL", { symbol: "AAPL", displaySymbol: "SPY" }), false);
  assert.equal(ownsBriefingSymbol("AAPL", {}), false);
});

test("only horizons belonging to the requested symbol enter the briefing", () => {
  const models = { horizons: { daily: { symbol: "^GSPC", displaySymbol: "SPX", spot: 7010 }, weekly: { symbol: "SPY", spot: 699 } } };
  assert.equal(buildModels(models, "SPY").daily, null);
  assert.equal(buildModels(models, "SPY").weekly?.spot, 699);
  assert.deepEqual(buildModels(models, "AAPL"), { daily: null, weekly: null });
});

test("bullish macro inputs alone do not manufacture an AAPL directional verdict", () => {
  const partial = {
    regime: { headline: "Risk-on", narrative: "", riskAxisLabel: "Risk", riskAxisDirection: "risk-on", notes: [] },
    crossAsset: { rows: [{ symbol: "SPY", last: 699, d1Pct: 1, w1Pct: 2, m1Pct: 3, corr20d: null, corrRegime: "n/a" }], vix: 14, vixChangePct: -2 },
    playbook: null, models: { daily: null, weekly: null },
    weekAhead: [], news: [], levels: buildLevels("AAPL", null, null, { symbol: "AAPL", spot: 281 }),
  };
  const result = scopedBriefingVerdict("AAPL", partial);
  assert.equal(result.verdict, "insufficient data");
  assert.equal(result.confidence, null);
  assert.match(result.oneLiner, /market context only/);
});

test("matching SPY reference data retains exact prices without calculation changes", () => {
  const result = buildLevels("SPY", null, {
    symbol: "SPY", spot: 699,
    paths: { bull: { trigger: { level: 700 } }, bear: { trigger: { level: 670 } } },
  }, { symbol: "SPY", spot: 699, zeroGamma: 690 });
  assert.deepEqual([result.spot, result.callWall, result.putWall, result.zeroGamma], [699, 700, 670, 690]);
});
