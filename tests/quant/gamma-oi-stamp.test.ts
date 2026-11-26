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
  bucketGexByDte, buildOiBasis, chainReadDate, chainReadMs, GEX_DTE_SPLIT_TEXT, KILLBOX_WEIGHTING_RULE, formatSessionDate, gammaWeighting, gexDteShares,
  GAMMA_WEIGHTING_LABELS, GEX_DTE_BUCKETS, HYBRID_VOLUME_WEIGHT, KILLBOX_HYBRID_VOLUME_TO_OI,
  KILLBOX_VOLUME_ONLY_MAX_OI, KILLBOX_VOLUME_ONLY_MIN_VOLUME, killboxWeightMode, oiSessionDate, oiStampText,
  OI_BASIS_TOOLTIP,
} from "../../shared/gammaBasis";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";
import { buildGammaStructure } from "../../server/sources";
import { gexByStrikeFromChain, SIGNALS_MAX_DTE } from "../../server/gammaProfile";

/** Epoch ms of an ET wall-clock time on a date. */
const et = (date: string, hm: string) => etWallToEpochMs(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
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
  const b = buildOiBasis(et("2026-11-16", "08:00"), { source: "held", sessionDate: "2026-11-13" });
  assert.equal(b.sessionDate, "2026-11-12");
  assert.match(b.note, /had not posted/);
  assert.equal(b.postingPending, undefined); // a held basis names its own posting day
  // no open interest at all: no date is claimed
  const none = buildOiBasis(et("2026-11-16", "11:00"), { source: "none", sessionDate: null });
  assert.equal(none.sessionDate, null);
});

test("OI basis object, read date and stamp text", () => {
  const b = buildOiBasis(et("2026-11-17", "11:00"), { source: "live", sessionDate: null });
  assert.deepEqual(b, { sessionDate: "2026-11-16", note: OI_BASIS_TOOLTIP });
  assert.equal(OI_BASIS_TOOLTIP, "Open interest is posted once a day. Today's trading is not in these figures.");
  assert.equal(oiStampText(b), "OI as of the close of Mon 16 Nov");
  assert.equal(formatSessionDate("2026-11-13"), "Fri 13 Nov");
  assert.equal(formatSessionDate("2026-02-30"), null);
  const unknown = buildOiBasis(null);
  assert.equal(buildOiBasis(NaN).sessionDate, null);
  assert.equal(unknown.sessionDate, null);
  assert.equal(oiStampText(unknown), "OI date unknown");
  assert.equal(oiStampText(null), "OI date unknown");
  assert.equal(oiStampText(undefined), "OI date unknown");
  // read date: receive time first, else the data time, in New York
  assert.equal(chainReadDate({ receivedAtMs: Date.parse("2026-11-17T15:00:00Z"), asOfMs: Date.parse("2026-11-16T21:00:00Z") }), "2026-11-17");
  assert.equal(chainReadDate({ asOfMs: Date.parse("2026-11-17T02:00:00Z") }), "2026-11-16"); // 21:00 ET the evening before
  assert.equal(chainReadMs({ receivedAtMs: 5, asOfMs: 9 }), 5);
  assert.equal(chainReadMs({ asOfMs: 9 }), 9);
  assert.equal(chainReadMs({ receivedAtMs: null }), null);
  assert.equal(chainReadDate({}), null);
  assert.equal(chainReadDate(null), null);
});

test("pre-open rule: a live chain read before the regular open does not assume today's posting", () => {
  const live = { source: "live" as const, sessionDate: null };
  // Tue 17 Nov 2026, 00:30 and 09:00 ET: Monday's posting is the latest certain one = Friday's close
  for (const hm of ["00:30", "09:00", "09:29"]) {
    const b = buildOiBasis(et("2026-11-17", hm), live);
    assert.equal(b.sessionDate, "2026-11-13", hm);
    assert.equal(b.postingPending, true, hm);
    assert.equal(oiStampText(b), "OI as of the close of Fri 13 Nov; today's posting may not be in yet");
    assert.match(b.note, /before the regular open/);
  }
  // 09:30 ET and later: today's posting = Monday's close, not pending
  for (const hm of ["09:30", "12:00", "16:30", "23:30"]) {
    const b = buildOiBasis(et("2026-11-17", hm), live);
    assert.equal(b.sessionDate, "2026-11-16", hm);
    assert.equal(b.postingPending, undefined, hm);
    assert.equal(oiStampText(b), "OI as of the close of Mon 16 Nov");
  }
  // no oiState given (older callers) is treated like Schwab's own open interest
  assert.equal(buildOiBasis(et("2026-11-17", "08:00")).postingPending, true);
  // Monday pre-open: Friday's posting = Thursday's close; after the open, Friday's close
  assert.deepEqual([buildOiBasis(et("2026-11-16", "08:00"), live).sessionDate, buildOiBasis(et("2026-11-16", "08:00"), live).postingPending], ["2026-11-12", true]);
  assert.equal(buildOiBasis(et("2026-11-16", "10:00"), live).sessionDate, "2026-11-13");
  // morning after a holiday (Fri 27 Nov 2026; Thanksgiving Thu 26): Wednesday's posting = Tuesday's close
  assert.deepEqual([buildOiBasis(et("2026-11-27", "07:00"), live).sessionDate, buildOiBasis(et("2026-11-27", "07:00"), live).postingPending], ["2026-11-24", true]);
  // that Friday is a half day (13:00 close): the open is still 09:30, and after the early close nothing changes
  assert.equal(buildOiBasis(et("2026-11-27", "09:30"), live).sessionDate, "2026-11-25");
  assert.equal(buildOiBasis(et("2026-11-27", "14:00"), live).sessionDate, "2026-11-25");
  assert.equal(buildOiBasis(et("2026-11-27", "14:00"), live).postingPending, undefined);
  // weekend and holiday reads have no open to wait for: the last posting stands
  assert.deepEqual(buildOiBasis(et("2026-11-14", "03:00"), live), { sessionDate: "2026-11-12", note: OI_BASIS_TOOLTIP });
  assert.deepEqual(buildOiBasis(et("2026-11-26", "03:00"), live), { sessionDate: "2026-11-24", note: OI_BASIS_TOOLTIP });
});

test("outside the exchange calendar's verified years no session is named", () => {
  const live = { source: "live" as const, sessionDate: null };
  // 2029 holidays are not in the table: 1 Jan 2029 must not be named as a session
  assert.equal(oiSessionDate("2029-01-02"), null);
  const b = buildOiBasis(et("2029-01-02", "11:00"), live);
  assert.equal(b.sessionDate, null);
  assert.equal(oiStampText(b), "OI date unknown");
  assert.match(b.note, /outside the exchange calendar/);
  assert.equal(buildOiBasis(et("2029-01-02", "08:00"), live).sessionDate, null);
  assert.equal(buildOiBasis(et("2029-01-02", "11:00"), { source: "held", sessionDate: "2029-01-02" }).sessionDate, null);
  // the first sessions of the first covered year reach back into an uncovered one
  assert.equal(oiSessionDate("2026-01-02"), null);
  assert.equal(oiSessionDate("2028-12-29"), "2028-12-28");
});

// ── B. weighting ──────────────────────────────────────────────────────────

test("weighting labels are built from the constants the code multiplies with", () => {
  assert.equal(gammaWeighting("oi").label, "weight: open interest");
  assert.equal(gammaWeighting("oi_plus_quarter_volume").label, `weight: open interest + ${HYBRID_VOLUME_WEIGHT} x today's volume`);
  const k = gammaWeighting("killbox_adaptive", "hybrid");
  assert.equal(k.kind, "killbox_adaptive");
  assert.equal(k.active, "hybrid");
  // short visible line: the mode this read used; the rule is a second short line
  assert.equal(k.label, `weight this read: open interest + ${HYBRID_VOLUME_WEIGHT} x volume`);
  assert.equal(gammaWeighting("killbox_adaptive", "oi").label, "weight this read: open interest");
  assert.equal(gammaWeighting("killbox_adaptive", "volume").label, "weight this read: volume alone");
  assert.equal(k.detail, KILLBOX_WEIGHTING_RULE);
  assert.ok(k.detail!.includes(`volume exceeds ${KILLBOX_HYBRID_VOLUME_TO_OI} x OI`), k.detail);
  assert.ok(k.detail!.includes(`${HYBRID_VOLUME_WEIGHT} x volume`), k.detail);
  assert.ok(k.detail!.includes(KILLBOX_VOLUME_ONLY_MAX_OI.toLocaleString("en-US")), k.detail);
  assert.ok(k.label.length <= 60 && k.detail!.length <= 130, `${k.label.length}/${k.detail!.length}`);
  assert.equal(gammaWeighting("oi").detail, undefined);
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
  // One function holds the weight (tests/quant/gamma-oi-only.test.ts); the label follows the mode in use.
  assert.match(fwd, /weightMode === "oi" \? oi : oi \+ vol \* HYBRID_VOLUME_WEIGHT/);
  assert.match(fwd, /weighting: gammaWeighting\(weightMode === "oi" \? "oi" : "oi_plus_quarter_volume"\)/);
  assert.match(fwd, /oiBasis: buildOiBasis\(chainReadMs\(/);
  const routes = read("server/routes.ts");
  const kb = routes.slice(routes.indexOf('app.get("/api/killbox/forward"'), routes.indexOf('app.get("/api/killbox/stats"'));
  assert.ok(kb.length > 1000);
  assert.match(kb, /weightMode: "oi" \| "volume" \| "hybrid" = killboxWeightMode\(totalOI, totalVol\)/);
  assert.match(kb, /else weight = oi \+ vol \* HYBRID_VOLUME_WEIGHT;/);
  assert.match(kb, /weighting: gammaWeighting\("killbox_adaptive", weightMode\)/);
  assert.match(kb, /oiBasis: buildOiBasis\(chainReadMs\(chain\), chain\.oiState\)/);
  assert.doesNotMatch(kb, /\* 0\.25/);
  // Heatseeker: open interest only (contractExposure is given `contracts: oi`)
  assert.match(read("server/heatseeker.ts"), /contractExposure\(\{[^}]*contracts: oi,/);
  assert.match(routes, /result\.oiBasis = buildOiBasis\(chainReadMs\(chain\), chain\.oiState\);\s*\n\s*result\.weighting = gammaWeighting\("oi"\);/);
  // Models: open interest only (bucketByStrike multiplies gamma by row.oi * 100)
  const models = read("server/models.ts");
  assert.match(models, /const oiMult = row\.oi \* 100;/);
  assert.match(models, /oiBasis: buildOiBasis\(chainReadMs\(chain\), chain\.oiState\),\s*\n\s*weighting: gammaWeighting\("oi"\),/);
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
  // the explanations are visible text, not hover-only
  assert.match(stamp, />\{oiReason\(oiBasis\)\}</);
  assert.match(stamp, /\(\{WEIGHTING_DIFFERS_TEXT\}\)/);
  assert.match(stamp, />\{weighting\.detail\}</);
  assert.equal((stamp.match(/title=/g) ?? []).length, 1);
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
  assert.match(blk, /b\.netGex == null \? "no priced contracts"/);
  assert.match(blk, />\{GEX_DTE_SPLIT_TEXT\}</);
  assert.doesNotMatch(blk, /title=/);
  assert.match(GEX_DTE_SPLIT_TEXT, /add up to Net GEX/);
  // Models header: the stamp sits between the strip's separators
  assert.match(read("client/src/components/ModelsPanel.tsx"), /<span className="text-border">\|<\/span>\s*\n\s*<GammaBasisStamp [^\n]*\n\s*<span className="text-border">\|<\/span>/);
  assert.doesNotMatch(blk, /bull|bear|buy|sell|signal|edge|text-emerald|text-red|text-green/i);
});
