// Item 2 of the 2026-11-17 list: name and deployer context from the desk's own pump.fun listener.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normSymbol, foldOutcomes, buildLaunchContext, unreadLaunchContext, SAME_SYMBOL_HOURS } from "../../shared/launchContext";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("symbol key and outcome fold", () => {
  assert.equal(normSymbol(" $BAWSAQ "), "bawsaq");
  assert.equal(normSymbol("Bawsaq"), "bawsaq");
  assert.equal(normSymbol(null), "");
  const o = foldOutcomes([{ outcome: "RUGGED", n: 3 }, { outcome: "HIT_5M", n: 1 }, { outcome: "DOUBLED", n: 1 }, { outcome: "DEAD", n: 2 }, { outcome: "OPEN", n: 1 }, { outcome: "NO_DATA", n: 4 }]);
  assert.deepEqual(o, { logged: 12, won: 2, rugged: 3, dead: 2, open: 1, noData: 4 });
});

test("the text states counts as seen and as lower bounds; an unread context says why and carries no number", () => {
  const c = buildLaunchContext({ sameSymbol24h: 8, deployerPrior: 3, outcomes: { logged: 2, won: 0, rugged: 2, dead: 0, open: 0, noData: 0 }, symbol: "BAWSAQ", now: 1 });
  assert.equal(c.state, "ok");
  assert.match(c.text, /8 other "BAWSAQ" launches seen in the last 24 h/);
  assert.match(c.text, /this deployer launched 3 other coins in 3 days \(the desk logged 2: 2 rugged\)/);
  assert.match(c.text, /lower bounds$/);
  assert.doesNotMatch(c.text, /\b(avoid|buy|sell|scam|safe)\b/i);
  const clean = buildLaunchContext({ sameSymbol24h: 0, deployerPrior: 0, outcomes: null, symbol: "X", now: 1 });
  assert.match(clean.text, /no other "X" launch seen in the last 24 h; no earlier launch by this deployer in 3 days/);
  const u = unreadLaunchContext("the pump.fun listener is off", 5);
  assert.equal(u.state, "unread"); assert.equal(u.sameSymbol24h, null); assert.equal(u.deployerPrior, null);
  assert.match(u.text, /not read: the pump\.fun listener is off/);
});

test("the listener's queries, run against SQLite: same symbol inside 24 h before, same deployer before, one outcome per coin", () => {
  const src = read("server/pumpListener.ts");
  const q = (re: RegExp) => re.exec(src)![1];
  const sameSql = q(/sqlite\.prepare\("(SELECT COUNT\(\*\) AS n FROM pump_launches WHERE symbol_norm = \?[^"]+)"\)/);
  const priorSql = q(/sqlite\.prepare\("(SELECT COUNT\(\*\) AS n FROM pump_launches WHERE deployer = \?[^"]+)"\)/);
  const outSql = q(/sqlite\.prepare\(`(SELECT outcome, COUNT\(\*\) AS n FROM \([\s\S]*?GROUP BY outcome)`\)/);
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE pump_launches (mint TEXT PRIMARY KEY, launch_slot INTEGER NOT NULL, launched_at INTEGER NOT NULL, record_json TEXT NOT NULL, updated_at INTEGER NOT NULL, symbol_norm TEXT, deployer TEXT)`);
  db.exec(`CREATE TABLE crypto_signals (id TEXT PRIMARY KEY, detected_at INTEGER, token_address TEXT, outcome TEXT, verdict TEXT DEFAULT 'WATCH')`);
  const H = 3_600_000, T = 1_800_000_000_000;
  const ins = db.prepare("INSERT INTO pump_launches VALUES (?, 1, ?, '{}', 0, ?, ?)");
  ins.run("Apump", T - 30 * H, "bawsaq", "DEV1"); // same symbol but older than 24 h; same deployer
  ins.run("Bpump", T - 5 * H, "bawsaq", "DEV1");
  ins.run("Cpump", T - 1 * H, "bawsaq", "DEV2");
  ins.run("Dpump", T, "bawsaq", "DEV1");           // the coin being read
  ins.run("Epump", T + 1 * H, "bawsaq", "DEV1");   // launched after: not counted
  ins.run("Fpump", T - 2 * H, "other", "DEV1");
  assert.equal((db.prepare(sameSql).get("bawsaq", "Dpump", T, T - SAME_SYMBOL_HOURS * H) as any).n, 2);
  assert.equal((db.prepare(priorSql).get("DEV1", "Dpump", T) as any).n, 3);
  const sig = db.prepare("INSERT INTO crypto_signals (id, detected_at, token_address, outcome) VALUES (?, ?, ?, ?)");
  // A second-look row (shared/secondLook.ts) is never a coin's outcome, even when it is the coin's only row.
  db.prepare("INSERT INTO crypto_signals VALUES ('look', 0, 'Fpump', 'HIT_5M', 'LOOK2')").run();
  sig.run("s1", 1, "Apump", "RUGGED"); sig.run("s2", 2, "Apump", "DEAD"); // a coin's first row is its outcome
  sig.run("s3", 3, "Bpump", "HIT_5M"); sig.run("s4", 4, "Cpump", "RUGGED"); // Cpump is another deployer's
  const rows = db.prepare(outSql).all("DEV1", "Dpump", T) as any[];
  assert.deepEqual(foldOutcomes(rows), { logged: 2, won: 1, rugged: 1, dead: 0, open: 0, noData: 0 });
  // The one-time back-fill of the indexed columns from stored records.
  const fill = /sqlite\.exec\(`(UPDATE pump_launches SET[\s\S]*?WHERE symbol_norm IS NULL)`\)/.exec(src)![1];
  db.prepare("INSERT INTO pump_launches (mint, launch_slot, launched_at, record_json, updated_at) VALUES ('Gpump', 1, 1, ?, 0)").run(JSON.stringify({ symbol: " $Katia ", deployer: "DEV9" }));
  db.exec(fill);
  assert.deepEqual({ ...(db.prepare("SELECT symbol_norm, deployer FROM pump_launches WHERE mint = 'Gpump'").get() as any) }, { symbol_norm: "katia", deployer: "DEV9" });
});

test("wiring: read once when the signal is written, stored on the row, shown on the card, and never a gate", () => {
  const e = read("server/cryptoEngine.ts");
  assert.match(e, /if \(c\.chain === "solana" && c\.launchCtx == null\) \{\s*try \{ c\.launchCtx = launchContextFor\(c\.tokenAddress, c\.pairCreatedAt\); \}/);
  assert.match(e, /launchCtx: c\.launchCtx \?\? null,/);
  // Not referenced by the scorer or any verdict: only the two places above and the type.
  assert.equal((e.match(/launchCtx/g) ?? []).length, 6);
  assert.match(read("client/src/components/CryptoPanel.tsx"), /data-testid=\{`crypto-launch-context-\$\{c\.pairAddress\}`\}/);
  assert.match(read("server/pumpListener.ts"), /normSymbol\(r\.symbol\), r\.deployer\)/);
});
