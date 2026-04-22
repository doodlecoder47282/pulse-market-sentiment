// CandlestickChart.tsx
// SVG-based candlestick chart with gamma wall overlay (SPY only). Built from
// scratch to get pixel-level control over the gamma lines + labels.
//
// Props:
//   candles: Candle[]
//   gamma?: GammaLevels (optional, SPY only)
//   height: chart height in px (viewport width auto-fills)
//   showVolume: whether to render volume pane at bottom

import { useMemo, useState } from "react";

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
};

export type GammaLevels = {
  callWall: number;
  putWall: number;
  zeroGamma: number | null;
  flip: number | null;
  maxPain: number | null;
  regime: "positive" | "negative";
  profile?: { strike: number; gex: number }[];
};

type Props = {
  candles: Candle[];
  gamma?: GammaLevels | null;
  height?: number;
  showVolume?: boolean;
  showGamma?: boolean;
  symbol: string;
};

// Extra right padding gives the price scale its own column, tick labels no longer
// collide with the candles or the gamma-wall badges.
const PADDING = { top: 12, right: 96, bottom: 32, left: 12 };
const PRICE_SCALE_WIDTH = 88; // reserved column on the right for price labels
const VOLUME_PANE_PCT = 0.18;

export function CandlestickChart({
  candles,
  gamma,
  height = 440,
  showVolume = true,
  showGamma = true,
  symbol,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 1200; // viewBox width; SVG scales responsively
  const chartBottom = showVolume ? height - PADDING.bottom - height * VOLUME_PANE_PCT - 8 : height - PADDING.bottom;
  const chartTop = PADDING.top;
  const chartHeight = chartBottom - chartTop;
  const chartLeft = PADDING.left;
  const chartRight = width - PADDING.right;
  const chartWidth = chartRight - chartLeft;

  const gammaApplies = showGamma && gamma && (symbol === "SPY" || symbol === "^GSPC" || symbol === "SPX");

  const { yMin, yMax, xStep, candleW } = useMemo(() => {
    if (!candles.length) return { yMin: 0, yMax: 1, xStep: 0, candleW: 0 };
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    // Extend range to include gamma levels so walls are always visible
    if (gammaApplies && gamma) {
      const levels = [gamma.callWall, gamma.putWall, gamma.zeroGamma, gamma.flip].filter((x): x is number => x != null);
      for (const lv of levels) {
        if (lv < lo) lo = lv;
        if (lv > hi) hi = lv;
      }
    }
    const pad = (hi - lo) * 0.06 || hi * 0.02;
    const step = chartWidth / candles.length;
    return {
      yMin: lo - pad,
      yMax: hi + pad,
      xStep: step,
      candleW: Math.max(2, Math.min(14, step * 0.75)),
    };
  }, [candles, gamma, gammaApplies, chartWidth]);

  if (!candles.length) {
    return (
      <div className="flex h-[440px] items-center justify-center rounded-xl border border-border/40 bg-card/40 text-sm text-muted-foreground">
        No candle data
      </div>
    );
  }

  const priceToY = (p: number) => chartBottom - ((p - yMin) / (yMax - yMin)) * chartHeight;
  const yToPrice = (y: number) => yMax - ((y - chartTop) / chartHeight) * (yMax - yMin);

  // Volume pane
  let volMax = 0;
  for (const c of candles) if (c.v && c.v > volMax) volMax = c.v;
  const volTop = chartBottom + 8;
  const volBottom = height - PADDING.bottom;
  const volHeight = volBottom - volTop;

  // Y-axis gridlines — target ~10 ticks. Adapts step size (powers of 1/2/5) to
  // the price range so labels are always round and evenly spaced.
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    if (!isFinite(range) || range <= 0) return [] as number[];
    const targetTicks = 10;
    const rough = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const start = Math.ceil(yMin / step) * step;
    const ticks: number[] = [];
    for (let v = start; v <= yMax; v += step) ticks.push(Number(v.toFixed(6)));
    return ticks;
  }, [yMin, yMax]);

  // X-axis tick indexes (every N candles, ~6 ticks)
  const xTickIdx = useMemo(() => {
    const n = candles.length;
    const count = Math.min(6, n);
    const step = Math.max(1, Math.floor(n / count));
    const out: number[] = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }, [candles]);

  // Decide decimals once for the whole chart so every label aligns.
  const priceDecimals = useMemo(() => {
    const max = Math.max(Math.abs(yMin), Math.abs(yMax));
    if (max >= 10000) return 0;
    if (max >= 1000) return 1;
    if (max >= 100) return 2;
    if (max >= 10) return 2;
    if (max >= 1) return 3;
    return 4;
  }, [yMin, yMax]);

  const formatPriceAxis = (v: number) => {
    if (Math.abs(v) >= 10000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals });
    return v.toFixed(priceDecimals);
  };

  const formatXTick = (t: number) => {
    const d = new Date(t * 1000);
    // If intraday (diff < 2 days across full series) show HH:mm
    const span = candles[candles.length - 1].t - candles[0].t;
    if (span < 3 * 86400) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const hovered = hoverIdx != null ? candles[hoverIdx] : null;

  return (
    <div className="w-full" data-testid="candlestick-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * width;
          const i = Math.floor((x - chartLeft) / xStep);
          if (i >= 0 && i < candles.length) setHoverIdx(i);
        }}
      >
        {/* Price-scale column background + divider — gives the axis a clean home */}
        <rect
          x={chartRight}
          y={0}
          width={PRICE_SCALE_WIDTH}
          height={height}
          fill="currentColor"
          fillOpacity={0.03}
        />
        <line
          x1={chartRight}
          x2={chartRight}
          y1={0}
          y2={height - PADDING.bottom}
          stroke="currentColor"
          strokeOpacity={0.15}
        />

        {/* Y gridlines + labels (right-side, inside the scale column) */}
        {yTicks.map((v, i) => {
          const y = priceToY(v);
          if (y < chartTop - 1 || y > chartBottom + 1) return null;
          return (
            <g key={i}>
              <line
                x1={chartLeft}
                x2={chartRight}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.08}
                strokeDasharray="2 3"
              />
              {/* Tick mark on the scale */}
              <line
                x1={chartRight}
                x2={chartRight + 4}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.45}
              />
              <text
                x={chartRight + 8}
                y={y + 3.5}
                fontSize={10.5}
                fill="currentColor"
                fillOpacity={0.7}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatPriceAxis(v)}
              </text>
            </g>
          );
        })}

        {/* Last-price tag on the scale — bloomberg-style pill */}
        {(() => {
          const last = candles[candles.length - 1];
          if (!last) return null;
          const y = priceToY(last.c);
          const isUp = last.c >= last.o;
          const color = isUp ? "#22c55e" : "#ef4444";
          return (
            <g>
              <line
                x1={chartLeft}
                x2={chartRight}
                y1={y}
                y2={y}
                stroke={color}
                strokeWidth={0.75}
                strokeDasharray="1 2"
                opacity={0.55}
              />
              <rect
                x={chartRight + 2}
                y={y - 8.5}
                width={PRICE_SCALE_WIDTH - 4}
                height={17}
                rx={2}
                fill={color}
              />
              <text
                x={chartRight + 6}
                y={y + 3.5}
                fontSize={11}
                fill="#000"
                fontWeight={700}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatPriceAxis(last.c)}
              </text>
            </g>
          );
        })()}

        {/* Gamma walls (SPY only) */}
        {gammaApplies && gamma && (
          <g>
            {/* Call wall — red resistance */}
            <line
              x1={chartLeft}
              x2={chartRight}
              y1={priceToY(gamma.callWall)}
              y2={priceToY(gamma.callWall)}
              stroke="#ef4444"
              strokeWidth={1.25}
              strokeDasharray="6 3"
              opacity={0.75}
            />
            <text
              x={chartLeft + 6}
              y={priceToY(gamma.callWall) - 3}
              fontSize={9.5}
              fill="#ef4444"
              fontWeight={600}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              CALL WALL {formatPriceAxis(gamma.callWall)}
            </text>

            {/* Put wall — green support */}
            <line
              x1={chartLeft}
              x2={chartRight}
              y1={priceToY(gamma.putWall)}
              y2={priceToY(gamma.putWall)}
              stroke="#22c55e"
              strokeWidth={1.25}
              strokeDasharray="6 3"
              opacity={0.75}
            />
            <text
              x={chartLeft + 6}
              y={priceToY(gamma.putWall) + 11}
              fontSize={9.5}
              fill="#22c55e"
              fontWeight={600}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              PUT WALL {formatPriceAxis(gamma.putWall)}
            </text>

            {/* Zero gamma flip — yellow line */}
            {gamma.zeroGamma != null && (
              <>
                <line
                  x1={chartLeft}
                  x2={chartRight}
                  y1={priceToY(gamma.zeroGamma)}
                  y2={priceToY(gamma.zeroGamma)}
                  stroke="#eab308"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.7}
                />
                <text
                  x={chartLeft + 6}
                  y={priceToY(gamma.zeroGamma) - 3}
                  fontSize={9}
                  fill="#eab308"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  0γ {formatPriceAxis(gamma.zeroGamma)}
                </text>
              </>
            )}

            {/* Max pain — violet tick */}
            {gamma.maxPain != null && (
              <>
                <line
                  x1={chartLeft}
                  x2={chartRight}
                  y1={priceToY(gamma.maxPain)}
                  y2={priceToY(gamma.maxPain)}
                  stroke="#a855f7"
                  strokeWidth={0.75}
                  strokeDasharray="1 4"
                  opacity={0.6}
                />
                <text
                  x={chartLeft + 6}
                  y={priceToY(gamma.maxPain) + 10}
                  fontSize={9}
                  fill="#a855f7"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  MP {formatPriceAxis(gamma.maxPain)}
                </text>
              </>
            )}
          </g>
        )}

        {/* Candles */}
        {candles.map((c, i) => {
          const x = chartLeft + i * xStep + xStep / 2;
          const isUp = c.c >= c.o;
          const color = isUp ? "#22c55e" : "#ef4444";
          const yHigh = priceToY(c.h);
          const yLow = priceToY(c.l);
          const yOpen = priceToY(c.o);
          const yClose = priceToY(c.c);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(1, Math.abs(yOpen - yClose));
          return (
            <g key={i} opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.75}>
              {/* Wick */}
              <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
              {/* Body */}
              <rect
                x={x - candleW / 2}
                y={bodyTop}
                width={candleW}
                height={bodyH}
                fill={color}
                fillOpacity={isUp ? 0.85 : 0.95}
                stroke={color}
                strokeWidth={0.5}
              />
            </g>
          );
        })}

        {/* X-axis ticks + labels */}
        {xTickIdx.map((i) => {
          const x = chartLeft + i * xStep + xStep / 2;
          return (
            <g key={`x${i}`}>
              <line x1={x} x2={x} y1={chartBottom} y2={chartBottom + 4} stroke="currentColor" strokeOpacity={0.3} />
              <text
                x={x}
                y={height - PADDING.bottom + 15}
                fontSize={10}
                fill="currentColor"
                fillOpacity={0.55}
                textAnchor="middle"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {formatXTick(candles[i].t)}
              </text>
            </g>
          );
        })}

        {/* Volume pane */}
        {showVolume && volMax > 0 && (
          <g>
            {candles.map((c, i) => {
              const x = chartLeft + i * xStep + xStep / 2;
              const h = c.v ? (c.v / volMax) * volHeight : 0;
              const isUp = c.c >= c.o;
              return (
                <rect
                  key={`v${i}`}
                  x={x - candleW / 2}
                  y={volBottom - h}
                  width={candleW}
                  height={h}
                  fill={isUp ? "#22c55e" : "#ef4444"}
                  fillOpacity={0.4}
                />
              );
            })}
          </g>
        )}

        {/* Hover crosshair + tooltip */}
        {hovered && hoverIdx != null && (
          <g pointerEvents="none">
            <line
              x1={chartLeft + hoverIdx * xStep + xStep / 2}
              x2={chartLeft + hoverIdx * xStep + xStep / 2}
              y1={chartTop}
              y2={volBottom}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="2 2"
            />
          </g>
        )}
      </svg>

      {/* Hover tooltip row */}
      {hovered && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-1.5 font-mono text-[11px] tabular-nums backdrop-blur">
          <span className="text-muted-foreground">
            {new Date(hovered.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
          <span>O <span className="font-semibold">{hovered.o.toFixed(2)}</span></span>
          <span>H <span className="font-semibold text-emerald-400">{hovered.h.toFixed(2)}</span></span>
          <span>L <span className="font-semibold text-rose-400">{hovered.l.toFixed(2)}</span></span>
          <span>C <span className="font-semibold">{hovered.c.toFixed(2)}</span></span>
          {hovered.v != null && (
            <span className="text-muted-foreground">V {(hovered.v / 1e6).toFixed(2)}M</span>
          )}
          <span className={`ml-auto ${hovered.c >= hovered.o ? "text-emerald-400" : "text-rose-400"}`}>
            {(((hovered.c - hovered.o) / hovered.o) * 100).toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}
