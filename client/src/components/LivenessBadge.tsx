/**
 * LivenessBadge.tsx — shared source of truth for "is this data actually live?"
 *
 * The whole dashboard has one nasty quirk: when Schwab is disconnected the
 * server still answers 200 with null/zero bodies, so every component's
 * `isError` guard misses and panels render confidently-wrong data under a
 * hardcoded green "LIVE" tag. This pill is the one place that knows the truth.
 *
 * It reads /api/schwab/status (deduped by React Query across every mount) and
 * cross-references the actual value we're about to show, then resolves to:
 *   LIVE    — Schwab connected + we have a value
 *   CBOE    — feed doesn't need Schwab and we have a value (delayed CBOE etc.)
 *   STALE   — value present but Schwab is down and this feed normally needs it
 *   OFFLINE — no usable value (null / undefined / a zero that shouldn't be zero)
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface SchwabStatus {
  connected: boolean;
  needsReauth: boolean;
}

type LivenessState = "LIVE" | "CBOE" | "STALE" | "OFFLINE";

const STATE_STYLE: Record<LivenessState, { dot: string; text: string; label: string; pulse: boolean }> = {
  LIVE:    { dot: "bg-emerald-400", text: "text-emerald-400", label: "live",    pulse: true },
  CBOE:    { dot: "bg-sky-400",     text: "text-sky-400",     label: "cboe",    pulse: false },
  STALE:   { dot: "bg-amber-400",   text: "text-amber-400",   label: "stale",   pulse: false },
  OFFLINE: { dot: "bg-zinc-500",    text: "text-zinc-500",    label: "offline", pulse: false },
};

// A value is "usable" if it's present and not a meaningless zero. We treat 0 as
// missing because every disconnected payload in this app backfills zeros where
// a real reading would never legitimately be exactly 0 (PCR, spot, change%).
function hasUsableValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export interface LivenessBadgeProps {
  /** Short feed name shown on the pill, e.g. "flow", "quotes", "options". */
  feedName: string;
  /** The actual data we're rendering — drives OFFLINE detection. */
  value?: unknown;
  /** Whether this feed normally needs a live Schwab connection. Default true. */
  requiresSchwab?: boolean;
  /** Optional pre-fetched status if the parent already has it. */
  status?: SchwabStatus;
  className?: string;
}

export default function LivenessBadge({
  feedName,
  value,
  requiresSchwab = true,
  status: statusProp,
  className,
}: LivenessBadgeProps) {
  const { data: fetched } = useQuery<SchwabStatus>({
    queryKey: ["/api/schwab/status"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/schwab/status");
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    // Skip the fetch entirely when the parent handed us status.
    enabled: statusProp == null,
  });

  const status = statusProp ?? fetched;
  const schwabLive = !!status && status.connected && !status.needsReauth;
  const usable = hasUsableValue(value);

  const state: LivenessState = !usable
    ? "OFFLINE"
    : !requiresSchwab
      ? "CBOE"
      : schwabLive
        ? "LIVE"
        : "STALE";

  const s = STATE_STYLE[state];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-current/30 px-1.5 py-0.5 text-[11px] font-medium ${s.text} ${className ?? ""}`}
      data-testid={`liveness-${feedName}`}
      title={`${feedName} · ${s.label}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.pulse ? "animate-pulse" : ""}`}
        aria-hidden
      />
      {s.label}
    </span>
  );
}
