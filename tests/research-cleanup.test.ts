import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStockTradeBrief } from "../server/tradeBrief";
import { verifyStoredCalculations } from "../server/evidenceReplay";
import { TRADE_BRIEF_INSTRUMENTS, TradeBriefSchema } from "../shared/tradeBrief";
import { summarizeTradeBrief } from "../shared/tradeBriefPresentation";
import { previousSessions } from "../server/equityCalendar";
import { etEpochMs } from "../server/etTime";

const now = Date.parse("2026-10-02T05:23:00Z");
const instrument = TRADE_BRIEF_INSTRUMENTS.find(i => i.symbol === "INTC")!;
const dates = previousSessions("2026-10-02", 20)!;
const history = { symbol: "INTC", candles: dates.map(date =>
  ({ datetime: etEpochMs(date, 0, 0), open: 100, high: 110, low: 90, close: 105, volume: 1000 })) };
const quote = { INTC: { symbol: "INTC", assetMainType: "EQUITY", realtime: true,
  quote: { lastPrice: 106, tradeTime: now - 6 * 3600_000, quoteTime: now - 6 * 3600_000, totalVolume: 0 } } };
const ok = (value: unknown) => ({ state: "ok" as const, value });
const build = (h: unknown = history, q: unknown = quote, news?: unknown) => buildStockTradeBrief(instrument, "swing",
  { quote: ok(q), history: ok(h), macro: ok([]), news }, now);

test("overnight research retains dated real observations without granting a live quote or levels", () => {
  const b = build(), s = summarizeTradeBrief(b, false);
  assert.ok(TradeBriefSchema.safeParse(b).success);
  assert.equal(b.quote, null); assert.equal(b.verdict, "INSUFFICIENT DATA"); assert.deepEqual(b.levels, []);
  assert.equal(s.live, false); assert.equal(s.price?.value, 106);
  assert.equal(s.close?.value, 105); assert.equal(s.close?.observed_at, "2026-10-01");
  assert.equal(s.volume?.value, 1000); assert.equal(s.outsideCore, true);
  assert.equal(b.risk.planned_loss, null);
});
test("historical ATR works independently; current-price ratios and distances stay withheld", () => {
  const b = build();
  assert.equal(b.evidence.find(e => e.id === "atr14")?.value, 20);
  assert.equal(b.evidence.some(e => e.id === "price-atr-percent" || e.id.startsWith("distance-")), false);
  assert.equal(b.context_items?.find(e => e.id === "factor-atr")?.evidence_ids.join(","), "atr14");
  assert.equal(verifyStoredCalculations(b).status, "matched");
});
test("wrong listing, synthetic, future, missing scheduled session and malformed bars cannot create historical context", () => {
  for (const h of [
    { ...history, symbol: "SPY" }, { ...history, synthetic: true },
    { ...history, candles: history.candles.map(b => ({ ...b, high: 0 })) },
    { ...history, candles: history.candles.filter(b => b.datetime !== etEpochMs("2026-10-01", 0, 0)) },
    { ...history, candles: [...history.candles, { ...history.candles[0], datetime: now + 1 }] },
  ]) {
    const b = build(h);
    assert.equal(b.evidence.some(e => e.id.startsWith("history-session-")), false);
    assert.equal(b.evidence.some(e => e.id === "atr14"), false);
  }
});
test("expiry never promotes an observed price and summary does not mutate archived evidence", () => {
  const b = build(), saved = JSON.stringify(b), s = summarizeTradeBrief(b, true);
  assert.equal(s.live, false); assert.equal(s.price?.value, 106); assert.match(s.title, /Saved research/);
  assert.equal(JSON.stringify(b), saved); assert.ok(s.findings.length <= 3);
  assert.equal(new Set(s.findings.map(x => x.text)).size, s.findings.length);
});
test("distinctive financial issuer titles pass only with original date, health and allowed publisher", () => {
  const news = (title: string, status = "ok") => ({ asOf: now / 1000,
    feeds: [{ source: "CNBC Markets", status, checked_at: new Date(now - 1000).toISOString() }],
    headlines: [{ title, source: "CNBC Markets", url: "https://www.cnbc.com/2026/10/02/intel-earnings.html",
      published: (now - 60_000) / 1000, publication_verified: true }] });
  assert.ok(build(history, quote, news("Intel shares rise after earnings")).context_items?.some(c => c.category === "news"));
  for (const n of [news("Latest intel on a military operation"), news("Intel shares rise after earnings", "error"),
    { ...news("Intel shares rise after earnings"), asOf: (now - 3600_000) / 1000 }]) {
    assert.equal(build(history, quote, n).context_items?.some(c => c.category === "news"), false);
  }
});
test("stock content is scoped, Crypto is pinned, selection scrolls forward as well as back", () => {
  const dashboard = readFileSync("client/src/pages/dashboard.tsx", "utf8");
  assert.match(dashboard, /hidden=\{activeTab !== "signals"\} data-testid="stock-research-workspace"/);
  assert.match(dashboard, /const primary = \["signals", "crypto", "chart"\]/);
  assert.match(dashboard, /data-testid="bottomnav-more"/);
  assert.doesNotMatch(dashboard, /if \(window\.scrollY > top - offset\)/);
  assert.match(dashboard, /<DialogTitle[^>]*>Workspaces/);
  assert.match(dashboard, /minmax\(min\(100%, 8rem\), 1fr\)/);
  assert.match(dashboard, /moreButtonRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});
test("concise surface puts repetition and technical details behind disclosures; insufficient AI is blocked", () => {
  const ui = readFileSync("client/src/components/TradeBriefSearch.tsx", "utf8");
  assert.match(ui, /<TradeBriefSummary/); assert.match(ui, /data-testid="brief-full-record"/);
  assert.match(ui, /data-testid="brief-history-toggle"/);
  const ai = readFileSync("client/src/components/TradeBriefAi.tsx", "utf8");
  assert.ok((ai.match(/brief.verdict === "INSUFFICIENT DATA"/g) ?? []).length >= 2);
});
