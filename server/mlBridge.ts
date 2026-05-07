/**
 * Pulse Batcave — ML Bridge (Wire 20)
 *
 * All functions:
 * - Use AbortController with 100ms timeout
 * - Return null on timeout / parse error / non-200 — never throw
 * - Log "ml:bridge:miss" with reason
 * - Read env PULSE_ML_URL (default "http://127.0.0.1:5001")
 * - Use native fetch (Node 18+)
 */

const ML_URL = () => process.env.PULSE_ML_URL ?? "http://127.0.0.1:5001";
// Hot-path default: 100ms (Wire 20 contract — Discord card / 0DTE gate cannot block).
// UI / dashboard routes pass an explicit override (e.g. 2500ms) since users tolerate latency.
const DEFAULT_TIMEOUT_MS = 100;

// ─── Response types ──────────────────────────────────────────────────────────

export interface MLScoreOdteResponse {
  pHitT1: number;
  status: string;
  version: string;
}

export interface MLWhaleFollowResponse {
  pFollow30m: number;
  status: string;
  version: string;
}

export interface MLQuantileBand {
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
}

export interface MLQuantileOverlayResponse {
  bands: Record<string, MLQuantileBand>;
  status: string;
  version: string;
}

export interface MLModelHealth {
  status: string;
  version: number;
  trained_at: string | null;
  n_train: number;
  auc: number | null;
}

export interface MLHealthResponse {
  status: string;
  models: {
    score_calibrator: MLModelHealth;
    quantile_overlay: MLModelHealth;
    whale_follow: MLModelHealth;
  };
}

// ─── Internal helper ─────────────────────────────────────────────────────────

async function _post<T>(
  path: string,
  body: unknown,
  label: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${ML_URL()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[ml:bridge:miss] ${label} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json as T;
  } catch (err: any) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? "timeout" : String(err?.message ?? err);
    console.warn(`[ml:bridge:miss] ${label} ${reason}`);
    return null;
  }
}

async function _get<T>(path: string, label: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${ML_URL()}${path}`, {
      method: "GET",
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[ml:bridge:miss] ${label} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json as T;
  } catch (err: any) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? "timeout" : String(err?.message ?? err);
    console.warn(`[ml:bridge:miss] ${label} ${reason}`);
    return null;
  }
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * POST /score/odte — returns p(hit_t1) probability or null.
 */
export async function mlScoreOdte(
  features: Record<string, number>,
): Promise<MLScoreOdteResponse | null> {
  const raw = await _post<{
    p_hit_t1: number | null;
    status: string;
    version: number | string;
  }>("/score/odte", { features }, "mlScoreOdte");

  if (!raw || raw.p_hit_t1 == null) return null;
  return {
    pHitT1: raw.p_hit_t1,
    status: String(raw.status),
    version: String(raw.version),
  };
}

/**
 * POST /score/whale_follow — returns p(follow_30min) or null.
 */
export async function mlWhaleFollow(
  features: Record<string, number>,
): Promise<MLWhaleFollowResponse | null> {
  const raw = await _post<{
    p_follow_30min: number | null;
    status: string;
    version: number | string;
  }>("/score/whale_follow", { features }, "mlWhaleFollow");

  if (!raw || raw.p_follow_30min == null) return null;
  return {
    pFollow30m: raw.p_follow_30min,
    status: String(raw.status),
    version: String(raw.version),
  };
}

/**
 * POST /quantile/overlay — returns quantile bands or null.
 */
export async function mlQuantileOverlay(
  features: Record<string, number>,
  horizons: number[],
  opts?: { timeoutMs?: number },
): Promise<MLQuantileOverlayResponse | null> {
  const raw = await _post<{
    bands: Record<string, MLQuantileBand>;
    status: string;
    version: number | string;
  }>("/quantile/overlay", { features, horizons }, "mlQuantileOverlay", opts?.timeoutMs);

  if (!raw || !raw.bands || Object.keys(raw.bands).length === 0) return null;
  return {
    bands: raw.bands,
    status: String(raw.status),
    version: String(raw.version),
  };
}

/**
 * GET /health — returns ML service health or null.
 */
export async function mlHealth(opts?: { timeoutMs?: number }): Promise<MLHealthResponse | null> {
  return _get<MLHealthResponse>("/health", "mlHealth", opts?.timeoutMs);
}
