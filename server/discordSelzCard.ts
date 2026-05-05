// server/discordSelzCard.ts
//
// SelzTrades-format daily SPX print for Pulse Batcave.
//
// Mirrors the user's reference print verbatim:
//
//   **SPX DAILY MODEL  |  YYYY-MM-DD  |  HH:MM ET  |  SPOT N  |  DFI ±N (LABEL)**
//   ```
//   CLOSE TARGETS
//     BULL P%  →  ~T
//     BASE P%  →  ~T
//     BEAR P%  →  ~T
//
//   CURRENT RANGE:  L – H  (VOL CONTAINED|BREAKOUT|BREAKDOWN)
//     <prose>
//     Breakout above H = bull trigger.  Break below L = bear trigger.
//
//   ━━━  RESISTANCE  ━━━━━…
//     <NAME> <PRICE>
//       <STATUS> → <annotation>
//   ...
//   ━━━  SUPPORT  ━━━━━…
//   ...
//   ━━━  CALLS / PUTS  ━━━…
//     CALLS ON above γ-zero+  →  N → N → γ-WALL N
//     NEUTRAL ZONE  L – H
//     PUTS  ON below γ-zero-  →  N → N → N
//   ```
//
// Strictly deterministic: every line keys off `/api/models` + `/api/quotes`.
// No LLM, no external API calls. Annotations are a fixed lookup keyed by
// `level.kind × status`, formatted with neighbor prices when needed.

import { recordPrediction } from "./calibration";
import { formatDecisionBlock } from "./decisionSupport";

const PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${PORT}`;

const WEBHOOK_URL =
  process.env.PULSE_DISCORD_WEBHOOK ??
  "https://discord.com/api/webhooks/1318055174576803860/egM4Fx5DcOnxX3fOkbCxmywkgvwgmJWC2B7O1geDKkF-6cFjpN4mspLlPWCZkrBn4Li6";

// ─── helpers ─────────────────────────────────────────────────────────────
function fmt0(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return Math.round(n).toString();
}
function fmt2(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(2);
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function fetchJSON(path: string): Promise<any | null> {
  return fetch(`${BASE}${path}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

// ─── deterministic annotation table ──────────────────────────────────────
// Keyed by canonical kind. Functions get level + spot + sorted neighbor
// arrays so they can name the next anchor explicitly. Output is the prose
// after "STATUS → ".
type AnnArgs = {
  level: any;
  spot: number;
  resistAbove: any[]; // sorted ascending
  supportBelow: any[]; // sorted descending
};
type AnnFn = (a: AnnArgs) => string;

const ANNOTATIONS: Record<string, AnnFn> = {
  // RESISTANCE side
  upsidePivot: ({ level }) =>
    level.status === "broken"
      ? "pivot lost — gamma-positive opens above"
      : "thin gamma — reversion likely unless power hour push",
  upperVomma: () => "vomma cluster — vol-of-vol pin overhead",
  callWall: () => "max gamma pin — dominant EOD attractor on breakout",
  dominantMag: ({ level }) =>
    `magnet zone — dealers absorb supply at ${fmt0(level.price)}`,
  charmTarget: ({ level }) =>
    level.side === "resistance"
      ? "charm drag pulls price up into pin"
      : "charm drag loses grip — downside opens",
  charmFlip: ({ level, resistAbove, supportBelow }) => {
    if (level.side === "resistance") {
      const next = resistAbove.find((l) => l.price > level.price);
      return `momentum accelerates — path opens to ${next ? fmt0(next.price) : "open road"}`;
    }
    const next = supportBelow.find((l) => l.price < level.price);
    return `charm drag loses grip — downside opens${next ? ` to ${fmt0(next.price)}` : ""}`;
  },
  charmFloor: ({ supportBelow }) => {
    const next = supportBelow[0];
    return `charm drag floor — break opens to ${next ? fmt0(next.price) : "downside"}`;
  },
  charmCeiling: ({ resistAbove }) => {
    const next = resistAbove[0];
    return `charm drag ceiling — break opens to ${next ? fmt0(next.price) : "upside"}`;
  },
  zommaBridge: () => "zomma bridge — gamma curvature transition",
  negGammaEntry: ({ resistAbove }) => {
    const next = resistAbove.find((l) => l.kind === "zeroGamma" || l.kind === "callWall");
    return `negative-gamma entry — break opens to ${next ? fmt0(next.price) : "upside"}`;
  },

  // gamma flip (reused both sides)
  zeroGamma: ({ level, resistAbove, supportBelow }) => {
    const above = level.side === "resistance";
    if (above) {
      const next = resistAbove.find((l) => l.price > level.price);
      return `gamma flips positive — dealers start buying${next ? ` → ${fmt0(next.price)}` : ""}`;
    }
    const next = supportBelow.find((l) => l.price < level.price);
    return `gamma flips negative — vol expansion starts${next ? ` → ${fmt0(next.price)}` : ""}`;
  },

  // SUPPORT side
  mainPivot: ({ supportBelow }) => {
    const next = supportBelow[0]; // first below mainPivot
    return `bull/bear line — break + hold below = path to ${next ? fmt0(next.price) : "downside"}`;
  },
  strongMag: ({ level }) =>
    level.side === "resistance"
      ? `magnet zone — dealers absorb supply at ${fmt0(level.price)}`
      : `magnet support at ${fmt0(level.price)} — dealers absorb demand`,
  extremeVac: () => "extreme vacuum — air-pocket below",
  putWall: () => "max negative gamma pin — capitulation level",
  mopexMaxPain: () => "max pain anchor — strikes pulling toward expiry",
  lowerVomma: () => "vomma cluster — vol-of-vol pin below",
  downsidePivot: () => "downside pivot — structure breaks below",
  t1Down: () => "T1 downside extension — momentum target",
  t2Down: () => "T2 downside extension — high-IV target",
  t1Up: () => "T1 upside extension — momentum target",
  t2Up: () => "T2 upside extension — high-IV target",
};

function annotate(a: AnnArgs): string {
  const fn = ANNOTATIONS[a.level.kind];
  if (fn) return fn(a);
  return a.level.side === "resistance" ? "structural resistance" : "structural support";
}

// Display name & icon per kind — Selz uses γ-WALL, MAIN PIVOT, CHARM FLOOR etc.
const DISPLAY_NAME: Record<string, string> = {
  callWall: "γ-WALL",
  putWall: "γ-PUT WALL",
  zeroGamma: "γ-ZERO",
  mainPivot: "MAIN PIVOT",
  charmTarget: "CHARM TARGET",
  charmFlip: "CHARM FLIP",
  charmFloor: "CHARM FLOOR",
  charmCeiling: "CHARM CEILING",
  strongMag: "STRONG MAG",
  dominantMag: "DOMINANT MAG",
  upsidePivot: "UPSIDE PIVOT",
  upperVomma: "UPPER VOMMA",
  zommaBridge: "ZOMMA BRIDGE",
  negGammaEntry: "NEG Γ ENTRY",
  extremeVac: "EXTREME VAC",
  mopexMaxPain: "MOPEX MAX PAIN",
  lowerVomma: "LOWER VOMMA",
  downsidePivot: "DOWNSIDE PIVOT",
  t1Up: "T1 UP",
  t2Up: "T2 UP",
  t1Down: "T1 DOWN",
  t2Down: "T2 DOWN",
};
const displayName = (kind: string, fallback: string) =>
  DISPLAY_NAME[kind] ?? fallback;

// Tactical band: levels within ±TACTICAL_BAND of spot are far more relevant
// to intraday trading than far structural anchors. Selz-style prints stay
// inside this band almost exclusively. Fill from outside only if tactical
// pool is short.
const TACTICAL_BAND = 40; // $40 ≈ ~0.55% on SPX 7250

// Pick the top n most-relevant levels per side. Strategy:
//   1. Take all dedup'd levels in the tactical band, sorted by distance to spot
//   2. If we still need more, fill from outside the band (closest first)
function pickTopLevels(side: "resistance" | "support", levels: any[], spot: number, n = 3): any[] {
  const filtered = levels.filter((l) => l.side === side);
  const dist = (p: number) => Math.abs(p - spot);
  // Sort by distance to spot — closest first regardless of side
  filtered.sort((a, b) => dist(a.price) - dist(b.price));

  // Dedupe by integer price
  const seen = new Set<string>();
  const dedup: any[] = [];
  for (const l of filtered) {
    const key = l.price.toFixed(0);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(l);
  }

  const tactical = dedup.filter((l) => dist(l.price) <= TACTICAL_BAND);
  const structural = dedup.filter((l) => dist(l.price) > TACTICAL_BAND);
  const out = [...tactical, ...structural].slice(0, n);
  return out;
}

function statusWord(status: string): string {
  if (status === "broken") return "BREAK";
  if (status === "approaching") return "NEAR";
  return "HELD";
}

// Header date in ET like 2026-05-01
function etDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function etTime(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ET`;
}

// ─── main poster ─────────────────────────────────────────────────────────
export async function postSelzDailyCard(): Promise<{ ok: boolean; preview: string }> {
  const [data, quotes] = await Promise.all([
    fetchJSON("/api/models?symbol=SPX"),
    fetchJSON("/api/quotes"),
  ]);
  if (!data) return { ok: false, preview: "models endpoint failed" };
  const daily = data?.horizons?.daily;
  if (!daily) return { ok: false, preview: "daily horizon missing" };

  const spot = daily.spot ?? 0;
  const audit = daily.audit ?? {};
  const sp = audit.scenarioProb ?? { bull: 0, base: 0, bear: 0 };
  const st = audit.scenarioTargets ?? { bull: spot, base: spot, bear: spot, oneDayEM: spot * 0.005 };
  // DFI: audit.dfi is normalized to [-5, +5]-ish. Multiply by 100 for display
  // but cap at ±499 so we don't pin at the visual ceiling on every print.
  const dfiRaw = (audit.dfi ?? 0) * 100;
  const dfi = Math.max(-499, Math.min(499, dfiRaw));
  const dfiLabel = dfi >= 100 ? "BULLISH" : dfi <= -100 ? "BEARISH" : "NEUTRAL";
  const rb = daily.rangeBox;
  const rbStatus = rb?.status ?? "contained";
  const rbStatusLabel =
    rbStatus === "breakout" ? "BREAKOUT"
    : rbStatus === "breakdown" ? "BREAKDOWN"
    : "VOL CONTAINED";

  // Synthesize charm-flip levels from audit.charmZeros (upper = resistance,
  // lower = support). Only synthesize when within tactical band of spot —
  // far charm zeros aren't tradeable intraday landmarks.
  const baseLevels = ((daily.levels ?? []) as any[]).slice();
  const charmZeros = (audit.charmZeros ?? []) as number[];
  for (const cz of charmZeros) {
    if (Math.abs(cz - spot) > 200) continue; // skip far charm zeros
    if (cz > spot) {
      baseLevels.push({
        kind: "charmFlip",
        side: "resistance",
        price: cz,
        status: "held",
        name: "CHARM FLIP",
      });
    } else {
      baseLevels.push({
        kind: "charmFloor",
        side: "support",
        price: cz,
        status: "held",
        name: "CHARM FLOOR",
      });
    }
  }
  const levels = baseLevels;

  // Range boundary identification — used for de-dup logic, NOT for blanket
  // exclusion. The breakout/breakdown anchor IS the most important tactical
  // level (it's literally the trigger line) and must show at the top of the
  // ladder. We only want to dedupe if MULTIPLE level kinds collapse onto the
  // same boundary price (e.g. callWall + strongMag both at rb.high).
  const RANGE_TOL = 0.6;
  const isAtPrice = (a: number, b: number) => Math.abs(a - b) < RANGE_TOL;

  const resistAbove = levels
    .filter((l) => l.side === "resistance" && l.price > spot)
    .sort((a, b) => a.price - b.price);
  const supportBelow = levels
    .filter((l) => l.side === "support" && l.price < spot)
    .sort((a, b) => b.price - a.price);

  // For the displayed top-3 ladders we want the structural anchor first.
  // Pick top-3 normally, then if rb.high (breakout anchor) isn't in the
  // resistance ladder, prepend it; same for rb.low on support side.
  const topResist = pickTopLevels("resistance", levels, spot, 3);
  const topSupport = pickTopLevels("support", levels, spot, 3);

  // Promote the range-anchor level to the top of its ladder when missing.
  // Anchor is identified by rb.anchorHigh.kind / rb.anchorLow.kind so the
  // displayed name and annotation come from the canonical kind, not a
  // synthesized stub.
  const promoteAnchor = (
    side: "resistance" | "support",
    ladder: any[],
    anchorPrice: number | undefined,
    anchorKind: string | undefined,
  ): any[] => {
    if (anchorPrice == null || !anchorKind) return ladder;
    const already = ladder.some((l) => isAtPrice(l.price, anchorPrice));
    if (already) return ladder;
    const anchorLevel = levels.find(
      (l) => l.side === side && isAtPrice(l.price, anchorPrice) && l.kind === anchorKind,
    ) ?? levels.find((l) => l.side === side && isAtPrice(l.price, anchorPrice));
    if (!anchorLevel) return ladder;
    return [anchorLevel, ...ladder].slice(0, 3);
  };
  const topResistFinal = promoteAnchor(
    "resistance",
    topResist,
    rb?.high,
    rb?.anchorHigh?.kind,
  );
  const topSupportFinal = promoteAnchor(
    "support",
    topSupport,
    rb?.low,
    rb?.anchorLow?.kind,
  );

  // calls / puts trigger lines: γ-zero crossings if available, else range edges
  // Fall back through audit.gammaZero (numeric) if level lookup fails.
  const auditGammaZero = (audit.gammaZero ?? null) as number | null;
  const gammaZeroAbove =
    resistAbove.find((l) => l.kind === "zeroGamma")?.price ??
    (auditGammaZero != null && auditGammaZero > spot ? auditGammaZero : null);
  const gammaZeroBelow =
    supportBelow.find((l) => l.kind === "zeroGamma")?.price ??
    (auditGammaZero != null && auditGammaZero < spot ? auditGammaZero : null);

  // EM-based hard fallback so triggers are NEVER null/0
  const oneDayEM = (st.oneDayEM ?? spot * 0.005) as number;

  // Calls path: γ-zero+ trigger, then 2 ascending resistances above it, then
  // call wall as terminal target — only if wall is genuinely above the last
  // mid-path price (otherwise wall is the trigger itself or behind us).
  const callWallPx = resistAbove.find((l) => l.kind === "callWall")?.price ?? null;
  let callsTrigger = gammaZeroAbove ?? callWallPx ?? (rb?.high ?? null);
  if (callsTrigger == null || callsTrigger <= spot) {
    callsTrigger = spot + oneDayEM;
  }
  const callsMidPath = resistAbove
    .filter((l) => l.kind !== "zeroGamma" && l.kind !== "callWall" && l.price > callsTrigger)
    .slice(0, 2)
    .map((l) => l.price)
    .sort((a, b) => a - b); // ascending
  // Wall is a terminal target only when strictly above the last mid (or above trigger if no mid)
  const lastMid = callsMidPath.length ? callsMidPath[callsMidPath.length - 1] : callsTrigger;
  const includeCallWall = callWallPx != null && callWallPx > lastMid + 0.5;
  const callsPathRaw = [callsTrigger, ...callsMidPath, ...(includeCallWall ? [callWallPx as number] : [])];
  const callsPath: number[] = [];
  for (const p of callsPathRaw) {
    if (p != null && (callsPath.length === 0 || Math.abs(callsPath[callsPath.length - 1] - p) > 0.5)) {
      callsPath.push(p);
    }
  }

  // Puts path: γ-zero- trigger, then 2 descending supports below, then main
  // pivot / put wall as terminal. Dedupe similarly.
  const putWallPx = supportBelow.find((l) => l.kind === "putWall")?.price ?? null;
  // mainPivot is only useful as a downside trigger if it's BELOW spot;
  // when above spot it's a resistance landmark, not a put trigger.
  const auditMainPivot = (audit.mainPivot ?? null) as number | null;
  const mainPivotBelow = auditMainPivot != null && auditMainPivot < spot ? auditMainPivot : null;
  let putsTrigger = gammaZeroBelow ?? mainPivotBelow ?? (rb?.low ?? null);
  if (putsTrigger == null || putsTrigger >= spot || putsTrigger <= 0) {
    putsTrigger = spot - oneDayEM;
  }
  const putsMidPath = supportBelow
    .filter((l) => l.kind !== "zeroGamma" && l.kind !== "putWall" && l.price < putsTrigger)
    .slice(0, 2)
    .map((l) => l.price)
    .sort((a, b) => b - a); // descending
  const putsLastMid = putsMidPath.length ? putsMidPath[putsMidPath.length - 1] : putsTrigger;
  const putsTerminalRaw = putWallPx ?? mainPivotBelow ?? null;
  const putsTerminal = (putsTerminalRaw != null && putsTerminalRaw < putsLastMid - 0.5) ? putsTerminalRaw : null;
  const putsPathRaw = [putsTrigger, ...putsMidPath, ...(putsTerminal ? [putsTerminal] : [])];
  const putsPath: number[] = [];
  for (const p of putsPathRaw) {
    if (p != null && (putsPath.length === 0 || Math.abs(putsPath[putsPath.length - 1] - p) > 0.5)) {
      putsPath.push(p);
    }
  }

  // ─── format the print ────────────────────────────────────────────────
  const header =
    `**SPX DAILY MODEL  |  ${etDate()}  |  ${etTime()}  |  SPOT ${fmt0(spot)}  |  DFI ${dfi >= 0 ? "+" : ""}${fmt0(dfi)} (${dfiLabel})**`;

  const close =
    `CLOSE TARGETS\n` +
    `  BULL ${pad(String(sp.bull) + "%", 4)}  →  ~${fmt0(st.bull)}\n` +
    `  BASE ${pad(String(sp.base) + "%", 4)}  →  ~${fmt0(st.base)}\n` +
    `  BEAR ${pad(String(sp.bear) + "%", 4)}  →  ~${fmt0(st.bear)}`;

  const rangeProse = (() => {
    if (!rb) return "  Spot is mid-range; no clear compression.";
    if (rbStatus === "contained") {
      return `  Spot ${fmt0(spot)} is compressing inside the charm drag band.`;
    }
    if (rbStatus === "breakout") {
      return `  Spot ${fmt0(spot)} broke above ${fmt0(rb.high)} — bull regime active.`;
    }
    return `  Spot ${fmt0(spot)} broke below ${fmt0(rb.low)} — bear regime active.`;
  })();

  const range = rb
    ? `CURRENT RANGE:  ${fmt0(rb.low)} – ${fmt0(rb.high)}  (${rbStatusLabel})\n` +
      rangeProse + `\n` +
      `  Breakout above ${fmt0(rb.high)} = bull trigger.  Break below ${fmt0(rb.low)} = bear trigger.`
    : `CURRENT RANGE:  no range data`;

  const sectionRule = (label: string) =>
    `━━━  ${label}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.slice(0, 60);

  const formatLevel = (l: any, side: "resistance" | "support") => {
    const name = displayName(l.kind, l.name);
    const px = fmt0(l.price);
    const status = statusWord(l.status);
    const ann = annotate({ level: l, spot, resistAbove, supportBelow });
    return `  ${name} ${px}\n    ${status} → ${ann}`;
  };

  const resistBlock =
    sectionRule("RESISTANCE") + "\n" +
    (topResistFinal.length
      ? topResistFinal.map((l) => formatLevel(l, "resistance")).join("\n")
      : "  no structural resistance above spot");

  const supportBlock =
    sectionRule("SUPPORT") + "\n" +
    (topSupportFinal.length
      ? topSupportFinal.map((l) => formatLevel(l, "support")).join("\n")
      : "  no structural support below spot");

  // Calls / puts trigger lines. Trigger is the first element; rest are
  // chained downstream targets. The path is already deduped above.
  const callsLine = callsPath.length > 0
    ? (() => {
        const trigger = callsPath[0];
        const downstream = callsPath.slice(1);
        // Tag the wall explicitly if it's the last element
        const downStr = downstream.length
          ? downstream
              .map((p, i) => (i === downstream.length - 1 && includeCallWall && Math.abs(p - (callWallPx as number)) < 0.5
                ? `γ-WALL ${fmt0(p)}`
                : fmt0(p)))
              .join(" → ")
          : "open";
        return `  CALLS ON above ${fmt0(trigger)}  →  ${downStr}`;
      })()
    : `  CALLS ON above ${fmt0(spot)}  →  open`;

  const neutralLine = rb
    ? `  NEUTRAL ZONE    ${fmt0(rb.low)} – ${fmt0(rb.high)}`
    : "";

  const putsLine = putsPath.length > 0
    ? (() => {
        const trigger = putsPath[0];
        const downstream = putsPath.slice(1);
        const downStr = downstream.length
          ? downstream
              .map((p, i) => (i === downstream.length - 1 && putWallPx && Math.abs(p - putWallPx) < 0.5
                ? `γ-PUT WALL ${fmt0(p)}`
                : fmt0(p)))
              .join(" → ")
          : "open";
        return `  PUTS  ON below  ${fmt0(trigger)}  →  ${downStr}`;
      })()
    : `  PUTS  ON below  ${fmt0(spot)}  →  open`;
  const callsPutsBlock =
    sectionRule("CALLS / PUTS") + "\n" +
    [callsLine, neutralLine, putsLine].filter(Boolean).join("\n");

  // Decision-support block (additive, never modifies existing card on failure)
  // Source: MASTER_SYNTHESIS Tier 1 — Kelly tile, base-rate strip, vol-drag,
  // P5/P95 close band. All four lines wrapped in their own try/catch inside
  // formatDecisionBlock, and the call itself is wrapped here so any throw
  // simply omits the block.
  let decisionBlock = "";
  try {
    decisionBlock = formatDecisionBlock({
      spot,
      probBull: (sp.bull ?? 0) / 100,
      probBase: (sp.base ?? 0) / 100,
      probBear: (sp.bear ?? 0) / 100,
      oneDayEM,
      // realizedSigma20d not in scope — formatter handles undefined gracefully
    });
  } catch {
    decisionBlock = "";
  }

  // Stitch the print
  const body = [
    "```",
    close,
    "",
    ...(decisionBlock ? [decisionBlock, ""] : []),
    range,
    "",
    resistBlock,
    "",
    supportBlock,
    "",
    callsPutsBlock,
    "```",
  ].join("\n");

  const footer = `*Pulse Batcave  |  strictly from internal data  |  no LLM*`;

  const content = `${header}\n${body}\n${footer}`;

  // Discord enforces 2000 char limit per message content. Truncate or split
  // if we exceed (rare given our compact format).
  const final = content.length > 1990 ? content.slice(0, 1985) + "\n…```" : content;

  // Record this prediction for calibration tracking. Read-only against the
  // calc — we just observe what was already computed and shipped.
  try {
    const etDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // YYYY-MM-DD
    const etHour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "2-digit", hour12: false,
      }).format(new Date()),
      10,
    );
    const etMin = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", minute: "2-digit",
      }).format(new Date()),
      10,
    );
    const isDailySlot = etHour === 9 && etMin === 30;
    recordPrediction({
      date: etDate,
      capturedAt: Math.floor(Date.now() / 1000),
      spot,
      targetBull: st.bull as number,
      targetBase: st.base as number,
      targetBear: st.bear as number,
      probBull: (sp.bull as number) / 100,
      probBase: (sp.base as number) / 100,
      probBear: (sp.bear as number) / 100,
      oneDayEm: oneDayEM,
      source: isDailySlot ? "daily" : "halfhour",
    });
  } catch (e: any) {
    console.warn(`[discordSelzCard] recordPrediction failed: ${e?.message ?? e}`);
  }

  // Post
  let ok = false;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Pulse Batcave", content: final }),
    });
    ok = res.ok;
    if (!ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[discordSelzCard] webhook ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.warn(`[discordSelzCard] webhook failed: ${e?.message ?? e}`);
  }

  return { ok, preview: final };
}
