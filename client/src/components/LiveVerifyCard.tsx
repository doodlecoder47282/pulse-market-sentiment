/**
 * LiveVerifyCard.tsx: "Verify live data" (Settings, once Schwab is connected).
 *
 * One tap runs GET /api/verify/live on the server: every Schwab-fed panel
 * route is reached the way the UI reaches it, and the key numbers are
 * recomputed from the raw inputs (server/liveVerify.ts, shared/liveVerify.ts).
 * The card shows the counts first, then every check with what was observed
 * and what the recomputation expected. Stale, unavailable and skipped are
 * their own states, never folded into pass. Descriptive; no advice.
 */
import { useRef, useState } from "react";
import { apiJson } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import type { Check, VerifySummary } from "@shared/liveVerify";

interface Report {
  version: 1;
  dataState: "ok" | "blocked" | "not_connected";
  connected: boolean;
  session: "open" | "closed";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cached: boolean;
  summary: VerifySummary;
  reach: Check[];
  checks: Check[];
  scope: string;
  note: string | null;
}

const STATE_CLS: Record<Check["state"], string> = {
  pass: "text-emerald-300",
  fail: "text-red-300",
  stale: "text-amber-300",
  unavailable: "text-amber-300",
  skipped: "text-muted-foreground",
};

const VERDICT_TEXT: Record<VerifySummary["verdict"], string> = {
  all_pass: "Every reachable data point answered live and every recomputed number matched.",
  issues: "Some data points did not answer, were stale, or did not match their recomputation. Review the rows below.",
  not_connected: "Schwab is not connected; only the keyless crypto desk was verified.",
  nothing_checked: "Nothing was checked.",
};

function Row({ c }: { c: Check }) {
  return (
    <li className="rounded border border-border/40 p-2 text-xs leading-snug" data-testid={`verify-row-${c.id.replace(/\W/g, "-")}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">{c.name} <span className="font-normal text-muted-foreground">· {c.panel}</span></span>
        <span className={`font-semibold uppercase ${STATE_CLS[c.state]}`}>{c.state}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        served {c.observed}{c.expected ? ` · expected ${c.expected}` : ""}
      </div>
      {c.detail && <div className="mt-0.5 text-muted-foreground">{c.detail}</div>}
    </li>
  );
}

export default function LiveVerifyCard() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setErr(null); setReport(null);
    try {
      const j = await apiJson<Report>("GET", "/api/verify/live");
      if (j.version !== 1 || !j.summary || !Array.isArray(j.checks) || !Array.isArray(j.reach)) throw new Error("report not supported");
      setReport(j);
    } catch (e: any) {
      setErr(/^429\b/.test(String(e?.message)) ? "The server is at its limit for this check; try again in a minute." : "No verification result. The server may be unavailable or running an older build.");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  const problems = report ? [...report.reach, ...report.checks].filter((c) => c.state !== "pass") : [];
  const all = report ? [...report.checks, ...report.reach] : [];
  const s = report?.summary;

  return (
    <div className="space-y-2 pt-1" data-testid="live-verify">
      <Button size="sm" variant="outline" className="h-auto min-h-[44px] w-full whitespace-normal py-2 text-sm leading-snug" onClick={run} disabled={busy} data-testid="live-verify-btn">
        {busy ? "Reaching every panel and recomputing..." : "Verify live data"}
      </Button>
      <p className="text-xs text-muted-foreground">Reaches every Schwab-fed panel the way the app does and recomputes the key numbers from the raw chain, quotes and bars. Takes up to a minute.</p>
      {err && <div role="status" className="text-sm text-foreground" data-testid="live-verify-error">{err}</div>}
      {report && s && (
        <>
          <p role="status" className="text-sm text-foreground" data-testid="live-verify-summary">
            {report.dataState === "blocked" || report.dataState === "not_connected" ? report.note : VERDICT_TEXT[s.verdict as VerifySummary["verdict"]]}
          </p>
          {(report.dataState === "ok" || all.length > 0) && (
            <div className="grid grid-cols-5 gap-1 text-center font-mono text-[11px]" data-testid="live-verify-counts">
              <div><div className="text-emerald-300">{s.pass}</div><div className="text-muted-foreground">pass</div></div>
              <div><div className="text-red-300">{s.fail}</div><div className="text-muted-foreground">fail</div></div>
              <div><div className="text-amber-300">{s.stale}</div><div className="text-muted-foreground">stale</div></div>
              <div><div className="text-amber-300">{s.unavailable}</div><div className="text-muted-foreground">unavail.</div></div>
              <div><div className="text-muted-foreground">{s.skipped}</div><div className="text-muted-foreground">skipped</div></div>
            </div>
          )}
          {(report.dataState === "ok" || all.length > 0) && (
            <p className="text-xs text-muted-foreground">
              {report.cached ? "Recent run" : "Ran"} at {new Date(report.finishedAt).toLocaleTimeString()} in {Math.round(report.durationMs / 1000)}s, session {report.session}. {report.note ? `${report.note} ` : ""}{report.scope}
            </p>
          )}
          {(report.dataState === "ok" || all.length > 0) && (
            <>
              {problems.length > 0 && !showAll && (
                <ul className="space-y-1.5" data-testid="live-verify-problems">{problems.map((c) => <Row key={c.id} c={c} />)}</ul>
              )}
              {showAll && <ul className="space-y-1.5" data-testid="live-verify-all">{all.map((c) => <Row key={c.id} c={c} />)}</ul>}
              <button type="button" className="min-h-[44px] w-full text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowAll((v) => !v)} data-testid="live-verify-toggle">
                {showAll ? "Show only what needs attention" : `Show all ${all.length} checks`}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
