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
import type { DailyAggregate, ProjectDayBucket } from "./aggregates.js";
import { type AliasMap, isProjectHidden, resolveProjectName } from "./alias-service.js";
import { localDateKey } from "./date-utils.js";
import { projectNameIncludes, projectNamesMatch } from "./project-name.js";
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
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
  opts?: { since?: string; until?: string; today?: boolean; project?: string }
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
  // Project-filtered path: walk per-(project, model) cross-cut buckets. Matches
  // legacy `aggregateByModel(filterByProject(records, project))` semantics —
  // grandTotal is the sum of the *filtered* set's cost, just like the legacy
  // path's `records.reduce((s, r) => s + r.cost)` over filtered records.
  if (opts?.project) {
    const query = opts.project;
    for (const day of iterateAllDays(aggregates, todayAccumulator)) {
      if (opts?.today && day.date !== todayKey) continue;
      if (opts?.since && day.date < opts.since) continue;
      if (opts?.until && day.date > opts.until) continue;
      for (const project of Object.values(day.projects)) {
        if (!projectNameIncludes(project.project, query)) continue;
        for (const mb of Object.values(project.modelBuckets)) {
          grandTotalCost += mb.cost;
          const key = `${mb.provider} ${mb.model}`;
          let row = totals.get(key);
          if (!row) {
            row = {
              provider: mb.provider,
              model: mb.model,
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
          row.cost += mb.cost;
          row.inputTokens += mb.inputTokens;
          row.outputTokens += mb.outputTokens;
          row.cacheReadTokens += mb.cacheReadTokens;
          row.cacheWriteTokens += mb.cacheWriteTokens;
          row.reasoningTokens += mb.reasoningTokens;
          row.totalTokens += mb.totalTokens;
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

/**
 * Per-(project, model) cross-cut accumulator. Sums one day's
 * ProjectModelDayBucket into a project-lifetime row.
 */
interface ProjectModelTotal {
  model: string;
  provider: ProviderId;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
}

/**
 * ProjectSummary[] from aggregates + today. Groups raw project names by
 * alias-resolved display, sums per-(model, provider) cross-cut buckets,
 * folds visibility (drop a display only when every raw mapping to it is
 * hidden), and emits the same shape as `aggregateByProject(records, aliases)`.
 *
 * Percentages are share-of-total cost across ALL projects (including hidden
 * ones), matching the legacy implementation that computes total before
 * filtering visibility.
 */
export function computeAllProjectsFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  aliases: AliasMap
): ProjectSummary[] {
  // Pass 1: grand total cost across all days (matches legacy's
  // `records.reduce((s, r) => s + r.cost)` on full input).
  let grandTotalCost = 0;
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    grandTotalCost += day.cost;
  }

  type Accum = {
    rawProjects: Set<string>;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    firstUsed: number;
    lastUsed: number;
    modelTotals: Map<string, ProjectModelTotal>;
    daily: Map<string, DailyEntry>;
  };

  const byDisplay = new Map<string, Accum>();

  const newAccum = (): Accum => ({
    rawProjects: new Set(),
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    firstUsed: Number.POSITIVE_INFINITY,
    lastUsed: Number.NEGATIVE_INFINITY,
    modelTotals: new Map(),
    daily: new Map(),
  });

  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    // Group day's raw projects by display name. Multiple raws may resolve to
    // the same display (alias merge) — sum them into one day-entry.
    const displaysOnDay = new Map<string, ProjectDayBucket[]>();
    for (const [raw, pb] of Object.entries(day.projects)) {
      const display = resolveProjectName(raw, aliases);
      const list = displaysOnDay.get(display) ?? [];
      list.push(pb);
      displaysOnDay.set(display, list);
    }

    for (const [display, buckets] of displaysOnDay) {
      let acc = byDisplay.get(display);
      if (!acc) {
        acc = newAccum();
        byDisplay.set(display, acc);
      }
      let dayCost = 0;
      let dayInput = 0;
      let dayOutput = 0;
      let dayCacheRead = 0;
      let dayCacheWrite = 0;
      let dayReasoning = 0;
      let dayRecords = 0;
      for (const pb of buckets) {
        acc.rawProjects.add(pb.project);
        acc.cost += pb.cost;
        acc.inputTokens += pb.inputTokens;
        acc.outputTokens += pb.outputTokens;
        acc.cacheReadTokens += pb.cacheReadTokens;
        acc.cacheWriteTokens += pb.cacheWriteTokens;
        acc.reasoningTokens += pb.reasoningTokens;
        if (pb.firstUsed > 0 && pb.firstUsed < acc.firstUsed) acc.firstUsed = pb.firstUsed;
        if (pb.lastUsed > acc.lastUsed) acc.lastUsed = pb.lastUsed;
        for (const mb of Object.values(pb.modelBuckets)) {
          const key = `${mb.provider} ${mb.model}`;
          let mt = acc.modelTotals.get(key);
          if (!mt) {
            mt = {
              model: mb.model,
              provider: mb.provider,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
              cost: 0,
            };
            acc.modelTotals.set(key, mt);
          }
          mt.cost += mb.cost;
          mt.inputTokens += mb.inputTokens;
          mt.outputTokens += mb.outputTokens;
          mt.cacheReadTokens += mb.cacheReadTokens;
          mt.cacheWriteTokens += mb.cacheWriteTokens;
          mt.reasoningTokens += mb.reasoningTokens;
          mt.totalTokens += mb.totalTokens;
        }
        dayCost += pb.cost;
        dayInput += pb.inputTokens;
        dayOutput += pb.outputTokens;
        dayCacheRead += pb.cacheReadTokens;
        dayCacheWrite += pb.cacheWriteTokens;
        dayReasoning += pb.reasoningTokens;
        dayRecords += pb.recordCount;
      }
      acc.daily.set(day.date, {
        date: day.date,
        cost: dayCost,
        inputTokens: dayInput,
        outputTokens: dayOutput,
        cacheReadTokens: dayCacheRead,
        cacheWriteTokens: dayCacheWrite,
        reasoningTokens: dayReasoning,
        totalTokens: dayInput + dayOutput + dayCacheRead + dayCacheWrite + dayReasoning,
        records: dayRecords,
      });
    }
  }

  const results: ProjectSummary[] = [];
  for (const [display, acc] of byDisplay) {
    // Visibility: a display stays if ANY raw mapping to it is non-hidden.
    let visible = false;
    for (const raw of acc.rawProjects) {
      if (!isProjectHidden(raw, aliases)) {
        visible = true;
        break;
      }
    }
    if (!visible) continue;

    const models: ModelSummary[] = [...acc.modelTotals.values()]
      .map((mt) => ({
        ...mt,
        percentageOfTotal: grandTotalCost > 0 ? (mt.cost / grandTotalCost) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    const providerMap = new Map<
      ProviderId,
      { cost: number; totalTokens: number; models: Set<string> }
    >();
    for (const mt of acc.modelTotals.values()) {
      let pv = providerMap.get(mt.provider);
      if (!pv) {
        pv = { cost: 0, totalTokens: 0, models: new Set() };
        providerMap.set(mt.provider, pv);
      }
      pv.cost += mt.cost;
      pv.totalTokens += mt.totalTokens;
      pv.models.add(mt.model);
    }
    const providers: ProviderSummary[] = [...providerMap.entries()]
      .map(([provider, t]) => ({
        provider,
        totalTokens: t.totalTokens,
        cost: t.cost,
        models: [...t.models],
        percentageOfTotal: grandTotalCost > 0 ? (t.cost / grandTotalCost) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    const dailyBreakdown = [...acc.daily.values()].sort((a, b) => a.date.localeCompare(b.date));

    results.push({
      project: display,
      totalTokens:
        acc.inputTokens +
        acc.outputTokens +
        acc.cacheReadTokens +
        acc.cacheWriteTokens +
        acc.reasoningTokens,
      totalCost: acc.cost,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
      reasoningTokens: acc.reasoningTokens,
      models,
      providers,
      dailyBreakdown,
      activeDays: dailyBreakdown.length,
      firstUsed: Number.isFinite(acc.firstUsed) ? acc.firstUsed : Number.POSITIVE_INFINITY,
      lastUsed: Number.isFinite(acc.lastUsed) ? acc.lastUsed : Number.NEGATIVE_INFINITY,
    });
  }
  return results;
}

/**
 * Single ProjectSummary lookup by name. First tries exact match
 * ({@link projectNamesMatch}), then falls back to substring
 * ({@link projectNameIncludes}) — same precedence as the legacy
 * `getProjectSummary`.
 */
export function computeProjectSummaryFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  aliases: AliasMap,
  projectName: string
): ProjectSummary | undefined {
  const all = computeAllProjectsFromState(aggregates, todayAccumulator, aliases);
  return (
    all.find((p) => projectNamesMatch(p.project, projectName)) ||
    all.find((p) => projectNameIncludes(p.project, projectName))
  );
}
