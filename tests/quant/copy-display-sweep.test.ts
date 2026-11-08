// Review item 7: instruction-style copy, `?? 0` reaching the screen, asOf never
// shown, the legibility floor only on desktop, the DEX flip fallback unmarked,
// "MOPEX max pain" over every expiry in the window, vomma "normal" on a missing VIX.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asOfMs, asOfText } from "../../client/src/lib/asOf";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("AsOfNote: ms, seconds and ISO parse; missing reads unknown, never now", () => {
  const now = Date.parse("2026-11-08T15:00:00Z");
  assert.equal(asOfMs(now - 5000), now - 5000);
  assert.equal(asOfMs(Math.floor((now - 120_000) / 1000)), Math.floor((now - 120_000) / 1000) * 1000, "epoch seconds are converted");
  assert.equal(asOfMs("2026-11-08T14:00:00Z"), Date.parse("2026-11-08T14:00:00Z"));
  assert.equal(asOfMs(null), null); assert.equal(asOfMs(0), null); assert.equal(asOfMs("not a date"), null);
  assert.equal(asOfText(null, now), "read time unknown");
  assert.match(asOfText(now - 120_000, now), /· 2 min ago$/);
  assert.match(asOfText(now - 5 * 3600_000, now), /· 5\.0 h ago$/);
});

test("copy: no instruction-style phrases in the swept panels", () => {
  const files = ["EdgeInfo", "DailyPlaybookChart", "MLProjectionPanel", "TradeDesk", "TickerOutlookCard", "ExposurePanel", "SeasonalityPanel", "CanaryStrip"];
  const banned = /fade pushes|don't fade|respect momentum|Expect momentum|Expect mean-reversion|buy dips, sell rips|buy-the-dip|long entry|short entry|sizing should|should be combined|RISK-ON CONFIRMED|Dealers sell rallies|Dealers buy dips/;
  for (const f of files) assert.doesNotMatch(read(`client/src/components/${f}.tsx`), banned, f);
});

test("display: null numbers read n/a or unknown, not 0 or now", () => {
  const cp = read("client/src/components/CryptoPanel.tsx");
  assert.doesNotMatch(cp, /feed\.asOf \?\? Date\.now\(\)/);
  assert.doesNotMatch(cp, /fmtUsd\(ok\.stress\.top10ValueUsd \?\? 0\)|fmtUsd\(ok\.stress\.quoteReserveUsd \?\? 0\)|Math\.round\(c\.fomoScore \?\? 0\)|\(f\.takerBuyShare \?\? 0\)/);
  assert.doesNotMatch(read("client/src/components/ThermalHeatmap.tsx"), /hover\.callVolume \?\? 0/);
  assert.doesNotMatch(read("client/src/components/SchwabSettings.tsx"), /formatDuration\(status\?\.expiresIn \?\? 0\)|formatDuration\(status\?\.refreshExpiresIn \?\? 0\)/);
  assert.doesNotMatch(read("client/src/components/ChainAudit.tsx"), /staleAgeSec \?\? 0/);
  assert.doesNotMatch(read("client/src/components/PositionSizer.tsx"), /fmtCents\(r\.maxLossDollars \?\? 0\)/);
  for (const f of ["Mag7Panel", "JPMCollarPanel", "OdteForward", "DailyPlaybookChart", "RegimeHeadline", "TickerOutlookCard", "DepthSkewFlow"]) {
    assert.match(read(`client/src/components/${f}.tsx`), /<AsOfNote asOf=/, `${f} shows its asOf`);
  }
  const css = read("client/src/index.css");
  assert.match(css, /@media \(max-width: 1023px\) \{\s*\.batcave-shell \[class~="text-\[8px\]"\],\s*\.batcave-shell \[class~="text-\[9px\]"\],\s*\.batcave-shell \[class~="text-\[10px\]"\] \{ font-size: 11px;/);
});

test("models: DEX flip fallback is named, max pain says its window, vomma on a missing VIX is unavailable", () => {
  const ca = read("server/chainAudit.ts");
  assert.match(ca, /flipMethod: "sign_change" \| "peak_fallback" \| "none";/);
  assert.match(ca, /if \(flipStrike != null\) flipMethod = "peak_fallback";/);
  assert.match(read("client/src/components/ChainAudit.tsx"), /DEX Peak Strike \(no flip\)/);
  const m = read("server/models.ts");
  assert.match(m, /label: `WINDOW MAX PAIN \$\{fmtK\(mp\)\}`,/);
  assert.match(m, /kind: "mopexMaxPain",/, "the persistent kind id is unchanged");
  assert.match(m, /vomma: "elevated" \| "normal" \| "unavailable" = vix == null \? "unavailable" : vix > 20 \? "elevated" : "normal";/);
  assert.match(read("client/src/components/ModelsPanel.tsx"), /VIX unavailable: vol level not read/);
});
