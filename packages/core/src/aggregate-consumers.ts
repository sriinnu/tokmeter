/**
 * @sriinnu/tokmeter-core — Aggregate-state pure computers.
 *
 * Pure functions that read from aggregate state (Map<date, DailyAggregate> +
 * today accumulator) and emit the same shapes the legacy records-walking
 * impls did. Parity-tested in aggregate-migration-parity.test.ts.
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

// ─── Shared shapes & helpers ───────────────────────────────────────────────

interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

interface CostedTokens extends Tokens {
  cost: number;
}

function zeroTokens(): Tokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

/** Add source's token fields into target in place. */
function addTokens(target: Tokens, source: Tokens): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
}

function sumTokens(t: Tokens): number {
  return (
    t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.reasoningTokens
  );
}

/** Yield each day's aggregate snapshot — historical first, then today. */
export function* iterateAllDays(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null
): Iterable<DailyAggregate> {
  const today = todayAccumulator?.toAggregate();
  // The live accumulator is the single owner of its date. If the same date is
  // also present in the sealed map (e.g. a sealed <today>.json reloaded by a
  // full scan, or a backward wall-clock step across midnight), skip the map
  // copy so the day is never counted twice.
  const todayDate = today?.date;
  for (const day of aggregates.values()) {
    if (todayDate !== undefined && day.date === todayDate) continue;
    yield day;
  }
  if (today) yield today;
}

/** Test whether a day passes the since/until/today date window. */
function dayInWindow(
  day: DailyAggregate,
  opts: { since?: string; until?: string; today?: boolean } | undefined,
  todayKey: string | undefined
): boolean {
  if (opts?.today && day.date !== todayKey) return false;
  if (opts?.since && day.date < opts.since) return false;
  if (opts?.until && day.date > opts.until) return false;
  return true;
}

function makeFilter(providers: ProviderId[] | undefined): Set<ProviderId> | null {
  return providers && providers.length > 0 ? new Set(providers) : null;
}

/** Build an alias-resolved display visibility map and add visible displays to set. */
function recordDisplayVisibility(
  rawProject: string,
  aliases: AliasMap,
  visible: Map<string, boolean>
): void {
  const display = resolveProjectName(rawProject, aliases);
  const isHidden = aliases[rawProject]?.hidden === true;
  if (!isHidden) visible.set(display, true);
  else if (!visible.has(display)) visible.set(display, false);
}

function longestConsecutiveStreak(days: Set<string>): number {
  const sorted = [...days].sort();
  let longest = 0;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / 86_400_000;
    if (diff === 1) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return Math.max(longest, current, sorted.length > 0 ? 1 : 0);
}

// ─── Stats ─────────────────────────────────────────────────────────────────

/** Legacy single-pass stats from a record array. Kept for callers that already
 *  hand us a pre-filtered set. */
export function computeStatsFromRecords(records: TokenRecord[], aliases: AliasMap): TokmeterStats {
  const tokens = zeroTokens();
  let totalCost = 0;
  let firstUsed = Number.POSITIVE_INFINITY;
  let lastUsed = Number.NEGATIVE_INFINITY;
  const displayVisible = new Map<string, boolean>();
  const projectSet = new Set<string>();
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();
  const daySet = new Set<string>();
  for (const r of records) {
    addTokens(tokens, r);
    totalCost += r.cost;
    if (r.timestamp < firstUsed) firstUsed = r.timestamp;
    if (r.timestamp > lastUsed) lastUsed = r.timestamp;
    recordDisplayVisibility(r.project, aliases, displayVisible);
    modelSet.add(r.model);
    providerSet.add(r.provider);
    daySet.add(localDateKey(r.timestamp));
  }
  for (const [display, v] of displayVisible) if (v) projectSet.add(display);
  return {
    totalTokens: sumTokens(tokens),
    totalCost,
    ...tokens,
    totalRecords: records.length,
    projects: projectSet.size,
    models: modelSet.size,
    providers: providerSet.size,
    activeDays: daySet.size,
    longestStreak: longestConsecutiveStreak(daySet),
    firstUsed: records.length ? firstUsed : 0,
    lastUsed: records.length ? lastUsed : 0,
  };
}

export function computeStatsFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  aliases: AliasMap,
  opts?: { providers?: ProviderId[] }
): TokmeterStats {
  const filter = makeFilter(opts?.providers);
  const tokens = zeroTokens();
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
    if (!filter) {
      // Unfiltered fast path — day-level sums already cover everything.
      addTokens(tokens, day);
      totalCost += day.cost;
      totalRecords += day.recordCount;
      if (day.recordCount > 0) {
        if (day.firstUsed < firstUsed) firstUsed = day.firstUsed;
        if (day.lastUsed > lastUsed) lastUsed = day.lastUsed;
        daySet.add(day.date);
      }
      for (const m of Object.keys(day.models)) modelSet.add(m);
      for (const p of Object.keys(day.providers)) providerSet.add(p);
      for (const raw of Object.keys(day.projects)) {
        recordDisplayVisibility(raw, aliases, displayVisible);
      }
      continue;
    }
    // Provider-filtered: sum matching per-provider buckets for totals.
    let dayRecords = 0;
    for (const [pid, pb] of Object.entries(day.providers)) {
      if (!filter.has(pid as ProviderId)) continue;
      providerSet.add(pid);
      addTokens(tokens, pb);
      totalCost += pb.cost;
      dayRecords += pb.recordCount;
      if (pb.firstUsed > 0 && pb.firstUsed < firstUsed) firstUsed = pb.firstUsed;
      if (pb.lastUsed > lastUsed) lastUsed = pb.lastUsed;
    }
    if (dayRecords > 0) {
      totalRecords += dayRecords;
      daySet.add(day.date);
    }
    // Distinct project/model counts come from per-(project, model) cross-cut.
    for (const [raw, pb] of Object.entries(day.projects)) {
      let matched = false;
      for (const mb of Object.values(pb.modelBuckets)) {
        if (!filter.has(mb.provider)) continue;
        modelSet.add(mb.model);
        matched = true;
      }
      if (matched) recordDisplayVisibility(raw, aliases, displayVisible);
    }
  }

  for (const [display, v] of displayVisible) if (v) projectSet.add(display);
  return {
    totalTokens: sumTokens(tokens),
    totalCost,
    ...tokens,
    totalRecords,
    projects: projectSet.size,
    models: modelSet.size,
    providers: providerSet.size,
    activeDays: daySet.size,
    longestStreak: longestConsecutiveStreak(daySet),
    firstUsed: totalRecords ? firstUsed : 0,
    lastUsed: totalRecords ? lastUsed : 0,
  };
}

// ─── Daily breakdown ───────────────────────────────────────────────────────

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

export function computeDailyBreakdownFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  opts?: { since?: string; until?: string; project?: string; providers?: ProviderId[] }
): DailyEntry[] {
  const projectMatch = opts?.project?.toLowerCase();
  const filter = makeFilter(opts?.providers);
  const out: DailyEntry[] = [];
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    if (!dayInWindow(day, { since: opts?.since, until: opts?.until }, undefined)) continue;
    if (!projectMatch && !filter) {
      out.push(dayToEntry(day));
      continue;
    }
    const sum: CostedTokens & { records: number } = {
      ...zeroTokens(),
      cost: 0,
      records: 0,
    };
    for (const [name, bucket] of Object.entries(day.projects)) {
      if (projectMatch && !projectNameIncludes(name, projectMatch)) continue;
      if (!filter) {
        addTokens(sum, bucket);
        sum.cost += bucket.cost;
        sum.records += bucket.recordCount;
        continue;
      }
      for (const mb of Object.values(bucket.modelBuckets)) {
        if (!filter.has(mb.provider)) continue;
        addTokens(sum, mb);
        sum.cost += mb.cost;
        sum.records += mb.recordCount;
      }
    }
    if (sum.records === 0) continue;
    out.push({
      date: day.date,
      totalTokens: sumTokens(sum),
      ...sum,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ─── Raw project names ─────────────────────────────────────────────────────

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

// ─── Model costs ───────────────────────────────────────────────────────────

interface ModelTotal extends CostedTokens {
  provider: ProviderId;
  model: string;
  totalTokens: number;
}

function emptyModelTotal(provider: ProviderId, model: string): ModelTotal {
  return { provider, model, totalTokens: 0, cost: 0, ...zeroTokens() };
}

function modelTotalsToSummaries(
  totals: Iterable<ModelTotal>,
  grandTotalCost: number
): ModelSummary[] {
  return [...totals]
    .map((row) => ({
      ...row,
      percentageOfTotal: grandTotalCost > 0 ? (row.cost / grandTotalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/** Add a per-(project, model) cross-cut bucket into a ModelTotal row. */
function foldCrossCut(
  totals: Map<string, ModelTotal>,
  mb: { provider: ProviderId; model: string; cost: number; totalTokens: number } & Tokens
): void {
  const key = `${mb.provider} ${mb.model}`;
  let row = totals.get(key);
  if (!row) {
    row = emptyModelTotal(mb.provider, mb.model);
    totals.set(key, row);
  }
  row.cost += mb.cost;
  addTokens(row, mb);
  row.totalTokens += mb.totalTokens;
}

export function computeModelCostsFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  opts?: {
    since?: string;
    until?: string;
    today?: boolean;
    project?: string;
    providers?: ProviderId[];
  }
): ModelSummary[] {
  const todayKey = todayAccumulator?.date;
  const filter = makeFilter(opts?.providers);
  const totals = new Map<string, ModelTotal>();
  let grandTotalCost = 0;

  // Cross-cut path: any project or provider filter walks per-(project, model)
  // buckets so the (provider, model) pairing is exact.
  if (opts?.project || filter) {
    const query = opts?.project;
    for (const day of iterateAllDays(aggregates, todayAccumulator)) {
      if (!dayInWindow(day, opts, todayKey)) continue;
      for (const project of Object.values(day.projects)) {
        if (query && !projectNameIncludes(project.project, query)) continue;
        for (const mb of Object.values(project.modelBuckets)) {
          if (filter && !filter.has(mb.provider)) continue;
          grandTotalCost += mb.cost;
          foldCrossCut(totals, mb);
        }
      }
    }
    return modelTotalsToSummaries(totals.values(), grandTotalCost);
  }

  // Unfiltered fast path: day-level model buckets. Multi-provider single-model
  // days even-split (best we can do at this granularity).
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    if (!dayInWindow(day, opts, todayKey)) continue;
    grandTotalCost += day.cost;
    for (const model of Object.values(day.models)) {
      const n = model.providers.length;
      for (const provider of model.providers) {
        const key = `${provider} ${model.model}`;
        let row = totals.get(key);
        if (!row) {
          row = emptyModelTotal(provider, model.model);
          totals.set(key, row);
        }
        const share = n === 1 ? 1 : 1 / n;
        row.cost += model.cost * share;
        row.inputTokens += model.inputTokens * share;
        row.outputTokens += model.outputTokens * share;
        row.cacheReadTokens += model.cacheReadTokens * share;
        row.cacheWriteTokens += model.cacheWriteTokens * share;
        row.reasoningTokens += model.reasoningTokens * share;
        row.totalTokens += model.totalTokens * share;
      }
    }
  }
  return modelTotalsToSummaries(totals.values(), grandTotalCost);
}

// ─── Provider breakdown ────────────────────────────────────────────────────

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

// ─── Projects ──────────────────────────────────────────────────────────────

interface ProjectAccum extends CostedTokens {
  rawProjects: Set<string>;
  firstUsed: number;
  lastUsed: number;
  modelTotals: Map<string, ModelTotal>;
  daily: Map<string, DailyEntry>;
}

function newProjectAccum(): ProjectAccum {
  return {
    ...zeroTokens(),
    cost: 0,
    rawProjects: new Set(),
    firstUsed: Number.POSITIVE_INFINITY,
    lastUsed: Number.NEGATIVE_INFINITY,
    modelTotals: new Map(),
    daily: new Map(),
  };
}

/** Fold one day's project buckets (already grouped by display) into the accumulator. */
function foldProjectDay(acc: ProjectAccum, date: string, buckets: ProjectDayBucket[]): void {
  const dayTotals: CostedTokens & { records: number } = {
    ...zeroTokens(),
    cost: 0,
    records: 0,
  };
  for (const pb of buckets) {
    acc.rawProjects.add(pb.project);
    addTokens(acc, pb);
    acc.cost += pb.cost;
    if (pb.firstUsed > 0 && pb.firstUsed < acc.firstUsed) acc.firstUsed = pb.firstUsed;
    if (pb.lastUsed > acc.lastUsed) acc.lastUsed = pb.lastUsed;
    for (const mb of Object.values(pb.modelBuckets)) foldCrossCut(acc.modelTotals, mb);
    addTokens(dayTotals, pb);
    dayTotals.cost += pb.cost;
    dayTotals.records += pb.recordCount;
  }
  acc.daily.set(date, {
    date,
    totalTokens: sumTokens(dayTotals),
    ...dayTotals,
  });
}

function projectAccumToSummary(
  display: string,
  acc: ProjectAccum,
  grandTotalCost: number
): ProjectSummary {
  const models = modelTotalsToSummaries(acc.modelTotals.values(), grandTotalCost);
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
  return {
    project: display,
    totalTokens: sumTokens(acc),
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
  };
}

/**
 * ProjectSummary[] from aggregates + today. Matches `aggregateByProject` —
 * percentages share the grand-total cost across ALL projects (including
 * hidden), and a display is dropped only when every raw mapping to it is
 * hidden.
 */
export function computeAllProjectsFromState(
  aggregates: Map<string, DailyAggregate>,
  todayAccumulator: DailyAccumulator | null,
  aliases: AliasMap
): ProjectSummary[] {
  let grandTotalCost = 0;
  for (const day of iterateAllDays(aggregates, todayAccumulator)) grandTotalCost += day.cost;

  const byDisplay = new Map<string, ProjectAccum>();
  for (const day of iterateAllDays(aggregates, todayAccumulator)) {
    const onDay = new Map<string, ProjectDayBucket[]>();
    for (const [raw, pb] of Object.entries(day.projects)) {
      const display = resolveProjectName(raw, aliases);
      const list = onDay.get(display) ?? [];
      list.push(pb);
      onDay.set(display, list);
    }
    for (const [display, buckets] of onDay) {
      let acc = byDisplay.get(display);
      if (!acc) {
        acc = newProjectAccum();
        byDisplay.set(display, acc);
      }
      foldProjectDay(acc, day.date, buckets);
    }
  }

  const results: ProjectSummary[] = [];
  for (const [display, acc] of byDisplay) {
    let visible = false;
    for (const raw of acc.rawProjects) {
      if (!isProjectHidden(raw, aliases)) {
        visible = true;
        break;
      }
    }
    if (!visible) continue;
    results.push(projectAccumToSummary(display, acc, grandTotalCost));
  }
  return results;
}

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
