// PositionSizer — risk-first contract sizer for banger trades.
// Plug in account size, entry, stop, grade → get contracts, $risk, Kelly fraction.
// API: POST /api/position-sizer

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
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
  bindingConstraint: "risk-floor" | "kelly-cap" | "conviction-tier" | "min-contract";
  expectedPayoffPct: number;
  rejected: boolean;
  rejectReason?: string;
  reasoning: string[];
}

function fmtDollar(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function PositionSizer() {
  const [accountSize, setAccountSize] = useState("25000");
  const [maxRiskPct, setMaxRiskPct] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [gradeScore, setGradeScore] = useState("85");
  const [targetPct, setTargetPct] = useState("50");
  const [kellyFraction, setKellyFraction] = useState("25");

  const sizeMut = useMutation({
    mutationFn: async (): Promise<SizingResult> => {
      const res = await apiRequest("POST", "/api/position-sizer", {
        accountSize: Number(accountSize),
        maxRiskPct: Number(maxRiskPct) / 100,
        entryPrice: Number(entryPrice),
        stopPrice: Number(stopPrice),
        gradeScore: Number(gradeScore),
        targetPct: Number(targetPct),
        kellyFraction: Number(kellyFraction) / 100,
      });
      return await res.json();
    },
  });

  const r = sizeMut.data;

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
            <span className="text-xs text-muted-foreground">entry price ($)</span>
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
            <span className="text-xs text-muted-foreground">stop price ($)</span>
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
          <div className="flex items-end">
            <Button
              onClick={() => sizeMut.mutate()}
              disabled={sizeMut.isPending}
              size="sm"
              className="w-full"
              data-testid="button-calculate-size"
            >
              {sizeMut.isPending ? "..." : "size it"}
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
                    {fmtDollar(r.riskDollars)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">notional</div>
                  <div className="text-lg font-semibold" data-testid="text-notional">
                    {fmtDollar(r.notionalDollars)}
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

        {!r && !sizeMut.isPending && (
          <p className="text-xs text-muted-foreground" data-testid="text-sizer-empty">
            risk-floor + Kelly cap + conviction tier — most conservative wins
          </p>
        )}
      </CardContent>
    </Card>
  );
}
