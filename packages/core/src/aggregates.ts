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
  /**
   * The 1-hour-TTL share of `cacheWriteTokens` — a SUBSET, never its own
   * bucket: it must stay out of every token total or the same tokens are
   * counted twice. Carried so "what would today cost on model X" prices
   * cache writes at the same TTL split the actual spend used. Absent on days
   * sealed before the field existed, which read as 0 (all-5m) — the old
   * behaviour, not a wrong one.
   */
  cacheWrite1hTokens?: number;
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

/**
 * Per-(project, model) cross-cut within a single day. Keyed by the same
 * ``${provider} ${model}`` composite the legacy {@link aggregateByModel}
 * uses, so reconstructing per-project ModelSummary arrays is a faithful sum
 * of these buckets across days. Per-provider sums fall out of these too —
 * each bucket carries its provider, so a project's provider breakdown is a
 * reduce-by-provider over its modelBuckets, no separate map needed.
 */
export interface ProjectModelDayBucket extends TokenBuckets {
  model: string;
  provider: ProviderId;
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
  /** Earliest record timestamp for this project on this day, epoch ms. */
  firstUsed: number;
  /** Latest record timestamp for this project on this day, epoch ms. */
  lastUsed: number;
  /** Distinct models used by this project on this day. */
  models: string[];
  /**
   * Per-(project, model) cross-cut buckets. Required by {@link getAllProjects}
   * / {@link getProjectSummary} / {@link getModelCosts}({project}) so they can
   * compute exact per-project ModelSummary + ProviderSummary without walking
   * raw records. Keyed by ``${provider} ${model}`` to match the legacy
   * aggregateByModel grouping.
   */
  modelBuckets: Record<string, ProjectModelDayBucket>;
}

/** Per-provider rollup within a single day. */
export interface ProviderDayBucket extends TokenBuckets {
  provider: ProviderId;
  cost: number;
  totalTokens: number;
  recordCount: number;
  /** Earliest record timestamp for this provider on this day, epoch ms. */
  firstUsed: number;
  /** Latest record timestamp for this provider on this day, epoch ms. */
  lastUsed: number;
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
  /** 1h-TTL share of cacheWriteTokens — a subset of it, never added to totals. */
  cacheWrite1hTokens?: number;
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
  /**
   * Cost bucketed by LOCAL hour-of-day (24 slots, index 0 = 00:00–00:59).
   * This is the intraday curve the pace signal needs — "typical spend by this
   * time of day" over recent days — so the daemon can answer it from the sealed
   * relay instead of re-parsing raw history. Optional: days sealed before this
   * field existed omit it, and pace simply skips those days (never treats a
   * missing curve as a $0 day, which would drag the baseline down).
   */
  costByHour?: number[];
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
  if (r.cacheWrite1hTokens) {
    target.cacheWrite1hTokens = (target.cacheWrite1hTokens ?? 0) + r.cacheWrite1hTokens;
  }
}

/** Fresh 24-slot hourly cost curve, all zero. */
export function emptyCostByHour(): number[] {
  return new Array(24).fill(0);
}

/**
 * Add a record's cost into its LOCAL hour slot on the day curve. Shared by the
 * cold-rebuild fold ({@link aggregateRecordsByDay}) and the live fold
 * (`foldRecordIntoDay`) so both produce byte-identical curves. Lazily seeds the
 * array so an old sealed day (loaded without `costByHour`) that later takes a
 * straggler fold doesn't crash — the seed then only reflects folded records,
 * which is the desired behavior for a re-derived day.
 */
export function foldCostByHour(day: DailyAggregate, r: TokenRecord): void {
  if (!day.costByHour) day.costByHour = emptyCostByHour();
  day.costByHour[new Date(r.timestamp).getHours()] += r.cost;
}

function tokensTotal(b: TokenBuckets): number {
  return (
    b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.reasoningTokens
  );
}

/**
 * A `Record`-shaped map keyed by untrusted strings (model / project / provider
 * names parsed from JSONL). Uses a null prototype so a hostile key like
 * `"__proto__"` or `"constructor"` becomes an ordinary own data property
 * instead of walking into `Object.prototype`: without this, `map["__proto__"]`
 * returns `Object.prototype` (a truthy stale bucket → pollution + a crash when
 * `.providers.includes` hits `undefined`), and `map["__proto__"] = x` silently
 * reassigns the prototype rather than storing the value. Null-proto keeps the
 * data (nothing lost) and costs nothing at access time. JSON-serializes as a
 * plain object, so the on-disk day-file format is unchanged.
 */
export function nullMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Shallow-copy a plain (possibly `JSON.parse`d) map into a null-prototype map,
 * preserving every own key — including a literal `"__proto__"` key, which
 * `JSON.parse` stores as an own data property and which copies across intact
 * because the null-proto target has no `__proto__` setter to intercept it.
 * Used to rehydrate day-file maps on read-back so the fold path is as safe as
 * the write path.
 */
export function toNullMap<T>(obj: Record<string, T> | undefined): Record<string, T> {
  return Object.assign(nullMap<T>(), obj ?? {});
}

/**
 * The single definition of "is this record fit to roll up". Both ingestion
 * paths — the cold scan ({@link aggregateRecordsByDay}) and the live daemon
 * fold — must apply this identically, or a rebuilt day disagrees with the
 * day that was accumulated live. Rejects non-finite / negative numerics and
 * empty model names: corrupt input, never real usage, so dropping it loses
 * no genuine data while keeping a poisoned JSONL line out of a frozen day file.
 */
/**
 * Stable per-record fingerprint for dedup. Same logical record arriving twice
 * (e.g. the Codex fork-dedup swapped a sibling and re-emitted identical content
 * from a different file) → same fingerprint → counted once. `sourceFile` is
 * deliberately excluded so the fingerprint is content-stable across the
 * fork-dedup winner-swap. `project` IS included: two different projects
 * hitting the same provider/model at the exact same millisecond with
 * identical token counts (and thus identical cost) are still two distinct
 * records, and without project in the key they'd wrongly collapse into one.
 * This is the SINGLE definition shared by the live fold (DailyAccumulator)
 * and the cold-scan rebuild (aggregateRecordsByDay), so a rebuilt day dedups
 * identically to the day accumulated live.
 */
export function recordFingerprint(r: TokenRecord): string {
  return `${r.timestamp}|${r.provider}|${r.model}|${r.project}|${r.inputTokens}|${r.outputTokens}|${r.cacheReadTokens}|${r.cacheWriteTokens}|${r.reasoningTokens}|${r.cost}`;
}

export function isValidRecord(r: TokenRecord): boolean {
  const nums = [
    r.timestamp,
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    r.reasoningTokens,
    r.cost,
  ];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false;
  }
  return typeof r.model === "string" && r.model.length > 0;
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
    models: nullMap(),
    projects: nullMap(),
    providers: nullMap(),
    costByHour: emptyCostByHour(),
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
  // Per-day fingerprint dedup, mirroring DailyAccumulator's live fold: a record
  // whose fingerprint was already folded into the same day is skipped, so a
  // cold rebuild collapses fork/resume duplicates identically to live and never
  // over-counts a gap-filled day.
  const seenByDate = new Map<string, Set<string>>();

  for (const r of records) {
    // Same validity gate as the live fold path, so a cold rebuild produces
    // byte-identical day totals to what was accumulated live.
    if (!isValidRecord(r)) continue;

    const date = localDateKey(r.timestamp);
    let day = byDate.get(date);
    let seen = seenByDate.get(date);
    if (!day) {
      day = newDay(date);
      byDate.set(date, day);
      seen = new Set<string>();
      seenByDate.set(date, seen);
    }
    const fp = recordFingerprint(r);
    if (seen!.has(fp)) continue;
    seen!.add(fp);

    // Day-level totals.
    day.cost += r.cost;
    addBuckets(day, r);
    foldCostByHour(day, r);
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
        firstUsed: Number.POSITIVE_INFINITY,
        lastUsed: Number.NEGATIVE_INFINITY,
        models: [],
        modelBuckets: nullMap(),
        ...emptyBuckets(),
      };
      day.projects[r.project] = project;
    }
    project.cost += r.cost;
    addBuckets(project, r);
    project.recordCount++;
    if (r.timestamp < project.firstUsed) project.firstUsed = r.timestamp;
    if (r.timestamp > project.lastUsed) project.lastUsed = r.timestamp;
    if (!project.models.includes(r.model)) project.models.push(r.model);
    // Per-(project, model) cross-cut bucket. Keyed by `${provider} ${model}`
    // so two providers using the same model name (rare but possible) don't
    // collapse.
    const projModelKey = `${r.provider} ${r.model}`;
    let projModel = project.modelBuckets[projModelKey];
    if (!projModel) {
      projModel = {
        model: r.model,
        provider: r.provider,
        cost: 0,
        totalTokens: 0,
        recordCount: 0,
        ...emptyBuckets(),
      };
      project.modelBuckets[projModelKey] = projModel;
    }
    projModel.cost += r.cost;
    addBuckets(projModel, r);
    projModel.recordCount++;

    // Per-provider bucket.
    let provider = day.providers[r.provider];
    if (!provider) {
      provider = {
        provider: r.provider,
        cost: 0,
        totalTokens: 0,
        recordCount: 0,
        firstUsed: Number.POSITIVE_INFINITY,
        lastUsed: Number.NEGATIVE_INFINITY,
        ...emptyBuckets(),
      };
      day.providers[r.provider] = provider;
    }
    provider.cost += r.cost;
    addBuckets(provider, r);
    provider.recordCount++;
    if (r.timestamp < provider.firstUsed) provider.firstUsed = r.timestamp;
    if (r.timestamp > provider.lastUsed) provider.lastUsed = r.timestamp;
  }

  // Finalize totalTokens (sum of buckets) and sort.
  const days = [...byDate.values()];
  for (const day of days) {
    day.totalTokens = tokensTotal(day);
    for (const m of Object.values(day.models)) m.totalTokens = tokensTotal(m);
    for (const p of Object.values(day.projects)) {
      p.totalTokens = tokensTotal(p);
      if (!Number.isFinite(p.firstUsed)) p.firstUsed = 0;
      if (!Number.isFinite(p.lastUsed)) p.lastUsed = 0;
      for (const pm of Object.values(p.modelBuckets)) pm.totalTokens = tokensTotal(pm);
    }
    for (const pr of Object.values(day.providers)) {
      pr.totalTokens = tokensTotal(pr);
      if (!Number.isFinite(pr.firstUsed)) pr.firstUsed = 0;
      if (!Number.isFinite(pr.lastUsed)) pr.lastUsed = 0;
    }
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

/**
 * Per-day replacement guard for windowed relay rebuilds (Deep Rescan).
 *
 * A sealed day may only be REPLACED by its rebuilt version when the rebuild
 * carries at least as much data — day total AND every provider bucket. Any
 * shrink means the rebuild is missing data the sealed day already has: the raw
 * JSONL behind it was cleaned up (the relay's whole promise is that sealed
 * days survive that), a file read truncated mid-stream, or a provider crashed.
 * The per-provider check matters because a day can GROW overall while one
 * provider's records silently vanish. `force` overrides everything for an
 * explicit "replace it anyway" rescan — e.g. after a parser fix that corrects
 * historical double-counting, where shrinking is the point.
 */
export function shouldKeepSealedDay(
  existing: DailyAggregate,
  rebuilt: DailyAggregate,
  opts: { force: boolean }
): boolean {
  if (opts.force) return false;
  if (rebuilt.totalTokens < existing.totalTokens) return true;
  // Cost is guarded too: a rebuild with kosha unreadable/offline (enrichCosts
  // is fail-soft) or a model since pruned from the registry re-derives the
  // same tokens at $0 — replacing would zero frozen historical cost. The one
  // cent of slack absorbs float noise from re-summing per-record costs; real
  // downward price corrections go through `force`.
  if (rebuilt.cost + 0.01 < existing.cost) return true;
  for (const [provider, bucket] of Object.entries(existing.providers)) {
    if ((rebuilt.providers[provider]?.totalTokens ?? 0) < bucket.totalTokens) return true;
  }
  return false;
}
