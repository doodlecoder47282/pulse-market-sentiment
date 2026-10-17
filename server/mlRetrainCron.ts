/**
 * Pulse Batcave — ML Retrain Cron (Wire 20)
 *
 * Schedules a weekly Sunday 02:00 ET retrain of the quantile overlay. The
 * score calibrator (R2-F item 6) and the whale-follow model (round 3) are
 * retired: neither had a consumer.
 * Explicit opt-in: PULSE_ML_RETRAIN_ENABLED=1, and never in demo edition.
 * Uses node-cron with America/New_York timezone.
 *
 * No silent failure (review 9.5): when the Python sidecar is not installed on
 * this host (e.g. the default Railway Node build, see RAILWAY-DEPLOY.md), the
 * run logs "[ml:retrain:skipped] ML sidecar not installed: <reason>" and
 * returns. A retrain writes a new quantile model only when the real-data gate
 * is met, and that model is served only if it passes the promotion gate.
 */

import cron from "node-cron";
import { sidecarInstallStatus } from "./mlSidecarStatus";
import { editionFromEnv } from "../shared/edition";
import { withRequestDeadline } from "../shared/requestDeadline";

const ML_URL = () => process.env.PULSE_ML_URL ?? "http://127.0.0.1:5001";

export function retrainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return editionFromEnv(env) !== "demo" && env.PULSE_ML_RETRAIN_ENABLED === "1";
}

/** Boot and weekly jobs share one flight, including its completion polling. */
export function singleFlight(operation: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(operation).finally(() => { pending = null; });
    return pending;
  };
}

const kickRetrain = singleFlight(async (): Promise<void> => {
  if (!retrainEnabled()) return;
  const inst = sidecarInstallStatus(true);
  if (!inst.installed) {
    console.warn(`[ml:retrain:skipped] ML sidecar not installed: ${inst.reason ?? "unknown"}`);
    return;
  }
  console.log("[ml:retrain:kicked] Starting weekly ML retrain...");
  try {
    const data = await withRequestDeadline(async signal => {
      const res = await fetch(`${ML_URL()}/retrain`, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: ["quantile_overlay"] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as { started: boolean; job_id: string };
    }, 15_000);
    if (data.started !== true || typeof data.job_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.job_id)) {
      console.warn("[ml:retrain:skipped] No valid new training job acknowledged");
      return;
    }
    console.log(`[ml:retrain:kicked] job_id=${data.job_id}`);

    // Poll for completion (up to 30 min)
    const maxWaitMs = 30 * 60 * 1000;
    const pollIntervalMs = 30_000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      try {
        const statusData = await withRequestDeadline(async signal => {
          const res = await fetch(`${ML_URL()}/retrain/status/${encodeURIComponent(data.job_id)}`, { signal });
          if (!res.ok) return null;
          return await res.json() as { status: string; results?: Record<string, unknown> };
        }, 10_000);
        if (statusData) {
          if (statusData.status === "done") {
            console.log(`[ml:retrain:done] job_id=${data.job_id}`, JSON.stringify(statusData.results ?? {}));
            return;
          }
          if (["failed", "error", "cancelled"].includes(statusData.status)) {
            console.warn(`[ml:retrain:failed] job_id=${data.job_id} ended without a model`);
            return;
          }
        }
      } catch {
        // ignore poll errors
      }
    }

    console.warn(`[ml:retrain:failed] job_id=${data.job_id} timed out after 30 min`);
  } catch (err: any) {
    console.error(`[ml:retrain:failed] ${err?.message ?? err}`);
  }
});

/**
 * Boot backfill (PULSE_ML_BACKFILL_ON_BOOT=1) is removed: the sidecar's
 * backfill.py (CBOE GEX / Alpha Vantage SPY bars) is deleted, and market data
 * is Schwab only (user rule 2026-10-08). The real-data logger (mlDataLog.ts)
 * stores Schwab $SPX minute bars and the live feature dicts instead. The env
 * flag only logs that, so an old deploy setting fails loudly, not silently.
 */
function scheduleBootBackfill(): void {
  if (process.env.PULSE_ML_BACKFILL_ON_BOOT !== "1") return;
  console.warn("[ml:backfill:boot] removed (non-Schwab sources); the real-data logger (mlDataLog.ts) replaces it");
}

/**
 * Call once at server startup from server/index.ts.
 * Registers the Sunday 02:00 ET cron job.
 */
let scheduled = false;
export function startMlRetrainCron(): void {
  if (scheduled) return;
  if (!retrainEnabled()) {
    console.log("[ml:retrain] disabled: requires non-demo edition and PULSE_ML_RETRAIN_ENABLED=1");
    return;
  }
  scheduled = true;

  // Sunday at 02:00 ET
  cron.schedule(
    "0 2 * * 0",
    () => {
      kickRetrain().catch((e) =>
        console.error(`[ml:retrain:failed] unhandled: ${e?.message ?? e}`),
      );
    },
    {
      timezone: "America/New_York",
    },
  );

  console.log("[ml:retrain] cron scheduled: Sunday 02:00 ET");

  // Boot-time backfill: removed; logs if the old flag is still set
  scheduleBootBackfill();

  // Boot-time staleness check: the Sunday cron only fires while the server is
  // awake, so after a long sleep the models can sit months out of date. If any
  // model's trained_at is older than 7 days, kick a retrain over the full
  // logged history 45s after boot (non-blocking, skipped if sidecar is down).
  setTimeout(async () => {
    try {
      const h = await withRequestDeadline(async signal => {
        const res = await fetch(`${ML_URL()}/health`, { signal });
        if (!res.ok) return null;
        return await res.json() as { models?: Record<string, { trained_at?: number }> };
      }, 3000);
      if (!h) return;
      const staleSec = 7 * 24 * 60 * 60;
      const nowSec = Math.floor(Date.now() / 1000);
      // Models with no trained_at (retired, never trained) do not count.
      const stamps = Object.values(h.models ?? {}).map(m => m.trained_at ?? 0).filter((t) => t > 0);
      const oldest = stamps.length ? Math.min(...stamps) : 0;
      if (oldest > 0 && nowSec - oldest > staleSec) {
        console.log(`[ml:retrain] models stale (oldest trained ${Math.round((nowSec - oldest) / 86400)}d ago) — kicking boot retrain`);
        kickRetrain().catch((e) => console.error(`[ml:retrain:failed] boot: ${e?.message ?? e}`));
      }
    } catch {
      const inst = sidecarInstallStatus();
      console.warn(`[ml:retrain] boot check: ${inst.installed ? "ML sidecar unreachable" : `ML sidecar not installed: ${inst.reason ?? "unknown"}`}`);
    }
  }, 45_000);
}
