// The crypto alpha brief (shared/cryptoBrief.ts): plain sentences from the desk's own reads; unread is said, never zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCryptoBrief, CRYPTO_BRIEF_BASIS, type BriefCoin, type BriefInputs } from "../../shared/cryptoBrief";

const coin = (over: Partial<BriefCoin> = {}): BriefCoin => ({
  chain: "solana", pairAddress: "PAIR1111aaaa", symbol: "GEKKO", verdict: "WATCH", verdictCode: "forming", score: 51,
  marketCap: 24_000, liquidityUsd: 11_500, ageMinutes: 1900, volAccel: 0.5, netBuyRatio5m: 0.83, chg1h: -11,
  boosted: false, hardKill: false, rugFlags: [], narrativeHits: [], bskyMentions1h: 1, pumpReplyPerHr: null,
  top10Pct: 22, securityCheckedAt: 1, jupState: "agree", ...over,
});
const full = (over: Partial<NonNullable<BriefInputs["feed"]>> = {}): BriefInputs => ({
  feed: {
    asOf: 1_800_000_000_000, trackedCount: 220, candidates: [coin()],
    narrativeHeat: [{ term: "grok", hits: 4, sources: ["a", "b"] }, { term: "cat", hits: 1, sources: ["a"] }],
    narrativeUpdatedAt: 1, narrativeSources: [{ name: "CoinDesk", state: "ok", titles: 30 }, { name: "Decrypt", state: "failed", titles: 0 }],
    majors: { state: "ok", rows: [{ asset: "BTC", kraken: { state: "ok", mid: 100_220, vwap24h: 100_000 }, coinbase: { state: "ok", mid: 100_230 }, cross: { state: "agree", reference: 100_250 } }] },
    derivs: { state: "ok", rows: [{ asset: "BTC", venue: "x", state: "ok", funding8hPct: 0.01, oi1hChangePct: -1.2, oiState: "ok" }, { asset: "BTC", venue: "y", state: "ok", funding8hPct: 0.03, oi1hChangePct: null, oiState: "building" }] },
    ...over,
  },
  health: { engines: [{ name: "scanner", status: "ok", lastError: null }, { name: "watchdog", status: "ok", lastError: null }] },
  record: { desk: { state: "on", reason: "BTC +0.22% vs its Kraken 24 h VWAP" }, coins: { total: 4194, hit5m: 107, doubled: 27, rugged: 1022, dead: 77, noData: 1921, open: 1040 }, enterCoins: { total: 0, graded: 0 }, ruggedRateObserved: 0.83 },
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
  assert.match(t, /BTC \$100,250 \(\+0\.25% vs its 24 h average price\)/);
  assert.match(t, /BTC perpetuals: funding \+0\.0200% per 8 h across 2 venues \(longs pay shorts\); open interest −1\.2% over the last hour\./, "a building open-interest read is left out of the average, not counted as zero");
});

test("a source that was not read gets a line saying so, never a zero", () => {
  const b = buildCryptoBrief({ feed: { ...full().feed!, majors: null, derivs: { state: "unavailable", rows: [] }, narrativeUpdatedAt: null, narrativeHeat: [], candidates: [coin({ bskyMentions1h: null, top10Pct: null, securityCheckedAt: null, jupState: "unchecked" })] }, health: null, record: null });
  assert.match(text(b, "backdrop"), /Desk risk state: not read\./);
  assert.match(text(b, "backdrop"), /BTC, ETH and SOL prices: not read on this pass\./);
  assert.match(text(b, "backdrop"), /Perpetual funding and open interest: not read on this pass\./);
  assert.match(text(b, "narrative"), /have not been read yet/);
  assert.match(text(b, "attention"), /Social not read for 1 listed coin \(GEKKO\): unread, not zero\./);
  assert.match(text(b, "risk"), /GEKKO: mint and freeze authority unread; top-10 holders unread; Jupiter price check not done\./);
  assert.match(text(b, "risk"), /The graded record was not read\./);
  assert.match(text(b, "coverage"), /Collector health: not read\./);
  assert.equal(buildCryptoBrief({}).headline, "The feed has not been read yet.");
});

test("narrative: only terms in two or more headlines, the coins carrying them, and failed sources named", () => {
  const b = buildCryptoBrief(full({ candidates: [coin({ symbol: "GROKIA", narrativeHits: ["grok"] }), coin({ symbol: "DEADGROK", pairAddress: "P2", narrativeHits: ["grok"], hardKill: true })] }));
  const t = text(b, "narrative");
  assert.match(t, /Terms in the most headlines: grok \(4, 2 sources\)\./);
  assert.doesNotMatch(t, /cat \(1/);
  assert.match(t, /GROKIA carries "grok": WATCH, score 51, cap \$24\.0K, 31\.7 h old\./);
  assert.doesNotMatch(t, /DEADGROK/, "a hard-killed coin is not offered as a carrier");
  assert.match(t, /failed on the last read: Decrypt\. Their headlines are missing from the counts, not absent from the news\./);
  assert.match(text(buildCryptoBrief(full()), "narrative"), /No tracked coin's name or symbol matches a hot term\./);
});

test("desk: each listed coin says what it is waiting on, in the rule book's words, and a zero-Enter record is stated", () => {
  const t = text(buildCryptoBrief(full()), "desk");
  assert.match(t, /220 pools tracked: 0 Enter, 1 Watch, 0 Pass shown\./);
  assert.match(t, /GEKKO · WATCH · score 51 · cap \$24\.0K, liquidity \$11\.5K, 31\.7 h old · volume pace 0\.5x the hour's, buys 83% of 5-minute trades, −11% in the hour · waiting on: score over 50, flow not confirmed\./);
  assert.match(t, /The desk has not issued an Enter on any coin in its record\./);
  const line = buildCryptoBrief(full()).sections.find((s) => s.id === "desk")!.lines.find((l) => l.coin);
  assert.deepEqual(line!.coin, { chain: "solana", pairAddress: "PAIR1111aaaa", symbol: "GEKKO" });
});

test("attention is labelled low grade, a capped search is a lower bound, and paid boosts are named as bought", () => {
  const b = buildCryptoBrief(full({ candidates: [coin({ bskyMentions1h: 25, bskyCapped: true, pumpReplyPerHr: 40 }), coin({ symbol: "PAID", pairAddress: "P3", boosted: true })] }));
  const t = text(b, "attention");
  assert.match(t, /GEKKO: at least 25 Bluesky mentions in the hour, pump\.fun replies \+40\/h/);
  assert.match(t, /1 shown coin with a paid DexScreener boost \(PAID\): bought attention\./);
  assert.match(t, /low-grade attention proxies; they are shown, never scored\./);
});

test("risk: hard kills counted and named, a clean list says so, and the record line carries its counts", () => {
  const t = text(buildCryptoBrief(full({ candidates: [coin(), coin({ symbol: "RUG", pairAddress: "P4", verdict: "PASS", hardKill: true })] })), "risk");
  assert.match(t, /1 shown coin with a hard kill standing .*: RUG\./);
  assert.match(t, /Every listed coin has its authority, holder and price checks read, with no flag\./);
  assert.match(t, /Record over 4194 coins: 107 reached the \$5M cap, 27 doubled, 1022 rugged, 77 died, 1921 could not be priced, 1040 still open\. Observed rug rate 83% of graded coins\./);
});

test("coverage: late or failing collectors are named with their error; a collector still starting is not called failed", () => {
  const b = buildCryptoBrief({ ...full(), health: { engines: [{ name: "social", status: "error", lastError: "HTTP 429" }, { name: "candles", status: "starting", lastError: null }, { name: "watchdog", status: "ok", lastError: null }] } });
  const t = text(b, "coverage");
  assert.match(t, /social: error \(HTTP 429\)\. Lines above that depend on it may be older or missing\./);
  assert.match(t, /candles: has not completed its first run yet\. Lines above that depend on it are not read, not empty\./);
  assert.match(text(buildCryptoBrief(full()), "coverage"), /All 1 collector reporting on time\./);
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
