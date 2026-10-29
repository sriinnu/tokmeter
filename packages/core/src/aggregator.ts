/**
 * @sriinnu/tokmeter-core — Aggregator.
 *
 * Groups parsed TokenRecords by project, model, provider, and date.
 */

import { type AliasMap, isProjectHidden, resolveProjectName } from "./alias-service.js";
import { toDateStr } from "./parsers/utils.js";
import { projectNameIncludes } from "./project-name.js";
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ProviderId,
  ProviderSummary,
  TokenRecord,
} from "./types.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight that starts `date` (YYYY-MM-DD). */
function localDayStart(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

/** Local midnight that starts the day after `date` — DST-safe. */
function localDayEnd(date: string): number {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * Filter records by date range, in LOCAL calendar days — the same days the
 * daily aggregates and `createSummaryQuery` use.
 *
 * A date-only bound used to go through `new Date("YYYY-MM-DD")`, which is UTC
 * midnight: in CET `--since 2026-10-28 --until 2026-10-28` dropped 00:00–01:00
 * on the 28th and took 00:00–01:00 on the 29th. `week` was a rolling 168 hours
 * (part of an eighth day) where the summary query uses the last 7 calendar
 * days. Cleanup selects session files through this helper too
 * (cleanup-service.ts), so its date window shifted the same way.
 * Bounds with a time component (`2026-10-28T13:00:00Z`) are taken as given.
 */
export function filterByDate(
  records: TokenRecord[],
  opts: {
    since?: string;
    until?: string;
    today?: boolean;
    week?: boolean;
    month?: boolean;
    year?: number;
  },
  now = Date.now()
): TokenRecord[] {
  const today = new Date(now);
  const todayKey = localDayKey(today);
  let since: number | undefined;
  let until: number | undefined; // exclusive

  if (opts.today) {
    since = localDayStart(todayKey);
    until = localDayEnd(todayKey);
  } else if (opts.week) {
    const first = new Date(now);
    first.setDate(first.getDate() - 6);
    since = localDayStart(localDayKey(first));
    until = localDayEnd(todayKey);
  } else if (opts.month) {
    since = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
    until = localDayEnd(todayKey);
  } else if (opts.year) {
    since = new Date(opts.year, 0, 1).getTime();
    until = new Date(opts.year + 1, 0, 1).getTime();
  } else {
    if (opts.since) {
      since = DATE_ONLY.test(opts.since)
        ? localDayStart(opts.since)
        : new Date(opts.since).getTime();
    }
    if (opts.until) {
      // A timestamp bound is inclusive, a date bound covers its whole day.
      until = DATE_ONLY.test(opts.until)
        ? localDayEnd(opts.until)
        : new Date(opts.until).getTime() + 1;
    }
  }

  return records.filter((r) => {
    if (since !== undefined && r.timestamp < since) return false;
    if (until !== undefined && r.timestamp >= until) return false;
    return true;
  });
}

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Filter records by provider. */
export function filterByProvider(records: TokenRecord[], providers: ProviderId[]): TokenRecord[] {
  if (!providers.length) return records;
  return records.filter((r) => providers.includes(r.provider));
}

/** Filter records by project name substring. */
export function filterByProject(records: TokenRecord[], project: string): TokenRecord[] {
  if (!project) return records;
  return records.filter((r) => projectNameIncludes(r.project, project));
}

/** Group records by a key extractor. */
function groupBy<K>(records: TokenRecord[], keyFn: (r: TokenRecord) => K): Map<K, TokenRecord[]> {
  const map = new Map<K, TokenRecord[]>();
  for (const r of records) {
    const key = keyFn(r);
    const arr = map.get(key) || [];
    arr.push(r);
    map.set(key, arr);
  }
  return map;
}

/** Sum tokens for a set of records. */
function sumTokens(records: TokenRecord[]) {
  return {
    input: records.reduce((s, r) => s + r.inputTokens, 0),
    output: records.reduce((s, r) => s + r.outputTokens, 0),
    cacheRead: records.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWrite: records.reduce((s, r) => s + r.cacheWriteTokens, 0),
    reasoning: records.reduce((s, r) => s + r.reasoningTokens, 0),
    total: records.reduce(
      (s, r) =>
        s +
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheWriteTokens +
        r.reasoningTokens,
      0
    ),
    cost: records.reduce((s, r) => s + r.cost, 0),
  };
}

/**
 * Aggregate records into per-project summaries.
 *
 * If `aliases` is provided: records are first grouped by the resolved
 * display name (so "Vortex" + "vortex" → one row), and projects flagged
 * `hidden: true` are dropped from the output (totals still reflect them
 * via `aggregator.sum*` callers that work on the raw record set).
 */
export function aggregateByProject(records: TokenRecord[], aliases?: AliasMap): ProjectSummary[] {
  const resolve = aliases ? (p: string) => resolveProjectName(p, aliases) : (p: string) => p;

  const grouped = groupBy(records, (r) => resolve(r.project));
  const totalCost = records.reduce((s, r) => s + r.cost, 0);

  return Array.from(grouped.entries())
    .filter(([, recs]) => {
      if (!aliases) return true;
      // Drop the row only when every raw project mapping to this display is
      // hidden. Any non-hidden contributor keeps it visible. O(N) total —
      // the group's own records already carry all raws for the display.
      const rawsForDisplay = new Set(recs.map((r) => r.project));
      for (const raw of rawsForDisplay) {
        if (!isProjectHidden(raw, aliases)) return true;
      }
      return false;
    })
    .map(([project, recs]) => {
      const sums = sumTokens(recs);
      const models = aggregateByModel(recs, totalCost);
      const providers = aggregateByProvider(recs, totalCost);
      const daily = aggregateByDate(recs);

      return {
        project,
        totalTokens: sums.total,
        totalCost: sums.cost,
        inputTokens: sums.input,
        outputTokens: sums.output,
        cacheReadTokens: sums.cacheRead,
        cacheWriteTokens: sums.cacheWrite,
        reasoningTokens: sums.reasoning,
        models,
        providers,
        dailyBreakdown: daily,
        activeDays: daily.length,
        firstUsed: recs.reduce((min, r) => Math.min(min, r.timestamp), Number.POSITIVE_INFINITY),
        lastUsed: recs.reduce((max, r) => Math.max(max, r.timestamp), Number.NEGATIVE_INFINITY),
      };
    });
}

/** Aggregate records into per-model summaries. */
export function aggregateByModel(records: TokenRecord[], totalCost?: number): ModelSummary[] {
  // Use a composite key that handles model names containing colons
  const SEP = "\u0000";
  const grouped = groupBy(records, (r) => `${r.provider}${SEP}${r.model}`);
  const total = totalCost ?? records.reduce((s, r) => s + r.cost, 0);

  return Array.from(grouped.entries())
    .map(([key, recs]) => {
      const sums = sumTokens(recs);
      const sepIdx = key.indexOf(SEP);
      const provider = key.slice(0, sepIdx);
      const model = key.slice(sepIdx + SEP.length);
      return {
        model,
        provider: provider as ProviderId,
        inputTokens: sums.input,
        outputTokens: sums.output,
        cacheReadTokens: sums.cacheRead,
        cacheWriteTokens: sums.cacheWrite,
        reasoningTokens: sums.reasoning,
        totalTokens: sums.total,
        cost: sums.cost,
        percentageOfTotal: total > 0 ? (sums.cost / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

/** Aggregate records into per-provider summaries. */
export function aggregateByProvider(records: TokenRecord[], totalCost?: number): ProviderSummary[] {
  const grouped = groupBy(records, (r) => r.provider);
  const total = totalCost ?? records.reduce((s, r) => s + r.cost, 0);

  return Array.from(grouped.entries())
    .map(([provider, recs]) => {
      const sums = sumTokens(recs);
      const models = [...new Set(recs.map((r) => r.model))];
      return {
        provider: provider as ProviderId,
        totalTokens: sums.total,
        cost: sums.cost,
        models,
        percentageOfTotal: total > 0 ? (sums.cost / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

/** Aggregate records into daily entries. */
export function aggregateByDate(records: TokenRecord[]): DailyEntry[] {
  const grouped = groupBy(records, (r) => toDateStr(r.timestamp));

  return Array.from(grouped.entries())
    .map(([date, recs]) => {
      const sums = sumTokens(recs);
      return {
        date,
        totalTokens: sums.total,
        inputTokens: sums.input,
        outputTokens: sums.output,
        cacheReadTokens: sums.cacheRead,
        cacheWriteTokens: sums.cacheWrite,
        reasoningTokens: sums.reasoning,
        cost: sums.cost,
        records: recs.length,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
