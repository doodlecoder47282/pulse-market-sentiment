// server/discordBatcaveCard.ts
//
// Batcave-format daily SPX print for Pulse Batcave.
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
import { chainAbove, chainBelow, playbookCopy } from "./levelPlaybook";
import { computeRealtimeTargets } from "./realtimeTargets";
import { getTodayEventContext } from "./volCalendar";

const PORT = Number(process.env.PORT ?? 5000);
const BASE = `http://127.0.0.1:${PORT}`;

// Model channel webhook — every-30-min refined-area card lands here.
// PULSE_DISCORD_MODEL_WEBHOOK overrides; falls back to dedicated model channel.
const WEBHOOK_URL =
  process.env.PULSE_DISCORD_MODEL_WEBHOOK ??
  "https://discord.com/api/webhooks/1501708521010499735/dltDgL_xkY_e5dImY_oYZW8B-d7HCpbnHGAwgMVdIBCuyN58ld04ptSNsr1xfdywtg5T";

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
  t1Down: ({ supportBelow }) => {
    const next = supportBelow[0];
    return next
      ? `first downside target — break + hold opens path to ${fmt0(next.price)}`
      : "first downside target — break opens path lower";
  },
  t2Down: () => "deeper downside extension — high-IV flush target",
  t1Up: ({ resistAbove }) => {
    const next = resistAbove[0];
    return next
      ? `first upside target — clean tag opens path to ${fmt0(next.price)}`
      : "first upside target — momentum extension";
  },
  t2Up: () => "deeper upside extension — high-IV squeeze target",
  gammaZero: ({ level, supportBelow, resistAbove }) => {
    if (level.side === "support") {
      const next = supportBelow[0];
      return next
        ? `gamma flips negative below — vol expansion → ${fmt0(next.price)}`
        : "gamma flips negative below — vol expansion starts";
    }
    const next = resistAbove[0];
    return next
      ? `gamma flip line — reclaim above unlocks ${fmt0(next.price)}`
      : "gamma flip line — reclaim opens upside";
  },
};

function annotate(a: AnnArgs): string {
  const fn = ANNOTATIONS[a.level.kind];
  if (fn) return fn(a);
  return a.level.side === "resistance" ? "structural resistance" : "structural support";
}

// Display name & icon per kind — Batcave uses γ-WALL, MAIN PIVOT, CHARM FLOOR etc.
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
  t1Up: "UPSIDE TARGET",
  t2Up: "T2 UPSIDE",
  t1Down: "DOWNSIDE TARGET",
  t2Down: "T2 DOWNSIDE",
  mainPivot: "MAIN PIVOT",
  gammaZero: "\u03b3-ZERO",
};
const displayName = (kind: string, fallback: string) =>
  DISPLAY_NAME[kind] ?? fallback;

// Tactical band: levels within ±TACTICAL_BAND of spot are far more relevant
// to intraday trading than far structural anchors. Batcave-style prints stay
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
export async function postBatcaveDailyCard(opts?: { dryRun?: boolean }): Promise<{ ok: boolean; preview: string }> {
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
  // Synthesize MAIN PIVOT only when not already represented by an existing
  // level kind. audit.mainPivot frequently coincides with `zeroGamma` (same
  // numeric price) — in that case we'd rather just promote zeroGamma into
  // the ladder (handled below in promoteNamedPivots), so check for collision
  // against ALL level kinds at that price first.
  const mp = (audit.mainPivot ?? null) as number | null;
  if (mp != null && Math.abs(mp - spot) <= TACTICAL_BAND * 3) {
    const collide = baseLevels.some((l: any) => Math.abs((l.price ?? 0) - mp) < 1);
    if (!collide) {
      baseLevels.push({
        kind: "mainPivot",
        side: mp >= spot ? "resistance" : "support",
        price: mp,
        status: "held",
        name: "MAIN PIVOT",
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
  const topResistFinal0 = promoteAnchor(
    "resistance",
    topResist,
    rb?.high,
    rb?.anchorHigh?.kind,
  );
  const topSupportFinal0 = promoteAnchor(
    "support",
    topSupport,
    rb?.low,
    rb?.anchorLow?.kind,
  );

  // Promote NAMED PIVOTS (mainPivot / zeroGamma / upsidePivot / downsidePivot)
  // into the top-3 ladder when present. These are anchor levels traders
  // expect to see by name on every card — they should never get filtered
  // out by tactical-band logic alone. We append them, sort by distance from
  // spot, then trim to 3.
  // Named pivots are reserved seats. mainPivot and zeroGamma always render
  // when present; upsidePivot/downsidePivot show when within 2x tactical band.
  // We reserve up to 2 of the 3 ladder slots for named pivots, and fill the
  // remainder with the closest non-named tactical levels.
  const NAMED_PIVOT_KINDS = new Set(["mainPivot", "zeroGamma", "upsidePivot", "downsidePivot"]);
  const promoteNamedPivots = (
    side: "resistance" | "support",
    ladder: any[],
  ): any[] => {
    const namedFromAll = levels.filter((l: any) =>
      l.side === side && NAMED_PIVOT_KINDS.has(l.kind) &&
      (side === "resistance" ? l.price > spot : l.price < spot),
    );
    if (!namedFromAll.length) return ladder;
    // Sort named pivots by distance ascending, take up to 2 reserved seats
    namedFromAll.sort((a: any, b: any) => Math.abs(a.price - spot) - Math.abs(b.price - spot));
    const reserved = namedFromAll.slice(0, 2);
    const reservedKeys = new Set(reserved.map((l: any) => Math.round(l.price * 100)));
    // Fill remaining slot(s) with non-named tactical levels from the ladder
    const fillers = ladder.filter((l: any) => !reservedKeys.has(Math.round(l.price * 100)));
    const needed = Math.max(0, 3 - reserved.length);
    const merged = [...reserved, ...fillers.slice(0, needed)];
    // Final sort: ascending price for resistance, descending for support
    return merged.sort((a, b) =>
      side === "resistance" ? a.price - b.price : b.price - a.price,
    );
  };
  const topResistFinal = promoteNamedPivots("resistance", topResistFinal0);
  const topSupportFinal = promoteNamedPivots("support", topSupportFinal0);

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

  // Real-time CLOSE TARGETS compression — collapses bull/bear toward base as
  // session ages. Blended (sqrt-time decay + spot reanchor + range-aware HOD/LOD),
  // regime-weighted via dfi/gammaZone/slope. Falls back to raw EOD on any error.
  let liveTargets = { bull: st.bull as number, base: st.base as number, bear: st.bear as number };
  let liveDiagLine = "";
  try {
    const rt = await computeRealtimeTargets({
      spot,
      scenarioTargets: st as any,
      audit,
      symbol: "^GSPC",
    });
    liveTargets = rt.compressed;
    const minsLeft = rt.diag.minutesRemaining;
    const compBullPct = Math.round(rt.diag.compressionPct.bull * 100);
    const compBearPct = Math.round(rt.diag.compressionPct.bear * 100);
    if (minsLeft < 380) {
      // Only show diag during RTH — not before open or after close
      liveDiagLine =
        `\n  LIVE — ${rt.diag.regime.toLowerCase()} • ${minsLeft}m left • ` +
        `bull −${compBullPct}% / bear −${compBearPct}% vs eod`;
    }
  } catch {
    // silent fallback to raw EOD targets
  }

  const close =
    `CLOSE TARGETS\n` +
    `  BULL ${pad(String(sp.bull) + "%", 4)}  →  ~${fmt0(liveTargets.bull)}  (eod ~${fmt0(st.bull)})\n` +
    `  BASE ${pad(String(sp.base) + "%", 4)}  →  ~${fmt0(liveTargets.base)}\n` +
    `  BEAR ${pad(String(sp.bear) + "%", 4)}  →  ~${fmt0(liveTargets.bear)}  (eod ~${fmt0(st.bear)})` +
    liveDiagLine;

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

  // ─── PIVOT AREAS block — dedicated up/down pivot summary with playbook ───
  // Pulled from the levels[] chain, NOT synthesized: the model already emits
  // upsidePivot / downsidePivot kinds. We grab the closest of each on the
  // correct side of spot and build a deterministic 'how to play' line using
  // the chain context (next level above / below the pivot).
  const upsidePivotLevel = levels
    .filter((l: any) => l.kind === "upsidePivot" && l.price > spot)
    .sort((a: any, b: any) => a.price - b.price)[0] ?? null;
  const downsidePivotLevel = levels
    .filter((l: any) => l.kind === "downsidePivot" && l.price < spot)
    .sort((a: any, b: any) => b.price - a.price)[0] ?? null;

  const pivotChain = (levels as any[]).map((l: any) => ({
    name: l.name, kind: l.kind, price: l.price, side: l.side, status: l.status,
  }));

  const buildPivotLine = (
    label: string,
    level: any | null,
    side: "resistance" | "support",
  ): string => {
    if (!level) return `  ${label}  —  not in tactical range`;
    const upChain = chainAbove(level.price, pivotChain, 2);
    const dnChain = chainBelow(level.price, pivotChain, 2);
    const distPts = Math.abs(level.price - spot).toFixed(0);
    const distPctStr = ((Math.abs(level.price - spot) / spot) * 100).toFixed(2);
    const dirArrow = side === "resistance" ? "↑" : "↓";
    const playbook = playbookCopy(level.kind, side, "approaching", upChain, dnChain);
    return `  ${label}  ${fmt0(level.price)}  (${dirArrow} ${distPts} pts · ${distPctStr}%)\n    HOW TO PLAY → ${playbook}`;
  };

  const pivotBlock =
    sectionRule("PIVOT AREAS") + "\n" +
    buildPivotLine("UPSIDE PIVOT  ", upsidePivotLevel, "resistance") + "\n" +
    buildPivotLine("DOWNSIDE PIVOT", downsidePivotLevel, "support");

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

  // Decision-support block (suggested size / stance / base rates / close band)
  // REMOVED per user 0DTE bot rules: no position sizing, no stance, alerts
  // only fire on actual setup triggers. Levels + structure + what to do at
  // each level — that's it.

  // Wick-zone block (intraday session-aware pivot for wick entries/exits)
  const wz = (audit as any).wickZones;
  const wickBlock = (wz && typeof wz.pivot === "number" && typeof wz.halfWidth === "number")
    ? sectionRule("WICK ZONES") + "\n" +
      `  PIVOT          ${fmt0(wz.pivot)}  (${wz.source})\n` +
      `  FADE-RIP from  ${fmt0(wz.upperEntry)} – ${fmt0(wz.upperExit)}  (sell calls / buy puts)\n` +
      `  BUY-DIP from   ${fmt0(wz.lowerEntry)} – ${fmt0(wz.lowerExit)}  (sell puts / buy calls)\n` +
      `  HALF-WIDTH     ±${wz.halfWidth.toFixed(1)}pt  (shrinks toward close)`
    : "";

  // EVENT DAY annotation (Papers I+J — Wright 2020 + Londono & Samadi 2025)
  const { eventDayKind: todayEvKind, expectedMoveBps: todayEvBps } = getTodayEventContext();
  const eventDayLine = todayEvKind
    ? `EVENT DAY: ${todayEvKind} - expected move ~${todayEvBps}bps annualized`
    : "";

  // VWAP/POC block (Paper F+O Wire 7 — Maróy 2025 + arxiv 2406.17198)
  // Only renders when vwapProfile is present and valid. ASCII only, no emojis.
  const vwapBlock = (() => {
    const vp = (audit as any).vwapProfile;
    if (!vp || typeof vp.vwap !== "number" || !isFinite(vp.vwap) || vp.vwap <= 0) return "";
    const spotN = Number(spot);
    const pctStr = (vp.spotVsVwap * 100).toFixed(2);
    const dir = vp.aboveVwap ? "above" : "below";
    const sign = vp.spotVsVwap >= 0 ? "+" : "";
    const stretchZ = vp.vwapStretchZ;
    const stretchSuffix =
      stretchZ != null && Math.abs(stretchZ) >= 1.5
        ? ` (stretchZ=${stretchZ.toFixed(2)})`
        : "";
    return (
      `VWAP/POC: VWAP=${vp.vwap.toFixed(1)} POC=${vp.poc.toFixed(1)} ` +
      `[VA ${vp.val.toFixed(1)}-${vp.vah.toFixed(1)}] ` +
      `spot ${spotN.toFixed(1)} (${sign}${pctStr}% ${dir}${stretchSuffix})`
    );
  })();

  // Wire 9: JUMP REGIME block (Paper M re-engineered)
  // Only renders when jumpRegime === true. Shows only the features that triggered.
  const jumpRegimeBlock = (() => {
    const jr = (audit as any).jumpRegime;
    const js = (audit as any).jumpScore;
    const jf = (audit as any).jumpFeatures;
    if (jr !== true || !jf) return "";
    const parts: string[] = [];
    if (jf.overnightGapPct != null && Math.abs(jf.overnightGapPct) >= 0.4) {
      const sign = jf.overnightGapPct >= 0 ? "+" : "";
      parts.push(`gap=${sign}${jf.overnightGapPct.toFixed(2)}%`);
    }
    if (jf.preMktRangePct != null && jf.preMktRangePct >= 0.5) {
      parts.push(`range=${jf.preMktRangePct.toFixed(2)}%`);
    }
    if (jf.gexSignFlip === true) {
      parts.push("gex_flip");
    }
    if (jf.vix1dChangePct != null && Math.abs(jf.vix1dChangePct) >= 5) {
      const sign = jf.vix1dChangePct >= 0 ? "+" : "";
      parts.push(`vix=${sign}${jf.vix1dChangePct.toFixed(1)}%`);
    }
    const scoreStr = js != null ? `${js}/4` : "?/4";
    const featStr = parts.length > 0 ? `: ` + parts.join(" ") : "";
    return `JUMP REGIME=true (score=${scoreStr}${featStr})`;
  })();

  // Wire 10: CHOP REGIME block (Paper C re-engineered)
  // Only renders when chopRegime === true.
  const chopRegimeBlock = (() => {
    const cr = (audit as any).chopRegime;
    const fb = (audit as any).chopFailedBreakCount;
    const pr = (audit as any).chopPivotReclaimCount;
    if (cr !== true) return "";
    const fbStr = fb != null ? fb : "?";
    const prStr = pr != null ? pr : "?";
    return `CHOP REGIME (failed breaks 60m=${fbStr}, pivot reclaims=${prStr})`;
  })();

  // Wire 11: VIX/SPX CORRELATION BREAKDOWN block (Paper L re-engineered)
  // Only renders when correlationBreakdown === true.
  const corrBreakdownBlock = (() => {
    const cb  = (audit as any).correlationBreakdown;
    const dir = (audit as any).correlationBreakdownDirection;
    const vp  = (audit as any).vixPctChange5m;
    const sp  = (audit as any).spxPctChange5m;
    if (cb !== true || dir == null) return "";
    const vixStr = vp != null ? `VIX ${vp >= 0 ? '+' : ''}${vp.toFixed(1)}%` : 'VIX n/a';
    const spxStr = sp != null ? `SPX ${sp >= 0 ? '+' : ''}${sp.toFixed(2)}%` : 'SPX n/a';
    return `VIX/SPX BREAKDOWN: ${dir} (${vixStr}, ${spxStr} over 5m)`;
  })();

  // Wire 13: OFI block (Lee-Ready 1-min session-cumulative trend)
  // One-line summary: trend + acceleration + key numbers in thousands.
  const ofiBlock = (() => {
    const ofi = (audit as any).ofiTrend;
    if (!ofi || typeof ofi.cumulative !== "number") return "";
    const fmtK = (n: number) => {
      const k = n / 1000;
      return (k >= 0 ? "+" : "") + k.toFixed(1) + "k";
    };
    if (ofi.trend === "NEUTRAL") {
      return `OFI: NEUTRAL (cum=${fmtK(ofi.cumulative)})`;
    }
    const accel = ofi.acceleration !== "FLAT" ? ` ${ofi.acceleration}` : "";
    return (
      `OFI: ${ofi.trend}${accel} ` +
      `(cum=${fmtK(ofi.cumulative)}, 15m=${fmtK(ofi.slope15m)}, 5m=${fmtK(ofi.slope5m)})`
    );
  })();

  // Wire 14: WICK TIMING block (T_high/T_low Bloomberg OHLC paper inference)
  const wickTimingBlock = (() => {
    const wt = (audit as any).wickTiming;
    if (!wt || typeof wt.last3Inference !== "string") return "";
    const lb = wt.latestBar;
    // Show latestBar timing pair when inference is clear
    let lbStr = "";
    if (lb && lb.inference !== "INDETERMINATE") {
      lbStr = ` latest=H_${lb.highTiming}+L_${lb.lowTiming}\u2192${lb.inference}`;
    }
    const countStr = wt.strongCount15m != null ? ` ${wt.strongCount15m}` : "";
    return (
      `WICK TIMING: last3=${wt.last3Inference} strong15m=${wt.strongDirection15m}${countStr}${lbStr}`
    );
  })();

  // Wire 12: S/D ZONE block (1-min Schwab bars, volume+freshness)
  // Shows nearest active DEMAND/SUPPLY zone relative to spot.
  // Renders a compact line per side: type, status, vol confirm tag, distance.
  const sdZoneBlock = (() => {
    const zones = (audit as any).sdZones;
    if (!Array.isArray(zones) || zones.length === 0) return "";
    const spotN = Number(spot);
    const lines: string[] = [];
    // Find nearest DEMAND below spot and nearest SUPPLY above spot
    const demandZones = zones.filter((z: any) => z.type === "DEMAND" && z.proximal < spotN && z.distal < spotN);
    const supplyZones = zones.filter((z: any) => z.type === "SUPPLY" && z.proximal > spotN && z.distal > spotN);
    const nearest = (arr: any[], side: "call" | "put") => {
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a: any, b: any) => {
        const dA = side === "call" ? spotN - a.proximal : a.proximal - spotN;
        const dB = side === "call" ? spotN - b.proximal : b.proximal - spotN;
        return dA - dB;
      });
      return sorted[0];
    };
    const nearDemand = nearest(demandZones, "call");
    const nearSupply = nearest(supplyZones, "put");
    if (nearDemand) {
      const dist = (spotN - nearDemand.proximal).toFixed(1);
      const volTag = nearDemand.volumeConfirmed ? "+VOL" : "";
      lines.push(`SD ZONE: DEMAND ${nearDemand.status}${volTag ? " " + volTag : ""} (-${dist}pt away)`);
    }
    if (nearSupply) {
      const dist = (nearSupply.proximal - spotN).toFixed(1);
      const volTag = nearSupply.volumeConfirmed ? "+VOL" : "";
      lines.push(`SD ZONE: SUPPLY ${nearSupply.status}${volTag ? " " + volTag : ""} (+${dist}pt away)`);
    }
    return lines.join("\n");
  })();

  // Stitch the print
  const body = [
    "```",
    ...(eventDayLine ? [eventDayLine, ""] : []),
    close,
    "",
    range,
    "",
    pivotBlock,
    "",
    resistBlock,
    "",
    supportBlock,
    "",
    callsPutsBlock,
    ...(wickBlock ? ["", wickBlock] : []),
    ...(vwapBlock ? ["", vwapBlock] : []),
    ...(jumpRegimeBlock ? ["", jumpRegimeBlock] : []),
    ...(chopRegimeBlock ? ["", chopRegimeBlock] : []),
    ...(corrBreakdownBlock ? ["", corrBreakdownBlock] : []),
    ...(sdZoneBlock ? ["", sdZoneBlock] : []),
    ...(ofiBlock ? ["", ofiBlock] : []),
    ...(wickTimingBlock ? ["", wickTimingBlock] : []),
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
    console.warn(`[discordBatcaveCard] recordPrediction failed: ${e?.message ?? e}`);
  }

  // Post (skipped in dry-run)
  let ok = false;
  if (opts?.dryRun) {
    return { ok: true, preview: final };
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Pulse Batcave", content: final }),
    });
    ok = res.ok;
    if (!ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[discord:model] batcave card webhook ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.warn(`[discord:model] batcave card webhook failed: ${e?.message ?? e}`);
  }

  return { ok, preview: final };
}
