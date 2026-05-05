// server/calibrationCard.ts
//
// Weekly Pulse calibration card — posts to Discord every Sunday 8pm ET.
//
// Pure observer of pulse_outcomes. Does not touch any calc.
//
// Layout (locked, top-tier readable, matches Batcave card aesthetic):
//
//   **PULSE CALIBRATION  |  WEEK OF YYYY-MM-DD  |  N TRADING DAYS**
//   ```
//   ━━━  CALIBRATION GRADE (lower = sharper)  ━━━━━━━━━━━━━━━━━━━━━━━━━
//     BULL     0.082  (A,  excellent)   trivial 0.222
//     BASE     0.137  (B,  good     )   trivial 0.222
//     BEAR     0.071  (A,  excellent)   trivial 0.222
//     OVERALL  0.290  (B,  good     )   trivial 0.667
//
//   ━━━  HIT RATE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//     Top-pick scenario realized  64%  (vs 33% random baseline)
//
//   ━━━  REALIZED OUTCOME MIX  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//     BULL  21%  |  BASE  43%  |  BEAR  36%
//     <prose: structurally over/under-weighted scenarios>
//   ```
//   *Pulse Batcave  |  measurement only  |  no calc changes*
//
// Reference for grades (Brier score thresholds):
//   <0.06 elite | <0.10 excellent | <0.15 good | <0.20 fair | <0.25 weak | else poor

import { rollingBrier, gradeBrier, beatsTrivial, recentForecastProbs } from "./calibration";
import { resolutionScore, gradeResolution, betaBinomialCI } from "./stats";
import { watchdogStatus } from "./cusumWatchdog";

const WEBHOOK_URL =
  process.env.PULSE_DISCORD_WEBHOOK ??
  "https://discord.com/api/webhooks/1318055174576803860/egM4Fx5DcOnxX3fOkbCxmywkgvwgmJWC2B7O1geDKkF-6cFjpN4mspLlPWCZkrBn4Li6";

function fmt3(n: number): string {
  return n.toFixed(3);
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
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

  const gBull = gradeBrier(r.bull);
  const gBase = gradeBrier(r.base);
  const gBear = gradeBrier(r.bear);
  const gTotal = gradeBrier(r.total / 3); // total is sum of three, normalize for grading

  // Diagnostic prose for realized mix. Heuristic: if any scenario realizes
  // >45% or <20%, the model is structurally biased relative to actual
  // outcomes. We surface this as observation, not as a fix recommendation.
  const realizedNotes: string[] = [];
  const { bull: rB, base: rM, bear: rR } = r.realized;
  if (rM > 0.55) realizedNotes.push("base realizing more often than predicted — vol may be over-modeled");
  else if (rM < 0.30) realizedNotes.push("base realizing less often than predicted — vol may be under-modeled");
  if (rB > 0.40) realizedNotes.push("bull tail fattening — upside skew under-priced");
  if (rR > 0.40) realizedNotes.push("bear tail fattening — downside skew under-priced");
  if (Math.abs(rB - rR) > 0.20) {
    realizedNotes.push(`directional bias in outcomes (${rB > rR ? "bullish" : "bearish"} regime)`);
  }
  const realizedProse = realizedNotes.length > 0
    ? realizedNotes.map((s) => `  ${s}`).join("\n")
    : "  scenarios realizing in line with model predictions";

  // Trivial-forecaster delta — how much edge over a 1/3-1/3-1/3 baseline.
  const edgeBull = ((r.trivialBull - r.bull) / r.trivialBull) * 100;
  const edgeBase = ((r.trivialBase - r.base) / r.trivialBase) * 100;
  const edgeBear = ((r.trivialBear - r.bear) / r.trivialBear) * 100;
  const edgeTotal = ((r.trivialTotal - r.total) / r.trivialTotal) * 100;
  const edgeFmt = (e: number) =>
    e >= 0 ? `+${e.toFixed(0)}% sharper` : `${e.toFixed(0)}% worse`;

  const today = etDate();

  const sectionRule = (title: string) => {
    const bar = "━".repeat(Math.max(3, 60 - title.length));
    return `━━━  ${title}  ${bar}`;
  };

  const lines: string[] = [];
  lines.push(`**PULSE CALIBRATION  |  WEEK OF ${today}  |  ${r.n} TRADING DAYS**`);
  lines.push("```");
  lines.push(sectionRule("CALIBRATION GRADE (lower = sharper)"));
  const fmtRow = (
    name: string, brier: number, grade: { letter: string; label: string }, trivial: number, edge: number,
  ) => {
    const tag = `(${grade.letter}, ${pad(grade.label, 9)})`;
    const ed = pad(edgeFmt(edge), 16);
    return `  ${pad(name, 8)} ${fmt3(brier)}  ${tag}   trivial ${fmt3(trivial)}  ${ed}`;
  };
  lines.push(fmtRow("BULL", r.bull, gBull, r.trivialBull, edgeBull));
  lines.push(fmtRow("BASE", r.base, gBase, r.trivialBase, edgeBase));
  lines.push(fmtRow("BEAR", r.bear, gBear, r.trivialBear, edgeBear));
  // Total is sum of three squared errors; divide by 3 for an "average per
  // scenario" grade so it compares apples to apples with the per-scenario rows.
  const totalAvg = r.total / 3;
  const trivialAvg = r.trivialTotal / 3;
  lines.push(fmtRow("AVG", totalAvg, gTotal, trivialAvg, edgeTotal));
  lines.push("");
  lines.push(sectionRule("HIT RATE"));
  const hitPct = pct(r.topPickHitRate);
  const hitBeats = r.topPickHitRate > 0.34 ? "ABOVE" : "AT/BELOW";
  // Beta-Binomial 95% credible interval (MASTER_SYNTHESIS Tier 2 #8 — Very Normal).
  // Replaces the bare percentage with an honest "how confident are we" band.
  try {
    if (r.topPickN > 0) {
      const ci = betaBinomialCI(r.topPickHits, r.topPickN);
      lines.push(
        `  Top-pick realized  ${r.topPickHits}/${r.topPickN} = ${hitPct}   95% CI [${pct(ci.lower95)}, ${pct(ci.upper95)}]   (${hitBeats} 33% baseline)`,
      );
    } else {
      lines.push(`  Top-pick scenario realized  ${hitPct}  (${hitBeats} 33% random baseline)`);
    }
  } catch {
    lines.push(`  Top-pick scenario realized  ${hitPct}  (${hitBeats} 33% random baseline)`);
  }
  lines.push("");
  lines.push(sectionRule("REALIZED OUTCOME MIX"));
  lines.push(`  BULL  ${pct(rB)}  |  BASE  ${pct(rM)}  |  BEAR  ${pct(rR)}`);
  lines.push(realizedProse);

  // ─── Resolution & Watchdog (Tier 1/2) ─ additive observers, never modify calc
  // Resolution = variance of forecast probs (3-Min Data Science). High variance
  // means the model meaningfully differentiates days; low variance means it's
  // basically constant.
  // Watchdog = CUSUM on (brier_total - trivial_total). If the model stops
  // beating trivial, this trips and the user sees DRIFTING/BROKEN.
  try {
    const fp = recentForecastProbs(30);
    const rsBull = resolutionScore(fp.bull);
    const rsBase = resolutionScore(fp.base);
    const rsBear = resolutionScore(fp.bear);
    const gBullR = gradeResolution(rsBull);
    const gBaseR = gradeResolution(rsBase);
    const gBearR = gradeResolution(rsBear);
    lines.push("");
    lines.push(sectionRule("RESOLUTION (variance of forecast — higher = sharper discrim)"));
    const fmtRes = (name: string, r: number, g: { letter: string; label: string }) =>
      `  ${pad(name, 8)} ${fmt3(r)}  (${g.letter}, ${pad(g.label, 14)})`;
    lines.push(fmtRes("BULL", rsBull, gBullR));
    lines.push(fmtRes("BASE", rsBase, gBaseR));
    lines.push(fmtRes("BEAR", rsBear, gBearR));
  } catch (e) {
    // resolution section is optional — omit silently if anything throws
  }

  try {
    const w = watchdogStatus(60);
    const badge =
      w.status === "HEALTHY" ? "● HEALTHY" :
      w.status === "DRIFTING" ? "● DRIFTING" :
      w.status === "BROKEN" ? "● BROKEN" :
      "● WARMING UP";
    lines.push("");
    lines.push(sectionRule("WATCHDOG (CUSUM on edge-vs-trivial)"));
    lines.push(`  ${badge}   c=${w.cValue.toFixed(3)}   baseline=${w.baseline.toFixed(3)}   n=${w.n}`);
    lines.push(`  ${w.reason}`);
  } catch (e) {
    // watchdog section optional too
  }

  lines.push("```");
  lines.push(`*Pulse Batcave  |  measurement only  |  no calc changes*`);
  const final = lines.join("\n");

  const ok = await sendWebhook(final);
  return { ok, preview: final };
}

async function sendWebhook(content: string): Promise<boolean> {
  try {
    const res = await fetch(WEBHOOK_URL, {
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
    console.warn(`[calibrationCard] webhook failed: ${e?.message ?? e}`);
    return false;
  }
}
