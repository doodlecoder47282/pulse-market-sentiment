// server/levelPlaybook.ts
//
// Deterministic "how to play" copy generator for level alerts. Maps a level's
// (kind, side, status) tuple to a short tactical line in the same voice as
// the SPX daily card. NO LLM, NO external calls — pure lookup + interpolation
// against the level chain we already computed.
//
// Source of language: the SelzTrades-style copy patterns the user approved
// in the daily card spec ("path opens to X then γ-WALL Y", "dealer long
// premium max — hard ceiling", "charm drag loses grip", etc).

export type LevelLite = {
  name: string;
  kind: string;
  price: number;
  side: "resistance" | "support" | string;
  status?: string;
  tag?: string;
};

// Pick the next N levels above (resistance chain) or below (support chain) a given price.
export function chainAbove(price: number, levels: LevelLite[], n = 3): LevelLite[] {
  return levels
    .filter((l) => l.price > price + 0.5)
    .sort((a, b) => a.price - b.price)
    .slice(0, n);
}
export function chainBelow(price: number, levels: LevelLite[], n = 3): LevelLite[] {
  return levels
    .filter((l) => l.price < price - 0.5)
    .sort((a, b) => b.price - a.price)
    .slice(0, n);
}

// Format a chain as "X → Y → Z" using level names.
export function fmtChain(chain: LevelLite[]): string {
  if (chain.length === 0) return "open";
  return chain.map((l) => `${l.name} ${Math.round(l.price)}`).join(" → ");
}

// "How to play it" copy — hand-written templates keyed by level kind + status.
// Each returns a single line meant to live under the targets in the embed.
//
// Status semantics:
//   held         → level still defending; describe what holding means
//   approaching  → spot near; describe the binary risk
//   broken       → level given way; describe what's behind it
export function playbookCopy(
  kind: string,
  side: string,
  status: string,
  upsideChain: LevelLite[],
  downsideChain: LevelLite[],
): string {
  const k = (kind || "").toLowerCase();
  const isRes = side === "resistance";
  const upStr = fmtChain(upsideChain);
  const dnStr = fmtChain(downsideChain);

  // Helper to phrase chain references with fallback.
  const upTo = upsideChain.length ? `path opens to ${upStr}` : "path opens, no overhead supply nearby";
  const dnTo = downsideChain.length ? `downside opens to ${dnStr}` : "downside opens, no support nearby";

  // Status-specific framing
  if (status === "broken") {
    if (isRes) {
      // Bullish break — resistance flips to support, lift continues
      if (k.includes("callwall") || k.includes("vomma") || k.includes("t2up")) {
        return `BREAKOUT — dealer hedging flips supportive · ${upTo}`;
      }
      if (k.includes("charm")) {
        return `charm drag flipped bullish — momentum accelerates · ${upTo}`;
      }
      if (k.includes("vanna")) {
        return `vanna ceiling cracked — IV-crush tailwind · ${upTo}`;
      }
      return `resistance lost — buyers in control · ${upTo}`;
    } else {
      // Bearish break — support gives way, slide continues
      if (k.includes("putwall") || k.includes("t2dn") || k.includes("t2down")) {
        return `BREAKDOWN — dealer hedging flips pressure · ${dnTo}`;
      }
      if (k.includes("charm")) {
        return `charm drag loses grip — downside opens · ${dnTo}`;
      }
      if (k.includes("gammazero") || k.includes("zero")) {
        return `γ-zero broken — volatility regime flips, expect range expansion · ${dnTo}`;
      }
      return `support broken — sellers in control · ${dnTo}`;
    }
  }

  if (status === "approaching") {
    if (isRes) {
      if (k.includes("callwall")) {
        return `dealer call wall — reversion favored, push only on power-hour vol · if breaks ${upTo}`;
      }
      if (k.includes("vanna")) {
        return `vanna peak — dealer long premium max, hard ceiling unless held · if breaks ${upTo}`;
      }
      if (k.includes("charm")) {
        return `charm flip — break + hold = momentum unlock · if breaks ${upTo}`;
      }
      if (k.includes("vomma") || k.includes("t2up")) {
        return `thin gamma above — reversion likely unless power-hour push · if breaks ${upTo}`;
      }
      return `resistance test — fade favored, breakout requires hold · if breaks ${upTo}`;
    } else {
      if (k.includes("putwall")) {
        return `dealer put wall — bounce favored, breakdown only on heavy flow · if breaks ${dnTo}`;
      }
      if (k.includes("charm")) {
        return `charm floor — break = drag releases · if breaks ${dnTo}`;
      }
      if (k.includes("gammazero") || k.includes("zero")) {
        return `γ-zero floor — sticky here, but break = volatility unlock · if breaks ${dnTo}`;
      }
      if (k.includes("pivot") || k.includes("main")) {
        return `bull/bear line — break + hold below = trend flip · if breaks ${dnTo}`;
      }
      return `support test — bounce favored, breakdown requires hold · if breaks ${dnTo}`;
    }
  }

  // Held (rarely fires as alert, included for completeness)
  if (isRes) {
    return `holding — ceiling intact, fade rallies into ${upStr || "open air"}`;
  }
  return `holding — floor intact, buy dips into ${dnStr || "open air"}`;
}

// Compute "upside target" and "downside target" for any pivot — first level
// above and first level below in the chain.
export function targetsForLevel(
  level: LevelLite,
  allLevels: LevelLite[],
): { upsideTarget: LevelLite | null; downsideTarget: LevelLite | null } {
  const up = chainAbove(level.price, allLevels, 1);
  const dn = chainBelow(level.price, allLevels, 1);
  return {
    upsideTarget: up[0] ?? null,
    downsideTarget: dn[0] ?? null,
  };
}
