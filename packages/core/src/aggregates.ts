/**
 * @sriinnu/tokmeter-core — Daily aggregates.
 *
 * The aggregate-based history model: completed days are stored as compact
 * per-day rollups (per-model + per-project + per-provider buckets) instead of
 * as raw TokenRecord arrays. This is the change that lets the daemon hold
 * months of history in ~few MB instead of ~1.5 GB, eliminates the V8 GC pauses
 * that were freezing interactive UI (Ghostty), and makes lifetime queries
 * a sum-over-aggregates instead of a sum-over-270k-records.
 *
 * Invariants:
 *   - A `DailyAggregate` is FROZEN once a day is past. Same immutability rule
 *     as the raw-records snapshot it replaces: yesterday never reprices unless
 *     `rescanHistory` is explicitly invoked.
 *   - Aggregates are derived purely from records via {@link aggregateRecordsByDay}.
 *     The function is the SINGLE definition of "how a day rolls up", so every
 *     reader (cold scan, snapshot load, today-merge) sees the same shape.
 *   - Maps are serialized as `Record<string, T>` (plain objects) so JSON
 *     round-trips losslessly. No `Map` / `Set` instances escape this module.
 */

import { localDateKey } from "./date-utils.js";
import type { ProviderId, TokenRecord } from "./types.js";

/** Token-bucket sub-totals shared by per-day, per-model, per-project, etc. */
export interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/** Per-model rollup within a single day. */
export interface ModelDayBucket extends TokenBuckets {
  model: string;
  /** Distinct providers that recorded under this model on this day (rare to
   *  have >1, but possible — e.g. `gpt-5` via OpenAI direct and via Codex). */
  providers: ProviderId[];
  cost: number;
  totalTokens: number;
  recordCount: number;
}

/** Per-project rollup within a single day. */
export interface ProjectDayBucket extends TokenBuckets {
  /** Raw project name as it appeared in the records — alias-resolution
   *  happens at READ time so a single aggregate file stays correct if the
   *  user later edits their alias map. */
  project: string;
  cost: number;
  totalTokens: number;
  recordCount: number;
  /** Distinct models used by this project on this day. */
  models: string[];
}

/** Per-provider rollup within a single day. */
export interface ProviderDayBucket extends TokenBuckets {
  provider: ProviderId;
  cost: number;
  totalTokens: number;
  recordCount: number;
}

/**
 * The aggregate representation of one calendar day's activity. Each field is
 * a complete, self-contained summary of that day — no need to re-derive from
 * records when answering any reporting question.
 */
export interface DailyAggregate {
  /** Local-calendar date key (YYYY-MM-DD). */
  date: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  recordCount: number;
  /** Earliest record timestamp on this day, epoch ms. */
  firstUsed: number;
  /** Latest record timestamp on this day, epoch ms. */
  lastUsed: number;
  /** Per-model breakdown, keyed by raw model id. */
  models: Record<string, ModelDayBucket>;
  /** Per-project breakdown, keyed by raw project name (pre-alias). */
  projects: Record<string, ProjectDayBucket>;
  /** Per-provider breakdown. */
  providers: Record<string, ProviderDayBucket>;
}

function emptyBuckets(): TokenBuckets {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

function addBuckets(target: TokenBuckets, r: TokenRecord): void {
  target.inputTokens += r.inputTokens;
  target.outputTokens += r.outputTokens;
  target.cacheReadTokens += r.cacheReadTokens;
  target.cacheWriteTokens += r.cacheWriteTokens;
  target.reasoningTokens += r.reasoningTokens;
}

function tokensTotal(b: TokenBuckets): number {
  return (
    b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.reasoningTokens
  );
}

function newDay(date: string): DailyAggregate {
  return {
    date,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    recordCount: 0,
    firstUsed: Number.POSITIVE_INFINITY,
    lastUsed: Number.NEGATIVE_INFINITY,
    models: {},
    projects: {},
    providers: {},
  };
}

/**
 * Roll an array of records up into per-day aggregates. Sorted by date ascending.
 * Single pass, O(N) over records + O(M) finalize pass over distinct days.
 *
 * The cost, token, and record-count totals at every level (day / per-model /
 * per-project / per-provider) are sums of the same underlying field on each
 * record, so a record never contributes to more than one bucket per level.
 */
export function aggregateRecordsByDay(records: TokenRecord[]): DailyAggregate[] {
  const byDate = new Map<string, DailyAggregate>();

  for (const r of records) {
    const date = localDateKey(r.timestamp);
    let day = byDate.get(date);
    if (!day) {
      day = newDay(date);
      byDate.set(date, day);
    }

    // Day-level totals.
    day.cost += r.cost;
    addBuckets(day, r);
    day.recordCount++;
    if (r.timestamp < day.firstUsed) day.firstUsed = r.timestamp;
    if (r.timestamp > day.lastUsed) day.lastUsed = r.timestamp;

    // Per-model bucket.
    let model = day.models[r.model];
    if (!model) {
      model = {
        model: r.model,
        providers: [],
        cost: 0,
        totalTokens: 0,
        recordCount: 0,
        ...emptyBuckets(),
      };
      day.models[r.model] = model;
    }
    model.cost += r.cost;
    addBuckets(model, r);
    model.recordCount++;
    if (!model.providers.includes(r.provider)) model.providers.push(r.provider);

    // Per-project bucket.
    let project = day.projects[r.project];
    if (!project) {
      project = {
        project: r.project,
        cost: 0,
        totalTokens: 0,
        recordCount: 0,
        models: [],
        ...emptyBuckets(),
      };
      day.projects[r.project] = project;
    }
    project.cost += r.cost;
    addBuckets(project, r);
    project.recordCount++;
    if (!project.models.includes(r.model)) project.models.push(r.model);

    // Per-provider bucket.
    let provider = day.providers[r.provider];
    if (!provider) {
      provider = {
        provider: r.provider,
        cost: 0,
        totalTokens: 0,
        recordCount: 0,
        ...emptyBuckets(),
      };
      day.providers[r.provider] = provider;
    }
    provider.cost += r.cost;
    addBuckets(provider, r);
    provider.recordCount++;
  }

  // Finalize totalTokens (sum of buckets) and sort.
  const days = [...byDate.values()];
  for (const day of days) {
    day.totalTokens = tokensTotal(day);
    for (const m of Object.values(day.models)) m.totalTokens = tokensTotal(m);
    for (const p of Object.values(day.projects)) p.totalTokens = tokensTotal(p);
    for (const pr of Object.values(day.providers)) pr.totalTokens = tokensTotal(pr);
    // Replace ±Infinity sentinels with 0 for empty days (defensive, shouldn't happen).
    if (!Number.isFinite(day.firstUsed)) day.firstUsed = 0;
    if (!Number.isFinite(day.lastUsed)) day.lastUsed = 0;
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

/**
 * Sum a list of {@link DailyAggregate} into a single grand total. Useful for
 * `getStats()` (sum aggregates → lifetime), `getModelCosts()` (group by model
 * across days), and any "sum the slice that matches my filter" question.
 *
 * Returns a NEW object — input aggregates are not mutated.
 */
export function sumAggregates(days: Iterable<DailyAggregate>): TotalsRollup {
  const rollup: TotalsRollup = {
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    recordCount: 0,
    activeDays: 0,
    firstUsed: Number.POSITIVE_INFINITY,
    lastUsed: Number.NEGATIVE_INFINITY,
    models: new Set<string>(),
    projects: new Set<string>(),
    providers: new Set<string>(),
  };
  for (const d of days) {
    rollup.cost += d.cost;
    rollup.inputTokens += d.inputTokens;
    rollup.outputTokens += d.outputTokens;
    rollup.cacheReadTokens += d.cacheReadTokens;
    rollup.cacheWriteTokens += d.cacheWriteTokens;
    rollup.reasoningTokens += d.reasoningTokens;
    rollup.totalTokens += d.totalTokens;
    rollup.recordCount += d.recordCount;
    rollup.activeDays++;
    if (d.firstUsed < rollup.firstUsed) rollup.firstUsed = d.firstUsed;
    if (d.lastUsed > rollup.lastUsed) rollup.lastUsed = d.lastUsed;
    for (const key of Object.keys(d.models)) rollup.models.add(key);
    for (const key of Object.keys(d.projects)) rollup.projects.add(key);
    for (const key of Object.keys(d.providers)) rollup.providers.add(key);
  }
  if (!Number.isFinite(rollup.firstUsed)) rollup.firstUsed = 0;
  if (!Number.isFinite(rollup.lastUsed)) rollup.lastUsed = 0;
  return rollup;
}

export interface TotalsRollup extends TokenBuckets {
  cost: number;
  totalTokens: number;
  recordCount: number;
  activeDays: number;
  firstUsed: number;
  lastUsed: number;
  /** Distinct model / project / provider IDENTIFIERS encountered. The caller
   *  decides whether to count them, resolve aliases, etc. */
  models: Set<string>;
  projects: Set<string>;
  providers: Set<string>;
}

/**
 * Longest run of consecutive calendar days present in the aggregate set, or
 * the current trailing run if it's longer. Same semantics as the streak
 * `getStats()` returns over raw records. Days are expected pre-sorted by date.
 */
export function longestConsecutiveDayStreak(days: DailyAggregate[]): number {
  if (days.length === 0) return 0;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < days.length; i++) {
    const diff =
      (new Date(days[i].date).getTime() - new Date(days[i - 1].date).getTime()) / 86_400_000;
    if (diff === 1) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return Math.max(longest, current);
}
