/**
 * dailyPlaybook.ts
 *
 * SPX/SPY Daily Playbook synthesis — 3 scenario paths (Bull/Base/Bear) with
 * target zones, trigger levels, invalidations, probability weights, and a
 * full input manifest so the client can show calibration / source per data point.
 *
 * Strict rule (per user): "the briefing should be strictley from are data and
 * calculations" — every number in the output traces to a value already
 * computed elsewhere (snapshot/gamma/regime/term-structure). No external LLMs.
 *
 * Usage:
 *   const pb = await buildDailyPlaybook("SPY"); // also accepts "SPX"
 *   res.json(pb);
 *
 * Exports:
 *   - buildDailyPlaybook(symbol): fresh synthesis
 *   - lockPlaybookAtOpen() / getLockedPlaybook(): for 9:00 ET pre-open lock
 *   - getDriftFromLocked(): live drift vs the morning lock (for drift overlay)
 */

// Snapshot is provided by the caller (routes.ts owns getOrBuild). This keeps
// dailyPlaybook.ts pure and avoids a circular import.
type SnapshotLike = {
  capturedAt: number;
  spy?: { price?: number | null };
  gamma: {
    spot: number; totalGex: number; callWall: number; putWall: number;
    zeroGamma: number; maxPain: number;
  };
  term?: { vix9d: number; vix: number; vix3m: number; ratio9dOver30d: number; ratio30dOver3m: number };
  vol: { vix?: { value: number } };
  composite?: { score: number; label: string };
};

export type SnapshotProvider = () => Promise<SnapshotLike>;
let _snapshotProvider: SnapshotProvider | null = null;

/** Inject the snapshot provider once at startup (routes.ts wires this). */
export function setSnapshotProvider(fn: SnapshotProvider) {
  _snapshotProvider = fn;
}

async function getSnap(): Promise<SnapshotLike> {
  if (!_snapshotProvider) throw new Error("dailyPlaybook: snapshot provider not registered");
  return _snapshotProvider();
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export type PathKey = "bull" | "base" | "bear";

export interface PathScenario {
  key: PathKey;
  label: string;                   // "Squeeze higher" / "Pin & chop" / "Flush lower"
  probability: number;             // 0..1 (the three sum to 1.0)
  trigger: { level: number; condition: string };  // e.g. { level: 740, condition: "15m close above call wall" }
  target: { low: number; high: number };          // expected close zone for this path
  invalidation: number;            // price beyond which this path is dead
  oneLiner: string;                // plain-English thesis
  drivers: string[];               // bullet drivers (3 max)
}

export interface LevelMagnet {
  level: number;
  label: string;                   // "Call Wall" / "Put Wall" / "Gamma Flip" / "Max Pain"
  kind: "callWall" | "putWall" | "gammaFlip" | "maxPain" | "spot";
  strength: "primary" | "secondary";
}

export interface InputManifest {
  key: string;                     // "spot", "vix", "callWall", etc.
  label: string;                   // human-readable
  value: number | string;
  source: "Schwab" | "Schwab+CBOE" | "CBOE delayed" | "Computed" | "Yahoo";
  asOf: number;                    // unix seconds
  freshSeconds: number;            // 0 = live now
  calibration?: string;            // "ATR(20)=±$8.40" etc.
}

export interface DailyPlaybook {
  symbol: string;                  // "SPY" or "SPX"
  spot: number;
  asOf: number;
  marketSession: "premarket" | "rth" | "afterhours" | "closed";
  paths: { bull: PathScenario; base: PathScenario; bear: PathScenario };
  magnets: LevelMagnet[];          // sorted ascending by level
  expectedRange: { low: number; high: number; method: string };  // 1-sigma daily
  headline: string;                // one-line plain-English summary
  inputs: InputManifest[];         // full calibration footer
  // Always-on regime classification (for UI tinting, even without lock)
  currentRegime?: {
    kind: "long-gamma" | "short-gamma";
    label: string;                 // "Long Gamma · Pin Regime"
    spotVsFlip: number;            // spot - gammaFlip
    totalGexB: number;             // billions (signed)
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function sessionET(): "premarket" | "rth" | "afterhours" | "closed" {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, weekday: "short",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const wd = parts.find(p => p.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return "closed";
  const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const mins = h * 60 + m;
  if (mins < 4 * 60) return "closed";          // <4am ET
  if (mins < 9 * 60 + 30) return "premarket";  // 4:00–9:30
  if (mins < 16 * 60) return "rth";            // 9:30–16:00
  if (mins < 20 * 60) return "afterhours";     // 16:00–20:00
  return "closed";
}

/** 1-sigma daily move from VIX: sigma_daily = VIX/100 / sqrt(252) */
function impliedDailySigma(vix: number, spot: number): number {
  const v = Math.max(8, Math.min(80, vix)) / 100;
  return spot * v / Math.sqrt(252);
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

// ─── Core synthesis ────────────────────────────────────────────────────────────

export async function buildDailyPlaybook(symbol: "SPY" | "SPX" = "SPY"): Promise<DailyPlaybook> {
  const snap = await getSnap();
  const g = snap.gamma;
  const term = snap.term;
  const vol = snap.vol;
  const composite = snap.composite;

  // SPX = SPY * 10 (close enough for level mapping; user typed SPX in the spec)
  const isSPX = symbol === "SPX";
  const scale = isSPX ? 10 : 1;

  const spot = (snap.spy?.price ?? g.spot) * scale;
  const callWall = g.callWall * scale;
  const putWall = g.putWall * scale;
  const gammaFlip = g.zeroGamma * scale;
  const maxPain = g.maxPain * scale;
  const totalGex = g.totalGex; // sign only matters
  const vix = vol.vix?.value ?? 16;

  const sigma = impliedDailySigma(vix, spot);
  const expectedRange = {
    low: spot - sigma,
    high: spot + sigma,
    method: `VIX ${vix.toFixed(2)} → 1σ daily ±$${sigma.toFixed(2)}`,
  };

  // ─── Probability weighting ──────────────────────────────────────────────────
  // Inputs that tilt probabilities:
  //   - Gamma sign: positive gamma → pin/base bias; negative → tail expansion
  //   - Term structure: contango (vix9d < vix < vix3m) → calm; backwardation → stress
  //   - Composite score: 0-100 (50 neutral)
  //   - Spot vs gamma flip: above flip → tilt bull; below → tilt bear
  //
  // Start from balanced (33/34/33), then tilt.
  let pBull = 0.30, pBase = 0.40, pBear = 0.30;

  const isPositiveGamma = totalGex >= 0;
  const isContango = (term?.ratio30dOver3m ?? 1) < 0.95 && (term?.ratio9dOver30d ?? 1) < 0.95;
  const compScore = composite?.score ?? 50;
  const spotVsFlip = spot - gammaFlip;

  // Positive gamma + contango → boost base case (pin), trim wings
  if (isPositiveGamma) { pBase += 0.10; pBull -= 0.05; pBear -= 0.05; }
  if (isContango)      { pBase += 0.05; pBull -= 0.025; pBear -= 0.025; }

  // Negative gamma → tails fatter (regime favors momentum / sweeps)
  if (!isPositiveGamma){ pBase -= 0.10; pBull += 0.05; pBear += 0.05; }

  // Composite tilt: 50 = neutral; ±25 points → ±10% probability shift
  const compTilt = (compScore - 50) / 250; // ±0.10 max
  pBull += compTilt;
  pBear -= compTilt;

  // Spot above gamma flip = dealer hedging supports rallies; below = supports declines
  if (spotVsFlip > 0) { pBull += 0.03; pBear -= 0.03; }
  else                { pBull -= 0.03; pBear += 0.03; }

  // Clamp + renormalize
  pBull = clamp01(pBull); pBase = clamp01(pBase); pBear = clamp01(pBear);
  const sum = pBull + pBase + pBear;
  pBull /= sum; pBase /= sum; pBear /= sum;

  // ─── Path construction ──────────────────────────────────────────────────────
  // Targets are anchored to walls (callWall/putWall), with sigma-extension on breaks.
  const above = callWall > spot ? callWall : spot + 0.5 * sigma;
  const below = putWall  < spot ? putWall  : spot - 0.5 * sigma;
  const pinAnchor = isPositiveGamma ? gammaFlip : maxPain;

  const bull: PathScenario = {
    key: "bull",
    label: "Squeeze higher",
    probability: pBull,
    trigger: {
      level: callWall,
      condition: `15m close above call wall ${callWall.toFixed(2)}`,
    },
    target: {
      low: callWall,
      high: callWall + sigma,
    },
    invalidation: gammaFlip,  // back below flip = thesis dead
    oneLiner: isPositiveGamma
      ? `Pierce ${callWall.toFixed(2)} flips dealer hedging into chase mode; +1σ ${(callWall + sigma).toFixed(2)}.`
      : `Negative gamma + bid → momentum higher. Targets +1σ ${(callWall + sigma).toFixed(2)}.`,
    drivers: [
      `Spot ${spot > gammaFlip ? "above" : "below"} flip (${gammaFlip.toFixed(2)})`,
      `Composite ${compScore}/100`,
      isContango ? "VIX contango (calm)" : "VIX backwardation (fragile)",
    ],
  };

  const base: PathScenario = {
    key: "base",
    label: isPositiveGamma ? "Pin & chop" : "Two-way grind",
    probability: pBase,
    trigger: {
      level: pinAnchor,
      condition: isPositiveGamma
        ? `Hold inside ${below.toFixed(2)}–${above.toFixed(2)}; gravitate to ${pinAnchor.toFixed(2)}`
        : `No clean break of ${below.toFixed(2)} or ${above.toFixed(2)}`,
    },
    target: {
      low: Math.max(putWall, spot - 0.5 * sigma),
      high: Math.min(callWall, spot + 0.5 * sigma),
    },
    invalidation: 0, // no single invalidation — base case dies if either wing triggers
    oneLiner: isPositiveGamma
      ? `Dealers long gamma → mean-reversion. Magnet ${pinAnchor.toFixed(2)} (gamma flip).`
      : `Negative gamma but no catalyst. Two-way inside ±0.5σ.`,
    drivers: [
      isPositiveGamma ? "Positive total GEX (pin regime)" : "Negative GEX, no catalyst",
      `1σ range ±$${sigma.toFixed(2)}`,
      `Max pain ${maxPain.toFixed(2)}`,
    ],
  };

  const bear: PathScenario = {
    key: "bear",
    label: "Flush lower",
    probability: pBear,
    trigger: {
      level: putWall,
      condition: `15m close below put wall ${putWall.toFixed(2)}`,
    },
    target: {
      low: putWall - sigma,
      high: putWall,
    },
    invalidation: gammaFlip,  // back above flip = bear thesis dead
    oneLiner: isPositiveGamma
      ? `Lose put wall ${putWall.toFixed(2)} forces dealer short-vol unwind; -1σ ${(putWall - sigma).toFixed(2)}.`
      : `Negative gamma + offer → cascading sells. -1σ ${(putWall - sigma).toFixed(2)}.`,
    drivers: [
      `Put wall ${putWall.toFixed(2)} as last line`,
      !isContango ? "Backwardation = stress" : "Sentiment fragile",
      `Composite ${compScore}/100`,
    ],
  };

  // ─── Level magnets (for chart overlays) ─────────────────────────────────────
  const magnets: LevelMagnet[] = [
    { level: callWall,  label: "Call Wall",  kind: "callWall",  strength: "primary"   },
    { level: putWall,   label: "Put Wall",   kind: "putWall",   strength: "primary"   },
    { level: gammaFlip, label: "Gamma Flip", kind: "gammaFlip", strength: "primary"   },
    { level: maxPain,   label: "Max Pain",   kind: "maxPain",   strength: "secondary" },
    { level: spot,      label: "Spot",       kind: "spot",      strength: "secondary" },
  ].sort((a, b) => a.level - b.level);

  // ─── Headline ───────────────────────────────────────────────────────────────
  const winner: PathKey = pBase >= pBull && pBase >= pBear ? "base"
                       : pBull >= pBear ? "bull" : "bear";
  const winnerLabel = winner === "bull" ? "lean up"
                    : winner === "bear" ? "lean down" : "pin & chop";
  const winnerProb = winner === "bull" ? pBull : winner === "bear" ? pBear : pBase;
  const headline =
    `${symbol} ${spot.toFixed(2)} · ${winnerLabel} (${Math.round(winnerProb * 100)}%). ` +
    `Range ${expectedRange.low.toFixed(2)}–${expectedRange.high.toFixed(2)} (1σ). ` +
    `Walls: put ${putWall.toFixed(2)} / call ${callWall.toFixed(2)}.`;

  // ─── Input manifest (calibration footer) ────────────────────────────────────
  const inputs: InputManifest[] = [
    { key: "spot",      label: "Spot price",      value: spot,                source: "Schwab",       asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt },
    { key: "vix",       label: "VIX",             value: vix,                 source: "Schwab",       asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: `1σ daily ±$${sigma.toFixed(2)}` },
    { key: "vix9d",     label: "VIX9D",           value: term?.vix9d ?? 0,    source: "Schwab",       asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt },
    { key: "vix3m",     label: "VIX3M",           value: term?.vix3m ?? 0,    source: "Schwab",       asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: isContango ? "Contango (calm)" : "Flat/backwardation" },
    { key: "callWall",  label: "Call Wall",       value: callWall,            source: "Schwab+CBOE",  asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: `Top call OI strike` },
    { key: "putWall",   label: "Put Wall",        value: putWall,             source: "Schwab+CBOE",  asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: `Top put OI strike` },
    { key: "gammaFlip", label: "Gamma Flip",      value: gammaFlip,           source: "Computed",     asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: `Zero-gamma level (Perfiliev)` },
    { key: "maxPain",   label: "Max Pain",        value: maxPain,             source: "Computed",     asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt },
    { key: "totalGex",  label: "Total GEX",       value: `${(totalGex / 1e9).toFixed(2)}B`, source: "Computed", asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: isPositiveGamma ? "Positive (pin)" : "Negative (momentum)" },
    { key: "composite", label: "Composite",       value: compScore,           source: "Computed",     asOf: snap.capturedAt, freshSeconds: nowSec() - snap.capturedAt, calibration: composite?.label ?? "" },
  ];

  return {
    symbol,
    spot,
    asOf: nowSec(),
    marketSession: sessionET(),
    paths: { bull, base, bear },
    magnets,
    expectedRange,
    headline,
    inputs,
    currentRegime: {
      kind: isPositiveGamma ? "long-gamma" : "short-gamma",
      label: isPositiveGamma ? "Long Gamma · Pin Regime" : "Short Gamma · Momentum Regime",
      spotVsFlip: spot - gammaFlip,
      totalGexB: totalGex / 1e9,
    },
  };
}

// ─── 9:00 ET Lock + drift ──────────────────────────────────────────────────────

let _locked: DailyPlaybook | null = null;
let _lockedDate: string = ""; // YYYY-MM-DD ET

function _todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/** Call once at 9:00 ET (pre-open) to freeze the day's playbook. Subsequent
 *  buildDailyPlaybook() calls return live numbers; client compares to locked. */
export async function lockPlaybookAtOpen(symbol: "SPY" | "SPX" = "SPY"): Promise<DailyPlaybook> {
  _locked = await buildDailyPlaybook(symbol);
  _lockedDate = _todayET();
  console.log(`[playbook] locked ${symbol} for ${_lockedDate} @ ${_locked.spot.toFixed(2)}`);
  return _locked;
}

export function getLockedPlaybook(): DailyPlaybook | null {
  // Auto-expire if the date rolled
  if (_lockedDate && _lockedDate !== _todayET()) {
    _locked = null;
    _lockedDate = "";
  }
  return _locked;
}

/** Per-path health re-grade against the locked invalidation. */
export type PathHealth = "alive" | "weakening" | "dead";
export interface PathHealthEntry {
  path: PathKey;
  health: PathHealth;
  reason: string;        // plain-English why
  distanceToInvalidation?: number;  // signed: positive = still alive
}

/** Live regime classification (drives UI tinting). */
export type GammaRegime = "long-gamma" | "short-gamma";
export interface RegimeOverlay {
  current: GammaRegime;
  locked: GammaRegime;
  flipped: boolean;                 // crossed since lock?
  flipDirection?: "toShort" | "toLong";
  spotVsFlip: number;               // current spot - gamma flip
  totalGexB: number;                // in billions, sign matters
  label: string;                    // "Long Gamma · Pin Regime"
}

/** Drift = current vs locked. Caller renders this as an overlay. */
export interface PlaybookDrift {
  hasLock: boolean;
  spotDrift?: number;             // current spot - locked spot
  spotDriftPct?: number;
  probabilityShift?: { bull: number; base: number; bear: number };  // current - locked
  triggerHits?: { path: PathKey; hit: boolean; closeness: number }[]; // closeness=0 means at trigger
  rangeExpansion?: number;        // current sigma / locked sigma
  notes: string[];
  pathHealth?: PathHealthEntry[]; // alive/weakening/dead per path
  regime?: RegimeOverlay;         // current vs locked gamma regime
}

export async function getDriftFromLocked(symbol: "SPY" | "SPX" = "SPY"): Promise<PlaybookDrift> {
  const locked = getLockedPlaybook();
  if (!locked) return { hasLock: false, notes: ["No 9:00 ET lock yet"] };
  const live = await buildDailyPlaybook(symbol);

  const spotDrift = live.spot - locked.spot;
  const spotDriftPct = (spotDrift / locked.spot) * 100;

  const probabilityShift = {
    bull: live.paths.bull.probability - locked.paths.bull.probability,
    base: live.paths.base.probability - locked.paths.base.probability,
    bear: live.paths.bear.probability - locked.paths.bear.probability,
  };

  const triggerHits = (["bull", "base", "bear"] as PathKey[]).map(k => {
    const t = live.paths[k].trigger.level;
    if (!t) return { path: k, hit: false, closeness: 0 };
    const distance = Math.abs(live.spot - t);
    const sigma = Math.max(1, live.expectedRange.high - live.expectedRange.low);
    const closeness = 1 - Math.min(1, distance / (sigma / 2));
    const hit = (k === "bull" && live.spot >= t) ||
                (k === "bear" && live.spot <= t) ||
                (k === "base" && distance < sigma * 0.1);
    return { path: k, hit, closeness };
  });

  const lockedSigma = locked.expectedRange.high - locked.expectedRange.low;
  const liveSigma = live.expectedRange.high - live.expectedRange.low;
  const rangeExpansion = lockedSigma > 0 ? liveSigma / lockedSigma : 1;

  const notes: string[] = [];
  if (Math.abs(spotDriftPct) > 0.3) {
    notes.push(`Spot moved ${spotDriftPct >= 0 ? "+" : ""}${spotDriftPct.toFixed(2)}% since lock`);
  }
  if (rangeExpansion > 1.15) notes.push(`Vol expanding (${((rangeExpansion - 1) * 100).toFixed(0)}% wider)`);
  else if (rangeExpansion < 0.85) notes.push(`Vol compressing (${((1 - rangeExpansion) * 100).toFixed(0)}% tighter)`);
  if (Math.abs(probabilityShift.bull) > 0.1)
    notes.push(`Bull odds ${probabilityShift.bull >= 0 ? "+" : ""}${(probabilityShift.bull * 100).toFixed(0)}pp`);
  if (Math.abs(probabilityShift.bear) > 0.1)
    notes.push(`Bear odds ${probabilityShift.bear >= 0 ? "+" : ""}${(probabilityShift.bear * 100).toFixed(0)}pp`);
  triggerHits.filter(h => h.hit).forEach(h => notes.push(`${h.path.toUpperCase()} trigger HIT`));

  // ─── Per-path health re-grade against LOCKED invalidations ────────────────
  // A path is dead when spot has crossed the LOCKED invalidation level.
  // This is the honest re-grade: thesis was set at 9:00 ET, market has moved,
  // does the original thesis still survive?
  const pathHealth: PathHealthEntry[] = (["bull", "base", "bear"] as PathKey[]).map(k => {
    const lockedPath = locked.paths[k];
    const inv = lockedPath.invalidation;
    const livePrice = live.spot;
    const sigma = Math.max(1, liveSigma / 2); // 1σ of the live range

    if (k === "base") {
      // Base case dies when EITHER wing's trigger is decisively breached
      const bullTrig = locked.paths.bull.trigger.level;
      const bearTrig = locked.paths.bear.trigger.level;
      const aboveBull = bullTrig > 0 && livePrice > bullTrig;
      const belowBear = bearTrig > 0 && livePrice < bearTrig;
      if (aboveBull) {
        return { path: k, health: "dead", reason: `spot ${livePrice.toFixed(2)} pierced bull trigger ${bullTrig.toFixed(2)}` };
      }
      if (belowBear) {
        return { path: k, health: "dead", reason: `spot ${livePrice.toFixed(2)} pierced bear trigger ${bearTrig.toFixed(2)}` };
      }
      // Weakening if vol expanded materially (pin thesis fragile in expanding vol)
      if (rangeExpansion > 1.20) {
        return { path: k, health: "weakening", reason: `vol expanding ${((rangeExpansion - 1) * 100).toFixed(0)}% — pin fragile` };
      }
      return { path: k, health: "alive", reason: "spot inside both wing triggers" };
    }

    // Bull: dies when spot drops back below gamma flip (locked invalidation)
    // Bear: dies when spot pops back above gamma flip
    if (k === "bull") {
      const dist = livePrice - inv; // positive = above invalidation = alive
      if (dist <= 0) return { path: k, health: "dead", reason: `spot ${livePrice.toFixed(2)} below locked invalidation ${inv.toFixed(2)}`, distanceToInvalidation: dist };
      if (dist < sigma * 0.25) return { path: k, health: "weakening", reason: `only ${dist.toFixed(2)} above invalidation (<0.25σ)`, distanceToInvalidation: dist };
      return { path: k, health: "alive", reason: `${dist.toFixed(2)} clear of invalidation`, distanceToInvalidation: dist };
    }
    // bear
    const dist = inv - livePrice; // positive = below invalidation = alive
    if (dist <= 0) return { path: k, health: "dead", reason: `spot ${livePrice.toFixed(2)} above locked invalidation ${inv.toFixed(2)}`, distanceToInvalidation: dist };
    if (dist < sigma * 0.25) return { path: k, health: "weakening", reason: `only ${dist.toFixed(2)} below invalidation (<0.25σ)`, distanceToInvalidation: dist };
    return { path: k, health: "alive", reason: `${dist.toFixed(2)} clear of invalidation`, distanceToInvalidation: dist };
  });

  pathHealth.filter(h => h.health === "dead").forEach(h => notes.push(`${h.path.toUpperCase()} thesis DEAD — ${h.reason}`));

  // ─── Regime overlay: long vs short gamma + flip crossing detection ────────
  const currentRegime: GammaRegime = live.inputs.find(i => i.key === "totalGex")?.calibration?.includes("Positive") ? "long-gamma" : "short-gamma";
  const lockedRegime: GammaRegime = locked.inputs.find(i => i.key === "totalGex")?.calibration?.includes("Positive") ? "long-gamma" : "short-gamma";
  const gammaFlipLevel = Number(live.inputs.find(i => i.key === "gammaFlip")?.value ?? 0);
  const totalGexBStr = String(live.inputs.find(i => i.key === "totalGex")?.value ?? "0B");
  const totalGexB = parseFloat(totalGexBStr.replace(/B$/, "")) || 0;
  const flipped = currentRegime !== lockedRegime;
  const regimeLabel = currentRegime === "long-gamma"
    ? "Long Gamma · Pin Regime"
    : "Short Gamma · Momentum Regime";

  if (flipped) {
    const dir = lockedRegime === "long-gamma" ? "pin→momentum" : "momentum→pin";
    notes.unshift(`REGIME FLIP since lock: ${dir}`);
  }

  const regime: RegimeOverlay = {
    current: currentRegime,
    locked: lockedRegime,
    flipped,
    flipDirection: flipped ? (currentRegime === "short-gamma" ? "toShort" : "toLong") : undefined,
    spotVsFlip: live.spot - gammaFlipLevel,
    totalGexB,
    label: regimeLabel,
  };

  if (notes.length === 0) notes.push("Tracking inside morning expectations");

  return { hasLock: true, spotDrift, spotDriftPct, probabilityShift, triggerHits, rangeExpansion, notes, pathHealth, regime };
}
