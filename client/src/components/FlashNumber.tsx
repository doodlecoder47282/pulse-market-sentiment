// FlashNumber.tsx — number that briefly flashes green (up) or red (down),
// then fades back to neutral. 200ms flash + 400ms fade using CSS transitions.
// Uses prev-value tracking to detect direction without Framer Motion dep.

import { useEffect, useRef, useState } from "react";

interface FlashNumberProps {
  value: number | null | undefined;
  format?: (v: number) => string;
  className?: string;
  neutralClassName?: string;
}

type FlashState = "up" | "down" | "neutral";

export function FlashNumber({
  value,
  format,
  className = "",
  neutralClassName = "text-foreground",
}: FlashNumberProps) {
  const prevRef = useRef<number | null | undefined>(undefined);
  const [flash, setFlash] = useState<FlashState>("neutral");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Skip the very first render (no prev to compare)
    if (prevRef.current === undefined) {
      prevRef.current = value;
      return;
    }
    const prev = prevRef.current;
    prevRef.current = value;

    if (value == null || prev == null) return;
    if (value === prev) return;

    const dir: FlashState = value > prev ? "up" : "down";
    setFlash(dir);

    if (timerRef.current) clearTimeout(timerRef.current);
    // After 200ms flash, start fade-back — by switching to "neutral" which uses
    // the CSS transition to fade
    timerRef.current = setTimeout(() => {
      setFlash("neutral");
    }, 200);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]);

  const flashClass =
    flash === "up"
      ? "text-emerald-400"
      : flash === "down"
      ? "text-red-400"
      : neutralClassName;

  const display =
    value == null
      ? "—"
      : format
      ? format(value)
      : value.toString();

  return (
    <span
      className={`tabular-nums transition-colors duration-[400ms] ${flashClass} ${className}`}
      data-flash={flash}
    >
      {display}
    </span>
  );
}
