import { test } from "node:test";
import assert from "node:assert/strict";
import { etEpochMs } from "../server/etTime";
import { equityDay, previousSessions, referenceSessions, scheduledSession, shiftSessionDate, easternDate } from "../server/equityCalendar";
import { EquityScheduleSchema } from "../shared/equityCalendar";
import { buildStockTradeBrief } from "../server/tradeBrief";
import { TRADE_BRIEF_INSTRUMENTS, TradeBriefSchema } from "../shared/tradeBrief";
import { getSourceContract } from "../shared/evidencePolicy";

const stock = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "AAPL")!;
const ok = (value: unknown) => ({ state: "ok" as const, value });
function candle(date: string) {
  return { datetime: etEpochMs(date, 0, 0), open: 100, high: 110, low: 90, close: 100, volume: 2000 };
}
function build(date: string, horizon: "intraday" | "swing" = "intraday",
  dates = previousSessions(date, 30) ?? [], hh = 11, mm = 0, ss = 0, extra = [] as ReturnType<typeof candle>[]) {
  const now = etEpochMs(date, hh, mm, ss);
  return buildStockTradeBrief(stock, horizon, {
    quote: ok({ AAPL: { symbol: "AAPL", assetMainType: "EQUITY", realtime: true,
      quote: { lastPrice: 105, tradeTime: now - 1000, quoteTime: now - 500, totalVolume: 1000 } } }),
    history: ok({ symbol: "AAPL", candles: [...dates.map(candle), ...extra] }), macro: ok([]),
  }, now);
}
const levelStatus = (b: ReturnType<typeof build>) => b.source_statuses.find(s => s.category === "levels")!;
const value = (b: ReturnType<typeof build>, id: string) => b.evidence.find(e => e.id === id)?.value;

test("all ten published 2026 holidays and the two early closes are explicit", () => {
  for (const date of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) {
    assert.equal(equityDay(date).kind, "holiday"); assert.equal(equityDay(date).open, null);
  }
  for (const date of ["2026-11-27", "2026-12-24"]) {
    assert.equal(equityDay(date).kind, "early_close");
    assert.equal(equityDay(date).minutes, 210);
    assert.equal(equityDay(date).close, etEpochMs(date, 13, 0));
  }
  assert.equal(equityDay("2026-07-02").kind, "regular"); // no invented July 2 early close
  assert.equal(equityDay("2026-10-12").kind, "regular"); // not all federal holidays are equity closures
  assert.equal(equityDay("2026-11-11").kind, "regular");
});

test("DST follows Eastern Time rather than fixed UTC offsets", () => {
  assert.equal(new Date(equityDay("2026-03-06").open!).toISOString(), "2026-03-06T14:30:00.000Z");
  assert.equal(new Date(equityDay("2026-03-09").open!).toISOString(), "2026-03-09T13:30:00.000Z");
  assert.equal(new Date(equityDay("2026-10-30").close!).toISOString(), "2026-10-30T20:00:00.000Z");
  assert.equal(new Date(equityDay("2026-11-02").close!).toISOString(), "2026-11-02T21:00:00.000Z");
  assert.equal(easternDate(Date.parse("2026-10-02T02:00:00Z")), "2026-10-01");
});

test("intraday prior-session selection crosses holiday/weekend boundaries correctly", () => {
  assert.deepEqual(referenceSessions("2026-09-08", "intraday"), ["2026-09-04"]);
  assert.deepEqual(referenceSessions("2026-04-06", "intraday"), ["2026-04-02"]);
  assert.deepEqual(referenceSessions("2026-07-06", "intraday"), ["2026-07-02"]);
  assert.deepEqual(referenceSessions("2026-12-28", "intraday"), ["2026-12-24"]);
  assert.deepEqual(referenceSessions("2026-09-06", "intraday"), ["2026-09-04"]);
});

test("weekly structure uses every scheduled session, not five assumed weekdays", () => {
  assert.deepEqual(referenceSessions("2026-09-14", "swing"), ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]);
  assert.deepEqual(referenceSessions("2026-11-30", "swing"), ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  assert.deepEqual(referenceSessions("2026-12-28", "swing"), ["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24"]);
});

test("unknown years and malformed dates fail closed with no weekday fallback", () => {
  for (const date of ["2025-12-31", "2027-01-04", "2026-02-30", "not-a-date"]) assert.equal(equityDay(date).kind, "unknown");
  assert.equal(previousSessions("2026-01-02", 1), null);
  assert.equal(referenceSessions("2027-01-04", "swing"), null);
  assert.equal(previousSessions("2026-10-01", 61), null);
  assert.throws(() => shiftSessionDate("2026-02-30", -1));
  const b = build("2027-01-04", "swing", ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"]);
  assert.equal(b.levels.length, 0);
  assert.equal(levelStatus(b).status, "unsupported");
  assert.equal(value(b, "atr14"), undefined);
  assert.equal(b.session.schedule?.coverage, "unsupported");
});

test("scheduled phases and next boundary are exact, including shortened sessions", () => {
  const date = "2026-11-27";
  const before = scheduledSession(etEpochMs(date, 9, 29, 59));
  assert.equal(before.schedule.phase, "before_core");
  assert.equal(Date.parse(before.schedule.next_boundary_at), etEpochMs(date, 9, 30));
  assert.equal(scheduledSession(etEpochMs(date, 9, 30)).schedule.phase, "core_window");
  const nearClose = scheduledSession(etEpochMs(date, 12, 59, 59));
  assert.equal(Date.parse(nearClose.schedule.next_boundary_at), etEpochMs(date, 13, 0));
  assert.equal(scheduledSession(etEpochMs(date, 13, 0)).schedule.phase, "after_core");
  assert.equal(scheduledSession(etEpochMs("2026-09-07", 11, 0)).schedule.phase, "closed");
});

test("calendar source metadata does not claim live status, legal approval or point-in-time validity", () => {
  const { schedule } = scheduledSession(etEpochMs("2026-09-30", 11, 0));
  assert.ok(EquityScheduleSchema.safeParse(schedule).success);
  assert.equal(schedule.live_status_verified, false); assert.equal(schedule.point_in_time_safe, false);
  assert.equal(schedule.source_urls.length, 2);
  for (const id of ["nyse.core-calendar", "nasdaq.core-calendar"]) {
    assert.equal(getSourceContract(id)?.integration, "reference_only");
    assert.equal(getSourceContract(id)?.publicUse, "blocked");
  }
});

test("realistic Labor Day gap now yields ATR14 and baseline volume from 20 scheduled sessions", () => {
  const b = build("2026-09-30");
  assert.ok(TradeBriefSchema.safeParse(b).success);
  assert.equal(value(b, "atr14"), 20);
  assert.equal(value(b, "volume-prior20-mean"), 2000);
  assert.equal(value(b, "volume-session-vs-prior20"), 0.5);
  assert.ok(!b.evidence.some(e => e.id.includes("2026-09-07")));
  assert.deepEqual(b.evidence_review?.excluded, []);
  assert.equal(b.risk.basis, "withheld");
});

test("the first session after a holiday has the actual prior-session references", () => {
  for (const [date, prior] of [["2026-09-08", "2026-09-04"], ["2026-04-06", "2026-04-02"], ["2026-07-06", "2026-07-02"]]) {
    const b = build(date);
    assert.equal(b.levels.length, 3); assert.ok(b.levels[0].period.includes(prior));
  }
});

test("holiday-week pivots recover without accepting a missing scheduled bar", () => {
  const b = build("2026-09-14", "swing");
  assert.deepEqual(b.levels.map(l => l.value), [90, 100, 110]);
  assert.ok(b.levels[0].period.includes("4 scheduled sessions"));
  const gap = build("2026-09-14", "swing", previousSessions("2026-09-14", 30)!.filter(d => d !== "2026-09-10"));
  assert.equal(gap.levels.length, 0); assert.equal(levelStatus(gap).status, "stale");
  assert.equal(value(gap, "atr14"), undefined); assert.equal(value(gap, "volume-session-vs-prior20"), undefined);
});

test("a provider bar on a published holiday is rejected, never used to fill the window", () => {
  const b = build("2026-09-30", "swing", previousSessions("2026-09-30", 30)!, 11, 0, 0, [candle("2026-09-07")]);
  assert.equal(b.levels.length, 0); assert.equal(value(b, "atr14"), undefined);
  assert.equal(levelStatus(b).status, "missing");
});

test("early-close ATR is retained with disclosure; full-day volume ratio is suppressed", () => {
  const today = build("2026-11-27");
  assert.equal(value(today, "atr14"), 20);
  assert.equal(value(today, "volume-session-vs-prior20"), undefined);
  const baseline = build("2026-11-30");
  assert.equal(value(baseline, "atr14"), 20);
  assert.equal(value(baseline, "volume-prior20-mean"), undefined);
  assert.ok(baseline.context_items?.find(c => c.id === "factor-atr")?.text.includes("shortened-session"));
  assert.ok(baseline.source_statuses.find(s => s.category === "volume")?.reason.includes("shortened"));
});

test("snapshot expiry stops exactly at scheduled open and early close", () => {
  const nearOpen = build("2026-11-27", "intraday", undefined, 9, 29, 59);
  assert.equal(Date.parse(nearOpen.expires_at), etEpochMs("2026-11-27", 9, 30));
  const nearClose = build("2026-11-27", "intraday", undefined, 12, 59, 59);
  assert.equal(Date.parse(nearClose.expires_at), etEpochMs("2026-11-27", 13, 0));
});

test("today's daily candle is never treated as completed, even after an early close", () => {
  const extra = { ...candle("2026-11-27"), high: 900, close: 500 };
  const b = build("2026-11-27", "intraday", undefined, 14, 0, 0, [extra]);
  assert.equal(value(b, "atr14"), 20);
  assert.ok(b.levels[0].period.includes("2026-11-25"));
  assert.equal(b.session.schedule?.phase, "after_core");
});
