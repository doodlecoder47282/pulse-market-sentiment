import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMintEvidence, rawTop10AccountPct, SPL_TOKEN_PROGRAM } from "../shared/cryptoSecurity";
import { parseDeskRss, dedupeHeadlines, safeNewsUrl, normalizeLiquidQuote, normalizeDerivative,
  evidenceAge, summarizeSocialPosts } from "../shared/cryptoDesk";

const now = 1790794800000;
const mint = () => ({ context: { slot: 42 }, value: { owner: SPL_TOKEN_PROGRAM, executable: false,
  data: { parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null,
    supply: "1000000000000000000", decimals: 9, isInitialized: true } } } } });

test("mint parsing requires program, initialized mint type and explicit authorities", () => {
  assert.equal(parseMintEvidence(mint()).state, "CHECKED");
  assert.equal(parseMintEvidence(mint()).mintAuthorityActive, false);
  const missing = mint(); delete (missing.value.data.parsed.info as any).mintAuthority;
  assert.equal(parseMintEvidence(missing).mintAuthorityActive, null);
  const notMint = mint(); notMint.value.data.parsed.type = "account";
  assert.equal(parseMintEvidence(notMint).state, "UNKNOWN");
  const unsupported = mint(); unsupported.value.owner = "Token2022OrAnotherProgram";
  assert.equal(parseMintEvidence(unsupported).state, "UNSUPPORTED");
  assert.equal(parseMintEvidence(unsupported).freezeAuthorityActive, null);
  const active = mint(); (active.value.data.parsed.info as any).mintAuthority = SPL_TOKEN_PROGRAM;
  assert.equal(parseMintEvidence(active).mintAuthorityActive, true);
});
test("raw account concentration includes the largest and does not lose integer precision", () => {
  const rows = [{ address: "A", amount: "900000000000000000" }, { address: "B", amount: "100000000000000000" }];
  assert.equal(rawTop10AccountPct(rows, "1000000000000000000"), 100);
  assert.equal(rawTop10AccountPct([...rows, rows[0]], "1000000000000000000"), null);
  assert.equal(rawTop10AccountPct(rows, "0"), null);
  assert.equal(rawTop10AccountPct(rows, "1"), null);
});
test("RSS validates schema, preserves missing times and sanitizes navigation URLs", () => {
  const xml = `<rss><channel><item><title><![CDATA[Verified &amp; attributed]]></title><link>https://example.com/a?utm_source=x</link></item>
    <item><title>Malicious link</title><link>javascript:alert(1)</link></item></channel></rss>`;
  const rows = parseDeskRss(xml, "Fixture", "crypto", now);
  assert.equal(rows.length, 1); assert.equal(rows[0].publishedAt, null);
  assert.equal(rows[0].url, "https://example.com/a"); assert.equal(rows[0].title, "Verified & attributed");
  assert.equal(safeNewsUrl("https://user:password@example.com"), null);
  assert.throws(() => parseDeskRss("<html>200 OK</html>", "broken", "crypto", now));
  assert.equal(dedupeHeadlines([...rows, ...rows]).length, 1);
});
test("spot normalization separates zero, missing, stale and crossed markets", () => {
  const ticker = { price: "100", bid: "99", ask: "101", volume: "0", time: new Date(now).toISOString() };
  const stats = { open: "80", low: "75", high: "105" };
  const q = normalizeLiquidQuote("BTC", ticker, stats, now);
  assert.equal(q.state, "HEALTHY"); assert.equal(q.volumeBase24h, 0);
  assert.equal(q.spreadBps, 200); assert.equal(q.change24hPct, 25);
  assert.equal(normalizeLiquidQuote("BTC", { ...ticker, ask: "98" }, stats, now).price, null);
  assert.equal(normalizeLiquidQuote("BTC", { ...ticker, time: new Date(now - 180001).toISOString() }, stats, now).state, "STALE");
  assert.equal(normalizeLiquidQuote("BTC", ticker, null, now).state, "PARTIAL");
  assert.equal(evidenceAge(now + 10000, now, 60000), "UNKNOWN");
});
test("derivative identity, units and missing fields never become zero OI or funding", () => {
  const valid = { instrument_name: "BTC-PERPETUAL", state: "open", timestamp: now, mark_price: 100, index_price: 100, open_interest: 0, funding_8h: 0 };
  const row = normalizeDerivative("BTC-PERPETUAL", valid, now);
  assert.equal(row.state, "HEALTHY"); assert.equal(row.openInterestUsd, 0); assert.equal(row.funding8hRaw, 0);
  assert.equal(normalizeDerivative("ETH-PERPETUAL", valid, now).state, "UNAVAILABLE");
  assert.equal(normalizeDerivative("BTC-PERPETUAL", null, now).openInterestUsd, null);
  assert.equal(normalizeDerivative("BTC-PERPETUAL", { ...valid, funding_8h: null }, now).state, "PARTIAL");
  assert.equal(normalizeDerivative("BTC-PERPETUAL", { ...valid, mark_price: 0 }, now).state, "PARTIAL");
  assert.equal(normalizeDerivative("BTC-PERPETUAL", { ...valid, timestamp: now - 180001 }, now).state, "STALE");
});
test("social sample discloses cap, deduplicates URI/authors and missing timestamps", () => {
  const p = { uri: "1", author: { did: "author" }, record: { createdAt: new Date(now - 1000).toISOString(), text: "SAME" } };
  const sample = summarizeSocialPosts([p, p, { ...p, uri: "2" }, { uri: "bad" }], now);
  assert.equal(sample.mentions1h, 2); assert.equal(sample.uniqueAuthors1h, 1);
  assert.equal(sample.repeatedTextShare, .5); assert.equal(sample.timestampsComplete, false);
  assert.equal(summarizeSocialPosts(Array(25).fill(p), now).capped, true);
});
