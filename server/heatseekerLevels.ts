// heatseekerLevels.ts
// Server-side persistence for user-editable Heatseeker sticky levels.
// File-based JSON store (NO localStorage — sandboxed iframe blocks it).
// Single user, single file: data/heatseeker-levels.json

import fs from "node:fs/promises";
import path from "node:path";

const FILE = path.resolve(process.cwd(), "data", "heatseeker-levels.json");

export type LevelKind = "upside" | "downside" | "pin" | "vomma";

export interface StickyLevel {
  id: string;             // stable client-supplied or server-generated key
  value: number;          // SPX strike
  label: string;          // short label e.g. "T2 UP"
  kind: LevelKind;
  updatedAt: number;      // unix ms
}

interface LevelsFile {
  version: 1;
  updatedAt: number;
  levels: StickyLevel[];
}

const DEFAULT_LEVELS: StickyLevel[] = [
  { id: "t2-up",        value: 7270, label: "T2 UP",       kind: "upside",   updatedAt: 0 },
  { id: "upper-vomma",  value: 7265, label: "UPPER VOMMA", kind: "vomma",    updatedAt: 0 },
  { id: "upside",       value: 7140, label: "UPSIDE",      kind: "upside",   updatedAt: 0 },
  { id: "charm",        value: 7128, label: "CHARM",       kind: "pin",      updatedAt: 0 },
  { id: "neg-gamma",    value: 7100, label: "NEG \u03b3",   kind: "pin",      updatedAt: 0 },
  { id: "vanna",        value: 7089, label: "VANNA",       kind: "pin",      updatedAt: 0 },
  { id: "zomma",        value: 7070, label: "ZOMMA",       kind: "pin",      updatedAt: 0 },
  { id: "mopex",        value: 7025, label: "MOPEX",       kind: "pin",      updatedAt: 0 },
  { id: "lower-vomma",  value: 6960, label: "LOWER VOMMA", kind: "vomma",    updatedAt: 0 },
  { id: "downside",     value: 6950, label: "DOWNSIDE",    kind: "downside", updatedAt: 0 },
  { id: "t2-down",      value: 6885, label: "T2 DOWN",     kind: "downside", updatedAt: 0 },
];

async function ensureDir() {
  await fs.mkdir(path.dirname(FILE), { recursive: true }).catch(() => {});
}

export async function readLevels(): Promise<LevelsFile> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as LevelsFile;
    if (!parsed || !Array.isArray(parsed.levels)) throw new Error("invalid levels file");
    return parsed;
  } catch {
    // Seed with defaults
    return { version: 1, updatedAt: 0, levels: DEFAULT_LEVELS };
  }
}

export async function writeLevels(levels: StickyLevel[]): Promise<LevelsFile> {
  const sanitized = sanitizeLevels(levels);
  const out: LevelsFile = { version: 1, updatedAt: Date.now(), levels: sanitized };
  try {
    await ensureDir();
    await fs.writeFile(FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (e: any) {
    throw new Error(`failed to write heatseeker levels: ${e?.message ?? e}`);
  }
  return out;
}

const KIND_SET: Set<LevelKind> = new Set(["upside", "downside", "pin", "vomma"]);

export function sanitizeLevels(input: unknown): StickyLevel[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const out: StickyLevel[] = [];
  const seenIds = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as any;
    const value = Number(r.value);
    if (!Number.isFinite(value) || value <= 0 || value > 100_000) continue;
    const label = String(r.label ?? "").trim().slice(0, 24);
    if (!label) continue;
    const kind: LevelKind = KIND_SET.has(r.kind) ? r.kind : "pin";
    let id = String(r.id ?? "").trim().slice(0, 48);
    if (!id || seenIds.has(id)) {
      id = `lvl-${value}-${Math.random().toString(36).slice(2, 7)}`;
    }
    seenIds.add(id);
    out.push({
      id,
      value: Math.round(value * 100) / 100,
      label,
      kind,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
    });
    if (out.length >= 30) break; // hard cap
  }
  return out;
}
