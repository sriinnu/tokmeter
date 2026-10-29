import { useState } from "react";
import { DayStateBadge } from "../../components/DayStateBadge.js";
import { SortableHead } from "../../components/SortableHead.js";
import { Button } from "../../components/ui/button.js";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "../../components/ui/table.js";
import { useSort } from "../../hooks/useSort.js";
import type { TokmeterDailyEntry, TokmeterScanMeta } from "../../hooks/useTokmeterData.js";
import { getDayState } from "../../lib/day-state.js";
import { formatCompact, formatCurrency, formatInteger, formatLongDate } from "../../lib/format.js";

type Column = "date" | "cost" | "tokens" | "input" | "output" | "cache" | "records";
const ACCESSORS: Record<Column, (d: TokmeterDailyEntry) => number | string> = {
  date: (d) => d.date,
  cost: (d) => d.cost,
  tokens: (d) => d.totalTokens,
  input: (d) => d.inputTokens,
  output: (d) => d.outputTokens,
  // Read + write: the two cache buckets. The 1h-TTL split is inside writes.
  cache: (d) => d.cacheReadTokens + d.cacheWriteTokens,
  records: (d) => d.records,
};
const PAGE = 31;

/** Every ledger day, verbatim, with its sealed/live state. */
export function DailyLedgerTable({
  daily,
  meta,
  todayKey,
}: {
  daily: TokmeterDailyEntry[];
  meta: TokmeterScanMeta;
  todayKey: string;
}) {
  const { sorted, sort, toggle } = useSort(daily, ACCESSORS, { key: "date", direction: "desc" });
  const [limit, setLimit] = useState(PAGE);
  const head = (column: Column, label: string, className?: string) => (
    <SortableHead
      column={column}
      sort={sort}
      onSort={toggle}
      align={column === "date" ? "left" : "right"}
      className={className}
    >
      {label}
    </SortableHead>
  );

  return (
    <div className="grid gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            {head("date", "Date")}
            {head("cost", "Est. cost")}
            {head("tokens", "Tokens")}
            {head("input", "Input", "hidden lg:table-cell")}
            {head("output", "Output", "hidden lg:table-cell")}
            {head("cache", "Cache r+w", "hidden md:table-cell")}
            {head("records", "Records", "hidden sm:table-cell")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.slice(0, limit).map((d) => (
            <TableRow key={d.date}>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num">{formatLongDate(d.date)}</span>
                  <DayStateBadge state={getDayState(d.date, todayKey, meta)} />
                </div>
              </TableCell>
              <TableCell className="num text-right font-medium">{formatCurrency(d.cost)}</TableCell>
              <TableCell className="num text-right" title={formatInteger(d.totalTokens)}>
                {formatCompact(d.totalTokens)}
              </TableCell>
              <TableCell className="num hidden text-right lg:table-cell">
                {formatCompact(d.inputTokens)}
              </TableCell>
              <TableCell className="num hidden text-right lg:table-cell">
                {formatCompact(d.outputTokens)}
              </TableCell>
              <TableCell className="num hidden text-right md:table-cell">
                {formatCompact(d.cacheReadTokens + d.cacheWriteTokens)}
              </TableCell>
              <TableCell className="num hidden text-right sm:table-cell">
                {formatInteger(d.records)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sorted.length > limit && (
        <div className="px-4 pb-2 sm:px-5">
          <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE * 3)}>
            Show more ({formatInteger(sorted.length - limit)} remaining)
          </Button>
        </div>
      )}
    </div>
  );
}
