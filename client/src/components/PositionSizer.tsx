// PositionSizer — risk-first contract sizer for banger trades.
// Plug in account size, entry, stop, grade → get contracts, $risk, Kelly fraction.
// API: POST /api/position-sizer

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { buildSizerRequest } from "@shared/sizerRequest";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Calculator, AlertTriangle, CheckCircle2 } from "lucide-react";

interface SizingResult {
  contracts: number;
  riskDollars: number;
  notionalDollars: number;
  kellyAccountFraction: number;
  bindingConstraint: "risk-floor" | "kelly-cap" | "conviction-tier" | "min-contract" | "cash" | "gap-cap";
  expectedPayoffPct: number;
  rejected: boolean;
  rejectReason?: string;
  reasoning: string[];
  // Added by the server sizer (all $ for the whole position unless perContract)
  maxLossDollars?: number;
  feesDollars?: number;
  riskBudgetDollars?: number;
  perContract?: { premium: number; riskAtStop: number; maxLoss: number; feesRoundTrip: number } | null;
}

// MISSION FIX #2 — edge survival waterfall (POST /api/edge/survival)
interface SurvivalRow { label: string; pct: number; note: string }
interface SurvivalResult {
  grossEvPct: number;            // realized ledger mean, % of premium
  rows: SurvivalRow[];
  netEvPct: number;
  adverseNetEvPct: number | null; // null: theta not repriced (no contract inputs)
  stress?: SurvivalRow[];
  reference?: SurvivalRow[];     // this quote's costs, already inside realized returns
  verdict: "EXPRESS" | "MARGINAL" | "STAND_DOWN" | "INSUFFICIENT_EVIDENCE";
  pUsed: number;
  pSource: string;
  evidence?: { bucket: string | null; n: number; wins: number };
  note: string;
}

function fmtDollar(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtCents(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PositionSizer() {
  const [accountSize, setAccountSize] = useState("25000");
  const [maxRiskPct, setMaxRiskPct] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [gradeScore, setGradeScore] = useState("85");
  const [targetPct, setTargetPct] = useState("50");
  const [kellyFraction, setKellyFraction] = useState("25");
  const [spreadDollars, setSpreadDollars] = useState("0.10");
  const [holdMin, setHoldMin] = useState("45");
  // Fees: $ per contract per side. Required for index options (SPXW): Schwab's
  // $0.65 plus exchange index fees that vary by account; read it off a confirm.
  const [feePerContract, setFeePerContract] = useState("");
  const [product, setProduct] = useState("SPXW");
  const [gapPct, setGapPct] = useState("5");

  const sizeMut = useMutation({
    mutationFn: async (): Promise<SizingResult> => {
      // The card collects MID prices; buildSizerRequest sends the fill (ask =
      // mid + spread/2) as entryPrice and spread/2 as the stop slippage.
      const res = await apiRequest("POST", "/api/position-sizer", buildSizerRequest({
        accountSize, maxRiskPctPercent: maxRiskPct, midPrice: entryPrice, stopPrice,
        spreadDollars, gradeScore, targetPct, kellyPercent: kellyFraction,
        feePerContract, product, maxGapLossPctPercent: gapPct,
      }));
      return await res.json();
    },
  });

  const survMut = useMutation({
    mutationFn: async (): Promise<SurvivalResult> => {
      const mid = Number(entryPrice);
      const half = Math.max(0, Number(spreadDollars)) / 2;
      const stopPctLoss = Math.abs((mid - Number(stopPrice)) / mid) * 100;
      const res = await apiRequest("POST", "/api/edge/survival", {
        gradeScore: Number(gradeScore),
        bid: mid - half,
        ask: mid + half,
        targetPct: Number(targetPct),
        stopPct: stopPctLoss,
        expectedHoldMin: Number(holdMin) || 45,
        // $ per contract per side; blank = not given (the waterfall says so)
        ...(String(feePerContract).trim() !== "" && Number.isFinite(Number(feePerContract)) ? { feePerContract: Number(feePerContract) } : {}),
        product,
      });
      return await res.json();
    },
  });

  const runBoth = () => {
    sizeMut.mutate();
    if (Number(entryPrice) > 0 && Number(stopPrice) > 0) survMut.mutate();
  };

  const r = sizeMut.data;
  const s = survMut.data;

  const verdictStyle = (v: SurvivalResult["verdict"]) =>
    v === "INSUFFICIENT_EVIDENCE"
      ? "border-border bg-muted/20 text-muted-foreground"
      : v === "EXPRESS"
      ? "border-green-500/30 bg-green-500/5 text-green-500"
      : v === "MARGINAL"
        ? "border-amber-500/30 bg-amber-500/5 text-amber-500"
        : "border-red-500/30 bg-red-500/5 text-red-500";

  return (
    <Card data-testid="card-position-sizer">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="w-4 h-4" /> Position sizer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">account size ($)</span>
            <Input
              type="number"
              value={accountSize}
              onChange={(e) => setAccountSize(e.target.value)}
              data-testid="input-account-size"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">max risk per trade (%)</span>
            <Input
              type="number"
              value={maxRiskPct}
              onChange={(e) => setMaxRiskPct(e.target.value)}
              step="0.25"
              data-testid="input-max-risk-pct"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">option mid now ($/share)</span>
            <Input
              type="number"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              step="0.05"
              placeholder="1.50"
              data-testid="input-entry-price"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">stop, mid level ($/share)</span>
            <Input
              type="number"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              step="0.05"
              placeholder="1.20"
              data-testid="input-stop-price"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">grade score (0-100)</span>
            <Input
              type="number"
              value={gradeScore}
              onChange={(e) => setGradeScore(e.target.value)}
              data-testid="input-grade-score"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">target T1 gain (%)</span>
            <Input
              type="number"
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              data-testid="input-target-pct"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Kelly fraction (%)</span>
            <Input
              type="number"
              value={kellyFraction}
              onChange={(e) => setKellyFraction(e.target.value)}
              step="5"
              data-testid="input-kelly-fraction"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">bid-ask spread ($/share; buy at ask, stop sells at bid)</span>
            <Input
              type="number"
              value={spreadDollars}
              onChange={(e) => setSpreadDollars(e.target.value)}
              step="0.05"
              data-testid="input-spread"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">product (option root)</span>
            <Input
              value={product}
              onChange={(e) => setProduct(e.target.value.toUpperCase())}
              placeholder="SPXW"
              data-testid="input-product"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">fees $/contract/side{product && /^(SPXW?|XSP|NDXP?|RUTW?|VIX|DJX|MRUT)$/.test(product) ? " (required for index)" : " (blank = $0.65)"}</span>
            <Input
              type="number"
              value={feePerContract}
              onChange={(e) => setFeePerContract(e.target.value)}
              step="0.01"
              placeholder="from your trade confirm"
              data-testid="input-fee-per-contract"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">max loss if it gaps to zero (% acct, max 5)</span>
            <Input
              type="number"
              value={gapPct}
              onChange={(e) => setGapPct(e.target.value)}
              step="0.5"
              data-testid="input-gap-pct"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">expected hold (min)</span>
            <Input
              type="number"
              value={holdMin}
              onChange={(e) => setHoldMin(e.target.value)}
              step="5"
              data-testid="input-hold-min"
            />
          </label>
          <div className="flex items-end">
            <Button
              onClick={runBoth}
              disabled={sizeMut.isPending || survMut.isPending}
              size="sm"
              className="w-full"
              data-testid="button-calculate-size"
            >
              {sizeMut.isPending || survMut.isPending ? "..." : "size it"}
            </Button>
          </div>
        </div>

        {r && r.rejected && (
          <div
            className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3"
            data-testid="text-sizer-rejected"
          >
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-red-500">REJECTED</div>
              <div className="text-xs text-muted-foreground">{r.rejectReason}</div>
            </div>
          </div>
        )}

        {r && !r.rejected && (
          <div className="space-y-3" data-testid="result-sizer-ok">
            <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/5 p-3">
              <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">contracts</div>
                  <div className="text-2xl font-bold" data-testid="text-contracts">
                    {r.contracts}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">risk</div>
                  <div className="text-lg font-semibold text-red-500" data-testid="text-risk-dollars">
                    {fmtCents(r.riskDollars)}
                  </div>
                </div>
                <div>
                  {/* notionalDollars is the premium paid (contracts x entry x 100, ex fees), not underlying notional */}
                  <div className="text-xs text-muted-foreground">premium paid</div>
                  <div className="text-lg font-semibold" data-testid="text-notional">
                    {fmtCents(r.notionalDollars)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">% of acct</div>
                  <div className="text-lg font-semibold" data-testid="text-account-fraction">
                    {(r.kellyAccountFraction * 100).toFixed(2)}%
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" data-testid="badge-binding-constraint">
                binding: {r.bindingConstraint}
              </Badge>
              <Badge variant="outline" data-testid="badge-payoff">
                target +{r.expectedPayoffPct}%
              </Badge>
            </div>
            {r.perContract && (
              <div className="text-xs text-muted-foreground font-mono tabular-nums" data-testid="text-sizer-dollars">
                per contract (x100): premium {fmtCents(r.perContract.premium)} · loss at stop {fmtCents(r.perContract.riskAtStop)} · fees {fmtCents(r.perContract.feesRoundTrip)}
                {" "}| position: max loss if it expires worthless {fmtCents(r.maxLossDollars ?? 0)} · fees {fmtCents(r.feesDollars ?? 0)} · risk budget {fmtCents(r.riskBudgetDollars ?? 0)}
              </div>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground" data-testid="summary-reasoning">
                why this size?
              </summary>
              <ul className="mt-2 space-y-1 ml-4 list-disc">
                {r.reasoning.map((line, i) => (
                  <li key={i} data-testid={`text-reasoning-${i}`}>
                    {line}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {s && (
          <div className={`rounded-md border p-3 space-y-2 ${verdictStyle(s.verdict)}`} data-testid="card-edge-survival">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm font-semibold" data-testid="text-survival-verdict">
                edge survival: {s.verdict.replace(/_/g, " ")}
              </div>
              <div className="text-xs opacity-90">
                {s.evidence && s.evidence.n > 0
                  ? `ledger ${s.evidence.bucket}: ${s.evidence.wins}/${s.evidence.n} wins, p used ${(s.pUsed * 100).toFixed(0)}% (${s.pSource.replace(/_/g, " ")})`
                  : "no realized ledger evidence"}
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-xs font-mono tabular-nums">
                <span className="text-foreground">realized EV (ledger mean)</span>
                <span>{s.grossEvPct >= 0 ? "+" : ""}{s.grossEvPct.toFixed(1)}%</span>
              </div>
              {s.rows.map((row, i) => (
                <div key={i} className="flex justify-between text-xs font-mono tabular-nums text-muted-foreground" data-testid={`row-survival-${i}`}>
                  <span>− {row.label}</span>
                  <span>−{Math.abs(row.pct).toFixed(1)}%</span>
                </div>
              ))}
              <div className="flex justify-between text-xs font-mono tabular-nums font-semibold border-t border-current/20 pt-1 text-foreground">
                <span>net EV</span>
                <span data-testid="text-net-ev">{s.netEvPct >= 0 ? "+" : ""}{s.netEvPct.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-xs font-mono tabular-nums text-muted-foreground">
                <span>adverse scenario</span>
                <span data-testid="text-adverse-ev">{s.adverseNetEvPct == null ? "not computed" : `${s.adverseNetEvPct >= 0 ? "+" : ""}${s.adverseNetEvPct.toFixed(1)}%`}</span>
              </div>
              {(s.stress ?? []).map((row: SurvivalRow, i: number) => (
                <div key={`st-${i}`} className="flex justify-between text-[11px] font-mono tabular-nums text-muted-foreground/80" title={row.note}>
                  <span>&nbsp;&nbsp;stress: {row.label}</span>
                  <span>{row.pct.toFixed(1)}%</span>
                </div>
              ))}
              {(s.reference ?? []).length > 0 && (
                <div className="pt-1 text-[11px] text-muted-foreground/80">this quote's costs (already in realized returns, not deducted again):</div>
              )}
              {(s.reference ?? []).map((row: SurvivalRow, i: number) => (
                <div key={`rf-${i}`} className="flex justify-between text-[11px] font-mono tabular-nums text-muted-foreground/80" title={row.note}>
                  <span>&nbsp;&nbsp;{row.label}</span>
                  <span>{row.pct.toFixed(1)}%</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground leading-snug">{s.note}</p>
          </div>
        )}

        {!r && !sizeMut.isPending && (
          <p className="text-xs text-muted-foreground" data-testid="text-sizer-empty">
            risk-floor + Kelly cap + conviction tier — most conservative wins. now also runs the net-EV waterfall: does the edge survive spread, slippage, and theta?
          </p>
        )}
      </CardContent>
    </Card>
  );
}
