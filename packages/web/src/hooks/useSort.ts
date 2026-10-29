import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * Client-side sort over already-computed rows. Accessors return the raw
 * number/string; formatting stays in the cell so sorting never runs on a
 * "1.2M" string.
 */
export function useSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => number | string>,
  initial: SortState<NoInfer<K>>
) {
  const [sort, setSort] = useState<SortState<K>>(initial);

  const sorted = useMemo(() => {
    const get = accessors[sort.key];
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = get(a);
      const right = get(b);
      if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
      return String(left).localeCompare(String(right)) * factor;
    });
  }, [rows, accessors, sort]);

  const toggle = (key: K) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : // Numbers read best biggest-first; text reads best A→Z.
          { key, direction: typeof accessors[key](rows[0] as T) === "string" ? "asc" : "desc" }
    );

  return { sorted, sort, toggle };
}
