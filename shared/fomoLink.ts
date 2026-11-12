// shared/fomoLink.ts
//
// ONE source for FOMO links (fomo.family, FOMO Labs, Inc., the owner's trading
// app). shared/coinLinks.ts and the desk card both read it.
//
// The per-token pattern `https://fomo.family/tokens/solana/<mint>` has been on
// the card since 2026-11-03 but has no documentation behind it: as of
// 2026-11-12 FOMO publishes no per-token URL and no URL scheme (fomo.family's
// per-asset pages are readable slugs, its memecoin table carries no addresses,
// and its user guides describe pasting the contract address into the app's
// search). Status: UNVERIFIED until the owner taps it on the phone. If the
// pattern is wrong, FOMO lands on its home page and the mint, copied to the
// clipboard by the desk card's button, is pasted into search; either way the
// person places any order themselves. The desk sends FOMO nothing.

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const FOMO_HOME_URL = "https://fomo.family";
/** What the per-token pattern is known to be, for the card's copy. */
export const FOMO_TOKEN_LINK_STATUS = "unverified as of 2026-11-12";

/** Per-token FOMO page for a Solana mint (pattern unverified, see above); the home page for anything that is not a mint. */
export function fomoTokenUrl(mint: string): string {
  if (!SOLANA_MINT.test(mint)) return FOMO_HOME_URL;
  return `${FOMO_HOME_URL}/tokens/solana/${encodeURIComponent(mint)}`;
}
