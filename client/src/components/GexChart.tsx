import { useEffect, useRef, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell,
} from "recharts";
import type { GammaStructure } from "@shared/schema";

interface Props { gamma: GammaStructure }

const MARGIN = { top: 8, right: 16, left: 0, bottom: 8 };
const Y_AXIS_W = 56;

/**
 * Label pinned to a vertical reference line. Each label has its own row so
 * the spot and flip labels never overlap when the two lines are close (the
 * usual case), and the text is kept inside the plot when the line sits near
 * an edge. recharts clones the element with the line's viewBox.
 */
function LineLabel({ viewBox, text, row, plotLeft, plotRight, fill, halo, fontSize, weight }: {
  viewBox?: { x: number; y: number; width: number; height: number };
  text: string;
  row: number;
  plotLeft: number;
  plotRight: number;
  fill: string;
  halo?: string;
  fontSize: number;
  weight?: number;
}) {
  if (!viewBox) return null;
  const half = (text.length * fontSize * 0.62) / 2 + 2;
  let x = viewBox.x;
  if (plotRight - plotLeft > 2 * half) x = Math.min(Math.max(x, plotLeft + half), plotRight - half);
  else if (plotRight > plotLeft) x = (plotLeft + plotRight) / 2;
  const y = viewBox.y + fontSize + 2 + row * (fontSize + 6);
  return (
    <text
      x={x} y={y} textAnchor="middle" fill={fill} fontSize={fontSize} fontWeight={weight}
      style={halo ? { paintOrder: "stroke", stroke: halo, strokeWidth: 6, strokeLinejoin: "round" } : undefined}
    >
      {text}
    </text>
  );
}

export default function GexChart({ gamma }: Props) {
  const data = gamma.profile.map((p) => ({
    strike: p.strike,
    gexM: p.gex / 1e6, // $M per 1%
  }));

  // Plot bounds for the line labels: the wrapper width minus the y axis and margins.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setWrapW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((es) => setWrapW(es[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plotLeft = MARGIN.left + Y_AXIS_W;
  const plotRight = wrapW > 0 ? wrapW - MARGIN.right : 0;

  return (
    <div ref={wrapRef} className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="strike"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => `${v}`}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickMargin={4}
          />
          <YAxis
            tickFormatter={(v) => `${v}M`}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            width={Y_AXIS_W}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v: any) => [`$${Number(v).toFixed(1)}M / 1%`, "Net GEX"]}
            labelFormatter={(v) => `Strike ${v}`}
          />
          <ReferenceLine
            x={gamma.spot}
            stroke="hsl(var(--foreground))"
            strokeDasharray="4 2"
            label={
              <LineLabel
                text={`Spot ${gamma.spot.toFixed(2)}`} row={1} plotLeft={plotLeft} plotRight={plotRight}
                fill="hsl(var(--foreground))" halo="hsl(var(--background))" fontSize={10} weight={600}
              />
            }
          />
          {gamma.zeroGamma && (
            <ReferenceLine
              x={gamma.zeroGamma}
              stroke="#fde047"
              strokeWidth={3}
              strokeDasharray="6 4"
              ifOverflow="extendDomain"
              style={{ filter: "drop-shadow(0 0 6px rgba(253, 224, 71, 0.9)) drop-shadow(0 0 12px rgba(251, 191, 36, 0.55))" }}
              label={
                <LineLabel
                  text={`ZERO-Γ FLIP ${gamma.zeroGamma.toFixed(1)}`} row={0} plotLeft={plotLeft} plotRight={plotRight}
                  fill="#0a0a0a" halo="#fde047" fontSize={12} weight={800}
                />
              }
            />
          )}
          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
          <Bar dataKey="gexM">
            {data.map((d, i) => (
              <Cell key={i} fill={d.gexM >= 0 ? "hsl(142 71% 45%)" : "hsl(0 84% 55%)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
