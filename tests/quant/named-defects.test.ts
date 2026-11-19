// The defects the owner named on the live site (2026-11-18), pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildHeatseeker } from "../../server/heatseeker";
import { intradayTapeState } from "../../shared/exchangeCalendar";
import { levelLabelSide } from "../../shared/chartLabels";

function chain(rows: Array<{ exp: string; dte: number; K: number; side: "C" | "P"; oi: number }>): any {
  const callExpDateMap: any = {}, putExpDateMap: any = {};
  for (const r of rows) {
    const key = `${r.exp}:${r.dte}`;
    const map = r.side === "C" ? callExpDateMap : putExpDateMap;
    (map[key] ??= {})[r.K.toFixed(1)] = [{ symbol: `SPXW  ${r.exp.slice(2).replace(/-/g, "")}${r.side}0${r.K}000`, volatility: 14, openInterest: r.oi, totalVolume: 10 }];
    (r.side === "C" ? putExpDateMap : callExpDateMap)[key] ??= {};
  }
  return { underlying: { last: 6700 }, callExpDateMap, putExpDateMap };
}
const twoDays = () => chain([
  { exp: "2026-10-08", dte: 0, K: 6700, side: "C", oi: 1000 }, { exp: "2026-10-08", dte: 0, K: 6690, side: "P", oi: 1000 },
  { exp: "2026-10-09", dte: 1, K: 6700, side: "C", oi: 2000 }, { exp: "2026-10-09", dte: 1, K: 6690, side: "P", oi: 2000 },
]);

test("heatseeker: after the close, no expiry asked resolves to the next unsettled expiry, not the settled one", () => {
  const during = Date.UTC(2026, 9, 8, 15, 0);  // 11:00 ET
  const after = Date.UTC(2026, 9, 8, 22, 0);   // 18:00 ET, today's contracts have settled
  const d = buildHeatseeker(twoDays(), "$SPX", 6700, null, during);
  assert.equal(d.expiry, "2026-10-08");
  assert.equal(d.nearestLiveExpiry, "2026-10-08");
  const a = buildHeatseeker(twoDays(), "$SPX", 6700, null, after);
  assert.equal(a.expiry, "2026-10-09");
  assert.equal(a.dataState, "ok");
  assert.ok(a.strikes.length > 0);
  assert.equal(a.nearestLiveExpiry, "2026-10-09");
});

test("heatseeker: a settled expiry asked for by date says it has settled", () => {
  const after = Date.UTC(2026, 9, 8, 22, 0);
  const a = buildHeatseeker(twoDays(), "$SPX", 6700, "2026-10-08", after);
  assert.equal(a.expiry, "2026-10-08");
  assert.equal(a.dataState, "unavailable");
  assert.equal(a.reason, "the 2026-10-08 expiry has settled: its contracts carry no exposure. Pick a later expiry.");
});

test("heatseeker: every listed expiry settled still answers with a reason", () => {
  const later = Date.UTC(2026, 9, 12, 22, 0);
  const a = buildHeatseeker(twoDays(), "$SPX", 6700, null, later);
  assert.equal(a.dataState, "unavailable");
  assert.equal(a.nearestLiveExpiry, null);
  assert.match(a.reason ?? "", /has settled/);
});

test("SPY tape: an empty tape carries the feed's own reason when there is one", () => {
  const mid = Date.UTC(2026, 9, 8, 15, 0); // a Thursday, 11:00 ET
  assert.equal(intradayTapeState(3, mid, "x").dataState, "ok");
  assert.equal(intradayTapeState(0, mid, "token expired").reason, "the price feed returned no bars: token expired");
  assert.equal(intradayTapeState(0, mid).reason, "intraday tape returned no bars (feed failed or empty)");
  assert.equal(intradayTapeState(0, mid, "  ").reason, "intraday tape returned no bars (feed failed or empty)");
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /tapeReason = ohlc\?\.dataReason \?\? null/);
  assert.match(routes, /intradayTapeState\(candles\.length, Date\.now\(\), tapeReason\)/);
});

test("SPY panel: with no band it is not titled a projected path and says where today's path is", () => {
  const p = readFileSync(new URL("../../client/src/components/MLProjectionPanel.tsx", import.meta.url), "utf8");
  assert.match(p, /hasBands \? "SPY — Projected Path" : "SPY — today's tape \(no projected path drawn\)"/);
  assert.match(p, /No projected path is drawn here: \{served\?\.reason \?\? "waiting for the projection service"\}\. The projected path for today \(\$SPX\) is at the top of the Signals tab, in the Today block\./);
});

test("Models chart: a level close to the price is labelled on the right, clear of the path start", () => {
  assert.equal(levelLabelSide(7332, 7324, 7124, 7773), "right");
  assert.equal(levelLabelSide(7271, 7324, 7124, 7773), "left");
  assert.equal(levelLabelSide(7522, 7324, 7124, 7773), "left");
  assert.equal(levelLabelSide(7332, null, 7124, 7773), "left");
  assert.equal(levelLabelSide(7332, 7324, 7500, 7500), "left");
  const m = readFileSync(new URL("../../client/src/components/ModelsPanel.tsx", import.meta.url), "utf8");
  assert.match(m, /levelLabelSide\(lv\.price, horizon\.spot, yMin, yMax\) === "right" \? "insideTopRight" : "insideTopLeft"/);
});
