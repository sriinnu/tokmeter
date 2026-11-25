import { homedir } from "node:os";
import {
  type AliasMap,
  type DailyEntry,
  loadAliases,
  localDateKey,
  type ModelSummary,
  type ProjectSummary,
  type ProviderId,
  type ProviderSummary,
  projectNameIncludes,
  resolveProjectName,
  type ScanOptions,
  sanitizeDataLabel,
  type TokenRecord,
  type TokmeterCore,
  type TokmeterStats,
} from "@sriinnu/tokmeter";

/** Metadata from one scan — surfaced in tool outputs for transparency. */
export interface ScanMeta {
  /** Records the scan itself read (today's live files, or a bounded raw window). */
  recordCount: number;
  /** Number of records where pricing was unavailable (cost === 0 despite having tokens). */
  unpricedRecords: number;
  /** Model IDs that had no pricing data. */
  unpricedModels: string[];
  /** Milliseconds the scan took. */
  scanDurationMs: number;
}

/** The common scope/filter params many tools accept. */
export interface ScopeParams {
  scope?: string;
  since?: string;
  until?: string;
  project?: string;
  providers?: string[];
}

/** Inclusive local-calendar day window a scope resolves to; open ends mean unbounded. */
export interface ScopeWindow {
  since?: string;
  until?: string;
  /** Human label, with the exact dates for bounded scopes. */
  label: string;
}

/** A provider's share of the scope, with its request count. */
export interface ProviderRow extends ProviderSummary {
  recordCount: number;
}

/** Every number a ledger-backed tool reports, narrowed to one scope. */
export interface ScopedView {
  label: string;
  window: ScopeWindow;
  stats: TokmeterStats;
  models: ModelSummary[];
  /** Sorted by cost, most expensive first. */
  projects: ProjectSummary[];
  daily: DailyEntry[];
  providers: ProviderRow[];
  /**
   * Requests per `${provider} ${model}` row. Null when the saved per-project
   * buckets don't reconcile with the scope's record total (days sealed before
   * those buckets existed), so a tool shows "—" instead of a wrong count.
   */
  requestsByModel: Map<string, number> | null;
  meta: ScanMeta;
}

/** JSON-safe representation of {@link ScopedView} returned by the daemon HTTP API. */
export interface SerializedScopedView extends Omit<ScopedView, "requestsByModel"> {
  requestsByModel: Record<string, number> | null;
}

export function serializeScopedView(view: ScopedView): SerializedScopedView {
  let requestsByModel: Record<string, number> | null = null;
  if (view.requestsByModel !== null) {
    requestsByModel = Object.create(null) as Record<string, number>;
    for (const [key, count] of view.requestsByModel.entries()) {
      requestsByModel[key] = count;
    }
  }
  return {
    ...view,
    requestsByModel,
  };
}

export function deserializeScopedView(raw: SerializedScopedView): ScopedView {
  const requestsByModel =
    raw.requestsByModel === null
      ? null
      : new Map<string, number>(Object.entries(raw.requestsByModel));
  return {
    ...raw,
    requestsByModel,
  };
}

/** Records that carry tokens but no cost — pricing was unavailable for them. */
export function unpricedOf(
  records: TokenRecord[]
): Pick<ScanMeta, "unpricedRecords" | "unpricedModels"> {
  const unpriced = records.filter((r) => r.cost === 0 && r.inputTokens + r.outputTokens > 0);
  return {
    unpricedRecords: unpriced.length,
    unpricedModels: [...new Set(unpriced.map((r) => r.model))],
  };
}

/** Move a local YYYY-MM-DD key by whole calendar days (DST-safe: anchored at noon). */
export function shiftDayKey(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateKey(date.getTime());
}

/**
 * Resolve a tool's scope to local calendar days, exactly as core's summary
 * query does: week is today plus the six days before it, month is the
 * calendar month to date. Resolving here and handing core explicit dates means
 * the ledger totals and any raw records a tool reads cover the same days.
 */
export function resolveScopeWindow(params: ScopeParams, now = Date.now()): ScopeWindow {
  const today = localDateKey(now);
  if (params.scope === "today") return { since: today, until: today, label: `Today (${today})` };
  if (params.scope === "week") {
    const since = shiftDayKey(today, -6);
    return { since, until: today, label: `Last 7 Days (${since} → ${today})` };
  }
  if (params.scope === "month") {
    const since = `${today.slice(0, 8)}01`;
    return { since, until: today, label: `This Month (${since} → ${today})` };
  }
  if (params.since || params.until) {
    return {
      since: params.since,
      until: params.until,
      label: `${params.since ?? "beginning"} → ${params.until ?? today}`,
    };
  }
  return { label: "All Time" };
}

/** The ScanOptions core's getSummary needs to narrow to this scope. */
export function summaryOptions(params: ScopeParams, window: ScopeWindow): ScanOptions {
  const opts: ScanOptions = {};
  if (window.since) opts.since = window.since;
  if (window.until) opts.until = window.until;
  if (params.project) opts.project = params.project;
  if (params.providers && params.providers.length > 0) {
    opts.providers = params.providers as ProviderId[];
  }
  return opts;
}

type DayAggregate = ReturnType<TokmeterCore["getDailyAggregates"]>[number];

/** Core's summary-query project rule: substring of the raw or the aliased name. */
export function projectMatcher(
  query: string | undefined,
  aliases?: AliasMap
): (name: string) => boolean {
  if (!query) return () => true;
  const resolvedAliases = aliases ?? loadAliases(homedir());
  return (name) =>
    projectNameIncludes(name, query) ||
    projectNameIncludes(resolveProjectName(name, resolvedAliases), query);
}

/** Sealed days plus today's live aggregate, each day exactly once. */
function allDays(core: TokmeterCore): DayAggregate[] {
  const today = core.getTodayAggregate();
  return [
    ...core.getDailyAggregates().filter((day) => day.date !== today?.date),
    ...(today ? [today] : []),
  ];
}

/**
 * Provider rows and per-model request counts for a scope. getSummary returns
 * no provider breakdown and ModelSummary carries no request count, so both are
 * folded here from the same day aggregates getSummary reads, with the same
 * matching rules (inclusive local days; project substring on the raw or
 * aliased name; provider set). Without a project filter, providers come from
 * each day's own provider buckets, which also cover days sealed before the
 * per-project buckets existed.
 */
export function scopedBreakdown(core: TokmeterCore, opts: ScanOptions, aliases?: AliasMap) {
  const providerSet = opts.providers?.length ? new Set<string>(opts.providers) : null;
  const query = opts.project;
  const matchesProject = projectMatcher(query, aliases);
  const rows = new Map<
    string,
    { cost: number; totalTokens: number; recordCount: number; models: Set<string> }
  >();
  const row = (provider: string) => {
    let entry = rows.get(provider);
    if (!entry) {
      entry = { cost: 0, totalTokens: 0, recordCount: 0, models: new Set() };
      rows.set(provider, entry);
    }
    return entry;
  };
  const requestsByModel = new Map<string, number>();
  let bucketRecords = 0;

  for (const day of allDays(core)) {
    if (opts.since && day.date < opts.since) continue;
    if (opts.until && day.date > opts.until) continue;
    for (const [name, project] of Object.entries(day.projects)) {
      if (!matchesProject(name)) continue;
      for (const bucket of Object.values(project.modelBuckets)) {
        if (providerSet && !providerSet.has(bucket.provider)) continue;
        const model = sanitizeDataLabel(bucket.model) || "unknown";
        const key = `${bucket.provider} ${model}`;
        requestsByModel.set(key, (requestsByModel.get(key) ?? 0) + bucket.recordCount);
        bucketRecords += bucket.recordCount;
        if (query) {
          const entry = row(bucket.provider);
          entry.cost += bucket.cost;
          entry.totalTokens += bucket.totalTokens;
          entry.recordCount += bucket.recordCount;
          entry.models.add(model);
        }
      }
    }
    if (!query) {
      for (const [provider, bucket] of Object.entries(day.providers)) {
        if (providerSet && !providerSet.has(provider)) continue;
        const entry = row(provider);
        entry.cost += bucket.cost;
        entry.totalTokens += bucket.totalTokens;
        entry.recordCount += bucket.recordCount;
      }
      for (const model of Object.values(day.models)) {
        for (const provider of model.providers) {
          if (providerSet && !providerSet.has(provider)) continue;
          row(provider).models.add(sanitizeDataLabel(model.model) || "unknown");
        }
      }
    }
  }

  let grandTotal = 0;
  for (const entry of rows.values()) grandTotal += entry.cost;
  const providers: ProviderRow[] = [...rows.entries()]
    .map(([provider, entry]) => ({
      provider: provider as ProviderId,
      cost: entry.cost,
      totalTokens: entry.totalTokens,
      recordCount: entry.recordCount,
      models: [...entry.models],
      percentageOfTotal: grandTotal > 0 ? (entry.cost / grandTotal) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
  return { providers, requestsByModel, bucketRecords };
}

/**
 * Pure ledger-backed ScopedView computation over an already-warm `TokmeterCore`
 * and its recent records. Used both by the daemon's `/api/scoped-view` endpoint
 * and by the MCP server's local fallback.
 */
export function computeScopedView(
  core: TokmeterCore,
  records: TokenRecord[],
  meta: ScanMeta,
  params: ScopeParams,
  now = Date.now()
): ScopedView {
  const window = resolveScopeWindow(params, now);
  const opts = summaryOptions(params, window);
  const aliases = loadAliases(core.getHomeDir());
  const summary = core.getSummary(opts);
  const breakdown = scopedBreakdown(core, opts, aliases);
  const today = localDateKey(now);
  const coversToday =
    (!window.since || window.since <= today) && (!window.until || window.until >= today);
  const matchesProject = projectMatcher(opts.project, aliases);
  const todayInScope = coversToday
    ? records.filter(
        (r) =>
          localDateKey(r.timestamp) === today &&
          (!opts.providers || opts.providers.includes(r.provider)) &&
          matchesProject(r.project)
      )
    : [];
  return {
    label: window.label,
    window,
    stats: summary.stats,
    models: summary.models,
    projects: [...summary.projects].sort((a, b) => b.totalCost - a.totalCost),
    daily: summary.daily,
    providers: breakdown.providers,
    requestsByModel:
      breakdown.bucketRecords === summary.stats.totalRecords ? breakdown.requestsByModel : null,
    meta: { ...meta, ...unpricedOf(todayInScope) },
  };
}
