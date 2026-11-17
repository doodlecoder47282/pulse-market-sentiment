// Audit 2026-11-16, dates and clocks: S5 (news week header), S15 (market status pill), S22 (chart time zone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { etDate, isTradingDay, sessionOpenMs, sessionCloseMs } from "../../shared/exchangeCalendar";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const fn = (src: string, re: RegExp, args: string[], deps: Record<string, unknown> = {}) => {
  const body = re.exec(src)![1];
  return new Function(...Object.keys(deps), ...args, body).bind(null, ...Object.values(deps));
};

test("S15: the status pill follows the exchange calendar: holiday closed, half day closes at 13:00", () => {
  const src = read("client/src/pages/dashboard.tsx");
  const marketStatusAt = fn(src, /export function marketStatusAt\(nowMs: number\): MarketStatus \{([\s\S]*?)\n\}/, ["nowMs"], { etDate, isTradingDay, sessionOpenMs, sessionCloseMs }) as (t: number) => string;
  const at = (iso: string) => Date.parse(iso);
  // Thanksgiving 2026 (Thu 26 Nov), 11:00 ET: closed, though a weekday in regular hours.
  assert.equal(marketStatusAt(at("2026-11-26T16:00:00Z")), "CLOSED");
  // The day after (half day, 13:00 close): open at 12:00 ET, after-hours at 14:00 ET, closed at 17:30 ET.
  assert.equal(marketStatusAt(at("2026-11-27T17:00:00Z")), "OPEN");
  assert.equal(marketStatusAt(at("2026-11-27T19:00:00Z")), "AFTER-HOURS");
  assert.equal(marketStatusAt(at("2026-11-27T22:30:00Z")), "CLOSED");
  // A normal day (Tue 17 Nov 2026, EST): 03:59 closed, 04:00 pre-market, 09:30 open, 16:00 after-hours, 20:00 closed.
  assert.equal(marketStatusAt(at("2026-11-17T08:59:00Z")), "CLOSED");
  assert.equal(marketStatusAt(at("2026-11-17T09:00:00Z")), "PRE-MARKET");
  assert.equal(marketStatusAt(at("2026-11-17T14:30:00Z")), "OPEN");
  assert.equal(marketStatusAt(at("2026-11-17T21:00:00Z")), "AFTER-HOURS");
  assert.equal(marketStatusAt(at("2026-11-18T01:00:00Z")), "CLOSED");
  // Weekend.
  assert.equal(marketStatusAt(at("2026-11-21T17:00:00Z")), "CLOSED");
  assert.match(src, /function getMarketStatus\(\): MarketStatus \{\s*return marketStatusAt\(Date\.now\(\)\);/);
});

test("S5: a news week starts on the ET calendar's Monday and its label prints that Monday", () => {
  const src = read("client/src/components/NewsPanel.tsx");
  const weekStart = fn(src, /export function weekStart\(epoch: number\): number \{([\s\S]*?)\n\}/, ["epoch"]) as (e: number) => number;
  const label = (e: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" }).format(new Date(e * 1000));
  const sec = (iso: string) => Date.parse(iso) / 1000;
  // Wednesday 18 Nov 2026 10:00 ET -> Mon 11/16.
  assert.equal(label(weekStart(sec("2026-11-18T15:00:00Z"))), "Mon, 11/16");
  // Sunday 22 Nov 2026 20:00 ET (Monday 01:00 UTC): still the week of Mon 11/16, not the next one.
  assert.equal(label(weekStart(sec("2026-11-23T01:00:00Z"))), "Mon, 11/16");
  // Monday 23 Nov 2026 00:30 ET -> Mon 11/23.
  assert.equal(label(weekStart(sec("2026-11-23T05:30:00Z"))), "Mon, 11/23");
  // Every day of one ET week maps to the same start; across a DST change too (week of Mon 2 Nov 2026 follows the 1 Nov change).
  const w = weekStart(sec("2026-11-02T15:00:00Z"));
  for (const d of ["2026-11-03T15:00:00Z", "2026-11-06T22:00:00Z", "2026-11-08T23:00:00Z"]) assert.equal(weekStart(sec(d)), w);
  assert.equal(label(weekStart(sec("2026-11-01T15:00:00Z"))), "Mon, 10/26");
});

test("S22: the SVG chart prints New York time and says so", () => {
  const c = read("client/src/components/CandlestickChart.tsx");
  assert.equal((c.match(/timeZone: "America\/New_York"/g) ?? []).length, 3);
  assert.match(c, /timeZone: "America\/New_York" \}\)\} ET/);
});
