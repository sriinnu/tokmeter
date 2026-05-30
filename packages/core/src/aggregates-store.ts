/**
 * @sriinnu/tokmeter-core — Per-day immutable aggregate store.
 *
 * The "relay race" disk layout: each completed day is one immutable file on
 * disk under `~/.cache/tokmeter/aggregates/YYYY-MM-DD.json`. Files are
 * write-once-ever; midnight rollover creates a new file but never touches the
 * old ones. Today lives in memory only ({@link DailyAccumulator}) and is
 * persisted to its `<today>.json` file exactly once, at the moment it
 * stops being today.
 *
 * Why a directory instead of one big snapshot file:
 *   1. True write-once per day — no file ever gets rewritten, eliminating
 *      partial-write / corruption windows for historical data.
 *   2. Bounded RAM: load N most-recent days; older days lazy-load on demand.
 *   3. Sync across machines is literally `rsync` — each file is a unit,
 *      union-merge across hosts gives unified token usage without coordination.
 *   4. Language-agnostic: a Rust / Python / Swift reader just walks the dir.
 *   5. Inspectable: `ls aggregates/` shows your history; `cat <day>.json |
 *      jq` opens any day in isolation.
 *
 * The {@link aggregates.ts} module owns the per-day SHAPE; this module owns
 * the on-disk LAYOUT + the live in-memory accumulator.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type DailyAggregate,
  type ModelDayBucket,
  type ProjectDayBucket,
  type ProviderDayBucket,
  type TokenBuckets,
  aggregateRecordsByDay,
} from "./aggregates.js";
import { localDateKey } from "./date-utils.js";
import type { TokenRecord } from "./types.js";

const STORE_DIR_NAME = ".cache/tokmeter/aggregates";
const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Validate a YYYY-MM-DD string against a real calendar date — the regex above
 * only checks digit shape, so `2026-13-99.json` would match without this. Any
 * stray garbage file whose name happens to fit the digit pattern must NOT
 * make it into the aggregates Map (would key by an unreachable bogus date).
 */
function isValidDateKey(s: string): boolean {
  const [Y, M, D] = s.split("-").map(Number);
  if (M < 1 || M > 12 || D < 1 || D > 31) return false;
  const d = new Date(Y, M - 1, D);
  return d.getFullYear() === Y && d.getMonth() === M - 1 && d.getDate() === D;
}

/** Directory containing the per-day aggregate files for this user/home. */
export function aggregatesStoreDir(homeDir: string): string {
  return join(homeDir, STORE_DIR_NAME);
}

function ensureStoreDir(homeDir: string): string {
  const dir = aggregatesStoreDir(homeDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function dayFilePath(homeDir: string, date: string): string {
  return join(aggregatesStoreDir(homeDir), `${date}.json`);
}

// ─── Listing ────────────────────────────────────────────────────────────────

/**
 * List the date keys (YYYY-MM-DD) of every per-day file present on disk,
 * sorted ascending. Returns [] if the store hasn't been created yet.
 */
export function listDaysOnDisk(homeDir: string): string[] {
  const dir = aggregatesStoreDir(homeDir);
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir);
    const dates: string[] = [];
    for (const e of entries) {
      const m = DATE_FILE_PATTERN.exec(e);
      if (m && isValidDateKey(m[1])) dates.push(m[1]);
    }
    dates.sort();
    return dates;
  } catch {
    return [];
  }
}

// ─── Read ──────────────────────────────────────────────────────────────────

/**
 * Read a single per-day aggregate file. Returns null when the file is missing
 * or unreadable — callers decide whether absence is an error.
 */
export function readDayFile(homeDir: string, date: string): DailyAggregate | null {
  const path = dayFilePath(homeDir, date);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as DailyAggregate;
    return forwardMigrateAggregate(parsed);
  } catch {
    return null;
  }
}

/**
 * Backfill fields added after the initial v3 schema for files written by
 * older versions. Per-project `firstUsed`/`lastUsed` default to 0 (the day's
 * raw records aren't kept, so we can't reconstruct exact timestamps — the
 * project-summary consumer treats 0 as "unknown"). Per-project `modelBuckets`
 * default to empty: getModelCosts(project=…) for that historical day yields
 * an empty per-(project, model) cross-cut, which is correct for any file
 * that pre-dates the schema enrichment. New writes always populate both.
 */
function forwardMigrateAggregate(day: DailyAggregate): DailyAggregate {
  for (const p of Object.values(day.projects)) {
    if (typeof p.firstUsed !== "number") p.firstUsed = 0;
    if (typeof p.lastUsed !== "number") p.lastUsed = 0;
    if (!p.modelBuckets) p.modelBuckets = {};
  }
  for (const pr of Object.values(day.providers)) {
    if (typeof pr.firstUsed !== "number") pr.firstUsed = 0;
    if (typeof pr.lastUsed !== "number") pr.lastUsed = 0;
  }
  return day;
}

/**
 * Load every per-day file present on disk, returning a Map keyed by date.
 * Optional `daysBack` cap loads only the N most-recent days (older files stay
 * on disk, lazy-load later). Files that fail to parse are silently skipped —
 * a single corrupt file must never poison the whole load.
 */
export function loadAggregates(
  homeDir: string,
  opts?: { daysBack?: number }
): Map<string, DailyAggregate> {
  const out = new Map<string, DailyAggregate>();
  const all = listDaysOnDisk(homeDir);
  const slice =
    opts?.daysBack && opts.daysBack > 0 && all.length > opts.daysBack
      ? all.slice(-opts.daysBack)
      : all;
  for (const date of slice) {
    const day = readDayFile(homeDir, date);
    if (day) out.set(date, day);
  }
  return out;
}

// ─── Write ─────────────────────────────────────────────────────────────────

/**
 * Atomically + durably write one per-day aggregate. Writes through a
 * per-process `.tmp` sibling, fsyncs the data, then renames — a kill mid-write
 * leaves either the prior file intact or (on first write) no file at all,
 * never a half-written one, and a power loss after the rename can't surface an
 * unflushed (empty/truncated) file in its place.
 *
 * Durability matters here specifically because the relay's promise is "a
 * sealed day never gets lost even if its JSONL is later deleted" — that
 * promise has to survive a hard crash, not just a clean exit. The tmp suffix
 * carries the pid so a daemon and a concurrent CLI cold-scan sealing the same
 * day can't tear each other's temp file.
 *
 * The file is intended to be **write-once**. The function does not refuse
 * overwrites (rollover may legitimately overwrite TODAY's tentative file on
 * the first rollover after a daemon restart that happened to write before
 * midnight), but every caller that expects immutability should check
 * {@link existsSync(dayFilePath(...))} first.
 */
export function writeDayFile(homeDir: string, aggregate: DailyAggregate): void {
  const dir = ensureStoreDir(homeDir);
  const path = join(dir, `${aggregate.date}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  // Write + fsync the data through an explicit fd before the rename so the
  // bytes are on stable storage when the rename makes them visible.
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(aggregate), { encoding: "utf-8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // fsync the directory so the rename entry itself is durable, not just the
  // file contents. Best-effort: some filesystems reject directory fsync.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync unsupported here — file fsync above still holds */
  }
}

/**
 * Remove a per-day file from the store. Used for migration cleanup, never
 * during normal daemon operation — historical days are immutable by design.
 */
export function deleteDayFile(homeDir: string, date: string): void {
  try {
    unlinkSync(dayFilePath(homeDir, date));
  } catch {
    // Already gone or not present — both fine.
  }
}

/** Atomic mtime probe — used by tests + maintenance utilities. */
export function dayFileMtime(homeDir: string, date: string): number | null {
  try {
    return statSync(dayFilePath(homeDir, date)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Seal a rolled-over day into the relay. Called when the daemon crosses
 * midnight and the outgoing {@link DailyAccumulator} holds a now-complete past
 * day: freezing it here means the day survives even if its raw JSONL is later
 * deleted, instead of depending on a later cold-start gap-fill that re-reads
 * the JSONL. Write-once — only persists when the day isn't already on disk, so
 * the immutable on-disk version always wins. Returns the sealed aggregate (so
 * the caller can splice it into its in-memory map) or null when nothing was
 * sealed (no rollover, empty day, or the day is already on disk). The disk
 * write is best-effort: a failure still returns the aggregate so live queries
 * stay correct, and the next cold-start gap-fill re-seals it from JSONL.
 */
export function sealRolledOverDay(
  homeDir: string,
  prev: DailyAccumulator,
  todayKey: string
): DailyAggregate | null {
  if (prev.date >= todayKey || prev.isEmpty()) return null;
  if (dayFileMtime(homeDir, prev.date) !== null) return null;
  const sealed = prev.seal();
  try {
    writeDayFile(homeDir, sealed);
  } catch {
    /* gap-fill on next cold start re-seals from JSONL if this write fails */
  }
  return sealed;
}

// ─── DailyAccumulator — the in-memory "today" runner ───────────────────────

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

/**
 * Mutable, in-memory accumulator for the current calendar day. The relay's
 * live leg: every record the daemon parses gets folded in via {@link fold}.
 * At midnight rollover, {@link seal} freezes the accumulator into a
 * {@link DailyAggregate} that gets written once to disk and then replaced by
 * a fresh accumulator for the new day.
 *
 * The accumulator shape is identical to {@link DailyAggregate}, so callers
 * can iterate today's stats with the same code that iterates historical days
 * — there's no "different shape for today" branch anywhere.
 */
export class DailyAccumulator {
  private agg: DailyAggregate;
  /**
   * Records that have been folded in but might be re-emitted by a parser on
   * a subsequent scan (e.g., codex's dedup might re-pick a different file
   * winner). The key is a stable per-record fingerprint; if a record with the
   * same fingerprint arrives twice we skip it instead of double-counting.
   *
   * We dedup at the accumulator level rather than at the parser level so the
   * invariant ("today's total only grows") is enforced regardless of which
   * parser is feeding records in.
   */
  private fingerprints = new Set<string>();

  constructor(date: string) {
    this.agg = makeEmptyDay(date);
  }

  /** YYYY-MM-DD of the day this accumulator is tracking. */
  get date(): string {
    return this.agg.date;
  }

  /** True before any record has been folded in. */
  isEmpty(): boolean {
    return this.agg.recordCount === 0;
  }

  /**
   * Fold a single record into the running aggregate. Idempotent: re-folding
   * the same record (by fingerprint) is a no-op. Returns true if the record
   * was new, false if it was a duplicate OR malformed.
   *
   * A record with a NaN/Infinity/negative numeric field would silently poison
   * every total and break the cache-math invariant (missRate +
   * cacheWriteShare + canonicalRate = 1.0) with no way to recover short of a
   * full rebuild. We drop such records at the door rather than let one bad
   * line corrupt the whole day's aggregate.
   */
  fold(record: TokenRecord): boolean {
    if (!isFoldableRecord(record)) return false;
    const fp = recordFingerprint(record);
    if (this.fingerprints.has(fp)) return false;
    this.fingerprints.add(fp);

    foldRecordIntoDay(this.agg, record);
    return true;
  }

  /** Bulk-fold an array of records. Returns the count newly accepted. */
  foldAll(records: TokenRecord[]): number {
    let added = 0;
    for (const r of records) if (this.fold(r)) added++;
    return added;
  }

  /**
   * Snapshot the running aggregate. Returns a NEW object — the accumulator
   * can keep growing after callers have walked away with the snapshot.
   * Useful for read-side queries (`/api/today`, `getStats()`).
   */
  toAggregate(): DailyAggregate {
    return finalizeDay(structuredClone(this.agg));
  }

  /**
   * Seal the accumulator and return the immutable per-day aggregate. After
   * this returns, the accumulator should be replaced for the new day —
   * mutating after seal is a programmer error.
   */
  seal(): DailyAggregate {
    return finalizeDay(this.agg);
  }

  /**
   * Pre-load a sealed aggregate as the accumulator's starting state. Used
   * when restoring today's in-memory state from an unsealed previous run
   * (e.g., daemon restart mid-day): we re-fold every record the daemon has
   * already seen so the running aggregate matches what `seal()` would have
   * produced.
   *
   * Idempotency note: the fingerprint set is reset — callers that hydrate
   * via this method MUST own the input, because we trust it without re-dedup.
   */
  hydrate(seed: DailyAggregate): void {
    this.agg = structuredClone(seed);
    this.fingerprints.clear();
  }
}

function makeEmptyDay(date: string): DailyAggregate {
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

function foldRecordIntoDay(day: DailyAggregate, r: TokenRecord): void {
  day.cost += r.cost;
  addBuckets(day, r);
  day.recordCount++;
  if (r.timestamp < day.firstUsed) day.firstUsed = r.timestamp;
  if (r.timestamp > day.lastUsed) day.lastUsed = r.timestamp;

  let model: ModelDayBucket | undefined = day.models[r.model];
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

  let project: ProjectDayBucket | undefined = day.projects[r.project];
  if (!project) {
    project = {
      project: r.project,
      cost: 0,
      totalTokens: 0,
      recordCount: 0,
      firstUsed: Number.POSITIVE_INFINITY,
      lastUsed: Number.NEGATIVE_INFINITY,
      models: [],
      modelBuckets: {},
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
  // Per-(project, model) cross-cut: same scheme as aggregateRecordsByDay so a
  // record folded here lands in the exact same bucket the cold-scan path
  // produces. Required by getAllProjects / getProjectSummary / getModelCosts
  // (project=…) to compute exact per-project ModelSummary arrays.
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

  let provider: ProviderDayBucket | undefined = day.providers[r.provider];
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

function finalizeDay(day: DailyAggregate): DailyAggregate {
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
  if (!Number.isFinite(day.firstUsed)) day.firstUsed = 0;
  if (!Number.isFinite(day.lastUsed)) day.lastUsed = 0;
  return day;
}

/**
 * Stable per-record fingerprint for accumulator-level dedup. Same record
 * arriving twice (e.g. codex parser dedup swapped a sibling and re-emitted
 * the same content from a different file) → same fingerprint → folded once.
 *
 * Uses timestamp + model + token counts + cost; `sourceFile` deliberately
 * excluded so the fingerprint is content-stable across the fork-dedup
 * winner-swap that would otherwise produce phantom duplicates.
 */
function recordFingerprint(r: TokenRecord): string {
  return `${r.timestamp}|${r.provider}|${r.model}|${r.inputTokens}|${r.outputTokens}|${r.cacheReadTokens}|${r.cacheWriteTokens}|${r.reasoningTokens}|${r.cost}`;
}

/**
 * Guard against a malformed record poisoning the running aggregate. Every
 * numeric must be a finite, non-negative number; the model identity must be a
 * non-empty string (an empty model key would create a junk bucket). A record
 * that fails any check is dropped — it never reaches {@link foldRecordIntoDay},
 * so totals and the cache-math identity stay sound regardless of upstream
 * parser bugs or hand-edited JSONL.
 */
function isFoldableRecord(r: TokenRecord): boolean {
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
  if (typeof r.model !== "string" || r.model.length === 0) return false;
  return true;
}

// ─── Migration helper (one-shot v2/v3-monolith → per-day directory) ────────

/**
 * One-shot migration: split a legacy single-file snapshot (v2 raw records OR
 * v3 monolithic aggregates) into per-day files. Idempotent — runs only if no
 * per-day files exist yet AND a legacy file is present. Safe to call on every
 * cold start; cheap when there's nothing to migrate.
 */
export function migrateMonolithSnapshotIfNeeded(
  homeDir: string,
  legacyFilePath: string,
  reader: () => { records?: TokenRecord[]; days?: DailyAggregate[] } | null
): { migrated: boolean; daysWritten: number } {
  const dir = aggregatesStoreDir(homeDir);
  // If per-day files already exist, the daemon's already on the new world.
  if (existsSync(dir)) {
    const existing = listDaysOnDisk(homeDir);
    if (existing.length > 0) return { migrated: false, daysWritten: 0 };
  }
  if (!existsSync(legacyFilePath)) return { migrated: false, daysWritten: 0 };

  const legacy = reader();
  if (!legacy) return { migrated: false, daysWritten: 0 };

  const days =
    legacy.days && legacy.days.length > 0
      ? legacy.days
      : legacy.records && legacy.records.length > 0
        ? aggregateRecordsByDay(legacy.records)
        : [];

  if (days.length === 0) return { migrated: false, daysWritten: 0 };

  ensureStoreDir(homeDir);
  // Only migrate days strictly before today — today still belongs to the
  // live accumulator, not the immutable store.
  const todayKey = localDateKey();
  let written = 0;
  for (const day of days) {
    if (day.date >= todayKey) continue;
    writeDayFile(homeDir, day);
    written++;
  }
  return { migrated: true, daysWritten: written };
}
