// tests/quant/event-replay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventReactions, summarizeReactions } from "../../shared/eventReplay";
import { MACRO_EVENTS, MACRO_COVERAGE, dailyBarEtDate, minutesToNextTier1 } from "../../shared/macroCalendar";

const bars = [
  { date: "2026-09-03", open: 7000, high: 7020, low: 6980, close: 7000 },
  { date: "2026-09-04", open: 7030, high: 7090, low: 7010, close: 7070 }, // NFP day: +1%
  { date: "2026-09-08", open: 7060, high: 7080, low: 7040, close: 7056 }, // next session: -0.2%
  { date: "2026-09-15", open: 7100, high: 7110, low: 7090, close: 7100 },
  { date: "2026-09-16", open: 7100, high: 7150, low: 7030, close: 7050 }, // FOMC day: -0.7%
];

test("eventReactions: event-session move, gap, range and next day from daily bars; missing bars and future dates are states", () => {
  const rows = eventReactions(bars, MACRO_EVENTS, "2026-10-20");
  const nfp = rows.find((r) => r.date === "2026-09-04")!;
  assert.equal(nfp.state, "ok");
  assert.equal(nfp.closeMovePct, 0.01);
  assert.equal(nfp.gapPct, Math.round((30 / 7000) * 1e4) / 1e4);
  assert.equal(nfp.rangePct, Math.round((80 / 7000) * 1e4) / 1e4);
  assert.equal(nfp.nextDayPct, Math.round((-14 / 7070) * 1e4) / 1e4);
  const fomc = rows.find((r) => r.date === "2026-09-16")!;
  assert.equal(fomc.state, "partial", "no next session in the fixture");
  assert.equal(fomc.closeMovePct, Math.round((-50 / 7100) * 1e4) / 1e4);
  assert.equal(rows.find((r) => r.date === "2026-08-07")!.state, "no_bar");
  assert.equal(rows.find((r) => r.date === "2026-12-09")!.state, "future");
  assert.equal(rows[0].date, "2026-12-23", "newest first");
});

test("summarizeReactions counts only priced events; coverage note names what is not loaded", () => {
  const s = summarizeReactions(eventReactions(bars, MACRO_EVENTS, "2026-10-20"));
  const nfp = s.find((x) => x.name === "NFP")!;
  assert.equal(nfp.n, 1);
  assert.equal(nfp.up, 1);
  assert.equal(nfp.largestClosePct?.date, "2026-09-04");
  assert.match(MACRO_COVERAGE.CPI, /November 2026 onward/);
  assert.equal(MACRO_EVENTS.filter((e) => e.name === "NFP").length, 12);
});

test("daily bars dated by their noon: a midnight-UTC or 05:00-UTC bar start lands on the same ET date; last-event minutes reported", () => {
  const etDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const midnightUtc = Date.UTC(2026, 8, 4, 0, 0);   // 2026-09-04T00:00Z = 2026-09-03 20:00 ET
  const fiveUtc = Date.UTC(2026, 8, 4, 5, 0);       // 2026-09-04T05:00Z = 2026-09-04 01:00 ET
  assert.equal(etDate(midnightUtc), "2026-09-03", "naive ET date of a midnight-UTC bar is the prior day");
  assert.equal(dailyBarEtDate(midnightUtc, etDate), "2026-09-04");
  assert.equal(dailyBarEtDate(fiveUtc, etDate), "2026-09-04");
  const toMs = (ymd: string, h: number, m: number) => Date.parse(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`);
  const r = minutesToNextTier1(toMs("2026-09-16", 14, 30), toMs, MACRO_EVENTS);
  assert.equal(r.last?.name, "FOMC");
  assert.equal(r.minutesSinceLast, 30);
});
