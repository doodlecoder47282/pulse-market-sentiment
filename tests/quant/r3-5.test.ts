// Round-3 R3-5: graceful unavailability when Schwab cannot answer.
// Runs the pure builders with an "unauthenticated Schwab" stub (the exact
// shapes server/schwab.ts and server/sources.ts return with no session) and
// asserts no throw past the route boundary and the right dataStates.
// Run: node --experimental-transform-types --no-warnings \
//   --import ./tests/quant/loader/register.mjs --test tests/quant/r3-5.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UpstreamUnavailableError, isUpstreamUnavailable, classifyRouteError, parseUnavailableError, unavailableBody,
} from "../../shared/unavailable";
import {
  assembleSnapshot, assembleSnapshotPartial, snapshotFailureResponse, tradeDeskDegraded,
  liveMetricsFromSnapshot, factCheckMetrics, type SnapshotInputs, type SnapshotPartial,
} from "../../server/snapshotDegrade";
import { factCheckItem, type VoiceItem } from "../../server/voices";
import { setSnapshotProvider, buildDailyPlaybook } from "../../server/dailyPlaybook";
import { describeDataState } from "../../shared/dataState";

// ── Unauthenticated Schwab stub ─────────────────────────────────────────────
// sources.getQuote with no session: getQuotes returns [] -> this shape.
const NO_QUOTE = { last: null, prev: null, prevSource: "unavailable" } as const;
// schwab.getOptionChain with no token.
const NO_CHAIN = { error: "schwab_required" as const, source: null, reason: "Schwab not connected" };
const NOW = Date.UTC(2026, 9, 9, 15, 0, 0);

const SOCIAL_OK = {
  score: 20, bullish: 6, bearish: 4, neutral: 2,
  posts: [{ source: "StockTwits" as const, text: "SPY bid", url: "https://stocktwits.com/x", tone: "bullish" as const }],
  status: "ok" as const, sources: [{ name: "StockTwits", state: "ok" as const, posts: 12 }], asOf: NOW,
};
const SOCIAL_NONE = { score: null, bullish: 0, bearish: 0, neutral: 0, posts: [], status: "unavailable" as const, sources: [], asOf: NOW };
const FG = { value: 41, label: "Fear", source: "CNN", asOf: "2026-10-09T14:00:00Z", stale: false };
const HEADLINES_OK = {
  items: [{ title: "Fed minutes", url: "https://www.federalreserve.gov/x", source: "Federal Reserve" }],
  status: "ok" as const, sources: [{ name: "Federal Reserve", state: "ok" as const, items: 1, newest: "2026-10-09T13:00:00Z" }],
  asOf: NOW, maxAgeHours: 24, note: "",
};
const HEADLINES_NONE = { items: [], status: "unavailable" as const, sources: [], asOf: NOW, maxAgeHours: 24, note: "no RSS source answered" };

function unauthInputs(over: Partial<SnapshotInputs> = {}) {
  return {
    vix: NO_QUOTE, vvix: NO_QUOTE, vix9d: NO_QUOTE, vix3m: NO_QUOTE, skew: NO_QUOTE, spy: NO_QUOTE,
    chain: NO_CHAIN,
    fearGreed: FG, social: SOCIAL_OK, headlines: HEADLINES_OK, warnings: [], nowMs: NOW,
    ...over,
  } as any;
}
const neverGamma = () => { throw new Error("buildGamma must not run without a chain"); };

// ── shared/unavailable.ts ───────────────────────────────────────────────────

test("classifyRouteError: typed upstream error -> 503 with dataState and reason", () => {
  const out = classifyRouteError(new UpstreamUnavailableError("Schwab SPY options chain unavailable: Schwab not connected"), "x");
  assert.equal(out.status, 503);
  assert.deepEqual(out.body, {
    dataState: "unavailable", reason: "Schwab SPY options chain unavailable: Schwab not connected",
    source: "schwab", message: "Schwab SPY options chain unavailable: Schwab not connected",
  });
});

test("classifyRouteError: Schwab disconnected + plain Error -> 503; connected -> 500; engine bug -> 500 either way", () => {
  const plain = new Error("insufficient bars for ^GSPC (0)");
  const dis = classifyRouteError(plain, "x", { schwabConnected: false });
  assert.equal(dis.status, 503);
  assert.equal((dis.body as any).reason, "Schwab not connected: insufficient bars for ^GSPC (0)");
  assert.equal(classifyRouteError(plain, "x", { schwabConnected: true }).status, 500);
  assert.equal(classifyRouteError(plain, "x", {}).status, 500, "unknown connection state is not assumed down");
  const bug = new TypeError("Cannot read properties of undefined (reading 'gamma')");
  const b = classifyRouteError(bug, "x", { schwabConnected: false });
  assert.equal(b.status, 500, "a TypeError is a code bug even while Schwab is down");
  assert.deepEqual(b.body, { message: "Cannot read properties of undefined (reading 'gamma')" });
  assert.deepEqual(classifyRouteError(plain, "x", { schwabConnected: true, key: "error" }).body, { error: "insufficient bars for ^GSPC (0)" });
});

test("isUpstreamUnavailable recognises a duck-typed copy (second module instance)", () => {
  const dup = Object.assign(new Error("r"), { name: "UpstreamUnavailableError", dataState: "unavailable", reason: "r" });
  assert.equal(isUpstreamUnavailable(dup), true);
  assert.equal(isUpstreamUnavailable(new Error("r")), false);
  assert.equal(isUpstreamUnavailable(null), false);
});

test("parseUnavailableError: client reads 503 bodies as unavailable with reason, others as failed", () => {
  const e503 = new Error(`503: ${JSON.stringify(unavailableBody("Schwab not connected"))}`);
  assert.deepEqual(parseUnavailableError(e503), { dataState: "unavailable", reason: "Schwab not connected", status: 503 });
  // existing 503 shapes using `note`
  const note = new Error(`503: ${JSON.stringify({ dataState: "unavailable", note: "no $SPX spot in the Schwab chain" })}`);
  assert.equal(parseUnavailableError(note)?.reason, "no $SPX spot in the Schwab chain");
  const e500 = new Error(`500: ${JSON.stringify({ message: "boom" })}`);
  assert.deepEqual(parseUnavailableError(e500), { dataState: "failed", reason: "boom", status: 500 });
  const net = new TypeError("Failed to fetch");
  assert.deepEqual(parseUnavailableError(net), { dataState: "failed", reason: "Failed to fetch", status: null });
  assert.equal(parseUnavailableError(null), null);
  // a 503 without a dataState body (proxy page) is a failure, not the contract
  assert.equal(parseUnavailableError(new Error("503: <html>Service Unavailable</html>"))?.dataState, "failed");
  // the chip renders both states as blocking, never ok
  assert.equal(describeDataState("unavailable").blocksSignal, true);
  assert.equal(describeDataState("failed").blocksSignal, true);
});

// ── Snapshot (Signals) ──────────────────────────────────────────────────────

test("snapshot, unauthenticated Schwab: throws the typed error carrying a partial; route answers 200 partial", () => {
  let caught: unknown = null;
  try { assembleSnapshot(unauthInputs(), neverGamma); } catch (e) { caught = e; }
  assert.ok(isUpstreamUnavailable(caught), "missing chain is an upstream error, not a bare Error (was a 500)");
  const resp = snapshotFailureResponse(caught);
  assert.ok(resp && resp.status === 200);
  const p = resp!.body as SnapshotPartial;
  assert.equal(p.dataState, "partial");
  assert.match(p.dataStateReason, /Schwab SPY options chain unavailable: Schwab not connected/);
  // Schwab sections: null with a reason, never 0
  assert.equal(p.gamma, null);
  assert.equal(p.composite, null);
  assert.equal(p.spy.price, null);
  assert.equal(p.spy.changePct, null);
  assert.equal(p.vol.vix.value, null);
  assert.equal(p.vol.vix.changePct, null);
  assert.equal(p.term.ratio9dOver30d, null);
  assert.equal(p.sections.gamma.dataState, "unavailable");
  assert.equal(p.sections.composite.dataState, "unavailable");
  assert.equal(p.sections.quotes.dataState, "unavailable");
  // non-Schwab context still filled and labelled
  assert.equal(p.social.score, 20);
  assert.equal(p.sections.social.dataState, "ok");
  assert.equal(p.fearGreed?.value, 41);
  assert.equal(p.sections.fearGreed.dataState, "ok");
  assert.equal(p.headlines.length, 1);
  assert.equal(p.sections.headlines.dataState, "ok");
  assert.equal(p.capturedAt, Math.floor(NOW / 1000));
});

test("snapshot: nothing useful left (no quotes, chain, social, F&G or headlines) -> 503 unavailable", () => {
  let caught: unknown = null;
  try {
    assembleSnapshot(unauthInputs({ social: SOCIAL_NONE as any, fearGreed: null, headlines: HEADLINES_NONE as any }), neverGamma);
  } catch (e) { caught = e; }
  const resp = snapshotFailureResponse(caught);
  assert.ok(resp && resp.status === 503);
  assert.equal((resp!.body as any).dataState, "unavailable");
  assert.match((resp!.body as any).reason, /Schwab not connected/);
});

test("snapshot: a non-upstream error is not turned into 503/partial", () => {
  assert.equal(snapshotFailureResponse(new TypeError("x is undefined")), null);
  assert.equal(snapshotFailureResponse(new Error("disk full")), null);
});

test("snapshot: partial quotes (chain down, some quotes up) -> quotes section partial, values kept", () => {
  const p = assembleSnapshotPartial(unauthInputs({ vix: { last: 18.5, prev: 18, stale: false } as any }), "chain down");
  assert.equal(p.sections.quotes.dataState, "partial");
  assert.equal(p.vol.vix.value, 18.5);
  assert.ok(Math.abs((p.vol.vix.changePct as number) - (0.5 / 18) * 100) < 1e-12);
  assert.equal(p.vol.vvix.value, null);
});

test("snapshot: chain with no underlying price -> upstream unavailable; other gamma errors are rethrown", () => {
  const okChain = { asOfMs: NOW - 5_000, ageMs: 5_000, stale: false };
  let caught: unknown = null;
  try {
    assembleSnapshot(unauthInputs({ chain: okChain as any }), () => { throw new Error("Schwab chain has no underlying price"); });
  } catch (e) { caught = e; }
  assert.ok(isUpstreamUnavailable(caught));
  assert.match((caught as UpstreamUnavailableError).reason, /unusable: Schwab chain has no underlying price/);
  assert.throws(
    () => assembleSnapshot(unauthInputs({ chain: okChain as any }), () => { throw new TypeError("bug"); }),
    (e: unknown) => e instanceof TypeError && !isUpstreamUnavailable(e),
  );
});

test("snapshot: live chain assembles the full snapshot unchanged (SPY from chain spot when quote missing)", () => {
  const okChain = { asOfMs: NOW - 5_000, ageMs: 5_000, stale: false };
  const gamma = { spot: 700, pcrOi: 1.2 } as any;
  const snap = assembleSnapshot(
    unauthInputs({ chain: okChain as any, vix: { last: 20, prev: 16 } as any, vix9d: { last: 22, prev: 21 } as any }),
    () => gamma,
  );
  assert.equal(snap.gamma, gamma);
  assert.equal(snap.spy.price, 700, "chain underlying stands in for a missing SPY quote");
  assert.equal(snap.spy.ageMs, 5_000, "and carries the chain's age");
  assert.equal(snap.spy.changePct, null, "no prior close -> null, not 0");
  assert.equal(snap.vol.vix.changePct, 25);
  assert.equal(snap.term.ratio9dOver30d, 22 / 20);
  assert.equal(snap.gammaAsOf, Math.floor((NOW - 5_000) / 1000));
});

// ── Trade Desk ──────────────────────────────────────────────────────────────

const NO_SERIES = { price: null, bars: [] };

test("trade desk: snapshot and every intraday quote unavailable -> 503 with reason", () => {
  const out = tradeDeskDegraded({
    range: "1d", interval: "1m", quotes: { spx: NO_SERIES, spy: NO_SERIES, vix: null },
    pivots: { spx: null, spy: null, vix: null }, reason: "Schwab not connected", nowMs: NOW,
  });
  assert.equal(out.status, 503);
  assert.equal((out.body as any).dataState, "unavailable");
  assert.match((out.body as any).reason, /no intraday quotes.*Schwab not connected/);
});

test("trade desk: quotes present, snapshot unavailable -> 200 partial, gamma/squeeze/playbook/composite null", () => {
  const spy = { price: 701.2, bars: [{ t: 1, c: 701.2 }] };
  const out = tradeDeskDegraded({
    range: "5d", interval: "5m", quotes: { spx: NO_SERIES, spy, vix: NO_SERIES },
    pivots: { spx: null, spy: { pp: 1 }, vix: null }, reason: "Schwab SPY options chain unavailable", voicesBias: { score: 5, sampleSize: 9 }, nowMs: NOW,
  });
  assert.equal(out.status, 200);
  const b = out.body as any;
  assert.equal(b.dataState, "partial");
  assert.equal(b.quotes.spy.price, 701.2);
  for (const k of ["gammaMap", "squeeze", "playbook", "composite"]) {
    assert.equal(b[k], null, k);
    assert.equal(b.sections[k].dataState, "unavailable", k);
    assert.equal(b.sections[k].reason, "Schwab SPY options chain unavailable", k);
  }
  assert.deepEqual(b.voicesBias, { score: 5, sampleSize: 9 }, "non-Schwab context passes through");
});

// ── Voices fact-check ───────────────────────────────────────────────────────

test("voices: no snapshot -> metrics null and claims 'unverified' (0 used to flag every VIX claim as conflicting)", () => {
  const m = liveMetricsFromSnapshot(null);
  assert.deepEqual(m, { vix: null, vvix: null, spy: null, skew: null, pcr: null });
  const item = { title: "VIX at 20 into CPI", summary: "", claims: [] } as unknown as VoiceItem;
  factCheckItem(item, factCheckMetrics(m));
  assert.equal(item.factCheck?.verdict, "unverified");
  // and with a live VIX of 20 the same claim is consistent
  const live = liveMetricsFromSnapshot({ vol: { vix: { value: 20 }, vvix: { value: null }, skew: { value: null } }, spy: { price: null }, gamma: null });
  const item2 = { title: "VIX at 20 into CPI", summary: "", claims: [] } as unknown as VoiceItem;
  factCheckItem(item2, factCheckMetrics(live));
  assert.equal(item2.factCheck?.verdict, "consistent");
});

// ── Daily playbook ──────────────────────────────────────────────────────────

test("daily playbook: unavailable snapshot propagates as the typed error (route 503), missing VIX too", async () => {
  setSnapshotProvider(async () => { throw new UpstreamUnavailableError("Schwab SPY options chain unavailable: Schwab not connected"); });
  await assert.rejects(buildDailyPlaybook("SPY"), (e: unknown) => isUpstreamUnavailable(e) && classifyRouteError(e, "x").status === 503);
  setSnapshotProvider(async () => ({
    capturedAt: Math.floor(NOW / 1000), spy: { price: 700 },
    gamma: { spot: 700, totalGex: 1e9, callWall: 710, putWall: 690, zeroGamma: 695, maxPain: 700 },
    vol: { vix: { value: null } },
  }));
  await assert.rejects(buildDailyPlaybook("SPY"), (e: unknown) => isUpstreamUnavailable(e) && /VIX quote unavailable/.test((e as Error).message));
  setSnapshotProvider(async () => ({
    capturedAt: Math.floor(NOW / 1000), spy: { price: 700 }, spxSpot: null,
    gamma: { spot: 700, totalGex: 1e9, callWall: 710, putWall: 690, zeroGamma: 695, maxPain: 700 },
    vol: { vix: { value: 18 } },
  }));
  await assert.rejects(buildDailyPlaybook("SPX"), (e: unknown) => isUpstreamUnavailable(e) && /no Schwab \$SPX quote/.test((e as Error).message));
});
