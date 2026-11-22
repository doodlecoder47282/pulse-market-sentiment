import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { maxPainStrike, expirySummary, rankLevels, outlookWindows, windowLines, windowHasContent, mainExpiryRows, outlookChart, collarLevels, boardOutlookLevels, spreadLabels, sharePct, shortDate, OUTLOOK_LINES_PER_SIDE, type OutlookContract } from "../../shared/outlook";
import { mergeLevels, type BoardLevel } from "../../shared/levelBoard";

const c = (expiry: string, dte: number, side: "call" | "put", strike: number, oi: number, iv = 0.2): OutlookContract => ({ expiry, dte, tYears: Math.max(dte, 0.5) / 365, side, strike, oi, iv });

test("max pain is the strike where holders are paid least, from open interest alone", () => {
  // Puts at 90 (100 open) and calls at 110 (100 open): anywhere from 90 to 110 pays nothing; the lowest such strike is reported.
  assert.equal(maxPainStrike([{ side: "put", strike: 90, oi: 100 }, { side: "call", strike: 110, oi: 100 }, { side: "call", strike: 100, oi: 0 }]), 90);
  // Heavy calls at 100 pull it down to 100; heavy puts at 105 pull it up.
  const rows = [{ side: "call" as const, strike: 100, oi: 500 }, { side: "put" as const, strike: 105, oi: 100 }, { side: "call" as const, strike: 110, oi: 10 }, { side: "put" as const, strike: 95, oi: 10 }];
  // Payout by settle: 95 -> puts 105 pay 1000 = 1000; 100 -> 500; 105 -> calls 100 pay 2500 + puts 95 0 = 2500; 110 -> 5000 + ...
  assert.equal(maxPainStrike(rows), 100);
  assert.equal(maxPainStrike([]), null);
  assert.equal(maxPainStrike([{ side: "call", strike: 100, oi: 0 }]), null, "no open interest, no max pain");
  // Input order does not change the answer.
  assert.equal(maxPainStrike([...rows].reverse()), 100);
});

test("one row per expiry: open interest, its share of the chain, ATM IV and the implied one-sigma move", () => {
  const spot = 7000;
  const rows = expirySummary([
    c("2026-11-27", 6, "call", 7000, 300, 0.24), c("2026-11-27", 6, "put", 7000, 100, 0.26), c("2026-11-27", 6, "put", 6900, 50, 0.4),
    c("2026-12-18", 27, "call", 7000, 900, 0.2), c("2026-12-18", 27, "put", 6950, 650, 0.22),
    c("bad", 1, "call", 7000, 999),
  ], spot);
  assert.deepEqual(rows.map((r) => r.expiry), ["2026-11-27", "2026-12-18"]);
  const [a, b] = rows;
  assert.deepEqual([a.callOi, a.putOi, a.oi], [300, 150, 450]);
  // Shares are of every open contract passed in, the malformed row included in the total it came with.
  assert.ok(Math.abs(a.oiShare! - 450 / (450 + 1550 + 999)) < 1e-12);
  assert.equal(a.atmIv, 0.25, "the call and put nearest the price");
  assert.ok(Math.abs(a.sigmaPts! - 7000 * 0.25 * Math.sqrt(6 / 365)) < 1e-9);
  assert.ok(b.sigmaPts! > a.sigmaPts!, "a later expiry implies a wider range");
  // No open interest anywhere (Schwab on a weekend): shares are unknown, not zero.
  const noOi = expirySummary([c("2026-11-27", 6, "call", 7000, 0), c("2026-11-27", 6, "put", 7000, 0)], spot);
  assert.deepEqual([noOi[0].oi, noOi[0].oiShare, noOi[0].maxPain], [0, null, null]);
  // No usable IV: no range, not a zero-width one.
  assert.equal(expirySummary([c("2026-11-27", 6, "call", 7000, 10, 0)], spot)[0].sigmaPts, null);
});

test("every level in one list, highest first, with its distance from the price and the tool it came from", () => {
  const r = rankLevels([
    { price: 7245, label: "collar long put", source: "JPM collar" }, { price: 6877, label: "prior-day low", source: "level board" },
    { price: 7003, label: "pivot", source: "level board" }, { price: 7003, label: "pivot", source: "level board" },
    { price: NaN, label: "bad", source: "x" }, { price: 7100, label: "", source: "x" },
  ], 7000);
  assert.deepEqual(r.map((l) => [l.price, l.side, Math.round(l.distPts)]), [[7245, "above", 245], [7003, "at", 3], [6877, "below", -123]]);
  assert.ok(Math.abs(r[0].distPct - 0.035) < 1e-9);
  assert.deepEqual(rankLevels([{ price: 7000, label: "a", source: "s" }], null), [], "no price, no distances");
});

test("the collar is drawn only while its strikes are live; otherwise the reason is given", () => {
  const live = collarLevels({ rollDate: "2026-12-31", longPut: 7245, shortPut: 6110, shortCall: 8060, verification: "partial", expired: false });
  assert.deepEqual(live.levels.map((l) => [l.price, l.label]), [[8060, "collar short call"], [7245, "collar long put"], [6110, "collar short put"]]);
  assert.match(live.levels[0].source, /JPM collar to 2026-12-31 \(partial\)/);
  const gone = collarLevels({ rollDate: "2026-03-31", longPut: 5565, shortPut: 4700, shortCall: 6165, expired: true, staleNote: "Strikes on file expired at the 2026-03-31 roll." });
  assert.equal(gone.levels.length, 0);
  assert.equal(gone.note, "the strikes on file expired at the 2026-03-31 roll, and the current collar's strikes are not on file (no reputable source was found for them), so no collar level is listed or drawn.");
  assert.doesNotMatch(gone.note!, /historical reference/, "the page's own words: here nothing is shown");
  assert.deepEqual(collarLevels(null), { levels: [], note: null });
});

test("the stretch ahead is cut into this week, the next two weeks, then month pieces, each with its events and largest expiry", () => {
  const spot = 7000;
  const ex = expirySummary([
    c("2026-11-23", 2, "call", 7000, 100), c("2026-11-27", 6, "call", 7000, 300), c("2026-12-04", 13, "put", 7000, 200),
    c("2026-12-18", 27, "call", 7000, 2000), c("2026-12-31", 40, "put", 7000, 900), c("2027-01-15", 55, "call", 7000, 700),
  ], spot);
  const events = [{ date: "2026-11-26", label: "Thanksgiving", type: "holiday" }, { date: "2026-12-16", label: "FOMC", type: "fomc" }, { date: "2026-12-18", label: "Quad witching", type: "quad_witching" }, { date: "2027-03-01", label: "far", type: "x" }];
  const w = outlookWindows("2026-11-21", ex, events, spot); // a Saturday
  assert.deepEqual(w.map((x) => [x.from, x.to]), [["2026-11-21", "2026-11-22"], ["2026-11-23", "2026-11-29"], ["2026-11-30", "2026-12-06"], ["2026-12-07", "2026-12-31"], ["2027-01-01", "2027-01-15"]]);
  assert.equal(w[0].title, "Now to Nov 22");
  assert.equal(w[0].expiries.length, 0);
  assert.deepEqual(w[1].events.map((e) => e.label), ["Thanksgiving"]);
  assert.equal(w[1].largest!.expiry, "2026-11-27");
  assert.equal(w[3].largest!.expiry, "2026-12-18");
  assert.deepEqual(w[3].events.map((e) => e.label), ["FOMC", "Quad witching"]);
  assert.equal(w[3].range!.expiry, "2026-12-31", "the range runs to the window's last expiry");
  assert.ok(w.every((x, i) => i === 0 || x.from > w[i - 1].to), "no day in two windows");
  assert.deepEqual(outlookWindows("2027-02-01", ex, events, spot), [], "nothing ahead, nothing drawn");
  // Short labelled lines: counts, dates and prices. An empty window says nothing and is not shown.
  const lines = windowLines(w[3]);
  assert.deepEqual(lines.slice(0, 2), [
    { label: "Events", text: "FOMC Dec 16, Quad witching Dec 18" },
    { label: "Largest expiry", text: "Dec 18, 48% of open interest read (2,000 contracts), max pain 7,000" },
  ]);
  assert.equal(lines[2].label, "Implied range by Dec 31");
  assert.match(lines[2].text, /^[\d,]+ to [\d,]+ \(±[\d,]+\)$/);
  assert.deepEqual(windowLines(w[0]), []);
  assert.equal(windowHasContent(w[0]), false);
  assert.equal(windowHasContent(w[3]), true);
  // The expiry table opens on the nearest expiry and the ones that hold 2% or more; the rest are one tap away.
  const rows = [{ oiShare: 0.004 }, { oiShare: 0.019 }, { oiShare: 0.02 }, { oiShare: 0.48 }, { oiShare: null }];
  assert.deepEqual(mainExpiryRows(rows), [rows[0], rows[2], rows[3]]);
  assert.deepEqual(mainExpiryRows([{ oiShare: null }, { oiShare: null }]).length, 2, "no open interest read: nothing to rank by");
  assert.equal(shortDate("2027-01-05"), "Jan 5");
});

test("the picture: time to the last expiry, the implied range widening, the nearest levels, and a count of what is not drawn", () => {
  const spot = 7000;
  const ex = expirySummary([c("2026-11-27", 6, "call", 7000, 300, 0.25), c("2026-12-18", 27, "call", 7000, 900, 0.2), c("2027-01-15", 55, "put", 7000, 100, 0.2)], spot);
  const levels = rankLevels([
    ...[7050, 7100, 7150, 7200, 7250, 7300].map((p) => ({ price: p, label: `up ${p}`, source: "level board" })),
    ...[6950, 6900].map((p) => ({ price: p, label: `down ${p}`, source: "level board" })),
    { price: 8060, label: "collar short call", source: "JPM collar" },
  ], spot);
  const ch = outlookChart("2026-11-21", spot, ex, levels, [{ date: "2026-12-16", label: "FOMC", type: "fomc" }, { date: "2027-06-01", label: "out of range", type: "x" }])!;
  assert.deepEqual([ch.from, ch.to], ["2026-11-21", "2027-01-15"]);
  assert.equal(ch.cone.length, 3);
  assert.ok(ch.cone[0].x < ch.cone[1].x && ch.cone[1].x < ch.cone[2].x && ch.cone[2].x === 1);
  assert.ok(ch.cone[2].yHi < ch.cone[0].yHi && ch.cone[2].yLo > ch.cone[0].yLo, "wider further out (y from the top)");
  assert.ok(Math.abs(ch.ySpot - 0.5) < 1e-9, "the price sits in the middle");
  assert.equal(ch.levels.filter((l) => l.side === "above").length, OUTLOOK_LINES_PER_SIDE);
  assert.deepEqual(ch.levels.filter((l) => l.side === "below").map((l) => l.price), [6950, 6900]);
  assert.ok(!ch.levels.some((l) => l.price === 8060), "a far level does not flatten the picture");
  assert.equal(ch.levelsNotDrawn, levels.length - ch.levels.length);
  assert.equal(ch.levelsNotDrawn, 3);
  assert.ok(ch.levels.every((l) => l.y >= 0 && l.y <= 1));
  assert.deepEqual(ch.events.map((e) => e.label), ["FOMC"]);
  assert.equal(outlookChart("2026-11-21", null, ex, levels, []), null, "no price: nothing is drawn");
  assert.equal(outlookChart("2027-03-01", spot, ex, levels, []), null, "no expiry ahead: nothing is drawn");
});

test("a share is never 0% for an expiry that has open interest", () => {
  assert.equal(sharePct(0.004), "under 1%");
  assert.equal(sharePct(0.005), "1%");
  assert.equal(sharePct(0), "0%");
  assert.equal(sharePct(0.476), "48%");
});

test("board levels carry a true source, and option-map levels are left out when the board's map is not current", () => {
  const BARS: BoardLevel[] = [{ key: "pdh", label: "prior-day high", price: 7048.6, group: "prior day" }, { key: "pdl", label: "prior-day low", price: 6998.2, group: "prior day" }, { key: "pp", label: "pivot", price: 7020, group: "pivot" }];
  const OPTS: BoardLevel[] = [{ key: "wallAbove", label: "wall above", price: 7050, group: "options" }, { key: "flip", label: "gamma flip", price: 7126, group: "options" }];
  const all = mergeLevels([...BARS, ...OPTS], 7018), without = mergeLevels(BARS, 7018);
  const ok = boardOutlookLevels({ all, withoutOptions: without, optionsState: "ok" });
  assert.equal(ok.optionsNote, null);
  const src = (label: RegExp) => ok.levels.filter((l) => label.test(l.label)).map((l) => l.source);
  assert.deepEqual(src(/^prior-day high$/), ["level board"], "the bar level is listed by itself, not hidden in the wall's line");
  assert.deepEqual(src(/^gamma flip$/), ["option map"]);
  assert.deepEqual(src(/wall above.*prior-day high|prior-day high.*wall above/), ["option map, joined with board levels within a few points"]);
  // The board's option map is stale: its levels are not listed as if current, and the reason is given.
  const stale = boardOutlookLevels({ all, withoutOptions: without, optionsState: "stale", optionsReason: "the chain is the last session's" });
  assert.deepEqual(stale.levels.map((l) => l.source), ["level board", "level board", "level board"]);
  assert.equal(stale.optionsNote, "Option-map levels (walls, pin, flip, straddle range) are left out: the board's option map is stale (the chain is the last session's).");
  assert.ok(!stale.levels.some((l) => /wall|flip/.test(l.label)));
  // No option-free list for this index: nothing is guessed from the mixed list.
  const none = boardOutlookLevels({ all, withoutOptions: null, optionsState: "ok" });
  assert.deepEqual([none.levels.length, none.optionsNote], [0, "The board sent no level list for this index, so its levels are not listed."]);
  // A landmark can REGROUP the bars around it: bars-only merges "prior-day high + R1"; with a wall just above,
  // the wall takes the high and R1 is left alone. R1 is a pivot whichever list it is read from.
  const B2: BoardLevel[] = [{ key: "pdh", label: "prior-day high", price: 6700, group: "prior day" }, { key: "r1", label: "pivot R1", price: 6697, group: "pivot" }];
  const all2 = mergeLevels([...B2, { key: "wallAbove", label: "wall above", price: 6703, group: "options" }], 6700), without2 = mergeLevels(B2, 6700);
  assert.equal(without2.length, 1, "the two bars are one line without the wall");
  assert.ok(all2.some((l) => l.key === "r1"), "and R1 stands alone once the wall takes the high");
  const re = boardOutlookLevels({ all: all2, withoutOptions: without2, optionsState: "ok" });
  assert.deepEqual(re.levels.filter((l) => /R1/.test(l.label)).map((l) => l.source), ["level board"], "R1 is listed once, as a board level, never as an option-map level");
  assert.deepEqual(re.levels.filter((l) => /wall above/.test(l.label)).map((l) => l.source), ["option map, joined with board levels within a few points"]);
  assert.equal(re.levels.length, 2);
  assert.ok(!re.levels.some((l) => /at the same price/.test(l.source)));
  // A board with bars only and no landmarks: no note.
  assert.deepEqual(boardOutlookLevels({ all: without, withoutOptions: without, optionsState: "unavailable" }).optionsNote, null);
});

test("labels are pushed apart so one does not print on another, in their own order and inside the box", () => {
  assert.deepEqual(spreadLabels([0.5, 0.2, 0.8], 0.05), [0.5, 0.2, 0.8], "already apart: untouched");
  const packed = spreadLabels([0.500, 0.502, 0.504], 0.05);
  assert.ok(Math.abs(packed[1] - packed[0] - 0.05) < 1e-12 && Math.abs(packed[2] - packed[1] - 0.05) < 1e-12);
  assert.equal(packed[0], 0.5);
  const order = spreadLabels([0.504, 0.5, 0.502], 0.05);
  assert.ok(order[1] < order[2] && order[2] < order[0], "each keeps its place relative to the others");
  const bottom = spreadLabels([0.97, 0.98, 0.99], 0.05);
  assert.ok(bottom.every((y) => y >= 0 && y <= 1));
  assert.ok(Math.abs(bottom[2] - 1) < 1e-12 && Math.abs(bottom[1] - 0.95) < 1e-12);
  assert.deepEqual(spreadLabels([], 0.05), []);
});

test("wiring: the chain audit carries the per-expiry rows", () => {
  const s = readFileSync("server/chainAudit.ts", "utf8");
  assert.match(s, /expiries: expirySummary\(contracts\.map\(\(c\) => \(\{ expiry: c\.expiry, dte: c\.dte, tYears: c\.tYears, side: c\.side, strike: c\.strike, oi: c\.oi, iv: c\.sigma \?\? c\.iv \}\)\), spot\),/);
});

test("wiring: the page reads four existing endpoints, shares the audit and board reads, and never shows a failed read as an empty one", () => {
  const ui = readFileSync("client/src/components/Outlook.tsx", "utf8");
  for (const k of ['queryKey: ["/api/chain-audit", SYMBOL]', 'queryKey: ["/api/desk/board"]', 'queryKey: ["/api/vol-calendar"]', 'queryKey: ["/api/jpm-collar"]']) assert.ok(ui.includes(k), k);
  assert.ok(ui.includes("&dte=60"), "the same request the Chain Audit panel makes, so they share one read");
  assert.match(ui, /enabled: active/);
  assert.match(ui, /This is not a list of no expiries\./);
  assert.match(ui, /This is not a calendar with nothing on it\./);
  assert.match(ui, /its levels are missing from this list/);
  assert.match(ui, /data-answer-tab="outlook" data-ready=\{settled \? "1" : "0"\}/, "the layout audit waits for this line on every tab");
  assert.match(ui, /boardOutlookLevels\(\{ all: spx\.levels, withoutOptions: cases\?\.levelsWithoutOptions \?\? null, optionsState: cases\?\.optionsState \?\? null/);
  assert.match(ui, /lastSession=\{audit\.data\?\.chainLastSession \?\? null\}/);
  assert.match(ui, /data-testid="outlook-oi-note"/);
  assert.match(ui, /dteRead != null && dteRead < 60/);
  assert.match(readFileSync("server/routes.ts", "utf8"), /audit\.dteRead = dteRead;/);
  assert.match(ui, /priced in, not a forecast/);
  assert.match(ui, /A level is a mapped price, not a target\./);
  assert.doesNotMatch(ui, /<text /, "labels are ordinary text over the drawing, so they keep their size on a phone");
  const dash = readFileSync("client/src/pages/dashboard.tsx", "utf8");
  assert.match(dash, /<TabsTrigger value="outlook" data-testid="tab-outlook"/);
  assert.match(dash, /<Outlook active=\{activeTab === "outlook"\} \/>/);
  assert.match(dash, /\{ key: "outlook", label: "Outlook" \},/);
  assert.match(readFileSync("tests/ux/ux-audit.mjs", "utf8"), /const tabs = \["signals", "outlook", "chart",/);
});
