// Outbound pages for a Solana coin (fomo first, pump.fun second). Navigation only.
// The FOMO link comes from shared/fomoLink.ts (one source; pattern status stated there).
import { fomoTokenUrl } from "./fomoLink";

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function coinLinks(chain: string, mint: string): { fomo: string; pump: string } | null {
  if (chain !== "solana" || !SOLANA_MINT.test(mint)) return null;
  const m = encodeURIComponent(mint);
  return { fomo: fomoTokenUrl(mint), pump: `https://pump.fun/coin/${m}` };
}
