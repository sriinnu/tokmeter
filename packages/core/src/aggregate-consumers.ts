/**
 * @sriinnu/tokmeter-core — Aggregate-state pure computers.
 *
 * Phase 2 of the cutover (docs/aggregate-snapshot-plan.md). Each consumer's
 * new implementation is a pure function that reads from the aggregate state
 * (Map<date, DailyAggregate> + a today accumulator snapshot) and produces the
 * same shape its legacy `this.records`-based sibling did. The class methods
 * in `tokmeter-core.ts` dispatch: if a caller passes raw records (legacy
 * `getStats(filteredRecords)` path used by daemon endpoints), the legacy
 * `*FromRecords` computer runs. Otherwise the new `*FromState` computer runs
 * against the live state. Parity tests in `aggregate-migration-parity.test.ts`
 * seed records, run BOTH computers, and assert they produce identical output
 * — so the migration is provably equivalent before `this.records` is retired
 * in Phase 3.
 *
 * Extracted into its own module so `tokmeter-core.ts` stays focused on the
 * class itself (scan / refresh lifecycle, kosha wiring, snapshot resolution)
 * and not on the math of every reporting method.
 */

import type { DailyAccumulator } from "./aggregates-store.js";
import type { DailyAggregate } from "./aggregates.js";
import { type AliasMap, resolveProjectName } from "./alias-service.js";
import { localDateKey } from "./date-utils.js";
import { projectNameIncludes } from "./project-name.js";
import type {
  DailyEntry,
  ModelSummary,
  ProviderId,
  ProviderSummary,
  TokenRecord,
  TokmeterStats,
} from "./types.js";

/** Yield each day's aggregate snapshot — historical first, then today. */
export function* iterateAllDays(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null
): Iterable<DailyAggregate> {
  yield* aggregates.values();
  const today = todayAccumulator?.toAggregate();
  if (today) yield today;
}

/**
 * Stats from raw records (the legacy `getStats` body, extracted as a pure
 * function). Kept around so the daemon's `filterByProvider(records).getStats`
 * path still works without an aggregate-aware filter API. Phase 3 retires
 * this once consumers stop passing pre-filtered records.
 */
export function computeStatsFromRecords(records: TokenRecord[], aliases: AliasMap): TokmeterStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let totalCost = 0;
  let firstUsed = Number.POSITIVE_INFINITY;
  let lastUsed = Number.NEGATIVE_INFINITY;
  const displayVisible = new Map<string, boolean>();
  const projectSet = new Set<string>();
  const modelSet = new Set<string>();
  const providerSet = new Set<unknown>();
  const daySet = new Set<string>();
  for (const r of records) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    cacheWriteTokens += r.cacheWriteTokens;
    reasoningTokens += r.reasoningTokens;
    totalCost += r.cost;
    if (r.timestamp < firstUsed) firstUsed = r.timestamp;
    if (r.timestamp > lastUsed) lastUsed = r.timestamp;
    const display = resolveProjectName(r.project, aliases);
    const isHidden = aliases[r.project]?.hidden === true;
    if (!isHidden) displayVisible.set(display, true);
    else if (!displayVisible.has(display)) displayVisible.set(display, false);
    modelSet.add(r.model);
    providerSet.add(r.provider);
    daySet.add(localDateKey(r.timestamp));
  }
  for (const [display, visible] of displayVisible) if (visible) projectSet.add(display);
  const days = [...daySet].sort();
  let longestStreak = 0;
  let currentStreak = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / 86_400_000;
    if (diff === 1) {
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else {
      currentStreak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, currentStreak, days.length > 0 ? 1 : 0);
  return {
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    totalCost,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalRecords: records.length,
    projects: projectSet.size,
    models: modelSet.size,
    providers: providerSet.size,
    activeDays: daySet.size,
    longestStreak,
    firstUsed: records.length ? firstUsed : 0,
    lastUsed: records.length ? lastUsed : 0,
  };
}

/**
 * Stats from aggregate state. Same output shape as
 * {@link computeStatsFromRecords}; parity-tested. The schema-level
 * equivalence holds because every per-day {@link DailyAggregate} already
 * sums the same fields the legacy single-pass loop summed — we just sum
 * across days instead of records.
 */
export function computeStatsFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  aliases: AliasMap
): TokmeterStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let totalCost = 0;
  let totalRecords = 0;
  let firstUsed = Number.POSITIVE_INFINITY;
  let lastUsed = Number.NEGATIVE_INFINITY;
  const displayVisible = new Map<string, boolean>();
  const projectSet = new Set<string>();
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();
  const daySet = new Set<string>();
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    inputTokens += day.inputTokens;
    outputTokens += day.outputTokens;
    cacheReadTokens += day.cacheReadTokens;
    cacheWriteTokens += day.cacheWriteTokens;
    reasoningTokens += day.reasoningTokens;
    totalCost += day.cost;
    totalRecords += day.recordCount;
    if (day.recordCount > 0) {
      if (day.firstUsed < firstUsed) firstUsed = day.firstUsed;
      if (day.lastUsed > lastUsed) lastUsed = day.lastUsed;
      daySet.add(day.date);
    }
    for (const key of Object.keys(day.models)) modelSet.add(key);
    for (const key of Object.keys(day.providers)) providerSet.add(key);
    for (const rawProject of Object.keys(day.projects)) {
      const display = resolveProjectName(rawProject, aliases);
      const isHidden = aliases[rawProject]?.hidden === true;
      if (!isHidden) displayVisible.set(display, true);
      else if (!displayVisible.has(display)) displayVisible.set(display, false);
    }
  }
  for (const [display, visible] of displayVisible) if (visible) projectSet.add(display);
  const sortedDays = [...daySet].sort();
  let longestStreak = 0;
  let currentStreak = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const diff =
      (new Date(sortedDays[i]).getTime() - new Date(sortedDays[i - 1]).getTime()) / 86_400_000;
    if (diff === 1) {
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else {
      currentStreak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, currentStreak, sortedDays.length > 0 ? 1 : 0);
  return {
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    totalCost,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalRecords,
    projects: projectSet.size,
    models: modelSet.size,
    providers: providerSet.size,
    activeDays: daySet.size,
    longestStreak,
    firstUsed: totalRecords ? firstUsed : 0,
    lastUsed: totalRecords ? lastUsed : 0,
  };
}

/** Convert one {@link DailyAggregate} to the public {@link DailyEntry} shape. */
function dayToEntry(day: DailyAggregate): DailyEntry {
  return {
    date: day.date,
    totalTokens: day.totalTokens,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    cacheReadTokens: day.cacheReadTokens,
    cacheWriteTokens: day.cacheWriteTokens,
    reasoningTokens: day.reasoningTokens,
    cost: day.cost,
    records: day.recordCount,
  };
}

/**
 * Daily breakdown from aggregates + today, with optional date/project filter.
 * Project filter projects onto each day's per-project bucket — same fuzzy
 * substring rule the legacy {@link filterByProject} uses on raw records.
 */
export function computeDailyBreakdownFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  opts?: { since?: string; until?: string; project?: string }
): DailyEntry[] {
  const projectMatch = opts?.project?.toLowerCase();
  const since = opts?.since;
  const until = opts?.until;
  const out: DailyEntry[] = [];
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    if (since && day.date < since) continue;
    if (until && day.date > until) continue;
    if (projectMatch) {
      let cost = 0;
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let reasoning = 0;
      let records = 0;
      for (const [name, bucket] of Object.entries(day.projects)) {
        if (!projectNameIncludes(name, projectMatch)) continue;
        cost += bucket.cost;
        input += bucket.inputTokens;
        output += bucket.outputTokens;
        cacheRead += bucket.cacheReadTokens;
        cacheWrite += bucket.cacheWriteTokens;
        reasoning += bucket.reasoningTokens;
        records += bucket.recordCount;
      }
      if (records === 0) continue;
      out.push({
        date: day.date,
        totalTokens: input + output + cacheRead + cacheWrite + reasoning,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
        cost,
        records,
      });
    } else {
      out.push(dayToEntry(day));
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Distinct raw project names across history + today. Aggregate path. */
export function computeRawProjectNamesFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null
): string[] {
  const names = new Set<string>();
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    for (const raw of Object.keys(day.projects)) names.add(raw);
  }
  return [...names];
}

/**
 * Per-model summaries from aggregates + today, with optional date filter.
 * The `project` filter requires per-(project, model) cross-cut buckets the
 * current schema doesn't capture — callers passing `options.project` stay on
 * the legacy records path until schema enrichment lands. Day-level date
 * filters (today / since / until) are handled natively here.
 */
export function computeModelCostsFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  opts?: { since?: string; until?: string; today?: boolean }
): ModelSummary[] {
  const todayKey = todayAccumulator?.date;
  const totals = new Map<
    string,
    {
      provider: ProviderId;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      cost: number;
    }
  >();
  let grandTotalCost = 0;
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    if (opts?.today && day.date !== todayKey) continue;
    if (opts?.since && day.date < opts.since) continue;
    if (opts?.until && day.date > opts.until) continue;
    grandTotalCost += day.cost;
    for (const model of Object.values(day.models)) {
      for (const provider of model.providers) {
        const key = `${provider} ${model.model}`;
        let row = totals.get(key);
        if (!row) {
          row = {
            provider,
            model: model.model,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cost: 0,
          };
          totals.set(key, row);
        }
        if (model.providers.length === 1) {
          row.cost += model.cost;
          row.inputTokens += model.inputTokens;
          row.outputTokens += model.outputTokens;
          row.cacheReadTokens += model.cacheReadTokens;
          row.cacheWriteTokens += model.cacheWriteTokens;
          row.reasoningTokens += model.reasoningTokens;
          row.totalTokens += model.totalTokens;
        } else {
          // Multi-provider single-model day → even split (best we can do
          // without per-(model, provider) cross-cut buckets).
          const n = model.providers.length;
          row.cost += model.cost / n;
          row.inputTokens += model.inputTokens / n;
          row.outputTokens += model.outputTokens / n;
          row.cacheReadTokens += model.cacheReadTokens / n;
          row.cacheWriteTokens += model.cacheWriteTokens / n;
          row.reasoningTokens += model.reasoningTokens / n;
          row.totalTokens += model.totalTokens / n;
        }
      }
    }
  }
  return [...totals.values()]
    .map((row) => ({
      ...row,
      percentageOfTotal: grandTotalCost > 0 ? (row.cost / grandTotalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Provider breakdown from aggregates + today. Reuses per-day perProvider
 * buckets for totals + walks per-day perModel.providers lists to compute
 * each provider's distinct-models set.
 */
export function computeProviderBreakdownFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null
): ProviderSummary[] {
  const totals = new Map<string, { cost: number; totalTokens: number; models: Set<string> }>();
  let grandTotalCost = 0;
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    grandTotalCost += day.cost;
    for (const [pid, bucket] of Object.entries(day.providers)) {
      let entry = totals.get(pid);
      if (!entry) {
        entry = { cost: 0, totalTokens: 0, models: new Set() };
        totals.set(pid, entry);
      }
      entry.cost += bucket.cost;
      entry.totalTokens += bucket.totalTokens;
    }
    for (const model of Object.values(day.models)) {
      for (const pid of model.providers) {
        let entry = totals.get(pid);
        if (!entry) {
          entry = { cost: 0, totalTokens: 0, models: new Set() };
          totals.set(pid, entry);
        }
        entry.models.add(model.model);
      }
    }
  }
  return [...totals.entries()]
    .map(([provider, t]) => ({
      provider: provider as ProviderId,
      totalTokens: t.totalTokens,
      cost: t.cost,
      models: [...t.models],
      percentageOfTotal: grandTotalCost > 0 ? (t.cost / grandTotalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}
