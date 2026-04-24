import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useCallback } from "react";

export type SortDir = "asc" | "desc";
export interface SortState<K extends string = string> {
  key: K | null;
  dir: SortDir;
}

export function nextSort<K extends string>(prev: SortState<K>, key: K, defaultDir: SortDir = "desc"): SortState<K> {
  if (prev.key !== key) return { key, dir: defaultDir };
  if (prev.dir === defaultDir) return { key, dir: defaultDir === "desc" ? "asc" : "desc" };
  // third click clears sort
  return { key: null, dir: defaultDir };
}

/**
 * Generic comparator — handles numbers, strings, nulls. Numbers sort numerically, strings alpha.
 */
export function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const aNil = a == null || (typeof a === "number" && Number.isNaN(a));
  const bNil = b == null || (typeof b === "number" && Number.isNaN(b));
  if (aNil && bNil) return 0;
  if (aNil) return 1; // nulls last
  if (bNil) return -1;
  if (typeof a === "number" && typeof b === "number") {
    return dir === "asc" ? a - b : b - a;
  }
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  if (as < bs) return dir === "asc" ? -1 : 1;
  if (as > bs) return dir === "asc" ? 1 : -1;
  return 0;
}

export function sortRows<T, K extends string>(
  rows: T[],
  state: SortState<K>,
  getValue: (row: T, key: K) => unknown,
): T[] {
  if (!state.key) return rows;
  const key = state.key;
  const dir = state.dir;
  return [...rows].sort((a, b) => compareValues(getValue(a, key), getValue(b, key), dir));
}

interface SortableThProps<K extends string> {
  sortKey: K;
  label: React.ReactNode;
  state: SortState<K>;
  onSort: (next: SortState<K>) => void;
  defaultDir?: SortDir;
  className?: string;
  align?: "left" | "right" | "center";
  testId?: string;
}

export function SortableTh<K extends string>({
  sortKey, label, state, onSort, defaultDir = "desc", className = "", align = "left", testId,
}: SortableThProps<K>) {
  const active = state.key === sortKey;
  const alignCls = align === "right" ? "text-right justify-end" : align === "center" ? "text-center justify-center" : "text-left justify-start";
  const handle = useCallback(() => {
    onSort(nextSort(state, sortKey, defaultDir));
  }, [state, sortKey, defaultDir, onSort]);
  return (
    <th className={`${className} ${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"} select-none`}>
      <button
        type="button"
        onClick={handle}
        className={`inline-flex w-full items-center gap-1 ${alignCls} transition-colors hover:text-foreground ${active ? "text-foreground" : ""}`}
        data-testid={testId ?? `sort-${sortKey}`}
        aria-label={`Sort by ${typeof label === "string" ? label : sortKey}`}
      >
        <span>{label}</span>
        {active ? (
          state.dir === "asc"
            ? <ArrowUp className="h-3 w-3 shrink-0" />
            : <ArrowDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}
