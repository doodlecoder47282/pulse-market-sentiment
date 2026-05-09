/**
 * TrackButton — universal start/stop tracking control for any signal.
 *
 * Drop into any signal row (flow alert, unusual flow, whale hit) to give
 * the user a manual track/close toggle. Hits /api/signals/track and
 * /api/signals/close on click. Reads /api/signals/tracked to determine
 * current tracked state.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

type Source = "flow-alert" | "unusual-flow" | "whale" | "manual";

interface Props {
  source: Source;
  symbol: string;
  type?: "C" | "P";
  strike?: number;
  expiration?: string;
  side?: "BULLISH" | "BEARISH" | "NEUTRAL";
  label?: string;
  entry?: { mark?: number | null; premium?: number | null; delta?: number | null; iv?: number | null; spot?: number | null; note?: string };
  meta?: Record<string, any>;
  /** Pass true if this item is currently tracked (parent reads /api/signals/tracked) */
  isTracked?: boolean;
  /** Pre-known tracked id (if known by parent), otherwise we recompute */
  trackedId?: string;
  size?: "xs" | "sm";
}

function makeId(p: Props): string {
  const parts: string[] = [p.source, p.symbol.toUpperCase()];
  if (p.type) parts.push(p.type);
  if (p.strike != null) parts.push(String(p.strike));
  if (p.expiration) parts.push(p.expiration);
  return parts.join(":");
}

export default function TrackButton(props: Props) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const id = props.trackedId ?? makeId(props);
  const isTracked = !!props.isTracked;

  const trackMut = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/signals/track", {
        source: props.source,
        symbol: props.symbol,
        type: props.type,
        strike: props.strike,
        expiration: props.expiration,
        side: props.side,
        label: props.label,
        entry: { at: Date.now(), ...(props.entry ?? {}) },
        meta: props.meta,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/signals/tracked"] });
    },
  });

  const closeMut = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/signals/close", { id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/signals/tracked"] });
    },
  });

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (isTracked) {
        await closeMut.mutateAsync();
      } else {
        await trackMut.mutateAsync();
      }
    } finally {
      setPending(false);
    }
  };

  const sizeClass = props.size === "sm"
    ? "text-[10px] px-2 py-0.5 h-5"
    : "text-[9px] px-1.5 py-0.5 h-4";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={`rounded border font-mono uppercase tracking-wider transition-colors ${sizeClass} ${
        isTracked
          ? "border-orange-500/50 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
          : "border-emerald-500/50 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
      } ${pending ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
      data-testid={`track-btn-${props.symbol}-${props.source}`}
      title={isTracked ? "Close tracking" : "Start tracking"}
    >
      {pending ? "..." : isTracked ? "stop" : "track"}
    </button>
  );
}
