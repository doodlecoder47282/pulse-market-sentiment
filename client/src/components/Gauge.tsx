import { scoreColor } from "@/lib/format";

interface GaugeProps {
  value: number;          // 0..100
  label: string;
  size?: number;
}

/** Semi-circular dial gauge. */
export default function Gauge({ value, label, size = 260 }: GaugeProps) {
  const v = Math.max(0, Math.min(100, value));
  const r = size / 2 - 18;
  const cx = size / 2;
  const cy = size / 2 + 10;
  // Angle sweep: -180° (left) → 0° (right)
  const angle = (v / 100) * 180 - 180;
  const rad = (angle * Math.PI) / 180;
  const px = cx + r * Math.cos(rad);
  const py = cy + r * Math.sin(rad);

  // Arc path (background)
  const bgArc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  // Segmented colored ticks
  const segments = [
    { from: 0,  to: 20, color: "#ef4444" },
    { from: 20, to: 40, color: "#f97316" },
    { from: 40, to: 55, color: "#f59e0b" },
    { from: 55, to: 75, color: "#84cc16" },
    { from: 75, to: 100, color: "#10b981" },
  ];

  function arcPath(fromPct: number, toPct: number) {
    const a1 = (fromPct / 100) * 180 - 180;
    const a2 = (toPct / 100) * 180 - 180;
    const r1 = (a1 * Math.PI) / 180;
    const r2 = (a2 * Math.PI) / 180;
    const x1 = cx + r * Math.cos(r1);
    const y1 = cy + r * Math.sin(r1);
    const x2 = cx + r * Math.cos(r2);
    const y2 = cy + r * Math.sin(r2);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  }

  return (
    <div className="flex flex-col items-center" data-testid="gauge-composite">
      <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62 + 10}`}>
        {/* background track */}
        <path d={bgArc} fill="none" stroke="hsl(var(--muted))" strokeWidth={14} strokeLinecap="round" />
        {/* colored segments */}
        {segments.map((s, i) => (
          <path
            key={i}
            d={arcPath(s.from, s.to)}
            fill="none"
            stroke={s.color}
            strokeWidth={14}
            strokeLinecap="butt"
            opacity={0.95}
          />
        ))}
        {/* tick labels — only at the ends to avoid collision with needle at top */}
        {[0, 100].map((p) => {
          const a = (p / 100) * 180 - 180;
          const rr = (a * Math.PI) / 180;
          const tx = cx + (r + 18) * Math.cos(rr);
          const ty = cy + (r + 18) * Math.sin(rr);
          return (
            <text key={p} x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
              fontSize="10" fill="hsl(var(--muted-foreground))" fontFamily="var(--font-mono)">
              {p}
            </text>
          );
        })}
        {/* sentiment zone labels at bottom edge */}
        <text x={cx - r * 0.7} y={cy + 16} textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))" letterSpacing="1">FEAR</text>
        <text x={cx + r * 0.7} y={cy + 16} textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))" letterSpacing="1">GREED</text>
        {/* needle */}
        <line x1={cx} y1={cy} x2={px} y2={py}
          stroke="hsl(var(--foreground))" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={8} fill="hsl(var(--foreground))" />
        <circle cx={cx} cy={cy} r={4} fill="hsl(var(--background))" />
      </svg>
      <div className="-mt-2 text-center">
        <div className={`text-5xl font-bold tabular-nums ${scoreColor(v)}`} data-testid="text-composite-score">{v}</div>
        <div className="mt-1 text-sm uppercase tracking-widest text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
