// server/mlServing.ts
//
// One function builds the band the Projected Path panel draws AND the band
// the coverage logger scores (review R2-F items 3 and 5: "score coverage on
// the band the user actually sees"). The decision itself is pure
// (mlServedBand.composeServedBand); this module only gathers its inputs:
//   - the quantile overlay from the ML sidecar (served only if promoted);
//   - the morning-anchor model (same gate; fingerprint from $SPX bars, the
//     same index as the overlay features);
//   - the baseline cone, with the trainer's fitted standardized quantiles
//     (ml_service/models/baseline_cone_meta.json) when they exist;
//   - why no model is drawn (sidecar not installed / unreachable / no
//     promoted model).

import fs from "fs";
import path from "path";
import { fetchOHLC } from "./ohlc";
import { mlHealth, mlQuantileMorning, mlQuantileOverlay, type MLQuantileOverlayResponse } from "./mlBridge";
import { buildMorningFingerprint, computeMorningBlendWeight, type MorningFingerprintResult } from "./mlMorningFingerprint";
import { baselineCone, composeServedBand, type BaselineZ, type ServedBand } from "./mlServedBand";
import { sidecarInstallStatus } from "./mlSidecarStatus";

export const OVERLAY_HORIZONS = [5, 15, 30, 60];
export const MORNING_HORIZONS = [30, 60, 120, 180, 240];

const BASELINE_META = path.resolve(process.cwd(), "ml_service", "models", "baseline_cone_meta.json");
let _z: { mtime: number; z: BaselineZ | null } | null = null;

/** Trainer-fitted standardized quantiles for the baseline cone, or null (Gaussian). */
export function loadBaselineZ(): BaselineZ | null {
  try {
    const st = fs.statSync(BASELINE_META);
    if (_z && _z.mtime === st.mtimeMs) return _z.z;
    const m = JSON.parse(fs.readFileSync(BASELINE_META, "utf8"));
    const z: BaselineZ | null = m && m.method === "fhs" && m.by_horizon
      ? { method: "fhs", byHorizon: m.by_horizon, nDays: Number(m.n_days) || 0, fittedAt: Number(m.fitted_at) || null }
      : null;
    _z = { mtime: st.mtimeMs, z };
    return z;
  } catch {
    return null;
  }
}

let _healthCache: { at: number; ok: boolean; promoted: boolean | null } | null = null;

/** Why the overlay gave no promoted bands: not installed, unreachable, or nothing promoted. */
async function noModelReason(): Promise<string> {
  const inst = sidecarInstallStatus();
  if (!inst.installed) return `ML sidecar not installed (${inst.reason ?? "unknown"})`;
  if (!_healthCache || Date.now() - _healthCache.at > 60_000) {
    const h: any = await mlHealth({ timeoutMs: 1500 });
    _healthCache = { at: Date.now(), ok: !!h, promoted: h ? h.models?.quantile_overlay?.promoted === true : null };
  }
  if (!_healthCache.ok) return "ML sidecar unreachable";
  return "no quantile model has passed the promotion gate";
}

export interface ServedProjection {
  served: ServedBand;
  overlay: MLQuantileOverlayResponse | null;
  morning: { fingerprint: MorningFingerprintResult; projection: MLQuantileOverlayResponse | null } | null;
  morningWeight: number;
}

/**
 * The served band for this feature dict. `features` carries NaN for missing
 * inputs (sent as JSON null; the sidecar routes them as missing).
 */
export async function buildServedProjection(
  features: Record<string, number>,
  opts: { timeoutMs?: number } = {},
): Promise<ServedProjection> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const overlay = await mlQuantileOverlay(features, OVERLAY_HORIZONS, { timeoutMs });

  // Morning anchor: fingerprint from $SPX bars (same index and ATR units as
  // the overlay features). Its sidecar endpoint serves only a promoted model.
  let morning: ServedProjection["morning"] = null;
  let morningWeight = 0;
  try {
    const atr = Number(features.atr_5m);
    const spot = Number(features.spx_spot);
    if (Number.isFinite(atr) && atr > 0 && Number.isFinite(spot) && spot > 0) {
      // Same call for the panel route and the coverage logger, so both see one band.
      let prevClose: number | null = null;
      try { prevClose = (await fetchOHLC("^SPX", "1D", "5m"))?.prevClose ?? null; } catch { prevClose = null; }
      const fp = await buildMorningFingerprint({ symbol: "^SPX", prevClose, atr5m: atr, spot });
      let projection: MLQuantileOverlayResponse | null = null;
      if (fp.ready) {
        projection = await mlQuantileMorning({
          ...features,
          morn_orb_range_atr: fp.morn_orb_range_atr, morn_orb_hi_pct: fp.morn_orb_hi_pct, morn_orb_lo_pct: fp.morn_orb_lo_pct,
          morn_open_drive_atr: fp.morn_open_drive_atr, morn_opening_vol_z: fp.morn_opening_vol_z, morn_gap_atr: fp.morn_gap_atr,
          morn_vwap_dev_atr: fp.morn_vwap_dev_atr, bars_since_anchor: fp.bars_since_anchor, spot_vs_anchor_atr: fp.spot_vs_anchor_atr,
        }, MORNING_HORIZONS, { timeoutMs });
        morningWeight = computeMorningBlendWeight();
      }
      morning = { fingerprint: fp, projection };
    }
  } catch (e: any) {
    console.warn("[ml:serving] morning model skipped:", e?.message ?? e);
  }

  const promotedOverlay = !!overlay && overlay.promoted === true && overlay.trainingData === "real";
  const served = composeServedBand({
    overlay: overlay ? { bands: overlay.bands, status: overlay.status, version: overlay.version, trainingData: overlay.trainingData, promoted: overlay.promoted ?? false } : null,
    morning: morning?.projection
      ? { bands: morning.projection.bands, status: morning.projection.status, version: morning.projection.version, trainingData: morning.projection.trainingData, promoted: morning.projection.promoted ?? false }
      : null,
    morningWeight,
    baseline: baselineCone(features, OVERLAY_HORIZONS, loadBaselineZ()),
    overlayHorizons: OVERLAY_HORIZONS,
    morningHorizons: MORNING_HORIZONS,
    reasonIfNoModel: promotedOverlay ? null : (overlay ? null : await noModelReason()),
  });
  _lastServed = { at: Date.now(), served };
  return { served, overlay, morning, morningWeight };
}

let _lastServed: { at: number; served: ServedBand } | null = null;

/** The most recent served band (panel route or logger), if computed within maxAgeMs. */
export function getRecentServedBand(maxAgeMs: number): { at: number; served: ServedBand } | null {
  return _lastServed && Date.now() - _lastServed.at <= maxAgeMs ? _lastServed : null;
}
