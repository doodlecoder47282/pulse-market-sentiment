export const fmt = {
  num: (n: number | null | undefined, d = 2) =>
    n == null || !isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }),
  pct: (n: number | null | undefined, d = 2) =>
    n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`,
  usd: (n: number | null | undefined, d = 2) =>
    n == null || !isFinite(n) ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}`,
  bn: (n: number | null | undefined, d = 2) =>
    n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}$${(n / 1e9).toFixed(d)}B`,
  mn: (n: number | null | undefined, d = 0) =>
    n == null || !isFinite(n) ? "—" : `${(n / 1e6).toFixed(d)}M`,
  int: (n: number | null | undefined) =>
    n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US"),
  ts: (epoch: number) => new Date(epoch * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }),
  toneColor: (t: "bullish" | "bearish" | "neutral") =>
    t === "bullish" ? "text-emerald-500" : t === "bearish" ? "text-red-500" : "text-muted-foreground",
};

export function scoreColor(v: number): string {
  // 0 = fear (red) → 50 (amber) → 100 (emerald)
  if (v <= 20) return "text-red-500";
  if (v <= 40) return "text-orange-500";
  if (v <= 55) return "text-amber-400";
  if (v <= 75) return "text-lime-400";
  return "text-emerald-400";
}
export function scoreBg(v: number): string {
  if (v <= 20) return "bg-red-500";
  if (v <= 40) return "bg-orange-500";
  if (v <= 55) return "bg-amber-400";
  if (v <= 75) return "bg-lime-400";
  return "bg-emerald-400";
}
