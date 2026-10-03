/**
 * @sriinnu/tokmeter-core — Per-day relay store loader + v2 migration.
 *
 * Owns the cold-start path: load `~/.cache/tokmeter/aggregates/*.json` into
 * a Map, fill any gap between the newest on-disk day and yesterday via a
 * bounded mtime-watermarked raw scan, write the new days back as immutable
 * per-day files. Phase 3.3 of the aggregate cutover.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  DailyAccumulator,
  finalizeDay,
  foldRecordIntoDay,
  listDaysOnDisk,
  loadAggregates,
  migrateMonolithSnapshotIfNeeded,
  writeDayFile,
} from "./aggregates-store.js";
import {
  type DailyAggregate,
  aggregateRecordsByDay,
  isValidRecord,
  recordFingerprint,
  shouldKeepSealedDay,
} from "./aggregates.js";
import { isBeforeToday, localDateKey, startOfLocalDay, yesterdayDateKey } from "./date-utils.js";
import { getParsers } from "./parsers/index.js";
import { enrichCosts, toErrorMessage } from "./pricing-enrichment.js";
import { type ScanContext, scanRawRecords } from "./scan-pipeline.js";
import type { ProviderId, ScanMeta, ScanWarning, TokenRecord } from "./types.js";

export interface RelayState {
  aggregates: Map<string, DailyAggregate>;
  historySource: ScanMeta["historySource"];
}

/**
 * Provider ids served by the single CustomSourceParser (providerId "custom").
 * A surgical backfill of one of these must scan that parser, not a parser whose
 * id equals the target (none exists). Mirrors CUSTOM_ELIGIBLE in
 * parsers/custom-source.ts.
 */
const CUSTOM_ELIGIBLE: ReadonlySet<ProviderId> = new Set<ProviderId>(["ribhu", "grok", "custom"]);

/**
 * Refresh historical aggregates from the per-day relay store.
 *
 * Loads every per-day file present on disk, then fills any gap between
 * the newest on-disk day and yesterday via a bounded mtime-watermarked
 * raw scan. Bounded so cold start scales with the gap (typically 0–1
 * days), not with lifetime corpus size.
 */
export async function refreshFromRelay(
  ctx: ScanContext,
  referenceTimestamp: number,
  warnings: ScanWarning[],
  forceRebuild: boolean
): Promise<RelayState> {
  migrateV2IfNeeded(ctx.homeDir);

  if (forceRebuild) return rebuildHistoricalFromScratch(ctx, referenceTimestamp, warnings);

  const aggregates = loadAggregates(ctx.homeDir);
  const onDisk = listDaysOnDisk(ctx.homeDir);
  const maxOnDisk = onDisk.length > 0 ? onDisk[onDisk.length - 1] : null;
  const yesterday = yesterdayDateKey(referenceTimestamp);

  if (maxOnDisk === null) return rebuildHistoricalFromScratch(ctx, referenceTimestamp, warnings);

  // Fast path: the relay is current through yesterday → no scan at all. This is
  // the bounded-cold-start guarantee the aggregate cutover exists for (months
  // of history read as ~few MB, no lifetime rescan). MUST stay a cheap
  // short-circuit — do NOT try to detect interior holes here: a day the user
  // simply didn't use Claude is never written to disk and is indistinguishable
  // from a real hole, so scanning back to it would re-parse the whole corpus on
  // every cold start. Interior holes from a rare transient write failure are
  // recovered by an explicit `rescanHistory`, not here.
  if (maxOnDisk >= yesterday) return { aggregates, historySource: "snapshot" };

  // Trailing gap only: fill from the day after the newest on-disk day. Bounded
  // to the gap (typically 0–1 days). Watermark at that day's LOCAL midnight
  // (startOfLocalDay is DST-safe; a fixed +86_400_000 could land an hour late
  // on a spring-forward day and prune an early-morning file).
  const gapStart = nextDayKey(maxOnDisk);
  const floorMs = startOfLocalDay(new Date(`${gapStart}T00:00:00`).getTime());
  const warnBefore = warnings.length;
  const raw = await scanRawRecords(ctx, undefined, "history", warnings, floorMs);
  const todayKey = localDateKey(referenceTimestamp);

  // A crashed provider mid-fill writes nothing — a healthy re-run will fill
  // it correctly. Better to retry than freeze a degraded day. Per-file
  // `partial` faults deliberately do NOT abort: a permanently unreadable file
  // would otherwise block the gap fill on every cold start until the raw
  // JSONL behind the gap ages out — losing whole days to protect one file's
  // tail.
  const gapDegraded = warnings.slice(warnBefore).some((w) => w.scope === "provider" && !w.partial);
  if (gapDegraded) return { aggregates, historySource: "extended" };

  const onDiskSet = new Set(onDisk);
  for (const day of aggregateRecordsByDay(raw)) {
    // Never seal today; never overwrite an already-sealed (immutable) day.
    // Never seal a day BEFORE the gap either: the mtime watermark admits
    // multi-day session files whose early records predate gapStart, but those
    // records are only the slice living in still-fresh files — sealing an
    // interior-hole day from them freezes a partial day permanently. Interior
    // holes are recovered by an explicit rescan, not the gap fill.
    if (day.date >= todayKey || day.date < gapStart || onDiskSet.has(day.date)) continue;
    try {
      writeDayFile(ctx.homeDir, day);
      aggregates.set(day.date, day);
    } catch (error) {
      warnings.push({
        scope: "cache",
        message: `Failed to persist day ${day.date} to relay: ${toErrorMessage(error)}`,
      });
    }
  }
  return { aggregates, historySource: "extended" };
}

/** Next calendar day's key — DST-safe (jump past any 23h/25h day, snap back to
 *  local midnight). */
function nextDayKey(key: string): string {
  const midnight = new Date(`${key}T00:00:00`).getTime();
  return localDateKey(startOfLocalDay(midnight + 26 * 3_600_000));
}

/**
 * Shared streaming fold: re-derive per-day aggregates from RAW files, folding
 * each file's records into shared day accumulators and releasing them, so peak
 * memory is a single file — never the whole corpus (the old "load everything"
 * path peaked multi-GB and drove the machine into a Jetsam/OOM reboot).
 *
 * `floorMs` bounds the work: with it set, only records on/after that instant
 * are folded (a windowed rebuild). Providers that expose `scanStreaming` are
 * driven file-by-file; the rest fall back to scan(). DailyAccumulator.fold
 * applies the exact same dedup + costByHour fold as aggregateRecordsByDay, so
 * the output is byte-identical (relay-accuracy tests guard this).
 */
async function foldRawIntoDays(
  ctx: ScanContext,
  referenceTimestamp: number,
  warnings: ScanWarning[],
  floorMs?: number
): Promise<Map<string, DailyAggregate>> {
  const todayKey = localDateKey(referenceTimestamp);
  const dayAccs = new Map<string, DailyAccumulator>();

  const foldFile = async (records: TokenRecord[]): Promise<void> => {
    if (records.length === 0) return;
    if (!ctx.skipPricing) {
      try {
        await enrichCosts(records, ctx.pricing, "history", warnings);
      } catch (error) {
        warnings.push({ scope: "history", message: `Pricing failed: ${toErrorMessage(error)}` });
      }
    }
    for (const r of records) {
      if (floorMs !== undefined && r.timestamp < floorMs) continue; // outside the window
      if (!isBeforeToday(r.timestamp, referenceTimestamp)) continue; // never seal today
      const key = localDateKey(r.timestamp);
      let acc = dayAccs.get(key);
      if (!acc) {
        acc = new DailyAccumulator(key);
        dayAccs.set(key, acc);
      }
      acc.fold(r);
    }
  };

  for (const parser of getParsers(undefined)) {
    // Per-file fail-soft truncations surface here for visibility. They don't
    // gate the rebuild — rebuildRecentWindow's overwrite-vs-keep decision is
    // shouldKeepSealedDay's size/cost comparison, which catches the truncated
    // result by its own shrinkage. `partial: true` keeps the gap fill's
    // whole-provider abort from firing on a single bad file.
    const scanOpts = {
      ...(floorMs !== undefined ? { modifiedSinceMs: floorMs } : {}),
      onWarning: (message: string) =>
        warnings.push({
          scope: "provider",
          provider: parser.providerId,
          message: `${parser.providerId} partial scan: ${message}`,
          partial: true,
        }),
    };
    try {
      if (parser.scanStreaming) {
        await parser.scanStreaming(ctx.homeDir, scanOpts, foldFile);
      } else {
        await foldFile(await parser.scan(ctx.homeDir, scanOpts));
      }
    } catch (error) {
      warnings.push({
        scope: "provider",
        provider: parser.providerId,
        message: `${parser.providerId} rebuild failed — skipped (${toErrorMessage(error)}).`,
      });
    }
  }

  const days = new Map<string, DailyAggregate>();
  for (const [date, acc] of dayAccs) {
    if (date >= todayKey) continue;
    days.set(date, acc.seal());
  }
  return days;
}

/**
 * Full historical rebuild — first-ever cold start, empty relay, or an explicit
 * full rebuild. Re-derives EVERY sealed day from raw and replaces the on-disk
 * relay. Memory-bounded by the streaming fold, but still the heaviest path.
 */
async function rebuildHistoricalFromScratch(
  ctx: ScanContext,
  referenceTimestamp: number,
  warnings: ScanWarning[]
): Promise<RelayState> {
  const days = await foldRawIntoDays(ctx, referenceTimestamp, warnings);
  const aggregates = new Map<string, DailyAggregate>();
  for (const [date, day] of days) {
    try {
      writeDayFile(ctx.homeDir, day);
      aggregates.set(date, day);
    } catch (error) {
      warnings.push({
        scope: "cache",
        message: `Failed to persist day ${date} to relay: ${toErrorMessage(error)}`,
      });
    }
  }
  return { aggregates, historySource: days.size > 0 ? "rebuilt" : "none" };
}

/**
 * Bounded window rebuild — what the Hub's "Deep Rescan" runs. Re-derives ONLY
 * the last `windowDays` of sealed days from raw and overwrites just those files,
 * leaving older days untouched. This is the right-sized operation: it backfills
 * pace's costByHour (which only reads the last few days) and corrects any recent
 * day sealed by buggy code, WITHOUT the multi-GB full-history parse that OOM'd
 * the box. Older days' curves are never read by pace, so re-deriving them is
 * pure waste — we skip it.
 *
 * Sealed days are only REPLACED when the rebuild carries at least as much
 * data — day total and every provider bucket (see shouldKeepSealedDay). A
 * shrunken rebuild means missing data: raw JSONL cleaned up, a truncated
 * per-file read (now surfaced via onWarning), or a provider crash. This is
 * the guard whose absence let the 2026-07-12 deep rescan shrink a sealed
 * 2026-06-12. `force` overrides for an explicit "replace it anyway" rescan.
 */
export async function rebuildRecentWindow(
  ctx: ScanContext,
  referenceTimestamp: number,
  warnings: ScanWarning[],
  windowDays: number,
  force = false
): Promise<RelayState> {
  migrateV2IfNeeded(ctx.homeDir);
  const floorMs = startOfLocalDay(referenceTimestamp - windowDays * 86_400_000);
  const warnBefore = warnings.length;
  const rebuilt = await foldRawIntoDays(ctx, referenceTimestamp, warnings, floorMs);
  // Providers whose scan soft-failed on a file during THIS fold. `force`
  // consents to an intentional shrink (a parser fix), not to a broken read —
  // a day that shrank for a partial-scan provider is kept even when forced,
  // so a transient read fault during a forced rescan can't reproduce the
  // 2026-07-12 loss with the user's own consent as the murder weapon.
  const partialProviders = new Set(
    warnings
      .slice(warnBefore)
      .filter((w) => w.scope === "provider" && w.partial && w.provider)
      .map((w) => w.provider)
  );
  // Start from what's already sealed, overwrite ONLY the window's days.
  const aggregates = loadAggregates(ctx.homeDir);
  for (const [date, day] of rebuilt) {
    const existing = aggregates.get(date);
    const forcedButTruncated =
      force &&
      existing &&
      [...partialProviders].some(
        (p) =>
          p !== undefined &&
          (day.providers[p]?.totalTokens ?? 0) < (existing.providers[p]?.totalTokens ?? 0)
      );
    if (existing && (forcedButTruncated || shouldKeepSealedDay(existing, day, { force }))) {
      warnings.push({
        scope: "history",
        message: `Kept sealed day ${date} — rebuild carried less data (rebuilt ${day.totalTokens} vs sealed ${existing.totalTokens} tokens${forcedButTruncated ? "; a truncated file read made the forced rebuild untrustworthy for it — retry" : ""}).`,
      });
      continue;
    }
    try {
      writeDayFile(ctx.homeDir, day);
      aggregates.set(date, day);
    } catch (error) {
      warnings.push({
        scope: "cache",
        message: `Failed to persist day ${date} to relay: ${toErrorMessage(error)}`,
      });
    }
  }
  return { aggregates, historySource: "rebuilt" };
}

/**
 * Surgical, provider-scoped additive backfill. Re-derives ONE provider's raw
 * over the last `windowDays` sealed days and ADDS its contribution to each day
 * — it never re-derives or touches the other providers already sealed in that
 * day. This is the tool for picking up a NEWLY ADDED parser (or a freshly
 * registered custom source) on a machine where the full deep rescan can't:
 * when a day's OTHER providers' raw has aged out (e.g. codex pruned by a
 * compaction job), re-deriving the whole day shrinks it and the grow-only guard
 * rejects it, so the new provider never lands. Adding only the new provider's
 * slice sidesteps that entirely and is grow-only by construction.
 *
 * Today is never touched (the live scan owns it). It is bounded by the NEW
 * provider's own raw retention — a day whose provider raw has aged out simply
 * contributes nothing. It is idempotent: a day that already carries this
 * provider is skipped, so a re-run never double-counts (re-deriving an
 * already-present provider would need a subtract we deliberately don't do;
 * correcting one is a full-day rebuild, not this additive path).
 */
export async function backfillProviderIntoRelay(
  ctx: ScanContext,
  providerId: ProviderId,
  referenceTimestamp: number,
  warnings: ScanWarning[],
  windowDays: number
): Promise<RelayState> {
  migrateV2IfNeeded(ctx.homeDir);
  const floorMs = startOfLocalDay(referenceTimestamp - windowDays * 86_400_000);
  const todayKey = localDateKey(referenceTimestamp);
  const floorKey = localDateKey(floorMs);

  // Custom-eligible ids (ribhu/grok/custom) are all emitted by the single
  // CustomSourceParser, whose providerId is "custom". Scanning [providerId]
  // for one of those would match no parser; scan the custom parser instead and
  // let the per-record `r.provider === providerId` filter below pick the target.
  const scanProviderId: ProviderId = CUSTOM_ELIGIBLE.has(providerId) ? "custom" : providerId;
  const raw = await scanRawRecords(ctx, [scanProviderId], "history", warnings, floorMs);

  // Keep only this provider's records that fall in the sealed window: on/after
  // the floor day and strictly before today (a multi-day file can carry records
  // outside the window; today belongs to the live scan). Validity + fingerprint
  // dedup mirror the cold fold paths (aggregateRecordsByDay / DailyAccumulator)
  // so a malformed or duplicated line can never poison an immutable sealed day.
  const byDate = new Map<string, TokenRecord[]>();
  const seenFingerprints = new Set<string>();
  for (const r of raw) {
    if (r.provider !== providerId) continue;
    if (!isValidRecord(r)) continue;
    const date = localDateKey(r.timestamp);
    if (date < floorKey || date >= todayKey) continue;
    const fp = recordFingerprint(r);
    if (seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(r);
  }

  const aggregates = loadAggregates(ctx.homeDir);
  let added = 0;
  let skipped = 0;
  for (const [date, records] of byDate) {
    const existing = aggregates.get(date);
    if (existing) {
      if (existing.providers[providerId]) {
        skipped++;
        continue; // already backfilled — additive re-run would double-count
      }
      for (const r of records) foldRecordIntoDay(existing, r);
      finalizeDay(existing); // recompute totalTokens rollups after the fold
      try {
        writeDayFile(ctx.homeDir, existing);
        added++;
      } catch (error) {
        warnings.push({
          scope: "cache",
          message: `Failed to persist day ${date} to relay: ${toErrorMessage(error)}`,
        });
      }
    } else {
      // No sealed day for this date yet — this provider is the only activity.
      const fresh = aggregateRecordsByDay(records)[0];
      if (!fresh) continue;
      try {
        writeDayFile(ctx.homeDir, fresh);
        aggregates.set(date, fresh);
        added++;
      } catch (error) {
        warnings.push({
          scope: "cache",
          message: `Failed to persist day ${date} to relay: ${toErrorMessage(error)}`,
        });
      }
    }
  }

  warnings.push({
    scope: "history",
    message: `Provider backfill (${providerId}): added ${added} day(s), skipped ${skipped} already-present day(s), window ${windowDays}d.`,
  });
  return { aggregates, historySource: "rebuilt" };
}

/**
 * One-shot v2 monolith → per-day relay migration. Idempotent: when per-day
 * files already exist OR no legacy file is present, returns immediately.
 * After a successful migration we rename the legacy file to `.legacy` so
 * future cold starts read the relay only.
 */
function migrateV2IfNeeded(homeDir: string): void {
  const v2Path = join(homeDir, ".cache/tokmeter/history-snapshot.json");
  const result = migrateMonolithSnapshotIfNeeded(homeDir, v2Path, () => {
    if (!existsSync(v2Path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(v2Path, "utf-8"));
      if (parsed?.version === 3 && Array.isArray(parsed.days)) return { days: parsed.days };
      if (Array.isArray(parsed?.records)) return { records: parsed.records };
    } catch {
      return null;
    }
    return null;
  });
  if (!result.migrated) return;
  try {
    if (existsSync(v2Path)) renameSync(v2Path, `${v2Path}.legacy`);
  } catch {
    // Best-effort — leftover legacy file is harmless once the relay is live.
  }
}
