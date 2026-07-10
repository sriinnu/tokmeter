/**
 * @sriinnu/tokmeter-core — Public API barrel export.
 *
 * Re-exports everything so consumers can use:
 *   import { TokmeterCore } from "@sriinnu/tokmeter-core";
 */

export { TokmeterCore } from "./tokmeter-core.js";
export {
  computeCreditsUsedToday,
  pollAntigravityLiveStatus,
  pruneSnapshotHistory as pruneAntigravitySnapshotHistory,
  readLatestSnapshot as readLatestAntigravitySnapshot,
  readSnapshotHistory as readAntigravitySnapshotHistory,
} from "./antigravity-live.js";
export type {
  AntigravityCreditsUsedToday,
  AntigravityModelQuota,
  AntigravitySnapshot,
} from "./antigravity-live.js";
export {
  PricingService,
  getKoshaRegistryMtime,
  maybeBackgroundRefresh,
  refreshKoshaRegistry,
} from "./pricing.js";
export { CleanupService } from "./cleanup-service.js";
export {
  ALL_PARSERS,
  ALL_PROVIDER_IDS,
  getParser,
  getParsers,
} from "./parsers/index.js";
export {
  ALL_CLEANERS,
  getCleaner,
  getCleaners,
} from "./cleaners/index.js";
export {
  aggregateByProject,
  aggregateByModel,
  aggregateByProvider,
  aggregateByDate,
  filterByDate,
  filterByProvider,
  filterByProject,
} from "./aggregator.js";
export {
  endOfLocalDay,
  isBeforeToday,
  isSameLocalDay,
  localDateKey,
  startOfLocalDay,
  yesterdayDateKey,
} from "./date-utils.js";
export {
  invalidateSummaryCache,
  loadSummaryCache,
  saveSummaryCache,
} from "./summary-cache.js";
export {
  invalidateRecordCache,
  clearRecordCache,
} from "./parsers/utils.js";
export { invalidateHistorySnapshot } from "./history-snapshot.js";
export {
  canonicalizeProjectName,
  projectMatchKey,
  projectNameIncludes,
  projectNamesMatch,
} from "./project-name.js";
export {
  aliasFilePath,
  applyTagOp,
  isProjectHidden,
  loadAliases,
  mergeAliases,
  removeAlias,
  resolveProjectName,
  saveAliases,
  setAlias,
  setHidden,
  suggestAliases,
} from "./alias-service.js";
export type { AliasEntry, AliasMap, AliasSuggestion } from "./alias-service.js";
export {
  CONFIG_FIELDS,
  DEFAULT_CONFIG,
  configFilePath,
  getConfigValue,
  loadConfig,
  mergeConfigs,
  saveConfig,
  setConfigValue,
} from "./config-service.js";
export type {
  ConfigFieldMeta,
  DefaultRange,
  DefaultSort,
  UserConfig,
} from "./config-service.js";
export {
  BUILT_IN_THEMES,
  getTheme,
  listThemeIds,
  listThemes,
  loadUserTheme,
  isNerdFontEnabled,
  getConfigPath,
} from "./themes.js";
export type { Theme, ThemeColors } from "./themes.js";

export { computeStatbarSignals } from "./signals.js";
export { deriveUsage, sumUsage } from "./usage.js";
export type { DerivedUsage, UsageBreakdown } from "./usage.js";
export type {
  TokenRecord,
  UsageMetricProvenance,
  UsageProvenance,
  UsageTelemetrySource,
  CompactionTelemetry,
  ProjectSummary,
  ModelSummary,
  ProviderSummary,
  DailyEntry,
  ScanMeta,
  ScanOptions,
  ScanWarning,
  TokmeterConfig,
  TokmeterStats,
  TokmeterSummary,
  StatbarSignals,
  SessionParser,
  ProviderId,
  SessionCleaner,
  CleanupTarget,
  CleanupFilter,
  CleanupPreview,
  CleanupResult,
  CleanupOptions,
  BackupInfo,
  RestoreResult,
  PartialFileWarning,
} from "./types.js";

export * from "./session-health.js";
