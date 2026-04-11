/**
 * @sriinnu/tokmeter-core — Local calendar helpers.
 *
 * Keeps the definition of "today" consistent across history freezing,
 * daily aggregation, and statusline/dashboard refresh logic.
 */
/** Start of the local day for the provided timestamp (or now). */
export declare function startOfLocalDay(timestamp?: number): number;
/** End of the local day for the provided timestamp (or now). */
export declare function endOfLocalDay(timestamp?: number): number;
/** Format a timestamp as a local YYYY-MM-DD date key. */
export declare function localDateKey(timestamp?: number): string;
/** Local YYYY-MM-DD key for yesterday relative to the reference timestamp. */
export declare function yesterdayDateKey(referenceTimestamp?: number): string;
/** True when both timestamps land on the same local calendar day. */
export declare function isSameLocalDay(left: number, right: number): boolean;
/** True when the timestamp is before the current local day. */
export declare function isBeforeToday(timestamp: number, referenceTimestamp?: number): boolean;
