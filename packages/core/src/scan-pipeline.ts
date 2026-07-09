/**
 * @sriinnu/tokmeter-core — Parser orchestration + windowed raw scans.
 *
 * The scan pipeline is the layer between TokmeterCore and the provider
 * parsers. It runs every registered parser in parallel, flattens the
 * results, and enriches today's records with pricing. Historical-scope
 * scans get a 14-day mtime watermark; today-scope scans get a local-midnight
 * watermark — both stat-prune the corpus so RSS scales with the window,
 * not lifetime.
 */

import { isBeforeToday, startOfLocalDay } from "./date-utils.js";
import { getParsers } from "./parsers/index.js";
import { saveRecordCacheToDisk } from "./parsers/utils.js";
import { enrichCosts, toErrorMessage } from "./pricing-enrichment.js";
import type { PricingService } from "./pricing.js";
import type { ProviderId, ScanMeta, ScanWarning, TokenRecord } from "./types.js";

export interface ScanContext {
  homeDir: string;
  pricing: PricingService;
  skipPricing: boolean;
}

/**
 * Which records a scan may (re)price — the frozen-cost gate. A today-scope
 * scan prices ONLY records dated today; before-today records (e.g. a
 * yesterday tail in a still-active file) are FROZEN and never re-priced, so a
 * new model or a price change today can never alter yesterday's or any earlier
 * total. History-scope (first-ever rebuild / gap-fill) prices everything,
 * because those days are being freshly committed and have no frozen cost yet.
 */
export function selectRecordsToPrice(
  records: TokenRecord[],
  warningScope: "history" | "today",
  referenceTimestamp: number
): TokenRecord[] {
  if (warningScope !== "today") return records;
  return records.filter((r) => !isBeforeToday(r.timestamp, referenceTimestamp));
}

/** Top-level parser fan-out: runs every parser, optional mtime watermark. */
export async function scanRawRecords(
  ctx: ScanContext,
  providers: ProviderId[] | undefined,
  warningScope: "history" | "today",
  warnings: ScanWarning[],
  modifiedSinceMs?: number
): Promise<TokenRecord[]> {
  if (!ctx.skipPricing) {
    try {
      await ctx.pricing.init();
    } catch (error) {
      warnings.push({
        scope: warningScope,
        message: `Pricing initialization failed — continuing without pricing (${toErrorMessage(error)}).`,
      });
    }
  }

  const parsers = getParsers(providers);
  const scanOpts = modifiedSinceMs !== undefined ? { modifiedSinceMs } : undefined;
  const results = await Promise.all(
    parsers.map(async (parser) => {
      try {
        return await parser.scan(ctx.homeDir, scanOpts);
      } catch (error) {
        warnings.push({
          scope: "provider",
          provider: parser.providerId,
          message: `${parser.providerId} scan failed — skipped (${toErrorMessage(error)}).`,
        });
        return [] as TokenRecord[];
      }
    })
  );

  const records = results.flat();

  if (records.length > 0 && !ctx.skipPricing) {
    // Today-scope enrichment is gated to records actually dated today.
    // A today-active file (e.g. a long-running Claude session whose JSONL
    // is appended to today) can ALSO contain records from yesterday that
    // appeared earlier in the same file. Those historical records are
    // FROZEN — their cost must not be touched here, even if they currently
    // sit at $0 (model wasn't in kosha that day). Without this gate, the
    // first today-scope scan would silently price every yesterday-tail
    // record at today's rates and write the new cost back through the
    // record cache, breaking the snapshot's frozen-cost invariant on the
    // next history extension.
    //
    // History-scope (rebuild / gap fill) prices everything as before —
    // those records are being freshly committed to the snapshot and need
    // an initial cost.
    const referenceTimestamp = Date.now();
    const recordsToPrice = selectRecordsToPrice(records, warningScope, referenceTimestamp);
    if (recordsToPrice.length > 0) {
      await enrichCosts(recordsToPrice, ctx.pricing, warningScope, warnings);
    }
  }

  saveRecordCacheToDisk();
  return records;
}

/** Today's records — mtime-pruned to today's active files, filtered to today's timestamps. */
export async function scanTodayRecords(
  ctx: ScanContext,
  providers: ProviderId[] | undefined,
  referenceTimestamp: number,
  warnings: ScanWarning[]
): Promise<TokenRecord[]> {
  const { today } = await scanTodayRecordsWithStragglers(
    ctx,
    providers,
    referenceTimestamp,
    warnings
  );
  return today;
}

/**
 * Today's active-file scan, partitioned into today's records and any
 * before-today "straggler" records physically present in the freshly-read
 * files. A session running nonstop across midnight appends a line dated
 * yesterday (e.g. 23:59:50) that the next post-midnight scan reads because the
 * same file also got a today write — without capturing these, the rollover
 * seal (which freezes yesterday from the stale in-memory accumulator) would
 * lose them permanently. The rollover folds stragglers into yesterday before
 * sealing; the accumulator's fingerprint dedup makes an already-counted
 * record a no-op, so this never double-counts. Stragglers are returned
 * as-parsed and NOT re-priced here, preserving the frozen-cost invariant.
 */
export async function scanTodayRecordsWithStragglers(
  ctx: ScanContext,
  providers: ProviderId[] | undefined,
  referenceTimestamp: number,
  warnings: ScanWarning[]
): Promise<{ today: TokenRecord[]; stragglers: TokenRecord[] }> {
  const rawRecords = await scanRawRecords(
    ctx,
    providers,
    "today",
    warnings,
    startOfLocalDay(referenceTimestamp)
  );
  const today: TokenRecord[] = [];
  const stragglers: TokenRecord[] = [];
  for (const record of rawRecords) {
    if (isBeforeToday(record.timestamp, referenceTimestamp)) stragglers.push(record);
    else today.push(record);
  }
  return { today, stragglers };
}

/** Unbounded historical scan — used only for first-ever cold start / explicit rescan. */
export async function scanHistoricalRecords(
  ctx: ScanContext,
  providers: ProviderId[] | undefined,
  referenceTimestamp: number,
  warnings: ScanWarning[]
): Promise<TokenRecord[]> {
  const rawRecords = await scanRawRecords(ctx, providers, "history", warnings);
  return rawRecords.filter((record) => isBeforeToday(record.timestamp, referenceTimestamp));
}

export function resolveTodayState(
  records: TokenRecord[],
  todayWarnings: ScanWarning[],
  isTodayOnlyScan: boolean
): ScanMeta["todayState"] {
  if (todayWarnings.length === 0) return "live";
  if (records.length > 0 || isTodayOnlyScan) return "degraded";
  return "snapshot-only";
}
