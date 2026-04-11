/**
 * @sriinnu/tokmeter-core — Parser registry and index.
 */
import type { ProviderId, SessionParser } from "../types.js";
/** All available parsers. */
export declare const ALL_PARSERS: SessionParser[];
/** Get a parser by provider ID. */
export declare function getParser(id: ProviderId): SessionParser | undefined;
/** Get parsers for specific provider IDs (or all if none specified). */
export declare function getParsers(ids?: ProviderId[]): SessionParser[];
/** All valid provider IDs. */
export declare const ALL_PROVIDER_IDS: ProviderId[];
