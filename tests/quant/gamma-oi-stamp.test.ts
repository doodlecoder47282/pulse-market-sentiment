// tests/quant/gamma-oi-stamp.test.ts
//
// The "OI as of" stamp, the per-tab weighting label and the Signals DTE split
// (shared/gammaBasis.ts). Descriptive fields only: no GEX figure, wall or flip
// is changed by them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bucketGexByDte, buildOiBasis, chainReadDate, formatSessionDate, gammaWeighting, gexDteShares,
  GAMMA_WEIGHTING_LABELS, GEX_DTE_BUCKETS, HYBRID_VOLUME_WEIGHT, KILLBOX_HYBRID_VOLUME_TO_OI,
  KILLBOX_VOLUME_ONLY_MAX_OI, KILLBOX_VOLUME_ONLY_MIN_VOLUME, killboxWeightMode, oiSessionDate, oiStampText,
  OI_BASIS_TOOLTIP,
} from "../../shared/gammaBasis";
import { buildGammaStructure } from "../../server/sources";
import { gexByStrikeFromChain, SIGNALS_MAX_DTE } from "../../server/gammaProfile";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ── A. sessionDate ────────────────────────────────────────────────────────

test("OI session date: the trading day before the posting a chain carries", () => {
  // normal weekday: Tue 17 Nov 2026 carries the figures posted that morning = Monday's close
  assert.equal(oiSessionDate("2026-11-17"), "2026-11-16");
  // Monday: posted Monday morning = Friday's close
  assert.equal(oiSessionDate("2026-11-16"), "2026-11-13");
  // day after a holiday: Fri 27 Nov 2026 (Thanksgiving was Thu 26) = Wednesday's close
  assert.equal(oiSessionDate("2026-11-27"), "2026-11-25");
  // weekend read: still Friday's posting (nothing new until Monday) = Thursday's close
  assert.equal(oiSessionDate("2026-11-14"), "2026-11-12");
  assert.equal(oiSessionDate("2026-11-15"), "2026-11-12");
  // read on the holiday itself: Wednesday's posting = Tuesday's close
  assert.equal(oiSessionDate("2026-11-26"), "2026-11-24");
  // unknown date
  assert.equal(oiSessionDate(null), null);
  assert.equal(oiSessionDate(undefined), null);
  assert.equal(oiSessionDate(""), null);
  assert.equal(oiSessionDate("17 Nov"), null);
});

test("OI session date: held open interest uses the saved posting day, not the read day", () => {
  // Monday pre-open, today's OI not posted: figures held from Friday's posting = Thursday's close
  assert.equal(oiSessionDate("2026-11-16", "2026-11-13"), "2026-11-12");
  const b = buildOiBasis("2026-11-16", { source: "held", sessionDate: "2026-11-13" });
  assert.equal(b.sessionDate, "2026-11-12");
  assert.match(b.note, /had not posted/);
  // no open interest at all: no date is claimed
  const none = buildOiBasis("2026-11-16", { source: "none", sessionDate: null });
  assert.equal(none.sessionDate, null);
});

test("OI basis object, read date and stamp text", () => {
  const b = buildOiBasis("2026-11-17", { source: "live", sessionDate: null });
  assert.deepEqual(b, { sessionDate: "2026-11-16", note: OI_BASIS_TOOLTIP });
  assert.equal(OI_BASIS_TOOLTIP, "Open interest is posted once a day. Today's trading is not in these figures.");
  assert.equal(oiStampText(b), "OI as of the close of Mon 16 Nov");
  assert.equal(formatSessionDate("2026-11-13"), "Fri 13 Nov");
  assert.equal(formatSessionDate("2026-02-30"), null);
  const unknown = buildOiBasis(null);
  assert.equal(unknown.sessionDate, null);
  assert.equal(oiStampText(unknown), "OI date unknown");
  assert.equal(oiStampText(null), "OI date unknown");
  assert.equal(oiStampText(undefined), "OI date unknown");
  // read date: receive time first, else the data time, in New York
  assert.equal(chainReadDate({ receivedAtMs: Date.parse("2026-11-17T15:00:00Z"), asOfMs: Date.parse("2026-11-16T21:00:00Z") }), "2026-11-17");
  assert.equal(chainReadDate({ asOfMs: Date.parse("2026-11-17T02:00:00Z") }), "2026-11-16"); // 21:00 ET the evening before
  assert.equal(chainReadDate({}), null);
  assert.equal(chainReadDate(null), null);
});

// ── B. weighting ──────────────────────────────────────────────────────────

test("weighting labels are built from the constants the code multiplies with", () => {
  assert.equal(gammaWeighting("oi").label, "weight: open interest");
  assert.equal(gammaWeighting("oi_plus_quarter_volume").label, `weight: open interest + ${HYBRID_VOLUME_WEIGHT} x today's volume`);
  const k = gammaWeighting("killbox_adaptive", "hybrid");
  assert.equal(k.kind, "killbox_adaptive");
  assert.equal(k.active, "hybrid");
  assert.ok(k.label.includes(`volume exceeds ${KILLBOX_HYBRID_VOLUME_TO_OI} x OI`), k.label);
  assert.ok(k.label.includes(`${HYBRID_VOLUME_WEIGHT} x volume`), k.label);
  assert.ok(k.label.includes(KILLBOX_VOLUME_ONLY_MAX_OI.toLocaleString("en-US")), k.label);
  assert.ok(k.label.includes("this read: open interest +"), k.label);
  assert.deepEqual(Object.keys(GAMMA_WEIGHTING_LABELS).sort(), ["killbox_adaptive", "oi", "oi_plus_quarter_volume"]);
  for (const l of Object.values(GAMMA_WEIGHTING_LABELS)) assert.ok(l.startsWith("weight: "), l);
});

test("Killbox weight rule is the one the route had (volume under thin OI, hybrid past the multiple, else OI)", () => {
  const old = (totalOI: number, totalVol: number) => {
    const useVolume = totalOI < 1000 && totalVol > 1000;
    return useVolume ? "volume" : (totalOI > 0 && totalVol > totalOI * 5 ? "hybrid" : "oi");
  };
  for (const [oi, vol] of [[0, 0], [0, 5000], [999, 1001], [999, 1000], [1000, 5000], [1000, 5001], [50_000, 250_000], [50_000, 250_001], [2_000_000, 100]]) {
    assert.equal(killboxWeightMode(oi, vol), old(oi, vol), `${oi}/${vol}`);
  }
  assert.equal(HYBRID_VOLUME_WEIGHT, 0.25);
  assert.equal(KILLBOX_HYBRID_VOLUME_TO_OI, 5);
  assert.equal(KILLBOX_VOLUME_ONLY_MAX_OI, 1000);
  assert.equal(KILLBOX_VOLUME_ONLY_MIN_VOLUME, 1000);
});

test("the code uses the named constants, and each tab declares the weighting it applies", () => {
  const fwd = read("server/odteForward.ts");
  assert.match(fwd, /const weight = oi \+ vol \* HYBRID_VOLUME_WEIGHT;/);
  assert.match(fwd, /totalVolume\) \|\| 0\) \* HYBRID_VOLUME_WEIGHT/);
  assert.match(fwd, /weighting: gammaWeighting\("oi_plus_quarter_volume"\)/);
  assert.match(fwd, /oiBasis: buildOiBasis\(chainReadDate\(/);
  const routes = read("server/routes.ts");
  const kb = routes.slice(routes.indexOf('app.get("/api/killbox/forward"'), routes.indexOf('app.get("/api/killbox/stats"'));
  assert.ok(kb.length > 1000);
  assert.match(kb, /weightMode: "oi" \| "volume" \| "hybrid" = killboxWeightMode\(totalOI, totalVol\)/);
  assert.match(kb, /else weight = oi \+ vol \* HYBRID_VOLUME_WEIGHT;/);
  assert.match(kb, /weighting: gammaWeighting\("killbox_adaptive", weightMode\)/);
  assert.match(kb, /oiBasis: buildOiBasis\(chainReadDate\(chain\), chain\.oiState\)/);
  assert.doesNotMatch(kb, /\* 0\.25/);
  // Heatseeker: open interest only (contractExposure is given `contracts: oi`)
  assert.match(read("server/heatseeker.ts"), /contractExposure\(\{[^}]*contracts: oi,/);
  assert.match(routes, /result\.oiBasis = buildOiBasis\(chainReadDate\(chain\), chain\.oiState\);\s*\n\s*result\.weighting = gammaWeighting\("oi"\);/);
  // Models: open interest only (bucketByStrike multiplies gamma by row.oi * 100)
  const models = read("server/models.ts");
  assert.match(models, /const oiMult = row\.oi \* 100;/);
  assert.match(models, /oiBasis: buildOiBasis\(chainReadDate\(chain\), chain\.oiState\),\s*\n\s*weighting: gammaWeighting\("oi"\),/);
  // Signals
  assert.match(read("server/sources.ts"), /weighting: gammaWeighting\("oi"\)/);
});

// ── C. DTE split ──────────────────────────────────────────────────────────

const C = (sym: string, x: Record<string, unknown>) => ({ symbol: sym, bid: 1, ask: 1.1, ...x });
const S = 670;
// Tue 13 Oct 2026, 11:00 ET
const NOW = Date.parse("2026-10-13T15:00:00Z");
const fullChain = () => ({
  underlying: { last: S },
  asOfMs: NOW, receivedAtMs: NOW,
  oiState: { source: "live" as const, sessionDate: null },
  callExpDateMap: {
    "2026-10-13:0": { "672.0": [C("SPY   261013C00672000", { openInterest: 12_000, volatility: 14, totalVolume: 90_000 })] },
    "2026-10-16:3": { "675.0": [C("SPY   261016C00675000", { openInterest: 30_000, volatility: 15 })] },
    "2026-11-20:38": { "690.0": [C("SPY   261120C00690000", { openInterest: 45_000, volatility: 16 })] },
    "2026-12-18:66": { "700.0": [C("SPY   261218C00700000", { openInterest: 99_000, volatility: 17 })] },
  },
  putExpDateMap: {
    "2026-10-13:0": { "668.0": [C("SPY   261013P00668000", { openInterest: 20_000, volatility: 15 })] },
    "2026-10-20:7": { "665.0": [C("SPY   261020P00665000", { openInterest: 40_000, volatility: 17 })] },
    "2026-10-21:8": { "660.0": [C("SPY   261021P00660000", { openInterest: 25_000, volatility: 18 })] },
    "2026-11-20:38": { "640.0": [C("SPY   261120P00640000", { openInterest: 70_000, volatility: 20 })] },
  },
});

test("Signals DTE split: three buckets that sum to the total, same sign convention", () => {
  const g = buildGammaStructure(fullChain() as any, NOW);
  const by = g.gexByDte!;
  assert.deepEqual(by.map((b) => [b.label, b.dteMin, b.dteMax]), [["0DTE", 0, 0], ["1-7D", 1, 7], ["8-45D", 8, 45]]);
  assert.equal(GEX_DTE_BUCKETS[2].dteMax, SIGNALS_MAX_DTE);
  assert.deepEqual(by.map((b) => b.contracts), [2, 2, 3]); // the 66 DTE call is outside the window
  const sum = by.reduce((a, b) => a + (b.netGex ?? 0), 0);
  assert.ok(Math.abs(sum - g.totalGex) <= 1e-9 * Math.max(1, Math.abs(g.totalGex)), `${sum} vs ${g.totalGex}`);
  // each bucket equals the total of a chain holding only that bucket's expiries
  const only = (keep: (dte: number) => boolean) => {
    const ch: any = fullChain();
    for (const m of [ch.callExpDateMap, ch.putExpDateMap]) for (const k of Object.keys(m)) if (!keep(Number(k.split(":")[1]))) delete m[k];
    return gexByStrikeFromChain(ch, NOW).profile.reduce((a, p) => a + p.netGex, 0);
  };
  const want = [only((d) => d === 0), only((d) => d >= 1 && d <= 7), only((d) => d >= 8 && d <= 45)];
  by.forEach((b, i) => assert.ok(Math.abs((b.netGex as number) - want[i]) <= 1e-9 * Math.abs(want[i]), `${b.label}: ${b.netGex} vs ${want[i]}`));
  // shares of the combined absolute size add to 1
  const sh = gexDteShares(by);
  assert.ok(Math.abs(sh.reduce((a: number, x) => a + (x ?? 0), 0) - 1) < 1e-12);
  // the payload carries the stamp and the weighting
  assert.deepEqual(g.oiBasis, { sessionDate: "2026-10-12", note: OI_BASIS_TOOLTIP });
  assert.deepEqual(g.weighting, { kind: "oi", label: "weight: open interest" });
});

test("Signals DTE split: an empty bucket is null, not 0; an undated chain has no OI date", () => {
  const ch: any = fullChain();
  delete ch.callExpDateMap["2026-10-13:0"];
  delete ch.putExpDateMap["2026-10-13:0"];
  delete ch.asOfMs; delete ch.receivedAtMs;
  const g = buildGammaStructure(ch, NOW);
  assert.equal(g.gexByDte![0].netGex, null);
  assert.equal(g.gexByDte![0].contracts, 0);
  const sum = g.gexByDte!.reduce((a, b) => a + (b.netGex ?? 0), 0);
  assert.ok(Math.abs(sum - g.totalGex) <= 1e-9 * Math.abs(g.totalGex));
  assert.equal(gexDteShares(g.gexByDte!)[0], null);
  assert.equal(g.oiBasis!.sessionDate, null);
  assert.equal(oiStampText(g.oiBasis), "OI date unknown");
});

test("bucketGexByDte: pure sums, null when empty, terms outside every bucket are left out", () => {
  const b = bucketGexByDte([{ dte: 0, gex: 5 }, { dte: 0, gex: -2 }, { dte: 9, gex: -7, contracts: 4 }, { dte: 60, gex: 100 }, { dte: NaN, gex: 1 }]);
  assert.deepEqual(b.map((x) => x.netGex), [3, null, -7]);
  assert.deepEqual(b.map((x) => x.contracts), [2, 0, 4]);
  assert.deepEqual(gexDteShares(b), [0.3, null, 0.7]);
  assert.deepEqual(gexDteShares(bucketGexByDte([])), [null, null, null]);
});

test("the DTE split does not change the total, the walls or the flip", () => {
  const g = buildGammaStructure(fullChain() as any, NOW);
  const ref = gexByStrikeFromChain({ ...fullChain(), underlying: { last: S } } as any, NOW);
  assert.equal(g.totalGex, ref.profile.reduce((a, p) => a + p.netGex, 0));
  assert.equal(g.callWall, ref.callWall);
  assert.equal(g.putWall, ref.putWall);
  assert.equal(g.zeroGamma, ref.zeroGamma);
});

// ── Wiring ────────────────────────────────────────────────────────────────

test("every gamma panel renders the stamp from the payload", () => {
  const stamp = read("client/src/components/GammaBasisStamp.tsx");
  assert.match(stamp, /oiStampText\(oiBasis\)/);
  assert.match(stamp, /title=\{oiBasis\?\.note \|\| OI_BASIS_TOOLTIP\}/);
  assert.match(stamp, /weighting\.label/);
  assert.doesNotMatch(stamp, /\b(Mon|Tue|Wed|Thu|Fri) \d/); // no hard-coded date
  assert.doesNotMatch(stamp, /<button|onClick/);           // descriptive, not interactive
  const panels: Array<[string, RegExp]> = [
    ["client/src/pages/dashboard.tsx", /<GammaBasisStamp oiBasis=\{gamma\.oiBasis\} weighting=\{gamma\.weighting\} testId="signals-gamma-basis"/],
    ["client/src/components/ModelsPanel.tsx", /<GammaBasisStamp oiBasis=\{\(horizon as any\)\.oiBasis \?\? null\} weighting=\{\(horizon as any\)\.weighting \?\? null\} testId="models-gamma-basis"/],
    ["client/src/components/Heatseeker.tsx", /<GammaBasisStamp oiBasis=\{\(data as any\)\.oiBasis \?\? null\} weighting=\{\(data as any\)\.weighting \?\? null\} testId="heatseeker-gamma-basis"/],
    ["client/src/components/OdteMapCard.tsx", /<GammaBasisStamp oiBasis=\{m\.oiBasis \?\? null\} weighting=\{m\.weighting \?\? null\} testId="odte-map-gamma-basis"/],
    ["client/src/components/Killbox.tsx", /<GammaBasisStamp oiBasis=\{\(data as any\)\.oiBasis \?\? null\} weighting=\{\(data as any\)\.weighting \?\? null\} testId="killbox-gamma-basis"/],
  ];
  for (const [file, re] of panels) assert.match(read(file), re, file);
  // the 0DTE map passes the forward's fields through
  const map = read("shared/odteMap.ts");
  assert.match(map, /oiBasis: f\.oiBasis \?\? null,\s*\n\s*weighting: f\.weighting \?\? null,/);
  // Signals DTE split: labelled values, the existing GEX-dollar formatter, no signal wording
  const dash = read("client/src/pages/dashboard.tsx");
  const at = dash.indexOf('data-testid="signals-gex-by-dte"');
  assert.ok(at > 0);
  const blk = dash.slice(at, dash.indexOf("})()}", at)).replace(/signals-gex-[a-z-]+/g, "");
  assert.match(blk, /fmt\.bn\(b\.netGex\)/);
  assert.match(blk, /b\.netGex == null \? "no contracts"/);
  assert.doesNotMatch(blk, /bull|bear|buy|sell|signal|edge|text-emerald|text-red|text-green/i);
});
