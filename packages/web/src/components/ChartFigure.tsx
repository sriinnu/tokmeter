import { BarChart3, Table2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "../lib/utils.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.js";

export interface FigureTable {
  columns: Array<{ label: string; align?: "left" | "right" }>;
  rows: Array<{ key: string; cells: ReactNode[] }>;
}

/**
 * Every chart ships with its numbers. The chart is an `img` with a summary
 * label; the toggle swaps in a real table carrying the same values, which is
 * also the screen-reader path.
 */
export function ChartFigure({
  label,
  summary,
  table,
  children,
  toolbar,
  className,
}: {
  label: string;
  summary: string;
  table: FigureTable;
  children: ReactNode;
  toolbar?: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const captionId = useId();

  return (
    <figure className={cn("grid min-w-0 gap-3", className)} aria-labelledby={captionId}>
      <figcaption id={captionId} className="sr-only">
        {label}. {summary}
      </figcaption>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(value) => value && setView(value as "chart" | "table")}
          aria-label={`${label}: view as`}
        >
          <ToggleGroupItem value="chart" aria-label="Chart view">
            <BarChart3 aria-hidden />
            <span className="hidden sm:inline">Chart</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="table" aria-label="Table view">
            <Table2 aria-hidden />
            <span className="hidden sm:inline">Table</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {view === "chart" ? (
        <div role="img" aria-label={`${label}. ${summary}`}>
          {children}
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                {table.columns.map((column) => (
                  <TableHead
                    key={column.label}
                    className={cn(column.align === "right" && "text-right")}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row) => (
                <TableRow key={row.key}>
                  {row.cells.map((cell, index) => (
                    <TableCell
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                      key={index}
                      className={cn("num", table.columns[index]?.align === "right" && "text-right")}
                    >
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </figure>
  );
}
