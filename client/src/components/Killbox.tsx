/**
 * Killbox.tsx — FORWARD-LOOKING dealer positioning map.
 *
 * Institutional model (matches VS3D / SpotGamma TRACE / MenthorQ):
 *   Y-axis: strike (labeled, numbered)
 *   X-axis: greek lens (gamma | vanna | charm | vomma | zomma) bar magnitudes
 *   Color: sign (long dealer = lime, short dealer = red)
 *   Right panel: ranked top strikes with $ notional
 *   Header: call wall, put wall, gamma flip, stability score
 *   Spot line: dashed yellow with label
 *   Hover/tap: tooltip with exact strike + exposure
 *
 * Data source: /api/killbox/forward returns latest snapshot per strike per greek
 * plus key levels + stability metric, computed server-side from chain-audit DB.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import LivenessBadge from "@/components/LivenessBadge";

type Greek = "gex" | "vanna" | "charm" | "vomma" | "zomma";

interface ProfilePoint {
  strike: number;
  exposure: number;
}

interface ForwardResponse {
  symbol: string;
  asOf: number | null;
  spot: number | null;
  profiles: Record<Greek, ProfilePoint[]>;
  levels: {
    callWall: number | null;
    callWallValue: number;
    putWall: number | null;
    putWallValue: number;
    gammaFlip: number | null;
  };
  stability: number;
  weightMode?: "oi" | "volume" | "hybrid";
  regime?: "long_gamma" | "short_gamma";
  totalOI?: number;
  totalVolume?: number;
  strikeCount?: number;
  source?: string;
}

const GREEK_LENSES: { key: Greek; label: string; sub: string; unit: string }[] = [
  { key: "gex", label: "GAMMA", sub: "GEX · $/1pt", unit: "$" },
  { key: "vanna", label: "VANNA", sub: "∂Δ/∂σ · $/1%vol", unit: "$" },
  { key: "charm", label: "CHARM", sub: "∂Δ/∂t · $/day", unit: "$" },
  { key: "vomma", label: "VOMMA", sub: "∂vega/∂σ · $/1%vol", unit: "$" },
  { key: "zomma", label: "ZOMMA", sub: "∂Γ/∂σ · $/1%vol", unit: "$" },
];

// Long dealer = lime, short dealer = red. Single consistent semantic across all greeks.
const LONG_COLOR = "#7cf04b";
const LONG_COLOR_DIM = "rgba(124,240,75,0.18)";
const SHORT_COLOR = "#ff4d52";
const SHORT_COLOR_DIM = "rgba(255,77,82,0.18)";
const SPOT_LINE = "#facc15";
const CALL_WALL = "#22d3ee";
const PUT_WALL = "#f472b6";
const GAMMA_FLIP = "#a3e635";

function fmtMoney(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Killbox({ symbol = "$SPX" }: { symbol?: string }) {
  const [greek, setGreek] = useState<Greek>("gex");
  const [hoverStrike, setHoverStrike] = useState<number | null>(null);

  const { data, isLoading } = useQuery<ForwardResponse>({
    queryKey: ["/api/killbox/forward", symbol],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/killbox/forward?symbol=${encodeURIComponent(symbol)}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const profile = data?.profiles?.[greek] ?? [];
  const spot = data?.spot ?? null;
  const levels = data?.levels;

  // Filter to ±2.5% around spot — the actionable kill zone where walls live.
  // Cap to 40 nearest-spot strikes to keep chart readable on phone.
  const visible = useMemo(() => {
    if (!spot || profile.length === 0) return [];
    const band = profile
      .filter(p => Math.abs(p.strike - spot) <= spot * 0.025)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
      .slice(0, 40);
    return band.sort((a, b) => a.strike - b.strike);
  }, [profile, spot]);

  const ranked = useMemo(() => {
    return [...visible]
      .sort((a, b) => Math.abs(b.exposure) - Math.abs(a.exposure))
      .slice(0, 10);
  }, [visible]);

  const absMax = useMemo(() => {
    return Math.max(0, ...visible.map(p => Math.abs(p.exposure)));
  }, [visible]);

  return (
    <div className="space-y-3">
      {/* Header — title + lens + freshness */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-baseline gap-2">
          <div className="font-mono text-sm font-bold tracking-wide text-foreground">KILLBOX</div>
          <div className="hidden sm:block text-[10px] uppercase tracking-wider text-muted-foreground">
            {symbol} · forward dealer positioning
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data?.weightMode && data.weightMode !== "oi" && (
            <div className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400" data-testid="killbox-weight-mode">
              {data.weightMode === "volume" ? "vol-weighted (OI stale)" : "hybrid"}
            </div>
          )}
          {data?.asOf && (
            <div className="text-[10px] font-mono text-muted-foreground" data-testid="killbox-asof">
              live · {fmtTime(data.asOf)}
            </div>
          )}
          <LivenessBadge feedName="options-cboe" value={data?.asOf ?? undefined} requiresSchwab={true} />
        </div>
      </div>

      {/* Key levels strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 rounded border border-border bg-card/40 p-2">
        <KeyLevel
          label="spot"
          value={spot != null ? `$${spot.toFixed(2)}` : "—"}
          color={SPOT_LINE}
        />
        <KeyLevel
          label="call wall"
          value={levels?.callWall != null ? String(levels.callWall) : "—"}
          subValue={levels?.callWallValue ? fmtMoney(levels.callWallValue) : undefined}
          color={CALL_WALL}
        />
        <KeyLevel
          label="put wall"
          value={levels?.putWall != null ? String(levels.putWall) : "—"}
          subValue={levels?.putWallValue ? fmtMoney(levels.putWallValue) : undefined}
          color={PUT_WALL}
        />
        <KeyLevel
          label="γ flip"
          value={levels?.gammaFlip != null ? levels.gammaFlip.toFixed(0) : "—"}
          subValue={
            spot != null && levels?.gammaFlip != null
              ? `spot ${spot > levels.gammaFlip ? "above" : "below"}`
              : undefined
          }
          color={GAMMA_FLIP}
        />
      </div>

      {/* Stability gauge */}
      {data && (
        <StabilityGauge
          stability={data.stability}
          callWall={levels?.callWall ?? null}
          putWall={levels?.putWall ?? null}
          spot={spot}
        />
      )}

      {/* Greek lens selector */}
      <div className="flex flex-wrap items-center gap-1.5">
        {GREEK_LENSES.map(l => {
          const on = greek === l.key;
          return (
            <button
              key={l.key}
              data-testid={`killbox-lens-${l.key}`}
              onClick={() => setGreek(l.key)}
              className={`inline-flex flex-col items-start gap-0 rounded-md border px-2.5 py-1.5 text-left transition-all min-h-[44px] sm:min-h-0 ${
                on
                  ? "border-foreground/40 bg-foreground/5 text-foreground"
                  : "border-border/40 bg-transparent text-muted-foreground/70 hover:text-foreground"
              }`}
            >
              <span className="text-[11px] font-mono font-bold">{l.label}</span>
              <span className="text-[8px] uppercase tracking-wider opacity-70">{l.sub}</span>
            </button>
          );
        })}
      </div>

      {/* Main forward dealer chart */}
      <ForwardChart
        visible={visible}
        spot={spot}
        levels={levels ?? null}
        absMax={absMax}
        greek={greek}
        hoverStrike={hoverStrike}
        onHover={setHoverStrike}
        isLoading={isLoading}
      />

      {/* Ranked top strikes */}
      {ranked.length > 0 && (
        <RankedStrikes
          ranked={ranked}
          spot={spot}
          greek={greek}
          hoverStrike={hoverStrike}
          onHover={setHoverStrike}
        />
      )}

      {/* Read-out tooltip footer for the hovered/tapped strike */}
      {hoverStrike != null && data && (
        <StrikeReadout
          strike={hoverStrike}
          data={data}
          activeGreek={greek}
        />
      )}
    </div>
  );
}

function KeyLevel({
  label, value, subValue, color,
}: {
  label: string; value: string; subValue?: string; color: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="font-mono text-sm font-semibold text-foreground tabular-nums">{value}</div>
      {subValue && <div className="text-[9px] text-muted-foreground tabular-nums">{subValue}</div>}
    </div>
  );
}

function StabilityGauge({
  stability, callWall, putWall, spot,
}: {
  stability: number;
  callWall: number | null;
  putWall: number | null;
  spot: number | null;
}) {
  // 0 = vol expansion / dealer short gamma below spot, 1 = pinning / dealer long
  const pct = stability * 100;
  const regime =
    stability > 0.65 ? "PINNING" : stability < 0.35 ? "VOL EXPANSION" : "NEUTRAL";
  const regimeColor =
    stability > 0.65 ? LONG_COLOR : stability < 0.35 ? SHORT_COLOR : SPOT_LINE;

  const range =
    callWall != null && putWall != null
      ? `${putWall} → ${callWall}`
      : "—";

  return (
    <div className="rounded border border-border bg-card/40 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">stability</span>
          <span
            className="font-mono text-[10px] font-bold tabular-nums"
            style={{ color: regimeColor }}
            data-testid="killbox-regime"
          >
            {regime}
          </span>
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          expected range: <span className="text-foreground">{range}</span>
        </div>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded bg-background">
        {/* gradient: red on left, yellow middle, lime right */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to right, rgba(255,77,82,0.35), rgba(250,204,21,0.25) 50%, rgba(124,240,75,0.35))",
          }}
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[8px] text-muted-foreground mt-0.5">
        <span>vol expansion</span>
        <span>pinning</span>
      </div>
    </div>
  );
}

function ForwardChart({
  visible, spot, levels, absMax, greek, hoverStrike, onHover, isLoading,
}: {
  visible: ProfilePoint[];
  spot: number | null;
  levels: ForwardResponse["levels"] | null;
  absMax: number;
  greek: Greek;
  hoverStrike: number | null;
  onHover: (s: number | null) => void;
  isLoading: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(360);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(es => {
      for (const e of es) setWrapW(Math.max(260, Math.floor(e.contentRect.width)));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (isLoading) {
    return (
      <div
        ref={wrapRef}
        className="flex h-[440px] items-center justify-center rounded border border-border bg-[#04060c] text-xs text-muted-foreground"
      >
        loading dealer book…
      </div>
    );
  }

  if (visible.length === 0 || !spot) {
    return (
      <div
        ref={wrapRef}
        className="flex h-[440px] flex-col items-center justify-center gap-2 rounded border border-border bg-[#04060c] px-4 text-center"
      >
        <div className="text-sm font-semibold text-foreground">no dealer book yet</div>
        <div className="text-[11px] text-muted-foreground max-w-[280px] leading-snug">
          fills after the first chain-audit snap of the day · auto-seeder runs every 5min during 9:30–16:00 ET
        </div>
      </div>
    );
  }

  // Sort strikes high → low (top to bottom) for natural read
  const rows = [...visible].sort((a, b) => b.strike - a.strike);
  const rowH = Math.max(13, Math.min(22, 520 / rows.length));
  const chartH = Math.min(520, rows.length * rowH);
  const labelW = 64;
  const barAreaW = wrapW - labelW - 12;
  const halfW = barAreaW / 2;
  const zeroX = labelW + halfW;

  return (
    <div
      ref={wrapRef}
      className="rounded border border-border bg-[#04060c] p-2"
      data-testid="killbox-forward-chart"
    >
      <svg width="100%" height={chartH} viewBox={`0 0 ${wrapW} ${chartH}`}>
        {/* Zero line */}
        <line
          x1={zeroX}
          y1={0}
          x2={zeroX}
          y2={chartH}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth="1"
        />

        {/* Spot line (horizontal) */}
        {spot != null && (() => {
          // Find y position of spot by interpolating between strikes
          const sortedAsc = [...rows].sort((a, b) => a.strike - b.strike);
          const above = sortedAsc.find(r => r.strike >= spot);
          const below = [...sortedAsc].reverse().find(r => r.strike <= spot);
          if (!above || !below) return null;
          const aIdx = rows.findIndex(r => r.strike === above.strike);
          const bIdx = rows.findIndex(r => r.strike === below.strike);
          const aY = aIdx * rowH + rowH / 2;
          const bY = bIdx * rowH + rowH / 2;
          const t = above.strike === below.strike ? 0 : (spot - below.strike) / (above.strike - below.strike);
          const y = bY + (aY - bY) * t;
          return (
            <g>
              <line x1={labelW} y1={y} x2={wrapW - 12} y2={y} stroke={SPOT_LINE} strokeWidth="1" strokeDasharray="3,3" />
              <text x={labelW + 4} y={y - 3} fill={SPOT_LINE} fontSize="10" fontFamily="ui-monospace, monospace">
                spot {spot.toFixed(0)}
              </text>
            </g>
          );
        })()}

        {/* Call wall marker */}
        {levels?.callWall != null && (() => {
          const idx = rows.findIndex(r => r.strike === levels.callWall);
          if (idx < 0) return null;
          const y = idx * rowH + rowH / 2;
          return (
            <g>
              <line x1={labelW} y1={y} x2={wrapW - 12} y2={y} stroke={CALL_WALL} strokeWidth="1" strokeDasharray="2,4" opacity="0.55" />
              <text x={wrapW - 14} y={y - 2} fill={CALL_WALL} fontSize="9" fontFamily="ui-monospace, monospace" textAnchor="end">
                call wall
              </text>
            </g>
          );
        })()}

        {/* Put wall marker */}
        {levels?.putWall != null && (() => {
          const idx = rows.findIndex(r => r.strike === levels.putWall);
          if (idx < 0) return null;
          const y = idx * rowH + rowH / 2;
          return (
            <g>
              <line x1={labelW} y1={y} x2={wrapW - 12} y2={y} stroke={PUT_WALL} strokeWidth="1" strokeDasharray="2,4" opacity="0.55" />
              <text x={wrapW - 14} y={y - 2} fill={PUT_WALL} fontSize="9" fontFamily="ui-monospace, monospace" textAnchor="end">
                put wall
              </text>
            </g>
          );
        })()}

        {/* Bars */}
        {rows.map((p, i) => {
          const y = i * rowH;
          const norm = absMax > 0 ? p.exposure / absMax : 0;
          const w = Math.abs(norm) * halfW;
          const isPos = p.exposure >= 0;
          const x = isPos ? zeroX : zeroX - w;
          const color = isPos ? LONG_COLOR : SHORT_COLOR;
          const dim = isPos ? LONG_COLOR_DIM : SHORT_COLOR_DIM;
          const isHover = hoverStrike === p.strike;
          return (
            <g
              key={p.strike}
              onMouseEnter={() => onHover(p.strike)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onHover(p.strike === hoverStrike ? null : p.strike)}
              style={{ cursor: "pointer" }}
              data-testid={`killbox-bar-${p.strike}`}
            >
              <rect
                x={labelW}
                y={y}
                width={barAreaW}
                height={rowH - 1}
                fill={isHover ? "rgba(255,255,255,0.04)" : "transparent"}
              />
              <rect x={x} y={y + 2} width={Math.max(1, w)} height={rowH - 5} fill={color} opacity={isHover ? 1 : 0.85} />
              <text
                x={labelW - 6}
                y={y + rowH / 2 + 3}
                fill={isHover ? "#fff" : "rgba(200,210,225,0.9)"}
                fontSize="10"
                fontFamily="ui-monospace, monospace"
                textAnchor="end"
                fontWeight={isHover ? "bold" : "normal"}
              >
                {p.strike}
              </text>
              {/* Value label on bar (only if bar wide enough) */}
              {w > 38 && (
                <text
                  x={isPos ? x + 4 : x + w - 4}
                  y={y + rowH / 2 + 3}
                  fill="rgba(0,0,0,0.7)"
                  fontSize="9"
                  fontFamily="ui-monospace, monospace"
                  fontWeight="bold"
                  textAnchor={isPos ? "start" : "end"}
                >
                  {fmtMoney(p.exposure)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RankedStrikes({
  ranked, spot, greek, hoverStrike, onHover,
}: {
  ranked: ProfilePoint[];
  spot: number | null;
  greek: Greek;
  hoverStrike: number | null;
  onHover: (s: number | null) => void;
}) {
  return (
    <div className="rounded border border-border bg-card/40 p-2">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5">
        top strikes — {greek.toUpperCase()} magnitude
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1">
        {ranked.map(p => {
          const isPos = p.exposure >= 0;
          const color = isPos ? LONG_COLOR : SHORT_COLOR;
          const dist = spot ? p.strike - spot : 0;
          const distSign = dist > 0 ? "+" : "";
          const isHover = hoverStrike === p.strike;
          return (
            <button
              key={p.strike}
              data-testid={`killbox-rank-${p.strike}`}
              onMouseEnter={() => onHover(p.strike)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onHover(p.strike === hoverStrike ? null : p.strike)}
              className={`flex flex-col items-start gap-0 rounded px-2 py-1 text-left transition-all min-h-[40px] ${
                isHover ? "bg-foreground/10" : "bg-background/40 hover:bg-foreground/5"
              }`}
            >
              <span className="font-mono text-[11px] font-bold tabular-nums text-foreground">
                {p.strike}
              </span>
              <span className="font-mono text-[10px] tabular-nums" style={{ color }}>
                {fmtMoney(p.exposure)}
              </span>
              <span className="text-[8px] text-muted-foreground tabular-nums">
                {distSign}{dist.toFixed(0)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StrikeReadout({
  strike, data, activeGreek,
}: {
  strike: number;
  data: ForwardResponse;
  activeGreek: Greek;
}) {
  const greeks: Greek[] = ["gex", "vanna", "charm", "vomma", "zomma"];
  const values: { greek: Greek; value: number }[] = greeks.map(g => {
    const p = (data.profiles[g] ?? []).find(x => x.strike === strike);
    return { greek: g, value: p?.exposure ?? 0 };
  });

  const dist = data.spot ? strike - data.spot : 0;
  const dealerSign = (g: Greek, v: number): string => {
    if (v === 0) return "neutral";
    return v > 0 ? "long" : "short";
  };

  return (
    <div className="rounded border border-foreground/30 bg-card/80 p-2.5" data-testid="killbox-readout">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <span className="font-mono text-base font-bold text-foreground">{strike}</span>
          {data.spot && (
            <span className="ml-2 font-mono text-[10px] text-muted-foreground">
              {dist > 0 ? "+" : ""}{dist.toFixed(0)} from spot
            </span>
          )}
        </div>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
          dealer book at this strike
        </div>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {values.map(v => {
          const isActive = v.greek === activeGreek;
          const color = v.value > 0 ? LONG_COLOR : v.value < 0 ? SHORT_COLOR : "#888";
          return (
            <div
              key={v.greek}
              className={`flex flex-col gap-0 rounded p-1.5 ${isActive ? "bg-foreground/10" : ""}`}
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                {v.greek === "gex" ? "gamma" : v.greek}
              </div>
              <div className="font-mono text-[11px] font-semibold tabular-nums" style={{ color }}>
                {fmtMoney(v.value)}
              </div>
              <div className="text-[8px] text-muted-foreground">
                {dealerSign(v.greek, v.value)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
