import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  normalizeSpyInputs, calculateSpyFeatures, blockedSpyFeatures, parseSpyHours, spyNyDate, shiftSpyDate,
  type SpyRawInputs, type SpySessionInput, type SpyFeatures,
} from "../shared/spyFeatures";

export interface SpyFeatureRun {
  features: SpyFeatures; input: SpySessionInput | null;
  quote: { price: number; time: number } | null; outsideSession: boolean;
}
export function buildSpyFeatureRun(raw: SpyRawInputs, now: number): SpyFeatureRun {
  const n = normalizeSpyInputs(raw, now);
  const features = n.input ? calculateSpyFeatures(n.input) : blockedSpyFeatures(n.issues.join(" "));
  if (n.input) features.issues.push(...n.issues);
  // Receipt time is not a numerical feature or part of the calculation identity.
  if (n.input) {
    const { receivedAt, ...stable } = n.input;
    features.inputHash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  }
  return { features, input: n.input, quote: n.quote, outsideSession: n.outsideSession };
}

/** Public market data only. No token/account fields, no model inference, no synthetic inputs. */
export async function readSpyFeatureInputs(): Promise<SpyRawInputs> {
  const { schwabFetch } = await import("./schwab");
  const date = spyNyDate(Date.now());
  const hours: Record<string, unknown> = {};
  const readHours = async () => {
    for (let back = 0; back <= 10; back++) {
      const day = shiftSpyDate(date, -back);
      hours[day] = await schwabFetch("marketdata/v1/markets", { markets: "equity", date: day });
      const parsed = parseSpyHours(hours[day], day);
      if (!parsed || back > 0 && parsed.isOpen) break;
      // A closed current session does not need historical feature computation.
      if (back === 0 && !parsed.isOpen) break;
    }
  };
  // One-minute window only; separate cache key from legacy 5m/SPX callers.
  const [quote, minuteHistory, dailyHistory] = await Promise.all([
    schwabFetch("marketdata/v1/quotes", { symbols: "SPY", fields: "quote,reference" }),
    schwabFetch("marketdata/v1/pricehistory", { symbol: "SPY", periodType: "day", period: 1,
      frequencyType: "minute", frequency: 1, needExtendedHoursData: "false", endDate: Date.now() }),
    schwabFetch("marketdata/v1/pricehistory", { symbol: "SPY", periodType: "month", period: 1,
      frequencyType: "daily", frequency: 1, needExtendedHoursData: "false" }),
    readHours(),
  ]);
  return { quote, minuteHistory, dailyHistory, hours, receivedAt: Date.now() };
}

/** Additive local research archive. Version/hash dedup retains changed bar revisions.
 * Not an immutable institutional ledger or point-in-time historical backfill.
 */
export async function archiveSpyFeatureRun(run: SpyFeatureRun): Promise<void> {
  try {
    const { sqlite } = await import("./storage");
    persistSpyFeatureRun(run, sqlite);
  } catch {
    run.features.archived = false;
    run.features.archiveReason = "Local archive unavailable; values are not being claimed replay-persisted.";
  }
}
export function persistSpyFeatureRun(run: SpyFeatureRun, sqlite: Database.Database): void {
  if (!run.input || !run.features.inputHash || run.features.status === "BLOCKED") return;
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS spy_real_feature_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contract_version TEXT NOT NULL,
      session_date TEXT NOT NULL, as_of INTEGER NOT NULL, received_at INTEGER NOT NULL,
      input_hash TEXT NOT NULL, input_json TEXT NOT NULL, features_json TEXT NOT NULL,
      UNIQUE(contract_version, input_hash)
    )`);
    sqlite.prepare(`INSERT OR IGNORE INTO spy_real_feature_snapshots
      (contract_version,session_date,as_of,received_at,input_hash,input_json,features_json)
      VALUES (?,?,?,?,?,?,?)`).run(run.features.version, run.input.date, run.input.asOf, run.input.receivedAt,
        run.features.inputHash, JSON.stringify(run.input), JSON.stringify(run.features));
    run.features.archived = true;
    run.features.archiveReason = "Versioned normalized input and features stored locally; hash deduplicated. Not a durable external ledger.";
  } catch {
    run.features.archived = false;
    run.features.archiveReason = "Local archive unavailable; values are not being claimed replay-persisted.";
  }
}
