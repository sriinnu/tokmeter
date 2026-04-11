/**
 * @sriinnu/tokmeter-core — Cleaner registry.
 *
 * Mirrors packages/core/src/parsers/index.ts but for cleanup operations.
 */
import type { ProviderId, SessionCleaner } from "../types.js";
/** All available cleaners, one per provider (except synthetic which has no files). */
export declare const ALL_CLEANERS: SessionCleaner[];
/** Get a cleaner for a specific provider. */
export declare function getCleaner(id: ProviderId): SessionCleaner | undefined;
/** Get cleaners for specific providers, or all if no filter. */
export declare function getCleaners(ids?: ProviderId[]): SessionCleaner[];
