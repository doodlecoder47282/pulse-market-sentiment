// shared/fomoLink.ts
//
// FOMO (fomo.family, FOMO Labs, Inc.) is the owner's chosen trading app. As of
// 2026-11-11 it publishes no per-token URL and no custom URL scheme: its web
// app's per-asset pages are readable slugs (fomo.family/prices/solana-sol),
// its memecoin table carries no addresses, and the user guides describe
// finding a coin by pasting the contract address into the app's search. The
// desk therefore copies the mint and opens the app's universal link; the
// person pastes the address. When FOMO documents a per-token link, change
// fomoTokenUrl here and nothing else.
//
// The desk never places orders. This is a link.

export const FOMO_OPEN_URL = "https://fomo.family";

/** Per-token link when FOMO documents one; until then the universal link (the mint travels on the clipboard). */
export function fomoTokenUrl(_mint: string): string {
  return FOMO_OPEN_URL;
}
