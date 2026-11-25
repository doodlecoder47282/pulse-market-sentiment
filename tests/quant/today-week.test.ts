// The week's levels: which expiry is read, and the wording for it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { weekLastTradingDay } from "../../shared/exchangeCalendar";
import { pickExpiryKey, weekDteWindow } from "../../server/odteForward";
import { todayPlan, expiryDayLabel } from "../../shared/todayPlan";

test("the last trading day of a week: Friday, or earlier when Friday is a holiday", () => {
  assert.equal(weekLastTradingDay("2026-11-24"), "2026-11-27", "Thanksgiving week: Friday is a half day and still trades");
  assert.equal(weekLastTradingDay("2026-11-27"), "2026-11-27");
  assert.equal(weekLastTradingDay("2026-11-28"), null, "a Saturday holds no later trading day in its week");
  assert.equal(weekLastTradingDay("2026-04-01"), "2026-04-02", "Good Friday 2026-04-03 is closed");
});

test("the week pick is the last unsettled expiry of the nearest expiry's week", () => {
  const keys = ["2026-11-25:1", "2026-11-27:3", "2026-11-30:6", "2026-12-01:7"];
  assert.deepEqual(pickExpiryKey(keys, "nearest"), { key: "2026-11-25:1", weekEnd: null, sameAsNearest: true });
  assert.deepEqual(pickExpiryKey(keys, "week"), { key: "2026-11-27:3", weekEnd: "2026-11-27", sameAsNearest: false });
  // Friday evening: the nearest unsettled expiry is Monday's, so the week is next week.
  assert.deepEqual(pickExpiryKey(["2026-11-30:3", "2026-12-02:5", "2026-12-04:7"], "week"), { key: "2026-12-04:7", weekEnd: "2026-12-04", sameAsNearest: false });
  // The week's last expiry is the nearest one: nothing new to show.
  assert.deepEqual(pickExpiryKey(["2026-11-27:0", "2026-11-30:3"], "week"), { key: "2026-11-27:0", weekEnd: "2026-11-27", sameAsNearest: true });
});

test("the chain window reaches the week's last expiry", () => {
  assert.equal(weekDteWindow(Date.parse("2026-11-24T18:00:00Z")), 4, "Tuesday 1 PM ET to Friday, plus one");
  assert.equal(weekDteWindow(Date.parse("2026-11-28T15:00:00Z")), 7, "Saturday to the following Friday, plus one");
  assert.ok(weekDteWindow(Date.parse("2026-11-27T23:00:00Z")) >= 7, "Friday evening reaches next Friday");
});

test("the week's wording names the expiry day and makes no next-session statement", () => {
  assert.equal(expiryDayLabel("2026-11-27"), "Fri Nov 27");
  const p = todayPlan({ symbol: "$SPX", spot: 7201, sessionState: "closed", dataState: "stale_session", atSpot: "short", straddle: 140, low: 7061, high: 7341, above: 7300, below: 7100, flip: 7250, weekExpiryLabel: "Fri Nov 27" });
  assert.equal(p.headline, "For the options that expire Fri Nov 27 alone, the map has dealer hedging leaning with moves at this price (bigger swings in this model). Options are priced for a move of about 140 points either way by the close on Fri Nov 27: roughly 7,061 to 7,341.");
  assert.doesNotMatch(p.headline, /are the setup/, "one expiry is not the whole market's setup");
  assert.doesNotMatch(p.headline, /next session|Market closed/);
});

test("wiring: one route option, the same compose rules, shown on the card for the index", () => {
  const routes = readFileSync("server/routes.ts", "utf8");
  assert.match(routes, /if \(String\(req\.query\.expiry \|\| ""\) === "week"\) \{/);
  assert.match(routes, /composeOdteMap\(b, \{ edition: editionFromEnv\(\) \}\)/);
  const fwd = readFileSync("server/odteForward.ts", "utf8");
  assert.match(fwd, /const takeQuote = isPm \|\| !rowQuotePm\.get\(styleKey\);/, "a row's quote comes from one settlement style");
  assert.match(readFileSync("client/src/components/TodayCard.tsx", "utf8"), /\{priced && symbol === "\$SPX" && <TodayWeek symbol=\{symbol\} active=\{active\} \/>\}/);
});
