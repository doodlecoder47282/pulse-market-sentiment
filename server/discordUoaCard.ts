// ─────────────────────────────────────────────────────────────────────────────
// discordUoaCard.ts — Discord embed for UOA cluster fires.
// One embed per cluster trigger. Routes to UOA_WEBHOOK_URL (falls back to whale).
// ─────────────────────────────────────────────────────────────────────────────

import { postToDiscord, UOA_WEBHOOK_URL } from "./discord";
import type { UoaCluster } from "./uoaScanner";

const COLOR_BULL = 0x16a34a;
const COLOR_BEAR = 0xdc2626;
const COLOR_NEUTRAL = 0x3b82f6;

function fmt$M(d: number): string {
  return `$${(d / 1_000_000).toFixed(2)}M`;
}
function fmt$K(d: number): string {
  return `$${(d / 1_000).toFixed(0)}K`;
}
function fmtPrem(d: number): string {
  return d >= 1_000_000 ? fmt$M(d) : fmt$K(d);
}

export async function postUoaClusterAlert(c: UoaCluster): Promise<boolean> {
  try {
    const color =
      c.sentiment === "BULLISH" ? COLOR_BULL :
      c.sentiment === "BEARISH" ? COLOR_BEAR : COLOR_NEUTRAL;

    const sideLabel = c.type === "C" ? "CALLS" : "PUTS";
    const distStr = c.distFromSpotPct !== undefined ? `${c.distFromSpotPct >= 0 ? "+" : ""}${c.distFromSpotPct.toFixed(1)}%` : "—";
    const beStr = c.breakevenPct !== undefined ? `${c.breakevenPct >= 0 ? "+" : ""}${c.breakevenPct.toFixed(1)}%` : "—";

    const fields = [
      { name: "Cluster",  value: `${c.hitCount} hits • ${fmtPrem(c.totalPremium)} total\n${c.sentiment} • ${c.bucket} cap tier`, inline: true },
      { name: "Contract", value: `${c.symbol} ${c.strike}${c.type} ${c.expiration.slice(5)}\n${c.dte}DTE • Δ${(c.avgDelta || 0).toFixed(2)} • IV ${(c.avgIv * 100).toFixed(0)}%`, inline: true },
      { name: "Levels",   value: `bid/ask ${c.bid.toFixed(2)}/${c.ask.toFixed(2)} (mid ${c.mid.toFixed(2)})\nspread ${c.spreadPct.toFixed(1)}% • spot ${c.spot ? c.spot.toFixed(2) : "—"}`, inline: true },
      { name: "Strike vs spot", value: distStr, inline: true },
      { name: "Breakeven %",    value: beStr, inline: true },
      { name: "Avg vol/OI",     value: `${c.avgVolOiRatio.toFixed(1)}x`, inline: true },
    ];

    const payload = {
      embeds: [{
        title: `UOA · ${c.symbol} ${sideLabel} cluster fired`,
        description: c.reason,
        color,
        fields,
        footer: { text: `Pulse Batcave · UOA scanner · ${c.bucket}-cap tier` },
        timestamp: new Date(c.firedAt ?? Date.now()).toISOString(),
      }],
    };

    return await postToDiscord(payload, UOA_WEBHOOK_URL);
  } catch (e: any) {
    console.warn(`[discordUoaCard] failed: ${e?.message ?? e}`);
    return false;
  }
}
