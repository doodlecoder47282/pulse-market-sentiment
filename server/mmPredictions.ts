// server/mmPredictions.ts
//
// Logs MM-matrix predictions and grades them against forward returns so we can
// replace hand-calibrated priors with empirical stats. Format is JSON Lines
// (one row per line) for append-only durability and easy stream processing.
//
// File: data/mm-predictions/predictions.jsonl
//
// Snapshot row shape:
//   { id, ts, sessionDate, horizon, regime, zone, pUp, pDown, pPin, bias,
//     action, spot, positionInZone, vixDelta, charmDriftPct, dfi }
//
// Outcome row shape (same id, written later):
//   { id, graded: true, spotAtGrade, tPlus30Pct, tPlus60Pct, tPlusClosePct,
//     outcome: "up" | "down" | "pin" }
//
// "up"/"down" threshold: ≥0.15% move; anything smaller is "pin".

import fs from "node:fs/promises";
import path from "node:path";
import type { ModelHorizon } from "./models";
import type { MMMatrix } from "./mmMatrix";

const LOG_DIR = path.resolve(process.cwd(), "data", "mm-predictions");
const LOG_FILE = path.join(LOG_DIR, "predictions.jsonl");

const PIN_THRESHOLD_PCT = 0.15; // < 0.15% forward move = pinned

// ──────────────────────────────────────────────────────────────────────────
// Row types
// ──────────────────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: string;                 // `${sessionDate}-${horizon}-${tsISO}`
  ts: number;                 // epoch seconds
  sessionDate: string;        // YYYY-MM-DD (NY)
  horizon: string;            // daily | weekly | monthly | quarterly
  regime: string;
  zone: string;
  pUp: number;
  pDown: number;
  pPin: number;
  bias: number;
  action: string;
  spot: number;
  positionInZone?: number;    // derived at snapshot time (current cell only)
  vixDelta: number | null;
  charmDriftPct: number | null; // (charmZero - spot) / spot
  dfi: number | null;
  kind: "snapshot";
}

export interface OutcomeRow {
  id: string;
  graded: true;
  gradedAt: number;
  spotAtGrade: number;
  tPlusClosePct: number;     // % change from snapshot spot to session close
  outcome: "up" | "down" | "pin";
  kind: "outcome";
}

type LogRow = SnapshotRow | OutcomeRow;

// ──────────────────────────────────────────────────────────────────────────
// File helpers
// ──────────────────────────────────────────────────────────────────────────

async function ensureDir() {
  await fs.mkdir(LOG_DIR, { recursive: true }).catch(() => {});
}

async function appendRow(row: LogRow): Promise<void> {
  await ensureDir();
  await fs.appendFile(LOG_FILE, JSON.stringify(row) + "\n", "utf8");
}

async function readAllRows(): Promise<LogRow[]> {
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line) as LogRow; } catch { return null; }
    }).filter((x): x is LogRow => x != null);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot: record current (regime, zone, probs) from a ModelHorizon
// ──────────────────────────────────────────────────────────────────────────

function sessionDateNY(now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(now);
}

export async function snapshotHorizon(horizon: ModelHorizon, horizonKey: string): Promise<SnapshotRow | null> {
  const mm: MMMatrix | undefined = horizon.mmMatrix;
  if (!mm) return null;
  const current = mm.cells.find((c) => c.regime === mm.currentRegime && c.zone === mm.currentZone);
  if (!current) return null;

  const a = horizon.audit;
  const ts = Math.floor(Date.now() / 1000);
  const sd = sessionDateNY();
  const id = `${sd}-${horizonKey}-${ts}`;

  // Re-derive positionInZone from the zone note if present (the classifyZone note
  // encodes this descriptively — we store a numeric approximation from mmMatrix).
  const row: SnapshotRow = {
    id,
    ts,
    sessionDate: sd,
    horizon: horizonKey,
    regime: mm.currentRegime,
    zone: mm.currentZone,
    pUp: current.pUp,
    pDown: current.pDown,
    pPin: current.pPin,
    bias: current.bias,
    action: current.action,
    spot: a.spot,
    vixDelta: a.termStructureDoD?.iv1dDelta ?? null,
    charmDriftPct: a.charmZero != null ? ((a.charmZero - a.spot) / a.spot) * 100 : null,
    dfi: a.dfi ?? null,
    kind: "snapshot",
  };
  await appendRow(row);
  return row;
}

// ──────────────────────────────────────────────────────────────────────────
// Grade: fill outcomes for any ungraded snapshot whose sessionDate has closed
// ──────────────────────────────────────────────────────────────────────────

export async function gradeOutcomes(
  closePriceForDate: (sessionDate: string) => Promise<number | null>,
): Promise<{ graded: number; skipped: number }> {
  const rows = await readAllRows();
  const graded = new Set<string>();
  for (const r of rows) if (r.kind === "outcome") graded.add(r.id);

  const today = sessionDateNY();
  let g = 0, s = 0;
  for (const r of rows) {
    if (r.kind !== "snapshot") continue;
    if (graded.has(r.id)) continue;
    if (r.sessionDate >= today) { s++; continue; } // session not closed yet
    const close = await closePriceForDate(r.sessionDate);
    if (close == null) { s++; continue; }

    const pct = ((close - r.spot) / r.spot) * 100;
    const outcome: "up" | "down" | "pin" =
      Math.abs(pct) < PIN_THRESHOLD_PCT ? "pin" : pct > 0 ? "up" : "down";
    const row: OutcomeRow = {
      id: r.id,
      graded: true,
      gradedAt: Math.floor(Date.now() / 1000),
      spotAtGrade: close,
      tPlusClosePct: Number(pct.toFixed(3)),
      outcome,
      kind: "outcome",
    };
    await appendRow(row);
    g++;
  }
  return { graded: g, skipped: s };
}

// ──────────────────────────────────────────────────────────────────────────
// Empirical stats: aggregate graded outcomes by (regime, zone)
// ──────────────────────────────────────────────────────────────────────────

export interface CellStat {
  regime: string;
  zone: string;
  n: number;
  empUp: number;       // 0..100
  empDown: number;
  empPin: number;
  priorUp: number;     // average of pUp across snapshots in this cell
  priorDown: number;
  priorPin: number;
  deltaUp: number;     // empUp - priorUp (where the prior is wrong)
  deltaDown: number;
  avgAbsMovePct: number;
}

export async function empiricalStats(): Promise<{
  total: number;
  graded: number;
  cells: CellStat[];
  recent: Array<{ id: string; regime: string; zone: string; pUp: number; pDown: number; pPin: number; outcome?: string; movePct?: number; ts: number }>;
}> {
  const rows = await readAllRows();
  const snaps = rows.filter((r): r is SnapshotRow => r.kind === "snapshot");
  const outcomes = new Map<string, OutcomeRow>();
  for (const r of rows) if (r.kind === "outcome") outcomes.set(r.id, r);

  const bucket = new Map<string, {
    up: number; down: number; pin: number;
    sumPriorUp: number; sumPriorDown: number; sumPriorPin: number;
    sumAbsMove: number; n: number;
  }>();

  for (const s of snaps) {
    const o = outcomes.get(s.id);
    if (!o) continue;
    const key = `${s.regime}|${s.zone}`;
    let b = bucket.get(key);
    if (!b) { b = { up: 0, down: 0, pin: 0, sumPriorUp: 0, sumPriorDown: 0, sumPriorPin: 0, sumAbsMove: 0, n: 0 }; bucket.set(key, b); }
    b[o.outcome]++;
    b.sumPriorUp += s.pUp;
    b.sumPriorDown += s.pDown;
    b.sumPriorPin += s.pPin;
    b.sumAbsMove += Math.abs(o.tPlusClosePct);
    b.n++;
  }

  const cells: CellStat[] = [];
  for (const [key, b] of bucket.entries()) {
    const [regime, zone] = key.split("|");
    const empUp = Math.round((b.up / b.n) * 100);
    const empDown = Math.round((b.down / b.n) * 100);
    const empPin = 100 - empUp - empDown;
    const priorUp = Math.round(b.sumPriorUp / b.n);
    const priorDown = Math.round(b.sumPriorDown / b.n);
    const priorPin = Math.round(b.sumPriorPin / b.n);
    cells.push({
      regime, zone, n: b.n,
      empUp, empDown, empPin,
      priorUp, priorDown, priorPin,
      deltaUp: empUp - priorUp,
      deltaDown: empDown - priorDown,
      avgAbsMovePct: Number((b.sumAbsMove / b.n).toFixed(3)),
    });
  }
  cells.sort((a, b) => b.n - a.n);

  const recent = snaps.slice(-25).reverse().map((s) => {
    const o = outcomes.get(s.id);
    return {
      id: s.id, regime: s.regime, zone: s.zone,
      pUp: s.pUp, pDown: s.pDown, pPin: s.pPin,
      outcome: o?.outcome, movePct: o?.tPlusClosePct,
      ts: s.ts,
    };
  });

  return {
    total: snaps.length,
    graded: Array.from(outcomes.values()).length,
    cells,
    recent,
  };
}
