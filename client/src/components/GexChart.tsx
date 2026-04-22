import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell,
} from "recharts";
import type { GammaStructure } from "@shared/schema";

interface Props { gamma: GammaStructure }

export default function GexChart({ gamma }: Props) {
  const data = gamma.profile.map((p) => ({
    strike: p.strike,
    gexM: p.gex / 1e6, // $M per 1%
  }));

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
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
            width={56}
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
          <ReferenceLine x={gamma.spot} stroke="hsl(var(--foreground))" strokeDasharray="4 2"
            label={{ value: `Spot ${gamma.spot.toFixed(2)}`, position: "insideTopLeft", fill: "hsl(var(--foreground))", fontSize: 10 }} />
          {gamma.zeroGamma && (
            <ReferenceLine
              x={gamma.zeroGamma}
              stroke="#fde047"
              strokeWidth={3}
              strokeDasharray="6 4"
              ifOverflow="extendDomain"
              style={{ filter: "drop-shadow(0 0 6px rgba(253, 224, 71, 0.9)) drop-shadow(0 0 12px rgba(251, 191, 36, 0.55))" }}
              label={{
                value: `⚡ ZERO-Γ FLIP ${gamma.zeroGamma.toFixed(1)}`,
                position: "insideTop",
                fill: "#0a0a0a",
                fontSize: 12,
                fontWeight: 800,
                offset: 10,
                style: {
                  paintOrder: "stroke",
                  stroke: "#fde047",
                  strokeWidth: 6,
                  strokeLinejoin: "round",
                } as any,
              }}
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
