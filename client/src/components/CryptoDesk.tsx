import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Search, ShieldAlert, RefreshCw, Database } from "lucide-react";
import { TokenCard, SignalLog, type Candidate, type FeedResp, type HealthResp, type SignalsResp } from "./CryptoPanel";
import { evidenceAge, type CryptoContext, type DeskHeadline, type LiquidQuote } from "@shared/cryptoDesk";
import { MEME_SCORE_BUDGET } from "@shared/memeScoring";
import { socialEvidenceFresh } from "@shared/cryptoSocial";

type View = "overview" | "meme" | "liquid" | "news" | "evidence" | "outcomes";
const views: [View, string][] = [["overview", "Overview"], ["meme", "Meme discovery"], ["liquid", "BTC / ETH"], ["news", "News & macro"], ["evidence", "Data coverage"], ["outcomes", "Outcomes"]];
const dollars = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "Unavailable" :
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` :
    `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
const quotePrice = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "Unavailable" :
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timestamp = (t: number | null | undefined) => t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unknown";
const fresh = (t: number | null | undefined, age = 300000) => t != null && Date.now() >= t && Date.now() - t <= age;
function Status({ state }: { state: string }) {
  return <span className={`crypto-status ${["HEALTHY", "CHECKED", "ok"].includes(state) ? "is-healthy" : ["UNAVAILABLE", "error"].includes(state) ? "is-unavailable" : ""}`}>{state.toLowerCase().replaceAll("_", " ")}</span>;
}
function Box({ title, note, children, testId }: { title: string; note?: string; children: React.ReactNode; testId?: string }) {
  return <section className="crypto-box" data-testid={testId}><div className="crypto-box-heading"><h3>{title}</h3>{note && <p>{note}</p>}</div>{children}</section>;
}
function NewsList({ rows, limit = 6 }: { rows: DeskHeadline[]; limit?: number }) {
  return <div className="crypto-news-list">{rows.slice(0, limit).map(n =>
    <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" data-testid={`crypto-headline-${n.id}`}>
      <span className="crypto-eyebrow">{n.publisher} · {timestamp(n.publishedAt)}</span>
      <span className="crypto-news-title">{n.title}<ArrowUpRight size={14} /></span>
    </a>)}
    {!rows.length && <p className="crypto-empty">No attributable headlines available. A quiet feed is not proof that no event occurred.</p>}</div>;
}
function QuoteCard({ q }: { q: LiquidQuote }) {
  const age = evidenceAge(q.observedAt, Date.now(), 120000);
  const state = q.state === "UNAVAILABLE" ? q.state : age === "HEALTHY" ? q.state : age;
  return <article className="crypto-quote" data-testid={`crypto-quote-${q.symbol}`}>
    <div className="flex items-center justify-between gap-2"><h3>{q.product}</h3><Status state={state} /></div>
    <div className="crypto-quote-price">{quotePrice(q.price)}</div>
    <div className="crypto-quote-change">{q.change24hPct == null ? "24h change unavailable" : `${q.change24hPct >= 0 ? "+" : ""}${q.change24hPct.toFixed(2)}% in 24h`}</div>
    <dl className="crypto-definition-grid">
      <div><dt>Bid / ask</dt><dd>{quotePrice(q.bid)} / {quotePrice(q.ask)}</dd></div>
      <div><dt>Spread</dt><dd>{q.spreadBps == null ? "Unavailable" : `${q.spreadBps > 0 && q.spreadBps < 0.01 ? "<0.01" : q.spreadBps.toFixed(2)} bps`}</dd></div>
      <div><dt>24h base volume</dt><dd>{q.volumeBase24h == null ? "Unavailable" : `${q.volumeBase24h.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${q.symbol}`}</dd></div>
      <div><dt>24h range, not targets</dt><dd>{quotePrice(q.low24h)} / {quotePrice(q.high24h)}</dd></div>
    </dl>
    <p className="crypto-footnote">{q.venue} · trade {timestamp(q.observedAt)}<br />Received {timestamp(q.fetchedAt)}. Sampled, not streaming.</p>
  </article>;
}

export default function CryptoDesk() {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    const timer = setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const [view, setView] = useState<View>("overview");
  const [filter, setFilter] = useState<"ALL" | "WATCH" | "PASS" | "PUMP">("ALL");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("score");
  const [limit, setLimit] = useState(12);
  const [expanded, setExpanded] = useState<string | null>(null);
  const feedQ = useQuery<FeedResp>({ queryKey: ["/api/crypto/feed"], refetchInterval: 45000 });
  const healthQ = useQuery<HealthResp>({ queryKey: ["/api/crypto/health"], refetchInterval: 45000 });
  const contextQ = useQuery<CryptoContext>({ queryKey: ["/api/crypto/context"], staleTime: 60000, refetchInterval: 120000, retry: 1 });
  const sigQ = useQuery<SignalsResp>({ queryKey: ["/api/crypto/signals"], staleTime: 120000, refetchInterval: 120000 });
  const feedExpired = !!feedQ.data && clock - feedQ.data.asOf > 300000;
  const contextExpired = !!contextQ.data && clock - contextQ.data.asOf > 180000;
  const feed = feedExpired ? undefined : feedQ.data;
  const context = contextExpired ? undefined : contextQ.data;
  const all = feed?.candidates ?? [];
  const socialMints = [...new Map(all.map(c => [c.tokenAddress, c])).values()];
  const socialSampled = socialMints.filter(c => socialEvidenceFresh(c.socialDetail, clock));
  const counts = {
    fresh: all.filter(c => fresh(c.lastRefreshAt)).length,
    liquidity: all.filter(c => fresh(c.lastRefreshAt) && c.liquidityUsd != null).length,
    authority: all.filter(c => c.securityEvidence?.state === "CHECKED" && fresh(c.securityCheckedAt, 1800000)).length,
    social: all.filter(c => c.socialCoverage === "ok" && fresh(c.socialCheckedAt, 600000)).length,
    watch: all.filter(c => c.verdict === "WATCH").length,
    pass: all.filter(c => c.verdict === "PASS").length,
  };
  const reasons = useMemo(() => {
    const categories = [
      ["Liquidity missing", (c: Candidate) => c.liquidityUsd == null],
      ["Hard risk filter", (c: Candidate) => c.hardKill],
      ["Mint check incomplete", (c: Candidate) => c.securityEvidence?.state !== "CHECKED" || !fresh(c.securityCheckedAt, 1800000)],
      ["Social incomplete", (c: Candidate) => c.socialCoverage !== "ok" || !fresh(c.socialCheckedAt, 600000)],
    ] as const;
    return categories.map(([label, test]) => ({ label, count: all.filter(test).length }));
  }, [feed, clock]);
  const visible = all.filter(c => {
    const needle = query.trim().toLowerCase();
    return (!needle || [c.symbol, c.name, c.tokenAddress, c.pairAddress].some(s => s.toLowerCase().includes(needle))) &&
      (filter === "ALL" || filter === "PUMP" ? filter !== "PUMP" || c.pumpfunGraduate : c.verdict === filter);
  }).sort((a, b) => sort === "liquidity" ? (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) :
    sort === "age" ? (a.ageMinutes ?? Infinity) - (b.ageMinutes ?? Infinity) : (b.score ?? -1) - (a.score ?? -1));
  const refresh = () => { void feedQ.refetch(); void healthQ.refetch(); void contextQ.refetch(); void sigQ.refetch(); };
  const refreshing = feedQ.isFetching || contextQ.isFetching;
  const sourcesHealthy = context?.sources.filter(s => s.state === "HEALTHY").length;
  const overviewRows = [...all].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 4);
  return <div className="crypto-desk" data-testid="crypto-panel">
    <header className="crypto-desk-header">
      <div><div className="crypto-eyebrow"><Activity size={14} /> BATCAVE RESEARCH</div>
        <h2>Crypto intelligence</h2><p>Market context. Token evidence. A reason to watch, or a reason to pass.</p></div>
      <div className="crypto-header-actions"><Status state="Research only" />
        <button className="crypto-control" onClick={refresh} disabled={refreshing} data-testid="crypto-refresh"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />{refreshing ? "Updating" : "Refresh"}</button>
        <span className="crypto-footnote">Feed received {timestamp(feed?.asOf)}</span></div>
    </header>

    <div className="crypto-kpi-grid" data-testid="crypto-summary">
      {[
        ["Tracked pools", feed ? String(feed.trackedCount) : "—", "Bounded Solana discovery"],
        ["Market observations", feed ? `${counts.fresh} / ${all.length}` : "—", "Received within 5 minutes"],
        ["Mint checks current", feed ? `${counts.authority} / ${all.length}` : "—", "Reviewed SPL / Token-2022 subset"],
        ["Research shortlist", feed ? String(counts.watch) : "—", `${counts.pass} passed over · ENTER disabled`],
      ].map(([label, value, note]) => <div className="crypto-kpi" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
    </div>

    <nav className="crypto-group-tabs" aria-label="Crypto research groups">
      {views.map(([key, label]) => <button key={key} aria-current={view === key ? "page" : undefined} onClick={() => setView(key)} data-testid={`crypto-group-${key}`}>{label}</button>)}
    </nav>
    <div className="crypto-safety-line" data-testid="crypto-scoring-policy"><ShieldAlert size={16} />
      <span>WATCH is a research list, not an entry. Scores are unvalidated points out of {MEME_SCORE_BUDGET}, not probabilities. No executable trade levels or real-money sizing.</span></div>
    {(feedQ.isError || feedExpired) && <div className="crypto-error" role="alert">Discovery feed unavailable or expired. {feed ? "Last received data may be stale." : "Counts and candidates are withheld."} <button onClick={() => void feedQ.refetch()} data-testid="crypto-retry">Retry feed</button></div>}
    {(contextQ.isError || contextExpired) && <div className="crypto-error" role="alert">Context refresh unavailable or expired. {context ? "Review each observation timestamp; this is not live confirmation." : "Previous context is withheld."} <button onClick={() => void contextQ.refetch()} data-testid="crypto-context-retry">Retry context</button></div>}
    {view === "overview" && <>
      <div className="crypto-overview-grid">
        <Box title={feed ? counts.watch ? "Candidates to investigate" : "No token currently qualifies" : "Checking the discovery universe"} note="The decision comes first. Empty shortlist does not mean empty intelligence." testId="crypto-verdict">
          <p className="crypto-lede">{counts.watch ? "Open each candidate to inspect its mint, market evidence and risk flags before drawing a conclusion." : "Stay in research mode. The scanner is showing rejected or incomplete candidates below, rather than manufacturing an entry."}</p>
          <div className="crypto-reason-grid">{reasons.map(r => <div key={r.label}><strong>{feed ? r.count : "—"}</strong><span>{r.label}</span></div>)}</div>
          <p className="crypto-footnote">Categories overlap. A rejected token may have several gaps. Collector success does not imply every token was checked.</p>
          <button className="crypto-text-button" onClick={() => { setView("meme"); setFilter("ALL"); }} data-testid="crypto-open-discovery">Inspect the full candidate list <ArrowUpRight size={14} /></button>
        </Box>
        <Box title="Evidence coverage" note="Completeness is separate from direction." testId="crypto-coverage-summary">
          {[
            ["Pool liquidity", counts.liquidity], ["Mint / authority", counts.authority], ["Sampled social", counts.social],
          ].map(([label, n]) => <div className="crypto-coverage-row" key={label}><div><span>{label}</span><strong>{feed ? `${n} / ${all.length}` : "Unknown"}</strong></div><progress aria-label={String(label)} value={Number(n)} max={Math.max(1, all.length)} /></div>)}
          <div className="crypto-coverage-row"><div><span>Context sources healthy</span><strong>{context ? `${sourcesHealthy} / ${context.sources.length}` : contextQ.isError ? "Unavailable" : "Checking"}</strong></div></div>
          <button className="crypto-text-button" onClick={() => setView("evidence")} data-testid="crypto-open-coverage">Inspect sources & gaps <ArrowUpRight size={14} /></button>
        </Box>
      </div>
      <div className="crypto-overview-grid">
        <Box title="Discovery, without the hype" note="Highest research points in the returned universe. PASS rows remain visible.">
          {feedQ.isLoading ? <div className="crypto-loading">Loading candidate evidence…</div> :
            overviewRows.length ? overviewRows.map(c => <button className="crypto-candidate-row" key={`${c.chain}:${c.pairAddress}`} data-testid={`crypto-overview-${c.pairAddress.slice(0, 8)}`} onClick={() => { setView("meme"); setQuery(c.tokenAddress); setExpanded(c.pairAddress); }}>
              <div><strong>{c.symbol}</strong><span>{c.chain} · {c.dexId}</span></div><div><strong>{c.score == null ? "Unranked" : `${c.score} / 70`}</strong><span>{c.verdict ?? "Pending"}</span></div>
              <p>{c.verdictReasons[0] ?? "Evidence collection pending"}</p></button>) :
              <p className="crypto-empty">No pools returned yet. Review scanner health, not a fabricated watchlist.</p>}
        </Box>
        <Box title="What changed around crypto" note="Attributed headlines, never token-level confirmation.">
          {contextQ.isLoading ? <p className="crypto-loading">Checking publisher feeds…</p> : <NewsList rows={context?.news.filter(n => n.group === "crypto") ?? []} limit={4} />}
        </Box>
      </div>
    </>}
    {view === "meme" && <Box title="Meme discovery" note="Solana pools, including pump.fun graduations. Select a token by its mint, not its name.">
      <div className="crypto-filter-bar">
        <label className="crypto-search"><Search size={16} /><span className="sr-only">Search token or mint</span><input value={query} onChange={e => { setQuery(e.target.value); setLimit(12); }} placeholder="Token, mint or pool address" data-testid="crypto-token-search" /></label>
        <label className="crypto-select">Show<select value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setLimit(12); }} data-testid="crypto-filter">{["ALL", "WATCH", "PASS", "PUMP"].map(v => <option key={v} value={v}>{v === "PUMP" ? "Pump graduations" : v === "ALL" ? "All candidates" : v}</option>)}</select></label>
        <label className="crypto-select">Sort<select value={sort} onChange={e => setSort(e.target.value)} data-testid="crypto-sort"><option value="score">Research points</option><option value="liquidity">Liquidity</option><option value="age">Newest pool</option></select></label>
      </div>
      <p className="crypto-footnote">{visible.length} matching / {all.length} returned / {feed?.trackedCount ?? "unknown"} tracked. No entry recommendations.</p>
      <div className="crypto-token-grid">{visible.slice(0, limit).map(c => <TokenCard key={`${c.chain}:${c.pairAddress}`} c={c} accent={c.verdict === "WATCH" ? "watch" : "pass"} isOpen={expanded === c.pairAddress} toggle={() => setExpanded(expanded === c.pairAddress ? null : c.pairAddress)} />)}</div>
      {!visible.length && <div className="crypto-empty"><p>{feedQ.isLoading ? "Loading tokens…" : "No candidate matches these filters."}</p><button className="crypto-control" onClick={() => { setQuery(""); setFilter("ALL"); }} data-testid="crypto-reset-filters">Reset filters</button></div>}
      {visible.length > limit && <button className="crypto-control mt-4" onClick={() => setLimit(n => n + 12)} data-testid="crypto-load-more">Show 12 more</button>}
    </Box>}
    {view === "liquid" && <>
      <div className="crypto-token-grid">{context?.quotes.map(q => <QuoteCard key={q.symbol} q={q} />)}</div>
      {!context && <p className="crypto-empty">{contextQ.isLoading ? "Retrieving timestamped spot observations…" : "Spot context unavailable. No last-known price is being presented as live."}</p>}
      <Box title="Derivatives & chain context" note="Independent evidence families, not automatic bullish confirmations.">
        <div className="crypto-token-grid">{context?.derivatives?.map(d => <div className="crypto-quote" key={d.instrument} data-testid={`crypto-derivative-${d.instrument}`}>
          <div className="flex justify-between gap-2"><h4>{d.instrument}</h4><Status state={d.state} /></div>
          <dl className="crypto-definition-grid mt-4"><div><dt>Open interest · USD</dt><dd>{dollars(d.openInterestUsd)}</dd></div>
            <div><dt>8h funding · raw provider fraction</dt><dd>{d.funding8hRaw == null ? "Unavailable" : d.funding8hRaw.toFixed(8)}</dd></div>
            <div><dt>Mark / index premium</dt><dd>{d.markPremiumBps == null ? "Unavailable" : `${d.markPremiumBps.toFixed(2)} bps`}</dd></div></dl>
          <p className="crypto-footnote">Deribit · {timestamp(d.observedAt)}. No annualization, direction score or trading-access claim.</p>
        </div>)}</div>
        <div className="crypto-info-grid mt-4">{context?.chainActivity?.map(c => <div key={c.chain}><h4>{c.chain} DeFi TVL · {dollars(c.tvlUsd)}</h4><p className="crypto-footnote">DefiLlama · received {timestamp(c.fetchedAt)}. {c.state.toLowerCase()}: provider observation time unavailable. Not net flows or token demand.</p></div>)}</div>
      </Box>
      <Box title="What this supports" note="Spot context is not a full trading model.">
        <div className="crypto-info-grid"><div><h4>Useful now</h4><p>Venue-specific price, spread, base-unit volume and daily range with visible timestamps. Compare conditions, not predicted profit.</p></div>
          <div><h4>Not supported yet</h4><p>Streaming depth, cross-venue confirmation, consolidated liquidations, validated targets and net execution costs. These gaps block an actionable trade brief.</p></div></div>
      </Box>
    </>}
    {view === "news" && <>
      <div className="crypto-overview-grid"><Box title="Crypto news" note="Publisher metadata; open the original for detail."><NewsList rows={context?.news.filter(n => n.group === "crypto") ?? []} limit={10} /></Box>
        <Box title="Macro & official releases" note="Secondary for meme ranking; relevant context for liquid crypto."><NewsList rows={context?.news.filter(n => n.group === "macro") ?? []} limit={10} /></Box></div>
      <Box title="Macro observations" note="Dates are observation dates, not surprise scores. Revised history is not vintage-safe.">
        <div className="crypto-macro-grid">{context?.macro.map(m => <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" data-testid={`crypto-macro-${m.id}`}><div className="flex justify-between gap-2"><span>{m.label}</span><Status state={m.state} /></div><strong>{m.value == null ? "Unavailable" : m.value.toLocaleString(undefined, { maximumFractionDigits: 3 })} <small>{m.unit}</small></strong><span>Observation {m.date ?? "unknown"}</span></a>)}</div>
        {!context && <p className="crypto-empty">Macro source observations have not loaded.</p>}
      </Box>
    </>}
    {view === "evidence" && <>
      <Box title="Social coverage" note="A successful request is not complete market coverage." testId="crypto-social-summary">
        <div className="crypto-info-grid">
          <div><h4>Contract-attributed samples</h4><p>{feed ? <>{socialSampled.length} / {socialMints.length} tracked mints have a current Bluesky sample.
            {" "}{socialSampled.filter(c => (c.socialDetail?.contract.mentions1h ?? 0) > 0).length} have exact-contract matches in that sample.</> :
            "Current feed unavailable or loading; no coverage count is assumed."}</p></div>
          <div><h4>Still outside our view</h4><p>X is disabled. Pump.fun may deny public access. Ticker chatter is separate context,
            never a substitute for token attribution or proof of organic demand.</p></div>
        </div>
        <p className="crypto-footnote">Four unique mints per pass, with priority and oldest-first coverage. Open a sampled token in Meme discovery
          for query counts, source posts and a guarded comparison of non-overlapping 10-minute windows. Unpolled mints remain unknown.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {socialSampled.slice(0,4).map(c => <button key={c.tokenAddress} type="button"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            data-testid={`crypto-social-inspect-${c.pairAddress.slice(0,8)}`}
            onClick={() => { setView("meme"); setFilter("ALL"); setQuery(c.tokenAddress);
              setExpanded(c.pairAddress); window.scrollTo({top:0,behavior:"instant"}); }}>
            Inspect {c.symbol} social sample
          </button>)}
        </div>
      </Box>
      <Box title="Collectors & coverage" note="These are deterministic routines, not autonomous reasoning agents." testId="crypto-agent-strip">
        <div className="crypto-engine-grid">{healthQ.data?.engines.map(e => <div key={e.name} data-testid={`crypto-engine-${e.name}`}><div className="flex justify-between gap-2"><strong>{e.name}</strong><Status state={e.status} /></div><p>Last completed run {timestamp(e.lastOkAt)}</p><p>{e.runs} runs · {e.errors} errors</p>
          {e.coverage && <><p>{e.coverage.usable} usable · {e.coverage.pending} coverage gaps<br />{e.coverage.attempted} attempted in latest batch</p>
            {e.coverage.issues.map(issue => <p key={issue} className="text-xs">{issue}</p>)}</>}
          {e.lastError && <p className="crypto-error">{e.lastError}</p>}
        </div>)}</div>
        {healthQ.isError && <p className="crypto-error">Collector health unavailable.</p>}
      </Box>
      <Box title="Source register" note="Publication time, observation time and fetch time are not interchangeable.">
        <div className="crypto-source-list">{context?.sources.map(s => <article key={s.id} data-testid={`crypto-source-${s.id}`}><div className="flex items-start justify-between gap-3"><a href={s.url} target="_blank" rel="noopener noreferrer">{s.name} <ArrowUpRight size={13} /></a><Status state={s.state} /></div><p>{s.role} · {s.cadence}</p><p>Observed {timestamp(s.observedAt)} · received {timestamp(s.fetchedAt)}</p><small>{s.limitation}</small></article>)}</div>
        {!context && <p className="crypto-empty">Source register is {contextQ.isError ? "unavailable" : "loading"}. No healthy status is assumed.</p>}
      </Box>
      <Box title="Open evidence gates" note="Visible blockers, not promised integrations.">
        <ul className="crypto-gap-list">{(context?.gaps ?? ["Source contract loading. X remains disabled; no new account access is assumed."]).map(g => <li key={g}><Database size={14} /><span>{g}</span></li>)}</ul>
        <details className="crypto-methodology"><summary data-testid="crypto-methodology">Research ranking methodology</summary><p>Flow 35 + risk-screen structure 25 + sampled social 10. No name, narrative, paid promotion or trending bonus. Missing evidence remains missing; points are not win probability. Unchecked, unsupported or stale mint evidence blocks WATCH qualification.</p><p>Liquidity, account concentration and stop scenarios are not executable depth, beneficial-owner identity or a guaranteed exit.</p><code data-testid="crypto-score-version">{feed?.scoreVersion ?? "Version unavailable"}</code></details>
      </Box>
    </>}
    {view === "outcomes" && <Box title="Discovery outcomes" note="Market-cap milestones, not paper-trade P&L or realized returns.">
      <div className="crypto-safety-line"><ShieldAlert size={16} /><span>Unobservable records are not wins or losses. Legacy ENTER rows retain their original labels; new ENTER signals remain disabled.</span></div>
      {healthQ.data?.lastGradeBatch && <p className="crypto-footnote" data-testid="crypto-grade-batch">
        Latest grading batch: {healthQ.data.lastGradeBatch.observed} observations
        {" · "}{healthQ.data.lastGradeBatch.partial ?? 0} partial
        {" · "}{healthQ.data.lastGradeBatch.unavailable} unavailable
        {" · "}{healthQ.data.lastGradeBatch.deferred ?? 0} awaiting retry.
        {" "}Missing pools are never replaced by another pool. Historical rows without documented coverage cannot establish a full-window result.
      </p>}
      {sigQ.isError ? <p className="crypto-error">Outcome ledger unavailable. No zero-loss claim can be made.</p> : <SignalLog sig={sigQ.data} loading={sigQ.isLoading} />}
    </Box>}
    <footer className="crypto-footnote">Read-only research · no wallet connection, signing or order routing · context {context?.version ?? "pending"}</footer>
  </div>;
}
