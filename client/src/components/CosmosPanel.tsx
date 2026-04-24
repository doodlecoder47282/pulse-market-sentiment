// CosmosPanel.tsx — Cosmos tab for the Pulse Batcave terminal.
//
// Combines the trading-astrology intel brief (static reference content —
// taxonomy, books, academic papers, edge rules) with the live astronomy
// engine in server/cosmos.ts (real-time planetary positions, aspects,
// lunar phase, NOAA Kp, natal-chart transits). Every taxonomy entry gets
// a live "lit" state so the static doc doubles as a real-time indicator.
//
// Design language is lifted from trading_astrology_intel_brief.html:
// gold/blue/green accents on near-black, Georgia serif body, monospace
// labels, tier badges, signal rows with weight indicators.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ─── Types (mirror server/cosmos.ts) ────────────────────────────────────────
type CosmosResponse = {
  snapshot: {
    generatedAt: string;
    positions: Array<{
      id: string; label: string; glyph: string; sign: string; signGlyph: string;
      degInSign: number; longitude: number; retrograde: boolean; speed: number;
    }>;
    aspects: Array<{
      a: string; b: string; aspect: string; angle: number; orb: number;
      applying: boolean; quality: string; score: number;
    }>;
    lunarPhase: { name: string; illumination: number; angle: number };
    voidOfCourse: { active: boolean; nextSignAt?: string; nextSign?: string };
    bradley: { value: number; trend: "rising" | "falling"; zone: "high" | "low" | "neutral" };
    financialSignals: Array<{ id: string; severity: "high" | "medium" | "low"; headline: string; detail: string }>;
    zodiacReadings: Array<{ sign: string; glyph: string; element: string; tone: string; reading: string; rulingPlanet: string }>;
    natalTransits: Array<{
      symbol: string; natalName: string; score: number;
      aspects: Array<{ transitingPlanet: string; aspect: string; natalPlanet: string; orb: number; applying: boolean }>;
    }>;
    dailyBriefMarkdown: string;
  };
  kp: {
    fetchedAt: string; current: number | null; max24h: number | null;
    stormActive: boolean; recent: Array<{ time: string; kp: number }>;
    forecast: Array<{ time: string; kp: number }>; error?: string;
  } | null;
  taxonomy: Array<{
    id: string; name: string; category: "planetary" | "lunar" | "solar_geomag" | "cycle_gann";
    tags: string[]; description: string; weight: string;
  }>;
  taxonomyLive: Record<string, {
    id: string; active: boolean; strength: number;
    currentValue?: string; badge?: string;
  }>;
  books: Array<{ title: string; authors: string; publisher: string; tier: 1 | 2 | 3; tags: string[]; summary: string; score?: number }>;
  papers: Array<{ title: string; source: string; finding: string; badge: string; category: "fed" | "university" }>;
  rules: Array<{ id: string; title: string; color: "gold" | "blue" | "green"; body: string }>;
  honestEdge: string;
};

type SubTab = "live" | "taxonomy" | "academic" | "edge" | "books";

type OutlookEvent = {
  date: string;
  dayOffset: number;
  type: string;
  headline: string;
  detail: string;
  severity: "high" | "medium" | "low";
  bias: "bullish" | "bearish" | "neutral" | "volatile";
};

type OutlookHorizon = {
  horizon: "weekly" | "monthly";
  startDate: string;
  endDate: string;
  events: OutlookEvent[];
  netBias: "bullish" | "bearish" | "mixed" | "neutral";
  keyDates: string[];
  markdown: string;
  claude: string | null;
  gpt: string | null;
  errors: { claude: string | null; gpt: string | null };
};

type OutlookResponse = {
  weekly: OutlookHorizon;
  monthly: OutlookHorizon;
  meta: {
    llmEnhancersEnabled: { claude: boolean; gpt: boolean };
    generatedAt: string;
  };
};

// ─── Palette tokens (match intel brief HTML) ────────────────────────────────
const ACCENT_GOLD = "#c8a96e";
const ACCENT_BLUE = "#7eb8d4";
const ACCENT_GREEN = "#6ec8a0";
const ACCENT_DANGER = "#d46e6e";
const MUTED = "#8a8a9a";
const TEXT = "#e8e4dc";
const BG2 = "rgba(20, 20, 24, 0.6)";
const BG3 = "rgba(26, 26, 32, 0.8)";
const BORDER_COL = "rgba(42, 42, 53, 0.8)";

// ─── Solar-system SVG diagram ───────────────────────────────────────────────
// Real planetary longitudes placed on orbital rings. Scaled so outer planets
// fit without distortion. Saturn+Uranus+Neptune+Pluto use log-ish compression.
function SolarSystemDiagram({ positions }: { positions: CosmosResponse["snapshot"]["positions"] }) {
  const size = 560;
  const cx = size / 2;
  const cy = size / 2;

  // Orbital radii in px. Tuned to fit nicely. Earth is invisible (we're
  // geocentric) but Sun sits at cx,cy.
  const RINGS: Record<string, { r: number; color: string; size: number }> = {
    moon:    { r:  45, color: "#d8d8d8", size: 5 },
    mercury: { r:  75, color: "#b8b0a0", size: 5 },
    venus:   { r: 105, color: "#e8c178", size: 7 },
    sun:     { r:   0, color: "#ffcc4a", size: 14 }, // center
    mars:    { r: 145, color: "#cc6a4a", size: 6 },
    jupiter: { r: 190, color: "#d8b878", size: 11 },
    saturn:  { r: 225, color: "#c8a074", size: 10 },
    uranus:  { r: 250, color: "#78c0d0", size: 8 },
    neptune: { r: 268, color: "#4a78c8", size: 8 },
    pluto:   { r: 282, color: "#a88078", size: 5 },
  };

  const glyphs: Record<string, string> = {
    sun: "☉", moon: "☽", mercury: "☿", venus: "♀", mars: "♂",
    jupiter: "♃", saturn: "♄", uranus: "♅", neptune: "♆", pluto: "♇",
  };

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-auto" style={{ background: "radial-gradient(circle at center, #0d0d12 0%, #050507 100%)" }}>
      <defs>
        <radialGradient id="sunGlow">
          <stop offset="0%" stopColor="#ffeaa0" stopOpacity="1" />
          <stop offset="40%" stopColor="#ffcc4a" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#ff8800" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Zodiac rim with sign divisions */}
      <circle cx={cx} cy={cy} r={size / 2 - 8} fill="none" stroke={BORDER_COL} strokeWidth="1" />
      {Array.from({ length: 12 }).map((_, i) => {
        const ang = (i * 30 - 90) * (Math.PI / 180);
        const x1 = cx + Math.cos(ang) * (size / 2 - 20);
        const y1 = cy + Math.sin(ang) * (size / 2 - 20);
        const x2 = cx + Math.cos(ang) * (size / 2 - 8);
        const y2 = cy + Math.sin(ang) * (size / 2 - 8);
        const tx = cx + Math.cos(ang + (15 * Math.PI / 180)) * (size / 2 - 14);
        const ty = cy + Math.sin(ang + (15 * Math.PI / 180)) * (size / 2 - 14);
        const signs = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={BORDER_COL} strokeWidth="0.5" />
            <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle" fontSize="11" fill={MUTED}>{signs[i]}</text>
          </g>
        );
      })}

      {/* Orbital rings */}
      {Object.entries(RINGS).filter(([id]) => id !== "sun").map(([id, ring]) => (
        <circle key={id} cx={cx} cy={cy} r={ring.r} fill="none" stroke={BORDER_COL} strokeWidth="0.5" strokeDasharray="2 4" />
      ))}

      {/* Sun glow */}
      <circle cx={cx} cy={cy} r={34} fill="url(#sunGlow)" />

      {/* Planets */}
      {positions.map((p) => {
        const ring = RINGS[p.id];
        if (!ring) return null;
        // Astronomical convention: 0° = Aries (east), counterclockwise. We
        // draw with SVG y-axis inverted, so use sin/-cos.
        const lon = p.longitude;
        const ang = (lon - 90) * (Math.PI / 180); // rotate so 0° Aries is at 3 o'clock
        const x = cx + Math.cos(ang) * ring.r;
        const y = cy + Math.sin(ang) * ring.r;
        return (
          <g key={p.id}>
            <circle cx={x} cy={y} r={ring.size} fill={ring.color} opacity={p.retrograde ? 0.6 : 1} stroke={p.retrograde ? ACCENT_DANGER : "none"} strokeWidth="1.5" />
            <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle" fontSize={ring.size + 4} fill="#0d0d12" fontWeight="bold">{glyphs[p.id]}</text>
            {p.retrograde && (
              <text x={x + ring.size + 3} y={y - ring.size - 1} fontSize="8" fill={ACCENT_DANGER} fontFamily="monospace">℞</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────
export default function CosmosPanel() {
  const [tab, setTab] = useState<SubTab>("live");

  const { data, isLoading, error } = useQuery<CosmosResponse>({
    queryKey: ["/api/cosmos"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/cosmos");
      return res.json();
    },
    refetchInterval: 5 * 60_000, // 5 minutes
    staleTime: 60_000,
  });

  return (
    <div className="cosmos-panel" style={{ fontFamily: "Georgia, 'Times New Roman', serif", color: TEXT, lineHeight: 1.65 }}>
      <style>{`
        .cosmos-panel .cm-title { font-family: Georgia, serif; font-size: 20px; color: ${ACCENT_GOLD}; letter-spacing: 0.04em; }
        .cosmos-panel .cm-stamp { font-family: monospace; font-size: 11px; color: ${MUTED}; border: 1px solid ${BORDER_COL}; padding: 2px 8px; border-radius: 3px; }
        .cosmos-panel .cm-subtitle { font-size: 12px; color: ${MUTED}; font-style: italic; }
        .cosmos-panel .cm-section-label { font-family: monospace; font-size: 10px; letter-spacing: 0.12em; color: ${MUTED}; text-transform: uppercase; }
        .cosmos-panel .cm-card { background: ${BG2}; border: 1px solid ${BORDER_COL}; border-radius: 4px; }
        .cosmos-panel .cm-card-title { font-size: 13px; font-weight: bold; color: ${ACCENT_GOLD}; font-family: monospace; }
        .cosmos-panel .cm-card-meta { font-size: 11px; color: ${MUTED}; font-family: monospace; }
        .cosmos-panel .cm-tag { display: inline-block; font-size: 10px; font-family: monospace; padding: 2px 7px; border-radius: 2px; margin: 2px 3px 0 0; background: rgba(30, 30, 40, 0.8); color: ${ACCENT_BLUE}; border: 1px solid ${BORDER_COL}; }
        .cosmos-panel .cm-tag.gold { color: ${ACCENT_GOLD}; border-color: ${ACCENT_GOLD}; }
        .cosmos-panel .cm-tag.green { color: ${ACCENT_GREEN}; border-color: ${ACCENT_GREEN}; }
        .cosmos-panel .cm-tag.red { color: ${ACCENT_DANGER}; border-color: ${ACCENT_DANGER}; }
        .cosmos-panel .cm-tier { display: inline-block; font-size: 10px; font-family: monospace; padding: 1px 8px; margin-left: 8px; border-radius: 2px; }
        .cosmos-panel .cm-tier-1 { background: rgba(200,169,110,0.12); color: ${ACCENT_GOLD}; border: 1px solid rgba(200,169,110,0.3); }
        .cosmos-panel .cm-tier-2 { background: rgba(126,184,212,0.12); color: ${ACCENT_BLUE}; border: 1px solid rgba(126,184,212,0.3); }
        .cosmos-panel .cm-tier-3 { background: rgba(110,200,160,0.12); color: ${ACCENT_GREEN}; border: 1px solid rgba(110,200,160,0.3); }
        .cosmos-panel .cm-signal-row { display: grid; grid-template-columns: 200px 1fr 120px; gap: 12px; align-items: start; padding: 0.7rem 0; border-bottom: 1px solid ${BORDER_COL}; }
        .cosmos-panel .cm-signal-row:last-child { border-bottom: none; }
        .cosmos-panel .cm-signal-row.active { background: rgba(200,169,110,0.05); margin: 0 -1rem; padding-left: 1rem; padding-right: 1rem; box-shadow: inset 3px 0 0 ${ACCENT_GOLD}; }
        .cosmos-panel .cm-signal-name { font-family: monospace; font-size: 12px; color: ${ACCENT_GOLD}; font-weight: bold; }
        .cosmos-panel .cm-signal-desc { font-size: 12px; color: ${TEXT}; }
        .cosmos-panel .cm-signal-weight { font-family: monospace; font-size: 10px; text-align: right; }
        .cosmos-panel .cm-weight-hi { color: ${ACCENT_GREEN}; }
        .cosmos-panel .cm-weight-med { color: ${ACCENT_GOLD}; }
        .cosmos-panel .cm-weight-lo { color: ${MUTED}; }
        .cosmos-panel .cm-edge-block { background: ${BG3}; border-left: 3px solid ${ACCENT_GOLD}; padding: 0.9rem 1rem; border-radius: 0 4px 4px 0; }
        .cosmos-panel .cm-edge-block.blue { border-left-color: ${ACCENT_BLUE}; }
        .cosmos-panel .cm-edge-block.green { border-left-color: ${ACCENT_GREEN}; }
        .cosmos-panel .cm-edge-title { font-family: monospace; font-size: 11px; color: ${ACCENT_GOLD}; letter-spacing: 0.08em; }
        .cosmos-panel .cm-edge-title.blue { color: ${ACCENT_BLUE}; }
        .cosmos-panel .cm-edge-title.green { color: ${ACCENT_GREEN}; }
        .cosmos-panel .cm-stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .cosmos-panel .cm-stat { background: ${BG2}; border: 1px solid ${BORDER_COL}; border-radius: 4px; padding: 0.8rem; text-align: center; }
        .cosmos-panel .cm-stat-val { font-family: monospace; font-size: 20px; color: ${ACCENT_GOLD}; font-weight: bold; }
        .cosmos-panel .cm-stat-label { font-size: 10px; color: ${MUTED}; font-family: monospace; margin-top: 2px; }
        .cosmos-panel .cm-sub-tab { padding: 8px 18px; font-size: 12px; font-family: monospace; letter-spacing: 0.06em; color: ${MUTED}; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; transition: all 0.15s; background: transparent; border-top: none; border-left: none; border-right: none; }
        .cosmos-panel .cm-sub-tab:hover { color: ${TEXT}; }
        .cosmos-panel .cm-sub-tab.active { color: ${ACCENT_GOLD}; border-bottom-color: ${ACCENT_GOLD}; }
        .cosmos-panel .cm-academic-row { padding: 0.7rem 0; border-bottom: 1px solid ${BORDER_COL}; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; }
        .cosmos-panel .cm-academic-row:last-child { border-bottom: none; }
        .cosmos-panel .cm-academic-title { font-size: 12.5px; color: ${TEXT}; font-weight: 500; }
        .cosmos-panel .cm-academic-source { font-family: monospace; font-size: 10px; color: ${ACCENT_BLUE}; margin-top: 2px; }
        .cosmos-panel .cm-academic-finding { font-size: 11.5px; color: ${MUTED}; margin-top: 4px; font-style: italic; }
        .cosmos-panel .cm-badge { font-family: monospace; font-size: 10px; padding: 2px 6px; border-radius: 2px; white-space: nowrap; }
        .cosmos-panel .cm-badge-fed { background: rgba(126,184,212,0.12); color: ${ACCENT_BLUE}; border: 1px solid rgba(126,184,212,0.3); }
        .cosmos-panel .cm-badge-uni { background: rgba(110,200,160,0.12); color: ${ACCENT_GREEN}; border: 1px solid rgba(110,200,160,0.3); }
        .cosmos-panel .cm-badge-wiley { background: rgba(200,169,110,0.12); color: ${ACCENT_GOLD}; border: 1px solid rgba(200,169,110,0.3); }
        .cosmos-panel .cm-warn { background: rgba(212,110,110,0.06); border: 1px solid rgba(212,110,110,0.25); border-radius: 4px; padding: 0.9rem 1rem; }
        .cosmos-panel .cm-warn-title { font-family: monospace; font-size: 10px; color: ${ACCENT_DANGER}; letter-spacing: 0.1em; }
        .cosmos-panel .cm-bar { height: 4px; border-radius: 2px; background: ${BORDER_COL}; overflow: hidden; }
        .cosmos-panel .cm-bar-fill { height: 4px; background: ${ACCENT_GOLD}; }
        .cosmos-panel .cm-active-pulse { animation: cm-pulse 2.5s ease-in-out infinite; }
        @keyframes cm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.65; } }
        @media (max-width: 640px) {
          .cosmos-panel .cm-signal-row { grid-template-columns: 1fr; }
          .cosmos-panel .cm-signal-weight { text-align: left; }
          .cosmos-panel .cm-stat-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* ── Header ── */}
      <div className="flex items-baseline justify-between gap-4 flex-wrap pb-5 mb-5 border-b" style={{ borderColor: BORDER_COL }}>
        <div>
          <div className="cm-title">COSMOS — MARKET ASTROLOGY &amp; SKY SIGNALS</div>
          <div className="cm-subtitle mt-1.5">Live planetary engine · intel brief · academic research · edge extraction framework</div>
        </div>
        <div className="cm-stamp">
          {data ? new Date(data.snapshot.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).toUpperCase() : "LOADING"}
        </div>
      </div>

      {/* ── Sub-tabs ── */}
      <div className="flex gap-0 border-b mb-6 overflow-x-auto" style={{ borderColor: BORDER_COL }}>
        {([
          { id: "live", label: "LIVE SKY" },
          { id: "taxonomy", label: "SIGNAL TAXONOMY" },
          { id: "academic", label: "ACADEMIC RESEARCH" },
          { id: "books", label: "BOOKS & SOURCES" },
          { id: "edge", label: "EDGE EXTRACTION" },
        ] as Array<{ id: SubTab; label: string }>).map((t) => (
          <button
            key={t.id}
            data-testid={`cosmos-tab-${t.id}`}
            className={cn("cm-sub-tab", tab === t.id && "active")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error && !data && (
        <Card className="cm-card">
          <CardContent className="p-6">
            <div className="text-sm" style={{ color: ACCENT_DANGER }}>Failed to load cosmos data. {(error as Error).message}</div>
          </CardContent>
        </Card>
      )}

      {data && tab === "live" && <LiveSkyTab data={data} />}
      {data && tab === "taxonomy" && <TaxonomyTab data={data} />}
      {data && tab === "academic" && <AcademicTab data={data} />}
      {data && tab === "books" && <BooksTab data={data} />}
      {data && tab === "edge" && <EdgeTab data={data} />}
    </div>
  );
}

// ─── LIVE SKY — real-time planetary engine ──────────────────────────────────
// ─── AI OUTLOOK — weekly + monthly forward astro narrative ────────────────
function OutlookPanel() {
  const { data, isLoading, error } = useQuery<OutlookResponse>({
    queryKey: ["/api/cosmos/outlook"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/cosmos/outlook");
      return r.json();
    },
    staleTime: 60 * 60 * 1000, // 1h — astro events don't move fast
  });
  const [horizon, setHorizon] = useState<"weekly" | "monthly">("weekly");
  const [source, setSource] = useState<"deterministic" | "claude" | "gpt">("deterministic");

  if (isLoading) {
    return (
      <Card className="cm-card">
        <CardContent className="p-5">
          <Skeleton className="h-5 w-40 mb-3" />
          <Skeleton className="h-3 w-full mb-2" />
          <Skeleton className="h-3 w-5/6 mb-2" />
          <Skeleton className="h-3 w-4/6" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="cm-card">
        <CardContent className="p-5 text-sm" style={{ color: ACCENT_DANGER }}>
          Could not load outlook. {(error as Error | undefined)?.message ?? ""}
        </CardContent>
      </Card>
    );
  }

  const active = data[horizon];
  const biasColor =
    active.netBias === "bullish" ? ACCENT_GREEN
    : active.netBias === "bearish" ? ACCENT_DANGER
    : active.netBias === "mixed" ? ACCENT_GOLD
    : MUTED;

  // Pick body content based on source toggle
  const bodyText =
    source === "claude" ? active.claude
    : source === "gpt" ? active.gpt
    : active.markdown;

  const claudeAvailable = !!active.claude;
  const gptAvailable = !!active.gpt;

  const startFmt = new Date(active.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endFmt = new Date(active.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const highCount = active.events.filter((e) => e.severity === "high").length;
  const medCount = active.events.filter((e) => e.severity === "medium").length;

  return (
    <Card className="cm-card" data-testid="cosmos-outlook-panel" style={{ borderColor: biasColor, borderWidth: 1, borderStyle: "solid", boxShadow: `0 0 24px ${biasColor}22` }}>
      <CardContent className="p-0">
        {/* Header bar */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b flex-wrap" style={{ borderColor: BORDER_COL, background: BG3 }}>
          <div className="flex items-center gap-3 flex-wrap">
            <div style={{ fontFamily: "monospace", fontSize: 11, color: ACCENT_GOLD, letterSpacing: "0.08em" }}>AI MARKET OUTLOOK</div>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: MUTED }}>{startFmt} → {endFmt}</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              data-testid="outlook-horizon-weekly"
              onClick={() => setHorizon("weekly")}
              style={{
                padding: "4px 12px", fontSize: 10, fontFamily: "monospace", letterSpacing: "0.06em",
                background: horizon === "weekly" ? `${ACCENT_GOLD}22` : "transparent",
                color: horizon === "weekly" ? ACCENT_GOLD : MUTED,
                border: `1px solid ${horizon === "weekly" ? ACCENT_GOLD : BORDER_COL}`,
                borderRadius: 2, cursor: "pointer",
              }}
            >
              WEEKLY
            </button>
            <button
              data-testid="outlook-horizon-monthly"
              onClick={() => setHorizon("monthly")}
              style={{
                padding: "4px 12px", fontSize: 10, fontFamily: "monospace", letterSpacing: "0.06em",
                background: horizon === "monthly" ? `${ACCENT_GOLD}22` : "transparent",
                color: horizon === "monthly" ? ACCENT_GOLD : MUTED,
                border: `1px solid ${horizon === "monthly" ? ACCENT_GOLD : BORDER_COL}`,
                borderRadius: 2, cursor: "pointer",
              }}
            >
              MONTHLY
            </button>
          </div>
        </div>

        {/* Bias strip + stats */}
        <div className="flex items-center justify-between gap-4 px-5 py-3 border-b flex-wrap" style={{ borderColor: BORDER_COL }}>
          <div className="flex items-center gap-6 flex-wrap">
            <div>
              <div style={{ fontFamily: "monospace", fontSize: 9, color: MUTED, letterSpacing: "0.08em" }}>NET BIAS</div>
              <div style={{ fontFamily: "monospace", fontSize: 15, color: biasColor, fontWeight: "bold", letterSpacing: "0.04em" }}>
                {active.netBias.toUpperCase()}
              </div>
            </div>
            <div>
              <div style={{ fontFamily: "monospace", fontSize: 9, color: MUTED, letterSpacing: "0.08em" }}>KEY DATES</div>
              <div style={{ fontFamily: "monospace", fontSize: 15, color: ACCENT_GOLD, fontWeight: "bold" }}>{highCount}</div>
            </div>
            <div>
              <div style={{ fontFamily: "monospace", fontSize: 9, color: MUTED, letterSpacing: "0.08em" }}>SECONDARY</div>
              <div style={{ fontFamily: "monospace", fontSize: 15, color: ACCENT_BLUE, fontWeight: "bold" }}>{medCount}</div>
            </div>
          </div>
          {/* Source toggle */}
          <div className="flex items-center gap-1">
            <button
              data-testid="outlook-source-deterministic"
              onClick={() => setSource("deterministic")}
              title="Rule-based astro calculation"
              style={{
                padding: "3px 10px", fontSize: 9, fontFamily: "monospace", letterSpacing: "0.06em",
                background: source === "deterministic" ? `${ACCENT_GOLD}22` : "transparent",
                color: source === "deterministic" ? ACCENT_GOLD : MUTED,
                border: `1px solid ${source === "deterministic" ? ACCENT_GOLD : BORDER_COL}`,
                borderRadius: 2, cursor: "pointer",
              }}
            >
              ENGINE
            </button>
            <button
              data-testid="outlook-source-claude"
              onClick={() => claudeAvailable && setSource("claude")}
              disabled={!claudeAvailable}
              title={claudeAvailable ? "Claude Sonnet narrative" : "ANTHROPIC_API_KEY not configured"}
              style={{
                padding: "3px 10px", fontSize: 9, fontFamily: "monospace", letterSpacing: "0.06em",
                background: source === "claude" ? `${ACCENT_GREEN}22` : "transparent",
                color: !claudeAvailable ? "#444" : source === "claude" ? ACCENT_GREEN : MUTED,
                border: `1px solid ${source === "claude" ? ACCENT_GREEN : BORDER_COL}`,
                borderRadius: 2, cursor: claudeAvailable ? "pointer" : "not-allowed",
                opacity: claudeAvailable ? 1 : 0.4,
              }}
            >
              CLAUDE
            </button>
            <button
              data-testid="outlook-source-gpt"
              onClick={() => gptAvailable && setSource("gpt")}
              disabled={!gptAvailable}
              title={gptAvailable ? "GPT-5 narrative" : "OPENAI_API_KEY not configured"}
              style={{
                padding: "3px 10px", fontSize: 9, fontFamily: "monospace", letterSpacing: "0.06em",
                background: source === "gpt" ? `${ACCENT_BLUE}22` : "transparent",
                color: !gptAvailable ? "#444" : source === "gpt" ? ACCENT_BLUE : MUTED,
                border: `1px solid ${source === "gpt" ? ACCENT_BLUE : BORDER_COL}`,
                borderRadius: 2, cursor: gptAvailable ? "pointer" : "not-allowed",
                opacity: gptAvailable ? 1 : 0.4,
              }}
            >
              GPT
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4" style={{ fontFamily: "Georgia, serif", fontSize: 13, lineHeight: 1.65, color: TEXT, maxHeight: 380, overflowY: "auto" }}>
          <OutlookMarkdown text={bodyText ?? active.markdown} />
        </div>

        {/* Footer note if LLM unavailable */}
        {!claudeAvailable && !gptAvailable && (
          <div className="px-5 py-2 border-t text-center" style={{ borderColor: BORDER_COL, fontSize: 9, fontFamily: "monospace", color: MUTED, letterSpacing: "0.06em" }}>
            LLM NARRATIVE LOCKED — SET ANTHROPIC_API_KEY OR OPENAI_API_KEY TO ENABLE CLAUDE/GPT TABS
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Lightweight markdown-to-styled renderer for outlook body
function OutlookMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div>
      {lines.map((ln, i) => {
        if (ln.startsWith("## ")) {
          return <div key={i} style={{ fontFamily: "monospace", fontSize: 12, color: ACCENT_GOLD, letterSpacing: "0.08em", margin: "8px 0 6px", fontWeight: "bold" }}>{ln.slice(3)}</div>;
        }
        if (ln.startsWith("### ")) {
          return <div key={i} style={{ fontFamily: "monospace", fontSize: 11, color: ACCENT_BLUE, letterSpacing: "0.06em", margin: "10px 0 4px", fontWeight: "bold" }}>{ln.slice(4)}</div>;
        }
        if (ln.startsWith("- ")) {
          return <div key={i} style={{ marginLeft: 6, paddingLeft: 8, position: "relative", margin: "3px 0 3px 6px" }}><span style={{ color: ACCENT_GOLD, marginRight: 6 }}>•</span><span dangerouslySetInnerHTML={{ __html: mdInline(ln.slice(2)) }} /></div>;
        }
        if (ln === "---") {
          return <hr key={i} style={{ border: "none", borderTop: `1px solid ${BORDER_COL}`, margin: "8px 0" }} />;
        }
        if (ln.trim() === "") {
          return <div key={i} style={{ height: 6 }} />;
        }
        if (ln.startsWith("*") && ln.endsWith("*") && !ln.startsWith("**")) {
          return <div key={i} style={{ fontSize: 11, color: MUTED, fontStyle: "italic", marginTop: 6 }}>{ln.slice(1, -1)}</div>;
        }
        return <div key={i} style={{ margin: "3px 0" }} dangerouslySetInnerHTML={{ __html: mdInline(ln) }} />;
      })}
    </div>
  );
}

function mdInline(s: string): string {
  // bold + escape minimal
  const escaped = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\*\*([^*]+)\*\*/g, `<strong style="color: ${ACCENT_GOLD}">$1</strong>`);
}

function LiveSkyTab({ data }: { data: CosmosResponse }) {
  const s = data.snapshot;
  const kp = data.kp;

  const topNatal = s.natalTransits.slice(0, 8);
  const topAspects = s.aspects.filter((a) => a.score > 0.4).slice(0, 8);

  return (
    <div className="space-y-6">
      {/* AI Outlook (weekly/monthly) */}
      <OutlookPanel />

      {/* Stat strip */}
      <div className="cm-stat-grid">
        <div className="cm-stat">
          <div className="cm-stat-val">{s.lunarPhase.name}</div>
          <div className="cm-stat-label">{(s.lunarPhase.illumination * 100).toFixed(0)}% illum · Moon in {s.positions.find(p => p.id === "moon")?.sign}</div>
        </div>
        <div className="cm-stat">
          <div className="cm-stat-val" style={{ color: s.bradley.zone === "high" ? ACCENT_DANGER : s.bradley.zone === "low" ? ACCENT_GREEN : ACCENT_GOLD }}>
            {s.bradley.value.toFixed(2)}
          </div>
          <div className="cm-stat-label">Bradley {s.bradley.trend} · {s.bradley.zone} zone</div>
        </div>
        <div className="cm-stat">
          <div className="cm-stat-val" style={{ color: kp?.stormActive ? ACCENT_DANGER : kp?.current != null && kp.current >= 4 ? ACCENT_GOLD : ACCENT_GREEN }}>
            {kp?.current != null ? `Kp ${kp.current.toFixed(1)}` : "—"}
          </div>
          <div className="cm-stat-label">{kp?.stormActive ? `G${Math.max(1, Math.floor((kp.current ?? 5) - 4))} storm active` : kp?.max24h != null ? `max 24h: ${kp.max24h.toFixed(1)}` : "geomagnetic — loading"}</div>
        </div>
      </div>

      {/* Solar system + planet table side by side */}
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <div className="cm-section-label mb-3">Solar System — Geocentric (today)</div>
          <div className="cm-card p-2">
            <SolarSystemDiagram positions={s.positions} />
            <div className="px-2 pb-2 pt-1 text-[10px]" style={{ color: MUTED, fontFamily: "monospace" }}>
              Planets drawn at live ecliptic longitudes. Red outline = retrograde. Zodiac rim shows sign boundaries.
            </div>
          </div>
        </div>
        <div>
          <div className="cm-section-label mb-3">Planet Positions</div>
          <div className="cm-card p-4">
            <table className="w-full" style={{ fontSize: 12 }}>
              <thead>
                <tr style={{ color: MUTED, fontFamily: "monospace", fontSize: 10, textAlign: "left" }}>
                  <th className="pb-2">Planet</th>
                  <th className="pb-2">Sign</th>
                  <th className="pb-2 text-right">Degree</th>
                  <th className="pb-2 text-right">Motion</th>
                </tr>
              </thead>
              <tbody>
                {s.positions.map((p) => (
                  <tr key={p.id} style={{ borderTop: `1px solid ${BORDER_COL}` }}>
                    <td className="py-1.5"><span style={{ color: ACCENT_GOLD, fontSize: 14, marginRight: 6 }}>{p.glyph}</span>{p.label}</td>
                    <td className="py-1.5" style={{ fontFamily: "monospace" }}>{p.signGlyph} {p.sign}</td>
                    <td className="py-1.5 text-right" style={{ fontFamily: "monospace" }}>{p.degInSign.toFixed(1)}°</td>
                    <td className="py-1.5 text-right" style={{ fontFamily: "monospace", color: p.retrograde ? ACCENT_DANGER : MUTED }}>
                      {p.retrograde ? "℞ retro" : "direct"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Void-of-course banner */}
      {s.voidOfCourse.active && (
        <div className="cm-warn">
          <div className="cm-warn-title mb-2">MOON VOID-OF-COURSE</div>
          <div style={{ fontSize: 12.5 }}>
            Moon has completed its last aspect in {s.positions.find(p => p.id === "moon")?.sign} — no new entries until sign change
            {s.voidOfCourse.nextSignAt ? ` at ${new Date(s.voidOfCourse.nextSignAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET` : ""}.
            Traditional rule: close only, do not open.
          </div>
        </div>
      )}

      {/* Major aspects */}
      {topAspects.length > 0 && (
        <div>
          <div className="cm-section-label mb-3">Major Aspects (Today)</div>
          <div className="cm-card p-4">
            {topAspects.map((a, i) => {
              const aPos = s.positions.find(p => p.id === a.a);
              const bPos = s.positions.find(p => p.id === a.b);
              const qualityColor = a.quality === "harmonious" ? ACCENT_GREEN : a.quality === "challenging" ? ACCENT_DANGER : ACCENT_GOLD;
              return (
                <div key={i} className="flex items-center justify-between py-2" style={{ borderTop: i > 0 ? `1px solid ${BORDER_COL}` : "none", fontSize: 12 }}>
                  <div style={{ fontFamily: "monospace" }}>
                    <span style={{ color: ACCENT_GOLD }}>{aPos?.glyph} {a.a}</span>
                    <span style={{ color: qualityColor, margin: "0 8px", fontWeight: 600 }}>{a.aspect}</span>
                    <span style={{ color: ACCENT_GOLD }}>{bPos?.glyph} {a.b}</span>
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: MUTED }}>
                    <span className="mr-3">orb {a.orb.toFixed(1)}°</span>
                    <span style={{ color: qualityColor }}>{a.quality}</span>
                    <span className="ml-3">{a.applying ? "applying" : "separating"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active financial signals */}
      {s.financialSignals.length > 0 && (
        <div>
          <div className="cm-section-label mb-3">Active Market Signals</div>
          <div className="cm-card p-4 space-y-3">
            {s.financialSignals.map((sig, i) => {
              const color = sig.severity === "high" ? ACCENT_DANGER : sig.severity === "medium" ? ACCENT_GOLD : ACCENT_BLUE;
              return (
                <div key={i} style={{ borderLeft: `3px solid ${color}`, paddingLeft: 12 }}>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color, fontWeight: 600, letterSpacing: "0.05em" }}>
                    {sig.severity.toUpperCase()} · {sig.headline}
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 3, color: TEXT }}>{sig.detail}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Natal transits for market tickers */}
      <div>
        <div className="cm-section-label mb-3">Natal Transits — Today's Sky vs. Ticker Birth Charts</div>
        <div className="cm-card p-4">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {topNatal.map((t) => {
              const scoreColor = t.score > 0.3 ? ACCENT_GREEN : t.score < -0.3 ? ACCENT_DANGER : MUTED;
              const disp = t.score > 0.3 ? "supportive" : t.score < -0.3 ? "stressed" : "neutral";
              return (
                <div key={t.symbol} className="p-3 rounded" style={{ background: BG3, border: `1px solid ${BORDER_COL}` }}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span style={{ fontFamily: "monospace", fontSize: 13, color: ACCENT_GOLD, fontWeight: 600 }}>{t.symbol}</span>
                    <span style={{ fontFamily: "monospace", fontSize: 13, color: scoreColor, fontWeight: 600 }}>
                      {t.score > 0 ? "+" : ""}{t.score.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: MUTED, fontFamily: "monospace", marginBottom: 6 }}>{t.natalName} · {disp}</div>
                  {t.aspects.slice(0, 2).map((a, i) => (
                    <div key={i} style={{ fontSize: 10.5, color: MUTED, lineHeight: 1.4 }}>
                      {a.transitingPlanet} {a.aspect} natal {a.natalPlanet}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Zodiac readings */}
      <div>
        <div className="cm-section-label mb-3">Trader Zodiac — Per-Sign Tone Today</div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
          {s.zodiacReadings.map((r) => {
            const toneColor = r.tone === "bullish" ? ACCENT_GREEN : r.tone === "bearish" ? ACCENT_DANGER : r.tone === "volatile" ? ACCENT_GOLD : MUTED;
            return (
              <div key={r.sign} className="cm-card p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span style={{ fontSize: 16, color: ACCENT_GOLD }}>{r.glyph}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 600, color: TEXT }}>{r.sign}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 9, color: toneColor, marginLeft: "auto", textTransform: "uppercase", letterSpacing: "0.08em" }}>{r.tone}</span>
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{r.element} · ruled by {r.rulingPlanet}</div>
                <div style={{ fontSize: 11.5, color: TEXT, lineHeight: 1.5 }}>{r.reading}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* NOAA Kp chart */}
      {kp && (kp.recent.length > 0 || kp.forecast.length > 0) && (
        <div>
          <div className="cm-section-label mb-3">NOAA Kp Index — Past 24h + 3-Day Forecast</div>
          <div className="cm-card p-4">
            <KpStrip recent={kp.recent} forecast={kp.forecast} />
          </div>
        </div>
      )}
    </div>
  );
}

function KpStrip({ recent, forecast }: { recent: Array<{ time: string; kp: number }>; forecast: Array<{ time: string; kp: number }> }) {
  const combined = [
    ...recent.map((r) => ({ ...r, observed: true })),
    ...forecast.map((r) => ({ ...r, observed: false })),
  ];
  if (combined.length === 0) return <div style={{ color: MUTED, fontSize: 11 }}>no data</div>;
  const max = Math.max(9, ...combined.map((c) => c.kp));
  const chartW = 700;
  const chartH = 110;
  const barW = Math.max(2, Math.floor(chartW / combined.length) - 1);
  return (
    <div>
      <svg viewBox={`0 0 ${chartW} ${chartH + 20}`} className="w-full h-auto">
        {/* G1 threshold line at kp=5 */}
        <line x1="0" y1={chartH * (1 - 5 / max)} x2={chartW} y2={chartH * (1 - 5 / max)} stroke={ACCENT_DANGER} strokeDasharray="3 3" strokeWidth="0.5" opacity="0.5" />
        <text x="2" y={chartH * (1 - 5 / max) - 2} fontSize="8" fill={ACCENT_DANGER} fontFamily="monospace">G1 storm threshold</text>
        {combined.map((p, i) => {
          const x = i * (chartW / combined.length);
          const h = (p.kp / max) * chartH;
          const color = p.kp >= 5 ? ACCENT_DANGER : p.kp >= 4 ? ACCENT_GOLD : p.observed ? ACCENT_BLUE : MUTED;
          return <rect key={i} x={x} y={chartH - h} width={barW} height={h} fill={color} opacity={p.observed ? 1 : 0.55} />;
        })}
        {/* Observed/forecast boundary line */}
        {recent.length > 0 && forecast.length > 0 && (() => {
          const x = (recent.length / combined.length) * chartW;
          return <line x1={x} y1="0" x2={x} y2={chartH} stroke={MUTED} strokeDasharray="2 2" strokeWidth="0.5" />;
        })()}
        <text x="2" y={chartH + 14} fontSize="9" fill={MUTED} fontFamily="monospace">24h ago</text>
        <text x={chartW / 2 - 10} y={chartH + 14} fontSize="9" fill={MUTED} fontFamily="monospace">now</text>
        <text x={chartW - 35} y={chartH + 14} fontSize="9" fill={MUTED} fontFamily="monospace">+3 days</text>
      </svg>
      <div className="flex gap-4 text-[10px]" style={{ color: MUTED, fontFamily: "monospace", marginTop: 4 }}>
        <span><span style={{ color: ACCENT_BLUE }}>■</span> observed</span>
        <span><span style={{ color: MUTED }}>■</span> forecast</span>
        <span><span style={{ color: ACCENT_GOLD }}>■</span> elevated (Kp 4)</span>
        <span><span style={{ color: ACCENT_DANGER }}>■</span> storm (Kp ≥ 5)</span>
      </div>
    </div>
  );
}

// ─── SIGNAL TAXONOMY — full-merge with live lighting ────────────────────────
function TaxonomyTab({ data }: { data: CosmosResponse }) {
  const sections: Array<{ key: "planetary" | "lunar" | "solar_geomag" | "cycle_gann"; label: string }> = [
    { key: "planetary", label: "Planetary Signals" },
    { key: "lunar", label: "Lunar Signals" },
    { key: "solar_geomag", label: "Solar & Geomagnetic Signals" },
    { key: "cycle_gann", label: "Time Cycle & Gann Signals" },
  ];

  const weightLabel = (w: string) => {
    if (w === "HIGH" || w === "HIGH_ACADEMIC") return { label: w === "HIGH_ACADEMIC" ? "HIGH ✓" : "HIGH", cls: "cm-weight-hi" };
    if (w === "MEDIUM") return { label: "MEDIUM", cls: "cm-weight-med" };
    if (w === "MACRO") return { label: "MACRO", cls: "cm-weight-lo" };
    if (w === "FILTER") return { label: "FILTER", cls: "cm-weight-lo" };
    if (w === "PROPRIETARY") return { label: "HIGH★", cls: "cm-weight-hi" };
    if (w === "ESOTERIC") return { label: "ESOTERIC", cls: "cm-weight-lo" };
    return { label: w, cls: "cm-weight-lo" };
  };

  return (
    <div className="space-y-6">
      <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>
        Every signal below shows its live state. Rows with a glowing left edge are ACTIVE NOW from the live engine or NOAA feed.
        Use stacked confluence — never a single signal in isolation (see Edge Extraction tab).
      </div>

      {sections.map((section) => {
        const entries = data.taxonomy.filter((t) => t.category === section.key);
        return (
          <div key={section.key}>
            <div className="cm-section-label mb-3">{section.label}</div>
            <div className="cm-card p-4">
              {entries.map((e) => {
                const live = data.taxonomyLive[e.id];
                const wt = weightLabel(e.weight);
                const isActive = live?.active === true;
                return (
                  <div key={e.id} className={cn("cm-signal-row", isActive && "active")} data-testid={`taxonomy-row-${e.id}`}>
                    <div>
                      <div className="cm-signal-name">{e.name}</div>
                      <div className="mt-1">
                        {e.tags.map((tag) => (
                          <span key={tag} className={cn("cm-tag", tag.includes("Bullish") && "green", tag.includes("Bearish") && "red")}>{tag}</span>
                        ))}
                      </div>
                      {live?.currentValue && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          {live.badge && (
                            <span className={cn("cm-tag", isActive && "cm-active-pulse", isActive ? "gold" : "")} style={{ fontWeight: 600 }}>
                              {live.badge}
                            </span>
                          )}
                          <span style={{ fontSize: 10.5, color: MUTED, fontFamily: "monospace" }}>
                            {live.currentValue}
                          </span>
                        </div>
                      )}
                      {live && live.strength > 0 && (
                        <div className="cm-bar mt-2" style={{ width: 160 }}>
                          <div className="cm-bar-fill" style={{ width: `${Math.round(live.strength * 100)}%`, background: isActive ? ACCENT_GOLD : MUTED }} />
                        </div>
                      )}
                    </div>
                    <div className="cm-signal-desc">{e.description}</div>
                    <div className={cn("cm-signal-weight", wt.cls)}>{wt.label}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── ACADEMIC RESEARCH tab ──────────────────────────────────────────────────
function AcademicTab({ data }: { data: CosmosResponse }) {
  const fed = data.papers.filter((p) => p.category === "fed");
  const uni = data.papers.filter((p) => p.category === "university");
  const badgeCls = (b: string) => {
    if (b === "FED ATL") return "cm-badge-fed";
    if (b.startsWith("U MICH")) return "cm-badge-uni";
    if (b.startsWith("SAGE")) return "cm-badge-uni";
    return "cm-badge-wiley";
  };
  return (
    <div className="space-y-6">
      <div className="cm-stat-grid">
        <div className="cm-stat">
          <div className="cm-stat-val">48</div>
          <div className="cm-stat-label">Countries Studied</div>
        </div>
        <div className="cm-stat">
          <div className="cm-stat-val">100yr</div>
          <div className="cm-stat-label">Historical Data</div>
        </div>
        <div className="cm-stat">
          <div className="cm-stat-val">{fed.length}</div>
          <div className="cm-stat-label">Federal Reserve Papers</div>
        </div>
      </div>

      <div>
        <div className="cm-section-label mb-3">Federal Reserve / Central Bank Research</div>
        <div className="cm-card p-4">
          {fed.map((p) => (
            <div key={p.title} className="cm-academic-row">
              <div>
                <div className="cm-academic-title">{p.title}</div>
                <div className="cm-academic-source">{p.source}</div>
                <div className="cm-academic-finding">{p.finding}</div>
              </div>
              <div><span className={cn("cm-badge", badgeCls(p.badge))}>{p.badge}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="cm-section-label mb-3">University &amp; Peer-Reviewed Research</div>
        <div className="cm-card p-4">
          {uni.map((p) => (
            <div key={p.title} className="cm-academic-row">
              <div>
                <div className="cm-academic-title">{p.title}</div>
                <div className="cm-academic-source">{p.source}</div>
                <div className="cm-academic-finding">{p.finding}</div>
              </div>
              <div><span className={cn("cm-badge", badgeCls(p.badge))}>{p.badge}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="cm-section-label mb-3">Journals &amp; Access Points</div>
        <div className="cm-card p-4" style={{ fontSize: 12, lineHeight: 1.9 }}>
          <span className="cm-tag">SSRN.com</span> — all Fed working papers free (search by title above)<br />
          <span className="cm-tag">FRASER StLouisFed</span> — full-text FRB Atlanta working papers, free<br />
          <span className="cm-tag">Wiley Online Library</span> — Pesavento/Lee books + Journal of Finance<br />
          <span className="cm-tag">ResearchGate</span> — most academic papers via request, often free PDF<br />
          <span className="cm-tag">ISFM</span> — International Society for Financial Astrology, practitioner papers<br />
          <span className="cm-tag">Foundation for the Study of Cycles</span> — Mogey's archive, historical cycle research<br />
          <span className="cm-tag">NOAA Space Weather</span> — live Kp index (powers the GMS light in Taxonomy tab)
        </div>
      </div>
    </div>
  );
}

// ─── BOOKS & SOURCES tab ────────────────────────────────────────────────────
function BooksTab({ data }: { data: CosmosResponse }) {
  const tier1 = data.books.filter((b) => b.tier === 1);
  const tier2 = data.books.filter((b) => b.tier === 2);
  const tier3 = data.books.filter((b) => b.tier === 3);

  const Card1 = (b: CosmosResponse["books"][number]) => (
    <div key={b.title} className="cm-card p-4 mb-3">
      <div className="cm-card-title">
        {b.title}
        <span className={cn("cm-tier", b.tier === 1 ? "cm-tier-1" : b.tier === 2 ? "cm-tier-2" : "cm-tier-3")}>TIER {b.tier === 1 ? "I" : b.tier === 2 ? "II" : "III"}</span>
      </div>
      <div className="cm-card-meta mt-1">{b.authors} · {b.publisher}</div>
      <div className="mt-2" style={{ fontSize: 13, lineHeight: 1.6 }}>{b.summary}</div>
      <div className="mt-2">
        {b.tags.map((t) => (
          <span key={t} className={cn("cm-tag", t === "Wiley" && "gold", t === "Original source" && "gold", t === "Best entry point" && "green")}>{t}</span>
        ))}
      </div>
      {b.score != null && (
        <div className="cm-bar mt-3"><div className="cm-bar-fill" style={{ width: `${b.score}%` }} /></div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="cm-section-label mb-3">Tier I — Institutional / Wiley / Peer-Reviewed</div>
        {tier1.map(Card1)}
      </div>
      <div>
        <div className="cm-section-label mb-3">Tier II — Practitioner Classics</div>
        <div className="grid md:grid-cols-2 gap-0">
          {tier2.map(Card1)}
        </div>
      </div>
      <div>
        <div className="cm-section-label mb-3">Tier III — Historical &amp; Foundational</div>
        <div className="grid md:grid-cols-2 gap-0">
          {tier3.map(Card1)}
        </div>
      </div>
    </div>
  );
}

// ─── EDGE EXTRACTION tab ────────────────────────────────────────────────────
function EdgeTab({ data }: { data: CosmosResponse }) {
  // Simple markdown-ish renderer: bold + newlines.
  const renderBody = (body: string) => {
    const parts = body.split("\n");
    return parts.map((line, i) => (
      <div key={i} style={{ marginBottom: line.trim() === "" ? 8 : 0 }}>
        {line.split(/(\*\*[^*]+\*\*)/g).map((seg, j) => {
          if (seg.startsWith("**") && seg.endsWith("**")) {
            return <strong key={j} style={{ color: ACCENT_GOLD }}>{seg.slice(2, -2)}</strong>;
          }
          return <span key={j}>{seg}</span>;
        })}
      </div>
    ));
  };

  return (
    <div className="space-y-4">
      <div className="cm-section-label">The Core Framework — Stacking Signals for Edge</div>

      {data.rules.map((r) => (
        <div key={r.id} className={cn("cm-edge-block", r.color)} data-testid={`edge-rule-${r.id}`}>
          <div className={cn("cm-edge-title", r.color)}>{r.title}</div>
          <div className="mt-2" style={{ fontSize: 12.5, lineHeight: 1.65, color: TEXT }}>
            {renderBody(r.body)}
          </div>
        </div>
      ))}

      <div className="cm-warn mt-6">
        <div className="cm-warn-title mb-2">HONEST EDGE ASSESSMENT</div>
        <div style={{ fontSize: 12, color: TEXT, lineHeight: 1.7 }}>
          {data.honestEdge}
        </div>
      </div>
    </div>
  );
}
