// The FOMO button is a link beside "Copy AI prompt": copies the mint, opens the
// app. It never places an order, and it says FOMO has no per-token link yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fomoTokenUrl, FOMO_OPEN_URL } from "../../shared/fomoLink";

test("fomoTokenUrl: universal link until FOMO documents a per-token URL; https only", () => {
  assert.equal(fomoTokenUrl("So11111111111111111111111111111111111111112"), FOMO_OPEN_URL);
  assert.match(FOMO_OPEN_URL, /^https:\/\/fomo\.family/);
});

test("CoinDesk: the FOMO button copies the mint and opens the link; Solana only; copy says the desk places no order", () => {
  const s = readFileSync(new URL("../../client/src/components/CoinDesk.tsx", import.meta.url), "utf8");
  assert.match(s, /c\.chain === "solana" && c\.tokenAddress && \(\s*<button onClick=\{onOpenFomo\}/);
  assert.match(s, /const ok = await copyText\(c\.tokenAddress\);/);
  assert.match(s, /window\.open\(fomoTokenUrl\(c\.tokenAddress\), "_blank", "noopener,noreferrer"\);/);
  assert.match(s, /FOMO has no documented per-token link, so you paste it into search\. Any order is yours to place there; the desk places none\./);
  assert.doesNotMatch(s, /fetch\([^)]*fomo/i, "no request to FOMO from the desk");
  assert.doesNotMatch(s, /\b(buy now|sell now|execute|place order)\b/i);
});
