/**
 * DataAgeChip.tsx — small "Schwab · 42s" chip for chain-derived panels.
 *
 * Shows how old the Schwab data behind a panel is (from the server's
 * chainAsOfMs / asOfMs, the time Schwab produced it), and turns amber when the
 * server flagged the payload stale (re-served after a failed refresh, within
 * its max age). The server never sends data past its max age: then the panel
 * gets an unavailable state instead, and this chip shows "unavailable".
 */
import { useEffect, useState } from "react";

export interface DataAgeChipProps {
  /** When Schwab produced the data, epoch ms (seconds are accepted and converted). */
  asOfMs: number | null | undefined;
  /** Server stale flag. */
  stale?: boolean | null;
  /** Short label, e.g. "chain". */
  label?: string;
  className?: string;
}

function fmtAge(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export default function DataAgeChip({ asOfMs, stale, label = "Schwab", className }: DataAgeChipProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const ms = asOfMs == null || !Number.isFinite(asOfMs) ? null : asOfMs < 1e12 ? asOfMs * 1000 : asOfMs;
  if (ms == null) {
    return (
      <span
        className={`inline-flex items-center rounded border border-zinc-500/40 px-1 py-px font-mono text-[9px] text-zinc-400 ${className ?? ""}`}
        data-testid="data-age-chip"
        title="Schwab data unavailable"
      >
        {label} · unavailable
      </span>
    );
  }
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  const tone = stale
    ? "border-amber-500/50 text-amber-400"
    : "border-border/60 text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded border px-1 py-px font-mono text-[9px] tabular-nums ${tone} ${className ?? ""}`}
      data-testid="data-age-chip"
      title={`Schwab data as of ${new Date(ms).toLocaleTimeString()}${stale ? " (stale: refresh failed, last good payload within its max age)" : ""}`}
    >
      {label} · {fmtAge(sec)}{stale ? " stale" : ""}
    </span>
  );
}
