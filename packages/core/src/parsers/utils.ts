/**
 * @sriinnu/tokmeter-core — Parser utilities barrel.
 *
 * Shared helpers for session file discovery, reading, caching, SQLite loading,
 * and record creation.
 */

export {
  ANY_PATH_SEGMENT,
  dirExists,
  expandHome,
  fileExists,
  filterFilesByMtime,
  findFiles,
  getConfiguredProviderPaths,
  lastPathSegment,
  mapWithConcurrency,
  vscodeFamilyUserDirs,
} from "./utils/fs-helpers.js";
export {
  type JsonlVisitResult,
  MAX_JSONL_RECORDS,
  type OversizedLine,
  readJsonFile,
  readJsonlFile,
  readJsonlFileFromOffset,
  visitJsonlLines,
} from "./utils/jsonl.js";
export {
  clearRecordCache,
  flushAllRecordCaches,
  getCachedKoshaMtime,
  getCachedOverridesMtime,
  getCachedRecords,
  invalidateRecordCache,
  markRecordCacheDirty,
  peekCachedRecords,
  saveRecordCacheToDisk,
  setCachedKoshaMtime,
  setCachedOverridesMtime,
  setCachedRecords,
} from "./utils/record-cache.js";
export {
  createRecord,
  extractProjectFromPath,
  fallbackRecordTime,
  resetFallbackRecordTimes,
  settleInferredTimes,
  toDateStr,
} from "./utils/records.js";
export {
  dbFileStateKey,
  fileMtimeWithWal,
  openReadonlySqlite,
  type ReadonlySqlite,
} from "./utils/sqlite.js";
