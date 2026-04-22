import { Card, CardContent } from "@/components/ui/card";
import { fmt } from "@/lib/format";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface Props {
  label: string;
  value: string;
  changePct?: number | null;
  sub?: string;
  accent?: "neutral" | "bull" | "bear" | "warn";
  testId?: string;
}

export default function MetricCard({ label, value, changePct, sub, accent = "neutral", testId }: Props) {
  const dotColor =
    accent === "bull" ? "bg-emerald-500"
    : accent === "bear" ? "bg-red-500"
    : accent === "warn" ? "bg-amber-500"
    : "bg-muted-foreground/40";

  const Icon = changePct == null ? null : changePct > 0 ? TrendingUp : changePct < 0 ? TrendingDown : Minus;
  const changeColor = changePct == null ? "" : changePct > 0 ? "text-emerald-500" : changePct < 0 ? "text-red-500" : "text-muted-foreground";

  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden />
          {label}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          {changePct != null && Icon && (
            <div className={`flex items-center gap-1 text-xs ${changeColor}`}>
              <Icon className="h-3 w-3" />
              <span className="tabular-nums">{fmt.pct(changePct, 2)}</span>
            </div>
          )}
        </div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
