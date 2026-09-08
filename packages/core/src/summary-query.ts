import type { DailyAggregate, ProjectDayBucket, ProjectModelDayBucket } from "./aggregates.js";
/** Read-only report filters over sealed daily aggregates and today's accumulator. */
import type { AliasMap } from "./alias-service.js";
import { resolveProjectName } from "./alias-service.js";
import { localDateKey } from "./date-utils.js";
import { projectNameIncludes } from "./project-name.js";
import type { ScanOptions, TokenRecord } from "./types.js";

const SUM_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "cost",
  "recordCount",
] as const;
type Totals = Pick<DailyAggregate, (typeof SUM_FIELDS)[number]>;

function zeroTotals(): Totals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    recordCount: 0,
  };
}

function addTotals(target: Totals, source: Totals): void {
  for (const field of SUM_FIELDS) target[field] += source[field];
}

function dateBound(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(`${value}T12:00:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    localDateKey(date.getTime()) !== value
  ) {
    throw new Error(
      `${name} must be a valid YYYY-MM-DD date; aggregate reports do not support intraday timestamps.`
    );
  }
  return value;
}

export function createSummaryQuery(options: ScanOptions, aliases: AliasMap, now = Date.now()) {
  let since = dateBound(options.since, "since");
  let until = dateBound(options.until, "until");
  const today = new Date(now);
  if (options.today) {
    since = until = localDateKey(now);
  } else if (options.week) {
    today.setDate(today.getDate() - 6);
    since = localDateKey(today.getTime());
    until = localDateKey(now);
  } else if (options.month) {
    since = localDateKey(new Date(today.getFullYear(), today.getMonth(), 1).getTime());
    until = localDateKey(now);
  } else if (options.year !== undefined) {
    if (!Number.isInteger(options.year) || options.year < 1000 || options.year > 9999) {
      throw new Error("year must be a four-digit calendar year.");
    }
    since = `${options.year}-01-01`;
    until = `${options.year}-12-31`;
  }
  if (since && until && since > until) throw new Error("since must be on or before until.");

  const providers = options.providers?.length ? new Set(options.providers) : null;
  const matchesDay = (day: string) => (!since || day >= since) && (!until || day <= until);
  const matchesProject = (project: string) =>
    !options.project ||
    projectNameIncludes(project, options.project) ||
    projectNameIncludes(resolveProjectName(project, aliases), options.project);
  return {
    narrowed: Boolean(since || until || providers || options.project),
    narrowedBuckets: Boolean(providers || options.project),
    matchesRecord: (record: TokenRecord) =>
      matchesDay(localDateKey(record.timestamp)) &&
      matchesProject(record.project) &&
      (!providers || providers.has(record.provider)),
    selectDays(days: DailyAggregate[]): Map<string, DailyAggregate> {
      const selected = new Map<string, DailyAggregate>();
      for (const day of days) {
        if (!matchesDay(day.date)) continue;
        if (!providers && !options.project) {
          selected.set(day.date, day);
          continue;
        }
        const result: DailyAggregate = {
          ...zeroTotals(),
          date: day.date,
          firstUsed: Number.POSITIVE_INFINITY,
          lastUsed: 0,
          models: Object.create(null),
          projects: Object.create(null),
          providers: Object.create(null),
        };
        for (const [name, project] of Object.entries(day.projects)) {
          if (!matchesProject(name)) continue;
          const buckets = Object.entries(project.modelBuckets).filter(
            ([, bucket]) => !providers || providers.has(bucket.provider)
          );
          if (!buckets.length) continue;
          const scoped: ProjectDayBucket = {
            ...project,
            ...zeroTotals(),
            models: [],
            modelBuckets: Object.create(null),
          };
          for (const [key, bucket] of buckets) {
            addTotals(scoped, bucket);
            scoped.modelBuckets[key] = bucket;
            if (!scoped.models.includes(bucket.model)) scoped.models.push(bucket.model);
            foldBucket(result, bucket, project);
          }
          result.projects[name] = scoped;
          addTotals(result, scoped);
          result.firstUsed = Math.min(result.firstUsed, scoped.firstUsed);
          result.lastUsed = Math.max(result.lastUsed, scoped.lastUsed);
        }
        if (Object.keys(result.projects).length) selected.set(day.date, result);
      }
      return selected;
    },
  };
}

function foldBucket(day: DailyAggregate, bucket: ProjectModelDayBucket, project: ProjectDayBucket) {
  day.models[bucket.model] ??= {
    ...zeroTotals(),
    model: bucket.model,
    providers: [],
  };
  const model = day.models[bucket.model];
  addTotals(model, bucket);
  if (!model.providers.includes(bucket.provider)) model.providers.push(bucket.provider);
  day.providers[bucket.provider] ??= {
    ...zeroTotals(),
    provider: bucket.provider,
    firstUsed: Number.POSITIVE_INFINITY,
    lastUsed: 0,
  };
  const provider = day.providers[bucket.provider];
  addTotals(provider, bucket);
  // Cross-cut buckets retain counts and costs, but only their parent's time bounds.
  provider.firstUsed = Math.min(provider.firstUsed, project.firstUsed);
  provider.lastUsed = Math.max(provider.lastUsed, project.lastUsed);
}
