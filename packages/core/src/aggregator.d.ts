/**
 * @sriinnu/tokmeter-core — Aggregator.
 *
 * Groups parsed TokenRecords by project, model, provider, and date.
 */
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ProviderId,
  ProviderSummary,
  TokenRecord,
} from "./types.js";
/** Filter records by date range. */
export declare function filterByDate(
  records: TokenRecord[],
  opts: {
    since?: string;
    until?: string;
    today?: boolean;
    week?: boolean;
    month?: boolean;
    year?: number;
  }
): TokenRecord[];
/** Filter records by provider. */
export declare function filterByProvider(
  records: TokenRecord[],
  providers: ProviderId[]
): TokenRecord[];
/** Filter records by project name substring. */
export declare function filterByProject(records: TokenRecord[], project: string): TokenRecord[];
/** Aggregate records into per-project summaries. */
export declare function aggregateByProject(records: TokenRecord[]): ProjectSummary[];
/** Aggregate records into per-model summaries. */
export declare function aggregateByModel(
  records: TokenRecord[],
  totalCost?: number
): ModelSummary[];
/** Aggregate records into per-provider summaries. */
export declare function aggregateByProvider(
  records: TokenRecord[],
  totalCost?: number
): ProviderSummary[];
/** Aggregate records into daily entries. */
export declare function aggregateByDate(records: TokenRecord[]): DailyEntry[];
