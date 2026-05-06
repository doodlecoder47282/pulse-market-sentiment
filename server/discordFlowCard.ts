// ─────────────────────────────────────────────────────────────────────────────
// discordFlowCard.ts — WHALE flow alert formatter for Discord
//
// One embed per ticker. Hits ranked by premium desc.
// Title: "🐋 WHALE FLOW — $TICKER" (no emoji per project rules — replaced w/ text)
// Color: bullish=green / bearish=red / mixed=blue
// ─────────────────────────────────────────────────────────────────────────────

import { postToDiscord } from "./discord";
import type { WhaleHit } from "./flowAlertEngine";

const COLOR_BULL = 0x16a34a;
const COLOR_BEAR = 0xdc2626;
const COLOR_MIXED = 0x3b82f6;

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtHit(h: WhaleHit): string {
  // e.g. "$NVDA 145C 5/16 (11d) — $1.84M • vol/OI 14.2x • ABOVE_ASK"
  const side = h.type === "C" ? "C" : "P";
  const exp = h.expiration.slice(5).replace("-", "/"); // "05-16" -> "5/16"
  const ratioPart = h.isNewStrike && h.openInterest === 0
    ? "NEW STRIKE"
    : `vol/OI ${h.volOiRatio.toFixed(1)}x`;
  return [
    `**${h.strike}${side}** ${exp} (${h.dte}d)`,
    `${fmtMoney(h.premium)}`,
    ratioPart,
    `${h.tag}`,
  ].join(" • ");
}

/**
 * postWhaleFlowAlert — fire one Discord embed for a single ticker's whale prints.
 */
export async function postWhaleFlowAlert(
  ticker: string,
  hits: WhaleHit[],
): Promise<boolean> {
  try {
    if (hits.length === 0) return false;

    // Determine net sentiment for color
    const callPrem = hits.filter(h => h.type === "C").reduce((s, h) => s + h.premium, 0);
    const putPrem  = hits.filter(h => h.type === "P").reduce((s, h) => s + h.premium, 0);
    const netRatio = callPrem / Math.max(putPrem, 1);
    const color =
      netRatio > 1.5 ? COLOR_BULL :
      netRatio < 0.67 ? COLOR_BEAR :
      COLOR_MIXED;

    const totalPrem = callPrem + putPrem;
    const callCount = hits.filter(h => h.type === "C").length;
    const putCount  = hits.filter(h => h.type === "P").length;

    // Header summary line
    const summary = [
      `**Total whale premium:** ${fmtMoney(totalPrem)}`,
      `**Calls:** ${callCount} (${fmtMoney(callPrem)})  •  **Puts:** ${putCount} (${fmtMoney(putPrem)})`,
      `**C/P ratio:** ${netRatio.toFixed(2)}x`,
    ].join("\n");

    // Hit list — top 8 to stay under embed char limit
    const top = hits.slice(0, 8);
    const list = top.map((h, i) => `\`${String(i + 1).padStart(2)}.\` ${fmtHit(h)}`).join("\n");
    const moreLine = hits.length > 8 ? `\n_+ ${hits.length - 8} more whale print(s)_` : "";

    const description = `${summary}\n\n${list}${moreLine}`;

    return await postToDiscord({
      username: "Pulse Batcave — Whale Flow",
      embeds: [{
        title: `WHALE FLOW — $${ticker}`,
        description,
        color,
        footer: { text: `whale gate: $1M+ premium • vol/OI 10x+ OR new-strike • ABOVE_ASK • dte≥1` },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (e: any) {
    console.warn(`[discordFlowCard] post ${ticker} failed: ${e?.message ?? e}`);
    return false;
  }
}
