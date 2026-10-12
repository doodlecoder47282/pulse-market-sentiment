// The crypto grader SQL ran on node:sqlite in tests, which accepts "?1"
// numbered placeholders, while the server's better-sqlite3 reads them as named
// parameters and rejected every positional write ("Too many parameter values
// were provided"), so live crypto peaks and outcomes were never recorded.
// These checks keep the SQL in the form both libraries bind the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  CRYPTO_PEAK_SAMPLE_SQL, CRYPTO_GRADER_MARK_SQL, CRYPTO_GRADER_NO_DATA_SQL,
  peakSampleParams, graderMarkParams, graderNoDataParams,
} from "../../server/cryptoStats";

const NUMBERED = /\?[0-9]/;

test("crypto SQL uses named parameters only", () => {
  for (const [name, sql] of Object.entries({ CRYPTO_PEAK_SAMPLE_SQL, CRYPTO_GRADER_MARK_SQL, CRYPTO_GRADER_NO_DATA_SQL })) {
    assert.doesNotMatch(sql, NUMBERED, `${name} has a numbered placeholder`);
  }
  const eng = readFileSync("server/cryptoEngine.ts", "utf8");
  assert.match(eng, /_peakStmt\.run\(peakSampleParams\(/);
  assert.match(eng, /mark\.run\(graderMarkParams\(/);
  assert.equal((eng.match(/markNoData\.run\(graderNoDataParams\(/g) ?? []).length, 2);
});

test("server SQL has no numbered placeholders anywhere (better-sqlite3 rejects positional values for them)", () => {
  const { readdirSync } = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  for (const f of readdirSync("server").filter((n: string) => n.endsWith(".ts"))) {
    const src = readFileSync(`server/${f}`, "utf8");
    for (const m of src.matchAll(/`([^`]*)`/g)) {
      const body = m[1];
      if (!/\b(SELECT|UPDATE|INSERT|DELETE)\b/.test(body)) continue;
      assert.doesNotMatch(body, NUMBERED, `${f}: numbered placeholder in SQL`);
    }
  }
});

test("crypto SQL binds under better-sqlite3 (the server's driver) when it is installed", (t) => {
  let Database: any;
  try {
    Database = createRequire(import.meta.url)("better-sqlite3");
    new Database(":memory:").close();
  } catch {
    t.skip("better-sqlite3 not installed here (CI installs it)");
    return;
  }
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE crypto_signals (id TEXT PRIMARY KEY, chain TEXT, pair_address TEXT, outcome TEXT, mcap_at_signal REAL,
    peak_mcap REAL, peak_at INTEGER, last_mcap REAL, last_liquidity REAL, graded_at INTEGER)`);
  db.prepare(`INSERT INTO crypto_signals (id, chain, pair_address, outcome, mcap_at_signal) VALUES ('a','solana','P1','OPEN',100000)`).run();
  db.prepare(`INSERT INTO crypto_signals (id, chain, pair_address, outcome, mcap_at_signal) VALUES ('b','solana','P2','OPEN',100000)`).run();
  db.prepare(CRYPTO_PEAK_SAMPLE_SQL).run(peakSampleParams(400_000, 10, 50_000, "solana", "P1"));
  db.prepare(CRYPTO_GRADER_MARK_SQL).run(graderMarkParams(6_000_000, 20, 6_000_000, 60_000, "OPEN", 5_000_000, "a"));
  db.prepare(CRYPTO_GRADER_NO_DATA_SQL).run(graderNoDataParams(30, "b", 5_000_000));
  const a = db.prepare(`SELECT * FROM crypto_signals WHERE id = 'a'`).get();
  const b = db.prepare(`SELECT * FROM crypto_signals WHERE id = 'b'`).get();
  assert.equal(a.peak_mcap, 6_000_000);
  assert.equal(a.outcome, "HIT_5M");
  assert.equal(b.outcome, "NO_DATA");
  db.close();
});
