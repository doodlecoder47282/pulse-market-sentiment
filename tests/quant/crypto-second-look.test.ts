// The second look (shared/secondLook.ts): one more row per coin a fixed time after its first signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { secondLookDue, secondLookReadout, SECOND_LOOK_PARAMS, SECOND_LOOK_VERSION, SECOND_LOOK_VERDICT, type LookRow } from "../../shared/secondLook";
import type { ReplayRow } from "../../shared/cryptoReplay";
import { CRYPTO_RULES } from "../../shared/cryptoRules";
import { CRYPTO_SIGNAL_COUNTS_SQL, cryptoCoinCountsSql } from "../../server/cryptoStats";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const base = { firstSignalAt: T0, alreadyAt: null, dataAt: T0 + 31 * MIN, cap: 200_000, liquidityUsd: 40_000 };

test("the trigger is time since the first signal, measured to the data time, inside a fixed window", () => {
  assert.deepEqual(secondLookDue(base), { due: true, minutesAfterFirst: 31 });
  assert.deepEqual(secondLookDue({ ...base, dataAt: T0 + 29.9 * MIN }), { due: false, why: "too_early" });
  assert.deepEqual(secondLookDue({ ...base, dataAt: T0 + 91 * MIN }), { due: false, why: "too_late" });
  assert.deepEqual(secondLookDue({ ...base, firstSignalAt: null }), { due: false, why: "no_first_signal" });
  assert.deepEqual(secondLookDue({ ...base, alreadyAt: T0 + 30 * MIN }), { due: false, why: "already_written" });
  assert.deepEqual(secondLookDue({ ...base, dataAt: null }), { due: false, why: "data_unread" });
});

test("an entry that cannot be measured is not written: missing or zero cap, missing or zero pool, or no room to the target", () => {
  for (const over of [{ cap: null }, { cap: 0 }, { liquidityUsd: null }, { liquidityUsd: 0 }]) {
    assert.deepEqual(secondLookDue({ ...base, ...over }), { due: false, why: "unmeasurable" }, JSON.stringify(over));
  }
  assert.deepEqual(secondLookDue({ ...base, cap: CRYPTO_RULES.universe.targetMcapUsd }), { due: false, why: "at_or_above_target" });
  assert.equal(secondLookDue({ ...base, cap: CRYPTO_RULES.universe.targetMcapUsd - 1 }).due, true);
});

let seq = 0;
function first(coin: string, over: Partial<ReplayRow> & { f?: Partial<ReplayRow["features"]> } = {}): ReplayRow {
  const { f, ...rest } = over;
  return {
    id: `f${++seq}`, detectedAt: T0 + seq * MIN, verdict: "WATCH", symbol: coin, coinKey: coin,
    outcome: "DEAD", mcapAtSignal: 40_000, liquidityAtSignal: 18_000, peakMcap: 45_000, lastMcap: 5_000, lastLiquidity: 9_000,
    features: { top10Pct: null, mintAuthorityActive: null, freezeAuthorityActive: null, gates: null, ...f },
    ...rest,
  };
}
function look(coin: string, over: Partial<LookRow> & { f?: Partial<ReplayRow["features"]>; meta?: Partial<NonNullable<LookRow["look"]>> } = {}): LookRow {
  const { f, meta, ...rest } = over;
  return {
    id: `l${++seq}`, detectedAt: T0 + 40 * MIN + seq * MIN, verdict: SECOND_LOOK_VERDICT, symbol: coin, coinKey: coin,
    outcome: "DEAD", mcapAtSignal: 120_000, liquidityAtSignal: 30_000, peakMcap: 130_000, lastMcap: 20_000, lastLiquidity: 12_000,
    features: {
      top10Pct: 22, mintAuthorityActive: false, freezeAuthorityActive: false,
      gates: { flowReadings: [2, 2], histLen: 2, jupState: "agree", jupGapPct: 1, buys1h: 80, sells1h: 20, deskRisk: "on" }, ...f,
    },
    look: { version: SECOND_LOOK_VERSION, minutesAfterFirst: 32, verdictAtLook: "WATCH", verdictCodeAtLook: null, hardKill: false, leftCurve: true, dexId: "pumpswap", firstCap: 40_000, firstLiquidity: 18_000, ...meta },
    ...rest,
  };
}

test("the readout compares what was read at the first signal with what was read at the look, on the same coins", () => {
  seq = 0;
  const firsts = [first("a"), first("b", { f: { top10Pct: 30 } }), first("c")];
  const looks = [look("a"), look("b", { f: { top10Pct: null } }), look("zz")]; // zz has no first signal in the record
  const r = secondLookReadout(looks, firsts);
  assert.equal(r.written, 3);
  assert.equal(r.coverage.of, 2, "only looks whose first signal is in the record are compared");
  assert.deepEqual(r.coverage.top10, { first: 1, look: 1 });
  assert.deepEqual(r.coverage.authorities, { first: 0, look: 2 });
  assert.deepEqual(r.coverage.jupiterChecked, { first: 0, look: 2 });
  assert.equal(r.medianCapMultipleSinceFirst, 3);
  assert.equal(r.windowPassedNoRow, null, "the server attaches the count; the pure readout does not invent one");
});

test("open rows are not graded, under 50 priced it is counts only, and a hard kill is a state at the look, not an outcome", () => {
  seq = 0;
  const firsts = ["a", "b", "c", "d"].map((c) => first(c));
  const looks = [
    look("a", { outcome: "DOUBLED", peakMcap: 300_000 }),
    look("b", { outcome: "RUGGED", meta: { hardKill: true } }),
    look("c", { outcome: "OPEN" }),
    look("d", { outcome: "NO_DATA", meta: { leftCurve: false } }),
  ];
  const r = secondLookReadout(looks, firsts);
  assert.deepEqual([r.written, r.open, r.graded, r.priced], [4, 1, 3, 2]);
  assert.equal(r.insufficient, true);
  assert.equal(r.hardKilledAtLook, 1);
  assert.deepEqual([r.all.n, r.all.wins], [2, 1]);
  assert.deepEqual([r.notKilled.n, r.notKilled.wins], [1, 1], "the killed row is left out by what was read at the look");
  assert.equal(r.leftCurve.n, 2, "NO_DATA and the on-curve row are not priced into the off-curve line");
  assert.equal(r.sameCoinsFirstSignal.n, 3, "first signals of the graded looks' coins only (a, b, d), not the open one");
});

test("a look row with no stored meta is neither 'not killed' nor 'off the curve'", () => {
  seq = 0;
  const l = { ...look("a", { outcome: "DOUBLED" }), look: null };
  const r = secondLookReadout([l], [first("a")]);
  assert.equal(r.all.n, 1);
  assert.equal(r.notKilled.n, 0);
  assert.equal(r.leftCurve.n, 0);
});

test("look rows never count as a coin's first signal or in the desk's row counts", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE crypto_signals (id TEXT PRIMARY KEY, detected_at INTEGER, chain TEXT, pair_address TEXT, token_address TEXT, verdict TEXT, outcome TEXT)`);
  const ins = db.prepare(`INSERT INTO crypto_signals VALUES (?, ?, 'solana', ?, ?, ?, ?)`);
  ins.run("1", 100, "p1", "m1", "WATCH", "DEAD");
  ins.run("2", 200, "p1", "m1", SECOND_LOOK_VERDICT, "DOUBLED");
  // A coin whose only row is a look (its first row lost): still not a first signal.
  ins.run("3", 300, "p2", "m2", SECOND_LOOK_VERDICT, "HIT_5M");
  const rows = db.prepare(CRYPTO_SIGNAL_COUNTS_SQL).get() as any;
  assert.deepEqual([Number(rows.total), Number(rows.doubled), Number(rows.hit5m), Number(rows.dead)], [1, 0, 0, 1]);
  const coins = db.prepare(cryptoCoinCountsSql()).get() as any;
  assert.deepEqual([Number(coins.total), Number(coins.doubled), Number(coins.hit5m), Number(coins.dead)], [1, 0, 0, 1]);
  const enters = db.prepare(cryptoCoinCountsSql("ENTER")).get() as any;
  assert.equal(Number(enters.total), 0);
});

test("the engine writes the look through the same writer, once per coin, and keeps it out of the list, replay and candidate sets", () => {
  const eng = readFileSync(new URL("../../server/cryptoEngine.ts", import.meta.url), "utf8");
  assert.match(eng, /persistSignal\(c\);\s*\n\s*maybeSecondLook\(c\);/, "checked on every momentum refresh, after the ordinary row");
  assert.match(eng, /look \? SECOND_LOOK_VERDICT : c\.verdict/);
  assert.match(eng, /\$\{look \? ":look2" : ""\}/, "a look written in the same millisecond as an ordinary row keeps its own id");
  assert.match(eng, /WHERE verdict != '\$\{SECOND_LOOK_VERDICT\}' ORDER BY detected_at DESC LIMIT \?/, "not in the signal list");
  assert.match(eng, /buildReplay\(firstRows, now\), candidates: candidatesReadout\(firstRows\)/);
  assert.match(eng, /if \(wrote\) c\.secondLookAt = Date\.now\(\)/, "a failed insert is retried, not marked done");
  assert.equal(SECOND_LOOK_VERDICT, "LOOK2", "the SQL in server/cryptoStats.ts and server/cryptoAuditStats.ts names this literal");
  for (const f of ["server/cryptoStats.ts", "server/cryptoAuditStats.ts"]) {
    assert.match(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"), /verdict != 'LOOK2'/, f);
  }
  const panel = readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /data-testid="crypto-replay-second-look"/);
  assert.match(panel, /A recording, not a verdict\./);
});

test("the second-look parameters are pinned to their version", () => {
  const hash = createHash("sha256").update(JSON.stringify(SECOND_LOOK_PARAMS)).digest("hex");
  const PINNED: Record<string, string> = { "second-look-2026.11.17-1": "8a1650293c4f73ac2d8e717f1855a336705c571f65c15f62f221d8de6d88256a" };
  assert.equal(hash, PINNED[SECOND_LOOK_VERSION], `second-look parameters changed under ${SECOND_LOOK_VERSION}: bump the version and pin ${hash}`);
});
