// Expanded coin card: every fact a meme-coin trader checks, the rule-book exit
// plan sized from the owner's bankroll, and a prompt to paste into their own AI.
// Rendered outside the card's toggle button (it holds an input and buttons).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, Target, ExternalLink } from "lucide-react";
import type { CardBundle } from "@shared/cryptoBundle";
import { bundleLine } from "@shared/cryptoBundle";
import { CRYPTO_RULES } from "@shared/cryptoRules";
import { planLevels, sizeFromBankroll, buildTradePrompt, type PlanSummary, type PromptCoin } from "@shared/exitPlan";
import { capOf } from "@shared/cryptoCap";
import { fomoTokenUrl, FOMO_TOKEN_LINK_STATUS } from "@shared/fomoLink";

export type DeskCoin = PromptCoin & {
  fdv?: number | null;
  bundle?: CardBundle | null;
  socialScore?: number | null;
  bskyMentions1h?: number | null;
  pumpReplies?: number | null;
  risk: { maxPositionUsd: number } | null;
};

const BANKROLL_KEY = "batcave.crypto.bankroll";

export function useBankroll(): [number | null, (n: number | null) => void] {
  const [v, setV] = useState<number | null>(() => {
    try { const n = Number(localStorage.getItem(BANKROLL_KEY)); return n > 0 ? n : null; } catch { return null; }
  });
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === BANKROLL_KEY) { const n = Number(e.newValue); setV(n > 0 ? n : null); } };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  return [v, (n) => {
    try { n && n > 0 ? localStorage.setItem(BANKROLL_KEY, String(n)) : localStorage.removeItem(BANKROLL_KEY); } catch { /* private mode */ }
    setV(n && n > 0 ? n : null);
  }];
}

const usd = (n: number | null | undefined, d = 1) => n == null || !Number.isFinite(n) ? "—"
  : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(d)}K` : `$${n.toFixed(0)}`;
const pct = (n: number | null | undefined, d = 0) => n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const age = (m: number | null) => m == null ? "—" : m < 60 ? `${Math.round(m)}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m / 1440)}d`;
const auth = (b: boolean | null) => b == null ? "unread" : b ? "ACTIVE" : "revoked";

function Fact({ k, v, tone }: { k: string; v: string; tone?: "bad" | "good" | "warn" }) {
  const cls = tone === "bad" ? "text-rose-300" : tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-foreground";
  return (
    <div className="min-w-0 rounded bg-muted/25 px-1.5 py-1">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className={`break-words font-mono text-[12px] leading-tight tabular-nums ${cls}`}>{v}</div>
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}

export default function CoinDesk({ c }: { c: DeskCoin }) {
  const [bankroll, setBankroll] = useBankroll();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [fomo, setFomo] = useState<"ok" | "fail" | null>(null);
  // One tap into FOMO: the <a> navigates inside the gesture (window.open after
  // an await is refused by Safari and the Capacitor shell), and the mint is
  // copied best-effort so it can be pasted into FOMO's search if the per-token
  // pattern (shared/fomoLink.ts, unverified) lands on the home page. A link,
  // not an order: the desk never executes.
  const onOpenFomo = () => {
    void copyText(c.tokenAddress).then((ok) => { setFomo(ok ? "ok" : "fail"); setTimeout(() => setFomo(null), 4000); });
  };
  type PlanRecord = PlanSummary & { currentVersion?: string; versions?: Array<PlanSummary & { version: string }> };
  const sig = useQuery<{ exitPlan?: PlanRecord | null }>({ queryKey: ["/api/crypto/signals"], refetchInterval: 120_000 });
  const rec = sig.data?.exitPlan ?? null;
  const earlier = (rec?.versions ?? []).filter((v) => v.closed > 0 || v.open > 0 || v.noData > 0);

  const b = c.bundle;
  // The same cap the server scored and recorded the entry on (marketCap, else FDV): the plan levels and the liq/cap read stay on that number.
  const cap = capOf({ marketCap: c.marketCap, fdv: c.fdv ?? null });
  const liqToCap = c.liquidityUsd != null && cap.cap ? (c.liquidityUsd / cap.cap) * 100 : null;
  const levels = planLevels(cap.cap).filter((l) => l.kind === "trim" || l.kind === "target" || l.kind === "stop");
  const size = sizeFromBankroll(bankroll, c.risk?.maxPositionUsd);
  const showPlan = c.verdict === "ENTER" || c.verdict === "WATCH";
  const bLine = b ? bundleLine(b) : null;

  const onCopy = async () => {
    const social = c.socialScore != null ? `social score ${Math.round(c.socialScore)} (Bluesky ${c.bskyMentions1h ?? "unread"} mentions/1h, pump.fun ${c.pumpReplies ?? "unread"} replies)` : null;
    const ok = await copyText(buildTradePrompt({ ...c, bundleLine: bLine, socialLine: social }, size.text));
    setCopied(ok ? "ok" : "fail");
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="mt-1 space-y-2 rounded-xl border border-border/50 bg-card/40 p-3" data-testid="crypto-coin-desk">
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" data-testid="crypto-coin-facts">
        <Fact k={cap.basis === "fdv" ? "cap (FDV)" : "cap"} v={usd(cap.cap)} />
        <Fact k="liq" v={usd(c.liquidityUsd)} />
        <Fact k="liq/cap" v={liqToCap == null ? "—" : `${liqToCap.toFixed(1)}%`} tone={liqToCap != null && liqToCap < 5 ? "warn" : undefined} />
        <Fact k="age" v={age(c.ageMinutes)} />
        <Fact k="vol 5m" v={usd(c.vol5m, 1)} />
        <Fact k="vol 24h" v={usd(c.vol24h, 0)} />
        <Fact k="buys/sells 5m" v={c.buys5m == null && c.sells5m == null ? "—" : `${c.buys5m ?? "?"}/${c.sells5m ?? "?"}`} />
        <Fact k="chg 5m" v={pct(c.chg5m)} tone={c.chg5m != null ? (c.chg5m >= 0 ? "good" : "bad") : undefined} />
        <Fact k="chg 24h" v={pct(c.chg24h)} tone={c.chg24h != null ? (c.chg24h >= 0 ? "good" : "bad") : undefined} />
        <Fact k="mint auth" v={auth(c.mintAuthorityActive)} tone={c.mintAuthorityActive ? "bad" : c.mintAuthorityActive === false ? "good" : "warn"} />
        <Fact k="freeze auth" v={auth(c.freezeAuthorityActive)} tone={c.freezeAuthorityActive ? "bad" : c.freezeAuthorityActive === false ? "good" : "warn"} />
        <Fact k="top 10" v={c.top10Pct == null ? "unread" : `${c.top10Pct.toFixed(1)}%`} tone={c.top10Pct == null ? "warn" : c.top10Pct > 45 ? "bad" : undefined} />
        <Fact k="LP locked" v={c.rcLpLockedPct == null ? "unread" : `${c.rcLpLockedPct}%`} tone={c.rcLpLockedPct == null ? "warn" : c.rcLpLockedPct < 50 ? "bad" : "good"} />
        <Fact k="creator buy" v={b?.state === "ok" && b.creatorBoughtPct != null ? `${b.creatorBoughtPct.toFixed(1)}%` : "unread"} tone={b?.state === "ok" ? undefined : "warn"} />
        <Fact k="launch block" v={b?.state === "ok" && b.sameBlockPct != null ? `${b.sameBlockWallets ?? "?"}w ${b.sameBlockPct.toFixed(1)}%` : "unread"} tone={b?.state === "ok" ? ((b.sameBlockPct ?? 0) >= 20 ? "bad" : undefined) : "warn"} />
        <Fact k="still held" v={b?.state === "ok" && b.stillHeldPct != null ? `${b.stillHeldPct.toFixed(1)}%` : "unread"} tone={b?.state === "ok" ? ((b.stillHeldPct ?? 0) >= 10 ? "bad" : undefined) : "warn"} />
        <Fact k="jupiter" v={c.jupState ?? "unchecked"} tone={c.jupState === "agree" ? "good" : c.jupState === "diverge" || c.jupState === "no-reliable-price" ? "bad" : "warn"} />
        <Fact k="boost" v={c.boosted ? "paid" : "none"} tone={c.boosted ? "warn" : undefined} />
      </div>

      {showPlan ? (
        <div className="space-y-1" data-testid="crypto-exit-plan">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold">
            <Target className="h-3.5 w-3.5 text-lime-300" />
            Exit plan {c.verdict === "WATCH" ? "(if it clears ENTER)" : ""}
          </div>
          <ul className="space-y-0.5 text-[12px] leading-snug">
            {levels.map((l) => (
              <li key={l.kind + (l.multiple ?? "")} className={l.kind === "stop" ? "text-rose-300" : "text-foreground"}>{l.text}</li>
            ))}
            <li className="text-muted-foreground">also: liquidity stop and a time stop, per the rule book</li>
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-muted-foreground">size</span>
            {bankroll && !editing ? (
              <>
                <span data-testid="crypto-plan-size">
                  {size.sizeUsd != null ? <span className="font-mono font-semibold">${size.sizeUsd.toLocaleString("en-US")}</span> : <span className="text-amber-300">{size.text}</span>}
                  {size.bound && <span className="text-muted-foreground"> · {size.bound === "risk" ? `${CRYPTO_RULES.exitPlan.riskPerTradePct}% of bankroll at risk to the stop` : "pool cap: the exit is the limit"}</span>}
                </span>
                <button className="min-h-[44px] px-2 text-[12px] text-muted-foreground underline" aria-label="Change bankroll" onClick={() => { setDraft(String(bankroll)); setEditing(true); }}>bankroll ${bankroll.toLocaleString("en-US")}</button>
              </>
            ) : (
              <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); const n = Number(draft.replace(/[$,\s]/g, "")); if (n > 0) { setBankroll(n); setEditing(false); } }}>
                <input inputMode="decimal" placeholder="bankroll $" value={draft} onChange={(e) => setDraft(e.target.value)}
                  className="h-11 w-32 rounded-md border border-border bg-background px-2 font-mono text-[13px]" aria-label="Bankroll in dollars" data-testid="crypto-bankroll-input" />
                <button type="submit" className="h-11 rounded-md bg-muted px-4 text-[12px] font-semibold">Save</button>
              </form>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground" data-testid="crypto-plan-record">
            plan record{rec?.currentVersion ? ` (rules ${rec.currentVersion})` : ""}: {rec ? rec.label : sig.isLoading ? "loading" : "unavailable (record not read)"}{rec?.ready && rec.medianPct != null ? ` · median ${pct(rec.medianPct, 1)} per $100 net` : ""}
          </div>
          {earlier.length > 0 && (
            <div className="text-[11px] text-muted-foreground" data-testid="crypto-plan-record-earlier">
              earlier rule versions, kept separately: {earlier.map((v) => `${v.version}: ${v.closed} closed, ${v.open} open${v.noData > 0 ? `, ${v.noData} no data` : ""}${v.ready && v.medianPct != null ? `, median ${pct(v.medianPct, 1)}` : ""}`).join(" · ")}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[12px] text-muted-foreground">No exit plan: the desk reads this as PASS.</div>
      )}

      <button onClick={onCopy} className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-lime-400/40 bg-lime-400/10 text-[13px] font-semibold text-lime-200" data-testid="crypto-copy-prompt">
        {copied === "ok" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied === "ok" ? "Copied. Paste it into your AI" : copied === "fail" ? "Copy blocked by the browser" : "Copy AI prompt"}
      </button>
      {c.chain === "solana" && c.tokenAddress && (
        <a href={fomoTokenUrl(c.tokenAddress)} target="_blank" rel="noopener noreferrer" onClick={onOpenFomo}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-sky-400/40 bg-sky-400/10 text-[13px] font-semibold text-sky-200" data-testid="crypto-open-fomo">
          <ExternalLink className="h-4 w-4" />
          {fomo === "ok" ? "Opening FOMO; mint copied for its search" : fomo === "fail" ? "Opening FOMO; clipboard blocked, use Address below" : "Open in FOMO (copies mint)"}
        </a>
      )}
      {c.chain === "solana" && c.tokenAddress && (
        <div className="text-[11px] text-muted-foreground">
          FOMO's per-token page pattern is {FOMO_TOKEN_LINK_STATUS}; if it lands on FOMO's home page, paste the copied mint into its search. Any order is yours to place there; the desk places none.
        </div>
      )}
    </div>
  );
}
