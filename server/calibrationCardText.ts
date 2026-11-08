// server/calibrationCardText.ts
//
// Pure text composer for the weekly calibration card (tested without a
// database). server/calibrationCard.ts reads the numbers and posts the text.

import { resolutionScore, gradeResolution, betaBinomialCI } from "./stats";

/** The fields of calibration.ts rollingBrier() the card reads. */
export interface RollingBrierLike {
  n: number;
  bull: number; base: number; bear: number; total: number;
  trivialBull: number; trivialBase: number; trivialBear: number; trivialTotal: number;
  topPickHitRate: number; topPickHits: number; topPickN: number;
  realized: { bull: number; base: number; bear: number };
  meanForecast: { bull: number; base: number; bear: number };
  probSourceMix: Record<string, number>;
  slotMix: Record<string, number>;
  skill: { bull: number | null; base: number | null; bear: number | null; total: number | null };
  gated: boolean;
  minDays: number;
}

const fmt3 = (n: number): string => n.toFixed(3);
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

export type CalibrationCardInputs = {
  r: RollingBrierLike;
  forecastProbs: { bull: number[]; base: number[]; bear: number[] } | null;
  watchdog: { status: "HEALTHY" | "NO_SKILL" | "DRIFTING" | "BROKEN" | "INSUFFICIENT_DATA"; n: number; cValue: number; baseline: number; reason: string } | null;
  today: string;
};

/**
 * Pure composer (tested). Rules:
 *   - Below CALIBRATION_MIN_DAYS settled days the card shows counts and the
 *     realized mix only: no Brier reading, no skill, no hit-rate comparison,
 *     no diagnosis. Twenty coin flips grade nothing.
 *   - No absolute letter grades: a Brier is read against the climatology
 *     forecast of the same outcome stream (skill = 1 - BS/BS_clim), which is
 *     the only comparison that means something for a three-bucket forecast
 *     whose base bucket realises most days.
 *   - The hit-rate baseline is the most frequent realized bucket (what
 *     "always pick base" would score), not 33%.
 *   - The odds behind the graded rows are named (implied vs heuristic vs
 *     unrecorded) instead of pooled silently; a mixed stream is one line.
 *   - Realized mix is set beside the MEAN FORECAST for each bucket; the card
 *     states the gap, not a story about vol or skew.
 */
export function composeCalibrationCard(inp: CalibrationCardInputs): string {
  const { r, today } = inp;
  const sectionRule = (title: string) => {
    const bar = "━".repeat(Math.max(3, 60 - title.length));
    return `━━━  ${title}  ${bar}`;
  };
  const { bull: rB, base: rM, bear: rR } = r.realized;
  const { bull: fB, base: fM, bear: fR } = r.meanForecast;
  const mixLine = (mix: Record<string, number>) => Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const odds = Object.keys(r.probSourceMix).filter((k) => k !== "unrecorded").length > 1 ? " (two forecasters pooled in one score)" : "";

  const lines: string[] = [];
  lines.push(`**PULSE CALIBRATION  |  WEEK OF ${today}  |  ${r.n} SETTLED DAY${r.n === 1 ? "" : "S"}**`);
  lines.push("```");
  lines.push(sectionRule("SAMPLE"));
  lines.push(`  ${r.n} settled days scored; odds recorded as: ${mixLine(r.probSourceMix)}${odds}; graded row from the ${mixLine(r.slotMix)} slot`);
  lines.push(sectionRule("REALIZED MIX vs MEAN FORECAST"));
  const gap = (real: number, fc: number) => `${pct(real)} realized vs ${pct(fc)} forecast (${real - fc >= 0 ? "+" : ""}${Math.round((real - fc) * 100)} pts)`;
  lines.push(`  BULL  ${gap(rB, fB)}`);
  lines.push(`  BASE  ${gap(rM, fM)}`);
  lines.push(`  BEAR  ${gap(rR, fR)}`);

  if (r.gated) {
    lines.push("");
    lines.push(sectionRule("BRIER, SKILL AND HIT RATE"));
    lines.push(`  withheld: ${r.n} of the ${r.minDays} settled days needed before a score is read as a reading`);
    lines.push(`  (the multinomial Brier so far is ${fmt3(r.total)} against a base-rate forecast's ${fmt3(r.trivialTotal)}; at this sample the difference is noise either way)`);
    lines.push("```");
    lines.push("*Pulse Batcave  |  measurement only  |  a measurement, not a verdict*");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(sectionRule("BRIER vs CLIMATOLOGY (lower = closer; skill 0 = no better than the base rate)"));
  const skillFmt = (sk: number | null) => sk == null ? "skill n/a" : `skill ${sk >= 0 ? "+" : ""}${(sk * 100).toFixed(0)}%`;
  const fmtRow = (name: string, brier: number, clim: number, sk: number | null) =>
    `  ${pad(name, 8)} ${fmt3(brier)}   base-rate ${fmt3(clim)}   ${skillFmt(sk)}`;
  lines.push(fmtRow("BULL", r.bull, r.trivialBull, r.skill.bull));
  lines.push(fmtRow("BASE", r.base, r.trivialBase, r.skill.base));
  lines.push(fmtRow("BEAR", r.bear, r.trivialBear, r.skill.bear));
  lines.push(fmtRow("TOTAL", r.total, r.trivialTotal, r.skill.total));
  lines.push("");
  lines.push(sectionRule("HIT RATE"));
  const hitPct = pct(r.topPickHitRate);
  const alwaysTop = Math.max(rB, rM, rR);
  const topName = alwaysTop === rM ? "base" : alwaysTop === rB ? "bull" : "bear";
  let ciText = "";
  try {
    if (r.topPickN > 0) {
      const ci = betaBinomialCI(r.topPickHits, r.topPickN);
      ciText = `   95% CI [${pct(ci.lower95)}, ${pct(ci.upper95)}]`;
    }
  } catch { /* CI optional */ }
  lines.push(`  Top-pick realized  ${r.topPickHits}/${r.topPickN} = ${hitPct}${ciText}`);
  lines.push(`  always-${topName} would have scored ${pct(alwaysTop)} on the same days${ciText ? "; read the CI against that, not against 33%" : ""}`);

  if (inp.forecastProbs) {
    try {
      const fp = inp.forecastProbs;
      const rows: Array<[string, number]> = [["BULL", resolutionScore(fp.bull)], ["BASE", resolutionScore(fp.base)], ["BEAR", resolutionScore(fp.bear)]];
      lines.push("");
      lines.push(sectionRule("RESOLUTION (variance of the forecast across days; 0 = the same number every day)"));
      for (const [name, v] of rows) lines.push(`  ${pad(name, 8)} ${fmt3(v)}  (${gradeResolution(v).label})`);
    } catch { /* optional */ }
  }
  if (inp.watchdog) {
    const w = inp.watchdog;
    const badge =
      w.status === "HEALTHY" ? "HEALTHY" :
      w.status === "NO_SKILL" ? "NO DEMONSTRATED SKILL" :
      w.status === "DRIFTING" ? "DRIFTING" :
      w.status === "BROKEN" ? "BROKEN" :
      "WARMING UP";
    lines.push("");
    lines.push(sectionRule("WATCHDOG (CUSUM vs climatology, target = zero skill)"));
    lines.push(`  ${badge}   c=${w.cValue.toFixed(3)}   baseline=${w.baseline.toFixed(3)}   n=${w.n}`);
    lines.push(`  ${w.reason}`);
  }
  lines.push("```");
  lines.push("*Pulse Batcave  |  measurement only  |  a measurement, not a verdict*");
  return lines.join("\n");
}

