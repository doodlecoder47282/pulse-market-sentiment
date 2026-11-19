// The level board: hand-marked chart levels per ticker and the two descriptive cases (shared/levelBoard.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDeskBoard, _resetDeskBoardCache, type DeskBoardDeps } from "../../server/deskBoard";
import {
  calendarLevels, sessionLevels, mergeLevels, nearestLevels, deskCase, techRead, vixRead, boardAnswer, boardSession, weekStart, priorMonth,
  type DayBar, type BoardLevel,
} from "../../shared/levelBoard";

const bar = (date: string, o: number, h: number, l: number, c: number): DayBar => ({ date, open: o, high: h, low: l, close: c });
// Oct 26-30 (prior month + two weeks back), Nov 2-6 (prior week), Nov 9-11 (this week); "today" is Wed 2026-11-11.
const daily: DayBar[] = [
  bar("2026-10-29", 100, 111, 95, 108), bar("2026-10-30", 108, 109, 101, 104),
  bar("2026-11-02", 104, 106, 100, 105), bar("2026-11-05", 105, 112, 103, 110), bar("2026-11-06", 110, 111, 107, 109),
  bar("2026-11-09", 109.5, 113, 108, 112), bar("2026-11-10", 112, 114, 110, 111),
  bar("2026-11-11", 111.5, 115, 111, 114), // in progress: never "prior"
];
const price = (ls: BoardLevel[], key: string) => ls.find((l) => l.key === key)?.price;

test("calendar helpers", () => {
  assert.equal(weekStart("2026-11-11"), "2026-11-09");
  assert.equal(weekStart("2026-11-09"), "2026-11-09");
  assert.equal(weekStart("2026-11-15"), "2026-11-09");
  assert.equal(priorMonth("2026-11-11"), "2026-10");
  assert.equal(priorMonth("2026-01-05"), "2025-12");
});

test("calendar levels come from completed bars only", () => {
  const ls = calendarLevels(daily, "2026-11-11");
  assert.deepEqual([price(ls, "pdh"), price(ls, "pdl"), price(ls, "pdc")], [114, 110, 111]);
  const p = (114 + 110 + 111) / 3;
  assert.ok(Math.abs(price(ls, "pp")! - p) < 1e-9);
  assert.ok(Math.abs(price(ls, "r1")! - (2 * p - 110)) < 1e-9);
  assert.ok(Math.abs(price(ls, "s1")! - (2 * p - 114)) < 1e-9);
  assert.deepEqual([price(ls, "pwh"), price(ls, "pwl"), price(ls, "pwc")], [112, 100, 109]);
  assert.equal(price(ls, "wo"), 109.5);
  assert.deepEqual([price(ls, "pmh"), price(ls, "pml"), price(ls, "pmc")], [111, 95, 104]);
  assert.equal(price(ls, "mo"), 104);
  assert.equal(calendarLevels(daily, "2026-11-11", { pivots: false }).some((l) => l.group === "pivot"), false);
});

test("after the close the board is for the next session, so today's bar becomes the prior day", () => {
  const ls = calendarLevels(daily, "2026-11-12");
  assert.deepEqual([price(ls, "pdh"), price(ls, "pdl"), price(ls, "pdc")], [115, 111, 114]);
  // Monday's board: the week just ended is the prior week.
  const mon = calendarLevels(daily, "2026-11-16");
  assert.deepEqual([price(mon, "pwh"), price(mon, "pwl"), price(mon, "pwc")], [115, 108, 114]);
  assert.equal(price(mon, "wo"), undefined, "no bar of the new week yet");
  assert.deepEqual(calendarLevels([], "2026-11-11"), []);
  assert.deepEqual(calendarLevels([bar("2026-11-10", 0, 1, 1, 1)], "2026-11-11"), [], "a bar with a zero price is not a bar");
});

test("board session: today until the close, then the next trading day", () => {
  assert.deepEqual(boardSession(Date.UTC(2026, 10, 11, 13, 0)), { forSession: "2026-11-11", sessionOpen: false, today: "2026-11-11" }); // 08:00 ET
  assert.deepEqual(boardSession(Date.UTC(2026, 10, 11, 16, 0)), { forSession: "2026-11-11", sessionOpen: true, today: "2026-11-11" });  // 11:00 ET
  assert.deepEqual(boardSession(Date.UTC(2026, 10, 11, 22, 0)), { forSession: "2026-11-12", sessionOpen: false, today: "2026-11-11" }); // 17:00 ET
  assert.equal(boardSession(Date.UTC(2026, 10, 14, 16, 0)).forSession, "2026-11-16"); // Saturday
  assert.equal(boardSession(Date.UTC(2026, 10, 26, 16, 0)).forSession, "2026-11-27"); // Thanksgiving
  assert.deepEqual(boardSession(Date.UTC(2026, 10, 27, 17, 30)), { forSession: "2026-11-27", sessionOpen: true, today: "2026-11-27" }); // half day, 12:30 ET
  assert.equal(boardSession(Date.UTC(2026, 10, 27, 18, 0)).forSession, "2026-11-30"); // half day, 13:00 ET: closed
});

test("session levels: the open at once, the opening range only after 10:00 ET", () => {
  const at = (h: number, m: number) => Date.UTC(2026, 10, 11, h + 5, m); // ET = UTC-5 in November
  const bars = [
    { t: at(9, 25), open: 1, high: 1, low: 1, close: 1 },           // pre-market: ignored
    { t: at(9, 30), open: 111.5, high: 112, low: 111, close: 111.8 },
    { t: at(9, 55), open: 111.8, high: 113, low: 111.6, close: 112.5 },
    { t: at(10, 0), open: 112.5, high: 114, low: 112, close: 113.5 }, // after the range
    { t: Date.UTC(2026, 10, 10, 15, 0), open: 50, high: 60, low: 40, close: 55 }, // yesterday: ignored
  ];
  const early = sessionLevels(bars, "2026-11-11", at(9, 58));
  assert.deepEqual(early.map((l) => [l.key, l.price]), [["open", 111.5]]);
  // At 10:00 with no bar at or after 10:00 yet, the 09:55 bar may be half formed: no range.
  assert.deepEqual(sessionLevels(bars.filter((b) => b.t !== at(10, 0)), "2026-11-11", at(10, 0)).map((l) => l.key), ["open"]);
  // A feed that starts after 09:30 has no open to show.
  assert.deepEqual(sessionLevels(bars.filter((b) => b.t !== at(9, 30)), "2026-11-11", at(10, 5)), []);
  const later = sessionLevels(bars, "2026-11-11", at(10, 5));
  assert.deepEqual(later.map((l) => [l.key, l.price]), [["open", 111.5], ["orh", 113], ["orl", 111]]);
  assert.deepEqual(sessionLevels(bars, "2026-11-12", at(10, 5)), []);
});

test("nearest levels, merging and the cases", () => {
  const ls: BoardLevel[] = [
    { key: "a", label: "prior-day high", price: 7350, group: "prior day" },
    { key: "b", label: "pivot R1", price: 7351, group: "pivot" },          // within 0.05% of 7350: one line
    { key: "c", label: "wall above", price: 7400, group: "options" },
    { key: "d", label: "prior-week high", price: 7450, group: "week" },
    { key: "e", label: "gamma flip", price: 7300, group: "options" },
    { key: "f", label: "prior-day low", price: 7250, group: "prior day" },
    { key: "g", label: "pin", price: 7325, group: "options" },             // within 0.1% of the price: "at"
  ];
  const m = mergeLevels(ls, 7324);
  assert.equal(m.length, 6);
  assert.equal(m.find((l) => l.price === 7351)!.label, "pivot R1 7,351 + prior-day high 7,350");
  assert.equal(new Set(m.map((l) => l.key)).size, m.length);
  assert.equal(mergeLevels([{ key: "x", label: "pin", price: 7300, group: "options" }, { key: "y", label: "gamma flip", price: 7300, group: "options" }], 7324)[0].label, "pin + gamma flip");
  const n = nearestLevels(ls, 7324);
  assert.deepEqual(n.at.map((l) => l.label), ["pin"]);
  assert.equal(n.above[0].price, 7350, "a joined line above the price is stated at its nearest member");
  // A run of close levels does not chain into one line, and a price sitting on a level is at it.
  const run: BoardLevel[] = [100.06, 100.02, 99.98, 99.94, 99.9].map((p, i) => ({ key: `k${i}`, label: `L${i}`, price: p, group: "pivot" as const }));
  assert.ok(mergeLevels(run, 99.9).length > 1);
  assert.ok(nearestLevels(run, 99.9).at.length > 0);
  assert.equal(n.below[0].price, 7300);
  const bull = deskCase(ls, 7324, "bull");
  assert.equal(bull.text, "Bull case: above 7,350 (pivot R1 7,351 + prior-day high 7,350) the next levels up are 7,400 (wall above) and 7,450 (prior-week high). The first level under the price is 7,300 (gamma flip).");
  const bear = deskCase(ls, 7324, "bear");
  assert.equal(bear.text, "Bear case: below 7,300 (gamma flip) the next level down is 7,250 (prior-day low). The first level over the price is 7,350 (pivot R1 7,351 + prior-day high 7,350).");
  assert.equal(deskCase(ls, 7500, "bull").text, "Bull case: no mapped level above the price.");
  assert.equal(deskCase(ls, null, "bear").text, "Bear case: no price read.");
  assert.equal(deskCase([ls[0]], 7324, "bull").text, "Bull case: above 7,350 (prior-day high) no further mapped level above.");
  for (const t of [bull.text, bear.text]) assert.doesNotMatch(t, /will|should|expect|likely|target|buy|sell|%|is off/i);
});

test("tech and VIX reads state the numbers they come from", () => {
  assert.deepEqual([techRead(0.8, 0.2).state, techRead(-0.5, 0.1).state, techRead(0.3, 0.2).state, techRead(null, 0.2).state], ["leading", "lagging", "in line", "unknown"]);
  assert.equal(techRead(0.8, 0.2).text, "QQQ +0.80% against SPY +0.20%: tech leading by 0.60 percentage points (hand-set line: 0.25).");
  assert.equal(techRead(0.3, 0.2).text, "QQQ +0.30% against SPY +0.20%: tech in line (hand-set line: 0.25).");
  assert.deepEqual([vixRead(3).state, vixRead(-2).state, vixRead(0.4).state, vixRead(undefined).state], ["firm", "soft", "flat", "unknown"]);
  assert.equal(vixRead(-3.53).text, "VIX -3.53% on the day: soft (hand-set line: 1%).");
});

test("the board's one-line answer", () => {
  const up: BoardLevel = { key: "u", label: "wall above", price: 7400, group: "options" };
  const dn: BoardLevel = { key: "d", label: "gamma flip", price: 7300, group: "options" };
  assert.equal(boardAnswer("SPX", 7324, { at: [], above: up, below: dn }), "SPX 7,324 sits between 7,300 (gamma flip) below and 7,400 (wall above) above.");
  assert.equal(boardAnswer("SPX", 7300, { at: [dn], above: up, below: null }), "SPX 7,300 is at 7,300 (gamma flip).");
  assert.equal(boardAnswer("SPX", null, { at: [], above: null, below: null }), "SPX: no price read, so no levels are placed.");
  assert.equal(boardAnswer("VIX", 23.9, { at: [], above: null, below: { key: "x", label: "prior-day low", price: 23.1, group: "prior day" } }), "VIX 23.90 is over every mapped level; the nearest is 23.10 (prior-day low).");
});

test("wiring: the board is served and sits at the top of the Trade Desk", () => {
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /app\.get\("\/api\/desk\/board"/);
  const desk = readFileSync(new URL("../../client/src/components/TradeDesk.tsx", import.meta.url), "utf8");
  assert.ok(desk.indexOf("<DeskBoard />") > 0 && desk.indexOf("<DeskBoard />") < desk.indexOf("<OdteMapCard />"));
  const srv = readFileSync(new URL("../../server/deskBoard.ts", import.meta.url), "utf8");
  assert.match(srv, /returned no quote for \$\{t\.symbol\}/);
  assert.match(srv, /"\/ES"/);
});

// ── the server build, with injected reads ──────────────────────────────────────────────────────────────
const dayMs = (d: string) => Date.parse(d + "T05:00:00Z");
const candles = (bars: DayBar[]) => bars.map((b) => ({ datetime: dayMs(b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: 1 }));
function deps(o: { quotes?: any[]; daily?: (sym: string) => any; intra?: (sym: string) => any; calls?: string[]; edition?: string } = {}): DeskBoardDeps {
  return {
    getQuotes: async () => o.quotes ?? [
      { symbol: "$SPX", last: 113, changePercent: 0.5, stale: false }, { symbol: "SPY", last: 113, changePercent: 0.2, stale: false },
      { symbol: "QQQ", last: 113, changePercent: 0.8, stale: false }, { symbol: "$VIX", last: 20, changePercent: -2, stale: false },
      { symbol: "/ES", last: 113, changePercent: null, prevClose: 100, stale: false },
    ],
    getPriceHistory: async (sym, periodType) => {
      o.calls?.push(`${sym}:${periodType}`);
      if (periodType === "month") return o.daily ? o.daily(sym) : { symbol: sym, candles: candles(daily), source: "schwab", dataState: "ok", asOfMs: Date.UTC(2026, 10, 11, 16, 0) };
      return o.intra ? o.intra(sym) : { symbol: sym, candles: [], source: "schwab", dataState: "empty", reason: "no bars yet" };
    },
    optionLevels: async () => ({ levels: [{ key: "wallAbove", label: "wall above", price: 120, group: "options" }], state: "ok", reason: null, asOfMs: 1 }),
    edition: () => o.edition ?? "personal",
  } as DeskBoardDeps;
}
const NOON = Date.UTC(2026, 10, 11, 17, 0); // 12:00 ET, Wed

test("build: quotes are keyed as asked, a future falls back to its previous close, and a missing quote says so", async () => {
  _resetDeskBoardCache();
  const calls: string[] = [];
  const b = await buildDeskBoard(NOON, deps({ calls }));
  const t = (s: string) => b.tickers.find((x) => x.symbol === s)!;
  assert.equal(t("$SPX").price, 113);
  assert.equal(t("/ES").changePct, 13);
  assert.deepEqual([t("/NQ").quoteState, t("/NQ").quoteReason], ["unavailable", "Schwab returned no quote for /NQ"]);
  assert.ok(!calls.includes("/NQ:month") && !calls.includes("/ES:month"), "no bars are asked for a future, priced or not");
  assert.match(t("/ES").levelsReason ?? "", /price only/);
  assert.ok(!calls.some((c) => c.startsWith("/ES:day")), "no intraday bars for futures");
  assert.equal(b.tech.state, "leading");
  assert.equal(b.vix.state, "soft");
  assert.equal(t("$SPX").priorSession, "2026-11-10");
  assert.equal(t("$SPX").levelsState, "partial", "session open but no 09:30 bar read");
  assert.match(t("$SPX").levelsReason ?? "", /today's open and opening range not read: no bars yet/);
  assert.ok(t("$SPX").levels.some((l) => l.key.split("+").includes("wallAbove")));
  assert.ok(!t("SPY").levels.some((l) => l.group === "options"));
  _resetDeskBoardCache();
  const demo = await buildDeskBoard(NOON, deps({ edition: "demo" }));
  assert.equal(demo.tickers.find((x) => x.symbol === "/NQ")!.quoteReason, "the sample feed returned no quote for /NQ");
});

test("build: stale and unknown-age quotes are not shown as live in session", async () => {
  _resetDeskBoardCache();
  const b = await buildDeskBoard(NOON, deps({ quotes: [{ symbol: "$SPX", last: 113, changePercent: 0, stale: true }, { symbol: "SPY", last: 113, changePercent: 0, stale: null }, { symbol: "QQQ", last: 113, changePercent: 0, stale: false }] }));
  const st = (s: string) => b.tickers.find((x) => x.symbol === s)!.quoteState;
  assert.deepEqual([st("$SPX"), st("SPY"), st("QQQ"), st("$VIX")], ["stale", "age_unknown", "ok", "unavailable"]);
  _resetDeskBoardCache();
  const closed = await buildDeskBoard(Date.UTC(2026, 10, 11, 23, 0), deps({ quotes: [{ symbol: "SPY", last: 113, changePercent: 0, stale: null }] }));
  assert.equal(closed.tickers.find((x) => x.symbol === "SPY")!.quoteState, "ok", "closed: the last price is the last price");
});

test("build: a newest bar that is not the expected prior session is partial, with the date", async () => {
  _resetDeskBoardCache();
  const old = daily.filter((b) => b.date <= "2026-11-09");
  const b = await buildDeskBoard(NOON, deps({ daily: (sym) => ({ symbol: sym, candles: candles(old), source: "schwab", dataState: "ok", asOfMs: NOON }) }));
  const spx = b.tickers.find((x) => x.symbol === "$SPX")!;
  assert.equal(spx.levelsState, "partial");
  assert.match(spx.levelsReason ?? "", /the newest completed daily bar is 2026-11-09, not 2026-11-10/);
});

test("build: at the close the daily read is taken again, and a pre-close payload is flagged, not trusted", async () => {
  _resetDeskBoardCache();
  const calls: string[] = [];
  const pre = Date.UTC(2026, 10, 11, 20, 45);  // 15:45 ET
  const post = Date.UTC(2026, 10, 11, 21, 1);  // 16:01 ET
  const d = deps({ calls, daily: (sym) => ({ symbol: sym, candles: candles(daily), source: "schwab", dataState: "ok", asOfMs: pre }) });
  await buildDeskBoard(pre, d);
  const n1 = calls.filter((c) => c === "$SPX:month").length;
  const b = await buildDeskBoard(post, d);
  assert.equal(calls.filter((c) => c === "$SPX:month").length, n1 + 1, "the session flipped: the cached read is not reused");
  const spx = b.tickers.find((x) => x.symbol === "$SPX")!;
  assert.equal(b.forSession, "2026-11-12");
  assert.equal(spx.levelsState, "partial");
  assert.match(spx.levelsReason ?? "", /the daily bar for 2026-11-11 was read before that session closed/);
});

test("build: a refused read is not asked for again inside five minutes, an empty one inside one", async () => {
  _resetDeskBoardCache();
  const calls: string[] = [];
  const d = deps({ calls, daily: (sym) => ({ symbol: sym, candles: [], source: "schwab", dataState: "unavailable", reason: "HTTP 403" }) });
  const b = await buildDeskBoard(NOON, d);
  assert.equal(b.tickers[0].levelsState, "unavailable");
  assert.match(b.tickers[0].levelsReason ?? "", /no daily bars from Schwab for \$SPX: HTTP 403/);
  await buildDeskBoard(NOON + 4 * 60_000, d);
  assert.equal(calls.filter((c) => c === "$SPX:month").length, 1);
  await buildDeskBoard(NOON + 6 * 60_000, d);
  assert.equal(calls.filter((c) => c === "$SPX:month").length, 2);
  // An empty read that is not a refusal is tried again after a minute.
  _resetDeskBoardCache();
  const calls2: string[] = [];
  const d2 = deps({ calls: calls2, daily: (sym) => ({ symbol: sym, candles: [], source: "schwab", dataState: "unavailable", reason: "Schwab not connected" }) });
  await buildDeskBoard(NOON, d2);
  await buildDeskBoard(NOON + 30_000, d2);
  assert.equal(calls2.filter((c) => c === "$SPX:month").length, 1);
  await buildDeskBoard(NOON + 90_000, d2);
  assert.equal(calls2.filter((c) => c === "$SPX:month").length, 2);
});

test("build: a missing quote carries the source's own stated reason when it gave one", async () => {
  _resetDeskBoardCache();
  const d = deps();
  d.quoteRefusal = async (s) => (s === "/NQ" ? "invalid_symbol" : null);
  const b = await buildDeskBoard(NOON, d);
  const nq = b.tickers.find((x) => x.symbol === "/NQ")!;
  assert.deepEqual([nq.quoteState, nq.quoteReason], ["unavailable", "Schwab answered that /NQ is not a symbol it recognises"]);
  assert.equal(b.tickers.find((x) => x.symbol === "/ES")!.quoteReason, null);
  for (const [code, re] of [["no_entry", /answered, with no entry for \/NQ/], ["no_price", /entry for \/NQ with no price/], ["not_connected", /not connected/], ["no_answer", /did not answer/]] as const) {
    _resetDeskBoardCache();
    const dd = deps(); dd.quoteRefusal = async () => code;
    assert.match((await buildDeskBoard(NOON, dd)).tickers.find((x) => x.symbol === "/NQ")!.quoteReason ?? "", re);
  }
  _resetDeskBoardCache();
  const demo = deps({ edition: "demo" }); demo.quoteRefusal = async () => "no_entry";
  assert.equal((await buildDeskBoard(NOON, demo)).tickers.find((x) => x.symbol === "/NQ")!.quoteReason, "the sample feed answered, with no entry for /NQ");
  _resetDeskBoardCache();
  const none = deps(); none.quoteRefusal = async () => null;
  assert.equal((await buildDeskBoard(NOON, none)).tickers.find((x) => x.symbol === "/NQ")!.quoteReason, "Schwab returned no quote for /NQ");
});

test("build: when the source refuses daily bars, the copy kept from the last good read is used and named", async () => {
  _resetDeskBoardCache();
  const store = new Map<string, { bars: any[]; asOfMs: number | null }>();
  const good = deps();
  good.saveDaily = async (s, bars, asOfMs) => { store.set(s, { bars, asOfMs }); };
  good.loadDaily = async (s) => store.get(s) ?? null;
  const first = await buildDeskBoard(NOON, good);
  assert.ok(store.has("$SPX") && store.has("SPY"), "a good read is kept");
  assert.doesNotMatch(first.tickers.find((x) => x.symbol === "$SPX")!.levelsReason ?? "", /copy kept/);

  _resetDeskBoardCache(); // a restart: the in-memory caches are gone, the store is not
  const refused = deps({ daily: (sym) => ({ symbol: sym, candles: [], source: "schwab", dataState: "unavailable", reason: "self-throttle (100 requests/min); no cached Schwab response" }) });
  refused.saveDaily = good.saveDaily; refused.loadDaily = good.loadDaily;
  const b = await buildDeskBoard(NOON, refused);
  const spx = b.tickers.find((x) => x.symbol === "$SPX")!;
  assert.ok(spx.levels.some((l) => l.key.split("+").includes("pdl")), "levels come from the kept copy");
  assert.equal(spx.levelsState, "partial");
  assert.match(spx.levelsReason ?? "", /daily bars are the copy kept from 2026-11-11 \d\d:\d\d ET; the fresh read failed \(.*self-throttle/);
  assert.equal(spx.priorSession, "2026-11-10");
  // The same answer while the refusal is remembered (no second request, still the kept copy).
  const again = await buildDeskBoard(NOON + 30_000, refused);
  assert.match(again.tickers.find((x) => x.symbol === "$SPX")!.levelsReason ?? "", /copy kept/);
});

test("build: with no kept copy a refused read stays unavailable with the source's reason", async () => {
  _resetDeskBoardCache();
  const refused = deps({ daily: (sym) => ({ symbol: sym, candles: [], source: "schwab", dataState: "unavailable", reason: "self-throttle" }) });
  refused.loadDaily = async () => null;
  const spx = (await buildDeskBoard(NOON, refused)).tickers.find((x) => x.symbol === "$SPX")!;
  assert.equal(spx.levelsState, "unavailable");
  assert.match(spx.levelsReason ?? "", /self-throttle/);
});
