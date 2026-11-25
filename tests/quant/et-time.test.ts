// Times read the normal way in Eastern time on the Signals flow panels.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { clock12, etTime, etTimeLabel } from "../../shared/etTime";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("a time is h:mm AM/PM in New York, never 24-hour", () => {
  assert.equal(etTime(Date.parse("2026-11-24T21:54:10Z")), "4:54 PM");
  assert.equal(etTime(Date.parse("2026-11-24T21:54:10Z"), { seconds: true }), "4:54:10 PM");
  assert.equal(etTime(Date.parse("2026-11-24T14:30:00Z")), "9:30 AM");
  assert.equal(etTime(Date.parse("2026-11-24T05:05:00Z")), "12:05 AM");
  assert.equal(etTime(Date.parse("2026-07-01T17:00:00Z")), "1:00 PM", "daylight time");
  assert.equal(etTimeLabel(Date.parse("2026-11-24T21:54:10Z")), "4:54 PM ET");
  assert.equal(etTime(null), "");
  assert.equal(etTimeLabel(Number.NaN), "");
});

test("the flow panels and the flow chart use it", () => {
  for (const f of ["client/src/components/FlowAlertsPanel.tsx", "client/src/components/FlowPanel.tsx", "client/src/components/UnusualFlowPanel.tsx"]) {
    const src = read(f);
    assert.match(src, /from "@shared\/etTime"/, f);
    assert.doesNotMatch(src, /hour12: false/, f);
    assert.doesNotMatch(src, /toLocaleTimeString\(\)/, `${f}: a bare toLocaleTimeString is the viewer's own time zone`);
  }
  assert.match(read("server/flow.ts"), /function getTimeLabel\(epochSecs: number\): string \{\s*return etTime\(epochSecs \* 1000\);/);
});

test("after the close the top card reads last session, the stream row says why it is empty, labels are 13px on a computer", () => {
  assert.match(read("client/src/components/TodayCard.tsx"), /m\.dataState === "stale_session" \? "last_session" : m\.dataState === "stale" \? "stale"/);
  assert.match(read("client/src/components/TodayCard.tsx"), /preopenIsLastSession\(m\.session\.state, m\.chainAsOfMs \?\? null, Date\.now\(\)\) \? "last_session" : "ok"/);
  const flow = read("client/src/components/FlowPanel.tsx");
  assert.doesNotMatch(flow, /Schwab stream not connected: not classified/);
  assert.match(flow, /Schwab's live trade feed is not connected \(Settings says why\)/);
  assert.doesNotMatch(flow, /switched off for this app/, "the same state covers a dropped connection, so the line does not name one cause");
  assert.match(read("client/src/index.css"), /\.batcave-shell \[class~="text-\[10px\]"\],\s*\.batcave-shell \[class~="text-\[11px\]"\] \{ font-size: 13px;/);
});

test("no screen formats a clock time on its own: the shared helper is the one place", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []; });
  // Allowed: hour-of-day arithmetic (not shown) and chart libraries that need their own formatter with hour12 true.
  const allowed = /pollInterval\.ts$|MLProjectionPanel\.tsx$/;
  for (const f of walk("client/src")) {
    const src = readFileSync(f, "utf8");
    if (!allowed.test(f)) assert.doesNotMatch(src, /hour12: false|hourCycle: "h23"/, f);
    assert.doesNotMatch(src, /new Date\([^)\n]*\)\.toLocale(Time)?String\(\)/, `${f}: a bare toLocaleString is the viewer's own time zone`);
  }
});

test("the helper takes an ISO string as well as milliseconds", () => {
  assert.equal(etTime("2026-11-25T18:07:00Z"), "1:07 PM");
  assert.equal(etTime("not a time"), "");
});

test("a stored wall-clock time reads the normal way", () => {
  assert.equal(clock12("08:30"), "8:30 AM");
  assert.equal(clock12("14:00"), "2:00 PM");
  assert.equal(clock12("12:00"), "12:00 PM");
  assert.equal(clock12("00:05"), "12:05 AM");
  assert.equal(clock12("at the open"), "at the open");
});
