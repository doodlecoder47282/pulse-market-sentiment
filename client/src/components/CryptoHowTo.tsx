// Plain-language guide to the Crypto desk: what it does, what each label
// means, how to open a coin in fomo, and the desk's words in plain English.
// Describes only; no predictions, no advice.
import { useState } from "react";
import { ChevronDown, ChevronRight, BookOpen } from "lucide-react";
import { CRYPTO_RULES } from "@shared/cryptoRules";

const TARGET = `$${(CRYPTO_RULES.universe.targetMcapUsd / 1e6).toLocaleString("en-US")}M`;

const STEPS: Array<[string, string]> = [
  ["What this tab does", "It watches brand-new Solana coins and checks each one against a fixed list of safety and buying-activity rules, about every minute. It only reads and grades. It never buys or sells."],
  ["Enter / Watch / Pass", "Enter: the coin passes every rule right now. Watch: it passes most rules and is missing one, usually buying activity. Pass: it failed at least one rule. The number (0 to 100) is a checklist score, not a chance of winning."],
  ["Look at a coin", "Tap a coin to open its details: why it got its label, safety checks, and who is buying. Under the details: fomo opens the coin in the fomo app or fomo.family; pump.fun opens its pump.fun page; Address copies the contract address."],
  ["Get the coin in fomo", "Tap fomo. If the page opens in the browser instead of the app, tap Address, open the fomo app, and paste the address into Search. Searching by contract address always finds the token; searching by name may not."],
  ["Check any coin yourself", "Paste a contract address into Contract autopsy. You get every desk rule with the value it read, and anything it could not read is marked as not read, never as a pass."],
  ["The record", `Every first Enter is graded over ${CRYPTO_RULES.grading.horizonHours} hours: it reached the ${TARGET} market-cap target or rugged (both close the grade early), or at ${CRYPTO_RULES.grading.horizonHours} hours it had doubled or died. One that cannot be priced is no data, its own outcome, never a loss or a win. Until ${CRYPTO_RULES.grading.minSample} are graded with no data at ${Math.round(CRYPTO_RULES.grading.maxNoDataShare * 100)}% or less, the desk is in tracking mode, so the labels have no proven track record yet.`],
];

const WORDS: Array<[string, string]> = [
  ["cap", "market cap: price times coins in circulation"],
  ["liq", "liquidity: dollars in the trading pool; small liq means a sale moves the price a lot"],
  ["mint revoked", "nobody can create more coins"],
  ["freeze revoked", "nobody can lock your coins"],
  ["top-10 holders", "share of all coins held by the ten biggest wallets"],
  ["rug", "the creators pulled the pool money; the coin is close to worthless"],
  ["pump.fun grad", "finished pump.fun's launch curve and moved to an open market"],
  ["paid boost", "someone paid DexScreener to promote it"],
  ["flow", "buys versus sells in the last few minutes"],
  ["exit door", "how much of the cap the pool could pay out if holders sold"],
  ["not read", "the source did not answer; shown as missing, never as zero"],
  ["heuristic score", "a rule checklist total, not calibrated odds"],
];

export default function CryptoHowTo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border/60 bg-card/60" data-testid="crypto-howto">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2 px-4 py-2 text-left text-sm font-semibold" data-testid="crypto-howto-toggle">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        How to use this desk
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">plain English</span>
      </button>
      {open && (
        <div className="space-y-4 px-4 pb-4">
          <ol className="space-y-2.5">
            {STEPS.map(([h, t], i) => (
              <li key={h} className="text-xs leading-relaxed">
                <span className="font-semibold">{i + 1}. {h}.</span>{" "}
                <span className="text-muted-foreground">{t}</span>
              </li>
            ))}
          </ol>
          <div>
            <div className="mb-1.5 text-xs font-semibold">The desk's words</div>
            <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {WORDS.map(([w, d]) => (
                <div key={w} className="text-xs leading-snug">
                  <dt className="inline font-mono font-semibold">{w}</dt>
                  <dd className="inline text-muted-foreground"> — {d}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="text-[11px] text-muted-foreground">Buying and selling happen in fomo or another wallet, not in Batcave. Most new coins under $1M lose most of their value.</p>
        </div>
      )}
    </div>
  );
}
