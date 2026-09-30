/**
 * Local, offline, read-only replay. No models, network or dataset downloads.
 * npx tsx scripts/replay-spy-features.ts [data.db]
 * JSONL goes to stdout; persisted input/values are checked against the same core.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { SPY_FEATURE_VERSION, SpySessionInputSchema, calculateSpyFeatures } from "../shared/spyFeatures";
const db = new Database(process.argv[2] ?? "data.db", { readonly: true, fileMustExist: true });
try {
  const rows = db.prepare(`SELECT input_json, features_json, input_hash FROM spy_real_feature_snapshots
    WHERE contract_version=? ORDER BY as_of, id`).iterate(SPY_FEATURE_VERSION);
  let count = 0;
  for (const row of rows as Iterable<{ input_json: string; features_json: string; input_hash: string }>) {
    const input = SpySessionInputSchema.parse(JSON.parse(row.input_json));
    const { receivedAt, ...stable } = input;
    if (createHash("sha256").update(JSON.stringify(stable)).digest("hex") !== row.input_hash) throw new Error("Input hash mismatch");
    const calculated = calculateSpyFeatures(input), stored = JSON.parse(row.features_json);
    if (calculated.status === "BLOCKED" || JSON.stringify(calculated.values) !== JSON.stringify(stored.values))
      throw new Error("Feature replay mismatch");
    process.stdout.write(JSON.stringify({ version: calculated.version, symbol: "SPY", asOf: input.asOf,
      receivedAt: input.receivedAt, sessionDate: input.date, inputHash: row.input_hash,
      values: Object.fromEntries(calculated.values.map(v => [v.id, v.value])),
      missing: calculated.values.filter(v => v.value === null).map(v => v.id),
      forecastEnabled: false, label: null }) + "\n");
    count++;
  }
  process.stderr.write(`Replayed ${count} stored observed snapshots; no training, labels or forecast activation.\n`);
} finally { db.close(); }
