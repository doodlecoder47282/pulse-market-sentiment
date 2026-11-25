// CryptoAlphaBrief — the crypto alpha brief: one plain-sentence read of everything the desk collects
// (shared/cryptoBrief.ts). Built from the feed, health and record payloads the tab already loads; no extra
// request, no model. Lines about a tracked coin jump to its card.
import { etTimeLabel } from "@shared/etTime";
import { useMemo, useState } from "react";
import { buildCryptoBrief, type BriefInputs, type BriefLine } from "@shared/cryptoBrief";

const TONE: Record<string, string> = { good: "text-emerald-300", warn: "text-amber-300/90", bad: "text-rose-300" };

export default function CryptoAlphaBrief({ inputs, onPick }: { inputs: BriefInputs; onPick: (coin: NonNullable<BriefLine["coin"]>) => void }) {
  const [open, setOpen] = useState(true);
  const brief = useMemo(() => buildCryptoBrief(inputs), [inputs]);
  return (
    <div className="rounded-xl border border-fuchsia-400/30 bg-card/60 p-3" data-testid="crypto-alpha-brief">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="crypto-alpha-brief-toggle"
        className="flex min-h-[44px] w-full items-start justify-between gap-3 text-left">
        <span className="min-w-0">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-fuchsia-300">Crypto alpha brief</span>
          <span className="mt-0.5 block break-words text-[13px] font-medium text-foreground" data-testid="crypto-alpha-brief-headline">{brief.headline}</span>
          <span className="block text-[11px] text-muted-foreground">{brief.asOf ? `as of ${etTimeLabel(brief.asOf)}` : "not read yet"} · rebuilt on every refresh</span>
        </span>
        <span className="shrink-0 pt-1 text-[11px] text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3" data-testid="crypto-alpha-brief-body">
          {brief.sections.map((s) => (
            <section key={s.id} data-testid={`crypto-alpha-brief-${s.id}`}>
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</h3>
              <ul className="mt-1 space-y-1 text-[12px] leading-snug">
                {s.lines.map((l, i) => (
                  <li key={i} className={`break-words ${l.tone ? TONE[l.tone] : "text-foreground/90"}`}>
                    {l.coin ? (
                      <button type="button" onClick={() => onPick(l.coin!)} className="min-h-[44px] w-full text-left underline decoration-dotted underline-offset-2 sm:min-h-0" data-testid={`crypto-alpha-brief-coin-${l.coin.pairAddress.slice(0, 8)}`}>
                        {l.text}
                      </button>
                    ) : l.text}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="text-[11px] text-muted-foreground" data-testid="crypto-alpha-brief-basis">{brief.basis}</p>
        </div>
      )}
    </div>
  );
}
