// Audit 2026-11-16, Signals / Chart batch: S1, S2, S3, S4, S13, S14, S16, S18.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterDismissal, type FlowAlert } from "../../shared/flowAlerts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("S1/S14/S18: the chart's gamma banner has four regime states and the SPY route sends the snapshot's regime and the chain's time", () => {
  const b = read("client/src/components/GammaContextBanner.tsx");
  assert.match(b, /regime: "positive" \| "negative" \| "neutral" \| "unknown";/);
  assert.match(b, /NET GAMMA NEAR ZERO/);
  assert.match(b, /GAMMA SIGN UNKNOWN/);
  // Anything that is not "positive" used to read NEG GAMMA.
  assert.doesNotMatch(b, /regimePositive\s*\?\s*"POS GAMMA · mean-revert"\s*:\s*"NEG GAMMA/);
  const r = read("server/routes.ts");
  assert.doesNotMatch(r, /regime: g\.totalGex >= 0 \? "positive" : "negative"/);
  assert.match(r, /regime: g\.regime,\s*profile: g\.profile,\s*\},[\s\S]{0,200}asOf: snap\.gammaAsOf \?\? null,/);
  const d = read("client/src/pages/dashboard.tsx");
  assert.match(d, /gamma\.regime === "negative" \? "trend\/breakout" : "net GEX within ±\$50M"/);
});

test("S16: a DTE bucket with no call open interest has no put/call ratio, not 0.00", () => {
  const s = read("server/sources.ts");
  assert.match(s, /pcrOi:\s+cOi\s+\? pOi\s+\/ cOi\s+: null,/);
  assert.match(s, /pcrVol: cVol \? pVol \/ cVol : null,/);
  assert.match(read("shared/schema.ts"), /pcrByBucket: \{ label: string; dteMax: number; pcrOi: number \| null; pcrVol: number \| null;/);
  assert.match(read("client/src/pages/dashboard.tsx"), /active\.pcrOi != null && active\.pcrOi > 1\.5/);
});

test("S2/S13: the closed count does not claim 'today'; an unavailable scan is not 'no whales pass'", () => {
  const w = read("client/src/components/WhaleFlowPanel.tsx");
  assert.doesNotMatch(w, /closed today/);
  assert.match(w, /\{closedPositions\.length\} closed or expired \(stored\)/);
  const i = w.indexOf('data-testid="fresh-whales-unavailable"');
  const j = w.indexOf('data-testid="fresh-whales-empty"');
  assert.ok(i > 0 && j > i, "the unavailable branch comes before the empty one");
  assert.match(w, /whaleGroups\.length === 0 && previewQuery\.data\?\.dataState === "unavailable"/);
});

test("S3/S4: a dismissed alert is not re-added by the next poll; a symbol change clears the comparison baseline", () => {
  const f = read("client/src/components/FlowAlertsPanel.tsx");
  assert.match(f, /const kept = afterDismissal\(newAlerts, dismissedRef\.current\);/);
  assert.match(f, /dismissedRef\.current\.set\(id, a\.severity\);/);
  assert.match(f, /for \(const a of prev\) dismissedRef\.current\.set\(a\.id, a\.severity\);/);
  assert.match(f, /useEffect\(\(\) => \{ prevPcrRef\.current = null; prevChainRef\.current = null; \}, \[symbol\]\);/);
  // The reset is declared before the alert engine effect, so it runs first on a symbol change.
  assert.ok(f.indexOf("prevPcrRef.current = null; prevChainRef.current = null;") < f.indexOf("// Run alert engine whenever chain data updates"));
});

test("S8/S9: a failed tape or quote refresh is shown as failed; VIX with no change is not red", () => {
  const m = read("client/src/components/MacroCarousel.tsx");
  assert.match(m, /const \{ data, isLoading, isError \} = useMacroQuery\(\);/);
  assert.ok(m.indexOf("if (isError && !data)") < m.indexOf("if (isLoading || !data)"), "a failed first request is not an endless Loading");
  assert.match(m, /Refresh failed/);
  const q = read("client/src/components/LiveQuoteStrip.tsx");
  assert.match(q, /const vixKnown = data\.vix\.changePct != null;/);
  assert.match(q, /neutralClassName=\{!vixKnown \? "text-foreground"/);
  assert.match(q, /data-testid="live-quote-strip-failed"/);
});

test("S3 review: a dismissal hides a standing condition, never a later P/C shift, and not a rise in severity", () => {
  const mk = (id: string, type: FlowAlert["type"], severity: FlowAlert["severity"]): FlowAlert => ({ id, ts: 1, type, symbol: "SPY", message: "", severity });
  const d = new Map<string, FlowAlert["severity"]>([["WALL:SPY:600:C", "med"], ["PC_SHIFT:SPY:x:x", "low"], ["BLOCK:SPY:590:P", "med"]]);
  const out = afterDismissal([mk("WALL:SPY:600:C", "WALL", "med"), mk("PC_SHIFT:SPY:x:x", "PC_SHIFT", "high"), mk("BLOCK:SPY:590:P", "BLOCK", "high"), mk("WALL:SPY:610:C", "WALL", "low")], d);
  assert.deepEqual(out.map((a) => a.id), ["PC_SHIFT:SPY:x:x", "BLOCK:SPY:590:P", "WALL:SPY:610:C"]);
  assert.equal(d.has("BLOCK:SPY:590:P"), false, "once it returns it is no longer dismissed");
  assert.equal(afterDismissal([mk("WALL:SPY:600:C", "WALL", "low")], d).length, 0);
});
