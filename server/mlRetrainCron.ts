/**
 * Pulse Batcave — ML Retrain Cron (Wire 20)
 *
 * Schedules weekly Sunday 02:00 ET retrain of all 3 ML models.
 * ENV gate: only runs if PULSE_ML_RETRAIN_ENABLED !== "0".
 * Uses node-cron with America/New_York timezone.
 */

import cron from "node-cron";

const ML_URL = () => process.env.PULSE_ML_URL ?? "http://127.0.0.1:5001";

async function kickRetrain(): Promise<void> {
  console.log("[ml:retrain:kicked] Starting weekly ML retrain...");
  try {
    const res = await fetch(`${ML_URL()}/retrain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: ["score_calibrator", "quantile_overlay", "whale_follow"],
      }),
    });

    if (!res.ok) {
      console.error(`[ml:retrain:failed] HTTP ${res.status}`);
      return;
    }

    const data = await res.json() as { started: boolean; job_id: string };
    console.log(`[ml:retrain:kicked] job_id=${data.job_id}`);

    // Poll for completion (up to 30 min)
    const maxWaitMs = 30 * 60 * 1000;
    const pollIntervalMs = 30_000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      try {
        const statusRes = await fetch(`${ML_URL()}/retrain/status/${data.job_id}`);
        if (statusRes.ok) {
          const statusData = await statusRes.json() as { status: string; results?: Record<string, unknown> };
          if (statusData.status === "done") {
            console.log(`[ml:retrain:done] job_id=${data.job_id}`, JSON.stringify(statusData.results ?? {}));
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
}

/**
 * Fire one-shot backfill 30s after boot (opt-in via PULSE_ML_BACKFILL_ON_BOOT=1).
 * Never blocks server startup.
 */
function scheduleBootBackfill(): void {
  if (process.env.PULSE_ML_BACKFILL_ON_BOOT !== "1") return;

  setTimeout(() => {
    console.log("[ml:backfill:boot] Firing POST /backfill (30s post-boot)...");
    fetch(`${ML_URL()}/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: ["spy_1min", "cboe_gex"] }),
    })
      .then(async (res) => {
        if (!res.ok) {
          console.warn(`[ml:backfill:boot] HTTP ${res.status}`);
          return;
        }
        const data = await res.json() as { started: boolean; job_id: string };
        console.log(`[ml:backfill:boot] started job_id=${data.job_id}`);
      })
      .catch((e) => console.warn(`[ml:backfill:boot] error: ${e?.message ?? e}`));
  }, 30_000);
}

/**
 * Call once at server startup from server/index.ts.
 * Registers the Sunday 02:00 ET cron job.
 */
export function startMlRetrainCron(): void {
  if (process.env.PULSE_ML_RETRAIN_ENABLED === "0") {
    console.log("[ml:retrain] cron disabled via PULSE_ML_RETRAIN_ENABLED=0");
    return;
  }

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

  // Boot-time backfill (opt-in)
  scheduleBootBackfill();
}
