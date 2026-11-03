// Funding and open-interest readout (shared/cryptoFunding.ts): parsers on
// doc-shaped fixtures, failure shapes that must never read as zero funding,
// the unit-free open-interest change, per-8h normalisation only when the
// venue states its interval, snapshot states, the compact signal record,
// and the verifier catching planted errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBybitTicker, parseOkx, oiChangePct, fundingDirection, buildDerivsSnapshot, derivsRecord,
  OI_WINDOW_MS, DERIVS_STALE_MS, PERP_ASSETS, PERP_VENUES,
  type PerpAsset, type PerpVenue, type VenueResult, type OiSample, type DerivsSnapshot,
} from "../../shared/cryptoFunding";
import { derivsChecks } from "../../shared/cryptoVerify";

const NOW = 1_800_000_000_000;

const bybit = (over: Record<string, unknown> = {}, sym = "BTCUSDT") => ({
  retCode: 0, retMsg: "OK", time: NOW,
  result: { category: "linear", list: [{ symbol: sym, lastPrice: "70000", markPrice: "70001", fundingRate: "0.0001", nextFundingTime: String(NOW + 3_600_000), fundingIntervalHour: "8", openInterest: "50000", openInterestValue: "3500000000", ...over }] },
});
const okxFunding = (over: Record<string, unknown> = {}, inst = "BTC-USDT-SWAP") => ({
  code: "0", msg: "", data: [{ instId: inst, instType: "SWAP", fundingRate: "0.0001", fundingTime: String(NOW), nextFundingTime: String(NOW + 8 * 3_600_000), ...over }],
});
const okxOi = (inst = "BTC-USDT-SWAP") => ({ code: "0", msg: "", data: [{ instId: inst, instType: "SWAP", oi: "1", oiCcy: "1", oiUsd: "3500000000", ts: String(NOW) }] });

test("Bybit parser: fields map, interval and open interest are read, bad shapes give a reason not a zero", () => {
  const ok = parseBybitTicker(bybit(), "BTC", NOW);
  assert.equal(ok.reason, null);
  assert.equal(ok.read?.fundingRate, 0.0001);
  assert.equal(ok.read?.fundingIntervalHours, 8);
  assert.equal(ok.read?.oi, 3_500_000_000);
  assert.equal(ok.read?.nextFundingMs, NOW + 3_600_000);
  for (const [j, why] of [
    [{ retCode: 10001, result: {} }, /retCode 10001/],
    [{}, /retCode missing/],
    [bybit({}, "ETHUSDT"), /not in response/],
    [bybit({ fundingRate: "" }), /fundingRate missing/],
    [bybit({ fundingRate: "abc" }), /fundingRate missing/],
    [bybit({ fundingRate: null }), /fundingRate missing/],
  ] as const) {
    const r = parseBybitTicker(j, "BTC", NOW);
    assert.equal(r.read, null);
    assert.match(String(r.reason), why);
  }
  // Missing or zero open interest is "not reported", never a zero that later divides.
  assert.equal(parseBybitTicker(bybit({ openInterestValue: "0" }), "BTC", NOW).read?.oi, null);
  assert.equal(parseBybitTicker(bybit({ openInterestValue: undefined }), "BTC", NOW).read?.oi, null);
  assert.equal(parseBybitTicker(bybit({ fundingIntervalHour: "" }), "BTC", NOW).read?.fundingIntervalHours, null);
});

test("OKX parser: interval comes from the two funding times; open interest optional; bad shapes fail closed", () => {
  const ok = parseOkx(okxFunding(), okxOi(), "BTC", NOW);
  assert.equal(ok.read?.fundingIntervalHours, 8);
  assert.equal(ok.read?.oi, 3_500_000_000);
  assert.equal(parseOkx(okxFunding({ fundingTime: String(NOW), nextFundingTime: String(NOW + 4 * 3_600_000) }), okxOi(), "BTC", NOW).read?.fundingIntervalHours, 4);
  assert.equal(parseOkx(okxFunding({ nextFundingTime: "" }), okxOi(), "BTC", NOW).read?.fundingIntervalHours, null);
  assert.equal(parseOkx(okxFunding(), null, "BTC", NOW).read?.oi, null, "open-interest call failing keeps funding, reports no open interest");
  assert.equal(parseOkx(okxFunding(), { code: "50011", data: [] }, "BTC", NOW).read?.oi, null);
  for (const [f, why] of [
    [{ code: "51001", data: [] }, /funding code 51001/],
    [{}, /funding code missing/],
    [okxFunding({}, "ETH-USDT-SWAP"), /not in funding response/],
    [okxFunding({ fundingRate: "" }), /fundingRate missing/],
  ] as const) {
    const r = parseOkx(f, okxOi(), "BTC", NOW);
    assert.equal(r.read, null);
    assert.match(String(r.reason), why);
  }
});

test("open-interest change: nearest sample to one hour back within tolerance; building, stale and non-positive give null", () => {
  const S = (minAgo: number, v: number): OiSample => ({ t: NOW - minAgo * 60_000, v });
  assert.equal(oiChangePct([S(60, 100), S(0, 103)], NOW), 3);
  assert.equal(oiChangePct([S(60, 100), S(30, 90), S(0, 95)], NOW), -5, "the sample nearest 60 min is the baseline, not the extreme");
  assert.equal(oiChangePct([S(70, 100), S(0, 110)], NOW), 10, "70 min is inside the 15 min tolerance");
  assert.equal(oiChangePct([S(80, 100), S(0, 110)], NOW), null, "80 min is outside it");
  assert.equal(oiChangePct([S(0, 110)], NOW), null, "one sample is building");
  assert.equal(oiChangePct([S(30, 100), S(0, 110)], NOW), null, "history shorter than the window is building");
  assert.equal(oiChangePct([S(70, 100), S(10, 110)], NOW), null, "latest sample older than the stale limit");
  assert.equal(oiChangePct([S(60, 0), S(0, 5)], NOW), null);
  assert.equal(oiChangePct([S(60, 100), S(0, 100)], NOW), 0, "an observed zero change is zero, not null");
  assert.ok(OI_WINDOW_MS === 3_600_000);
});

test("direction is the sign of the rate only", () => {
  assert.equal(fundingDirection(0.0001), "longs pay shorts");
  assert.equal(fundingDirection(-0.00002), "shorts pay longs");
  assert.equal(fundingDirection(0), "flat");
});

function results(map: Partial<Record<PerpVenue, Partial<Record<PerpAsset, VenueResult>>>>): Record<PerpVenue, Record<PerpAsset, VenueResult>> {
  const out = {} as Record<PerpVenue, Record<PerpAsset, VenueResult>>;
  for (const v of PERP_VENUES) { out[v] = {} as Record<PerpAsset, VenueResult>; for (const a of PERP_ASSETS) out[v][a] = map[v]?.[a] ?? { parsed: null, error: "HTTP 403" }; }
  return out;
}
const histories = (h: Partial<Record<PerpVenue, Partial<Record<PerpAsset, OiSample[]>>>> = {}) => {
  const out = {} as Record<PerpVenue, Record<PerpAsset, OiSample[]>>;
  for (const v of PERP_VENUES) { out[v] = {} as Record<PerpAsset, OiSample[]>; for (const a of PERP_ASSETS) out[v][a] = h[v]?.[a] ?? []; }
  return out;
};
const byb = (a: PerpAsset, over: Record<string, unknown> = {}, now = NOW): VenueResult => ({ parsed: parseBybitTicker(bybit(over, `${a}USDT`), a, now), error: null });

test("snapshot: normalises to 8h only with a stated interval, labels building vs ok, and reports a blocked venue honestly", () => {
  const hist = histories({ bybit: { BTC: [{ t: NOW - 3_600_000, v: 100 }, { t: NOW, v: 102 }] } });
  const snap = buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC", { fundingIntervalHour: "4", fundingRate: "0.00005" }), ETH: byb("ETH"), SOL: byb("SOL", { fundingIntervalHour: "" }) } }), hist, NOW);
  assert.equal(snap.state, "partial", "a fully dark venue keeps the badge at partial even when the other venue covers every asset");
  const btc = snap.rows.find((r) => r.venue === "bybit" && r.asset === "BTC")!;
  assert.equal(btc.fundingPct, 0.005);
  assert.equal(btc.funding8hPct, 0.01, "4 h interval doubles to 8 h");
  assert.equal(btc.oi1hChangePct, 2);
  assert.equal(btc.oiState, "ok");
  const eth = snap.rows.find((r) => r.venue === "bybit" && r.asset === "ETH")!;
  assert.equal(eth.funding8hPct, 0.01);
  assert.equal(eth.oiState, "building");
  assert.equal(eth.oi1hChangePct, null);
  const sol = snap.rows.find((r) => r.venue === "bybit" && r.asset === "SOL")!;
  assert.equal(sol.funding8hPct, null, "no stated interval means no per-8h figure");
  const okxRow = snap.rows.find((r) => r.venue === "okx" && r.asset === "BTC")!;
  assert.equal(okxRow.state, "unavailable");
  assert.equal(okxRow.reason, "HTTP 403");
  assert.equal(okxRow.fundingPct, null, "a blocked venue is never zero funding");
});

test("snapshot states: partial when an asset has no fresh venue; unavailable when none; stale reads are not ok", () => {
  assert.equal(buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC"), ETH: byb("ETH") } }), histories(), NOW).state, "partial");
  assert.equal(buildDerivsSnapshot(results({}), histories(), NOW).state, "unavailable");
  const old = NOW - DERIVS_STALE_MS - 60_000;
  const stale = buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC", {}, old), ETH: byb("ETH", {}, old), SOL: byb("SOL", {}, old) } }), histories(), NOW);
  assert.equal(stale.state, "unavailable");
  assert.ok(stale.rows.filter((r) => r.venue === "bybit").every((r) => r.state === "stale" && r.oi1hChangePct === null));
});

test("signal record: only fresh rows, null when nothing fresh, no thresholds or labels beyond the numbers", () => {
  const snap = buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC"), ETH: byb("ETH", { fundingRate: "-0.0002" }) } }), histories(), NOW);
  const rec = derivsRecord(snap)!;
  assert.deepEqual(Object.keys(rec.assets).sort(), ["BTC", "ETH"]);
  assert.equal(rec.assets.ETH?.fundingPct, -0.02);
  assert.equal(rec.assets.SOL, undefined);
  assert.equal(derivsRecord(buildDerivsSnapshot(results({}), histories(), NOW)), null);
  assert.equal(derivsRecord(null), null);
});

const full = () => buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC"), ETH: byb("ETH"), SOL: byb("SOL") } }), histories(), NOW);

test("verifier does not false-fail correct per-8h figures: many-decimal rates on 1h and 4h intervals, tiny rates", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const h of ["1", "2", "4", "8"]) {
    for (let i = 0; i < 400; i++) {
      const rate = ((rnd() - 0.5) * 0.002).toFixed(13);
      const snap = buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC", { fundingRate: rate, fundingIntervalHour: h }), ETH: byb("ETH"), SOL: byb("SOL") } }), histories(), NOW);
      assert.equal(derivsChecks(snap, NOW)[0].state, "pass", `interval ${h}h rate ${rate}`);
    }
  }
  // A rate that rounds to 0.000000% keeps its raw-sign direction and still verifies.
  const tiny = buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC", { fundingRate: "0.000000002" }), ETH: byb("ETH"), SOL: byb("SOL") } }), histories(), NOW);
  assert.equal(tiny.rows.find((r) => r.asset === "BTC" && r.venue === "bybit")!.direction, "longs pay shorts");
  assert.equal(derivsChecks(tiny, NOW)[0].state, "pass");
  // The record is stamped with the oldest read behind it.
  const older = buildDerivsSnapshot(results({ bybit: { BTC: byb("BTC", {}, NOW - 90_000), ETH: byb("ETH"), SOL: byb("SOL") } }), histories(), NOW);
  assert.equal(derivsRecord(older)!.asOf, NOW - 90_000);
});
const clone = (s: DerivsSnapshot): DerivsSnapshot => JSON.parse(JSON.stringify(s));

test("verifier: a consistent snapshot passes; planted sign, arithmetic, unit and staleness errors fail; absent is unavailable", () => {
  assert.equal(derivsChecks(full(), NOW)[0].state, "pass");
  assert.equal(derivsChecks(null, NOW)[0].state, "unavailable");
  assert.equal(derivsChecks(buildDerivsSnapshot(results({}), histories(), NOW), NOW)[0].state, "unavailable");

  const wrongDir = clone(full()); wrongDir.rows.find((r) => r.state === "ok")!.direction = "shorts pay longs";
  assert.equal(derivsChecks(wrongDir, NOW)[0].state, "fail");

  const wrong8h = clone(full()); wrong8h.rows.find((r) => r.state === "ok")!.funding8hPct = 0.5;
  assert.equal(derivsChecks(wrong8h, NOW)[0].state, "fail");

  const unit = clone(full()); const u = unit.rows.find((r) => r.state === "ok")!; u.fundingPct = 10; u.funding8hPct = 10; u.direction = "longs pay shorts";
  assert.equal(derivsChecks(unit, NOW)[0].state, "fail", "a percent read as a fraction is outside the plausible band");

  const noInterval = clone(full()); const n = noInterval.rows.find((r) => r.state === "ok")!; n.fundingIntervalHours = null;
  assert.equal(derivsChecks(noInterval, NOW)[0].state, "fail", "a per-8h figure without a stated interval is invalid");

  const fakeOi = clone(full()); const f = fakeOi.rows.find((r) => r.state === "ok")!; f.oiState = "building"; f.oi1hChangePct = 4;
  assert.equal(derivsChecks(fakeOi, NOW)[0].state, "fail");

  // A frozen snapshot still labelled ok after the stale limit is a defect the verifier must catch.
  assert.equal(derivsChecks(full(), NOW + DERIVS_STALE_MS + 60_000)[0].state, "fail");
  // The server rebuilds from stored reads at serve time, so the same reads age to stale, not ok.
  const stored = results({ bybit: { BTC: byb("BTC"), ETH: byb("ETH"), SOL: byb("SOL") } });
  const later = NOW + DERIVS_STALE_MS + 60_000;
  const aged = buildDerivsSnapshot(stored, histories(), later);
  assert.equal(aged.state, "unavailable");
  assert.ok(aged.rows.filter((r) => r.venue === "bybit").every((r) => r.state === "stale"));
  assert.equal(derivsChecks(aged, later)[0].state, "unavailable", "all rows stale: nothing fresh to verify");
  assert.equal(derivsRecord(aged), null, "a signal logged after the feed died records no derivs");
});
