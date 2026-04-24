// client/src/components/ConstellationPulse.tsx
// Regime pulse strip — derives at-a-glance regime context from sector-web data.
// Sits above the Correlation Constellation in SectorWeb.
//
// Panels:
//   1. Regime label (Risk-On / Risk-Off / Rotation / Defensive / Mixed)
//      derived from breadth + cyclical-vs-defensive leadership.
//   2. Correlation dispersion gauge — tight (everything moves together, fragile)
//      vs dispersed (dislocation/rotation opportunity).
//   3. Top 3 strongest correlation pairs (most coupled sectors this period).
//   4. Top 3 SPY decouplers (sectors with lowest absolute RS-correlation via
//      proxy — we use |rs1w| outlier magnitude).
//
// All math is client-side off the existing /api/sector-web response — no
// backend changes needed.

import { useMemo } from "react";
import type { SectorWebResponse, SectorEdge } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, Link2, Unlink, Gauge as GaugeIcon } from "lucide-react";

// Short sector labels
const SEC_LABEL: Record<string, string> = {
  tech: "Tech",
  comm: "Comm",
  disc: "Disc",
  stap: "Staples",
  fin: "Financials",
  hlth: "Health",
  ind: "Industrials",
  enrg: "Energy",
  util: "Utilities",
  mat: "Materials",
  reit: "REITs",
};

// Risk-on sectors (cyclical / growth). Risk-off (defensive).
const RISK_ON = new Set(["tech", "comm", "disc", "fin", "ind", "mat"]);
const RISK_OFF = new Set(["stap", "hlth", "util", "reit"]);

type RegimeTag = "risk-on" | "risk-off" | "rotation" | "defensive" | "mixed";

function classifyRegime(data: SectorWebResponse): {
  tag: RegimeTag;
  label: string;
  tone: string;
  detail: string;
} {
  // Breadth pct (1W)
  const breadthPct = data.breadth.w1 / data.breadth.total;

  // Average RS of risk-on vs risk-off cohorts
  let onSum = 0, onN = 0, offSum = 0, offN = 0;
  for (const s of data.sectors) {
    if (RISK_ON.has(s.id)) { onSum += s.rs1w; onN += 1; }
    if (RISK_OFF.has(s.id)) { offSum += s.rs1w; offN += 1; }
  }
  const onAvg = onN ? onSum / onN : 0;
  const offAvg = offN ? offSum / offN : 0;
  const spread = onAvg - offAvg; // positive → risk-on leading

  let tag: RegimeTag;
  let label: string;
  let tone: string;
  let detail: string;

  if (breadthPct >= 0.6 && spread > 0.5) {
    tag = "risk-on";
    label = "Risk-On";
    tone = "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    detail = `Cyclicals +${onAvg.toFixed(1)}% vs defensives ${offAvg.toFixed(1)}% · broad breadth`;
  } else if (breadthPct <= 0.35 && spread < -0.5) {
    tag = "risk-off";
    label = "Risk-Off";
    tone = "border-red-500/40 bg-red-500/10 text-red-300";
    detail = `Defensives +${offAvg.toFixed(1)}% vs cyclicals ${onAvg.toFixed(1)}% · thin breadth`;
  } else if (offAvg > 0.5 && onAvg < 0.5 && spread < 0) {
    tag = "defensive";
    label = "Defensive Tilt";
    tone = "border-sky-500/40 bg-sky-500/10 text-sky-300";
    detail = `Staples/Health/Utilities/REITs bidding, cyclicals lagging`;
  } else if (Math.abs(spread) < 0.4 && (breadthPct > 0.45 && breadthPct < 0.65)) {
    tag = "rotation";
    label = "Rotation";
    tone = "border-amber-500/40 bg-amber-500/10 text-amber-300";
    detail = `Leadership churning — risk-on/off spread near zero, breadth balanced`;
  } else {
    tag = "mixed";
    label = "Mixed";
    tone = "border-zinc-500/40 bg-zinc-500/10 text-zinc-300";
    detail = `No single narrative dominant · spread ${spread.toFixed(2)}pp`;
  }

  return { tag, label, tone, detail };
}

// Correlation dispersion: std-dev of the edge correlations. Tight bundle → low dispersion (fragile);
// spread-out → high dispersion (healthy rotation / dislocation).
function correlationDispersion(edges: SectorEdge[]): {
  mean: number;
  std: number;
  pct: number; // 0-100 where 100 = tight/everything-moves-together
  label: string;
  tone: string;
} {
  if (!edges.length) {
    return { mean: 0, std: 0, pct: 0, label: "No data", tone: "text-muted-foreground" };
  }
  const n = edges.length;
  const mean = edges.reduce((a, e) => a + e.corr, 0) / n;
  const variance = edges.reduce((a, e) => a + (e.corr - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  // pct: use abs(mean) as a proxy for bundling — |mean| near 1 means everything moves the same direction.
  const pct = Math.max(0, Math.min(100, Math.abs(mean) * 100));

  let label: string;
  let tone: string;
  if (pct >= 70) {
    label = "Tight bundle · fragile";
    tone = "text-amber-300";
  } else if (pct >= 50) {
    label = "Coupled · normal";
    tone = "text-emerald-300";
  } else if (pct >= 30) {
    label = "Dispersed · rotation";
    tone = "text-sky-300";
  } else {
    label = "Dislocated · unusual";
    tone = "text-red-300";
  }
  return { mean, std, pct, label, tone };
}

// Top N strongest edges by |corr|, formatted as sector pairs
function topEdges(data: SectorWebResponse, n = 3): Array<{
  a: string; b: string; corr: number;
}> {
  const sectorIds = new Set(data.sectors.map((s) => s.id));
  const ssEdges = data.edges.filter(
    (e) => sectorIds.has(e.source) && sectorIds.has(e.target),
  );
  const sorted = [...ssEdges].sort(
    (a, b) => Math.abs(b.corr) - Math.abs(a.corr),
  );
  return sorted.slice(0, n).map((e) => ({
    a: SEC_LABEL[e.source] ?? e.source,
    b: SEC_LABEL[e.target] ?? e.target,
    corr: e.corr,
  }));
}

// Decouplers: sectors with |rs1w| highest magnitude (strongest signal vs SPY)
function topDecouplers(data: SectorWebResponse, n = 3): Array<{
  id: string; label: string; rs: number;
}> {
  const ranked = [...data.sectors].sort(
    (a, b) => Math.abs(b.rs1w) - Math.abs(a.rs1w),
  );
  return ranked.slice(0, n).map((s) => ({
    id: s.id,
    label: SEC_LABEL[s.id] ?? s.id,
    rs: s.rs1w,
  }));
}

export default function ConstellationPulse({
  data,
}: {
  data: SectorWebResponse;
}) {
  const regime = useMemo(() => classifyRegime(data), [data]);
  const disp = useMemo(() => correlationDispersion(data.edges), [data.edges]);
  const pairs = useMemo(() => topEdges(data, 3), [data]);
  const decouplers = useMemo(() => topDecouplers(data, 3), [data]);

  return (
    <Card className="overflow-hidden" data-testid="constellation-pulse">
      <CardContent className="p-4 md:p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {/* Regime label */}
          <div className="md:border-r md:border-border/60 md:pr-4">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <Activity className="h-3 w-3" />
              Regime
            </div>
            <div
              className={`mt-1.5 inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold ${regime.tone}`}
              data-testid="pulse-regime-tag"
            >
              {regime.label}
            </div>
            <div
              className="mt-1.5 text-[11px] leading-snug text-muted-foreground"
              data-testid="pulse-regime-detail"
            >
              {regime.detail}
            </div>
          </div>

          {/* Dispersion gauge */}
          <div className="md:border-r md:border-border/60 md:pr-4">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <GaugeIcon className="h-3 w-3" />
              Correlation
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span
                className="font-mono text-base font-semibold text-foreground"
                data-testid="pulse-corr-mean"
              >
                {disp.mean >= 0 ? "+" : ""}
                {disp.mean.toFixed(2)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                σ {disp.std.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-border/50">
              <div
                className="h-1.5 rounded-full bg-primary transition-all"
                style={{ width: `${disp.pct}%` }}
              />
            </div>
            <div
              className={`mt-1 text-[11px] font-medium ${disp.tone}`}
              data-testid="pulse-corr-label"
            >
              {disp.label}
            </div>
          </div>

          {/* Strongest pairs */}
          <div className="md:border-r md:border-border/60 md:pr-4">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <Link2 className="h-3 w-3" />
              Tightest Pairs
            </div>
            <ul className="mt-1.5 space-y-0.5" data-testid="pulse-pairs">
              {pairs.length === 0 && (
                <li className="text-[11px] text-muted-foreground">No edges</li>
              )}
              {pairs.map((p, i) => (
                <li
                  key={`${p.a}-${p.b}-${i}`}
                  className="flex items-center justify-between text-[11px]"
                >
                  <span className="text-foreground/90">
                    {p.a} <span className="text-muted-foreground">·</span> {p.b}
                  </span>
                  <span
                    className={`font-mono font-semibold ${
                      p.corr >= 0 ? "text-emerald-300" : "text-red-300"
                    }`}
                  >
                    {p.corr >= 0 ? "+" : ""}
                    {p.corr.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Decouplers */}
          <div>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <Unlink className="h-3 w-3" />
              Biggest Movers vs SPY (1W)
            </div>
            <ul className="mt-1.5 space-y-0.5" data-testid="pulse-decouplers">
              {decouplers.length === 0 && (
                <li className="text-[11px] text-muted-foreground">No data</li>
              )}
              {decouplers.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between text-[11px]"
                >
                  <span className="text-foreground/90">{d.label}</span>
                  <span
                    className={`font-mono font-semibold ${
                      d.rs >= 0 ? "text-emerald-300" : "text-red-300"
                    }`}
                  >
                    {d.rs >= 0 ? "+" : ""}
                    {d.rs.toFixed(2)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
