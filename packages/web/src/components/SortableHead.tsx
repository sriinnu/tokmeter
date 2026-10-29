import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";
import type { SortState } from "../hooks/useSort.js";
import { cn } from "../lib/utils.js";
import { TableHead } from "./ui/table.js";

/** Column header that sorts on click/Enter and reports state via aria-sort. */
export function SortableHead<K extends string>({
  column,
  sort,
  onSort,
  children,
  align = "left",
  className,
}: {
  column: K;
  sort: SortState<K>;
  onSort: (column: K) => void;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
          active && "text-foreground"
        )}
      >
        {children}
        <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
      </button>
    </TableHead>
  );
}
