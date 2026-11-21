import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAlerts, unreadCount, newLoud, announcement, seenOf, laterSeen, validSeen, alertPanelPlace, ALERT_QUIET_MS, type AlertArm, type AlertHit } from "../../shared/alerts";
import { joinHits, type HitRow } from "../../shared/protocols";
import { etWallToEpochMs } from "../../shared/exchangeCalendar";

const T = (hm: number) => etWallToEpochMs("2026-11-20", hm);
const names = { sweep_reclaim: "Sweep under a level and reclaim" };
const arm = (o: Partial<AlertArm> = {}): AlertArm => ({ id: 7, protocol: "sweep_reclaim", armedAt: T(10 * 60 + 55), entry: 7288.4, levelLabel: "prior-day low", levelPrice: 7286, status: "open", ...o });
let rowId = 100;
const hit = (o: Partial<AlertHit> = {}): AlertHit => ({ at: T(11 * 60 + 17), firstAt: T(11 * 60 + 17), count: 1, fromBefore: false, symbol: "$SPX", levelKey: "s1", lastRowId: ++rowId, label: "pivot S1", levelPrice: 7094, direction: "down", watchedBy: [], ...o });

test("a rule arm reads as what happened, with its status; an unknown rule keeps its id", () => {
  const [a] = buildAlerts({ arms: [arm()], hits: [], names });
  assert.deepEqual([a.id, a.kind, a.seq, a.loud, a.title], ["arm-7", "rule_armed", 7, true, "Rule armed: Sweep under a level and reclaim"]);
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

test("index and VIX crossings and rule arms are announced; SPY and QQQ repeats are listed only; newest first", () => {
  const items = buildAlerts({ arms: [arm()], hits: [hit(), hit({ symbol: "SPY", levelPrice: 707.71 }), hit({ symbol: "$VIX", levelPrice: 29.69 }), hit({ symbol: "/ES", levelPrice: 7193 })], names });
  assert.deepEqual(items.filter((i) => i.loud).map((i) => i.title).sort(), ["Rule armed: Sweep under a level and reclaim", "SPX crossed 7,094", "VIX crossed 29.69"]);
  assert.equal(items.length, 5);
  assert.ok(items.every((x, i) => i === 0 || items[i - 1].at >= x.at));
  assert.equal(buildAlerts({ arms: [arm({ armedAt: NaN })], hits: [hit({ levelPrice: NaN })], names }).length, 0, "rows without a time or price are dropped");
});

test("what counts as new is the storage row id: unread, and what is announced on a read", () => {
  const first = buildAlerts({ arms: [arm({ id: 7 })], hits: [hit({ lastRowId: 200 }), hit({ symbol: "SPY", levelKey: "s1", levelPrice: 707.71, lastRowId: 201 })], names });
  assert.deepEqual(seenOf(first), { arm: 7, hit: 201 });
  assert.equal(unreadCount(first, { arm: 0, hit: 0 }), 3);
  assert.equal(unreadCount(first, seenOf(first)), 0);
  assert.deepEqual(newLoud(first, null), [], "the first read after opening is history: nothing is announced");
  const mark = seenOf(first);
  assert.deepEqual(newLoud(first, mark), []);
  // A new index crossing, a new QQQ crossing (listed only), and a rule arm logged in the same minute as the last look.
  const later = buildAlerts({ arms: [arm({ id: 7 }), arm({ id: 8, armedAt: T(11 * 60 + 17) })], hits: [hit({ lastRowId: 200 }), hit({ symbol: "SPY", levelPrice: 707.71, lastRowId: 201 }), hit({ levelKey: "flip", levelPrice: 7046, label: "gamma flip", at: T(13 * 60), firstAt: T(13 * 60), direction: "up", lastRowId: 202 }), hit({ symbol: "QQQ", levelPrice: 634, at: T(13 * 60), firstAt: T(13 * 60), lastRowId: 203 })], names });
  assert.deepEqual(newLoud(later, mark).map((i) => i.title).sort(), ["Rule armed: Sweep under a level and reclaim", "SPX crossed 7,046"]);
  assert.equal(unreadCount(later, mark), 3, "the arm counts although its time equals an item already seen");
  assert.deepEqual(announcement(newLoud(later, mark).filter((i) => i.kind === "level_cross")), { title: "SPX crossed 7,046", text: "Crossed up through 7,046 (gamma flip)." });
  assert.equal(announcement([]), null);
  const four = buildAlerts({ arms: [], hits: [1, 2, 3, 4].map((i) => hit({ levelKey: `k${i}`, levelPrice: 7000 + i * 10, at: T(800 + i), firstAt: T(800 + i) })), names });
  assert.deepEqual(announcement(four), { title: "4 new alerts", text: "SPX crossed 7,040 · SPX crossed 7,030 · SPX crossed 7,020 · and 1 more" });
  assert.deepEqual(laterSeen({ arm: 9, hit: 5 }, { arm: 3, hit: 50 }), { arm: 9, hit: 50 }, "a mark never moves back");
});

test("a long run of crossings at one level is announced once, however the read window slides (the real joinHits)", () => {
  // SPX crosses one level every minute for 400 minutes; the log is read 300 rows at a time, as the server reads it.
  const all: HitRow[] = Array.from({ length: 400 }, (_, i) => ({ id: 1000 + i, at: T(570) + i * 60_000, symbol: "$SPX", levelKey: "s1", label: "pivot S1", levelPrice: 7094, direction: i % 2 ? "up" : "down", price: 7094 }));
  const readAt = (n: number) => {
    const rows = all.slice(0, n).slice(-300);
    const cut = n > 300;
    const lines = joinHits(rows, undefined, cut ? rows[0].at : null);
    return buildAlerts({ arms: [], names, hits: lines.map((h) => ({ at: h.at, firstAt: h.firstAt, count: h.count, fromBefore: h.fromBefore, symbol: h.symbol, levelKey: h.levelKey, lastRowId: h.lastId ?? 0, label: h.label, levelPrice: h.levelPrice, direction: h.direction, watchedBy: [] })) });
  };
  let prev = seenOf(readAt(5));
  const said: Record<string, number> = {};
  const announcedAt: number[] = [];
  for (let n = 6; n <= 400; n++) {
    const items = readAt(n);
    assert.equal(items.length, 1);
    const fresh = newLoud(items, prev, said);
    prev = laterSeen(prev, seenOf(items));
    for (const f of fresh) { said[f.subject] = f.at; announcedAt.push(f.at); }
  }
  // Once when it is first new, then at most once per quiet period while it goes on: never once a minute.
  assert.ok(announcedAt.length >= 1 && announcedAt.length <= Math.ceil((395 * 60_000) / ALERT_QUIET_MS) + 1, `announced ${announcedAt.length} times`);
  assert.ok(announcedAt.every((t, i) => i === 0 || t - announcedAt[i - 1] >= ALERT_QUIET_MS));
  // The line's own first time and "from before" mark did move as the window slid: identity must not rest on them.
  assert.notEqual(readAt(350)[0].text, readAt(399)[0].text);
  assert.equal(readAt(350)[0].subject, readAt(399)[0].subject);
});

test("an item that leaves the list and comes back is not new; a mark from a reset log is dropped", () => {
  const a = hit({ lastRowId: 300 });
  const b = hit({ levelKey: "flip", levelPrice: 7046, lastRowId: 301, at: T(12 * 60), firstAt: T(12 * 60) });
  let prev = seenOf(buildAlerts({ arms: [], hits: [a, b], names }));
  prev = laterSeen(prev, seenOf(buildAlerts({ arms: [], hits: [b], names })));
  assert.deepEqual(newLoud(buildAlerts({ arms: [], hits: [a, b], names }), prev), []);
  const items = buildAlerts({ arms: [arm({ id: 2 })], hits: [hit({ lastRowId: 4 })], names });
  assert.deepEqual(validSeen({ arm: 900, hit: 5000 }, items), { arm: 0, hit: 0 });
  assert.deepEqual(validSeen({ arm: 2, hit: 3 }, items), { arm: 2, hit: 3 });
  assert.deepEqual(validSeen({ arm: 900, hit: 5000 }, []), { arm: 900, hit: 5000 }, "an empty read proves nothing");
});

test("the panel stays on the screen at every width", () => {
  // On a phone the header's last control is settings (44 px) with an 8 px gap and a 12 px page margin, so the bell's right edge is 64 px in.
  for (const vw of [320, 375, 393, 430, 443, 640]) {
    const p = alertPanelPlace({ bottom: 56, right: vw - 64 }, vw);
    const left = vw - p.right - p.width;
    assert.ok(left >= 12, `left edge ${left} at ${vw}`);
    assert.ok(p.right >= 12 && p.width <= 380 && p.width <= vw - 24, `${vw}: ${JSON.stringify(p)}`);
  }
  assert.deepEqual(alertPanelPlace({ bottom: 56, right: 311 }, 375), { top: 64, right: 12, width: 351 }, "a phone: the full width between the margins");
  assert.deepEqual(alertPanelPlace({ bottom: 40, right: 1300 }, 1440), { top: 48, right: 140, width: 380 }, "desktop: right edge on the bell");
  assert.deepEqual(alertPanelPlace({ bottom: 40, right: 1436 }, 1440), { top: 48, right: 12, width: 380 }, "a bell at the very edge keeps the margin");
  assert.equal(alertPanelPlace({ bottom: 40, right: 100 }, 1440).right, 1048, "a bell far to the left: the panel moves right until it fits");
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
  assert.match(bell, /prev\.current = prev\.current \? laterSeen\(prev\.current, now\) : now;/, "the mark only moves forward");
  assert.match(bell, /createPortal\(/, "the panel is drawn outside the header's layer");
  assert.match(bell, /setPlace\(alertPanelPlace\(r, window\.innerWidth\)\)/, "and placed so it stays on the screen");
  assert.match(bell, /the level watch is not running, so nothing is being logged/);
  const dash = readFileSync("client/src/pages/dashboard.tsx", "utf8");
  assert.match(dash, /className="hidden sm:flex shrink-0[^"]*"\s+data-testid="link-method"/, "the method link gives way on phones so every header control keeps its full tap size");
  assert.match(readFileSync("client/src/components/SchwabSettings.tsx", "utf8"), /settings-link-method/, "and stays reachable from Settings");
  assert.match(readFileSync("client/src/pages/dashboard.tsx", "utf8"), /<AlertBell \/>/);
});
