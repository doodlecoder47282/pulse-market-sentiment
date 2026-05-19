// client/src/components/SectorWeb.tsx
// Reactive sector web — a D3-force-simulated constellation of the 11 GICS
// sectors (SPY at center, sector ETFs orbiting, their top leaders as
// satellites), plus correlation edges between sectors.
//
// Interactions:
//   • CLICK any node  →  jump to Chart tab with that ticker loaded
//     (shift+click / meta+click: focus only — isolate neighbors, stay here)
//   • CLICK in empty space  →  release focus
//   • DRAG any node     →  reposition
//   • Scroll wheel      →  zoom in/out
//   • DRAG background   →  pan
//   • Window toggle 1D/1W/1M → ripple pulse from SPY, color tween
//
// Below the graph, a dense heatmap grid shows every sector + every leader in
// a scannable tile layout. Every cell is clickable → chart tab.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Network, Grid3x3, AlertTriangle, Waves, Maximize2, MousePointerClick } from "lucide-react";
import * as d3 from "d3-force";
import type { SectorWebResponse, SectorNode, LeaderNode, SectorEdge, SectorGridRow } from "@shared/schema";
import { useTickers } from "./TickerContext";
import ConstellationPulse from "./ConstellationPulse";

type WindowKey = "r1d" | "r1w" | "r1m";
const WINDOW_LABEL: Record<WindowKey, string> = { r1d: "1D", r1w: "1W", r1m: "1M" };

// ----- Node descriptions (for hover cards) -----
// Short "what is this / why it matters" blurbs. For sectors we describe the
// GICS group + what drives it; for leaders we describe the company and its
// role in the sector.
const SECTOR_DESC: Record<string, string> = {
  tech: "Information Technology — software, semis, hardware. High-beta growth sleeve. Drivers: real rates, capex cycles, AI spend.",
  comm: "Communication Services — interactive media, telcos, entertainment. Ad-spend + subscriber growth sensitive.",
  disc: "Consumer Discretionary — autos, retail, travel, leisure. Cyclical; levered to jobs, wages, consumer confidence.",
  stap: "Consumer Staples — food, beverage, household, tobacco. Defensive, low-beta; bond-proxy in risk-off.",
  fin: "Financials — banks, insurers, card networks, brokers. Driven by yield curve, credit spreads, M&A activity.",
  hlth: "Health Care — pharma, biotech, devices, payers. Defensive but policy-sensitive (drug pricing, Medicare rules).",
  ind: "Industrials — machinery, aerospace, logistics. Cyclical; read-through to PMIs, capex, freight rates.",
  enrg: "Energy — oil & gas E&P, refiners, services. Inverse correlation to duration; driven by crude/nat-gas spot.",
  util: "Utilities — regulated power, water, renewables. Bond-proxy; moves opposite real yields. AI-demand story.",
  mat: "Materials — chemicals, metals, miners, paper/pulp. China-growth + global PMI leverage.",
  reit: "Real Estate — REITs. Long-duration; inverse to 10Y real yields. Sub-sector mix matters (office vs data center).",
};

const LEADER_DESC: Record<string, string> = {
  // Tech
  AAPL: "Apple — iPhone + Services flywheel, ~$3.5T mcap. Drives XLK, S&P 500, and the Mag-7 basket.",
  MSFT: "Microsoft — Azure + M365 + OpenAI stake. Largest AI capex name; weight anchor for tech.",
  NVDA: "NVIDIA — AI accelerator monopoly. Single stock that moves the whole market on earnings.",
  AVGO: "Broadcom — custom AI silicon (ASICs) + VMware software. Second-largest AI datacenter beneficiary.",
  ORCL: "Oracle — cloud infra pivot + AI training contracts. Late-cycle AI capex beneficiary.",
  CRM: "Salesforce — enterprise SaaS + Data Cloud. Software demand bellwether.",
  ADBE: "Adobe — creative + document cloud. AI-substitution risk tape.",
  // Comm
  META: "Meta Platforms — FB+IG ad engine, Reality Labs, Llama AI. Ad-spend + AI capex.",
  GOOGL: "Alphabet — Search + YouTube + Cloud + Gemini. Ad duopoly with regulatory overhang.",
  NFLX: "Netflix — streaming leader, ad-tier + password crackdown driving subs/ARPU.",
  TMUS: "T-Mobile US — wireless, 5G leader. Defensive comm leader.",
  DIS: "Disney — parks + streaming + ESPN. Secular transition + activist overhang.",
  CMCSA: "Comcast — cable, broadband, NBCU. Cord-cutting headwind.",
  // Disc
  AMZN: "Amazon — AWS + retail + ads. AI capex beneficiary; margin leverage story.",
  TSLA: "Tesla — EVs + FSD/robotaxi + energy. High-beta, narrative-driven.",
  HD: "Home Depot — home improvement. Housing-turnover + rates-sensitive.",
  MCD: "McDonald's — QSR, global consumer read-through. Value-menu pricing matters.",
  LOW: "Lowe's — home improvement #2 to HD. DIY vs pro mix.",
  NKE: "Nike — apparel/footwear. China exposure + innovation cycles.",
  SBUX: "Starbucks — coffee, China optionality, domestic labor story.",
  // Staples
  COST: "Costco — warehouse club, membership-fee flywheel. Premium defensive.",
  WMT: "Walmart — retail giant, Walmart+ ads, grocery dominance.",
  PG: "Procter & Gamble — household goods bellwether. Pricing power tape.",
  KO: "Coca-Cola — global beverages. FX-sensitive defensive.",
  PEP: "PepsiCo — beverages + Frito-Lay snacks. Staples compounder.",
  PM: "Philip Morris — international tobacco + IQOS. Defensive dividend.",
  MDLZ: "Mondelēz — global snacks. Cocoa cost + EM exposure.",
  // Fin
  JPM: "JPMorgan Chase — largest US bank. NII + trading + IB. Proxy for banks.",
  "BRK-B": "Berkshire Hathaway — Buffett conglomerate. Cash-rich, insurance + equity book.",
  V: "Visa — payments network. Consumer-spend proxy.",
  MA: "Mastercard — payments #2. Same drivers as V.",
  BAC: "Bank of America — rate-sensitive super-regional.",
  WFC: "Wells Fargo — balance-sheet bank in turnaround.",
  GS: "Goldman Sachs — IB, trading, AWM. M&A + capital-markets gauge.",
  // Health
  LLY: "Eli Lilly — GLP-1 leader (Mounjaro/Zepbound). Obesity-drug tape.",
  UNH: "UnitedHealth — largest insurer + Optum services. Payer tape.",
  JNJ: "Johnson & Johnson — pharma + devices post-Kenvue.",
  ABBV: "AbbVie — immunology (Humira follow-ons), oncology.",
  MRK: "Merck — Keytruda oncology franchise + vaccines.",
  TMO: "Thermo Fisher — life-science tools. Biotech-capex sensitive.",
  ABT: "Abbott — med devices + diagnostics.",
  // Industrials
  GE: "GE Aerospace — jet engines + services. Airline-capex leverage.",
  CAT: "Caterpillar — construction/mining equipment. Global PMI proxy.",
  RTX: "RTX (Raytheon) — defense + commercial aero. Geopolitics + GTF fix.",
  HON: "Honeywell — diversified industrial + aero.",
  UBER: "Uber — rideshare + delivery. Profitability inflection.",
  UNP: "Union Pacific — Class I rail. Freight volume proxy.",
  ETN: "Eaton — electrical equipment. Datacenter + grid capex.",
  // Energy
  XOM: "ExxonMobil — integrated oil major. Crude + Permian + Pioneer.",
  CVX: "Chevron — integrated major. Hess deal + Permian growth.",
  COP: "ConocoPhillips — pure E&P. Upstream leverage to crude.",
  SLB: "Schlumberger — oilfield services leader. Intl drilling activity.",
  EOG: "EOG Resources — top-quartile US shale E&P.",
  PSX: "Phillips 66 — refining + midstream. Crack-spread leverage.",
  // Utilities
  NEE: "NextEra Energy — regulated FPL + renewables pipeline.",
  SO: "Southern Company — southeast regulated utility + Vogtle nuclear.",
  DUK: "Duke Energy — large regulated utility.",
  CEG: "Constellation Energy — #1 nuclear fleet. AI-datacenter PPA winner.",
  VST: "Vistra — merchant power + nuclear. Peak AI-power name.",
  AEP: "American Electric Power — regulated T&D, PJM exposure.",
  // Materials
  LIN: "Linde — industrial gases monopoly. Defensive growth compounder.",
  SHW: "Sherwin-Williams — paint/coatings. Housing-cycle beta.",
  APD: "Air Products — industrial gases #2. Hydrogen capex overhang.",
  ECL: "Ecolab — water/hygiene specialty chems.",
  FCX: "Freeport-McMoRan — copper leader. China + electrification tape.",
  NEM: "Newmont — largest gold miner. Bullion + cost-curve leverage.",
  MP: "MP Materials — US rare earths. Critical-minerals policy tape.",
  // REITs
  PLD: "Prologis — industrial REIT #1. E-com + nearshoring.",
  AMT: "American Tower — cell towers + data centers.",
  EQIX: "Equinix — datacenter REIT. AI-demand beneficiary.",
  WELL: "Welltower — senior housing REIT. Demographics tailwind.",
  SPG: "Simon Property — premium mall REIT.",
  O: "Realty Income — monthly-dividend net-lease REIT.",
  // Market
  SPY: "SPDR S&P 500 — the broad market. All cross-sector correlations are measured relative to this.",
};

// ----- Color math -----
// RS heat: yellow → green for outperformers, yellow → red for underperformers.
// Used at 1W / 1M horizons where relative strength vs SPY is the meaningful signal.
function heatColor(rs: number, opacity = 1): string {
  const clamp = Math.max(-4, Math.min(4, rs));
  if (clamp >= 0) {
    const t = clamp / 4;
    const h = 45 + t * (142 - 45);
    const s = 90 - t * 19;
    const l = 55 - t * 10;
    return `hsla(${h}, ${s}%, ${l}%, ${opacity})`;
  } else {
    const t = -clamp / 4;
    const h = 45 - t * 45;
    const s = 90;
    const l = 55;
    return `hsla(${h}, ${s}%, ${l}%, ${opacity})`;
  }
}

// Pure day-change color: red if down today, green if up today, intensity scaled by magnitude.
// Used at the 1D window so a glance at the board immediately tells you red/green tape.
function dayChangeColor(r1d: number, opacity = 1): string {
  const clamp = Math.max(-5, Math.min(5, r1d));
  if (clamp >= 0) {
    // Green: 142° (mint) at 0 → 142° (deep emerald) at +5%
    const t = clamp / 5;
    const l = 58 - t * 18;       // 58% → 40% (more saturated as it climbs)
    const s = 55 + t * 30;       // 55% → 85%
    return `hsla(142, ${s}%, ${l}%, ${opacity})`;
  } else {
    // Red: 6° (warm coral) at 0 → 0° (deep crimson) at -5%
    const t = -clamp / 5;
    const h = 6 - t * 6;
    const l = 58 - t * 18;
    const s = 60 + t * 30;
    return `hsla(${h}, ${s}%, ${l}%, ${opacity})`;
  }
}

// ----- Main component -----

export default function SectorWeb() {
  const [winKey, setWinKey] = useState<WindowKey>("r1w");
  const { data, isLoading, isError, error } = useQuery<SectorWebResponse>({
    queryKey: ["/api/sector-web"],
    queryFn: async () => apiRequest("GET", "/api/sector-web").then((r) => r.json()),
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <SectorWebSkeleton />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm font-medium">Sector web unavailable</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {(error as Error)?.message ?? "Could not build the reactive sector web."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="sector-web">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Reactive Sector Web</div>
          <div className="mt-1 text-sm text-muted-foreground">
            11 GICS sectors · {data.leaders.length} leaders · {data.edges.length} correlation links
          </div>
        </div>
        <div className="flex items-center gap-3">
          <BreadthPill breadth={data.breadth} />
          <div className="flex items-center gap-1 rounded-md border border-border bg-card/50 p-1">
            {(["r1d", "r1w", "r1m"] as WindowKey[]).map((w) => (
              <Button
                key={w}
                variant={winKey === w ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setWinKey(w)}
                data-testid={`button-sweb-${w}`}
              >
                {WINDOW_LABEL[w]}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <ConstellationPulse data={data} />

      <Card className="overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Network className="h-4 w-4" />
            Correlation Constellation
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ForceGraph data={data} winKey={winKey} />
          <div className="flex items-center gap-4 border-t border-border/60 px-5 py-2.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <MousePointerClick className="h-3 w-3" />
              <strong>Click</strong> = chart · <kbd className="rounded border px-1">Shift</kbd>+click = isolate
            </span>
            <span className="hidden md:inline">· Drag to move · Scroll to zoom · Drag bg to pan</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Grid3x3 className="h-4 w-4" />
            Full Sector Heatmap · {WINDOW_LABEL[winKey]} relative strength vs SPY
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SectorHeatmap grid={data.grid} winKey={winKey} spy={data.spy} />
        </CardContent>
      </Card>
    </div>
  );
}

// ----- Breadth pill -----

function BreadthPill({ breadth }: { breadth: { w1: number; m1: number; total: number } }) {
  const pct1w = Math.round((breadth.w1 / breadth.total) * 100);
  const tone = pct1w >= 70 ? "bull" : pct1w <= 30 ? "bear" : "neutral";
  const cls = tone === "bull"
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
    : tone === "bear"
    ? "border-red-500/40 bg-red-500/10 text-red-300"
    : "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return (
    <div className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${cls}`}>
      <Waves className="h-3 w-3" />
      <span className="font-mono">{breadth.w1}/{breadth.total} sectors &gt; SPY · 1W</span>
      <span className="opacity-60">·</span>
      <span className="font-mono opacity-80">1M: {breadth.m1}/{breadth.total}</span>
    </div>
  );
}

// ----- Force graph -----

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  kind: "market" | "sector" | "leader";
  symbol: string;
  name: string;
  sectorId?: string;
  hue: number;
  rs: number;
  r: number;
  size: number;
  heat: string;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  corr: number;
  kind: "ss" | "sl";
}

const W = 900;
const H = 520;

function ForceGraph({ data, winKey }: { data: SectorWebResponse; winKey: WindowKey }) {
  const { focusChart } = useTickers();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<SimNode | null>(null);
  const [, setTick] = useState(0);

  // Focus + isolate
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Zoom + pan transform
  const [zoom, setZoom] = useState<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 });

  // Regime pulse — ripple from SPY when winKey changes
  const [rippleKey, setRippleKey] = useState(0);
  const prevWinRef = useRef<WindowKey>(winKey);
  useEffect(() => {
    if (prevWinRef.current !== winKey) {
      setRippleKey((k) => k + 1);
      prevWinRef.current = winKey;
    }
  }, [winKey]);

  // Build nodes+links — memoized so the simulation survives re-renders.
  const { nodes, links } = useMemo(() => {
    const winRsKey = winKey === "r1d" ? "rs1d" : winKey === "r1w" ? "rs1w" : "rs1m";

    const spyNode: SimNode = {
      id: "spy",
      kind: "market",
      symbol: "SPY",
      name: "S&P 500",
      hue: 0,
      rs: 0,
      r: data.spy[winKey],
      size: 26,
      heat: "hsl(220, 20%, 70%)",
      fx: W / 2, fy: H / 2,
    };

    // Coloring rule: 1D window = pure red/green by absolute day return;
    // 1W/1M = relative strength vs SPY (yellow-green outperform, yellow-red underperform).
    const useDayColor = winKey === "r1d";

    const sectorSim: SimNode[] = data.sectors.map((s: SectorNode) => {
      const rs = (s as any)[winRsKey] as number;
      const r = s[winKey];
      const size = 14 + Math.min(14, Math.abs(rs) * 3.5);
      return {
        id: s.id,
        kind: "sector",
        symbol: s.symbol,
        name: s.name,
        hue: s.hue,
        rs,
        r,
        size,
        heat: useDayColor ? dayChangeColor(r) : heatColor(rs),
      };
    });

    const leaderSim: SimNode[] = data.leaders.map((l: LeaderNode) => {
      const rs = (l as any)[winRsKey] as number;
      const r = l[winKey];
      const size = 5 + Math.min(9, Math.abs(rs) * 1.6);
      return {
        id: l.id,
        kind: "leader",
        symbol: l.symbol,
        sectorId: l.sectorId,
        name: l.name,
        hue: l.hue,
        rs,
        r,
        size,
        heat: useDayColor ? dayChangeColor(r, 0.92) : heatColor(rs, 0.9),
      };
    });

    const ns = [spyNode, ...sectorSim, ...leaderSim];

    const ls: SimLink[] = [];
    for (const e of data.edges as SectorEdge[]) {
      ls.push({ source: e.source, target: e.target, corr: e.corr, kind: "ss" });
    }
    for (const l of leaderSim) {
      ls.push({ source: l.sectorId!, target: l.id, corr: 0.95, kind: "sl" });
    }
    return { nodes: ns, links: ls };
  }, [data, winKey]);

  // Neighbor map for focus/isolate
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of nodes) m.set(n.id, new Set([n.id]));
    for (const l of links) {
      const a = typeof l.source === "object" ? (l.source as SimNode).id : (l.source as string);
      const b = typeof l.target === "object" ? (l.target as SimNode).id : (l.target as string);
      m.get(a)?.add(b);
      m.get(b)?.add(a);
    }
    return m;
  }, [nodes, links]);

  // Run the simulation headlessly to settle, then PIN every node so the
  // constellation is rock-steady. Drag still overrides fx/fy on its node.
  // A new simulation runs whenever nodes/links change (window flip).
  //
  // Layout rebuild: sectors live on a ring around SPY (forceRadial), leaders
  // hug their sector tight (short SL link distance + strong link force),
  // sector-to-sector charges weaker so no orphaning to corners. Center
  // gravity stronger to prevent dead space.
  useEffect(() => {
    const ringR = Math.min(W, H) * 0.36;
    const sim = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3.forceLink<SimNode, SimLink>(links)
          .id((n) => n.id)
          .distance((l) => l.kind === "sl" ? 28 : 90 * (1 - Math.abs(l.corr) * 0.4))
          .strength((l) => l.kind === "sl" ? 1.0 : Math.min(0.8, Math.abs(l.corr) * 0.9)),
      )
      .force(
        "charge",
        d3.forceManyBody<SimNode>().strength((n) =>
          n.kind === "leader" ? -28 : n.kind === "sector" ? -220 : -120,
        ),
      )
      .force("center", d3.forceCenter(W / 2, H / 2).strength(0.12))
      // Sectors pinned to a ring around SPY — kills the orphan-corner problem.
      .force(
        "radial",
        d3.forceRadial<SimNode>(
          (n) => (n.kind === "sector" ? ringR : 0),
          W / 2,
          H / 2,
        ).strength((n) => (n.kind === "sector" ? 0.55 : 0)),
      )
      .force("collide", d3.forceCollide<SimNode>().radius((n) => n.size + (n.kind === "leader" ? 2 : 6)))
      .stop();  // don't auto-tick on RAF

    // Run 400 ticks synchronously — enough to settle layout. Clamp every
    // node inside the viewport on each tick so leaders don't fly off-canvas.
    const N = 400;
    const padX = 24, padY = 24;
    for (let i = 0; i < N; i++) {
      sim.tick();
      for (const n of nodes) {
        if (n.kind === "market") continue;
        const r = n.size + 2;
        if (n.x != null) n.x = Math.max(padX + r, Math.min(W - padX - r, n.x));
        if (n.y != null) n.y = Math.max(padY + r, Math.min(H - padY - r, n.y));
      }
    }

    // Freeze: pin every node at its settled position. The layout is now
    // permanent until nodes/links change (window flip triggers re-layout).
    for (const n of nodes) {
      if (n.kind !== "market" && n.x != null && n.y != null) {
        n.fx = n.x;
        n.fy = n.y;
      }
    }
    setTick((t) => t + 1);
    return () => { sim.stop(); };
  }, [nodes, links]);

  // ---- Drag (nodes) + pan (background) ----
  const drag = useRef<{ mode: "none" | "node" | "pan"; node: SimNode | null; startX: number; startY: number; startZoomX: number; startZoomY: number; moved: boolean }>({
    mode: "none", node: null, startX: 0, startY: 0, startZoomX: 0, startZoomY: 0, moved: false,
  });

  // Map client coords → SVG viewBox coords (accounting for current zoom/pan)
  const toSvg = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const vbX = ((clientX - rect.left) / rect.width) * W;
    const vbY = ((clientY - rect.top) / rect.height) * H;
    // Account for <g> transform: translate(zoom.x, zoom.y) scale(zoom.k)
    return { x: (vbX - zoom.x) / zoom.k, y: (vbY - zoom.y) / zoom.k };
  };

  const onNodeDown = (e: React.MouseEvent, n: SimNode) => {
    e.stopPropagation();
    drag.current = {
      mode: "node", node: n,
      startX: e.clientX, startY: e.clientY,
      startZoomX: 0, startZoomY: 0, moved: false,
    };
    n.fx = n.x; n.fy = n.y;
  };

  const onSvgDown = (e: React.MouseEvent<SVGSVGElement>) => {
    // Only start panning if we're clicking empty background (not a node)
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = {
      mode: "pan", node: null,
      startX: e.clientX, startY: e.clientY,
      startZoomX: zoom.x, startZoomY: zoom.y, moved: false,
    };
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d.mode === "none") return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;

    if (d.mode === "node" && d.node) {
      const { x, y } = toSvg(e.clientX, e.clientY);
      d.node.fx = x; d.node.fy = y;
      setTick((t) => t + 1);
    } else if (d.mode === "pan") {
      const rect = svgRef.current!.getBoundingClientRect();
      // Convert clientX/Y delta to viewBox units
      const vbDx = (dx / rect.width) * W;
      const vbDy = (dy / rect.height) * H;
      setZoom((z) => ({ ...z, x: d.startZoomX + vbDx, y: d.startZoomY + vbDy }));
    }
  };

  const onUp = (e: React.MouseEvent<SVGSVGElement>) => {
    const d = drag.current;
    const wasClick = !d.moved;

    if (d.mode === "node" && d.node) {
      // Keep the node pinned at its new (dragged) position. The whole
      // constellation is pinned — we don't release to the simulation.
      if (d.node.kind !== "market" && d.node.x != null && d.node.y != null) {
        d.node.fx = d.node.x;
        d.node.fy = d.node.y;
      }
      // A true click (no drag) = either focus (shift) or navigate (plain)
      if (wasClick) {
        if (e.shiftKey || e.metaKey) {
          setFocusedId((cur) => (cur === d.node!.id ? null : d.node!.id));
        } else if (d.node.kind !== "market") {
          focusChart(d.node.symbol);
        }
      }
    } else if (d.mode === "pan" && wasClick) {
      // Click on empty background = release focus
      setFocusedId(null);
    }
    drag.current = { mode: "none", node: null, startX: 0, startY: 0, startZoomX: 0, startZoomY: 0, moved: false };
  };

  // Wheel zoom — anchored to cursor
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = svgRef.current!.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    const vbY = ((e.clientY - rect.top) / rect.height) * H;

    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom((z) => {
      const newK = Math.max(0.4, Math.min(4, z.k * factor));
      // Keep cursor-anchored: pre = (vbX - z.x) / z.k, want pre == (vbX - newX) / newK
      const newX = vbX - ((vbX - z.x) / z.k) * newK;
      const newY = vbY - ((vbY - z.y) / z.k) * newK;
      return { k: newK, x: newX, y: newY };
    });
  };

  const resetView = () => setZoom({ k: 1, x: 0, y: 0 });

  // Breathing pulse for hot RS nodes
  const pulse = Math.sin((Date.now() / 1000) * 1.8) * 0.5 + 0.5;

  // Which nodes are highlighted vs dimmed under focus
  const focusSet = focusedId ? neighbors.get(focusedId) : null;
  const isDim = (n: SimNode) => (focusSet ? !focusSet.has(n.id) : false);
  const linkDim = (l: SimLink) => {
    if (!focusedId) return false;
    const a = typeof l.source === "object" ? (l.source as SimNode).id : (l.source as string);
    const b = typeof l.target === "object" ? (l.target as SimNode).id : (l.target as string);
    return !(a === focusedId || b === focusedId);
  };

  // ── Immersive cosmos background — procedural starfield + grid + nebulae ─────
  // Generated once per component mount (seeded by W/H) so stars don't twinkle
  // randomly on every render. Stars cluster around center; far stars dim and
  // small, near stars bright and large. Three nebula blooms add depth.
  const stars = useMemo(() => {
    const arr: Array<{ cx: number; cy: number; r: number; o: number; hue: number }> = [];
    // Deterministic PRNG so the field is stable across re-renders
    let s = 1337;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let i = 0; i < 220; i++) {
      const cx = rand() * W;
      const cy = rand() * H;
      // Bias size: most stars small, a few bright
      const z = rand();
      const r = z < 0.85 ? 0.5 + rand() * 0.8 : 1.2 + rand() * 1.6;
      const o = z < 0.85 ? 0.25 + rand() * 0.35 : 0.55 + rand() * 0.4;
      // Hue: mostly cool white, occasional cyan/purple flash
      const h = rand() < 0.15 ? (rand() < 0.5 ? 195 : 270) : 220;
      arr.push({ cx, cy, r, o, hue: h });
    }
    return arr;
  }, []);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-[520px] w-full touch-none select-none"
        onMouseDown={onSvgDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        onWheel={onWheel}
        style={{
          cursor: drag.current.mode === "pan" ? "grabbing" : "default",
          // Layered cosmic background: deep navy base + radial bloom
          background:
            "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(56, 89, 161, 0.18) 0%, rgba(20, 24, 48, 0.4) 40%, rgba(6, 8, 20, 1) 80%)",
        }}
      >
        <defs>
          <radialGradient id="haloGreen" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(16, 185, 129, 0.6)" />
            <stop offset="100%" stopColor="rgba(16, 185, 129, 0)" />
          </radialGradient>
          <radialGradient id="haloRed" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(239, 68, 68, 0.55)" />
            <stop offset="100%" stopColor="rgba(239, 68, 68, 0)" />
          </radialGradient>
          <radialGradient id="rippleGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(125, 211, 252, 0.0)" />
            <stop offset="70%" stopColor="rgba(125, 211, 252, 0.35)" />
            <stop offset="100%" stopColor="rgba(125, 211, 252, 0)" />
          </radialGradient>
          <radialGradient id="nebulaPurple" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(147, 51, 234, 0.18)" />
            <stop offset="100%" stopColor="rgba(147, 51, 234, 0)" />
          </radialGradient>
          <radialGradient id="nebulaCyan" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34, 211, 238, 0.16)" />
            <stop offset="100%" stopColor="rgba(34, 211, 238, 0)" />
          </radialGradient>
          <pattern id="cosmosGrid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(125, 145, 200, 0.05)" strokeWidth="1" />
          </pattern>
        </defs>

        {/* Background layer — fixed (no zoom/pan) for parallax depth */}
        <g pointerEvents="none">
          <rect x={0} y={0} width={W} height={H} fill="url(#cosmosGrid)" opacity={0.6} />
          <ellipse cx={W * 0.25} cy={H * 0.35} rx={180} ry={120} fill="url(#nebulaPurple)" />
          <ellipse cx={W * 0.78} cy={H * 0.72} rx={220} ry={140} fill="url(#nebulaCyan)" />
          {stars.map((st, i) => (
            <circle
              key={`st-${i}`}
              cx={st.cx}
              cy={st.cy}
              r={st.r}
              fill={`hsl(${st.hue}, 70%, 85%)`}
              opacity={st.o}
            >
              {st.r > 1.2 && (
                <animate
                  attributeName="opacity"
                  values={`${st.o};${Math.max(0.15, st.o - 0.3)};${st.o}`}
                  dur={`${3 + (i % 5)}s`}
                  repeatCount="indefinite"
                />
              )}
            </circle>
          ))}
        </g>

        {/* Zoom+pan group */}
        <g transform={`translate(${zoom.x}, ${zoom.y}) scale(${zoom.k})`}>
          {/* Ripple pulse from SPY on regime change */}
          <circle
            key={`ripple-${rippleKey}`}
            cx={W / 2}
            cy={H / 2}
            r={10}
            fill="url(#rippleGrad)"
            style={{
              animation: `sw-ripple 1.6s ease-out forwards`,
              transformOrigin: `${W / 2}px ${H / 2}px`,
              pointerEvents: "none",
            }}
          />

          {/* Edges */}
          <g>
            {links.map((l, i) => {
              const a = typeof l.source === "object" ? l.source as SimNode : null;
              const b = typeof l.target === "object" ? l.target as SimNode : null;
              if (!a || !b || a.x == null || b.x == null) return null;
              const dim = linkDim(l);
              if (l.kind === "sl") {
                return (
                  <line
                    key={`l${i}`}
                    x1={a.x} y1={a.y!} x2={b.x} y2={b.y!}
                    stroke="rgba(180,180,200,0.14)"
                    strokeWidth={1}
                    opacity={dim ? 0.15 : 1}
                    style={{ transition: "opacity 240ms ease" }}
                  />
                );
              }
              const pos = l.corr >= 0;
              const w = 0.6 + Math.abs(l.corr) * 2.4;
              const opa = 0.15 + Math.abs(l.corr) * 0.45;
              return (
                <line
                  key={`l${i}`}
                  x1={a.x} y1={a.y!}
                  x2={b.x} y2={b.y!}
                  stroke={pos ? `rgba(52, 211, 153, ${opa})` : `rgba(248, 113, 113, ${opa})`}
                  strokeWidth={dim ? w * 0.5 : (focusedId ? w * 1.6 : w)}
                  strokeDasharray={pos ? undefined : "5 3"}
                  opacity={dim ? 0.1 : 1}
                  style={{ transition: "opacity 240ms ease, stroke-width 240ms ease" }}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g>
            {nodes.map((n) => {
              if (n.x == null || n.y == null) return null;
              const hot = Math.abs(n.rs) > 1.5;
              const dimmed = isDim(n);
              const isFocus = focusedId === n.id;
              const pulseR = hot ? n.size * (1.8 + pulse * 0.8) : 0;
              const haloId = n.rs >= 0 ? "haloGreen" : "haloRed";
              return (
                <g
                  key={n.id}
                  data-node
                  transform={`translate(${n.x},${n.y})`}
                  style={{
                    cursor: n.kind === "market" ? "pointer" : "grab",
                    opacity: dimmed ? 0.2 : 1,
                    transition: "opacity 240ms ease",
                  }}
                  onMouseDown={(e) => onNodeDown(e, n)}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                >
                  {hot && n.kind !== "leader" && <circle r={pulseR} fill={`url(#${haloId})`} />}
                  {hot && n.kind === "leader" && <circle r={pulseR * 0.65} fill={`url(#${haloId})`} opacity={0.6} />}
                  {isFocus && (
                    <circle
                      r={n.size + 6}
                      fill="none"
                      stroke="rgba(125, 211, 252, 0.9)"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                    />
                  )}
                  <circle
                    r={n.size}
                    fill={n.kind === "market" ? "rgba(226, 232, 240, 0.95)" : n.heat}
                    stroke={n.kind === "market" ? "rgba(226, 232, 240, 0.5)" : `hsl(${n.hue}, 70%, 70%)`}
                    strokeWidth={n.kind === "leader" ? 0.75 : 1.5}
                    style={{
                      filter: n.kind === "sector"
                        ? `drop-shadow(0 0 ${4 + Math.abs(n.rs) * 2}px ${n.heat})`
                        : undefined,
                      transition: "fill 380ms ease, filter 380ms ease",
                    }}
                  />
                  {/* Progressive label reveal:
                     - SPY + sectors: always labeled.
                     - Leaders: only when hot (|RS|>=1.5), focused, or zoomed in (k>=1.4). */}
                  {(n.kind !== "leader" || hot || isFocus || zoom.k >= 1.4) && (
                    <text
                      textAnchor="middle"
                      y={n.kind === "leader" ? -n.size - 3 : 4}
                      fontSize={n.kind === "market" ? 12 : n.kind === "sector" ? 11 : 9}
                      fontWeight={n.kind === "leader" ? 500 : 700}
                      fill={n.kind === "market" ? "#1e293b"
                        : n.kind === "sector" ? "rgba(15, 23, 42, 0.95)"
                        : "rgba(226, 232, 240, 0.92)"}
                      stroke={n.kind === "leader" ? "rgba(10, 15, 25, 0.85)" : "none"}
                      strokeWidth={n.kind === "leader" ? 2.5 : 0}
                      paintOrder="stroke fill"
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {n.symbol}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>

        {/* Legend (fixed, not zoomed) */}
        <g transform={`translate(${W - 230},${H - 58})`} style={{ pointerEvents: "none" }}>
          <rect x={-6} y={-20} width={228} height={52} rx={6} fill="rgba(10, 15, 25, 0.55)" stroke="rgba(148, 163, 184, 0.2)" />
          <text x={4} y={-6} fontSize={10} fill="rgba(226,232,240,0.8)">Edges: correlation (60d daily)</text>
          <line x1={4} y1={6} x2={34} y2={6} stroke="rgba(52,211,153,0.9)" strokeWidth={2.2} />
          <text x={40} y={9} fontSize={9.5} fill="rgba(226,232,240,0.8)">positive</text>
          <line x1={92} y1={6} x2={122} y2={6} stroke="rgba(248,113,113,0.9)" strokeWidth={2.2} strokeDasharray="5 3" />
          <text x={128} y={9} fontSize={9.5} fill="rgba(226,232,240,0.8)">divergent</text>
          <text x={4} y={24} fontSize={9.5} fill="rgba(226,232,240,0.7)">Leader labels reveal on zoom or |RS|&gt;1.5%</text>
        </g>
      </svg>

      {/* Ripple keyframes — scoped inline */}
      <style>{`
        @keyframes sw-ripple {
          0%   { r: 10;  opacity: 0.9; }
          100% { r: 520; opacity: 0;   }
        }
      `}</style>

      {/* Zoom controls — top-right overlay */}
      <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md border border-border/60 bg-background/75 p-1 backdrop-blur">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-xs"
          onClick={() => setZoom((z) => ({ ...z, k: Math.min(4, z.k * 1.2), x: z.x, y: z.y }))}
          data-testid="button-zoom-in"
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-xs"
          onClick={() => setZoom((z) => ({ ...z, k: Math.max(0.4, z.k / 1.2), x: z.x, y: z.y }))}
          data-testid="button-zoom-out"
          aria-label="Zoom out"
        >
          −
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={resetView}
          data-testid="button-zoom-reset"
          aria-label="Reset zoom"
        >
          <Maximize2 className="h-3 w-3" />
        </Button>
        <span className="px-1 font-mono text-[10px] text-muted-foreground">
          {Math.round(zoom.k * 100)}%
        </span>
      </div>

      {/* Focus banner */}
      {focusedId && (
        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-200 backdrop-blur">
          <span className="font-mono font-semibold">
            {nodes.find((n) => n.id === focusedId)?.symbol}
          </span>
          <span className="opacity-70">isolated</span>
          <button
            className="ml-1 text-cyan-300 hover:text-white"
            onClick={() => setFocusedId(null)}
          >
            ×
          </button>
        </div>
      )}

      {/* Rich description card on hover */}
      {hover && (() => {
        const desc =
          hover.kind === "sector" ? SECTOR_DESC[hover.id]
          : hover.kind === "leader" ? LEADER_DESC[hover.symbol]
          : LEADER_DESC["SPY"];
        const kindLabel =
          hover.kind === "market" ? "Benchmark ETF"
          : hover.kind === "sector" ? "GICS Sector ETF"
          : "Sector Leader";
        const parentSector = hover.kind === "leader" && hover.sectorId
          ? data.sectors.find((s) => s.id === hover.sectorId)?.name
          : null;
        return (
          <div
            className="pointer-events-none absolute left-4 bottom-4 max-w-[340px] rounded-lg border border-border/70 bg-popover/95 p-3 text-xs shadow-xl backdrop-blur"
          >
            {/* Header row */}
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: hover.heat, boxShadow: `0 0 8px ${hover.heat}` }}
              />
              <span className="font-mono text-[14px] font-bold tracking-tight">{hover.symbol}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-[11px] font-normal text-muted-foreground">{hover.name}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[9.5px] uppercase tracking-wider text-muted-foreground">
              <span>{kindLabel}</span>
              {parentSector && (<><span>·</span><span>{parentSector}</span></>)}
            </div>

            {/* Description */}
            {desc && (
              <div className="mt-2 border-t border-border/40 pt-2 text-[11.5px] leading-relaxed text-foreground/85">
                {desc}
              </div>
            )}

            {/* Performance grid */}
            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border/40 pt-2">
              <PerfCell label={`Return ${WINDOW_LABEL[winKey]}`} value={hover.r} />
              <PerfCell label="vs SPY" value={hover.rs} />
              <div>
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Hot?</div>
                <div className={`font-mono text-[12px] font-semibold ${Math.abs(hover.rs) > 1.5 ? "text-cyan-300" : "text-muted-foreground"}`}>
                  {Math.abs(hover.rs) > 1.5 ? "● rotation" : "—"}
                </div>
              </div>
            </div>

            {hover.kind !== "market" && (
              <div className="mt-2 border-t border-border/30 pt-1.5 text-[10px] text-cyan-300/80">
                click → load in chart · shift+click → isolate neighbors
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function PerfCell({ label, value }: { label: string; value: number }) {
  const pos = value >= 0;
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-[12px] font-semibold ${pos ? "text-emerald-400" : "text-red-400"}`}>
        {pos ? "+" : ""}{value.toFixed(2)}%
      </div>
    </div>
  );
}

// ----- Heatmap grid -----

function SectorHeatmap({ grid, winKey, spy }: { grid: SectorGridRow[]; winKey: WindowKey; spy: SectorNode }) {
  const { focusChart } = useTickers();
  const winRsKey = winKey === "r1d" ? "rs1d" : winKey === "r1w" ? "rs1w" : "rs1m";
  const sorted = [...grid].sort((a, b) => (b as any)[winRsKey] - (a as any)[winRsKey]);

  return (
    <div className="space-y-2">
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">
          SPY {WINDOW_LABEL[winKey]}: <span className={spy[winKey] >= 0 ? "text-emerald-400" : "text-red-400"}>{spy[winKey] >= 0 ? "+" : ""}{spy[winKey].toFixed(2)}%</span>
        </span>
        <span className="text-muted-foreground">Click any ticker → chart tab</span>
      </div>
      {sorted.map((row) => {
        const rowRs = (row as any)[winRsKey] as number;
        const rowR = (row as any)[winKey] as number;
        return (
          <div
            key={row.sectorId}
            className="flex flex-col gap-1 rounded-md border border-border/40 bg-card/30 p-2 md:flex-row md:items-center"
          >
            <button
              className="flex w-full items-center gap-3 rounded px-3 py-2 text-left transition hover:ring-1 hover:ring-cyan-500/50 md:w-56 md:shrink-0"
              style={{
                background: `linear-gradient(90deg, ${heatColor(rowRs, 0.18)}, transparent 80%)`,
                borderLeft: `3px solid hsl(${row.hue}, 70%, 55%)`,
              }}
              onClick={() => focusChart(row.etf, row.sectorName)}
              data-testid={`heatmap-sector-${row.etf}`}
              title={`Chart ${row.etf} — ${row.sectorName}`}
            >
              <div className="flex-1">
                <div className="text-[13px] font-semibold">{row.sectorName}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{row.etf}</div>
              </div>
              <div className="text-right">
                <div className={`font-mono text-sm font-semibold ${rowR >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {rowR >= 0 ? "+" : ""}{rowR.toFixed(2)}%
                </div>
                <div className={`font-mono text-[10px] ${rowRs >= 0 ? "text-emerald-500/80" : "text-red-500/80"}`}>
                  RS {rowRs >= 0 ? "+" : ""}{rowRs.toFixed(2)}
                </div>
              </div>
            </button>
            <div className="grid flex-1 grid-cols-4 gap-1.5 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8">
              {row.leaders.map((l) => {
                const lRs = (l as any)[winRsKey] as number;
                const lR = (l as any)[winKey] as number;
                return (
                  <button
                    key={l.id}
                    className="flex flex-col items-center rounded px-1.5 py-1 transition hover:scale-105 hover:ring-1 hover:ring-cyan-500/60"
                    style={{
                      background: heatColor(lRs, 0.22),
                      borderBottom: `2px solid ${heatColor(lRs, 0.9)}`,
                    }}
                    title={`Chart ${l.symbol} · ${WINDOW_LABEL[winKey]}: ${lR.toFixed(2)}% · RS ${lRs.toFixed(2)}%`}
                    data-testid={`heatmap-cell-${l.symbol}`}
                    onClick={() => focusChart(l.symbol)}
                  >
                    <span className="font-mono text-[11px] font-semibold leading-tight">{l.symbol}</span>
                    <span className={`font-mono text-[10px] leading-tight ${lR >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                      {lR >= 0 ? "+" : ""}{lR.toFixed(1)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ----- Skeleton -----

function SectorWebSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-[520px] w-full" />
      <Skeleton className="h-[600px] w-full" />
    </div>
  );
}
