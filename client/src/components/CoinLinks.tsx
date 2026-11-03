// Open a Solana coin outside Batcave: fomo first (the owner's phone app),
// pump.fun second, and the raw contract address to paste anywhere.
// Navigation only: Batcave never places orders.
import { useState } from "react";
import { ExternalLink, Copy, Check } from "lucide-react";
import { coinLinks } from "@shared/coinLinks";

export default function CoinLinks({ chain, mint, symbol }: { chain: string; mint: string; symbol: string }) {
  const [copied, setCopied] = useState(false);
  const links = coinLinks(chain, mint);
  if (!links) return null;
  const btn = "inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold";
  const copy = async () => {
    try { await navigator.clipboard.writeText(mint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="mt-2 grid grid-cols-3 gap-2" data-testid={`coin-links-${mint.slice(0, 8)}`}>
      <a href={links.fomo} target="_blank" rel="noopener noreferrer" aria-label={`Open ${symbol} in fomo`}
        className={`${btn} border-lime-400/50 bg-lime-500/10 text-lime-300`} data-testid="coin-link-fomo">
        fomo <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <a href={links.pump} target="_blank" rel="noopener noreferrer" aria-label={`Open ${symbol} on pump.fun`}
        className={`${btn} border-border/60 text-foreground/90`} data-testid="coin-link-pump">
        pump.fun <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <button type="button" onClick={copy} aria-label={`Copy ${symbol} contract address`}
        className={`${btn} border-border/60 text-foreground/90`} data-testid="coin-link-copy">
        {copied ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Address</>}
      </button>
    </div>
  );
}
