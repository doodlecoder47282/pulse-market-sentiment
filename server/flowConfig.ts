// ─────────────────────────────────────────────────────────────────────────────
// flowConfig.ts — runtime-mutable config for whale flow detection.
//
// Why this exists:
//   - Watchlist was hardcoded in flowAlertEngine.ts (audit ticket #6)
//   - Tuning thresholds previously required a redeploy (audit ticket #7)
//
// Resolution order (highest priority first):
//   1) Runtime override via setFlowConfig() — mutated in-memory by /api/flow/config
//   2) Environment variables (FLOW_WATCHLIST, FLOW_PREMIUM_FLOOR, ...)
//   3) Compiled defaults
//
// In-memory only — no persistence yet (audit ticket #5 will add SQLite).
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowConfig {
  /** Symbols scanned BEFORE the watchlist (always first). */
  priority: string[];
  /** User-tunable watchlist (after priority). */
  watchlist: string[];
  /** Minimum notional $ to qualify as whale */
  premiumFloor: number;
  /** Minimum volume / openInterest multiple */
  volOiRatio: number;
  /** Minimum DTE (0 = include 0DTE) */
  minDte: number;
  /** Maximum DTE — kills hedges/leaps, keeps urgency money */
  maxDte: number;
  /** Required aggressor tag */
  requiredTag: "ABOVE_ASK" | "AT_ASK" | "ANY";
  /** Delta filter window (|delta|) */
  deltaMin: number;
  /** Delta filter window upper bound */
  deltaMax: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_PRIORITY = ["SPX", "QQQ", "SPY"];
const DEFAULT_WATCHLIST = [
  "NVDA", "TSLA", "AAPL", "MSFT", "META", "GOOGL", "AMZN",
  "AMD", "AVGO", "PLTR", "COIN", "MSTR",
];

// ─── Env parsing helpers ─────────────────────────────────────────────────────
function parseSymbolList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));
  return parsed.length > 0 ? parsed : fallback;
}
function parseNum(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function parseTag(raw: string | undefined, fallback: FlowConfig["requiredTag"]): FlowConfig["requiredTag"] {
  const v = String(raw ?? "").toUpperCase();
  if (v === "ABOVE_ASK" || v === "AT_ASK" || v === "ANY") return v;
  return fallback;
}

// ─── State ───────────────────────────────────────────────────────────────────
let _config: FlowConfig = {
  priority: parseSymbolList(process.env.FLOW_PRIORITY, DEFAULT_PRIORITY),
  watchlist: parseSymbolList(process.env.FLOW_WATCHLIST, DEFAULT_WATCHLIST),
  premiumFloor: parseNum(process.env.FLOW_PREMIUM_FLOOR, 2_500_000),
  volOiRatio: parseNum(process.env.FLOW_VOL_OI_RATIO, 15),
  minDte: parseNum(process.env.FLOW_MIN_DTE, 1),
  maxDte: parseNum(process.env.FLOW_MAX_DTE, 3),
  requiredTag: parseTag(process.env.FLOW_REQUIRED_TAG, "ABOVE_ASK"),
  deltaMin: parseNum(process.env.FLOW_DELTA_MIN, 0.20),
  deltaMax: parseNum(process.env.FLOW_DELTA_MAX, 0.80),
};

// ─── Public API ──────────────────────────────────────────────────────────────
export function getFlowConfig(): FlowConfig {
  // Return frozen copy so callers can't mutate state through the reference
  return {
    priority: [..._config.priority],
    watchlist: [..._config.watchlist],
    premiumFloor: _config.premiumFloor,
    volOiRatio: _config.volOiRatio,
    minDte: _config.minDte,
    maxDte: _config.maxDte,
    requiredTag: _config.requiredTag,
    deltaMin: _config.deltaMin,
    deltaMax: _config.deltaMax,
  };
}

/** Validation + partial update. Returns either { ok: true, config } or { ok: false, error }. */
export function setFlowConfig(patch: Partial<FlowConfig>): { ok: boolean; config?: FlowConfig; error?: string } {
  try {
    const next: FlowConfig = { ..._config };
    if (patch.priority !== undefined) {
      if (!Array.isArray(patch.priority)) return { ok: false, error: "priority must be array" };
      const cleaned = patch.priority
        .map((s) => String(s).trim().toUpperCase())
        .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));
      if (cleaned.length === 0) return { ok: false, error: "priority cannot be empty" };
      next.priority = cleaned;
    }
    if (patch.watchlist !== undefined) {
      if (!Array.isArray(patch.watchlist)) return { ok: false, error: "watchlist must be array" };
      const cleaned = patch.watchlist
        .map((s) => String(s).trim().toUpperCase())
        .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));
      // watchlist may be empty
      next.watchlist = cleaned;
    }
    if (patch.premiumFloor !== undefined) {
      const n = Number(patch.premiumFloor);
      if (!Number.isFinite(n) || n < 100_000 || n > 100_000_000) {
        return { ok: false, error: "premiumFloor must be in [100000, 100000000]" };
      }
      next.premiumFloor = n;
    }
    if (patch.volOiRatio !== undefined) {
      const n = Number(patch.volOiRatio);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        return { ok: false, error: "volOiRatio must be in [1, 100]" };
      }
      next.volOiRatio = n;
    }
    if (patch.minDte !== undefined) {
      const n = Number(patch.minDte);
      if (!Number.isInteger(n) || n < 0 || n > 60) {
        return { ok: false, error: "minDte must be integer in [0, 60]" };
      }
      next.minDte = n;
    }
    if (patch.maxDte !== undefined) {
      const n = Number(patch.maxDte);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        return { ok: false, error: "maxDte must be integer in [1, 365]" };
      }
      next.maxDte = n;
    }
    if (next.minDte > next.maxDte) {
      return { ok: false, error: "minDte must be <= maxDte" };
    }
    if (patch.requiredTag !== undefined) {
      const v = String(patch.requiredTag).toUpperCase();
      if (v !== "ABOVE_ASK" && v !== "AT_ASK" && v !== "ANY") {
        return { ok: false, error: "requiredTag must be ABOVE_ASK | AT_ASK | ANY" };
      }
      next.requiredTag = v as FlowConfig["requiredTag"];
    }
    if (patch.deltaMin !== undefined) {
      const n = Number(patch.deltaMin);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { ok: false, error: "deltaMin must be in [0, 1]" };
      }
      next.deltaMin = n;
    }
    if (patch.deltaMax !== undefined) {
      const n = Number(patch.deltaMax);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { ok: false, error: "deltaMax must be in [0, 1]" };
      }
      next.deltaMax = n;
    }
    if (next.deltaMin >= next.deltaMax) {
      return { ok: false, error: "deltaMin must be less than deltaMax" };
    }
    _config = next;
    return { ok: true, config: getFlowConfig() };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Reset to compiled defaults (useful for tests). */
export function resetFlowConfig(): FlowConfig {
  _config = {
    priority: parseSymbolList(process.env.FLOW_PRIORITY, DEFAULT_PRIORITY),
    watchlist: parseSymbolList(process.env.FLOW_WATCHLIST, DEFAULT_WATCHLIST),
    premiumFloor: parseNum(process.env.FLOW_PREMIUM_FLOOR, 1_000_000),
    volOiRatio: parseNum(process.env.FLOW_VOL_OI_RATIO, 10),
    minDte: parseNum(process.env.FLOW_MIN_DTE, 1),
    requiredTag: parseTag(process.env.FLOW_REQUIRED_TAG, "ABOVE_ASK"),
    deltaMin: parseNum(process.env.FLOW_DELTA_MIN, 0.20),
    deltaMax: parseNum(process.env.FLOW_DELTA_MAX, 0.80),
  };
  return getFlowConfig();
}
