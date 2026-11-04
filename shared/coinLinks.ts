// Outbound pages for a Solana coin (fomo first, pump.fun second). Navigation only.
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function coinLinks(chain: string, mint: string): { fomo: string; pump: string } | null {
  if (chain !== "solana" || !SOLANA_MINT.test(mint)) return null;
  const m = encodeURIComponent(mint);
  return { fomo: `https://fomo.family/tokens/solana/${m}`, pump: `https://pump.fun/coin/${m}` };
}
