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
  listDaysOnDisk,
  loadAggregates,
  migrateMonolithSnapshotIfNeeded,
  writeDayFile,
} from "./aggregates-store.js";
import { type DailyAggregate, aggregateRecordsByDay } from "./aggregates.js";
import { localDateKey, yesterdayDateKey } from "./date-utils.js";
import { toErrorMessage } from "./pricing-enrichment.js";
import { type ScanContext, scanHistoricalRecords, scanRawRecords } from "./scan-pipeline.js";
import type { ScanMeta, ScanWarning } from "./types.js";

export interface RelayState {
  aggregates: Map<string, DailyAggregate>;
  historySource: ScanMeta["historySource"];
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

  const aggregates = loadAggregates(ctx.homeDir);
  const onDisk = listDaysOnDisk(ctx.homeDir);
  const maxOnDisk = onDisk.length > 0 ? onDisk[onDisk.length - 1] : null;
  const yesterday = yesterdayDateKey(referenceTimestamp);

  if (maxOnDisk === null) return rebuildHistoricalFromScratch(ctx, referenceTimestamp, warnings);
  if (maxOnDisk >= yesterday) return { aggregates, historySource: "snapshot" };

  // Gap fill — watermark at the start of the first uncovered day.
  const floorMs = new Date(`${maxOnDisk}T00:00:00`).getTime() + 86_400_000;
  const warnBefore = warnings.length;
  const raw = await scanRawRecords(ctx, undefined, "history", warnings, floorMs);
  const todayKey = localDateKey(referenceTimestamp);
  const gap = raw.filter((r) => {
    const k = localDateKey(r.timestamp);
    return k > maxOnDisk && k < todayKey;
  });
  // A partial gap scan (provider crash mid-fill) writes nothing — a healthy
  // re-run will fill it correctly. Better to retry than freeze a degraded day.
  const gapDegraded = warnings.slice(warnBefore).some((w) => w.scope === "provider");
  if (gapDegraded) return { aggregates, historySource: "extended" };

  for (const day of aggregateRecordsByDay(gap)) {
    if (day.date <= maxOnDisk || day.date >= todayKey) continue;
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

/**
 * Full historical rebuild — first-ever cold start, explicit `rescanHistory`,
 * or empty relay. Scans every historical file, splatters into per-day relay
 * files. One-time cost (and the only path that touches lifetime raw records
 * — caller-scoped and immediately released).
 */
async function rebuildHistoricalFromScratch(
  ctx: ScanContext,
  referenceTimestamp: number,
  warnings: ScanWarning[]
): Promise<RelayState> {
  const raw = await scanHistoricalRecords(ctx, undefined, referenceTimestamp, warnings);
  const todayKey = localDateKey(referenceTimestamp);
  const days = aggregateRecordsByDay(raw);
  const aggregates = new Map<string, DailyAggregate>();
  for (const day of days) {
    if (day.date >= todayKey) continue;
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
  return { aggregates, historySource: raw.length > 0 ? "rebuilt" : "none" };
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
