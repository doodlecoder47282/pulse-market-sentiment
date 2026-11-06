// Macro event calendar: official FOMC (Fed, 2025-09-05 release) and CPI (BLS schedule) dates.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../server/volCalendar.ts", import.meta.url), "utf8");
const list = (name: string) => {
  const m = new RegExp(`const ${name}: string\\[\\] = \\[([\\s\\S]*?)\\];`).exec(src);
  assert.ok(m, name);
  return Array.from(m![1].matchAll(/"(\d{4}-\d{2}-\d{2})"/g)).map((x) => x[1]);
};

test("FOMC: 2027 decision days from the Federal Reserve's schedule", () => {
  const f = list("FOMC_DATES");
  for (const d of ["2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08"]) assert.ok(f.includes(d), d);
  assert.deepEqual([...f].sort(), f, "chronological");
  for (const d of f) assert.notEqual(new Date(d + "T12:00:00Z").getUTCDay() % 6, 0, `${d} is a weekday`);
});

test("CPI: the BLS dates for late 2026 (moved after the 2025 lapse) and 2027", () => {
  const c = list("CPI_DATES");
  assert.ok(c.includes("2026-11-10") && !c.includes("2026-11-12"), "Nov 2026 release is the 10th");
  assert.ok(c.includes("2026-12-10") && !c.includes("2026-12-09"), "Dec 2026 release is the 10th");
  for (const d of ["2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10", "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10"]) assert.ok(c.includes(d), d);
  assert.deepEqual([...c].sort(), c, "chronological");
});

test("calendar: a 90-day window that runs past the end of a list says so", async () => {
  const { buildVolCalendar } = await import("../../server/volCalendar.ts");
  const cal: any = buildVolCalendar();
  assert.ok(Array.isArray(cal.events));
  const lastF = list("FOMC_DATES").at(-1)!;
  const in90 = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
  const expectWarn = in90 > lastF;
  assert.equal((cal.warnings ?? []).some((w: string) => /FOMC schedule (ends|stale)/.test(w)), expectWarn);
});
