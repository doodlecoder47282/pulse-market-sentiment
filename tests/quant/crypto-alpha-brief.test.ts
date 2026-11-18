// The crypto alpha brief (shared/cryptoBrief.ts): plain sentences from the desk's own reads; unread is said, never zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCryptoBrief, CRYPTO_BRIEF_BASIS, type BriefCoin, type BriefInputs } from "../../shared/cryptoBrief";

const coin = (over: Partial<BriefCoin> = {}): BriefCoin => ({
  chain: "solana", pairAddress: "PAIR1111aaaa", symbol: "GEKKO", verdict: "WATCH", verdictCode: "forming", score: 51,
  marketCap: 24_000, liquidityUsd: 11_500, ageMinutes: 1900, volAccel: 0.5, netBuyRatio5m: 0.83, chg1h: -11,
  boosted: false, hardKill: false, rugFlags: [], narrativeHits: [], bskyMentions1h: 1, pumpReplyPerHr: null, socialStatus: "ok",
  top10Pct: 22, securityCheckedAt: 1, jupState: "agree", ...over,
});
const full = (over: Partial<NonNullable<BriefInputs["feed"]>> = {}): BriefInputs => ({
  feed: {
    asOf: 1_800_000_000_000, trackedCount: 220, candidates: [coin()],
    narrativeHeat: [{ term: "grok", hits: 4, sources: ["a", "b"] }, { term: "cat", hits: 1, sources: ["a"] }],
    narrativeUpdatedAt: 1_800_000_000_000, narrativeSources: [{ name: "CoinDesk", state: "ok", titles: 30 }, { name: "Decrypt", state: "failed", titles: 0 }, { name: "Quiet", state: "empty", titles: 0 }],
    majors: { asOf: 1_800_000_000_000, state: "ok", rows: [{ asset: "BTC", kraken: { state: "ok", mid: 100_220, vwap24h: 100_000 }, coinbase: { state: "ok", mid: 100_230 }, cross: { state: "agree", reference: 100_250 } }] },
    derivs: { state: "ok", rows: [{ asset: "BTC", venue: "x", state: "ok", funding8hPct: 0.01, oi1hChangePct: -1.2, oiState: "ok" }, { asset: "BTC", venue: "y", state: "ok", funding8hPct: 0.03, oi1hChangePct: null, oiState: "building" }] },
    ...over,
  },
  health: { engines: [{ name: "scanner", status: "ok", lastError: null }, { name: "watchdog", status: "ok", lastError: null }] },
  record: { desk: { state: "on", reason: "BTC +0.22% vs its Kraken 24 h VWAP" }, coins: { total: 4194, hit5m: 107, doubled: 27, rugged: 1022, dead: 77, noData: 1921, open: 1040, graded: 1233 }, enterCoins: { total: 0, graded: 0 }, ruggedRateObserved: 0.83, noDataShare: 0.61 },
  codeText: { forming: "score over 50, flow not confirmed" },
});
const text = (b: ReturnType<typeof buildCryptoBrief>, id: string) => b.sections.find((s) => s.id === id)!.lines.map((l) => l.text).join("\n");

test("six sections in reading order, each with at least one line, and a headline", () => {
  const b = buildCryptoBrief(full());
  assert.deepEqual(b.sections.map((s) => s.id), ["backdrop", "narrative", "desk", "attention", "risk", "coverage"]);
  for (const s of b.sections) assert.ok(s.lines.length >= 1, s.id);
  assert.equal(b.headline, 'Nothing on Enter, 1 on Watch; desk risk on; hottest term "grok".');
  assert.equal(b.asOf, 1_800_000_000_000);
  assert.equal(b.basis, CRYPTO_BRIEF_BASIS);
});

test("backdrop: desk state with its reason, majors against their 24 h average, funding averaged over venues actually read", () => {
  const t = text(buildCryptoBrief(full()), "backdrop");
  assert.match(t, /Desk risk is on: BTC \+0\.22% vs its Kraken 24 h VWAP\./);
  assert.match(t, /BTC \$100,250 \(Kraken \+0\.22% vs its 24 h VWAP\)/, "the reference price, and Kraken's own mid against Kraken's own VWAP");
  assert.match(t, /BTC perpetuals: funding \+0\.0200% per 8 h, average of 2 venues \(longs pay shorts\); open interest −1\.2% over about an hour, average of 1 venue\./, "each average states its own venue count; a building read is left out, not counted as zero");
  assert.match(t, /ETH perpetuals: no venue read\./);
});

test("a source that was not read gets a line saying so, never a zero", () => {
  const b = buildCryptoBrief({ feed: { ...full().feed!, majors: null, derivs: { state: "unavailable", rows: [] }, narrativeUpdatedAt: null, narrativeHeat: [], candidates: [coin({ bskyMentions1h: null, top10Pct: null, securityCheckedAt: null, jupState: "unchecked" })] }, health: null, record: null });
  assert.match(text(b, "backdrop"), /Desk risk state: not read\./);
  assert.match(text(b, "backdrop"), /BTC, ETH and SOL prices: not read on this pass\./);
  assert.match(text(b, "backdrop"), /Perpetual funding and open interest: not read on this pass\./);
  assert.match(text(b, "narrative"), /have not been read yet/);
  assert.match(text(b, "attention"), /No current social read for 1 listed coin \(GEKKO\): unread or expired, not zero\./);
  assert.match(text(b, "risk"), /GEKKO: mint and freeze authority unread; top-10 holders unread; Jupiter price check not done\./);
  assert.match(text(b, "risk"), /The graded record was not read\./);
  assert.match(text(b, "coverage"), /Collector health: not read\./);
  assert.equal(buildCryptoBrief({}).headline, "The feed has not been read yet.");
});

test("narrative: only terms in two or more headlines, the coins carrying them, and failed sources named", () => {
  const b = buildCryptoBrief(full({ candidates: [coin({ symbol: "GROKIA", narrativeHits: ["grok"] }), coin({ symbol: "DEADGROK", pairAddress: "P2", narrativeHits: ["grok"], hardKill: true })] }));
  const t = text(b, "narrative");
  assert.match(t, /Terms in the most headlines over 24 h: grok \(4 headlines, 2 sources\)\./);
  assert.doesNotMatch(t, /cat \(1/);
  assert.match(t, /GROKIA carries "grok": WATCH, score 51, cap \$24\.0K, 31\.7 h old\./);
  assert.doesNotMatch(t, /DEADGROK/, "a hard-killed coin is not offered as a carrier");
  assert.match(t, /failed on the last read: Decrypt\. Their headlines are missing from the counts, not absent from the news\./);
  assert.match(text(buildCryptoBrief(full()), "narrative"), /No served coin without a hard kill matches a hot term\./);
  assert.match(text(buildCryptoBrief(full({ narrativeUpdatedAt: 1_800_000_000_000 - 90 * 60_000 })), "narrative"), /over 24 h as of the last read 90 min before this feed: grok/, "old heat is dated, not called current");
  assert.match(text(buildCryptoBrief(full({ narrativeHeat: [] })), "narrative"), /No term appears in two or more headlines \(2 of 3 news sources answered\)\./, "an empty source answered; only the failed one did not");
});

test("desk: each listed coin says what it is waiting on, in the rule book's words, and a zero-Enter record is stated", () => {
  const t = text(buildCryptoBrief(full()), "desk");
  assert.match(t, /220 pools tracked; among the 1 highest-ranked served here: 0 Enter, 1 Watch, 0 Pass\./);
  assert.match(t, /GEKKO · WATCH · score 51 · cap \$24\.0K, liquidity \$11\.5K, 31\.7 h old · volume pace 0\.5x the hour's, buys 83% of 5-minute trades, −11% in the hour · held by: score over 50, flow not confirmed\./);
  assert.match(t, /The desk has not issued an Enter on any coin in its record\./);
  const line = buildCryptoBrief(full()).sections.find((s) => s.id === "desk")!.lines.find((l) => l.coin);
  assert.deepEqual(line!.coin, { chain: "solana", pairAddress: "PAIR1111aaaa", symbol: "GEKKO" });
});

test("attention is labelled low grade, a capped search is a lower bound, and paid boosts are named as bought", () => {
  const b = buildCryptoBrief(full({ candidates: [coin({ bskyMentions1h: 25, bskyCapped: true, pumpReplyPerHr: 40 }), coin({ symbol: "PAID", pairAddress: "P3", boosted: true })] }));
  const t = text(b, "attention");
  assert.match(t, /GEKKO: at least 25 Bluesky mentions in the hour, pump\.fun replies \+40 per hour/);
  assert.match(t, /1 served coin with a paid DexScreener boost \(PAID\): bought attention\./);
  assert.match(t, /low-grade attention proxies; they are shown, never scored\./);
});

test("risk: hard kills counted and named, a clean list says so, and the record line carries its counts", () => {
  const t = text(buildCryptoBrief(full({ candidates: [coin(), coin({ symbol: "RUG", pairAddress: "P4", verdict: "PASS", hardKill: true })] })), "risk");
  assert.match(t, /1 served coin with a hard kill standing .*: RUG\./);
  assert.match(t, /Every listed coin has its authority, holder and price checks read, with no flag\./);
  assert.match(t, /Record over 4194 coins: 107 reached the \$5M cap, 27 doubled, 1022 rugged, 77 died, 1921 could not be priced, 1040 still open\./);
  assert.match(t, /1022 of 1233 graded coins rugged\. No rate is quoted: 61% of resolved coins could not be priced, over the 20% limit, and an unpriced coin is often a rug\./);
  assert.doesNotMatch(t, /83%/, "no bare rate while the no-data share is over the limit");
  const ok = text(buildCryptoBrief({ ...full(), record: { ...full().record!, noDataShare: 0.1 } }), "risk");
  assert.match(ok, /1022 of 1233 graded coins rugged \(83%\)\./, "inside the limit the rate is shown with its n");
});

test("coverage: late or failing collectors are named with their error; a collector still starting is not called failed", () => {
  const b = buildCryptoBrief({ ...full(), health: { engines: [{ name: "social", status: "error", lastError: "HTTP 429" }, { name: "candles", status: "starting", lastError: null }, { name: "watchdog", status: "ok", lastError: null }] } });
  const t = text(b, "coverage");
  assert.match(t, /social: error \(HTTP 429\)\. Lines above that depend on it may be older or missing\./);
  assert.match(t, /candles: has not completed its first run yet\. Lines above that depend on it are not read, not empty\./);
  assert.match(text(buildCryptoBrief(full()), "coverage"), /All 1 collector reporting on time\./);
});

test("a stale or diverged venue is never turned into a price or a percent", () => {
  const stale = buildCryptoBrief(full({ majors: { asOf: 1_800_000_000_000, state: "partial", rows: [
    { asset: "BTC", kraken: { state: "stale", mid: 99_000, vwap24h: 95_000 }, coinbase: { state: "ok", mid: 100_000 }, cross: { state: "single-source", reference: 100_000 } },
    { asset: "ETH", kraken: { state: "ok", mid: 3_000, vwap24h: 2_990 }, coinbase: { state: "ok", mid: 3_100 }, cross: { state: "diverge", reference: null } },
    { asset: "SOL", kraken: { state: "ok", mid: null, vwap24h: null }, coinbase: { state: "ok", mid: null }, cross: { state: "unavailable", reference: null } },
  ] } }));
  const t = text(stale, "backdrop");
  assert.match(t, /BTC \$100,000 \(Kraken 24 h VWAP not read\)/, "a stale Kraken VWAP is not compared against");
  assert.doesNotMatch(t, /5\.26%/);
  assert.match(t, /ETH: Coinbase and Kraken disagree; no reference price is shown\./);
  assert.doesNotMatch(t, /ETH \$/);
  assert.match(t, /SOL price: not read\./);
  const old = text(buildCryptoBrief(full({ majors: { ...full().feed!.majors!, asOf: 1_800_000_000_000 - 25 * 60_000 } })), "backdrop");
  assert.match(old, /Majors last read 25 min before this feed\./);
});

test("an expired social read is not shown as current, and only listed coins are links", () => {
  const b = buildCryptoBrief(full({ candidates: [
    coin({ symbol: "OLD", bskyMentions1h: 40, socialStatus: "stale" }),
    coin({ symbol: "PASSED", pairAddress: "P6", verdict: "PASS", bskyMentions1h: 12, narrativeHits: ["grok"] }),
  ] }));
  const att = b.sections.find((s) => s.id === "attention")!.lines;
  assert.ok(!att.some((l) => /OLD: .*40 Bluesky/.test(l.text)), "a stale count is not printed as this hour's");
  assert.ok(att.some((l) => /No current social read for 1 listed coin \(OLD\)/.test(l.text)));
  const passed = [...att, ...b.sections.find((s) => s.id === "narrative")!.lines].filter((l) => /PASSED/.test(l.text));
  assert.ok(passed.length >= 2, "a Pass coin is still described");
  assert.ok(passed.every((l) => l.coin === undefined), "but is not a link: its card is in a collapsed, truncated section");
});

test("lists are capped with the remainder stated, unread authorities qualify 'no hard kill', and a failed feed request is said", () => {
  const many = Array.from({ length: 8 }, (_, k) => coin({ symbol: `W${k}`, pairAddress: `PW${k}`, score: 60 - k, securityCheckedAt: null, rugFlags: ["x"] }));
  const b = buildCryptoBrief({ ...full({ candidates: many }), feedError: true });
  assert.match(text(b, "desk"), /3 more on Watch, listed below\./);
  const r = text(b, "risk");
  assert.match(r, /No served coin has a hard kill standing\. Mint and freeze authority are unread on 8 of 8 served coins, so an authority kill cannot show on those yet\./);
  assert.match(r, /W0: mint and freeze authority unread; 1 flag on its card\./);
  assert.match(r, /3 more listed coins have an unread check or a flag; see their cards\./);
  assert.match(text(b, "coverage"), /The last feed request failed: this brief is built from the last successful read/);
  assert.match(text(buildCryptoBrief({ ...full(), record: { ...full().record!, coins: { total: 10, hit5m: 0, doubled: 0, rugged: 0, dead: 0, open: 10 } } }), "risk"), /unpriced count not reported/);
});

test("the brief describes: no advice, forecast or edge wording anywhere, and no emojis", () => {
  const b = buildCryptoBrief(full({ candidates: [coin({ verdict: "ENTER", verdictCode: "enter" }), coin({ symbol: "B", pairAddress: "P5", boosted: true, hardKill: true })] }));
  const all = [b.headline, b.basis, ...b.sections.flatMap((s) => [s.title, ...s.lines.map((l) => l.text)])].join("\n");
  assert.doesNotMatch(all, /\b(buy|sell|should|recommend|will (rise|fall|pump|moon)|guaranteed|edge|alpha signal|likely to)\b/i);
  assert.doesNotMatch(all, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.match(b.basis, /No model writes it and it places no orders\./);
});

test("the tab renders the brief from the payloads it already loads, above the guide, with coin lines that jump to the card", () => {
  const panel = readFileSync(new URL("../../client/src/components/CryptoPanel.tsx", import.meta.url), "utf8");
  assert.ok(panel.indexOf("<CryptoAlphaBrief inputs={briefInputs} onPick={jumpTo} />") > panel.indexOf("<DeskBrief "));
  assert.ok(panel.indexOf("<CryptoAlphaBrief ") < panel.indexOf("<CryptoHowTo />"));
  const cmp = readFileSync(new URL("../../client/src/components/CryptoAlphaBrief.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(cmp, /useQuery|fetch\(/, "no request of its own");
  assert.match(cmp, /useState\(true\)/, "open by default");
  assert.match(cmp, /onClick=\{\(\) => onPick\(l\.coin!\)\}/);
  assert.match(cmp, /min-h-\[44px\]/);
});
