// server/discord.ts
//
// Pulse Batcave → Discord webhook poster.
//
// All formatters are DETERMINISTIC string templates pulled strictly from our
// own internal HTTP endpoints — no LLM, no external APIs, no ad-libbing.
// User rule (verbatim): "the briefing should be strictley from are data and
// calculations".
//
// Three card types:
//   1. SPX daily model card — fired once at 9:30 ET via discordScheduler
//   2. Level break / gamma flip alerts — fired by alertEngine on detection
//   3. Major news — fired by alertEngine when a high-impact event drops
//
// Discord webhook format: rich embeds (limit 10 per message, 6000 chars total).
// We use one embed per card.

const WEBHOOK_URL =
  process.env.PULSE_DISCORD_WEBHOOK ??
  // Hardcoded fallback for the user's channel. Override via env in prod.
  "https://discord.com/api/webhooks/1318055174576803860/egM4Fx5DcOnxX3fOkbCxmywkgvwgmJWC2B7O1geDKkF-6cFjpN4mspLlPWCZkrBn4Li6";

const PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${PORT}`;

// Pulse Batcave brand colors (hex → int for Discord)
const COLOR_BULL = 0x16a34a;     // green-600
const COLOR_BEAR = 0xdc2626;     // red-600
const COLOR_NEUTRAL = 0x3b82f6;  // blue-500
const COLOR_WARNING = 0xf59e0b;  // amber-500
const COLOR_ALERT = 0xef4444;    // red-500

// ─── Discord embed type ──────────────────────────────────────────────────
interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  url?: string;
}

interface DiscordPayload {
  username?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

// ─── Webhook poster ──────────────────────────────────────────────────────
async function postToDiscord(payload: DiscordPayload): Promise<boolean> {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[discord] webhook HTTP ${res.status}: ${txt.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[discord] webhook failed: ${e?.message ?? e}`);
    return false;
  }
}

// ─── Internal API fetchers ──────────────────────────────────────────────
async function fetchModels(symbol = "SPX"): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/api/models?symbol=${symbol}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchNews(): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/api/news`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Formatters ──────────────────────────────────────────────────────────
function fmtPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtPct(n: number | null | undefined, sign = true): string {
  if (n == null || !isFinite(n)) return "—";
  const s = sign ? (n >= 0 ? "+" : "") : "";
  return `${s}${n.toFixed(2)}%`;
}

function fmtBps(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return `${s}${Math.round(n)}bps`;
}

function statusEmoji(status: string): string {
  if (status === "broken") return "✕";
  if (status === "approaching") return "○";
  return "●"; // held / default
}

function gammaZoneLabel(zone: string): string {
  return zone === "y+" ? "γ+ (dampened)" : "γ− (volatile)";
}

// ─── Card 1: SPX daily model ─────────────────────────────────────────────
//
// Mirrors the SelzTrades-style mockup the user approved. Pulls strictly from
// /api/models — spot, scenarioProb, levels (with #4 status), rangeBox (#3),
// gammaZone, dfi, vix term ratio. All data, no LLM.
export async function postDailyModelCard(): Promise<boolean> {
  const data = await fetchModels("SPX");
  if (!data) {
    console.warn("[discord] daily card: /api/models returned null");
    return false;
  }
  const daily = data.horizons?.daily;
  if (!daily) {
    console.warn("[discord] daily card: missing horizons.daily");
    return false;
  }

  const spot = daily.spot ?? null;
  const audit = daily.audit ?? {};
  const scen = audit.scenarioProb ?? { bull: 0, base: 0, bear: 0 };
  const gammaZone = audit.gammaZone ?? "y+";
  const dfi = audit.dfi ?? 0;
  const vix = data.vol?.vix ?? null;
  const termRatio = data.vol?.termRatio ?? null;
  const termLabel = data.vol?.termLabel ?? "";

  // Pick scenario color from highest-weight outcome
  const top = scen.bull >= scen.bear && scen.bull >= scen.base
    ? "bull"
    : scen.bear >= scen.base ? "bear" : "base";
  const color =
    top === "bull" ? COLOR_BULL :
    top === "bear" ? COLOR_BEAR : COLOR_NEUTRAL;

  // Levels — show top 4 nearest to spot
  const levels = (daily.levels ?? []) as Array<any>;
  const sortedLevels = [...levels]
    .filter((l) => l.price != null)
    .sort((a, b) => Math.abs((a.distBps ?? 0)) - Math.abs((b.distBps ?? 0)))
    .slice(0, 4);

  const levelsBlock = sortedLevels.length > 0
    ? sortedLevels.map((l) => {
        const sym = statusEmoji(l.status ?? "held");
        const name = (l.name ?? l.kind ?? "").padEnd(14);
        const px = fmtPrice(l.price);
        const dist = fmtBps(l.distBps);
        return `\`${sym} ${name} ${px}  ${dist}\``;
      }).join("\n")
    : "_no levels_";

  // Range box (#3)
  const rb = daily.rangeBox;
  const rangeBlock = rb
    ? `**${fmtPrice(rb.low)} – ${fmtPrice(rb.high)}** (${rb.widthPct?.toFixed(2) ?? "—"}%)\n` +
      `breakout > ${fmtPrice(rb.breakoutTrigger)}  ·  breakdown < ${fmtPrice(rb.breakdownTrigger)}\n` +
      `status: \`${rb.status?.toUpperCase() ?? "—"}\``
    : "_no range_";

  // Scenario bar (visual, deterministic)
  const bar = (pct: number) => {
    const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
    return "█".repeat(n) + "░".repeat(10 - n);
  };
  const scenarioBlock =
    `\`bull ${String(scen.bull).padStart(2)}% ${bar(scen.bull)}\`\n` +
    `\`base ${String(scen.base).padStart(2)}% ${bar(scen.base)}\`\n` +
    `\`bear ${String(scen.bear).padStart(2)}% ${bar(scen.bear)}\``;

  // Vol context line
  const volLine =
    vix != null
      ? `VIX ${vix.toFixed(2)}` +
        (termRatio != null ? `  ·  term ${termRatio.toFixed(2)} (${termLabel})` : "")
      : "_vol unavailable_";

  const embed: DiscordEmbed = {
    title: `SPX · Daily Model · ${fmtPrice(spot)}`,
    description: `${gammaZoneLabel(gammaZone)}  ·  DFI ${dfi >= 0 ? "+" : ""}${dfi.toFixed(2)}  ·  ${volLine}`,
    color,
    fields: [
      { name: "Scenarios", value: scenarioBlock, inline: false },
      { name: "Range Box", value: rangeBlock, inline: false },
      { name: "Levels (nearest)", value: levelsBlock, inline: false },
    ],
    footer: { text: "Pulse Batcave · strictly from internal data · no LLM" },
    timestamp: new Date().toISOString(),
  };

  return await postToDiscord({
    username: "Pulse Batcave",
    embeds: [embed],
  });
}

// ─── Card 2: level break alert ───────────────────────────────────────────
export async function postLevelBreakAlert(args: {
  level: { name: string; kind: string; price: number; side: string };
  prevStatus: string;
  newStatus: string;
  spot: number;
}): Promise<boolean> {
  const { level, prevStatus, newStatus, spot } = args;
  const direction =
    newStatus === "broken"
      ? (level.side === "resistance" ? "BROKEN UP through" : "BROKEN DOWN through")
      : "approaching";
  const color = newStatus === "broken"
    ? (level.side === "resistance" ? COLOR_BULL : COLOR_BEAR)
    : COLOR_WARNING;

  const embed: DiscordEmbed = {
    title: `SPX · ${level.name} · ${direction}`,
    description: `Spot **${fmtPrice(spot)}** vs ${level.kind} **${fmtPrice(level.price)}**\nstatus: \`${prevStatus}\` → \`${newStatus}\``,
    color,
    footer: { text: "Pulse Batcave · level status (#4)" },
    timestamp: new Date().toISOString(),
  };

  return await postToDiscord({
    username: "Pulse Batcave",
    embeds: [embed],
  });
}

// ─── Card 3: gamma flip alert ────────────────────────────────────────────
export async function postGammaFlipAlert(args: {
  prevZone: string;
  newZone: string;
  spot: number;
  gammaZero: number | null;
}): Promise<boolean> {
  const { prevZone, newZone, spot, gammaZero } = args;
  const into = newZone === "y+" ? "DAMPENED" : "VOLATILE";
  const color = newZone === "y+" ? COLOR_BULL : COLOR_BEAR;

  const embed: DiscordEmbed = {
    title: `SPX · γ-ZONE FLIP · into ${into}`,
    description:
      `Regime changed: \`${gammaZoneLabel(prevZone)}\` → \`${gammaZoneLabel(newZone)}\`\n` +
      `Spot **${fmtPrice(spot)}**` +
      (gammaZero != null ? `  ·  γ-zero **${fmtPrice(gammaZero)}**` : ""),
    color,
    footer: { text: "Pulse Batcave · gamma regime" },
    timestamp: new Date().toISOString(),
  };

  return await postToDiscord({
    username: "Pulse Batcave",
    embeds: [embed],
  });
}

// ─── Card 4: major news alert ────────────────────────────────────────────
export async function postNewsAlert(args: {
  kind: string;     // FOMC | CPI | NFP | etc
  title: string;
  whenLabel: string;
  forecast?: string | null;
  previous?: string | null;
}): Promise<boolean> {
  const { kind, title, whenLabel, forecast, previous } = args;
  const fp =
    (forecast || previous)
      ? `\nforecast: \`${forecast ?? "—"}\`  ·  prev: \`${previous ?? "—"}\``
      : "";

  const embed: DiscordEmbed = {
    title: `📅 ${kind} · ${title}`,
    description: `**${whenLabel}**${fp}`,
    color: COLOR_ALERT,
    footer: { text: "Pulse Batcave · macro calendar" },
    timestamp: new Date().toISOString(),
  };

  return await postToDiscord({
    username: "Pulse Batcave",
    embeds: [embed],
  });
}

// ─── Test poster (used by /api/discord/test) ─────────────────────────────
export async function fireTestCard(): Promise<{ ok: boolean; note: string }> {
  const ok = await postDailyModelCard();
  return {
    ok,
    note: ok ? "test SPX daily card sent" : "webhook post failed — check logs",
  };
}
