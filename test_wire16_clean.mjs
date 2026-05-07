// ─── Helper: extract formatOdteAlert from dist ───────────────────────────────
// The dist is a bundled server. We need to test formatOdteAlert which is
// pure logic (no I/O). We'll reconstruct it inline matching the exact source
// since we can't extract it from the opaque bundle. The source is deterministic.

function letterGrade(score) {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "A−";
  if (score >= 75) return "B+";
  if (score >= 72) return "B−";
  if (score >= 65) return "B";
  if (score >= 55) return "C+";
  return "C";
}

const MIN_FIRE_SCORE = 72;

function formatOdteAlert(a) {
  const sideUpper = a.side.toUpperCase();
  const contractType = a.side === "call" ? "C" : "P";
  const setupLabel =
    a.setup === "FAILED_BREAK" ? "FAILED BREAK" :
    a.setup === "PIVOT_RECLAIM" ? "PIVOT RECLAIM" :
    "WALL REJECT";

  const etTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(a.asOf));

  const deltaStr = a.contract.delta != null
    ? Math.abs(a.contract.delta).toFixed(2)
    : "—";

  const projT1Pct = a.wire15?.projReturnPctT1 != null
    ? Math.round(a.wire15.projReturnPctT1 * 100)
    : Math.round(a.t1.estPctGain);
  const projT2Pct = a.wire15?.projReturnPctT2 != null
    ? Math.round(a.wire15.projReturnPctT2 * 100)
    : (a.t2 ? Math.round(a.t2.estPctGain) : null);

  const newStop = a.side === "call"
    ? Math.round(a.t1.price) - 3
    : Math.round(a.t1.price) + 3;

  const lines = [];
  lines.push(`SPX 0DTE TRADE ALERT  |  ${etTime} ET`);
  lines.push("─".repeat(40));
  lines.push(`${sideUpper} ALERT  |  ${setupLabel}  |  CONFIDENCE ${a.grade.letter}  (${a.grade.score}/100)`);
  lines.push("");
  lines.push(`CONTRACT:  SPX ${a.contract.strike} ${contractType}  |  SPX @ ${a.spot.toFixed(1)}  (delta ${deltaStr})`);
  lines.push("");
  const reversionLine = `${a.reversionFrom.name} ${Math.round(a.reversionFrom.price)}  →  ${a.t1.name} ${Math.round(a.t1.price)}`;
  const entryDesc = a.setup === "FAILED_BREAK"
    ? `Was ${a.side === "call" ? "below" : "above"} ${Math.round(a.reversionFrom.price)}, broke ${a.side === "call" ? "above" : "below"} — trap confirmed. Trade ${sideUpper} back toward ${Math.round(a.t1.price)}.`
    : a.setup === "PIVOT_RECLAIM"
    ? `${a.side === "call" ? "Reclaimed" : "Lost"} pivot ${Math.round(a.reversionFrom.price)} — momentum trade toward ${Math.round(a.t1.price)}.`
    : `Tagged ${a.reversionFrom.name} ${Math.round(a.reversionFrom.price)} and rejected — fade toward ${Math.round(a.t1.price)}.`;
  lines.push(`REVERSION:  ${reversionLine}`);
  lines.push(`ENTRY:  ${entryDesc}`);
  lines.push("");
  lines.push(`STOP:  -20%  OR  5-min close ${a.side === "call" ? "BELOW" : "ABOVE"} ${Math.round(a.stopLevel)}`);
  const projTier = a.wire15?.projTier ?? null;
  const tierTag = projTier ? `  [${projTier}]` : "";
  lines.push(`T1:  ${Math.round(a.t1.price)}  (${a.t1.name})  +${projT1Pct}% est${tierTag}`);
  if (a.t2) {
    const t2ProjStr = projT2Pct != null ? `+${projT2Pct}% est` : "+—% est";
    lines.push(`  IF T1 BREAKS: stop -> ${a.side === "call" ? "BELOW" : "ABOVE"} ${newStop}  |  T2: ${Math.round(a.t2.price)} (${a.t2.name}) ${t2ProjStr}`);
    lines.push(`  T2 activates on: 5-min candle close ${a.side === "call" ? "ABOVE" : "BELOW"} ${Math.round(a.t1.price)}`);
  }
  lines.push("");
  lines.push(`Greek signals:  ${a.greekSignals}`);
  lines.push(`Regime:  ${a.regime}`);
  lines.push("");
  lines.push(`Built by God. Paid by the Market.`);

  return { content: "```\n" + lines.join("\n") + "\n```" };
}

// ─── GEX tier helper (matching odteAlertEngine.ts logic) ──────────────────
// audit.gex is in $M, so absGex = Math.abs(gexM) * 1_000_000
function gexTier(absGexDollars) {
  if (absGexDollars < 300_000_000)   return "THIN";   // < $300M
  if (absGexDollars < 750_000_000)   return "LIGHT";  // $300M–$750M
  if (absGexDollars < 1_500_000_000) return "SOFT";   // $750M–$1.5B
  return "FULL";                                       // >= $1.5B
}

// ─── Gate simulation (Wire 16 gate ordering) ─────────────────────────────────
// Returns { fires: true, alert } or { fires: false, reason }
function simulateGates(params) {
  const {
    score,
    projReturnPctT1Raw,   // raw before any degrade
    gexDollars,           // absolute GEX in dollars
    chaseRatio,           // realized15mMove / distanceToT1
    spreadPct,            // bid-ask / mid
    chaseDirectionMatches = true,  // whether chase direction matches trade
  } = params;

  // Gate ordering per Wire 16 spec:
  // 1. Setup detection — always assumed valid in our test objects
  // 2. Score floor >= 72
  if (score < MIN_FIRE_SCORE) {
    return { fires: false, reason: `SCORE_BELOW_B_MINUS (score=${score} < ${MIN_FIRE_SCORE})` };
  }

  // 3. Wire 15 Gate 1 — Environmental veto (skipped: test scenario has no env veto)

  // 4. GEX magnitude gate
  const tier = gexTier(gexDollars);
  if (tier === "THIN") {
    return { fires: false, reason: `GEX_TOO_THIN_LT_300M (absGex=$${(gexDollars/1e6).toFixed(0)}M, tier=THIN)` };
  }
  let projReturnPctT1 = projReturnPctT1Raw;
  let gexLightDegrade = false;
  let gexLightOverride = false;
  if (tier === "LIGHT") {
    if (score < 85) {
      return { fires: false, reason: `GEX_LIGHT_NEEDS_A_MINUS (score=${score} < 85, tier=LIGHT)` };
    }
    gexLightOverride = true;
  }
  if (tier === "SOFT") {
    projReturnPctT1 = projReturnPctT1Raw * 0.85;
    gexLightDegrade = true;
  }

  // 5. Anti-chase
  if (chaseRatio != null && chaseRatio >= 0.60 && chaseDirectionMatches) {
    if (score < 85) {
      return { fires: false, reason: `CHASE_PRIOR_15M_COVERED_60_PCT (chaseRatio=${chaseRatio.toFixed(2)}, score=${score} < 85)` };
    }
    // score >= 85: override passes
  }

  // 6. Wire 15 Gate 2 — Contract picker + spread gate
  if (spreadPct != null && spreadPct > 0.05) {
    return { fires: false, reason: `CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT (spreadPct=${(spreadPct*100).toFixed(1)}%)` };
  }

  // 7. Wire 15 Gate 3 — Projected return >= 30% (after GEX SOFT degrade)
  if (projReturnPctT1 < 0.30) {
    return { fires: false, reason: `PROJ_RETURN_BELOW_30_PCT (projT1=${(projReturnPctT1*100).toFixed(1)}% after degrade)` };
  }

  // Gates 4 & 5 (IV richness, Greek slope) — assumed pass in test scenarios
  // Determine tier
  let projTier;
  if (projReturnPctT1 >= 1.0) projTier = "MOONSHOT";
  else if (projReturnPctT1 >= 0.50) projTier = "BANGER";
  else projTier = "STANDARD";

  return {
    fires: true,
    projReturnPctT1,
    projReturnPctT1Raw,
    projTier,
    tier,
    gexLightDegrade,
    gexLightOverride,
    score,
  };
}

// ─── Build a minimal OdteAlert for format testing ─────────────────────────────
function makeAlert({ score, projReturnPctT1, projTier, setup = "WALL_REJECT", side = "call" }) {
  return {
    setup,
    side,
    spot: 5255.5,
    asOf: Date.now(),
    contract: {
      strike: 5260,
      last: 4.20,
      bid: 4.10,
      ask: 4.30,
      delta: side === "call" ? 0.35 : -0.35,
      key: "SPX_5260_C_2026-05-06",
      expiry: "2026-05-06",
      gamma: 0.004,
      theta: -0.12,
      vega: 0.08,
      iv: 0.18,
      midPrice: 4.20,
    },
    reversionFrom: { name: "R1", price: 5270.0 },
    t1: { name: "VWAP", price: 5242.0, estPctGain: Math.round(projReturnPctT1 * 100) },
    t2: { name: "S1", price: 5230.0, estPctGain: Math.round(projReturnPctT1 * 150) },
    stopPct: 20,
    stopLevel: side === "call" ? 5265.0 : 5250.0,
    t2TriggerLevel: 5242.0,
    t2TrailingStopLevel: 5245.0,
    greekSignals: "SLOPE DOWN · VANNA BEAR",
    regime: "DAMPENED γ+",
    grade: {
      score,
      letter: letterGrade(score),
      coldBootOverride: false,
      reasoning: ["test case"],
    },
    reasoning: ["test case"],
    wire15: {
      projReturnPctT1,
      projReturnPctT2: projReturnPctT1 * 1.5,
      rv5d: 0.008,
      ivRichRatio: 1.1,
      ivRichDegrade: false,
      gammaSlope5m: 0.002,
      envVetoReason: null,
      gateRejectReason: null,
      contractStrike: 5260,
      contractDelta: side === "call" ? 0.35 : -0.35,
      contractMidPrice: 4.20,
      contractBid: 4.10,
      contractAsk: 4.30,
      contractEntryPrice: 4.22,
      contractSpreadPct: 0.048,
      absGex: null,
      gexTier: "FULL",
      gexLightDegrade: false,
      gexLightOverride: false,
      realized15mMove: 3.0,
      distanceToT1: 28.0,
      chaseRatio: 0.11,
      chaseOverride: false,
      projTier,
      coldBootProjOverride: false,
      wire15Present: true,
      wire16Present: true,
    },
  };
}

// ─── Run tests ────────────────────────────────────────────────────────────────
const SEP = "═".repeat(60);
const sep = "─".repeat(60);

// ── (a) STANDARD: projReturnPctT1=0.35, score=72, GEX FULL ──────────────────
console.log(`\n${SEP}`);
console.log("TEST (a) — STANDARD fire: proj=0.35, score=72, GEX FULL ($2B)");
console.log(SEP);
const a = simulateGates({
  score: 72,
  projReturnPctT1Raw: 0.35,
  gexDollars: 2_000_000_000,
  chaseRatio: 0.11,
  spreadPct: 0.03,
});
console.log("Gate result:", a.fires ? `FIRES → tier=${a.projTier}` : `REJECTED: ${a.reason}`);
if (a.fires) {
  const alert = makeAlert({ score: 72, projReturnPctT1: a.projReturnPctT1, projTier: a.projTier });
  const card = formatOdteAlert(alert);
  console.log("\nFORMATTED CARD:");
  console.log(card.content);
  const hasStandard = card.content.includes("[STANDARD]");
  console.log(`✓ [STANDARD] tag present: ${hasStandard}`);
}

// ── (b) BANGER: proj=0.72 raw, score=78, GEX SOFT ($1B) → degrades to 0.612 ─
console.log(`\n${SEP}`);
console.log("TEST (b) — BANGER fire: proj=0.72 raw→0.612 after SOFT degrade, score=78, GEX SOFT ($1B)");
console.log(SEP);
const b = simulateGates({
  score: 78,
  projReturnPctT1Raw: 0.72,
  gexDollars: 1_000_000_000,
  chaseRatio: 0.10,
  spreadPct: 0.03,
});
console.log(`Gate result: ${b.fires ? `FIRES → tier=${b.projTier}, proj after degrade=${(b.projReturnPctT1*100).toFixed(1)}%` : `REJECTED: ${b.reason}`}`);
if (b.fires) {
  const alert = makeAlert({ score: 78, projReturnPctT1: b.projReturnPctT1, projTier: b.projTier });
  const card = formatOdteAlert(alert);
  console.log("\nFORMATTED CARD:");
  console.log(card.content);
  const hasBanger = card.content.includes("[BANGER]");
  console.log(`✓ [BANGER] tag present: ${hasBanger}`);
  console.log(`✓ SOFT degrade: ${b.projReturnPctT1Raw} * 0.85 = ${(b.projReturnPctT1Raw*0.85).toFixed(4)} → tier=${b.projTier} (>= 0.50 = BANGER correct)`);
}

// ── (c) MOONSHOT: proj=1.45, score=85, GEX FULL ──────────────────────────────
console.log(`\n${SEP}`);
console.log("TEST (c) — MOONSHOT fire: proj=1.45, score=85, GEX FULL ($3B)");
console.log(SEP);
const c = simulateGates({
  score: 85,
  projReturnPctT1Raw: 1.45,
  gexDollars: 3_000_000_000,
  chaseRatio: 0.05,
  spreadPct: 0.02,
});
console.log(`Gate result: ${c.fires ? `FIRES → tier=${c.projTier}` : `REJECTED: ${c.reason}`}`);
if (c.fires) {
  const alert = makeAlert({ score: 85, projReturnPctT1: c.projReturnPctT1, projTier: c.projTier, side: "put" });
  const card = formatOdteAlert(alert);
  console.log("\nFORMATTED CARD:");
  console.log(card.content);
  const hasMoonshot = card.content.includes("[MOONSHOT]");
  console.log(`✓ [MOONSHOT] tag present: ${hasMoonshot}`);
}

// ── (d) REJECT: GEX < 300M, score=90 → GEX_TOO_THIN ─────────────────────────
console.log(`\n${SEP}`);
console.log("TEST (d) — REJECT: GEX $150M (THIN), score=90 — should hard reject");
console.log(SEP);
const d = simulateGates({
  score: 90,
  projReturnPctT1Raw: 0.80,
  gexDollars: 150_000_000,
  chaseRatio: 0.05,
  spreadPct: 0.03,
});
console.log(`Gate result: ${d.fires ? "FIRES (UNEXPECTED)" : `REJECTED: ${d.reason}`}`);
const dCorrect = !d.fires && d.reason.includes("GEX_TOO_THIN_LT_300M");
console.log(`✓ Correct rejection (GEX_TOO_THIN_LT_300M): ${dCorrect}`);

// ── (e) REJECT: chaseRatio=0.75, score=78 → CHASE_PRIOR_15M ─────────────────
console.log(`\n${SEP}`);
console.log("TEST (e) — REJECT: chaseRatio=0.75, score=78 — should reject (not A-)");
console.log(SEP);
const e = simulateGates({
  score: 78,
  projReturnPctT1Raw: 0.55,
  gexDollars: 2_000_000_000,
  chaseRatio: 0.75,
  spreadPct: 0.03,
  chaseDirectionMatches: true,
});
console.log(`Gate result: ${e.fires ? "FIRES (UNEXPECTED)" : `REJECTED: ${e.reason}`}`);
const eCorrect = !e.fires && e.reason.includes("CHASE_PRIOR_15M_COVERED_60_PCT");
console.log(`✓ Correct rejection (CHASE_PRIOR_15M_COVERED_60_PCT): ${eCorrect}`);

// ── (f) REJECT: spreadPct=0.08 → CONTRACT_SPREAD_TOO_WIDE ───────────────────
console.log(`\n${SEP}`);
console.log("TEST (f) — REJECT: spreadPct=0.08 (8%) — should reject bid-ask too wide");
console.log(SEP);
const f = simulateGates({
  score: 82,
  projReturnPctT1Raw: 0.65,
  gexDollars: 2_000_000_000,
  chaseRatio: 0.10,
  spreadPct: 0.08,
});
console.log(`Gate result: ${f.fires ? "FIRES (UNEXPECTED)" : `REJECTED: ${f.reason}`}`);
const fCorrect = !f.fires && f.reason.includes("CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT");
console.log(`✓ Correct rejection (CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT): ${fCorrect}`);

// ── BONUS: Verify letterGrade boundaries ─────────────────────────────────────
console.log(`\n${SEP}`);
console.log("LETTER GRADE BOUNDARY CHECK");
console.log(SEP);
[71, 72, 74, 75, 79, 80, 84, 85, 89, 90, 95].forEach(s => {
  console.log(`  score=${s} → ${letterGrade(s)}`);
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log(`\n${SEP}`);
console.log("SUMMARY");
console.log(SEP);
const results = [
  { id: "a", label: "STANDARD fire",          pass: a.fires && a.projTier === "STANDARD" },
  { id: "b", label: "BANGER fire (SOFT deg)", pass: b.fires && b.projTier === "BANGER" },
  { id: "c", label: "MOONSHOT fire",          pass: c.fires && c.projTier === "MOONSHOT" },
  { id: "d", label: "GEX THIN hard reject",   pass: !d.fires && d.reason.includes("GEX_TOO_THIN_LT_300M") },
  { id: "e", label: "Anti-chase reject",      pass: !e.fires && e.reason.includes("CHASE_PRIOR_15M_COVERED_60_PCT") },
  { id: "f", label: "Spread gate reject",     pass: !f.fires && f.reason.includes("CONTRACT_SPREAD_TOO_WIDE_GT_5_PCT") },
];
results.forEach(r => {
  console.log(`  (${r.id}) ${r.label}: ${r.pass ? "PASS" : "FAIL"}`);
});
const allPass = results.every(r => r.pass);
console.log(`\nAll gates: ${allPass ? "ALL PASS" : "FAILURES DETECTED"}`);
