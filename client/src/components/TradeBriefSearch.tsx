import { useEffect, useId, useRef, useState } from "react";
import { Search, ChevronRight, RefreshCw, ShieldCheck } from "lucide-react";
import { transportRequest } from "@/lib/queryClient";
import { TradeBriefAi } from "./TradeBriefAi";
import { EvidenceHistory } from "./EvidenceHistory";
import { EvidenceTiming } from "./EvidenceTiming";
import { TradeBriefSummary } from "./TradeBriefSummary";
import { getSourceContract } from "@shared/evidencePolicy";
import {
  SearchResponseSchema, TradeBriefSchema, tradeBriefExpired,
  type CoverageStatus, type TradeBrief, type TradeBriefHorizon, type TradeBriefInstrument,
} from "@shared/tradeBrief";

const control = "min-h-[44px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50";
const action = `${control} inline-flex items-center justify-center gap-2 font-medium hover:bg-muted`;
const statusLabels: Record<CoverageStatus, string> = {
  available: "Available", partial: "Partial", delayed: "Delayed / lag unknown", stale: "Stale",
  missing: "Missing", unavailable: "Unavailable", unsupported: "Unsupported", not_applicable: "Not applicable",
};
const amount = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value);
function timestamp(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} (date only)`;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  })}` : "Time unavailable";
}
function Badge({ status }: { status: CoverageStatus }) {
  const color = status === "available" ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
    : status === "stale" || status === "delayed" ? "border-amber-500/40 text-amber-800 dark:text-amber-300"
    : "border-border text-muted-foreground";
  return <span className={`inline-block rounded-md border px-2 py-1 text-xs leading-snug ${color}`}>{statusLabels[status]}</span>;
}

async function getJson(path: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await transportRequest("GET", path);
        if (!response.ok) {
          if (response.status === 429) throw new Error("The research request budget is busy. Wait a minute, then retry manually.");
          if (response.status === 401 || response.status === 403) throw new Error("This research endpoint is not authorized in the current session.");
          throw new Error("Research data is unavailable. Retry manually; no substitute prices were generated.");
        }
        return response.json();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The request timed out. Retry manually; no substitute prices were generated.")), 12_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Standalone web component. No polling, automatic Analyze, model calls, storage or native work.
 * Request generations discard results after edits, horizon changes, new requests or unmount.
 */
export function TradeBriefSearch({ className = "" }: { className?: string }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [horizon, setHorizon] = useState<TradeBriefHorizon>("swing");
  const [selected, setSelected] = useState<TradeBriefInstrument | null>(null);
  const [matches, setMatches] = useState<TradeBriefInstrument[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [searched, setSearched] = useState(false);
  const [brief, setBrief] = useState<TradeBrief | null>(null);
  const [busy, setBusy] = useState<"search" | "brief" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [expired, setExpired] = useState(false);
  const [editing, setEditing] = useState(true);
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const generation = useRef(0);
  const resultRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const online = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", off);
    return () => {
      generation.current++;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    if (!brief) { setExpired(false); return; }
    const update = () => setExpired(tradeBriefExpired(brief));
    update();
    const timer = setTimeout(update, Math.max(0, Date.parse(brief.expires_at) - Date.now()) + 25);
    // A suspended phone tab may miss its deadline until it resumes.
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, [brief]);

  function supersede(message = "Previous brief superseded. Analyze the selected listing and horizon again.") {
    generation.current++;
    if (brief || busy === "brief") setNotice(message);
    setBrief(null);
    setExpired(false);
    setBusy(null);
    setError(null);
  }
  function editQuery(value: string) {
    supersede();
    setNotice("");
    setQuery(value);
    setSelected(null);
    setMatches([]);
    setSearched(false);
    setMatchCount(0);
  }
  async function search() {
    if (!query.trim() || offline || busy === "search") return;
    const searchTerm = query.trim();
    supersede();
    setSelected(null);
    setMatches([]);
    setSearched(false);
    const request = ++generation.current;
    setBusy("search");
    setNotice(`Looking for “${searchTerm}”…`);
    try {
      const result = SearchResponseSchema.parse(await getJson(`/api/trade-brief/search?q=${encodeURIComponent(searchTerm)}`));
      if (generation.current !== request) return;
      setMatches(result.instruments);
      setMatchCount(result.total);
      setSearched(true);
      setNotice(result.total > 0
        ? `${result.total} matching ${result.total === 1 ? "listing" : "listings"}. Select the exact instrument below.`
        : `No supported listing found for “${searchTerm}”.`);
    } catch (e) {
      if (generation.current === request) {
        setNotice("");
        setError(e instanceof Error && !(e.name === "ZodError")
          ? e.message : "The lookup returned an incompatible response. No listing was selected.");
      }
    } finally { if (generation.current === request) setBusy(null); }
  }
  function select(instrument: TradeBriefInstrument) {
    supersede();
    setSelected(instrument);
    setMatches([]);
    setNotice("Listing confirmed. Analyze to capture a research snapshot.");
  }
  async function analyze() {
    if (!selected || offline) return;
    const request = ++generation.current;
    setBusy("brief");
    setError(null);
    setBrief(null); // never leave old levels beside a new in-flight quote
    setNotice("");
    try {
      const result = TradeBriefSchema.parse(await getJson(
        `/api/trade-brief?instrument_id=${encodeURIComponent(selected.id)}&horizon=${horizon}`,
      ));
      if (generation.current !== request) return;
      if (result.instrument_id !== selected.id || result.instrument.id !== selected.id || result.horizon !== horizon) {
        throw new Error("The response does not match the selected listing and horizon. Nothing was displayed.");
      }
      setBrief(result);
      setEditing(false);
      setExpired(tradeBriefExpired(result));
      setNotice("");
      setTimeout(() => { if (generation.current === request) {
        resultRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
        resultRef.current?.focus({ preventScroll: true });
      } }, 0);
    } catch (e) {
      if (generation.current === request) setError(e instanceof Error && !(e.name === "ZodError")
        ? e.message : "The research snapshot failed validation. No values were displayed.");
    } finally { if (generation.current === request) setBusy(null); }
  }

  return <section data-testid="trade-brief-search" aria-labelledby={`${id}-title`} className={`min-w-0 [overflow-wrap:anywhere] rounded-xl border border-border bg-card text-card-foreground shadow-sm ${className}`}>
    <div className="border-b border-border p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-semibold"><Search size={18} aria-hidden="true" />Stock research</h2>
          <p className="mt-1 text-sm text-muted-foreground">Price context. Key drivers. Your next check.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
          <ShieldCheck size={14} aria-hidden="true" /> STOCKS / ETFs
        </span>
      </div>
      {brief && !editing && <div className="flex flex-wrap items-center justify-between gap-2" data-testid="brief-compact-search">
        <button data-testid="brief-edit-search" type="button" className={action} onClick={() => setEditing(true)}>
          <Search size={16} aria-hidden="true" />{brief.instrument.symbol} · {horizon === "swing" ? "Swing" : "Intraday"}<span className="text-muted-foreground">Change</span>
        </button>
        <button data-testid="brief-quick-refresh" type="button" className={action} onClick={analyze} disabled={offline || busy === "brief"}>
          <RefreshCw size={16} aria-hidden="true" />Refresh
        </button>
      </div>}
      <div hidden={brief !== null && !editing}>
      {/* Embedded previews can disallow native form submission, including React
          onSubmit. Explicit click/Enter handlers also work without allow-forms. */}
      <div role="search" aria-label="Find a stock or ETF" className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className="min-w-0">
          <label htmlFor={`${id}-search`} className="mb-1.5 block text-sm font-medium">Ticker or company</label>
          <input data-testid="trade-brief-query" id={`${id}-search`} className={`${control} w-full`} type="search" value={query} maxLength={64}
            placeholder="e.g. SPY, NVDA, Intel" autoComplete="off" spellCheck={false}
            enterKeyHint="search" aria-describedby={`${id}-scope`} onChange={e => editQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void search();
              }
            }} />
        </div>
        <button data-testid="trade-brief-find" aria-label="Find listing" className={`${action} self-end`} type="button" onClick={() => void search()} disabled={!query.trim() || busy === "search" || offline}>
          <Search size={16} aria-hidden="true" /><span className="hidden sm:inline">{busy === "search" ? "Finding…" : "Search"}</span>
        </button>
      </div>
      <p data-testid="trade-brief-search-status" role="status" aria-live="polite" aria-atomic="true" className="mt-3 text-sm text-muted-foreground">
        {busy === "search" || (searched && !selected) ? notice : ""}
      </p>
      <p id={`${id}-scope`} className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Selected US listings · USD · Confirm your match before analysis.
      </p>

      {matches.length > 0 && <div className="mt-4">
        <p className="mb-2 text-sm font-medium">Confirm the exact instrument{matchCount > matches.length ? " — refine your search for additional matches" : ""}</p>
        <ul aria-label="Matching instruments" className="grid gap-2 md:grid-cols-2">
          {matches.map(i => <li key={i.id}>
            <button data-testid={`trade-brief-listing-${i.symbol}`} type="button" className={`${action} w-full justify-between text-left`} onClick={() => select(i)}>
              <span className="min-w-0 break-words"><strong>{i.symbol}</strong><span className="ml-2 text-xs text-muted-foreground">{i.asset_class} · USD</span>
                <span className="mt-0.5 block text-sm font-normal">{i.name}</span>
              </span><ChevronRight size={16} className="shrink-0" aria-hidden="true" />
            </button>
          </li>)}
        </ul>
      </div>}
      {searched && !matches.length && !selected && <p className="mt-3 text-sm text-muted-foreground" role="status">
        No match in this bounded universe. Try a supported ticker or a more specific name. This does not mean the security is invalid.
      </p>}

      {selected && <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <span className="block text-xs text-muted-foreground">Selected instrument</span>
          <span className="block break-words text-sm font-medium">{selected ? `${selected.symbol} · ${selected.asset_class} · ${selected.name}` : "Choose a search result"}</span>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-horizon`} className="mb-1.5 block text-sm font-medium">Research horizon</label>
          <select data-testid="trade-brief-horizon" id={`${id}-horizon`} value={horizon} className={`${control} w-full`}
            onChange={e => { supersede(); setHorizon(e.target.value as TradeBriefHorizon); }}>
            <option value="swing">Swing</option>
            <option value="intraday">Intraday</option>
          </select>
        </div>
        <button data-testid="trade-brief-analyze" className={`${action} border-primary/40 bg-primary/10`} type="button" disabled={!selected || busy === "brief" || offline} onClick={analyze}>
          {brief ? <RefreshCw size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          {busy === "brief" ? "Analyzing…" : brief ? "Refresh brief" : "Analyze"}
        </button>
      </div>}
      <div aria-live="polite" aria-atomic="true" className="mt-3 text-sm text-muted-foreground">
        {busy === "brief" ? "Checking price, history, events and source coverage…"
          : busy !== "search" && (!searched || selected) ? notice : ""}
      </div>
      {offline && <p role="alert" className="mt-2 text-sm text-amber-800 dark:text-amber-300">Offline. Previous snapshots are not live; reconnect and refresh manually.</p>}
      {error && <p data-testid="trade-brief-error" role="alert" className="mt-2 break-words text-sm text-destructive">{error}</p>}
      {!brief && !busy && !error && !notice && <p className="mt-3 text-sm text-muted-foreground">
        Search a company or ticker to see a concise, source-backed research brief.
      </p>}
      </div>
    </div>

    {brief && <div className="min-w-0 p-4 sm:p-5">
      <TradeBriefSummary brief={brief} expired={expired} resultRef={resultRef} />
      <div className="brief-tools">
        <details data-testid="brief-history-disclosure">
          <summary data-testid="brief-history-toggle">Saved evidence</summary>
          <EvidenceHistory key={`history-${brief.snapshot_id}`} brief={brief} offline={offline} />
        </details>
        <details data-testid="brief-ai-disclosure">
          <summary data-testid="brief-ai-toggle">Optional AI prioritization</summary>
          <TradeBriefAi key={brief.snapshot_id} brief={brief} expired={expired} offline={offline} />
        </details>
      </div>
      <details className="brief-full-record" data-testid="brief-full-record">
        <summary data-testid="brief-full-record-toggle">Sources, calculations &amp; full research record</summary>
        <p className="mb-4 text-xs text-muted-foreground">Captured {timestamp(brief.created_at)}. {expired ? "Current checks expired; historical record only." : `Current checks expire ${timestamp(brief.expires_at)}.`}</p>
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold">
              {brief.instrument.symbol} <span className="font-normal text-muted-foreground">/ {brief.horizon === "swing" ? "Swing research" : "Intraday research"}</span>
            </h3>
            <span className="rounded-md border border-amber-500/40 px-2 py-1 text-xs font-semibold text-amber-800 dark:text-amber-300">
              {expired ? "EXPIRED" : brief.verdict}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Captured {timestamp(brief.created_at)}<br />
            Expires {timestamp(brief.expires_at)} · {brief.coverage === "partial" ? "Partial coverage" : "Insufficient coverage"}<br />
            {brief.session.label}
          </p>
          {brief.session.schedule && <details data-testid="trade-brief-calendar" className="mt-3 rounded-lg border border-border">
            <summary data-testid="trade-brief-calendar-toggle" className="min-h-[44px] cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              {brief.session.schedule.coverage === "covered" ? "Session calendar · published schedule" : "Session calendar · unsupported date"}
            </summary>
            <div className="space-y-2 border-t border-border p-3 text-xs leading-relaxed text-muted-foreground">
              <p data-testid="trade-brief-calendar-hours">{brief.session.schedule.session_date} · {brief.session.schedule.day_type.replaceAll("_", " ")}
                {brief.session.schedule.session_minutes ? ` · ${brief.session.schedule.session_minutes} scheduled core minutes` : ""}
                {brief.session.schedule.holiday ? ` · ${brief.session.schedule.holiday}` : ""}</p>
              <p>Cash-equity core hours only. Published holidays are excluded from expected bars; real missing sessions still block calculations. Shortened sessions do not enter an unnormalized full-day volume comparison.</p>
              <p>Not live venue or halt status. No point-in-time backtest approval. Coverage: {brief.session.schedule.coverage_from} through {brief.session.schedule.coverage_through}.</p>
              <p>Reviewed {timestamp(brief.session.schedule.reviewed_at)} · {brief.session.schedule.version}</p>
              <div className="flex flex-wrap gap-3">
                {brief.session.schedule.source_urls.map((url, i) => <a key={url} data-testid={`trade-brief-calendar-source-${i}`} href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center underline underline-offset-2">{i === 0 ? "NYSE calendar" : "Nasdaq calendar"}</a>)}
              </div>
            </div>
          </details>}
          <p className="mt-3 text-sm leading-relaxed">{brief.thesis}</p>
          {!expired && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="min-w-0 rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Verified last trade</p>
              <p className="mt-1 break-words text-base font-semibold tabular-nums">{brief.quote ? amount(brief.quote.value) : "Withheld"}</p>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">{brief.quote ? `${brief.quote.source} · ${timestamp(brief.quote.observed_at)}` : "No usable current price"}</p>
            </div>
            {brief.levels.map(level => <div key={level.kind} className="min-w-0 rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{level.label}</p>
              <p className="mt-1 break-words text-base font-semibold tabular-nums">{amount(level.value)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Reference only</p>
            </div>)}
          </div>}
          {!!brief.levels.length && <p className="mt-2 text-xs text-muted-foreground">{brief.levels[0].period} · USD/share · Not an entry, stop or target.</p>}
          {!expired && !!brief.claims.length && <div data-testid="trade-brief-factors" className="mt-4 rounded-lg border border-border p-4">
            <h4 className="text-sm font-semibold">Calculated evidence</h4>
            <p className="mt-1 text-xs text-muted-foreground">Existing inputs, explicit formulas. Descriptive context, not a proven trading edge.</p>
            <ul className="mt-3 space-y-3 text-sm leading-relaxed">
              {brief.claims.map((claim, i) => <li key={i} className="border-t border-border pt-3 first:border-0 first:pt-0">
                {claim.text}<span className="mt-1 block break-words text-xs text-muted-foreground">Evidence: {claim.evidence_ids.join(", ")}</span>
              </li>)}
            </ul>
          </div>}
          {!expired && !!brief.context_items?.some(item => item.category === "news" || item.category === "earnings") && <div data-testid="trade-brief-context" className="mt-4">
            <h4 className="text-sm font-semibold">News and event context</h4>
            <ul className="mt-2 space-y-3">
              {brief.context_items.filter(item => item.category === "news" || item.category === "earnings").map(item => <li key={item.id} className="rounded-lg border border-border p-3 text-sm leading-relaxed">
                <p>{item.text}</p><p className="mt-1 text-xs text-muted-foreground">{item.category} · {timestamp(item.observed_at)} · {statusLabels[item.status]}</p>
                <a data-testid={`trade-brief-context-${item.id}`} href={item.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs underline underline-offset-2">{item.source}</a>
              </li>)}
            </ul>
          </div>}
          <div className="mt-4 space-y-3 text-sm leading-relaxed">
            <div><h4 className="font-semibold">Wait-for condition</h4><p className="mt-1 text-muted-foreground">{brief.trigger}</p></div>
            <div><h4 className="font-semibold">What argues against a trade</h4><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
              {brief.counterevidence.map(text => <li key={text}>{text}</li>)}
            </ul></div>
            <div><h4 className="font-semibold">Risk &amp; next action</h4>
              <p className="mt-1 text-muted-foreground">Entry, stop, targets, net reward/risk and sizing are withheld. Verify event timing and execution prerequisites before defining a plan. A stop is not a guaranteed fill or maximum loss.</p>
              <p className="mt-1 text-muted-foreground">This snapshot expires and is not monitored for price crossings. Refresh manually after material changes; changing listing or horizon supersedes it.</p>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Deterministic calculations · No automatic AI call</strong><br />{brief.explanation.detail}
          </div>
        </div>

        <aside aria-label="Coverage and evidence" className="min-w-0">
          <h4 className="text-sm font-semibold">Coverage check</h4>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">Every relevant category is accounted for. Status is as captured, not continuously updated.</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {brief.source_statuses.map(s => <li key={s.category} className="min-w-0 rounded-lg border border-border px-3 py-2">
              <p className="mb-1.5 text-sm font-medium capitalize">{s.category}</p><Badge status={s.status} />
              <p className="mt-1 text-xs text-muted-foreground">{s.contributed ? "Contributed to snapshot" : s.applicability === "not_applicable" ? "Not a company-earnings input" : "Did not contribute"}</p>
              <p data-testid={`trade-brief-coverage-${s.category}`} className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.reason}</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">{s.observed_at ? timestamp(s.observed_at) : "Observation time unavailable"}</p>
            </li>)}
          </ul>
          {brief.evidence_review && <details data-testid="trade-brief-policy" className="mt-3 rounded-lg border border-border">
            <summary data-testid="trade-brief-policy-toggle" className="min-h-[44px] cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Source policy &amp; AI eligibility
            </summary>
            <div className="space-y-3 border-t border-border p-3 text-sm leading-relaxed">
              <p data-testid="trade-brief-policy-count">{expired ? "Expired snapshot: no current AI eligibility."
                : `${brief.evidence_review.eligible_ids.length} evidence items passed the contract at capture; ${brief.evidence_review.excluded.length} excluded from AI selection.`}</p>
              <p className="text-xs text-muted-foreground">This counts evidence items, not independent sources or confidence. AI rechecks at request time.</p>
              <EvidenceTiming brief={brief} testId="trade-brief-timing" />
              <ul className="space-y-2 text-xs text-muted-foreground">
                {brief.evidence_review.source_ids.map(id => {
                  const contract = getSourceContract(id);
                  return <li key={id}><strong className="text-foreground">{contract?.name ?? "Unregistered source"}</strong>
                    <br />{contract?.limitation ?? "Excluded until a source contract is registered."}
                    <br />Rights unverified · Not approved for public/multi-user use
                  </li>;
                })}
              </ul>
              {brief.evidence_review.excluded.length > 0 && <details>
                <summary data-testid="trade-brief-policy-exclusions" className="min-h-[44px] cursor-pointer py-3 text-sm">Why evidence was excluded</summary>
                <ul className="space-y-1 text-xs text-muted-foreground">{brief.evidence_review.excluded.map(e => <li key={e.id}>{e.id}: {e.reasons.map(r => r.replaceAll("_", " ")).join("; ")}</li>)}</ul>
              </details>}
              {brief.evidence_review.limitations.map(text => <p key={text} className="text-xs text-muted-foreground">{text}</p>)}
              <p className="text-xs text-muted-foreground">{brief.evidence_review.version}</p>
            </div>
          </details>}
          <details className="mt-3 rounded-lg border border-border">
            <summary className="min-h-[44px] cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Evidence, freshness &amp; gaps</summary>
            <div className="space-y-4 border-t border-border p-3 text-xs leading-relaxed">
              {brief.source_statuses.map(s => <div key={s.category}>
                <h5 className="text-sm font-semibold capitalize">{s.category} · {statusLabels[s.status]}</h5>
                <p className="mt-1 text-muted-foreground">{s.reason}</p>
                <p className="mt-1 break-words text-muted-foreground">{s.source} · {s.applicability.replace("_", " ")}
                  {s.max_age_seconds !== null ? ` · Age limit ${s.max_age_seconds} seconds` : " · No instantaneous-age contract"}</p>
                <p className="mt-1 text-muted-foreground">Dependencies: {s.dependencies.join("; ")}.</p>
              </div>)}
              {brief.evidence.length ? brief.evidence.map(e => <div key={e.id} className="border-t border-border pt-3">
                <p className="font-semibold">{e.label}</p>
                <p className="mt-1 break-words tabular-nums">{e.value.toLocaleString("en-US", { maximumFractionDigits: 6 })} {e.unit} · {statusLabels[e.status]}</p>
                <p className="mt-1 text-muted-foreground">{timestamp(e.observed_at)} · {e.time_precision} precision · ID: {e.id}</p>
                <a className="mt-1 inline-block break-words underline underline-offset-2" href={e.url} target="_blank" rel="noopener noreferrer">{e.source}</a>
              </div>) : <p className="text-muted-foreground">No validated numeric observations in this snapshot. Missing values have not been filled in.</p>}
            </div>
          </details>
          <details className="mt-3 rounded-lg border border-border">
            <summary className="min-h-[44px] cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Methodology &amp; invalidation</summary>
            <div className="space-y-3 border-t border-border p-3 text-xs leading-relaxed text-muted-foreground">
              {[...brief.methodology, ...brief.prerequisites, ...brief.management_rules, ...brief.invalidation_rules,
                ...brief.risk.assumptions, ...brief.risk.limitations].map((text, i) => <p key={i}>{text}</p>)}
              {brief.levels.map(l => <p key={l.kind} className="break-all">{l.label}: {l.formula_id}. Evidence: {l.evidence_ids.join(", ")}.</p>)}
              <p className="break-all">Snapshot: {brief.snapshot_id}<br />Calculation: {brief.calculation_version}<br />Model: none</p>
            </div>
          </details>
        </aside>
      </div>
      </details>
    </div>}
  </section>;
}

export default TradeBriefSearch;
