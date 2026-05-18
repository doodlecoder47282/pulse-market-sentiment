// LightweightCandlestick.tsx
// Wraps TradingView's open-source `lightweight-charts` library. Preserves gamma
// walls as persistent price lines. Designed to drop into the Chart tab as an
// alternative engine to the custom SVG renderer.

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  ColorType,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  LineStyle,
} from "lightweight-charts";

export type NewsMarker = {
  id: string;
  time: number; // epoch seconds
  direction: "BULL" | "BEAR" | "NEUTRAL";
  tier: "TIER_1" | "TIER_2" | "SENTIMENT_SHIFT";
  category: string;
  title: string;
};

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number | null };
type GammaLevels = {
  callWall: number;
  putWall: number;
  zeroGamma: number | null;
  maxPain: number | null;
  regime: "positive" | "negative";
};

export default function LightweightCandlestick({
  candles,
  gamma,
  symbol,
  height = 460,
  showVolume = true,
  showGamma = true,
  newsMarkers,
  onMarkerClick,
}: {
  candles: Candle[];
  gamma: GammaLevels | null;
  symbol: string;
  height?: number;
  showVolume?: boolean;
  showGamma?: boolean;
  newsMarkers?: NewsMarker[];
  onMarkerClick?: (markerId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const gammaLinesRef = useRef<IPriceLine[]>([]);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const markerIdByTimeRef = useRef<Map<number, string>>(new Map());
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;

  // Init + cleanup
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
        textColor: "rgba(228, 228, 231, 0.8)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.15)",
        scaleMargins: { top: 0.08, bottom: showVolume ? 0.25 : 0.08 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.15)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(34,211,238,0.4)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#0891b2" },
        horzLine: { color: "rgba(34,211,238,0.4)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#0891b2" },
      },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#f43f5e",
      wickUpColor: "#10b981",
      wickDownColor: "#f43f5e",
      borderVisible: false,
    });
    chartRef.current = chart;
    candleRef.current = candle;

    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        color: "rgba(148,163,184,0.5)",
      });
      chart.priceScale("vol").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      volRef.current = vol;
    }

    // Click handler for news markers — detect which marker (if any) was clicked.
    chart.subscribeClick((param) => {
      const t = (param.time as number | undefined);
      if (t == null) return;
      const id = markerIdByTimeRef.current.get(t);
      if (id && onMarkerClickRef.current) onMarkerClickRef.current(id);
    });

    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      gammaLinesRef.current = [];
      markersPluginRef.current = null;
      markerIdByTimeRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, showVolume]);

  // Push candle data whenever it changes
  useEffect(() => {
    if (!candleRef.current || candles.length === 0) return;
    // Dedupe by timestamp AND ensure strictly ascending — lightweight-charts requires this
    const seen = new Set<number>();
    const deduped = candles.filter((c) => {
      if (seen.has(c.t)) return false;
      seen.add(c.t);
      return true;
    });
    deduped.sort((a, b) => a.t - b.t);
    const data = deduped.map((c) => ({
      time: c.t as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
    candleRef.current.setData(data);
    if (volRef.current) {
      const vData = deduped.map((c) => ({
        time: c.t as UTCTimestamp,
        value: c.v ?? 0,
        color: c.c >= c.o ? "rgba(16,185,129,0.4)" : "rgba(244,63,94,0.4)",
      }));
      volRef.current.setData(vData);
    }
    // Fit on first load, leave user zoom afterward. Heuristic: fit if current
    // visible range is empty or covers all data.
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles]);

  // Push gamma lines
  useEffect(() => {
    if (!candleRef.current) return;
    // Remove existing lines
    for (const line of gammaLinesRef.current) {
      candleRef.current.removePriceLine(line);
    }
    gammaLinesRef.current = [];
    if (!showGamma || !gamma) return;
    const add = (price: number, color: string, title: string, width = 2) => {
      const line = candleRef.current!.createPriceLine({
        price,
        color,
        lineWidth: width as any,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      });
      gammaLinesRef.current.push(line);
    };
    add(gamma.callWall, "#f43f5e", `Call Wall ${gamma.callWall.toFixed(0)}`);
    add(gamma.putWall, "#10b981", `Put Wall ${gamma.putWall.toFixed(0)}`);
    if (gamma.zeroGamma != null) add(gamma.zeroGamma, "#f59e0b", `0γ ${gamma.zeroGamma.toFixed(0)}`);
    if (gamma.maxPain != null) add(gamma.maxPain, "#8b5cf6", `Max Pain ${gamma.maxPain.toFixed(0)}`, 1);
  }, [gamma, showGamma]);

  // Push news markers — maps each event to a chart marker color-coded by direction,
  // shaped by tier. Multiple events at the same minute would collide so we snap
  // each marker's `time` to the nearest candle bucket and track id<->time.
  useEffect(() => {
    if (!candleRef.current || !chartRef.current) return;

    // Lazily attach the markers plugin once. Plugin is destroyed with the chart.
    if (!markersPluginRef.current) {
      try {
        markersPluginRef.current = createSeriesMarkers(candleRef.current, []);
      } catch (e) {
        // older lightweight-charts: fall back to deprecated setMarkers if available
        // (we keep going — markers just won't render)
        // eslint-disable-next-line no-console
        console.warn("[lightweightChart] markers plugin unavailable:", (e as any)?.message);
      }
    }
    if (!markersPluginRef.current) return;

    markerIdByTimeRef.current.clear();
    const items: NewsMarker[] = newsMarkers ?? [];
    if (!items.length || candles.length === 0) {
      markersPluginRef.current.setMarkers([]);
      return;
    }

    // Build sorted candle times for snapping
    const candleTimes = candles.map((c) => c.t).sort((a, b) => a - b);
    const minT = candleTimes[0];
    const maxT = candleTimes[candleTimes.length - 1];

    function snap(t: number): number {
      if (t <= minT) return minT;
      if (t >= maxT) return maxT;
      // binary search for nearest
      let lo = 0, hi = candleTimes.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (candleTimes[mid] <= t) lo = mid; else hi = mid;
      }
      return Math.abs(candleTimes[lo] - t) <= Math.abs(candleTimes[hi] - t) ? candleTimes[lo] : candleTimes[hi];
    }

    const colorFor = (d: NewsMarker["direction"]) =>
      d === "BULL" ? "#10b981" : d === "BEAR" ? "#f43f5e" : "#f59e0b";
    const shapeFor = (tier: NewsMarker["tier"]): SeriesMarker<Time>["shape"] =>
      tier === "TIER_1" ? "circle" : tier === "TIER_2" ? "square" : "arrowDown";
    const sizeFor = (tier: NewsMarker["tier"]) =>
      tier === "TIER_1" ? 2 : tier === "TIER_2" ? 1.5 : 1;
    const textFor = (m: NewsMarker) => {
      const label = m.category === "SENTIMENT_CLUSTER" ? "∇" :
                    m.category === "EARNINGS" ? "E" :
                    m.category === "GUIDANCE" ? "G" :
                    m.category === "M&A" ? "M" :
                    m.category === "FDA" ? "R" :
                    m.category === "FED" ? "F" :
                    m.category === "RATING" ? "↑↓" :
                    m.category === "FLOW" ? "♦" :
                    "●";
      return label;
    };

    // Snap, dedupe by snapped time keeping highest priority (TIER_1 > TIER_2 > SENTIMENT_SHIFT)
    const tierWeight: Record<NewsMarker["tier"], number> = { TIER_1: 3, TIER_2: 2, SENTIMENT_SHIFT: 1 };
    const byTime = new Map<number, NewsMarker>();
    for (const m of items) {
      const snapped = snap(m.time);
      const existing = byTime.get(snapped);
      if (!existing || tierWeight[m.tier] > tierWeight[existing.tier]) {
        byTime.set(snapped, m);
      }
    }

    const markers: SeriesMarker<Time>[] = [];
    for (const [snapped, m] of byTime.entries()) {
      markerIdByTimeRef.current.set(snapped, m.id);
      markers.push({
        time: snapped as UTCTimestamp,
        position: m.direction === "BEAR" ? "aboveBar" : "belowBar",
        color: colorFor(m.direction),
        shape: shapeFor(m.tier),
        text: textFor(m),
        size: sizeFor(m.tier),
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersPluginRef.current.setMarkers(markers);
  }, [newsMarkers, candles]);

  return (
    <div className="relative rounded-lg border border-border/40 bg-black/20 p-2" data-testid={`lightweight-${symbol}`}>
      <div ref={containerRef} style={{ height, width: "100%" }} />
      <div className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground">
        <span>Lightweight Charts · TradingView open-source</span>
        <span>{candles.length} candles</span>
      </div>
    </div>
  );
}
