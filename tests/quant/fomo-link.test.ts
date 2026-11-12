// One source for FOMO links; the desk card's button is an <a> (navigates in the
// gesture) that also copies the mint; the copy says the pattern is unverified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fomoTokenUrl, FOMO_HOME_URL, FOMO_TOKEN_LINK_STATUS } from "../../shared/fomoLink";
import { coinLinks } from "../../shared/coinLinks";

const mint = "FEXGegqeVm5vZurqyC7qsmkLqWspVV1ACb9bbLvcpump";

test("fomoTokenUrl: one source; coinLinks reads it; non-mints go to the home page; https only", () => {
  assert.equal(fomoTokenUrl(mint), `https://fomo.family/tokens/solana/${mint}`);
  assert.equal(coinLinks("solana", mint)!.fomo, fomoTokenUrl(mint), "the two FOMO affordances agree");
  assert.equal(fomoTokenUrl("javascript:alert(1)"), FOMO_HOME_URL);
  assert.equal(fomoTokenUrl(""), FOMO_HOME_URL);
  assert.match(FOMO_HOME_URL, /^https:\/\/fomo\.family$/);
  assert.match(FOMO_TOKEN_LINK_STATUS, /unverified as of \d{4}-\d{2}-\d{2}/, "the pattern's status is dated, not stated as permanent");
});

test("CoinDesk: the FOMO button is a link that navigates in the gesture and copies the mint; Solana only; copy says the desk places no order", () => {
  const s = readFileSync(new URL("../../client/src/components/CoinDesk.tsx", import.meta.url), "utf8");
  assert.match(s, /c\.chain === "solana" && c\.tokenAddress && \(\s*<a href=\{fomoTokenUrl\(c\.tokenAddress\)\} target="_blank" rel="noopener noreferrer" onClick=\{onOpenFomo\}/);
  assert.match(s, /void copyText\(c\.tokenAddress\)\.then/);
  assert.doesNotMatch(s, /window\.open\(/, "no window.open after an await: Safari and the Capacitor shell refuse it");
  assert.match(s, /FOMO's per-token page pattern is \{FOMO_TOKEN_LINK_STATUS\}; if it lands on FOMO's home page, paste the copied mint into its search\. Any order is yours to place there; the desk places none\./);
  assert.doesNotMatch(s, /fetch\([^)]*fomo/i, "no request to FOMO from the desk");
  assert.doesNotMatch(s, /\b(buy now|sell now|execute|place order)\b/i);
  const howto = readFileSync(new URL("../../client/src/components/CryptoHowTo.tsx", import.meta.url), "utf8");
  assert.match(howto, /unverified/);
});
