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
  aggregateRecordsByDay,
  type DailyAggregate,
  isValidRecord,
  recordFingerprint,
  shouldKeepSealedDay,
} from "./aggregates.js";
import {
  DailyAccumulator,
  finalizeDay,
  foldRecordIntoDay,
  listDaysOnDisk,
  loadAggregates,
  migrateMonolithSnapshotIfNeeded,
  writeDayFile,
} from "./aggregates-store.js";
import { isBeforeToday, localDateKey, startOfLocalDay, yesterdayDateKey } from "./date-utils.js";
import { attachDayPrices, type DayPrices, pricesForRebuild, priceWithCard } from "./day-prices.js";
import { getParsers } from "./parsers/index.js";
import type { PriceCard } from "./pricing.js";
import { enrichCosts, toErrorMessage } from "./pricing-enrichment.js";
import { providerFault, type ScanContext, scanRawRecords } from "./scan-pipeline.js";
import { carriedRecordsFor, journalDates, withCarried } from "./today-journal.js";
import type { ProviderId, ScanFaultDetail, ScanMeta, ScanWarning, TokenRecord } from "./types.js";
import { warningsBlockDay } from "./warning-coverage.js";

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
const CUSTOM_ELIGIBLE: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "ribhu",
  "chitragupta",
  "grok",
  "custom",
]);

/**
 * Give a day its price cards before it's written: `kept` for models that
 * already had one, today's for the rest. Fail-soft — a pricing fault must not
 * stop a day from sealing; it seals without cards and gets implied ones if
 * it's ever rebuilt.
 */
async function withPrices(
  ctx: ScanContext,
  day: DailyAggregate,
  warnings: ScanWarning[],
  kept?: DayPrices
): Promise<void> {
  if (ctx.skipPricing) return;
  try {
    await attachDayPrices(day, ctx.pricing, kept);
  } catch (error) {
    warnings.push({
      scope: "history",
      message: `Couldn't record the prices for ${day.date}: ${toErrorMessage(error)}`,
    });
  }
}

/** Providers with a fault that may hide records (not notices). */
function faultedProviders(warnings: readonly ScanWarning[]): string[] {
  const out = new Set<string>();
  for (const w of warnings) {
    if (w.scope === "provider" && !w.notice) out.add(w.provider ?? "unknown");
  }
  return [...out].sort();
}

/** Load the relay, reporting repaired and quarantined days as history warnings. */
function loadRelay(
  homeDir: string,
  warnings: ScanWarning[],
  quarantined?: Set<string>
): Map<string, DailyAggregate> {
  return loadAggregates(homeDir, {
    onWarning: (message) => warnings.push({ scope: "history", message }),
    quarantined,
  });
}

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

  const aggregates = loadRelay(ctx.homeDir, warnings);
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

  // A provider fault makes a gap day non-authoritative only when the faulting
  // file can hold records of that day. Seal the gap's leading run of days the
  // faults can't touch and stop at the first one they can: sealing past it
  // would leave an interior hole the next gap fill never revisits, so that
  // day and everything after it wait for a scan that reads cleanly.
  const gapWarnings = warnings.slice(warnBefore);
  let heldFrom: string | null = null;
  for (let date = gapStart; date < localDateKey(referenceTimestamp); date = nextDayKey(date)) {
    if (warningsBlockDay(gapWarnings, date)) {
      heldFrom = date;
      break;
    }
  }
  if (heldFrom) {
    warnings.push({
      scope: "history",
      message: `Gap fill not persisted from ${heldFrom} on: a file that may hold those days' records could not be fully read.`,
    });
  }

  // A day the daemon never sealed (it was down at midnight) still has its
  // journal: fold in what was deleted while it ran, or while it was down.
  const carried: TokenRecord[] = [];
  for (let date = gapStart; date < todayKey; date = nextDayKey(date)) {
    carried.push(...carriedRecordsFor(ctx.homeDir, date));
  }

  const onDiskSet = new Set(onDisk);
  for (const day of aggregateRecordsByDay(withCarried(raw, carried))) {
    // Never seal today; never overwrite an already-sealed (immutable) day.
    // Never seal a day BEFORE the gap either: the mtime watermark admits
    // multi-day session files whose early records predate gapStart, but those
    // records are only the slice living in still-fresh files — sealing an
    // interior-hole day from them freezes a partial day permanently. Interior
    // holes are recovered by an explicit rescan, not the gap fill.
    if (day.date >= todayKey || day.date < gapStart || onDiskSet.has(day.date)) continue;
    if (heldFrom && day.date >= heldFrom) continue;
    await withPrices(ctx, day, warnings);
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
  floorMs?: number,
  cardFor?: (r: TokenRecord) => PriceCard | undefined
): Promise<Map<string, DailyAggregate>> {
  const todayKey = localDateKey(referenceTimestamp);
  const dayAccs = new Map<string, DailyAccumulator>();
  // Days with a today-journal (the last week) may have had threads deleted
  // before they sealed. Raw no longer has those, so keep these days' raw
  // records to fold the journal's carried ones in after, minus duplicates.
  const journaled = new Set(journalDates(ctx.homeDir).filter((d) => d < todayKey));
  const journaledRaw: TokenRecord[] = [];

  const foldOne = (r: TokenRecord): void => {
    if (floorMs !== undefined && r.timestamp < floorMs) return; // outside the window
    if (!isBeforeToday(r.timestamp, referenceTimestamp)) return; // never seal today
    const key = localDateKey(r.timestamp);
    let acc = dayAccs.get(key);
    if (!acc) {
      acc = new DailyAccumulator(key);
      dayAccs.set(key, acc);
    }
    acc.fold(r);
  };

  const foldFile = async (records: TokenRecord[]): Promise<void> => {
    if (records.length === 0) return;
    if (!ctx.skipPricing) {
      try {
        await enrichCosts(records, ctx.pricing, "history", warnings, undefined, cardFor);
      } catch (error) {
        warnings.push({ scope: "history", message: `Pricing failed: ${toErrorMessage(error)}` });
      }
    }
    for (const r of records) {
      if (journaled.has(localDateKey(r.timestamp))) journaledRaw.push(r);
      foldOne(r);
    }
  };

  for (const parser of getParsers(undefined)) {
    // Per-file bounded-read faults surface here for visibility. Callers decide
    // whether the resulting fold may be persisted; full rebuilds abort every
    // write when any provider is incomplete, while recent-window rebuilds also
    // retain their per-day grow-only comparison as a second line of defense.
    const scanOpts = {
      ...(floorMs !== undefined ? { modifiedSinceMs: floorMs } : {}),
      onWarning: (message: string, detail?: ScanFaultDetail) =>
        warnings.push(providerFault(parser.providerId, message, detail)),
      onNotice: (message: string) =>
        warnings.push({
          scope: "history",
          provider: parser.providerId,
          message: `${parser.providerId}: ${message}`,
          notice: true,
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

  if (journaled.size > 0) {
    const carried: TokenRecord[] = [];
    for (const date of journaled) carried.push(...carriedRecordsFor(ctx.homeDir, date));
    const extra = withCarried(journaledRaw, carried).slice(journaledRaw.length);
    if (extra.length > 0) {
      if (!ctx.skipPricing) {
        try {
          await enrichCosts(extra, ctx.pricing, "history", warnings, undefined, cardFor);
        } catch (error) {
          warnings.push({ scope: "history", message: `Pricing failed: ${toErrorMessage(error)}` });
        }
      }
      for (const r of extra) foldOne(r);
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
  const quarantined = new Set<string>();
  const existing = loadRelay(ctx.homeDir, warnings, quarantined);
  const warnBefore = warnings.length;
  const days = await foldRawIntoDays(ctx, referenceTimestamp, warnings);
  const rebuildWarnings = warnings.slice(warnBefore);
  // Persist every day the scan covered completely. A day a faulting file may
  // hold keeps whatever is sealed for it (or stays unsealed). This used to
  // refuse the whole rebuild on any partial read — so on a corpus with one
  // unreadable file a fresh install never got history, and redid the full
  // rebuild on every start.
  const aggregates = new Map<string, DailyAggregate>();
  const held: string[] = [];
  for (const [date, day] of days) {
    if (quarantined.has(date)) continue; // unreadable sealed file: never overwrite it here
    if (warningsBlockDay(rebuildWarnings, date)) {
      held.push(date);
      const sealed = existing.get(date);
      if (sealed) aggregates.set(date, sealed);
      continue;
    }
    await withPrices(ctx, day, warnings);
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
  const faulted = faultedProviders(rebuildWarnings);
  if (held.length === 0 && faulted.length > 0) {
    warnings.push({
      scope: "history",
      message: `Full rebuild: ${faulted.join(", ")} scan incomplete; not persisted for any day it may touch.`,
    });
  }
  if (held.length > 0) {
    warnings.push({
      scope: "history",
      message: `Full rebuild not persisted for ${held.length} day(s) (${held.slice(0, 5).join(", ")}${held.length > 5 ? ", …" : ""}): a file that may hold their records could not be fully read. Every other day was rebuilt.`,
    });
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
  const floorKey = localDateKey(floorMs);
  const quarantined = new Set<string>();
  const aggregates = loadRelay(ctx.homeDir, warnings, quarantined);
  // Each sealed day in the window rebuilds at its OWN prices — the cards it
  // sealed with, or implied ones for a day sealed before cards existed — so a
  // rescan changes a day's cost only when its tokens change, never because
  // kosha's rates moved since.
  const kept = new Map<string, DayPrices>();
  if (!ctx.skipPricing) {
    for (const [date, day] of aggregates) {
      if (date < floorKey) continue;
      try {
        kept.set(date, await pricesForRebuild(day, ctx.pricing));
      } catch (error) {
        warnings.push({
          scope: "history",
          message: `Couldn't read the prices ${date} sealed at — its rebuild uses today's: ${toErrorMessage(error)}`,
        });
      }
    }
  }
  const cardFor = (r: TokenRecord) => kept.get(localDateKey(r.timestamp))?.[r.model]?.card;
  const warnBefore = warnings.length;
  const rebuilt = await foldRawIntoDays(ctx, referenceTimestamp, warnings, floorMs, cardFor);
  const rebuildWarnings = warnings.slice(warnBefore);
  // Start from what's already sealed, overwrite ONLY the window's days.
  for (const [date, day] of rebuilt) {
    const existing = aggregates.get(date);
    // `force` consents to an intentional parser-driven shrink, never to a
    // broken read: a day a faulting file may hold is left as sealed, since a
    // new provider bucket for it may itself be partial.
    if (warningsBlockDay(rebuildWarnings, date)) {
      warnings.push({
        scope: "history",
        message: `Rebuild of ${date} not persisted: a file that may hold its records could not be fully read.`,
      });
      continue;
    }
    if (quarantined.has(date) && !force) {
      // Unreadable, not absent: it may still be the only copy of that day.
      warnings.push({
        scope: "history",
        message: `Kept sealed day ${date} — its file could not be read, so a rebuild may not replace it without force.`,
      });
      continue;
    }
    if (existing && shouldKeepSealedDay(existing, day, { force })) {
      warnings.push({
        scope: "history",
        message: `Kept sealed day ${date} — rebuild carried less data (rebuilt ${day.totalTokens} vs sealed ${existing.totalTokens} tokens).`,
      });
      continue;
    }
    await withPrices(ctx, day, warnings, kept.get(date));
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

  // Custom-eligible ids (ribhu/chitragupta/grok/custom) are all emitted by the single
  // CustomSourceParser, whose providerId is "custom". Scanning [providerId]
  // for one of those would match no parser; scan the custom parser instead and
  // let the per-record `r.provider === providerId` filter below pick the target.
  const scanProviderId: ProviderId = CUSTOM_ELIGIBLE.has(providerId) ? "custom" : providerId;
  const warnBefore = warnings.length;
  const raw = await scanRawRecords(ctx, [scanProviderId], "history", warnings, floorMs);
  const backfillWarnings = warnings.slice(warnBefore);

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

  const quarantined = new Set<string>();
  const aggregates = loadRelay(ctx.homeDir, warnings, quarantined);
  let added = 0;
  let skipped = 0;
  for (const [date, records] of byDate) {
    if (quarantined.has(date)) {
      skipped++;
      continue; // unreadable sealed file: never overwrite the only copy
    }
    if (warningsBlockDay(backfillWarnings, date)) {
      // Additive and idempotent per day: adding a partial slice would make a
      // later re-run skip the day as "already backfilled". Leave it for one.
      warnings.push({
        scope: "history",
        message: `Provider backfill (${providerId}) for ${date} was not persisted: a file that may hold its records could not be fully read.`,
      });
      skipped++;
      continue;
    }
    const existing = aggregates.get(date);
    if (existing) {
      if (existing.providers[providerId]) {
        skipped++;
        continue; // already backfilled — additive re-run would double-count
      }
      // Bill the added provider at this day's prices where the day has a card
      // for the model (another provider used it that day); today's otherwise.
      const kept = existing.prices;
      for (const r of records) {
        const card = kept?.[r.model]?.card;
        if (card && r.costEligible !== false && r.usage?.cost !== "direct") priceWithCard(r, card);
        foldRecordIntoDay(existing, r);
      }
      finalizeDay(existing); // recompute totalTokens rollups after the fold
      await withPrices(ctx, existing, warnings, kept);
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
      await withPrices(ctx, fresh, warnings);
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

  if (faultedProviders(backfillWarnings).length > 0) {
    warnings.push({
      scope: "history",
      message: `Provider backfill (${providerId}): scan incomplete; not persisted for any day it may touch.`,
    });
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
