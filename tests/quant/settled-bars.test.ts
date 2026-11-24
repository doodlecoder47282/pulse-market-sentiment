// Stored daily bars are completed sessions, and a figure built on bars that stop early says so.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  settledThrough, settledRows, barsState, refreshSettledDailyBars, BEHIND_RETRY_MS, SETTLE_MARGIN_MS,
  type BarRow, type BarsMark, type SettledBarsStore,
} from "../../server/dailyBarsSettled";
import { synthesizeVerdict } from "../../server/edgeBriefing";
import { closesThroughLine, shortDate } from "../../shared/barDates";

const TUE_MID = Date.parse("2026-11-24T18:28:00Z");   // Tuesday 13:28 ET, session open
const TUE_1605 = Date.parse("2026-11-24T21:05:00Z");  // 16:05 ET, closed five minutes
const TUE_1625 = Date.parse("2026-11-24T21:25:00Z");  // 16:25 ET
const SAT = Date.parse("2026-11-21T15:00:00Z");

function weekdays(endIso: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${endIso}T12:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const rowsTo = (endIso: string, n = 60, close = 100): BarRow[] =>
  weekdays(endIso, n).map((date, i) => ({ date, close: close + i, t: Date.parse(`${date}T05:00:00Z`) / 1000 }));

function fakeStore() {
  const bars = new Map<string, Map<string, number>>();
  const marks = new Map<string, BarsMark>();
  const store: SettledBarsStore = {
    getBarsMark: (s) => marks.get(s) ?? null,
    storeSettledDailyBars(s, rows, through, checkedAt) {
      const m = bars.get(s) ?? new Map<string, number>();
      for (const d of [...m.keys()]) if (d > through) m.delete(d);
      for (const r of rows) m.set(r.date, r.close);
      bars.set(s, m);
      marks.set(s, { through, checkedAt });
    },
  };
  return { store, bars, marks };
}

test("the session a bar may be stored for: closed, plus the margin", () => {
  assert.equal(SETTLE_MARGIN_MS, 20 * 60_000);
  assert.equal(settledThrough(TUE_MID), "2026-11-23", "the open session is not a stored bar");
  assert.equal(settledThrough(TUE_1605), "2026-11-23", "five minutes after the close is inside the margin");
  assert.equal(settledThrough(TUE_1625), "2026-11-24");
  assert.equal(settledThrough(SAT), "2026-11-20");
  assert.equal(barsState(null, "2026-11-23"), "missing");
  assert.equal(barsState("2026-11-20", "2026-11-23"), "behind");
  assert.equal(barsState("2026-11-23", "2026-11-23"), "current");
  assert.deepEqual(settledRows([{ date: "2026-11-23" }, { date: "2026-11-24" }], "2026-11-23"), [{ date: "2026-11-23" }]);
});

test("a fetch made while the session is open does not store the open session's bar", async () => {
  const { store, bars, marks } = fakeStore();
  let calls = 0;
  const fetchRows = async () => { calls++; return rowsTo("2026-11-24"); }; // vendor includes today's partial bar
  const r = await refreshSettledDailyBars(["SPY"], fetchRows, store, TUE_MID);
  assert.deepEqual(r.fetched, ["SPY"]);
  assert.equal(r.expected, "2026-11-23");
  assert.equal(bars.get("SPY")!.has("2026-11-24"), false, "the mid-session price is not kept as Tuesday's close");
  assert.equal(marks.get("SPY")!.through, "2026-11-23");
  const again = await refreshSettledDailyBars(["SPY"], fetchRows, store, TUE_MID + 60_000);
  assert.deepEqual(again.cached, ["SPY"]);
  assert.equal(calls, 1, "a current symbol is not asked again");
});

test("a partial bar stored by the old code is removed and the day is read again after its close", async () => {
  const { store, bars } = fakeStore();
  bars.set("GLD", new Map([["2026-11-23", 300], ["2026-11-24", 301.5]])); // 301.5 was a mid-session price
  const afterClose = rowsTo("2026-11-24", 60, 300);
  const first = await refreshSettledDailyBars(["GLD"], async () => afterClose, store, TUE_MID);
  assert.deepEqual(first.fetched, ["GLD"], "no mark yet, so the stored date alone does not count as current");
  assert.equal(bars.get("GLD")!.has("2026-11-24"), false);
  const second = await refreshSettledDailyBars(["GLD"], async () => afterClose, store, TUE_1625);
  assert.deepEqual(second.fetched, ["GLD"]);
  assert.equal(bars.get("GLD")!.get("2026-11-24"), afterClose[afterClose.length - 1].close, "the close, read after the close");
});

test("an answer without the expected session is 'behind': kept, reported, and asked again soon", async () => {
  const { store, marks } = fakeStore();
  let calls = 0;
  const fetchRows = async () => { calls++; return rowsTo("2026-11-20"); }; // Monday's bar not posted
  const r = await refreshSettledDailyBars(["TLT"], fetchRows, store, TUE_MID);
  assert.deepEqual(r.behind, ["TLT"]);
  assert.deepEqual(r.fetched, []);
  assert.deepEqual(r.failed, []);
  assert.equal(marks.get("TLT")!.through, "2026-11-20");
  const soon = await refreshSettledDailyBars(["TLT"], fetchRows, store, TUE_MID + BEHIND_RETRY_MS - 1000);
  assert.deepEqual(soon.behind, ["TLT"]);
  assert.equal(calls, 1, "not asked again inside the retry spacing");
  await refreshSettledDailyBars(["TLT"], fetchRows, store, TUE_MID + BEHIND_RETRY_MS + 1000);
  assert.equal(calls, 2);
});

test("a failed or too-short read stores nothing", async () => {
  const { store, bars, marks } = fakeStore();
  const r = await refreshSettledDailyBars(["A", "B"], async (s) => { if (s === "A") throw new Error("down"); return rowsTo("2026-11-23", 5); }, store, TUE_MID);
  assert.deepEqual(r.failed.sort(), ["A", "B"]);
  assert.equal(bars.size, 0);
  assert.equal(marks.size, 0);
});

test("both refreshers store through the completed-session path only", () => {
  for (const f of ["server/regime.ts", "server/stockBarsCache.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /refreshSettledDailyBars\(/, f);
    assert.doesNotMatch(src, /storage\.upsertDailyBars\(/, `${f} must not write bars directly`);
  }
  const cross = readFileSync("server/crossAsset.ts", "utf8");
  assert.match(cross, /label = "not read: bars not current";/);
  assert.match(cross, /filter\(\(b\) => b\.date <= expectedBarDate\)/);
});

const base = {
  regime: { headline: "Risk-off", narrative: "", riskAxisLabel: "risk", riskAxisDirection: "risk-off", notes: [] },
  playbook: null, weekAhead: [], news: [],
  models: { daily: null, weekly: null },
  levels: {} as any,
};
const spyRow = (extra: object) => ({ symbol: "SPY", last: 690, d1Pct: -1.9, w1Pct: -8.56, m1Pct: -6, corr20d: null, corrRegime: "n/a", ...extra });

test("the weekly change from bars that stop early is not counted, and the line says so", () => {
  const stale = synthesizeVerdict({ ...base, crossAsset: { rows: [spyRow({ barDate: "2026-11-20", stale: true })], expectedBarDate: "2026-11-23", vix: 24, vixChangePct: 0 } } as any);
  assert.match(stale.oneLiner, /2 of 5 inputs/);
  assert.match(stale.oneLiner, /not counted: spy weekly change \(bars stop at Nov 20\)/);
  assert.doesNotMatch(stale.oneLiner, /-8\.56/);
  const current = synthesizeVerdict({ ...base, crossAsset: { rows: [spyRow({ barDate: "2026-11-23", stale: false })], expectedBarDate: "2026-11-23", vix: 24, vixChangePct: 0 } } as any);
  assert.match(current.oneLiner, /3 of 5 inputs/);
  assert.match(current.oneLiner, /spy 5 sessions to Nov 23 -8\.56%/);
  assert.equal(stale.verdict, "lean bear");
  assert.equal(current.verdict, "strong bear");
});

test("the as-of line names the close and the rows that are older", () => {
  assert.equal(shortDate("2026-11-23"), "Nov 23");
  assert.equal(shortDate("soon"), "soon");
  assert.equal(closesThroughLine("2026-11-23", [{ symbol: "SPY", barDate: "2026-11-23", stale: false }]), "Closes through Nov 23, the last completed session.");
  assert.equal(
    closesThroughLine("2026-11-23", [{ symbol: "SPY", barDate: "2026-11-23" }, { symbol: "GLD", barDate: "2026-11-20", stale: true }, { symbol: "TIP", barDate: null }]),
    "Closes through Nov 23, the last completed session. Older: GLD stops at Nov 20. No bars: TIP.",
  );
  assert.equal(closesThroughLine(undefined, []), "");
});
