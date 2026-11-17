// Practitioner review 2026-11-17, options side: O2 (entry basis), O3 (closed list), O4 (P/C baseline), O5 (rounding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cumulativeAt, pcrReadAtClock, FULL_DAY_MIN_MINUTE } from "../../server/pcrHistory";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("O4: outside the session each stored day's last point is its full-day value; a day that stopped early is not", () => {
  const full = [{ minute: 100, putVol: 10, callVol: 20 }, { minute: 390, putVol: 50, callVol: 60 }];
  const stopped = [{ minute: 60, putVol: 5, callVol: 5 }, { minute: 150, putVol: 9, callVol: 9 }];
  assert.deepEqual(cumulativeAt(full, Infinity), { putVol: 50, callVol: 60 });
  assert.equal(cumulativeAt(stopped, Infinity), null);
  assert.equal(cumulativeAt(full, 24 * 60), null, "the old out-of-session minute matched no stored point");
  assert.equal(FULL_DAY_MIN_MINUTE, 375);
  // A half day (210 minutes) counts when the caller passes that date's own figure; a normal day that stopped at 200 does not.
  const half = [{ minute: 205, putVol: 7, callVol: 8 }];
  assert.deepEqual(cumulativeAt(half, Infinity, 195), { putVol: 7, callVol: 8 });
  assert.equal(cumulativeAt(half, Infinity), null);
  assert.equal(cumulativeAt([{ minute: 200, putVol: 1, callVol: 1 }], Infinity, 375), null);
  // In session the same-clock interpolation is unchanged.
  assert.deepEqual(cumulativeAt(full, 100), { putVol: 10, callVol: 20 });
  const sessions = Array.from({ length: 25 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, points: [{ minute: 390, putVol: 100 + i, callVol: 100 }] }));
  const r = pcrReadAtClock({ putVol: 120, callVol: 100 }, Infinity, sessions, { today: "2026-11-17" });
  assert.notEqual(r.zone, "insufficient_history");
  assert.equal(r.sessionsStored, 25);
  // Stored but not usable at this clock time is said, not shown as "0 recorded".
  const early = sessions.map((s) => ({ date: s.date, points: [{ minute: 60, putVol: 10, callVol: 10 }] }));
  const e = pcrReadAtClock({ putVol: 120, callVol: 100 }, 200, early, { today: "2026-11-17" });
  assert.equal(e.zone, "insufficient_history"); assert.equal(e.n, 0);
  assert.match(e.reason ?? "", /25 sessions are stored, 0 have a reading at or after this clock time/);
  const f = read("server/flow.ts");
  assert.match(f, /const minute = onSessionDay \? at!\.minute : Infinity;/);
  // Outside the session the last session is the value being read, so it is not in its own baseline; full day is per date.
  assert.match(f, /const baseline = onSessionDay \? stored : stored\.filter\(\(s\) => s\.date !== lastSession\);/);
  assert.match(f, /lastSession = prevTradingDay\(today\);/);
  assert.match(f, /return o != null && c != null \? \(c - o\) \/ 60_000 - 15 : Infinity;\s*\} catch \{ return Infinity; \}/);
  const out = pcrReadAtClock({ putVol: 120, callVol: 100 }, Infinity, early, { today: "2026-11-17" });
  assert.match(out.reason ?? "", /a reading near its close/);
  assert.match(read("server/routes.ts"), /try \{ startPcrRecorder\(\); \}/);
});

test("O2: a whale position's entry mark is the quote mid at detection, the same moment as its entry ask", () => {
  const w = read("server/whaleFollowThrough.ts");
  assert.match(w, /const entryMark = Number\.isFinite\(hb\) && Number\.isFinite\(ha\) && hb >= 0 && ha > 0 && ha >= hb \? \(hb \+ ha\) \/ 2 : avgTraded;/);
  assert.match(w, /avgTraded,/);
  // Arithmetic the row must now satisfy: bought at the ask and sold at the bid cannot beat mid to mid.
  const bid0 = 3.2, ask0 = 3.3, bid1 = 4.95, ask1 = 5.05;
  const mid = ((bid1 + ask1) / 2 - (bid0 + ask0) / 2) / ((bid0 + ask0) / 2);
  const askToBid = (bid1 - ask0) / ask0;
  assert.ok(askToBid < mid);
});

test("O3 / O5: the closed list asks for expired positions too; flow volumes are rounded with their sign", () => {
  const wp = read("client/src/components/WhaleFlowPanel.tsx");
  assert.match(wp, /\/api\/flow\/followups\?status=TERMINAL&includeExpired=true/);
  assert.match(wp, /\(p\) => p\.status === "CLOSED" \|\| p\.status === "EXPIRED",/);
  assert.doesNotMatch(wp, /Filter out EXPIRED entirely/);
  const src = read("client/src/components/FlowPanel.tsx");
  const body = /function fmtVol\(v: number\): string \{([\s\S]*?)\n\}/.exec(src)![1];
  const fmtVol = new Function("v", body) as (v: number) => string;
  assert.equal(fmtVol(-5107.666666666667), "\u22125.1K");
  assert.equal(fmtVol(-15323), "\u221215K");
  assert.equal(fmtVol(2_700_000), "2.7M");
  assert.equal(fmtVol(999.6), "1.0K");
  assert.equal(fmtVol(-0.4), "0");
  assert.equal(fmtVol(NaN), "n/a");
});
