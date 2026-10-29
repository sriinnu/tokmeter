import { Badge } from "../../components/ui/badge.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import type { TokmeterDailyEntry } from "../../hooks/useTokmeterData.js";
import { parseDateKey } from "../../lib/dates.js";
import { formatCompact, formatCurrency, formatInteger } from "../../lib/format.js";

interface MonthRow {
  month: string;
  cost: number;
  totalTokens: number;
  records: number;
  activeDays: number;
}

/** Calendar-month sums of the daily ledger. The current month is still open. */
export function MonthlyTable({
  daily,
  todayKey,
}: {
  daily: TokmeterDailyEntry[];
  todayKey: string;
}) {
  const months = new Map<string, MonthRow>();
  for (const entry of daily) {
    const key = entry.date.slice(0, 7);
    const row = months.get(key) ?? {
      month: key,
      cost: 0,
      totalTokens: 0,
      records: 0,
      activeDays: 0,
    };
    row.cost += entry.cost;
    row.totalTokens += entry.totalTokens;
    row.records += entry.records;
    row.activeDays += 1;
    months.set(key, row);
  }
  const rows = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  const current = todayKey.slice(0, 7);
  const label = (month: string) =>
    new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
      parseDateKey(`${month}-01`)
    );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Month</TableHead>
          <TableHead className="text-right">Est. cost</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Active days</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Avg / active day</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.month}>
            <TableCell>
              <span className="flex flex-wrap items-center gap-2">
                {label(row.month)}
                {row.month === current && <Badge variant="live">In progress</Badge>}
              </span>
            </TableCell>
            <TableCell className="num text-right font-medium">{formatCurrency(row.cost)}</TableCell>
            <TableCell className="num text-right" title={formatInteger(row.totalTokens)}>
              {formatCompact(row.totalTokens)}
            </TableCell>
            <TableCell className="num hidden text-right sm:table-cell">{row.activeDays}</TableCell>
            <TableCell className="num hidden text-right text-muted-foreground sm:table-cell">
              {formatCurrency(row.activeDays > 0 ? row.cost / row.activeDays : 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
