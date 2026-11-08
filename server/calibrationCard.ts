// server/calibrationCard.ts
//
// Weekly Pulse calibration card — posts to Discord every Sunday 8pm ET.
//
// Pure observer of pulse_outcomes. Does not touch any calc.
//
// Layout: sample line (settled days, which odds were recorded, which slot),
// realized mix beside the mean forecast, then, once CALIBRATION_MIN_DAYS are
// settled, Brier against the climatology forecast with a skill score, the
// top-pick hit rate against always-picking the most frequent bucket, the
// resolution and the CUSUM watchdog. No absolute letter grades: see
// composeCalibrationCard.

import { rollingBrier, recentForecastProbs } from "./calibration";
import { composeCalibrationCard } from "./calibrationCardText";
import { watchdogStatus } from "./cusumWatchdog";
import { webhookOrWarn, safeErrorSummary } from "./webhookConfig";

// Main Batcave channel, from PULSE_DISCORD_WEBHOOK only (no hard-coded fallback).
// Resolved at send time; unset = card disabled, logged once.

function etDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export async function postCalibrationCard(days: number = 7): Promise<{
  ok: boolean;
  preview: string;
}> {
  const r = rollingBrier(days);
  if (!r) {
    const msg = `**PULSE CALIBRATION**  |  ${etDate()}\n\`\`\`\n  No settled days yet — calibration starts after the first market close\n  with a recorded prediction.\n\`\`\`\n*Pulse Batcave  |  measurement only*`;
    await sendWebhook(msg);
    return { ok: true, preview: msg };
  }
  let forecastProbs: ReturnType<typeof recentForecastProbs> | null = null;
  try { forecastProbs = recentForecastProbs(30); } catch { forecastProbs = null; }
  let watchdog: ReturnType<typeof watchdogStatus> | null = null;
  try { watchdog = watchdogStatus(60); } catch { watchdog = null; }
  const final = composeCalibrationCard({ r, forecastProbs, watchdog, today: etDate() });
  const ok = await sendWebhook(final);
  return { ok, preview: final };
}

async function sendWebhook(content: string): Promise<boolean> {
  const url = webhookOrWarn("main", "calibrationCard");
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Pulse Batcave", content }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[calibrationCard] webhook ${res.status}: ${t.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[calibrationCard] webhook failed: ${safeErrorSummary(e)}`);
    return false;
  }
}
