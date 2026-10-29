import { SortableHead } from "../../components/SortableHead.js";
import { EmptyState } from "../../components/states.js";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "../../components/ui/table.js";
import { useSort } from "../../hooks/useSort.js";
import type { TokmeterModelSummary } from "../../hooks/useTokmeterData.js";
import {
  formatCompact,
  formatCostPerMillion,
  formatCurrency,
  formatInteger,
  formatPercent,
} from "../../lib/format.js";

type Column =
  | "model"
  | "provider"
  | "cost"
  | "share"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "reasoning"
  | "total"
  | "perMillion";

const ACCESSORS: Record<Column, (m: TokmeterModelSummary) => number | string> = {
  model: (m) => m.model.toLowerCase(),
  provider: (m) => m.provider,
  cost: (m) => m.cost,
  share: (m) => m.cost,
  input: (m) => m.inputTokens,
  output: (m) => m.outputTokens,
  cacheRead: (m) => m.cacheReadTokens,
  cacheWrite: (m) => m.cacheWriteTokens,
  reasoning: (m) => m.reasoningTokens,
  total: (m) => m.totalTokens,
  perMillion: (m) => (m.totalTokens > 0 ? m.cost / m.totalTokens : -1),
};

/**
 * Every model with all five token buckets. `shareBase` sets what "share" is
 * of: pass a project's cost to get share-of-project (the payload's own
 * `percentageOfTotal` is share of ALL spend, even inside a project summary).
 */
export function ModelTable({
  models,
  shareBase,
}: {
  models: TokmeterModelSummary[];
  shareBase?: number;
}) {
  const { sorted, sort, toggle } = useSort(models, ACCESSORS, { key: "cost", direction: "desc" });
  if (models.length === 0) {
    return (
      <div className="px-4 pb-3">
        <EmptyState title="No models match" />
      </div>
    );
  }
  const share = (m: TokmeterModelSummary) =>
    shareBase === undefined ? m.percentageOfTotal / 100 : shareBase > 0 ? m.cost / shareBase : 0;
  const head = (
    column: Column,
    label: string,
    className?: string,
    align: "left" | "right" = "right"
  ) => (
    <SortableHead column={column} sort={sort} onSort={toggle} align={align} className={className}>
      {label}
    </SortableHead>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head("model", "Model", undefined, "left")}
          {head("provider", "Provider", "hidden md:table-cell", "left")}
          {head("cost", "Est. cost")}
          {head("share", "Share", "hidden sm:table-cell")}
          {head("input", "Input", "hidden lg:table-cell")}
          {head("output", "Output", "hidden lg:table-cell")}
          {head("cacheRead", "Cache read", "hidden xl:table-cell")}
          {head("cacheWrite", "Cache write", "hidden xl:table-cell")}
          {head("reasoning", "Reasoning", "hidden xl:table-cell")}
          {head("total", "Total tokens")}
          {head("perMillion", "$/1M", "hidden md:table-cell")}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((m) => (
          <TableRow key={`${m.provider}:${m.model}`}>
            <TableCell className="max-w-44 truncate font-medium sm:max-w-72" title={m.model}>
              {m.model}
              <div className="text-xs font-normal text-muted-foreground md:hidden">
                {m.provider}
              </div>
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">
              {m.provider}
            </TableCell>
            <TableCell className="num text-right font-medium">
              {m.cost === 0 && m.totalTokens > 0 ? (
                <span
                  className="text-muted-foreground"
                  title="No known price; counted as $0 in totals"
                >
                  unpriced
                </span>
              ) : (
                formatCurrency(m.cost)
              )}
            </TableCell>
            <TableCell className="num hidden text-right text-muted-foreground sm:table-cell">
              {formatPercent(share(m))}
            </TableCell>
            {[m.inputTokens, m.outputTokens].map((v, i) => (
              <TableCell
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed column order
                key={i}
                className="num hidden text-right lg:table-cell"
                title={formatInteger(v)}
              >
                {formatCompact(v)}
              </TableCell>
            ))}
            {[m.cacheReadTokens, m.cacheWriteTokens, m.reasoningTokens].map((v, i) => (
              <TableCell
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed column order
                key={i}
                className="num hidden text-right xl:table-cell"
                title={formatInteger(v)}
              >
                {formatCompact(v)}
              </TableCell>
            ))}
            <TableCell className="num text-right" title={formatInteger(m.totalTokens)}>
              {formatCompact(m.totalTokens)}
            </TableCell>
            <TableCell className="num hidden text-right text-muted-foreground md:table-cell">
              {formatCostPerMillion(
                m.totalTokens > 0 ? (m.cost / m.totalTokens) * 1_000_000 : null
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
