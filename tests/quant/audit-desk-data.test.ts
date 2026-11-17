// Audit 2026-11-16, desk data batch: T9, T13, T14, T18, T19, T22.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("T9: the IV/RV daily row is written on trading days only, and a missing value never erases a stored one", () => {
  const src = read("server/ivRv.ts");
  assert.doesNotMatch(src, /INSERT OR REPLACE INTO iv_rv_daily/);
  assert.match(src, /function persist\(symbol: string, snap: IvRvSnapshot\): void \{\s*if \(!tradingDate\(snap\.asOf\)\) return;/);
  // Readers drop rows stored on non-trading dates by the old code.
  assert.match(src, /r\.iv30 > 0 && tradingDate\(r\.date\)/);
  assert.match(src, /rows\.filter\(\(r\) => tradingDate\(r\.date\)\)\.map\(r => r\.v\)/);
  // The statement itself, run against SQLite.
  const sql = /export const IV_RV_UPSERT_SQL = `([\s\S]*?)`;/.exec(src)![1];
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE iv_rv_daily (symbol TEXT NOT NULL, date TEXT NOT NULL, rv_5 REAL, rv_10 REAL, rv_20 REAL, rv_30 REAL, rv_60 REAL, iv_30 REAL, iv_60 REAL, iv_90 REAL, captured_at INTEGER NOT NULL, PRIMARY KEY (symbol, date))`);
  const st = db.prepare(sql);
  st.run("SPY", "2026-11-16", 0.1, 0.11, 0.12, 0.13, 0.14, 0.2, 0.21, 0.22, 1);
  st.run("SPY", "2026-11-16", 0.15, null, 0.12, 0.13, 0.14, null, null, 0.25, 2); // a later read with a failed chain
  const row = db.prepare(`SELECT * FROM iv_rv_daily`).all() as any[];
  assert.equal(row.length, 1);
  assert.equal(row[0].iv_30, 0.2, "a null implied vol does not erase the stored one");
  assert.equal(row[0].rv_10, 0.11);
  assert.equal(row[0].rv_5, 0.15, "a present value updates");
  assert.equal(row[0].iv_90, 0.25);
  assert.equal(row[0].captured_at, 2);
});

test("T18: with a leg missing the cross-asset rules name no pattern", () => {
  const src = read("server/crossAsset.ts");
  const i = src.indexOf("if (missingLegs.length > 0) {");
  const block = src.slice(i, i + 420);
  assert.match(block, /risk = "mixed";\s*label = "not read: missing data";\s*confidence = "low";\s*notes\.length = 0;/);
  assert.doesNotMatch(src, /verdict downgraded/);
});

test("T19: FRED week and month changes are by calendar date, not row count", async () => {
  const src = read("server/fredClient.ts");
  assert.doesNotMatch(src, /rows\.find\(\(_, i\) => i >= (5|22)\)/);
  assert.match(src, /const wkRow = rowAtOrBefore\(rows, latestDate, 7, 13\);\s*const moRow = rowAtOrBefore\(rows, latestDate, 28, 45\);/);
  // The helper, evaluated from source (the module opens the database on import).
  const body = /export function rowAtOrBefore<T[^>]*>\(rows: T\[\], latestDate: string \| null, days: number, maxDays: number = Infinity\): T \| undefined \{([\s\S]*?)\n\}/.exec(src)![1];
  const fn = new Function("rows", "latestDate", "days", "maxDays = Infinity", body) as (rows: any[], d: string | null, n: number, m?: number) => any;
  const weekly = [{ date: "2026-11-11", value: 5 }, { date: "2026-11-04", value: 4 }, { date: "2026-10-28", value: 3 }, { date: "2026-10-21", value: 2 }, { date: "2026-10-14", value: 1 }, { date: "2026-10-07", value: 0 }];
  assert.equal(fn(weekly, "2026-11-11", 7).date, "2026-11-04", "a weekly series: one week back is the previous row, not five rows back");
  assert.equal(fn(weekly, "2026-11-11", 30).date, "2026-10-07");
  const daily = [{ date: "2026-11-13", value: 1 }, { date: "2026-11-12", value: 1 }, { date: "2026-11-10", value: 1 }, { date: "2026-11-06", value: null }, { date: "2026-11-05", value: 9 }];
  assert.equal(fn(daily, "2026-11-13", 7).date, "2026-11-05", "a row without a value is skipped");
  assert.equal(fn([{ date: "2026-11-13", value: 1 }], "2026-11-13", 7), undefined);
  assert.equal(fn(daily, null, 7), undefined);
  const monthly = [{ date: "2027-03-01", value: 3 }, { date: "2027-02-01", value: 2 }, { date: "2027-01-01", value: 1 }];
  assert.equal(fn(monthly, "2027-03-01", 7, 13), undefined, "a monthly series has no 1w figure (it would be its month-over-month change)");
  assert.equal(fn(monthly, "2027-03-01", 28, 45).date, "2027-02-01", "February: the month comparison is the previous month, not two back");
  assert.equal(fn(weekly, "2026-11-11", 7, 13).date, "2026-11-04");
  const brief = read("server/edgeLabBrief.ts");
  assert.match(brief, /cross-asset matrix not read: a day change is missing/);
  assert.match(brief, /note: notRead \? "not read: a leg has no data"/);
  assert.match(read("client/src/components/edgelab/MacroFlowPanel.tsx"), /s\.weekChange == null \? "text-muted-foreground"/);
});

test("T22: a failed event-replay price read is retried after minutes, not cached for six hours", () => {
  const src = read("server/researchStore.ts");
  assert.match(src, /const REPLAY_FAIL_CACHE_MS = 2 \* 60_000;/);
  assert.match(src, /if \(hit && Date\.now\(\) - hit\.at < replayTtl\(hit\.data\)\) return hit\.data;/);
  assert.doesNotMatch(src, /hit\.at < REPLAY_CACHE_MS/);
});

test("T13/T14: the option ledger is described as before fees; a fitted value is printed only where it is the one served", () => {
  const t = read("client/src/components/edgelab/TruthPanel.tsx");
  assert.doesNotMatch(t, /net return = \(sale proceeds − premium paid − fees\)/);
  assert.match(t, /before fees \(this table deducts none\)/);
  assert.match(t, /\{b\.fittedInUse \? pctFmt\(b\.fitted\) : "—"\}/);
  const g = read("server/gradeCalibration.ts");
  assert.match(g, /b\.fittedInUse = source === "fitted" && b\.n >= MIN_BUCKET && b\.fitted != null;/);
});
