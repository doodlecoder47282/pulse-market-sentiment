import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAlerts, unreadCount, newLoud, announcement, ALERT_FEED_MAX, type AlertArm, type AlertHit } from "../../shared/alerts";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";

const T = (hm: number) => etWallToEpochMs("2026-11-20", hm);
const names = { sweep_reclaim: "Sweep under a level and reclaim" };
const arm = (o: Partial<AlertArm> = {}): AlertArm => ({ id: 7, protocol: "sweep_reclaim", armedAt: T(10 * 60 + 55), entry: 7288.4, levelLabel: "prior-day low", levelPrice: 7286, status: "open", ...o });
const hit = (o: Partial<AlertHit> = {}): AlertHit => ({ at: T(11 * 60 + 17), firstAt: T(11 * 60 + 17), count: 1, fromBefore: false, symbol: "$SPX", label: "pivot S1", levelPrice: 7094, direction: "down", watchedBy: [], ...o });

test("a rule arm reads as what happened, with its status; an unknown rule keeps its id", () => {
  const [a] = buildAlerts({ arms: [arm()], hits: [], names });
  assert.deepEqual([a.id, a.kind, a.loud, a.title], ["arm-7", "rule_armed", true, "Rule armed: Sweep under a level and reclaim"]);
  assert.equal(a.text, "All of its conditions were met at 10:55 ET with the index at 7,288, at 7,286 (prior-day low). Status: still open.");
  assert.match(buildAlerts({ arms: [arm({ status: "expected" })], hits: [], names })[0].text, /Status: since reached the rule's outcome price\.$/);
  const bare = buildAlerts({ arms: [arm({ protocol: "x", entry: null, status: "?" })], hits: [], names })[0];
  assert.equal(bare.title, "Rule armed: x");
  assert.equal(bare.text, "All of its conditions were met at 10:55 ET.");
});

test("a crossing: once, many times, and from before the log", () => {
  const one = buildAlerts({ arms: [], hits: [hit()], names })[0];
  assert.equal(one.title, "SPX crossed 7,094");
  assert.equal(one.text, "Crossed down through 7,094 (pivot S1).");
  const many = buildAlerts({ arms: [], hits: [hit({ count: 3, firstAt: T(11 * 60 + 12), direction: "up", watchedBy: ["Sweep under a level and reclaim"] })], names })[0];
  assert.equal(many.text, "Crossed 7,094 (pivot S1) 3 times from 11:12, last up. Watched by: Sweep under a level and reclaim.");
  const before = buildAlerts({ arms: [], hits: [hit({ count: 4, fromBefore: true, firstAt: T(10 * 60) })], names })[0];
  assert.match(before.text, /at least 4 times, from before 10:00, last down\.$/);
  assert.match(buildAlerts({ arms: [], hits: [hit({ fromBefore: true })], names })[0].text, /earlier crossings may precede the log/);
  assert.equal(buildAlerts({ arms: [], hits: [hit({ symbol: "$VIX", levelPrice: 29.69, label: "today's open" })], names })[0].title, "VIX crossed 29.69");
});

test("repeat crossings of one level keep one id, so they are announced once", () => {
  const first = buildAlerts({ arms: [], hits: [hit()], names })[0];
  const again = buildAlerts({ arms: [], hits: [hit({ count: 2, at: T(11 * 60 + 25) })], names })[0];
  assert.equal(first.id, again.id);
  assert.notEqual(first.id, buildAlerts({ arms: [], hits: [hit({ firstAt: T(13 * 60), at: T(13 * 60) })], names })[0].id, "a later, separate run is a new alert");
});

test("index and VIX crossings and rule arms are announced; SPY and QQQ repeats are listed only", () => {
  const items = buildAlerts({ arms: [arm()], hits: [hit(), hit({ symbol: "SPY", levelPrice: 707.71 }), hit({ symbol: "$VIX", levelPrice: 29.69 }), hit({ symbol: "/ES", levelPrice: 7193 })], names });
  assert.deepEqual(items.filter((i) => i.loud).map((i) => i.title).sort(), ["Rule armed: Sweep under a level and reclaim", "SPX crossed 7,094", "VIX crossed 29.69"]);
  assert.equal(items.length, 5);
});

test("newest first, capped, and rows without a time or price are dropped", () => {
  const hits = Array.from({ length: ALERT_FEED_MAX + 10 }, (_, i) => hit({ at: T(600 + i), firstAt: T(600 + i), levelPrice: 7000 + i }));
  const items = buildAlerts({ arms: [arm({ armedAt: T(599) })], hits, names });
  assert.equal(items.length, ALERT_FEED_MAX);
  assert.ok(items.every((x, i) => i === 0 || items[i - 1].at >= x.at));
  assert.equal(buildAlerts({ arms: [arm({ armedAt: NaN })], hits: [hit({ levelPrice: NaN })], names }).length, 0);
});

test("unread count, and what is announced on a new read", () => {
  const items = buildAlerts({ arms: [arm()], hits: [hit(), hit({ symbol: "SPY", levelPrice: 707.71 })], names });
  assert.equal(unreadCount(items, 0), 3);
  assert.equal(unreadCount(items, T(11 * 60)), 2);
  assert.equal(unreadCount(items, T(12 * 60)), 0);
  assert.deepEqual(newLoud(items, null), [], "the first read after opening is history: nothing is announced");
  const known = new Set(items.map((i) => i.id));
  assert.deepEqual(newLoud(items, known), []);
  const later = buildAlerts({ arms: [arm()], hits: [hit(), hit({ symbol: "SPY", levelPrice: 707.71 }), hit({ levelPrice: 7046, label: "gamma flip", at: T(13 * 60), firstAt: T(13 * 60), direction: "up" }), hit({ symbol: "QQQ", levelPrice: 634, at: T(13 * 60), firstAt: T(13 * 60) })], names });
  assert.deepEqual(newLoud(later, known).map((i) => i.title), ["SPX crossed 7,046"], "the QQQ row is new but listed only");
  assert.deepEqual(announcement(newLoud(later, known)), { title: "SPX crossed 7,046", text: "Crossed up through 7,046 (gamma flip)." });
  assert.equal(announcement([]), null);
  const four = buildAlerts({ arms: [], hits: [1, 2, 3, 4].map((i) => hit({ levelPrice: 7000 + i * 10, at: T(800 + i), firstAt: T(800 + i) })), names });
  assert.deepEqual(announcement(four), { title: "4 new alerts", text: "SPX crossed 7,040 · SPX crossed 7,030 · SPX crossed 7,020 · and 1 more" });
});

test("wiring: the route builds from the desk's own log, the bell is in the header, and a failed read is not shown as no alerts", () => {
  const routes = readFileSync("server/routes.ts", "utf8");
  assert.match(routes, /app\.get\("\/api\/alerts"/);
  assert.match(routes, /hits: log\.hits,/);
  assert.match(routes, /const log = getLoggedEvents\(\);/, "the bell's poll reads the stored logs only");
  const eng = readFileSync("server/protocolEngine.ts", "utf8");
  const fn = eng.slice(eng.indexOf("export function getLoggedEvents"), eng.indexOf("export async function getProtocolLog"));
  assert.doesNotMatch(fn, /contextNow|evalProtocols|await /, "no evaluation and no market read");
  const bell = readFileSync("client/src/components/AlertBell.tsx", "utf8");
  assert.match(bell, /refetchIntervalInBackground: true/);
  assert.match(bell, /Not read, so this is not a list of no alerts\./);
  assert.match(bell, /known\.current = new Set/);
  assert.match(readFileSync("client/src/pages/dashboard.tsx", "utf8"), /<AlertBell \/>/);
});
